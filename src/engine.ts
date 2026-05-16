import type { ActivityTemplate, ExecutionTaskRecord, ExecutionTrace, FailureMode, Impulse, InputShapeRef, LifecycleEvent } from "./ontology";
import { getImpulseShape } from "./ontology";
import type { CreateImpulseInput } from "./impulses";
import type { ResolverContext } from "./resolvers";
import { ExecutionRuntime } from "./runtime";

export interface ExecutionBudget {
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxTaskCount?: number;
}

export interface ExecuteOptions {
  variables?: Record<string, unknown>;
  impulses?: Impulse[];
  reason?: string;
  budget?: ExecutionBudget;
  parentExecutionId?: string;
  compositionChain?: string[];
}

class BudgetExceededError extends Error {
  constructor(
    readonly budgetType: "cost" | "duration" | "task_count",
    readonly consumed: number,
    readonly allowed: number,
  ) {
    super(`Budget exceeded: ${budgetType} (consumed ${consumed}, allowed ${allowed})`);
  }
}

export class ActivityExecutor {
  constructor(private readonly runtime: ExecutionRuntime) {}

  async execute(template: ActivityTemplate, options: ExecuteOptions = {}): Promise<ExecutionTrace> {
    const executionId = this.runtime.random.id("exec");
    const startedAt = this.runtime.clock.now();
    const compositionChain = options.compositionChain ?? [];

    const seededImpulses = options.impulses ?? [];
    for (const impulse of seededImpulses) {
      this.runtime.store.put(impulse);
    }

    await this.emit({
      type: "activity.started",
      timestamp: startedAt,
      data: {
        executionId,
        templateId: template.id,
        templateName: template.name,
        parentExecutionId: options.parentExecutionId,
      },
    });

    const taskRecords: ExecutionTaskRecord[] = [];
    const inputImpulseIds = seededImpulses.map((impulse) => impulse.id);
    const outputImpulseIds = new Set<string>();
    let totalCostUsd = 0;
    const budget = options.budget;

    try {
      for (const task of template.tasks) {
        if (budget?.maxTaskCount !== undefined && taskRecords.length >= budget.maxTaskCount) {
          throw new BudgetExceededError("task_count", taskRecords.length, budget.maxTaskCount);
        }

        const elapsed = this.runtime.clock.now() - startedAt;
        if (budget?.maxDurationMs !== undefined && elapsed >= budget.maxDurationMs) {
          throw new BudgetExceededError("duration", elapsed, budget.maxDurationMs);
        }

        await this.emit({
          type: "task.started",
          timestamp: this.runtime.clock.now(),
          data: { executionId, taskId: task.id, resolverId: task.resolver },
        });

        const taskStart = this.runtime.clock.now();
        const inputImpulses = this.resolveInputs(task.inputShapes ?? [], task.id);

        let storedOutputs: Impulse[];
        let taskCostUsd: number | undefined;
        let childExecutionId: string | undefined;

        if (task.resolver === "compose") {
          // Nested composition: dispatch to a sub-activity template
          const result = await this.dispatchCompose(task, {
            executionId,
            inputImpulses,
            compositionChain,
            variables: options.variables ?? {},
            budget,
          });
          storedOutputs = result.outputs;
          taskCostUsd = result.childTrace.costUsd;
          childExecutionId = result.childTrace.id;
          if (result.childTrace.costUsd !== undefined) {
            totalCostUsd += result.childTrace.costUsd;
          }
          for (const impulse of storedOutputs) {
            outputImpulseIds.add(impulse.id);
          }
        } else {
          const resolver = this.runtime.resolvers.get(task.resolver);
          if (!resolver) {
            throw new Error(`Resolver '${task.resolver}' is not registered`);
          }

          const context: ResolverContext = {
            executionId,
            template,
            task,
            variables: options.variables ?? {},
            inputImpulses,
            store: this.runtime.store,
            clock: this.runtime.clock,
            random: this.runtime.random,
            eventSink: this.runtime.eventSink,
            traceSink: this.runtime.traceSink,
            templateProvider: this.runtime.templateProvider,
            attachedVessels: this.runtime.attachedVessels,
          };

          const outputs = await resolver.resolve(context);
          storedOutputs = outputs.map((impulse, index) => {
            const complete = this.ensureImpulse(task.outputShapes ?? [], impulse, index);
            this.runtime.store.put(complete);
            outputImpulseIds.add(complete.id);
            return complete;
          });

          // Cost attribution is opt-in via trace sink; not inferred from impulse fields.
        }

        const taskDurationMs = this.runtime.clock.now() - taskStart;

        if (budget?.maxCostUsd !== undefined && totalCostUsd >= budget.maxCostUsd) {
          throw new BudgetExceededError("cost", totalCostUsd, budget.maxCostUsd);
        }

        taskRecords.push({
          taskId: task.id,
          description: task.description,
          resolverId: task.resolver,
          resolverTier: task.resolver === "compose" ? "deterministic" : this.runtime.resolvers.get(task.resolver)?.tier,
          inputImpulseIds: inputImpulses.map((impulse) => impulse.id),
          outputImpulseIds: storedOutputs.map((impulse) => impulse.id),
          success: true,
          costUsd: taskCostUsd,
          durationMs: taskDurationMs,
          childExecutionId,
        });

        await this.emit({
          type: "task.completed",
          timestamp: this.runtime.clock.now(),
          data: {
            executionId,
            taskId: task.id,
            resolverId: task.resolver,
            success: true,
            outputImpulseIds: storedOutputs.map((impulse) => impulse.id),
            childExecutionId,
          },
        });
      }

      const totalDurationMs = this.runtime.clock.now() - startedAt;
      const trace: ExecutionTrace = {
        id: executionId,
        templateId: template.id,
        templateName: template.name,
        status: "completed",
        reason: options.reason,
        parentExecutionId: options.parentExecutionId,
        compositionChain: compositionChain.length > 0 ? compositionChain : undefined,
        inputImpulseIds,
        outputImpulseIds: [...outputImpulseIds],
        tasks: taskRecords,
        costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
        durationMs: totalDurationMs,
      };

      await this.runtime.traceSink.record(trace);
      await this.emit({
        type: "activity.completed",
        timestamp: this.runtime.clock.now(),
        data: { executionId, templateId: template.id },
      });
      return trace;
    } catch (error) {
      const totalDurationMs = this.runtime.clock.now() - startedAt;
      const message = error instanceof Error ? error.message : String(error);

      let failureMode: FailureMode;
      if (error instanceof BudgetExceededError) {
        failureMode = {
          type: "budget_exhausted",
          reason: message,
          context: {
            budget_type: error.budgetType,
            consumed: error.consumed,
            allowed: error.allowed,
          },
        };
      } else {
        failureMode = { type: "execution_error", reason: message };
      }

      const trace: ExecutionTrace = {
        id: executionId,
        templateId: template.id,
        templateName: template.name,
        status: "failed",
        reason: options.reason,
        parentExecutionId: options.parentExecutionId,
        compositionChain: compositionChain.length > 0 ? compositionChain : undefined,
        inputImpulseIds,
        outputImpulseIds: [...outputImpulseIds],
        tasks: taskRecords,
        failureMode,
        costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
        durationMs: totalDurationMs,
      };

      await this.runtime.traceSink.record(trace);
      await this.emit({
        type: "activity.failed",
        timestamp: this.runtime.clock.now(),
        data: { executionId, templateId: template.id, error: message },
      });
      return trace;
    }
  }

