import type { ActivityTask, ActivityTemplate, ExecutionTaskRecord, ExecutionTrace, FailureMode, Impulse, InputShapeRef, LifecycleEvent } from "./ontology";
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
  /** Optional goal context forwarded into `lifecycle:*` payloads so subscribers
   *  (e.g. slot-binding's escalate_unbindable → create-shape-provider-goal)
   *  can read the parent goal without recomputing from variables. Matches
   *  minibob's `currentGoalContext` plumbing. */
  goalContext?: { goal?: string };
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

        // Emit `lifecycle:task:preBinding` BEFORE `task.started` when the task
        // declares inputShapes — slot-binding meta-activities enrich the
        // impulse pool here (spec §E / 2026-04-26-impulse-binding-selection-layer).
        // Mirrors minibob/src/activity.ts emit at line 4734.
        const declaredInputShapeNames = (task.inputShapes ?? []).map((entry) =>
          typeof entry === "string" ? entry : entry.shape,
        );
        if (declaredInputShapeNames.length > 0) {
          const poolShapes = this.runtime.store
            .all()
            .map((imp) => getImpulseShape(imp));
          const presentShapes = new Set(poolShapes);
          const missingShapes = declaredInputShapeNames.filter(
            (s) => !presentShapes.has(s),
          );
          await this.emit({
            type: "lifecycle:task:preBinding",
            timestamp: this.runtime.clock.now(),
            data: {
              taskId: task.id,
              templateId: template.id,
              executionId,
              inputShapes: declaredInputShapeNames,
              currentImpulseShapes: poolShapes,
              missingShapes,
              variables: options.variables ?? {},
              parentDepth: compositionChain.length,
              parentGoalText: options.goalContext?.goal,
            },
          });
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
            compositionChain,
          };

          // Retry semantics (design §J.4): read max_attempts (snake_case) or
          // maxAttempts (camelCase) for parity with minibob template authors.
          const retryConfig = task.retry as
            | { max_attempts?: number; maxAttempts?: number; strategy?: string }
            | undefined;
          const maxAttempts = Math.max(
            1,
            retryConfig?.max_attempts ?? retryConfig?.maxAttempts ?? 1,
          );

          let outputs: Impulse[] = [];
          let lastError: unknown;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              outputs = await resolver.resolve(context);
              lastError = undefined;
              break;
            } catch (err) {
              lastError = err;
              if (attempt < maxAttempts) {
                await this.emit({
                  type: "task.retry",
                  timestamp: this.runtime.clock.now(),
                  data: {
                    executionId,
                    taskId: task.id,
                    attempt,
                    maxAttempts,
                    error: err instanceof Error ? err.message : String(err),
                  },
                });
              }
            }
          }
          if (lastError !== undefined) throw lastError;

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

        // Mirror minibob/src/activity.ts:3200 — emit the lifecycle event so
        // validator-dispatch + concept-db subscribers can fire on task
        // boundaries. Additive to `task.completed`; the simpler event is kept
        // for existing consumers.
        await this.emit({
          type: "lifecycle:task:completed",
          timestamp: this.runtime.clock.now(),
          data: {
            taskId: task.id,
            templateId: template.id,
            executionId,
            resolverId: task.resolver,
            success: true,
            durationMs: taskDurationMs,
            costUsd: taskCostUsd ?? 0,
            inputImpulseIds: inputImpulses.map((impulse) => impulse.id),
            outputImpulseIds: storedOutputs.map((impulse) => impulse.id),
            inputShapes: declaredInputShapeNames,
            outputShapes: this.shapesOfImpulses(task, storedOutputs),
            // 2026-05-20 fix (task 40): include depth info so the
            // lifecycle-subscriber's universal depth-cap can refuse runaway
            // recursion. Without this, subscribers on lifecycle:task:completed
            // (validator-dispatch et al.) read parentDepth=undefined → cap
            // never fires → unbounded mutual recursion when seeding.
            parentDepth: compositionChain.length,
            compositionChain,
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

      // Spec-normative event for audit-test-report + ribosome subscribers.
      // Emitted ONLY on success (not in the failure branch below) so the
      // `output_shapes_contains` filter on audit-test-report does not fire
      // on partial / failed traces. parentDepth is exposed explicitly so the
      // R5 depth-cap can short-circuit without recomputing from
      // composition_chain (mirrors minibob/src/activity.ts:3862).
      const outputShapes = [
        ...new Set(
          [...outputImpulseIds]
            .map((id) => this.runtime.store.get(id))
            .filter((imp): imp is Impulse => imp !== undefined)
            .map((imp) => getImpulseShape(imp)),
        ),
      ];
      await this.emit({
        type: "lifecycle:execution:succeeded",
        timestamp: this.runtime.clock.now(),
        data: {
          executionId,
          templateId: template.id,
          templateName: template.name,
          status: "completed",
          durationMs: totalDurationMs,
          costUsd: totalCostUsd,
          outputShapes,
          outputImpulseIds: [...outputImpulseIds],
          taskCount: template.tasks.length,
          parentDepth: compositionChain.length,
          compositionChain,
          ...(options.goalContext ? { goalContext: options.goalContext } : {}),
        },
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

  /**
   * Resolve the distinct output shapes for a completed task. Prefer the
   * impulse's resolved shape (set by `ensureImpulse`); fall back to the
   * declared `task.outputShapes` when an impulse carries no metadata.shape.
   */
  private shapesOfImpulses(task: ActivityTask, impulses: Impulse[]): string[] {
    const declared = task.outputShapes ?? [];
    const collected = impulses.map((imp, i) => {
      const s = getImpulseShape(imp);
      return s || declared[i] || imp.pointer.type;
    });
    return [...new Set(collected)];
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
