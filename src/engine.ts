import type { ActivityTask, ActivityTemplate, ExecutionTaskRecord, ExecutionTrace, FailureMode, Impulse, InputShapeRef, LifecycleEvent } from "./ontology";
import { getImpulseShape } from "./ontology";
import type { CreateImpulseInput } from "./impulses";
import type { ResolverContext } from "./resolvers";
import { ExecutionRuntime } from "./runtime";
import { VesselResolver } from "./adapters/vessel-resolver";
import { classifyShape } from "./shape-lifecycle";

/**
 * Leaf-LLM cost pricing — MEASUREMENT SEAM.
 *
 * Per-task cost for a LEAF LLM resolver call is priced here from the token
 * usage the resolver stamps into its output-impulse metadata
 * (`metadata.usage = { input_tokens, output_tokens }`; see
 * resolvers/llm-prompt.ts). Without this, taskCostUsd stayed 0 for every leaf
 * LLM call, so totalCostUsd aggregated to 0 and per-arm cost could not be
 * compared. (compose / compose_parallel tasks already price from their child
 * trace — only the leaf path was missing.)
 *
 * This constant is the SEAM that should later read a SHAPED pricing impulse
 * (law 1 — behaviour steered by shapes read at use time) instead of an
 * in-process constant. Until that impulse exists, these are bootstrap-only
 * defaults. Rates are USD per token (per-million list price / 1e6). Keys match
 * as case-insensitive substrings of the model id (provider prefix + date
 * suffix tolerated), longest key first, so e.g.
 * "anthropic/claude-haiku-4-5-20251001" resolves to the "haiku" tier.
 */
export const MODEL_PRICES: Record<string, { inRate: number; outRate: number }> = {
  opus: { inRate: 15 / 1e6, outRate: 75 / 1e6 },
  sonnet: { inRate: 3 / 1e6, outRate: 15 / 1e6 },
  haiku: { inRate: 1 / 1e6, outRate: 5 / 1e6 },
};

/** Fallback rate when a model id matches no MODEL_PRICES key (sonnet-tier). */
const DEFAULT_MODEL_PRICE = { inRate: 3 / 1e6, outRate: 15 / 1e6 };

/**
 * Price a leaf LLM call from its token usage. Returns 0 when no tokens are
 * present, preserving byte-identical behaviour for calls that carry no usage
 * (backward-compatible: absent tokens => cost stays 0 as before this seam).
 */
/**
 * What a task's resolver was actually called with, made safe to persist in a trace.
 *
 * Two constraints, both real rather than defensive. SECRETS: synthesised shell commands and
 * fetch headers carry tokens, and a trace is read by the ribosome, the drafter and any
 * operator — so key-looking fields are replaced, not truncated, because a truncated secret is
 * still a leaked prefix. SIZE: a config can carry a whole document body and traces are already
 * under retention pressure, so long values are cut with a marker that says so rather than
 * silently.
 *
 * Redacts by KEY NAME and not by value pattern: a value-sniffing redactor fails open on the
 * secret it does not recognise, and the key name is what the caller controls.
 */
export function redactResolvedConfig(config: unknown, maxValueChars = 600): Record<string, unknown> | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|authorization|auth|credential|bearer|cookie|private[_-]?key)/i;
  const walk = (v: unknown, keyName: string, depth: number): unknown => {
    if (SECRET_KEY.test(keyName)) return "[redacted]";
    if (depth > 4) return "[depth-capped]";
    if (typeof v === "string") {
      return v.length > maxValueChars ? `${v.slice(0, maxValueChars)}…[+${v.length - maxValueChars} chars]` : v;
    }
    if (Array.isArray(v)) return v.slice(0, 20).map((e) => walk(e, keyName, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val, k, depth + 1);
      return out;
    }
    return v;
  };
  const result = walk(config, "", 0);
  return result && typeof result === "object" ? (result as Record<string, unknown>) : undefined;
}