  private async dispatchCompose(
    task: import("./ontology").ActivityTask,
    opts: {
      executionId: string;
      inputImpulses: Impulse[];
      compositionChain: string[];
      variables: Record<string, unknown>;
      budget?: ExecutionBudget;
    },
  ): Promise<{ outputs: Impulse[]; childTrace: ExecutionTrace }> {
    if (!task.subActivityId) {
      throw new Error(`Task '${task.id}' uses resolver "compose" but has no subActivityId`);
    }
    if (!this.runtime.templateProvider) {
      throw new Error(
        `Task '${task.id}' requires templateProvider to dispatch compose to '${task.subActivityId}'`,
      );
    }

    const subTemplate = await this.runtime.templateProvider.getTemplate(task.subActivityId);
    if (!subTemplate) {
      throw new Error(`Sub-activity template '${task.subActivityId}' not found`);
    }

    const childChain = [...opts.compositionChain, opts.executionId];
    const childExecutor = new ActivityExecutor(this.runtime);
    const childTrace = await childExecutor.execute(subTemplate, {
      impulses: opts.inputImpulses,
      variables: opts.variables,
      budget: opts.budget,
      parentExecutionId: opts.executionId,
      compositionChain: childChain,
    });

    if (childTrace.status === "failed") {
      throw new Error(
        `Compose sub-activity '${task.subActivityId}' failed: ${childTrace.failureMode?.reason ?? "unknown"}`,
      );
    }

    const outputs = childTrace.outputImpulseIds
      .map((id) => this.runtime.store.get(id))
      .filter((impulse): impulse is Impulse => impulse !== undefined);

    return { outputs, childTrace };
  }

  private resolveInputs(shapes: (string | InputShapeRef)[], taskId: string): Impulse[] {
    return shapes.flatMap((entry) => {
      const ref: InputShapeRef = typeof entry === "string"
        ? { shape: entry, cardinality: "any" }
        : { cardinality: "any", ...entry };

      const byShape = this.runtime.store.findByShape(ref.shape);

      // Predicate filter: producedBy narrows to impulses with matching metadata
      const candidates = ref.producedBy
        ? byShape.filter((imp) => imp.metadata.producedBy === ref.producedBy || imp.metadata.produced_at_task_id === ref.producedBy)
        : byShape;

      if (candidates.length === 0) {
        const predDesc = ref.producedBy ? ` (producedBy=${ref.producedBy})` : "";
        throw new Error(
          `Task '${taskId}' requires shape '${ref.shape}'${predDesc} but no matching impulses were found`,
        );
      }

      if (ref.cardinality === "exactly_one" && candidates.length > 1) {
        throw new Error(
          `Task '${taskId}' requires exactly one '${ref.shape}' impulse but found ${candidates.length}`,
        );
      }

      return candidates;
    });
  }

  private ensureImpulse(outputShapes: string[], impulse: Impulse, index: number): Impulse {
    const shape = outputShapes[index] ?? getImpulseShape(impulse);
    const metadata =
      shape === getImpulseShape(impulse) ? impulse.metadata : { ...impulse.metadata, shape };
    return { ...impulse, loaded: impulse.loaded ?? true, metadata };
  }

  async createImpulse(input: CreateImpulseInput): Promise<Impulse> {
    const impulse = this.runtime.store.create(input);
    await this.emit({
      type: "impulse.created",
      timestamp: this.runtime.clock.now(),
      data: { impulseId: impulse.id, shape: getImpulseShape(impulse) },
    });
    return impulse;
  }

  private async emit(event: LifecycleEvent): Promise<void> {
    await this.runtime.eventSink.emit(event);
  }
}
