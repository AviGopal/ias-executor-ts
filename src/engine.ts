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
  /** Classification tags written into the execution trace (e.g. "intent:topology_discovery"). */
  tags?: string[];
  /** Optional goal context forwarded into `lifecycle:*` payloads so subscribers
   *  (e.g. slot-binding's escalate_unbindable → create-shape-provider-goal)
   *  can read the parent goal without recomputing from variables. Matches
   *  minibob's `currentGoalContext` plumbing. */
  goalContext?: { goal?: string };
  /** Caller's originally-requested template id (when dispatch bypassed
   *  recommendation). Threaded onto the resulting `ExecutionTrace` so the
   *  substrate can audit dispatch-target drift without operator inspection.
   *  See ontology `ExecutionTrace.dispatchTargetTemplateId`. */
  dispatchTargetTemplateId?: string;
  /** Forward-dispatch composition depth cap (Phase 2 of obsidian meta-skill,
   *  2026-06-01). Complements the existing read-time `parent_execution_id`
   *  depth-16 walk by gating each `compose` dispatch BEFORE the child
   *  execution starts. When `compositionChain.length >= maxCompositionDepth`
   *  on a `compose` task, the engine refuses the dispatch with a
   *  `safety_breach` failure_mode rather than letting an authored template
   *  recurse without bound. Default: 16. */
  maxCompositionDepth?: number;
}

// Per-key cap on accumulatedVariables string projections (bytes). Tunable via
// `IAS_ACCUMULATED_VAR_MAX_BYTES`; default 262144 (256 KiB). Caps protect
// long task chains from retaining MBs of LLM-output strings PER variable per
// task — the canonical impulse store already keeps the original content and
// is cleared on top-level execution completion.
const ACCUMULATED_VAR_MAX_BYTES = (() => {
  const raw = typeof process !== "undefined" ? process.env?.IAS_ACCUMULATED_VAR_MAX_BYTES : undefined;
  const n = raw ? parseInt(raw, 10) : 262_144;
  return Number.isFinite(n) && n > 0 ? n : 262_144;
})();