export function priceLlmUsage(
  model: string | undefined,
  inTokens: number | undefined,
  outTokens: number | undefined,
): number {
  const inTok = inTokens ?? 0;
  const outTok = outTokens ?? 0;
  if (inTok === 0 && outTok === 0) return 0;
  const id = (model ?? "").toLowerCase();
  const key = Object.keys(MODEL_PRICES)
    .sort((a, b) => b.length - a.length)
    .find((k) => id.includes(k));
  const rate = key ? MODEL_PRICES[key]! : DEFAULT_MODEL_PRICE;
  return inTok * rate.inRate + outTok * rate.outRate;
}

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
  /** Ancestor TEMPLATE ids (not execution ids), for cycle detection when an activity
   *  composes another activity — rejects A -> ... -> A before it recurses, instead of
   *  only tripping the depth cap at 16. Prerequisite for activities-as-resolvers. */
  compositionTemplateChain?: string[];
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

  /** Output impulse ids the last top-level execution deliberately left in the
   *  store so its caller could read the content back after execute() returned.
   *  Reaped at the next top-level entry — see execute() and
   *  evictExecutionScope(). Tracking the ids (rather than clearing the store)
   *  keeps caller-seeded impulses, which this class does not own, intact. */
  private readonly retainedOutputIds = new Set<string>();

  async execute(template: ActivityTemplate, options: ExecuteOptions = {}): Promise<ExecutionTrace> {
    const executionId = this.runtime.random.id("exec");
    const startedAt = this.runtime.clock.now();
    const compositionChain = options.compositionChain ?? [];
    const compositionTemplateChain = options.compositionTemplateChain ?? [];

    // Reap the PREVIOUS top-level execution's retained outputs before seeding
    // this one. evictExecutionScope deliberately leaves those behind so the
    // caller can read its content back after execute() returns (see there);
    // reaping here, rather than on the way out, is what bounds that retention
    // to a single execution instead of letting it accumulate across runs.
    //
    // Reap ONLY the ids this class retained. A caller may legitimately seed the
    // store directly via `runtime.store.put()` instead of `options.impulses`
    // (several fixtures and the predicate-binding path do exactly that), and
    // those impulses are not ours to discard — a blanket clear here silently
    // starved task binding of its inputs.
    if (!options.parentExecutionId && compositionChain.length === 0) {
      const store = this.runtime.store as unknown as { impulses?: Map<string, Impulse> };
      for (const id of this.retainedOutputIds) store.impulses?.delete?.(id);
      this.retainedOutputIds.clear();
    }

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
    // M1 general close-on-failure: track the task currently in-flight so the outer
    // catch can record it as a MEASURED failed task (closure) on ANY throw path
    // (validity-check failure, resolver error, etc.) instead of leaving tasks=null.
    let inFlightTask: ActivityTask | undefined;
    let inFlightInputs: Impulse[] = [];
    const inputImpulseIds = seededImpulses.map((impulse) => impulse.id);
    // Decision-time pool shapes = the state the selection conditioned on. Threaded onto
    // every returned trace (below) so the trace-sink records input_impulse_shapes and the
    // state-conditioned Thompson posterior is keyed by the same shapes recommend read.
    const inputShapes = [...new Set(seededImpulses.map(getImpulseShape).filter((s): s is string => !!s))];
    const outputImpulseIds = new Set<string>();
    let totalCostUsd = 0;
    let totalTokensInput = 0;
    let totalTokensOutput = 0;
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
    // TEMPLATE-DECLARED DEFAULTS (2026-08-02). A template may declare
    // `variables: [{ name, required: false, default }]`, but nothing merged those
    // defaults into the execution, so an unsupplied variable was simply ABSENT.
    // In a conditional gate that is fatal rather than defaulted: the interpolator
    // throws UNRESOLVABLE_GATE (engine.interpolation.ts, `resolveDottedPath` ->
    // `if (!res.found) throw unresolvable(...)`), so the whole execution FAILS at
    // that task instead of taking the declared-default branch.
    //
    // Measured: `ribosome-extract` reached its final task `dispatch_write_attempt`
    // and died on `{{variables.applyExtraction}} which cannot be resolved` — 218
    // UNRESOLVABLE_GATE / 457 failed in 6h, i.e. extraction ran the full quality
    // chain and then threw away the result. Three templates fleet-wide use a
    // defaulted variable inside a gate; all three are the activity-lifecycle
    // machinery (ribosome-extract, prune-activity, replace-activity).
    //
    // Seeding is STRICTLY CONSERVATIVE — each declared default resolves the gate
    // to the branch the template author intended, never to a more destructive one:
    //   applyExtraction=false   gate `== 'true'`   -> write task SKIPS (no mint)
    //   dryRun=true             gate `== 'false'`  -> deprecate SKIPS (dry-run kept)
    //   requireValidation=true  gate `== 'true'`   -> validation RUNS
    // Caller-provided variables still win: like the executionId seed below, this
    // only fills holes.
    for (const v of template.variables ?? []) {
      if (v?.name && v.default !== undefined && accumulatedVariables[v.name] === undefined) {
        accumulatedVariables[v.name] = v.default;
      }
    }
    // Reverse map of {{<priorTaskId>_<shape>}} placeholder keys -> shape name, so a
    // consuming task's interpolation references reveal which shapes it ACTUALLY consumes
    // (the empirical input contract). Populated as each task's shape-keyed outputs are
    // projected below; read when building the next tasks' inputShapes.
    const shapeKeyOf: Record<string, string> = {};
    // Parallel reverse map: placeholder key -> the task id that PRODUCED it
    // (option B placeholder-provenance). For {{<taskId>}} (bare) and
    // {{<taskId>_<shape>}} keys, records <taskId> so a consuming task's
    // interpolation references reveal which producer task it consumed from.
    // Read when building consumedFromTaskIds; mapped to producing activities
    // (childActivityId) by the composition-edge reconcile to derive genuine
    // producer->consumer capability edges.
    const producerTaskOf: Record<string, string> = {};
    // Seed the substrate's root identifiers so templates can interpolate them
    // (e.g. {{executionId}} into http_fetch bodies for concept_create_write).
    // Caller-provided variables of the same name take precedence — the seed
    // only fills holes.
    if (accumulatedVariables.executionId === undefined) {
      accumulatedVariables.executionId = executionId;
    }
    if (accumulatedVariables.execution_id === undefined) {
      accumulatedVariables.execution_id = executionId;
    }

    // ── Lifecycle-subscriber contract wiring (gap ias-executor-template-contract-mismatch) ──
    // Subscriber dispatchers (hosts/goal-host.ts) seed the triggering
    // lifecycle event's payload as an impulse (metadata.source ===
    // "lifecycle-event", metadata.shape = the event type). That payload is
    // what {{lifecycle.*}} config placeholders and conditional gates resolve
    // against in the dispatch loop below.
    const lifecycleTriggerData: Record<string, unknown> | undefined = (() => {
      for (const imp of seededImpulses) {
        const meta = imp.metadata as Record<string, unknown> | undefined;
        const shape = typeof meta?.["shape"] === "string" ? (meta["shape"] as string) : "";
        if (meta?.["source"] === "lifecycle-event" || shape.startsWith("lifecycle:")) {
          if (imp.content !== null && typeof imp.content === "object" && !Array.isArray(imp.content)) {
            return imp.content as Record<string, unknown>;
          }
        }
      }
      return undefined;
    })();
    // Expose the payload as the `lifecycle` variable so task PROMPTS reach it
    // through the existing dotted-path interpolation in llm-prompt.ts
    // ({{lifecycle.taskId}} → variables.lifecycle.taskId). Caller-provided
    // variables of the same name take precedence.
    if (lifecycleTriggerData !== undefined && accumulatedVariables.lifecycle === undefined) {
      accumulatedVariables.lifecycle = lifecycleTriggerData;
    }
    // Gates and config interpolation must see the same `lifecycle` context the
    // prompts do: a caller that passes `variables.lifecycle` without seeding a
    // lifecycle-event impulse (the reach→mint path in goal-host) would otherwise
    // hit UNRESOLVABLE_GATE on every {{lifecycle.*}} gate — a structurally
    // unmintable ribosome-extract. Trigger-event payload keeps precedence.
    const lifecycleContext: Record<string, unknown> =
      lifecycleTriggerData ??
      (accumulatedVariables.lifecycle !== null &&
      typeof accumulatedVariables.lifecycle === "object" &&
      !Array.isArray(accumulatedVariables.lifecycle)
        ? (accumulatedVariables.lifecycle as Record<string, unknown>)
        : {});
    // Tasks skipped by a false conditional gate (or by depending on one).
    const skippedTaskIds = new Set<string>();
    // {{impulse:<slot>}} gate operands: prefer impulses stamped with
    // metadata.outputImpulseKey === slot (named-output slots, stamped in the
    // loop below), then metadata.shape === slot. First match wins
    // (outputImpulseKey preferred). Falls back to an accumulated variable of the
    // same name.
    const resolveImpulseSlot = (slot: string): string | undefined => {
      console.error("[rIS-debug]", JSON.stringify({ slot, storeKeys: this.runtime.store.all().map((i) => (i.metadata as Record<string, unknown>)?.["outputImpulseKey"]).filter(Boolean), shapes: this.runtime.store.all().map((i) => (i.metadata as Record<string, unknown>)?.["shape"]).filter(Boolean) }));
      console.error("[rIS-debug2]", JSON.stringify({ slot, headContent: (() => { const h = slot.indexOf(".") >= 0 ? slot.slice(0, slot.indexOf(".")) : slot; const imp = this.runtime.store.all().find((i) => (i.metadata as Record<string, unknown>)?.["outputImpulseKey"] === h); return imp ? { type: typeof imp.content, preview: (typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content)).slice(0, 400) } : "HEAD_NOT_FOUND"; })() }));
    const dot = slot.indexOf(".");
      const head = dot >= 0 ? slot.slice(0, dot) : slot;
      const tail = dot >= 0 ? slot.slice(dot + 1) : "";

      let impulse: Impulse | undefined;
      // Try by outputImpulseKey
      for (const imp of this.runtime.store.all()) {
        const meta = imp.metadata as Record<string, unknown> | undefined;
        if (meta?.["outputImpulseKey"] === head) {
          impulse = imp;
          break;
        }
      }
      // Fallback to by shape
      if (!impulse) {
        for (const imp of this.runtime.store.all()) {
          const meta = imp.metadata as Record<string, unknown> | undefined;
          if (meta?.["shape"] === head) {
            impulse = imp;
            break;
          }
        }
      }

      let rawResolved: string | undefined;
      if (impulse) {
        rawResolved = typeof impulse.content === "string" ? impulse.content : JSON.stringify(impulse.content ?? "");
      } else {
        // Fallback to accumulated variables (e.g., from priorTaskId_text)
        const v = accumulatedVariables[head];
        if (v !== undefined) {
          rawResolved = typeof v === "string" ? v : JSON.stringify(v);
        }
      }

      if (!rawResolved || tail === "") {
        return rawResolved;
      }

      try {
        let parsed: unknown; try { parsed = JSON.parse(rawResolved); } catch (pe) { const a = rawResolved.indexOf("{"); const b = rawResolved.lastIndexOf("}"); if (a >= 0 && b > a) { parsed = JSON.parse(rawResolved.slice(a, b + 1)); } else { throw pe; } }
        const segments = tail.split(".");
        for (const segment of segments) {
          if (typeof parsed !== "object" || parsed === null || !Object.prototype.hasOwnProperty.call(parsed, segment)) {
            return undefined;
          }
          parsed = (parsed as Record<string, unknown>)[segment];
        }
        if (typeof parsed === "string") {
          return parsed;
        } else if (parsed !== undefined) {
          return JSON.stringify(parsed);
        } else {
          return undefined; // Resolved to undefined value
        }
      } catch {
        return undefined; // Content is not JSON or path is invalid
      }
    };

    // Pre-register discovery-routed VesselResolvers for any task resolver that
    // is neither locally registered nor "compose"/"compose_parallel" — cross-
    // vessel shapes like fleetActivityFeed served only by another vessel.
    // Best-effort: lookup failures fall through to the existing
    // resolver_not_registered close-on-failure path.
    if (this.runtime.discovery) {
      for (const rawTask of template.tasks ?? []) {
        const rid = typeof (rawTask as { resolver?: unknown }).resolver === "string" ? (rawTask as { resolver: string }).resolver : "";
        if (!rid || rid === "compose" || rid === "compose_parallel" || this.runtime.resolvers.has(rid)) continue;
        try {
          const producers = await this.runtime.discovery.lookupShapeProducers(rid);
          // healthScore-aware pick (first increment onto the learned-selection
          // primitive): prefer the healthiest producer with a usable endpoint.
          // healthScore is optional (undefined when discovery omits health_score);
          // `!producer` seeds first-match and strict `>` keeps ties/all-missing on
          // the FIRST eligible producer — behaviour-identical to the old .find when
          // no scores are present — and returns undefined when none are eligible.
          let producer: (typeof producers)[number] | undefined;
          for (const candidate of producers) {
            if (typeof candidate.resolveEndpoint !== "string" || candidate.resolveEndpoint.length === 0) continue;
            if (!producer || (candidate.healthScore ?? -Infinity) > (producer.healthScore ?? -Infinity)) {
              producer = candidate;
            }
          }
          if (producer) {
            this.runtime.resolvers.register(new VesselResolver({ id: rid, tier: "external", shape: rid, resolveEndpoint: producer.resolveEndpoint, apiKey: this.runtime.vesselApiKey ?? "" }));
          }
        } catch { /* discovery unreachable — leave to close-on-failure */ }
      }
    }
    try {
      for (const rawTask of template.tasks) {
        inFlightTask = undefined;

        // ── Lifecycle-subscriber contract: gates + {{lifecycle.*}} interpolation ──
        // (gap ias-executor-template-contract-mismatch; helpers above class)
        const recordSkip = async (reason: string): Promise<void> => {
          skippedTaskIds.add(rawTask.id);
          // Skipped ≠ success and ≠ failure: no resolver ran. The record
          // carries skipped=true; success=true only keeps the trace's
          // clean-chain finalization — consumers distinguish via the flag.
          taskRecords.push({
            taskId: rawTask.id,
            description: rawTask.description,
            resolverId: rawTask.resolver,
            inputImpulseIds: [],
            outputImpulseIds: [],
            inputShapes: [],
            outputShapes: [],
            success: true,
            skipped: true,
            durationMs: 0,
          });
          await this.emit({
            type: "task.skipped",
            timestamp: this.runtime.clock.now(),
            data: { executionId, taskId: rawTask.id, templateId: template.id, reason },
          });
        };
        // Dependency-skip propagation: a task whose dependency was skipped is
        // skipped too (validator-dispatch's documented chain contract — its
        // gate references {{impulse:...}} slots the skipped task never filled).
        const deps = Array.isArray(rawTask["dependencies"]) ? (rawTask["dependencies"] as unknown[]) : [];
        if (deps.some((d) => typeof d === "string" && skippedTaskIds.has(d))) {
          await recordSkip("dependency_skipped");
          continue;
        }
        if (rawTask["conditional"] !== undefined && rawTask["conditional"] !== null) {
          let gateOpen: boolean;
          try {
            gateOpen = evaluateConditionalGate(rawTask["conditional"], {
              taskId: rawTask.id,
              lifecycleData: lifecycleContext,
              variables: accumulatedVariables,
              resolveImpulseSlot,
            });
          } catch (gateErr) {
            // Loud, MEASURED failure: record the task, then fail the
            // execution — an unresolvable gate must never silently run.
            taskRecords.push({
              taskId: rawTask.id,
              description: rawTask.description,
              resolverId: rawTask.resolver,
              inputImpulseIds: [],
              outputImpulseIds: [],
              inputShapes: [],
              outputShapes: [],
              success: false,
              error: gateErr instanceof Error ? gateErr.message : String(gateErr),
            });
            throw gateErr;
          }
          if (!gateOpen) {
            await recordSkip("conditional_false");
            continue;
          }
        }
        // Interpolate {{lifecycle.*}} placeholders in the task config with the
        // triggering lifecycle impulse's data BEFORE any resolver / compose
        // dispatch sees it. Unresolvable ⇒ structured UNRESOLVABLE_PLACEHOLDER
        // throw — the literal placeholder string never reaches a resolver.
        let task: ActivityTask = rawTask;
        if (rawTask.config) {
          try {
            // This pass resolves {{impulse:<slot>}} and {{impulse:<slot>.<field>}} placeholders in the task config into their concrete values.
    const interpolateImpulseRefs = (value: unknown): unknown => {
              if (typeof value === "string") {
                return value.replace(/\{\{\s*impulse:([^}]+?)\s*\}\}/g, (m, slot) => {
                  const r = resolveImpulseSlot(String(slot).trim());
                  return r === undefined ? m : r;
                });
              }
              if (Array.isArray(value)) {
                return value.map(interpolateImpulseRefs);
              }
              if (value && typeof value === "object") {
                const out: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
                  out[k] = interpolateImpulseRefs(v);
                }
                return out;
              }
              return value;
            };
            task = {
              ...rawTask,
              config: interpolateImpulseRefs(resolveLifecyclePlaceholders(rawTask.config, lifecycleContext, rawTask.id)) as Record<string, unknown>,
            };
          } catch (interpErr) {
            taskRecords.push({
              taskId: rawTask.id,
              description: rawTask.description,
              resolverId: rawTask.resolver,
              inputImpulseIds: [],
              outputImpulseIds: [],
              inputShapes: [],
              outputShapes: [],
              success: false,
              error: interpErr instanceof Error ? interpErr.message : String(interpErr),
            });
            throw interpErr;
          }
        }
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
          const poolImpulses = this.runtime.store.all();
          const poolShapes = poolImpulses.map((imp) => getImpulseShape(imp));
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
              // Impulse ids currently in the pool — slot-binding's
              // agent_fill_fallback / escalate_unbindable interpolate
              // {{lifecycle.currentImpulseIds}} (contract documented in
              // templates/lifecycle/slot-binding.json).
              currentImpulseIds: poolImpulses.map((imp) => imp.id),
              missingShapes,
              variables: options.variables ?? {},
              parentDepth: compositionChain.length,
              parentGoalText: options.goalContext?.goal,
              // Thread parent tags so lifecycle-subscriber-dispatched child
              // executions inherit them (state_signature:<hash> in particular,
              // required for boredom's per-(signature, goal_idx) Thompson cells).
              tags: options.tags,
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
        inFlightTask = task;
        inFlightInputs = inputImpulses;
        // Empirical input-shape discovery: scan this task's config + prompt for
        // {{<priorTaskId>_<shape>}} references and collect the shapes they consume.
        // Most activities declare no inputShapes and chain purely via these
        // placeholders, so this is the only signal of what state the task consumes.
        // Scan once for BOTH the consumed shapes (shapeKeyOf) and the producer
        // task ids (producerTaskOf) referenced by this task's {{placeholders}}.
        // placeholderConsumedFrom is the option-B provenance edge signal.
        const { placeholderConsumedShapes, placeholderConsumedFrom } = ((): {
          placeholderConsumedShapes: string[];
          placeholderConsumedFrom: string[];
        } => {
          try {
            const refText =
              JSON.stringify(task.config ?? {}) + "\u0000" + ((task.prompt as { template?: string } | undefined)?.template ?? "");
            const shapes = new Set<string>();
            const producers = new Set<string>();
            for (const m of refText.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
              const tok = (m[1] ?? "").trim();
              if (!tok) continue;
              if (Object.prototype.hasOwnProperty.call(shapeKeyOf, tok)) shapes.add(shapeKeyOf[tok]!);
              if (Object.prototype.hasOwnProperty.call(producerTaskOf, tok)) producers.add(producerTaskOf[tok]!);
            }
            return { placeholderConsumedShapes: [...shapes], placeholderConsumedFrom: [...producers] };
          } catch {
            return { placeholderConsumedShapes: [], placeholderConsumedFrom: [] };
          }
        })();
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
        // The activity this task dispatched (compose / compose_parallel), so the
        // composition-edge reconcile can map a consumed producer task -> its
        // producing activity for option-B placeholder-provenance edges.
        let dispatchedActivityId: string | undefined;

        if (task.resolver === "compose") {
          // Nested composition: dispatch to a sub-activity template
          const result = await this.dispatchCompose(task, {
            executionId,
            inputImpulses,
            compositionChain,
            compositionTemplateChain: [...compositionTemplateChain, template.id],
            variables: accumulatedVariables,
            budget,
            maxCompositionDepth: options.maxCompositionDepth,
            tags: options.tags,
          });
          storedOutputs = result.outputs;
          taskCostUsd = result.childTrace.costUsd;
          childExecutionId = result.childTrace.id;
          dispatchedActivityId = result.childTrace.templateId;
          if (result.childTrace.costUsd !== undefined) {
            totalCostUsd += result.childTrace.costUsd;
          }
          for (const impulse of storedOutputs) {
            outputImpulseIds.add(impulse.id);
          }
        } else if (task.resolver === "compose_parallel") {
          // Horizontal composition (SUBSTRATE_AS_MDP §7): dispatch N children
          // concurrently as sibling trajectories under this task's parent
          // execution id, join their output pools by shape-union. The breadth-
          // first dual of `compose`. Siblings sharing parent_execution_id are
          // what activity-api's propagateCreditAlongChain averages over (so a
          // shared ancestor is not k-fold credit-inflated when k siblings fire).
          const result = await this.dispatchComposeParallel(task, {
            executionId,
            inputImpulses,
            compositionChain,
            compositionTemplateChain: [...compositionTemplateChain, template.id],
            variables: accumulatedVariables,
            budget,
            maxCompositionDepth: options.maxCompositionDepth,
            tags: options.tags,
          });
          storedOutputs = result.outputs;
          taskCostUsd = result.totalChildCostUsd;
          // Representative child id for the task record; activity-api recovers
          // the full sibling set by grouping child traces on parent_execution_id.
          childExecutionId = result.childTraces[0]?.id;
          dispatchedActivityId = result.childTraces[0]?.templateId;
          totalCostUsd += result.totalChildCostUsd;
          for (const impulse of storedOutputs) {
            outputImpulseIds.add(impulse.id);
          }
        } else {
          const resolver = this.runtime.resolvers.get(task.resolver);
          if (!resolver) {
            // ACTIVITIES-AS-RESOLVERS (SUBSTRATE_AS_REPRESENTATION §1: "each axis can
            // itself be a subsystem with its own span"). If this resolver id names a
            // known ACTIVITY template, dispatch it via compose (cycle-guarded by
            // compositionTemplateChain) instead of hard-failing. A task then routes to
            // the activity-subsystem that produces what it needs, so composition /
            // topology SELF-ASSEMBLES — and this closes M1 for the activity case
            // (a resolver name that is actually an activity is no longer a tasks=null
            // black hole). Leaf resolvers fall through to close-on-failure below.
            const composeActivity = this.runtime.templateProvider
              ? await this.runtime.templateProvider.getTemplate(task.resolver).catch(() => null)
              : null;
            if (composeActivity && Array.isArray((composeActivity as ActivityTemplate).tasks)) {
              const cr = await this.dispatchCompose(
                { ...task, subActivityId: task.resolver },
                {
                  executionId,
                  inputImpulses,
                  compositionChain,
                  compositionTemplateChain: [...compositionTemplateChain, template.id],
                  variables: accumulatedVariables,
                  budget,
                  maxCompositionDepth: options.maxCompositionDepth,
                  tags: options.tags,
                },
              );
              const aOut = cr.outputs;
    const namedSlotsForActivity = Array.isArray((task as Record<string, unknown>)["outputImpulses"]) ? ((task as Record<string, unknown>)["outputImpulses"] as unknown[]).filter((v): v is string => typeof v === "string") : [];
    aOut.forEach((imp, idx) => { const slot = namedSlotsForActivity[idx]; if (slot) { const stamped = { ...imp, metadata: { ...((imp.metadata as Record<string, unknown>) ?? {}), outputImpulseKey: slot } }; this.runtime.store.put(stamped); } else { this.runtime.store.put(imp); }});
              for (const imp of aOut) outputImpulseIds.add(imp.id);
              if (cr.childTrace.costUsd !== undefined) totalCostUsd += cr.childTrace.costUsd;
              taskRecords.push({
                taskId: task.id,
                description: task.description,
                resolverId: task.resolver,
                resolverTier: "deterministic",
                resolvedConfig: redactResolvedConfig(task.config),
                inputImpulseIds: inputImpulses.map((imp) => imp.id),
                outputImpulseIds: aOut.map((imp) => imp.id),
                inputShapes: [
                  ...new Set([
                    ...declaredInputShapeNames,
                    ...inputImpulses.map((imp) => getImpulseShape(imp) || imp.pointer.type).filter(Boolean),
                    ...placeholderConsumedShapes,
                  ]),
                ],
                outputShapes: [...new Set(aOut.map((imp) => getImpulseShape(imp) || imp.pointer.type))],
                ...(() => {
                  const filesModified: string[] = [];
                  const filesCreated: string[] = [];
                  const materialsConsulted: string[] = [];
                  for (const imp of aOut) {
                    const p = (imp.pointer as { path?: unknown }).path;
                    if (typeof p !== "string" || !p) continue;
                    const shape = getImpulseShape(imp) || imp.pointer.type;
                    if (shape === "fileWriteResult") {
                      filesModified.push(p);
                    } else if (shape === "codeInsertResult") {
                      filesCreated.push(p);
                    } else if (
                      shape === "fileEditResult" ||
                      shape === "codeReplaceResult" ||
                      shape === "codeAddImportResult"
                    ) {
                      filesModified.push(p);
                    } else if (
                      shape === "fileContent" ||
                      shape === "codeReadResult" ||
                      shape === "codeSearchResult" ||
                      shape === "codeFindFunctionResult" ||
                      shape === "codeFindImportResult"
                    ) {
                      materialsConsulted.push(`file:${p}`);
                    }
                  }
                  const fm = [...new Set(filesModified)];
                  const fc = [...new Set(filesCreated)];
                  const mc = [...new Set(materialsConsulted)];
                  return {
                    ...(fm.length > 0 ? { filesModified: fm } : {}),
                    ...(fc.length > 0 ? { filesCreated: fc } : {}),
                    ...(mc.length > 0 ? { materialsConsulted: mc } : {}),
                  };
                })(),
                success: true,
                costUsd: cr.childTrace.costUsd,
                childExecutionId: cr.childTrace.id,
                consumedFromTaskIds: placeholderConsumedFrom,
                childActivityId: cr.childTrace.templateId,
              });
              // Project the activity's outputs into accumulatedVariables so downstream
              // tasks can reference {{<taskId>}} / {{<taskId>_<shape>}} as with any task.
              if (aOut.length > 0) {
                const first = aOut[0]!;
                const firstText = typeof first.content === "string"
                  ? first.content
                  : JSON.stringify(first.content ?? "");
                const cappedFirst = capForAccumulator(firstText);
                accumulatedVariables[task.id] = cappedFirst;
                accumulatedVariables[`${task.id}_text`] = cappedFirst;
                producerTaskOf[task.id] = task.id;
                for (const imp of aOut) {
                  const sh = (imp.metadata as { shape?: string } | undefined)?.shape;
                  if (sh) {
                    const k = `${task.id}_${sh}`;
                    shapeKeyOf[k] = sh;
                    producerTaskOf[k] = task.id;
                    if (!(k in accumulatedVariables)) {
                      accumulatedVariables[k] = capForAccumulator(
                        typeof imp.content === "string" ? imp.content : JSON.stringify(imp.content ?? ""),
                      );
                    }
                  }
                }
              }
              inFlightTask = undefined;
              await this.emit({
                type: "task.completed",
                timestamp: this.runtime.clock.now(),
                data: {
                  executionId,
                  taskId: task.id,
                  resolverId: task.resolver,
                  success: true,
                  outputImpulseIds: aOut.map((imp) => imp.id),
                  childExecutionId: cr.childTrace.id,
                },
              });
              continue;
            }
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
            // CLOSE-ON-FAILURE (M1): record a MEASURED failed task instead of
            // throwing into a tasks=null black hole. A resolver miss is a learnable
            // transition — preserve the consumed input shapes (the empirical input
            // contract + state signature) and the resolver-unavailable outcome so the
            // trace/activity store self-assembles its topology from failures too
            // ("topology learns from BOTH successes and failures"; "validity =
            // measurement against reality, not prediction"). The outer catch finalizes
            // the trace with status=failed and these task records.
            taskRecords.push({
              taskId: task.id,
              description: task.description,
              resolverId: task.resolver,
              resolverTier: undefined,
              resolvedConfig: redactResolvedConfig(task.config),
              inputImpulseIds: inputImpulses.map((imp) => imp.id),
              outputImpulseIds: [],
              inputShapes: [
                ...new Set([
                  ...declaredInputShapeNames,
                  ...inputImpulses.map((imp) => getImpulseShape(imp) || imp.pointer.type).filter(Boolean),
                  ...placeholderConsumedShapes,
                ]),
              ],
              outputShapes: [],
              success: false,
              error: `resolver_not_registered: ${task.resolver}`,
              consumedFromTaskIds: placeholderConsumedFrom,
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
          if (lastError !== undefined) {
            // CLOSE-ON-FAILURE (M1): a resolver that threw on all attempts is a
            // MEASURED transition, not a black hole. Record a failed task carrying
            // the consumed input shapes (empirical input contract + state signature)
            // and the error, THEN propagate so the outer catch finalizes the trace as
            // failed WITH task records — instead of tasks=null, which lost ALL signal
            // (input contract, which task/resolver failed, why) and starved the
            // topology of failure-edges. "Topology learns from BOTH successes and
            // failures." Transformers now COMPLETE (close) rather than vanishing.
            taskRecords.push({
              taskId: task.id,
              description: task.description,
              resolverId: task.resolver,
              resolverTier: this.runtime.resolvers.get(task.resolver)?.tier,
              resolvedConfig: redactResolvedConfig(task.config),
              inputImpulseIds: inputImpulses.map((imp) => imp.id),
              outputImpulseIds: [],
              inputShapes: [
                ...new Set([
                  ...declaredInputShapeNames,
                  ...inputImpulses.map((imp) => getImpulseShape(imp) || imp.pointer.type).filter(Boolean),
                  ...placeholderConsumedShapes,
                ]),
              ],
              outputShapes: [],
              success: false,
              error: lastError instanceof Error ? lastError.message : String(lastError),
              consumedFromTaskIds: placeholderConsumedFrom,
            });
            throw lastError;
          }

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
            storedOutputs.every(i => (i.metadata as Record<string, unknown>)?.["degraded"] === true) &&
            // A degraded READ from the impulse-resolve lookup resolver is
            // information-absence ("no pathway/rows yet", HTTP 4xx on a not-yet-served
            // shape, endpoint down) — a pathway-unknown outcome, NOT swallowed work.
            // It must NOT β-penalise or sink the walk; downstream composers read empty
            // signal tasks defensively. Only genuine swallowed-work degradation
            // (proxy / third-party resolvers, the F13 case) hard-fails here.
            !storedOutputs.every(i => (i.metadata as Record<string, unknown>)?.["source"] === "impulse-resolve")) {
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
              // Check 2b — JSON-artifact content validity. A `.json` file whose
              // bytes don't parse is a ghost-write: the task self-reports success
              // while writing an artifact that violates its own extension's
              // contract. This is exactly how a template that interpolates raw
              // (fenced, newline-bearing, quote-bearing) LLM text into a JSON
              // string slot ships 100%-unparseable proposal files past the
              // existence check. Parse is FENCE-TOLERANT — strip a leading
              // ```json fence + trailing ``` and slice the first balanced object,
              // mirroring the downstream consumers (apply-proposal-as-patch's
              // parseFirstJsonObject) — so intentionally-fenced reports that the
              // pipeline already tolerates do NOT regress, while structurally
              // broken content fails loudly with a β-penalty that pressures the
              // offending template to self-repair via the variant loop.
              if (resolvedPath.endsWith(".json")) {
                const written = await Bun.file(resolvedPath).text();
                if (!isParseableJsonArtifact(written)) {
                  throw new Error(
                    `convergent_validity[json_artifact]: fs_write reported success ` +
                    `but ${resolvedPath} does not contain parseable JSON (even after ` +
                    `fence-stripping). A .json artifact whose bytes are not JSON is a ` +
                    `ghost-write — likely raw text interpolated into a JSON string slot.`
                  );
                }
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
              // Keep this variant contract-complete for subscribers:
              // validator-dispatch's gate reads outputShapes/skip_validation,
              // the lifecycle-subscriber depth-cap reads parentDepth.
              outputShapes: [],
              skip_validation: task.config?.["skip_validation"] === true,
              allImpulseIds: this.runtime.store.all().map((imp) => imp.id),
              loadedImpulseIds: inputImpulses.filter((imp) => imp.loaded === true).map((imp) => imp.id),
              toolCallRecords: [],
              parentDepth: compositionChain.length,
              compositionChain,
              tags: options.tags,
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
          // Bare key (no suffix): {{<taskId>}} -> first output content. Matches the
          // dev-vessel cli executor convention so a seed authored as {{taskId}} binds
          // identically under BOTH the cli (run-local-seed) and the engine (autonomous
          // goal-host) paths. Without it, custom-resolver compose templates had to know
          // which executor would run them (the dual-convention footgun, 2026-06-19).
          accumulatedVariables[task.id] = (this as any).executionId;
          accumulatedVariables[`${task.id}_text`] = cappedFirstText;
          producerTaskOf[task.id] = task.id;
          // _content keeps the structural reference so resolvers that read
          // .content as an object (rather than .text) still see the full
          // payload. Strings get capped here too; objects fall through.
          accumulatedVariables[`${task.id}_content`] =
            typeof firstContent === "string" ? cappedFirstText : (firstContent ?? "");
          // _valueJson is kept verbatim (== _text) for back-compat: ~8 existing
          // seed templates interpolate {{x_valueJson}} INSIDE surrounding quotes
          // or inline in goal strings and depend on the raw form. Do NOT change it.
          accumulatedVariables[`${task.id}_valueJson`] = cappedFirstText;
          // _json is the JSON-ESCAPED form: a valid JSON string literal (escaped
          // quotes/newlines/backslashes, wrapped in double quotes). Use it WITHOUT
          // surrounding quotes in a template to embed a prior task's raw text inside
          // a JSON body, e.g. {"content": {{task_json}}}. Without this, authored
          // real-resolver-chains whose final task POSTs an LLM result interpolated
          // raw text (with quotes/newlines) into a JSON string slot and produced
          // "Invalid JSON body" 4xx — the same ghost-write class guarded at
          // engine.ts:472. JSON.stringify yields the escaped, quoted literal.
          accumulatedVariables[`${task.id}_json`] = JSON.stringify(cappedFirstText);
          // Shape-keyed access: {{<taskId>_<shape>}} maps to the first impulse
          // matching that shape.
          for (const impulse of storedOutputs) {
            const shape = (impulse.metadata as { shape?: string } | undefined)?.shape;
            if (shape) {
              const key = `${task.id}_${shape}`;
              shapeKeyOf[key] = shape;
              producerTaskOf[key] = task.id;
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

        const llmUsage = storedOutputs.map((i) => (i.metadata as { usage?: { input_tokens?: number; output_tokens?: number } } | undefined)?.usage).find((u) => u && typeof u.input_tokens === "number");
        if (llmUsage) {
          totalTokensInput += llmUsage.input_tokens ?? 0;
          totalTokensOutput += llmUsage.output_tokens ?? 0;
          // Leaf-LLM cost pricing (measurement plumbing). compose /
          // compose_parallel already set taskCostUsd from the child trace; a
          // LEAF llm call left it undefined, so totalCostUsd aggregated to 0 and
          // per-arm cost was uncomparable. Price from the stamped usage via the
          // MODEL_PRICES seam and fold into the aggregate. Absent tokens => 0
          // (byte-identical to prior behaviour).
          if (taskCostUsd === undefined) {
            const llmModel =
              (task.config?.["model"] as string | undefined) ??
              ((task as { prompt?: { model?: string } }).prompt?.model) ??
              (llmUsage as { model?: string }).model;
            const leafCostUsd = priceLlmUsage(llmModel, llmUsage.input_tokens, llmUsage.output_tokens);
            if (leafCostUsd > 0) {
              taskCostUsd = leafCostUsd;
              totalCostUsd += leafCostUsd;
            }
          }
        }

        taskRecords.push({
          taskId: task.id,
          description: task.description,
          resolverId: task.resolver,
          // Recorded AFTER interpolation: the value the resolver received is what a future
          // replay needs, not the template that produced it. See ExecutionTaskRecord.
          resolvedConfig: redactResolvedConfig(task.config),
          resolverTier: task.resolver === "compose" || task.resolver === "compose_parallel" ? "deterministic" : this.runtime.resolvers.get(task.resolver)?.tier,
          inputImpulseIds: inputImpulses.map((impulse) => impulse.id),
          outputImpulseIds: storedOutputs.map((impulse) => impulse.id),
          // Record the ACTUAL shapes of the resolved input impulses (unioned with
          // any declared input shapes) so the trace sink can union them into
          // trace.input_impulse_shapes. Required by activity-api's server-side
          // state_signature path (execution-traces.ts:2419-2441) which gates the
          // conditional context_thompson_scores writes (M2 state-signature keying).
          // Previously this recorded only `declaredInputShapeNames`, but input
          // shapes are OPTIONAL on a template task, so input-consuming activities
          // that don't redundantly re-declare their inputs shipped EMPTY
          // input_impulse_shapes → signature never derived → conditional posteriors
          // were starved and selection stayed state-blind. Mirror the actual-shape
          // logic used for outputShapes below (getImpulseShape over the resolved
          // impulses) so a trace records the real state S it consumed.
          inputShapes: [
            ...new Set([
              ...declaredInputShapeNames,
              ...inputImpulses.map((imp) => getImpulseShape(imp) || imp.pointer.type).filter(Boolean),
              ...placeholderConsumedShapes,
            ]),
          ],
          // Record actual shapes of output impulses so coverage_tick and
          // activity-api can distinguish "shape actually produced" from
          // "shape the template declares it might produce". Previously all
          // 600 traces had output_shapes=None, making coverage_tick fall
          // back to template declarations — a proxy, not a measurement.
          outputShapes: this.shapesOfImpulses(task, storedOutputs),
          ...(() => {
              const filesModified: string[] = [];
              const filesCreated: string[] = [];
              const materialsConsulted: string[] = [];
              for (const imp of storedOutputs) {
                const p = (imp.pointer as { path?: unknown }).path;
                if (typeof p !== "string" || !p) continue;
                const shape = getImpulseShape(imp) || imp.pointer.type;
                if (shape === "fileWriteResult" || shape === "fileEditResult" || shape === "codeReplaceResult" || shape === "codeAddImportResult") {
                  filesModified.push(p);
                } else if (shape === "codeInsertResult") {
                  filesCreated.push(p);
                } else if (shape === "fileContent" || shape === "codeReadResult" || shape === "codeSearchResult" || shape === "codeFindFunctionResult" || shape === "codeFindImportResult") {
                  materialsConsulted.push(`file:${p}`);
                }
              }
              const fm = [...new Set(filesModified)];
              const fc = [...new Set(filesCreated)];
              const mc = [...new Set(materialsConsulted)];
              return {
                ...(fm.length > 0 ? { filesModified: fm } : {}),
                ...(fc.length > 0 ? { filesCreated: fc } : {}),
                ...(mc.length > 0 ? { materialsConsulted: mc } : {}),
              };
            })(),
          success: true,
          costUsd: taskCostUsd,
          tokensInput: llmUsage?.input_tokens,
          tokensOutput: llmUsage?.output_tokens,
          durationMs: taskDurationMs,
          childExecutionId,
          consumedFromTaskIds: placeholderConsumedFrom,
          childActivityId: dispatchedActivityId,
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
            // Contract fields consumed by validator-dispatch's conditional
            // gate ({{lifecycle.skip_validation}}) and its
            // learning_signal_write config (allImpulseIds / loadedImpulseIds /
            // toolCallRecords). The engine keeps no tool-call transcript, so
            // an empty array is the honest value.
            skip_validation: task.config?.["skip_validation"] === true,
            allImpulseIds: this.runtime.store.all().map((imp) => imp.id),
            loadedImpulseIds: inputImpulses.filter((imp) => imp.loaded === true).map((imp) => imp.id),
            toolCallRecords: [],
            // 2026-05-20 fix (task 40): include depth info so the
            // lifecycle-subscriber's universal depth-cap can refuse runaway
            // recursion. Without this, subscribers on lifecycle:task:completed
            // (validator-dispatch et al.) read parentDepth=undefined → cap
            // never fires → unbounded mutual recursion when seeding.
            parentDepth: compositionChain.length,
            compositionChain,
            tags: options.tags,
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
        inputShapes,
        outputImpulseIds: [...outputImpulseIds],
        tasks: taskRecords,
        costUsd: totalCostUsd > 0 ? totalCostUsd : undefined,
        tokensInput: totalTokensInput > 0 ? totalTokensInput : undefined,
        tokensOutput: totalTokensOutput > 0 ? totalTokensOutput : undefined,
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
          tags: options.tags,
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
      // Legibility: an execution that throws BETWEEN tasks (e.g. input-shape
      // binding rejects a terminal/sink shape) recorded no task and, on the
      // goal-host direct-write path, a null failure_mode — leaving the failure
      // invisible in both the trace and the journal. Always log it.
      console.error(`[engine] execution ${executionId} template ${template.id} failed after ${taskRecords.length} task(s): ${message}`);

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

      // M1 general close-on-failure: if a task was in-flight when the execution threw
      // and it is not already recorded (inline resolver-not-registered / resolver-throw
      // paths push their own), record it as a MEASURED failed task so the trace CLOSES
      // with its input contract + the error instead of tasks=null. Transformers now
      // COMPLETE (close) on every failure path, feeding the topology failure-edges
      // ("topology learns from BOTH successes and failures").
      if (inFlightTask && !taskRecords.some((r) => r.taskId === inFlightTask!.id)) {
        const declaredIn = (inFlightTask.inputShapes ?? []).map((entry) =>
          typeof entry === "string" ? entry : (entry as { shape: string }).shape);
        taskRecords.push({
          taskId: inFlightTask.id,
          description: inFlightTask.description,
          resolverId: inFlightTask.resolver,
          resolverTier: this.runtime.resolvers.get(inFlightTask.resolver)?.tier,
          resolvedConfig: redactResolvedConfig(inFlightTask.config),
          inputImpulseIds: inFlightInputs.map((imp) => imp.id),
          outputImpulseIds: [],
          inputShapes: [
            ...new Set([
              ...declaredIn,
              ...inFlightInputs.map((imp) => getImpulseShape(imp) || imp.pointer.type).filter(Boolean),
            ]),
          ],
          outputShapes: [],
          success: false,
          error: message,
        });
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
        inputShapes,
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
        // Evict everything EXCEPT this execution's outputs, which the caller
        // reads back AFTER execute() returns — the goal-host walk does exactly
        // that at goal-host-vessel/src/index.ts:9380 (`store.get(id)` →
        // addToPool). A walk step is top-level by this function's own test (no
        // parentExecutionId, empty compositionChain), so the previous
        // `store.impulses.clear()` made every one of those reads miss. The walk
        // fell through to its stub branch and pooled
        // `{producedBy, executionId}` in place of the produced data,
        // permanently — addToPool is first-write-wins with no upgrade path — so
        // step N+1 interpolated metadata where the data belonged and the reach
        // judge graded the stub as evidence, while the walk logged
        // `new_shapes=1` for a stub exactly as for real content.
        //
        // "The trace + impulse refs are durable via traceSink.record()" was
        // true and beside the point: the trace stores SHAPES, never bodies, so
        // durability there does not hand the caller back its content.
        //
        // The retained set is bounded to ONE execution's outputs and is reaped
        // at the next top-level entry (see execute()), so the store cannot grow
        // across runs — the leak this branch exists to prevent stays fixed.
        // See test/engine-output-readback.test.ts.
        const store = this.runtime.store as unknown as { impulses: Map<string, Impulse> };
        if (store.impulses && typeof store.impulses.delete === "function") {
          for (const id of [...store.impulses.keys()]) {
            if (opts.outputImpulseIds.has(id)) continue;
            store.impulses.delete(id);
          }
          // Record what we left behind so the next top-level entry can reap
          // exactly this set — and nothing a caller seeded itself.
          this.retainedOutputIds.clear();
          for (const id of opts.outputImpulseIds) {
            if (store.impulses.has(id)) this.retainedOutputIds.add(id);
          }
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
      compositionTemplateChain?: string[];
      variables: Record<string, unknown>;
      budget?: ExecutionBudget;
      maxCompositionDepth?: number;
      tags?: string[];
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

    // CYCLE DETECTION (activities-as-resolvers prerequisite): the chain tracks EXECUTION
    // ids, so a direct A->A recursion only trips the depth cap at 16. Track TEMPLATE ids
    // too and refuse to compose a sub-activity that is already an ANCESTOR (a real cycle).
    if (opts.compositionTemplateChain?.includes(task.subActivityId)) {
      throw new Error(
        `safety_breach: compose dispatch refused — cycle detected. Sub-activity ` +
        `'${task.subActivityId}' is already an ancestor in the composition template ` +
        `chain [${opts.compositionTemplateChain.join(" -> ")}].`,
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
      compositionTemplateChain: opts.compositionTemplateChain,
      maxCompositionDepth: opts.maxCompositionDepth,
      // Propagate parent's tags (including state_signature:<hash>) to nested
      // child traces. Without this, only top-level traces from goal-host's
      // runGoal carry state_signature tags — child compositions emit untagged
      // traces, starving per-(signature, goal_idx) Thompson cells to ~2
      // samples/hour and blocking MIN_CELL_SAMPLES=3 + SIG_CONTINUITY_MIN_SAMPLES=2
      // activation thresholds. Tag inheritance multiplies tag density by the
      // composition fan-out factor (~5-10x in practice).
      tags: opts.tags,
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
   * Horizontal composition (SUBSTRATE_AS_MDP §7) — the breadth-first dual of
   * `dispatchCompose`. Dispatches every id in `task.subActivityIds` concurrently
   * as a sibling trajectory under the SAME parent execution id and the SAME
   * composition chain, then joins their output impulse pools by shape-union.
   *
   * Tolerant join (§7 "k siblings fired, m succeeded"): a sibling that fails is
   * dropped from the union rather than failing the whole task; the task fails
   * only if EVERY sibling failed (zero useful outputs). This is what makes the
   * primitive useful for OR-edge discovery — run all candidate producers of a
   * shape in parallel, keep whatever resolved.
   *
   * Credit: siblings share `parent_execution_id`, so activity-api's
   * propagateCreditAlongChain groups them and averages (not sums) the deltas at
   * the shared ancestor — avoiding k-fold credit inflation.
   */
  private async dispatchComposeParallel(
    task: import("./ontology").ActivityTask,
    opts: {
      executionId: string;
      inputImpulses: Impulse[];
      compositionChain: string[];
      compositionTemplateChain?: string[];
      variables: Record<string, unknown>;
      budget?: ExecutionBudget;
      maxCompositionDepth?: number;
      tags?: string[];
    },
  ): Promise<{ outputs: Impulse[]; childTraces: ExecutionTrace[]; totalChildCostUsd: number }> {
    const ids = task.subActivityIds;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new Error(
        `Task '${task.id}' uses resolver "compose_parallel" but has no subActivityIds`,
      );
    }
    if (!this.runtime.templateProvider) {
      throw new Error(
        `Task '${task.id}' requires templateProvider to dispatch compose_parallel`,
      );
    }

    // Same forward-dispatch depth gate as `compose`: refuse BEFORE spawning any
    // sibling so the cap is observable as a safety_breach, not a cascade.
    const cap = opts.maxCompositionDepth ?? 16;
    if (opts.compositionChain.length >= cap) {
      throw new Error(
        `safety_breach: compose_parallel dispatch refused — composition chain depth ` +
        `(${opts.compositionChain.length}) has reached the cap (${cap}). ` +
        `Task '${task.id}' would target [${ids.join(", ")}].`,
      );
    }

    // All siblings share the parent's chain (sibling trajectories from one origin
    // state, §7) — NOT a deeper chain per sibling.
    const childChain = [...opts.compositionChain, opts.executionId];
    const provider = this.runtime.templateProvider;

    const settled = await Promise.allSettled(
      ids.map(async (subId) => {
        const subTemplate = await provider.getTemplate(subId);
        if (!subTemplate) {
          throw new Error(`Sub-activity template '${subId}' not found`);
        }
        const childExecutor = new ActivityExecutor(this.runtime);
        return childExecutor.execute(subTemplate, {
          impulses: opts.inputImpulses,
          variables: opts.variables,
          budget: opts.budget,
          parentExecutionId: opts.executionId,
          compositionChain: childChain,
          compositionTemplateChain: opts.compositionTemplateChain,
          maxCompositionDepth: opts.maxCompositionDepth,
          tags: opts.tags,
        });
      }),
    );

    const childTraces: ExecutionTrace[] = [];
    const succeeded: ExecutionTrace[] = [];
    const k = ids.length; // sibling-group width = fan-out factor (§7 averaging divisor)
    for (const s of settled) {
      if (s.status === "fulfilled") {
        // Mark the fan-out width so activity-api's propagateCreditAlongChain
        // averages (÷k) instead of summing each sibling's full credit at the
        // shared ancestor — the §7 k-fold-inflation guard. Flows verbatim into
        // the persisted trace's body.metadata; absent ⇒ divisor defaults to 1.
        s.value.metadata = { ...(s.value.metadata ?? {}), siblingGroupSize: k };
        childTraces.push(s.value);
        if (s.value.status !== "failed") succeeded.push(s.value);
      }
    }

    if (succeeded.length === 0) {
      throw new Error(
        `compose_parallel '${task.id}' — all ${ids.length} sibling dispatch(es) failed; ` +
        `no output pool to join.`,
      );
    }

    // Shape-union join: every successful sibling's output impulses, deduped by id.
    const outputs: Impulse[] = [];
    const seen = new Set<string>();
    let totalChildCostUsd = 0;
    for (const trace of succeeded) {
      if (trace.costUsd !== undefined) totalChildCostUsd += trace.costUsd;
      for (const id of trace.outputImpulseIds) {
        if (seen.has(id)) continue;
        const impulse = this.runtime.store.get(id);
        if (impulse !== undefined) {
          seen.add(id);
          outputs.push(impulse);
        }
      }
    }

    return { outputs, childTraces, totalChildCostUsd };
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
        // Terminal/sink shapes (reports, audits, findings, gaps, …) are
        // consumed by observation and are never produced FOR binding, so a
        // required-input wiring on one can never be satisfied — no amount of
        // producer dispatch will help. Surface that as a template-authoring
        // bug with a specific message (does NOT change WHICH cases throw —
        // a missing required input already throws here).
        if (classifyShape(ref.shape) === "terminal") {
          throw new Error(
            `Task '${taskId}' requires shape '${ref.shape}', but terminal/sink shapes are never produced for binding (template-authoring bug)`,
          );
        }
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

// --- parity-gated seam extraction: moved decls now live in ./engine.interpolation ---
import { capForAccumulator, evaluateConditionalGate, isParseableJsonArtifact, resolveLifecyclePlaceholders, structuredError } from "./engine.interpolation";
export { evaluateConditionalGate, isParseableJsonArtifact, resolveLifecyclePlaceholders } from "./engine.interpolation";
export type { GateEvaluationContext } from "./engine.interpolation";
