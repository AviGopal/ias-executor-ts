import type { ActivityTask, ActivityTemplate, ExecutionTaskRecord, ExecutionTrace, FailureMode, Impulse, InputShapeRef, LifecycleEvent } from "./ontology";
import { getImpulseShape } from "./ontology";
import type { CreateImpulseInput } from "./impulses";
import type { ResolverContext } from "./resolvers";
import { ExecutionRuntime } from "./runtime";
import { classifyShape } from "./shape-lifecycle";

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

/**
 * Fence-tolerant JSON validity test for the `.json` artifact convergent-validity
 * check (Check 2b). Returns true iff `raw` parses as JSON either directly or
 * after stripping a leading ```json fence + trailing ``` and slicing the first
 * balanced top-level object/array. Mirrors the tolerance of the downstream
 * consumers (apply-proposal-as-patch's parseFirstJsonObject) so the intentionally
 * fenced `-report.json` writes the pipeline already accepts do not regress, while
 * structurally-broken content (raw text injected into a JSON string slot) is
 * rejected. Empty/whitespace-only content is not a valid JSON artifact.
 */
export function isParseableJsonArtifact(raw: string): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  try { JSON.parse(raw); return true; } catch { /* fall through to fence-tolerant path */ }
  const s = raw.replace(/^\s*```(?:json)?\n?/i, "").trimStart();
  const startObj = s.indexOf("{");
  const startArr = s.indexOf("[");
  const candidates: Array<[number, string, string]> = [];
  if (startObj >= 0) candidates.push([startObj, "{", "}"]);
  if (startArr >= 0) candidates.push([startArr, "[", "]"]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [start, open, close] of candidates) {
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i]!;
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { JSON.parse(s.slice(start, i + 1)); return true; } catch { break; }
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lifecycle-subscriber template contract (gap ias-executor-template-contract-mismatch):
// {{lifecycle.*}} config interpolation + conditional / skipIfFalse task gates.
//
// The embedded meta-templates (slot-binding on lifecycle:task:preBinding,
// validator-dispatch on lifecycle:task:completed, and the
// create-shape-provider-goal escalation) were authored for minibob's executor,
// which resolved {{lifecycle.<dotted.path>}} placeholders in task config from
// the triggering lifecycle impulse's data payload and honored per-task
// conditional gates. This engine passed task.config verbatim to resolvers —
// resolvers received the literal placeholder strings (HTTP 400 storms from
// validator-dispatch, hollow gap-cache queries from slot-binding) and gated
// tasks (escalate_unbindable) fired unconditionally. These helpers implement
// the contract; ActivityExecutor.execute wires them into the dispatch loop.
// ---------------------------------------------------------------------------

function structuredError(code: string, message: string, context: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...context });
}

/**
 * Resolve a dotted path against a payload object. Each segment tries the
 * literal key first, then a snake_case → camelCase fallback (template authors
 * write `{{lifecycle.skip_validation}}` / `{{lifecycle.composition_chain}}`;
 * emit payloads use camelCase — same tolerance as `resolvePayloadField` in
 * lifecycle-subscriber.ts). A missing segment or a terminal `undefined` is
 * "not found" — callers fail loudly rather than passing a literal through.
 */
function resolveDottedPath(
  data: Record<string, unknown>,
  dottedPath: string,
): { found: boolean; value?: unknown } {
  let cur: unknown = data;
  for (const seg of dottedPath.split(".")) {
    if (cur === null || typeof cur !== "object") return { found: false };
    const obj = cur as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, seg)) {
      cur = obj[seg];
      continue;
    }
    const camel = seg.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (camel !== seg && Object.prototype.hasOwnProperty.call(obj, camel)) {
      cur = obj[camel];
      continue;
    }
    return { found: false };
  }
  return cur === undefined ? { found: false } : { found: true, value: cur };
}

/** Inline (partial-string) substitution form: strings verbatim, scalars via
 *  String(), arrays/objects JSON-stringified — the documented minibob
 *  dotted-path interpolator semantics the meta-templates were written against. */
function stringifyForInline(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const WHOLE_LIFECYCLE_RE = /^\{\{\s*lifecycle\.([^{}\s]+)\s*\}\}$/;
const INLINE_LIFECYCLE_RE = /\{\{\s*lifecycle\.([^{}\s]+)\s*\}\}/g;

/**
 * Resolve every {{lifecycle.<dotted.path>}} placeholder in a task config
 * against the triggering lifecycle impulse's data payload.
 *
 * - A string that IS exactly one placeholder substitutes the resolved value
 *   with its type preserved (arrays stay arrays, booleans stay booleans).
 * - Inline occurrences inside a larger string substitute the stringified form.
 * - An unresolvable placeholder throws a structured UNRESOLVABLE_PLACEHOLDER
 *   error naming the task and placeholder — the literal is NEVER passed
 *   through to a resolver (that literal-passthrough was the 400-storm bug).
 * - Underscore-prefixed keys (_variables_note, _lifecycle_note, ...) are
 *   template-author documentation that mentions placeholders in prose; they
 *   are copied verbatim, not interpolated.
 *
 * Non-lifecycle placeholder families ({{<taskId>_text}}, {{shape}},
 * {{impulse:<slot>}}, ...) are left untouched — those are resolved downstream
 * by the individual resolvers, as before.
 */
export function resolveLifecyclePlaceholders(
  config: Record<string, unknown>,
  lifecycleData: Record<string, unknown>,
  taskId: string,
): Record<string, unknown> {
  const resolveOrThrow = (path: string): unknown => {
    const res = resolveDottedPath(lifecycleData, path);
    if (!res.found) {
      throw structuredError(
        "UNRESOLVABLE_PLACEHOLDER",
        `UNRESOLVABLE_PLACEHOLDER: task '${taskId}': unresolvable placeholder {{lifecycle.${path}}} — ` +
          `path not present in the triggering lifecycle impulse data`,
        { code: "UNRESOLVABLE_PLACEHOLDER", taskId, placeholder: `{{lifecycle.${path}}}` },
      );
    }
    return res.value;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = WHOLE_LIFECYCLE_RE.exec(value);
      if (whole) return resolveOrThrow(whole[1]!);
      return value.replace(INLINE_LIFECYCLE_RE, (_m, path: string) =>
        stringifyForInline(resolveOrThrow(path)),
      );
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = k.startsWith("_") ? v : walk(v);
      }
      return out;
    }
    return value;
  };
  return walk(config) as Record<string, unknown>;
}

export interface GateEvaluationContext {
  taskId: string;
  /** Triggering lifecycle impulse data ({} when the execution has none). */
  lifecycleData: Record<string, unknown>;
  /** Accumulated variables (request-level + prior-task projections). */
  variables: Record<string, unknown>;
  /** Resolve an {{impulse:<slot>}} reference to the impulse's content string. */
  resolveImpulseSlot: (slot: string) => string | undefined;
}

/**
 * Evaluate a task's `conditional` gate BEFORE dispatch. Returns true when the
 * task should run, false when it should be skipped.
 *
 * Accepted forms (matching the embedded meta-templates):
 *   - boolean, or { expression: boolean }
 *   - { expression: "<clauses>" [, skipIfFalse: true] } or a bare string
 *
 * Expression mini-language (validator-dispatch / slot-binding / ribosome
 * gates): clauses joined by ` AND ` (no OR in the catalogue); each clause is
 * `<operand> <op> <operand>` with op ∈ { ===, !==, ==, !=, contains,
 * not-contains }, or a bare operand tested for truthiness. Operands are
 * quoted literals or {{lifecycle.*}} / {{impulse:<slot>}} / {{variables.*}}
 * references; comparison is on the stringified forms.
 *
 * A false expression skips the task whether or not `skipIfFalse` is set —
 * running a task whose declared gate is false would reintroduce the
 * unconditional-fire bug (60 bogus escalations/hr) this exists to close.
 * An unresolvable gate throws a structured UNRESOLVABLE_GATE error, never
 * silently runs the task.
 */
export function evaluateConditionalGate(
  conditional: unknown,
  ctx: GateEvaluationContext,
): boolean {
  if (typeof conditional === "boolean") return conditional;
  let expression: string;
  if (typeof conditional === "string") {
    expression = conditional;
  } else if (conditional !== null && typeof conditional === "object") {
    const expr = (conditional as { expression?: unknown }).expression;
    if (typeof expr === "boolean") return expr;
    if (typeof expr !== "string") {
      throw structuredError(
        "UNRESOLVABLE_GATE",
        `UNRESOLVABLE_GATE: task '${ctx.taskId}': conditional gate has no boolean/string expression ` +
          `(got ${JSON.stringify(conditional)})`,
        { code: "UNRESOLVABLE_GATE", taskId: ctx.taskId },
      );
    }
    expression = expr;
  } else {
    throw structuredError(
      "UNRESOLVABLE_GATE",
      `UNRESOLVABLE_GATE: task '${ctx.taskId}': conditional gate must be a boolean, string expression, ` +
        `or { expression } object (got ${JSON.stringify(conditional)})`,
      { code: "UNRESOLVABLE_GATE", taskId: ctx.taskId },
    );
  }

  const unresolvable = (ref: string): Error =>
    structuredError(
      "UNRESOLVABLE_GATE",
      `UNRESOLVABLE_GATE: task '${ctx.taskId}': conditional gate references ${ref} which cannot be resolved`,
      { code: "UNRESOLVABLE_GATE", taskId: ctx.taskId, placeholder: ref },
    );

  const resolveOperand = (raw: string): string => {
    let s = raw.trim();
    // Strip one layer of matching quotes (template gates quote literals AND
    // sometimes quote placeholders: '{{lifecycle.outputShapes}}').
    if (
      s.length >= 2 &&
      ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
    ) {
      s = s.slice(1, -1);
    }
    return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, token: string) => {
      if (token.startsWith("lifecycle.")) {
        const res = resolveDottedPath(ctx.lifecycleData, token.slice("lifecycle.".length));
        if (!res.found) throw unresolvable(`{{${token}}}`);
        return stringifyForInline(res.value);
      }
      if (token.startsWith("impulse:")) {
        const v = ctx.resolveImpulseSlot(token.slice("impulse:".length));
        if (v === undefined) throw unresolvable(`{{${token}}}`);
        return v;
      }
      const path = token.startsWith("variables.") ? token.slice("variables.".length) : token;
      const res = resolveDottedPath(ctx.variables, path);
      if (!res.found) throw unresolvable(`{{${token}}}`);
      return stringifyForInline(res.value);
    });
  };

  const truthy = (v: string): boolean => {
    const t = v.trim();
    return t !== "" && t !== "false" && t !== "0" && t !== "null" && t !== "undefined" && t !== "[]";
  };

  const CLAUSE_RE = /^(.+?)\s+(===|!==|==|!=|not-contains|contains)\s+(.+)$/;
  for (const clause of expression.split(/\s+AND\s+/)) {
    const m = CLAUSE_RE.exec(clause.trim());
    let clauseResult: boolean;
    if (!m) {
      clauseResult = truthy(resolveOperand(clause));
    } else {
      const lhs = resolveOperand(m[1]!);
      const rhs = resolveOperand(m[3]!);
      switch (m[2]) {
        case "===":
        case "==":
          clauseResult = lhs === rhs;
          break;
        case "!==":
        case "!=":
          clauseResult = lhs !== rhs;
          break;
        case "contains":
          clauseResult = lhs.includes(rhs);
          break;
        case "not-contains":
          clauseResult = !lhs.includes(rhs);
          break;
        default:
          clauseResult = false;
      }
    }
    if (!clauseResult) return false; // AND semantics — first false short-circuits
  }
  return true;
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
    const compositionTemplateChain = options.compositionTemplateChain ?? [];

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
    // Tasks skipped by a false conditional gate (or by depending on one).
    const skippedTaskIds = new Set<string>();
    // {{impulse:<slot>}} gate operands: prefer impulses stamped with
    // metadata.outputImpulseKey === slot (named-output slots, stamped in the
    // loop below), then metadata.shape === slot; last match wins (latest
    // output). Falls back to an accumulated variable of the same name.
    const resolveImpulseSlot = (slot: string): string | undefined => {
      let found: Impulse | undefined;
      for (const imp of this.runtime.store.all()) {
        const meta = imp.metadata as Record<string, unknown> | undefined;
        if (meta?.["outputImpulseKey"] === slot) found = imp;
      }
      if (!found) {
        for (const imp of this.runtime.store.all()) {
          const meta = imp.metadata as Record<string, unknown> | undefined;
          if (meta?.["shape"] === slot) found = imp;
        }
      }
      if (found) {
        return typeof found.content === "string" ? found.content : JSON.stringify(found.content ?? "");
      }
      const v = accumulatedVariables[slot];
      if (v === undefined) return undefined;
      return typeof v === "string" ? v : JSON.stringify(v);
    };

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
              lifecycleData: lifecycleTriggerData ?? {},
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
            task = {
              ...rawTask,
              config: resolveLifecyclePlaceholders(rawTask.config, lifecycleTriggerData ?? {}, rawTask.id),
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
              for (const imp of aOut) outputImpulseIds.add(imp.id);
              if (cr.childTrace.costUsd !== undefined) totalCostUsd += cr.childTrace.costUsd;
              taskRecords.push({
                taskId: task.id,
                description: task.description,
                resolverId: task.resolver,
                resolverTier: "deterministic",
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
          accumulatedVariables[task.id] = cappedFirstText;
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
        if (llmUsage) { totalTokensInput += llmUsage.input_tokens ?? 0; totalTokensOutput += llmUsage.output_tokens ?? 0; }

        taskRecords.push({
          taskId: task.id,
          description: task.description,
          resolverId: task.resolver,
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