function capForAccumulator(value: string): string {
  if (typeof value !== "string" || value.length <= ACCUMULATED_VAR_MAX_BYTES) return value;
  return value.slice(0, ACCUMULATED_VAR_MAX_BYTES) +
    `…[truncated ${value.length - ACCUMULATED_VAR_MAX_BYTES} bytes]`;
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

    // Accumulated variables across tasks. Starts as request-level variables and
    // grows after each task succeeds with minibob-convention keys:
    //   <taskId>_text       — string content of the first output impulse (if any)
    //   <taskId>_content    — same as _text (alias)
    //   <taskId>_valueJson  — JSON-stringified content (for json_path_extract et al.)
    //   <taskId>_<shapeName>— content keyed by output impulse shape (when single shape)
    //
    // Without this propagation, multi-task chains like draft-gap-closing-activity
    // (whose register_variant uses `{{draft_via_llm_text}}`) silently fail —
    // the placeholder remains literal because context.variables only contained
    // request-level vars. The engine reports task=success because the resolver
    // (e.g. activity_create_variant) is called with malformed input but the
    // proxy didn't propagate the structuredError. This was the load-bearing
    // gap blocking lift: substrate-authored templates couldn't reach
    // activity-api with their LLM-drafted content.
    const accumulatedVariables: Record<string, unknown> = { ...(options.variables ?? {}) };

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
          if (missingShapes.length > 0) {
            await this.emit({
              type: "lifecycle:gap:classified",
              timestamp: this.runtime.clock.now(),
              data: {
                gapType: "missing_input_shapes",
                taskId: task.id,
                templateId: template.id,
                executionId,
                missingShapes,
                presentShapes: poolShapes,
                parentDepth: compositionChain.length,
              },
            });
          }
        }

        await this.emit({
          type: "task.started",
          timestamp: this.runtime.clock.now(),
          data: { executionId, taskId: task.id, resolverId: task.resolver },
        });

        const taskStart = this.runtime.clock.now();
        const inputImpulses = await this.resolveInputs(task.inputShapes ?? [], task.id);
        // Named-input slot lookup (Idiom-6 ribosome closure): when a task
        // declares `inputImpulses: string[]`, pull matching impulses from the
        // store by their stamped `metadata.outputImpulseKey`. This is what
        // makes `{{impulse:<slot>}}` placeholders resolvable in proxy resolver
        // configs even when the task didn't declare `inputShapes` for the
        // corresponding upstream output.
        const namedInputSlots = (task as Record<string, unknown>)["inputImpulses"];
        if (Array.isArray(namedInputSlots)) {
          const seen = new Set(inputImpulses.map((i) => i.id));
          for (const slot of namedInputSlots) {
            if (typeof slot !== "string") continue;
            const match = this.runtime.store.all().find((imp) => {
              const meta = imp.metadata as Record<string, unknown> | undefined;
              return meta?.["outputImpulseKey"] === slot;
            });
            if (match && !seen.has(match.id)) {
              inputImpulses.push(match);
              seen.add(match.id);
            }
          }
        }

        let storedOutputs: Impulse[];
        let taskCostUsd: number | undefined;
        let childExecutionId: string | undefined;

        if (task.resolver === "compose") {
          // Nested composition: dispatch to a sub-activity template
          const result = await this.dispatchCompose(task, {
            executionId,
            inputImpulses,
            compositionChain,
            variables: accumulatedVariables,
            budget,
            maxCompositionDepth: options.maxCompositionDepth,
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
            await this.emit({
              type: "lifecycle:gap:classified",
              timestamp: this.runtime.clock.now(),
              data: {
                gapType: "resolver_not_registered",
                taskId: task.id,
                templateId: template.id,
                executionId,
                resolverId: task.resolver,
                parentDepth: compositionChain.length,
              },
            });
            throw new Error(`Resolver '${task.resolver}' is not registered`);
          }

          const context: ResolverContext = {
            executionId,
            template,
            task,
            // Use accumulatedVariables (request-level + prior-task outputs)
            // instead of just options.variables so chains like draft-gap-
            // closing-activity see their upstream task outputs as
            // {{<taskId>_text}} / {{<taskId>_valueJson}} substitutions.
            variables: accumulatedVariables,
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

          // Named-output slot stamping (Idiom-6 ribosome closure):
          // when a task declares `outputImpulses: string[]`, stamp the slot
          // name on the corresponding output impulse's metadata so downstream
          // tasks that reference it via `inputImpulses` (and template authors
          // who reference it via `{{impulse:<slot>}}`) can find the exact
          // impulse instance unambiguously. Without this stamp the only handle
          // is `metadata.shape`, which collides when two tasks emit the same
          // shape under different slot names.
          const namedOutputSlots = (task as Record<string, unknown>)["outputImpulses"];
          const namedOutputSlotArray = Array.isArray(namedOutputSlots)
            ? (namedOutputSlots as unknown[]).filter((v): v is string => typeof v === "string")
            : [];
          storedOutputs = outputs.map((impulse, index) => {
            const complete = this.ensureImpulse(task.outputShapes ?? [], impulse, index);
            const slot = namedOutputSlotArray[index];
            const stamped = slot
              ? { ...complete, metadata: { ...complete.metadata, outputImpulseKey: slot } }
              : complete;
            this.runtime.store.put(stamped);
            outputImpulseIds.add(stamped.id);
            return stamped;
          });

          // Cost attribution is opt-in via trace sink; not inferred from impulse fields.
        }

        // ── Convergent validity checks ─────────────────────────────────────────
        // Independent signals that must agree with the resolver's self-report
        // before success=true is recorded. Each check throws on disagreement,
        // causing the task to record success=false + β+=1 rather than silently
        // polluting Thompson posteriors with a ghost success.
        //
        // Check 1 — degraded impulse detection.
        // The proxy resolver in goal-host-vessel used to swallow exceptions and
        // return a degraded impulse with metadata.degraded=true, letting the
        // engine see success while the actual work failed (F13, inv-058/083).
        // F13 re-throws now, but third-party resolvers may still follow the old
        // pattern. Reject any task where ALL outputs are degraded: unanimously
        // degraded outputs means the resolver produced no usable signal.
        if (storedOutputs.length > 0 &&
            storedOutputs.every(i => (i.metadata as Record<string, unknown>)?.["degraded"] === true)) {
          throw new Error(
            `convergent_validity[degraded]: all ${storedOutputs.length} output(s) carry ` +
            `metadata.degraded=true — resolver self-reports failure via degraded impulse pattern`
          );
        }

        // Check 2 — fs_write artifact verification.
        // An fs_write resolver that reports success but leaves no file behind is
        // a ghost write. Verify the written path actually exists. Only applies to
        // workspace-scoped paths (outside /workspace the engine has no read access).
        if (task.resolver === "fs_write") {
          const rawPath = (task.config as Record<string, unknown> | undefined)?.["path"];
          if (typeof rawPath === "string") {
            // Resolve any {{variable}} placeholders that were already interpolated
            // into accumulatedVariables before the task ran.
            const resolvedPath = rawPath.replace(/\{\{([^}]+)\}\}/g, (_, k) => {
              const v = accumulatedVariables[k.trim()];
              return v !== undefined ? String(v) : _;
            });
            if (resolvedPath.startsWith("/workspace/") && !resolvedPath.includes("{{")) {
              const exists = await Bun.file(resolvedPath).exists();
              if (!exists) {
                throw new Error(
                  `convergent_validity[artifact]: fs_write reported success but ` +
                  `no file found at ${resolvedPath}`
                );
              }
            }
          }
        }

        // Check 3 — declared outputShapes with zero outputs (informational).
        // Some resolvers legitimately produce no impulses (side-effect-only),
        // but a task that declares outputShapes and produces nothing is worth
        // flagging. Emit a lifecycle event rather than failing — the resolver
        // did not throw, so we treat this as a low-confidence success.
        if ((task.outputShapes ?? []).length > 0 && storedOutputs.length === 0) {
          await this.emit({
            type: "lifecycle:task:completed",
            timestamp: this.runtime.clock.now(),
            data: {
              taskId: task.id,
              templateId: template.id,
              executionId,
              resolverId: task.resolver,
              success: true,
              warning: "convergent_validity[empty_output]: task declared outputShapes but produced 0 impulses",
            },
          });
        }
        // ── end convergent validity checks ────────────────────────────────────

        // Propagate this task's outputs into accumulatedVariables so subsequent
        // tasks can substitute {{<taskId>_text}} / {{<taskId>_content}} /
        // {{<taskId>_valueJson}} / {{<taskId>_<shapeName>}} placeholders.
        // First output impulse is canonical for unsuffixed access.
        //
        // Memory bound: each task output that lands here is a string projected
        // from the impulse content. For LLM-heavy chains the content can be
        // MB-scale, and the impulse store ALREADY retains the canonical copy
        // (and is cleared by evictExecutionScope on top-level completion).
        // Mirroring the same content into accumulatedVariables doubles the
        // retention — and the string projection lives until the trace returns
        // and the closure goes out of scope. Cap each per-task projection at
        // 256 KB; downstream resolvers that need the full body should read
        // from the impulse via inputImpulses, not the {{<task>_text}} sugar.
        if (storedOutputs.length > 0) {
          const first = storedOutputs[0]!;
          const firstContent = first.content;
          const firstText = typeof firstContent === "string"
            ? firstContent
            : firstContent !== undefined && firstContent !== null
              ? JSON.stringify(firstContent)
              : "";
          const cappedFirstText = capForAccumulator(firstText);
          accumulatedVariables[`${task.id}_text`] = cappedFirstText;
          // _content keeps the structural reference so resolvers that read
          // .content as an object (rather than .text) still see the full
          // payload. Strings get capped here too; objects fall through.
          accumulatedVariables[`${task.id}_content`] =
            typeof firstContent === "string" ? cappedFirstText : (firstContent ?? "");
          accumulatedVariables[`${task.id}_valueJson`] = cappedFirstText;
          // Shape-keyed access: {{<taskId>_<shape>}} maps to the first impulse
          // matching that shape.
          for (const impulse of storedOutputs) {
            const shape = (impulse.metadata as { shape?: string } | undefined)?.shape;
            if (shape) {
              const key = `${task.id}_${shape}`;
              if (!(key in accumulatedVariables)) {
                const text = typeof impulse.content === "string"
                  ? impulse.content
                  : JSON.stringify(impulse.content ?? "");
                accumulatedVariables[key] = capForAccumulator(text);
              }
            }
          }
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
          // Record declared input shapes so the trace sink can union them into
          // trace.input_impulse_shapes. Required by activity-api's server-side
          // state_signature path (execution-traces.ts:2381-2390) which gates
          // M1 context_thompson_scores writes. Without this, autonomous traces
          // ship empty input_impulse_shapes and the trainer reports
          // n_training_samples=0 every cycle.
          inputShapes: declaredInputShapeNames,
          // Record actual shapes of output impulses so coverage_tick and
          // activity-api can distinguish "shape actually produced" from
          // "shape the template declares it might produce". Previously all
          // 600 traces had output_shapes=None, making coverage_tick fall
          // back to template declarations — a proxy, not a measurement.
          outputShapes: this.shapesOfImpulses(task, storedOutputs),
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
        tags: options.tags,
        parentExecutionId: options.parentExecutionId,
        compositionChain: compositionChain.length > 0 ? compositionChain : undefined,
        inputImpulseIds,
        outputImpulseIds: [...outputImpulseIds],
        tasks: taskRecords,
        costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
        durationMs: totalDurationMs,
        dispatchTargetTemplateId: options.dispatchTargetTemplateId,
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
      this.evictExecutionScope({
        inputImpulseIds,
        outputImpulseIds,
        isTopLevel: !options.parentExecutionId && compositionChain.length === 0,
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
        tags: options.tags,
        parentExecutionId: options.parentExecutionId,
        compositionChain: compositionChain.length > 0 ? compositionChain : undefined,
        inputImpulseIds,
        outputImpulseIds: [...outputImpulseIds],
        tasks: taskRecords,
        failureMode,
        costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
        durationMs: totalDurationMs,
        dispatchTargetTemplateId: options.dispatchTargetTemplateId,
      };

      await this.runtime.traceSink.record(trace);
      await this.emit({
        type: "activity.failed",
        timestamp: this.runtime.clock.now(),
        data: { executionId, templateId: template.id, error: message },
      });
      this.evictExecutionScope({
        inputImpulseIds,
        outputImpulseIds,
        isTopLevel: !options.parentExecutionId && compositionChain.length === 0,
      });
      return trace;
    }
  }

  /**
   * Release impulses added during this execution back to GC.
   *
   * The `ExecutionRuntime.store` is shared across all executions on a long-
   * lived `GoalHost` instance (constructed once, reused for every runGoal).
   * Without explicit eviction it accumulates impulses indefinitely — every
   * subscriber dispatch, every nested compose, every recommend->execute pass
   * adds rows. Content fields routinely hold LLM completions / file bodies
   * (KB–MB per impulse). Over thousands of executions the store retains
   * hundreds of MB of strings, none of which V8 can free because the store
   * still references them. Anonymous mmap mappings under Bun's allocator
   * track those string buffers and grow without bound; `process.memoryUsage()`
   * understates the cost because Bun's native allocator is not surfaced in
   * heapUsed. This matches the cgroup-vs-JS divergence signature in
   * concept_T-CTTOEl97IM.
   *
   * Top-level executions clear the entire store (clean slate per runGoal).
   * Nested executions only evict their own seeded inputs + intermediate
   * outputs that the parent doesn't need — declared outputs survive because
   * `dispatchCompose` reads them via `runtime.store.get(id)` after the
   * child returns. We treat all tracked output impulse ids as keepable for
   * nested executions; the parent's eviction at top level reaps them.
   */
  private evictExecutionScope(opts: {
    inputImpulseIds: string[];
    outputImpulseIds: Set<string>;
    isTopLevel: boolean;
  }): void {
    try {
      if (opts.isTopLevel) {
        // Clean slate: every impulse seen during this top-level execution
        // (seeded inputs, every output of every task, every subscriber-
        // injected lifecycle impulse, every nested compose output) is no
        // longer needed in-process. The trace + impulse refs are durable
        // via traceSink.record() already.
        const store = this.runtime.store as unknown as { impulses: Map<string, Impulse> };
        if (store.impulses && typeof store.impulses.clear === "function") {
          store.impulses.clear();
        }
      } else {
        // Nested execution: evict only seeded inputs. Outputs stay live so
        // the parent's compose path can read them via `runtime.store.get`.
        for (const id of opts.inputImpulseIds) {
          const store = this.runtime.store as unknown as { impulses: Map<string, Impulse> };
          store.impulses?.delete?.(id);
        }
      }
    } catch {
      // Eviction is a cleanup; never fail an execution because of it.
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
      maxCompositionDepth?: number;
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

    // Forward-dispatch composition-depth gate (Phase 2 of obsidian meta-skill,
    // 2026-06-01). Complements the existing parent_execution_id read-walk
    // cap (16) at the trace level. When an authored template tries to
    // recurse beyond maxCompositionDepth, refuse BEFORE the child execution
    // starts so the cap is observable as a safety_breach rather than as a
    // budget-exhausted cascade.
    const cap = opts.maxCompositionDepth ?? 16;
    if (opts.compositionChain.length >= cap) {
      throw new Error(
        `safety_breach: compose dispatch refused — composition chain depth ` +
        `(${opts.compositionChain.length}) has reached the cap (${cap}). ` +
        `Task '${task.id}' would target '${task.subActivityId}'.`,
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
      maxCompositionDepth: opts.maxCompositionDepth,
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

  /**
   * Resolve declared input shapes against the current impulse store.
   *
   * Per audit investigation-028 recommendation C (inv-028 C, 2026-05-27):
   * the previous implementation threw immediately if a declared shape was
   * absent from the store, even though slot-binding subscribers fire on
   * `lifecycle:task:preBinding` and are expected to populate the missing
   * shape before this point. The previous "synchronous-enough" assumption
   * was the fragility the audit flagged.
   *
   * This version polls the store for each missing shape with a configurable
   * deadline. Default `EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS = 0` preserves
   * the original behavior (no waiting). Set to a positive value (e.g. 5000)
   * to give lifecycle subscribers a deterministic window to populate the
   * store before this throws.
   *
   * Implementation: per-shape independent polling. As soon as a shape's
   * candidates appear (and meet the cardinality requirement), it's
   * resolved. The deadline applies to the slowest shape, not the sum.
   *
   * Polling cadence: 50ms. Microtask-friendly — gives event loop time to
   * dispatch subscribers between checks.
   */
  private async resolveInputs(
    shapes: (string | InputShapeRef)[],
    taskId: string,
  ): Promise<Impulse[]> {
    const timeoutMs = parseInt(
      process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"] ?? "0",
      10,
    );
    const deadline = Date.now() + (Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : 0);
    const POLL_INTERVAL_MS = 50;

    const resolved: Impulse[] = [];

    for (const entry of shapes) {
      const ref: InputShapeRef = typeof entry === "string"
        ? { shape: entry, cardinality: "any" }
        : { cardinality: "any", ...entry };

      const filterCandidates = (): Impulse[] => {
        const byShape = this.runtime.store.findByShape(ref.shape);
        return ref.producedBy
          ? byShape.filter((imp) =>
              imp.metadata.producedBy === ref.producedBy
              || imp.metadata.produced_at_task_id === ref.producedBy,
            )
          : byShape;
      };

      let candidates = filterCandidates();

      // Poll loop: wait for slot-binding subscribers to populate the store.
      // No-op when EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS=0 (default).
      while (candidates.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        candidates = filterCandidates();
      }

      if (candidates.length === 0) {
        const predDesc = ref.producedBy ? ` (producedBy=${ref.producedBy})` : "";
        const waitDesc = timeoutMs > 0
          ? ` (waited ${timeoutMs}ms for slot-binding subscribers)`
          : "";
        throw new Error(
          `Task '${taskId}' requires shape '${ref.shape}'${predDesc} but no matching impulses were found${waitDesc}`,
        );
      }

      if (ref.cardinality === "exactly_one" && candidates.length > 1) {
        throw new Error(
          `Task '${taskId}' requires exactly one '${ref.shape}' impulse but found ${candidates.length}`,
        );
      }

      resolved.push(...candidates);
    }

    return resolved;
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
