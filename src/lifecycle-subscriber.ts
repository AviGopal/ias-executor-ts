/**
 * Lifecycle Subscriber — port of minibob's `lifecycle-subscriptions.ts`
 * into ias-executor-ts as an attached `lifecycle-subscriber` vessel.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host
 *   §E.1 Option E.2 — attach as a vessel kind, not inline in ExecutionRuntime.
 *   §E.2 — carry-over semantics (filter suffix predicates, snake→camel fallback,
 *          self-subscription guard, top-K defaults, must_fire segregation,
 *          dedupe window, audit-tag depth-cap, failure isolation).
 *
 * Source of truth being ported: repos/minibob/src/lifecycle-subscriptions.ts.
 *
 * What is preserved verbatim from minibob:
 *   - `matchesFilter` suffix predicates `_contains` / `_equals`
 *   - `resolvePayloadField` snake_case → camelCase fallback
 *   - `deepEquals` structural equality
 *   - `resolveDedupeKey` template-string `{field}` and `{nested.field}` syntax
 *   - 5-minute per-process dedupe window with opportunistic GC at 1024 entries
 *   - `refuseForDepthCap` default 2, max 4, gated on `tags ∋ "audit"`
 *   - Self-subscription guard via `emittingTemplateId`
 *   - Subscriber failure isolation (log + swallow)
 *
 * Porting gaps / intentional differences from minibob:
 *   1. `findSubscribers`/`rankSubscribers`/`fireSubscribers` global functions
 *      and the singleton `setTemplateProvider` / `setRelevanceProvider` /
 *      `setSubscriberDispatcher` overrides are NOT ported. Their state was
 *      process-global in minibob, which made testing painful and prevented
 *      multiple runtimes from coexisting. The replacement is the
 *      `LifecycleSubscriberVessel` class which owns its own registry,
 *      dispatcher, and (optional) downstream sink. Hosts that want global
 *      behaviour install a single vessel instance into the runtime.
 *   2. Thompson / EMA relevance ranking is NOT ported in Phase 1. The current
 *      vessel dispatches every matching subscriber (after dedupe + depth-cap).
 *      Top-K + must_fire segregation will land when activity-api ships the
 *      lifecycle-subscribers ranker (deferred per design §E.2). The constants
 *      `HIGH_FREQUENCY_SHAPES` / `HIGH_FREQUENCY_TOP_K` / `ONE_SHOT_TOP_K` are
 *      exported here for parity but unused by the vessel itself; see §3 of
 *      tasks.md for the follow-up that wires Thompson ranking.
 *   3. LifecycleEvent payloads in ias-executor-ts are flat `{ type, timestamp,
 *      data }` objects (see ontology.ts). Minibob fires "lifecycle impulses"
 *      with `pointer.content` carrying the payload. The vessel reads
 *      `event.data` as the structural payload, matching the executor's
 *      ontology. When future work introduces lifecycle-impulse emission inside
 *      the engine, the vessel's `emit` body will need a corresponding adapter.
 */

import type { ActivityTemplate, LifecycleEvent } from "./ontology";
import type { EventSink } from "./ports";

// =============================================================================
// FILTER MATCHING (ported from lifecycle-subscriptions.ts:203-283)
// =============================================================================

/**
 * Returns true iff every (key, value) in `filter` matches the same key/value
 * in `payload`. Strict equality for primitives; deep equality (JSON) for
 * nested values. Missing keys in payload always fail the match.
 *
 * Filter-key suffix conventions (test-audit-loop spec §G):
 *   - `<field>_contains`: actual at `<field>` must be an array whose elements
 *     deep-equal the expected value.
 *   - `<field>_equals`: actual at `<field>` must deep-equal the expected
 *     value. Functionally identical to plain deep-equality but explicit.
 *
 * Unknown suffixes fall through to plain deep-equality on the literal key
 * name so we don't silently drop a filter the author intended as a key.
 */
export function matchesFilter(
  filter: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (key.endsWith("_contains")) {
      const field = key.slice(0, -"_contains".length);
      const arr = resolvePayloadField(payload, field);
      if (!Array.isArray(arr)) return false;
      if (!arr.some((item) => deepEquals(item, expected))) return false;
      continue;
    }
    if (key.endsWith("_equals")) {
      const field = key.slice(0, -"_equals".length);
      if (!deepEquals(resolvePayloadField(payload, field), expected)) return false;
      continue;
    }
    const actual = resolvePayloadField(payload, key);
    if (!deepEquals(expected, actual)) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve a payload field tolerating snake_case → camelCase mismatches.
 * Spec authors write `output_shapes_contains` (matching the SQL/JSON contract
 * shape names), but emit payloads use the existing camelCase JavaScript
 * conventions (`outputShapes`, `executionId`, `parentDepth`). Tries the
 * literal key first, then a snake_case → camelCase fallback.
 */
export function resolvePayloadField(
  payload: Record<string, unknown>,
  field: string,
): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, field)) {
    return payload[field];
  }
  const camel = field.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  if (camel !== field && Object.prototype.hasOwnProperty.call(payload, camel)) {
    return payload[camel];
  }
  return undefined;
}

export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (
      !deepEquals(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      )
    ) {
      return false;
    }
  }
  return true;
}

// =============================================================================
// TOP-K DEFAULTS (parity export; not consumed by the vessel — see header note 2)
// =============================================================================

export const HIGH_FREQUENCY_SHAPES = new Set<string>([
  "lifecycle:task:completed",
  "lifecycle:task:started",
  "lifecycle:execution:tick",
  "task.completed",
  "task.started",
]);
export const HIGH_FREQUENCY_TOP_K = 1;
export const ONE_SHOT_TOP_K = 3;

export function defaultTopKForShape(shape: string): number {
  return HIGH_FREQUENCY_SHAPES.has(shape)
    ? HIGH_FREQUENCY_TOP_K
    : ONE_SHOT_TOP_K;
}

// =============================================================================
// DEDUPE (ported from lifecycle-subscriptions.ts:381-485)
// =============================================================================

const DEDUPE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Resolve a dedupe-key template against a payload. Templates use `{field}`
 * or `{nested.field}` placeholders; missing fields collapse to the literal
 * placeholder so we don't accidentally merge two unrelated events to the
 * empty key.
 */
export function resolveDedupeKey(
  template: ActivityTemplate,
  payload: Record<string, unknown>,
): string | null {
  const tmpl = template.dedupe_key ?? template.subscription?.dedupe_key;
  if (!tmpl) return null;
  return tmpl.replace(/\{([^}]+)\}/g, (match, path: string) => {
    const segs = path.split(".");
    let cur: unknown = payload;
    for (const seg of segs) {
      if (
        cur &&
        typeof cur === "object" &&
        seg in (cur as Record<string, unknown>)
      ) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        if (segs.length === 1 && cur && typeof cur === "object") {
          const camel = seg.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
          if (camel in (cur as Record<string, unknown>)) {
            cur = (cur as Record<string, unknown>)[camel];
            continue;
          }
        }
        return match;
      }
    }
    if (cur === undefined || cur === null) return match;
    return String(cur);
  });
}

// =============================================================================
// DEPTH-CAP (ported from lifecycle-subscriptions.ts:424-457)
// =============================================================================

const AUDIT_DEFAULT_DEPTH_CAP = 2;
const AUDIT_MAX_DEPTH_CAP = 4;

/**
 * Spec R5 (test-audit-loop): activities tagged "audit" enforce a
 * composition_chain depth cap. Default 2; the SCHEMAFULL `audit_depth_cap`
 * ASSERT in migration 131 caps the declared override at ≤ 4.
 *
 * Returns true when the dispatch must be refused.
 */
export function refuseForDepthCap(
  template: ActivityTemplate,
  payload: Record<string, unknown>,
): boolean {
  // 2026-05-20: depth-cap now applies to ALL subscriber templates, not just
  // those tagged "audit". Reason: cross-template mutual recursion
  // (slot-binding subscribes to preBinding; firing slot-binding emits more
  // preBindings; validator-dispatch subscribes to completed, firing it
  // emits more completed events). Self-subscription guard only catches
  // SAME-template-id recursion, not cycles across subscriber pairs. A
  // universal depth cap is the simplest correct guard.
  // - Default cap: 2 (matches the prior audit-tag default). Composition
  //   chains deeper than 2 nested subscriber dispatches refused.
  // - Audit-tagged templates can override via metadata.auditDepthCap (≤4).
  const tags = template.tags ?? [];
  const meta = (template.metadata ?? {}) as Record<string, unknown>;
  const declared =
    typeof meta.auditDepthCap === "number" ? meta.auditDepthCap : undefined;
  const cap = Math.min(declared ?? AUDIT_DEFAULT_DEPTH_CAP, AUDIT_MAX_DEPTH_CAP);
  const parentDepth =
    typeof payload.parentDepth === "number"
      ? payload.parentDepth
      : Array.isArray(payload.compositionChain)
        ? payload.compositionChain.length
        : Array.isArray((payload as Record<string, unknown>).composition_chain)
          ? (payload.composition_chain as unknown[]).length
          : 0;
  return parentDepth >= cap;
}

// =============================================================================
// VESSEL
// =============================================================================

/**
 * Dispatcher invoked when a subscriber template matches an event. The
 * vessel does not directly run an ActivityExecutor — it delegates so the
 * host can wire whatever execution strategy it prefers (in-process, queued,
 * remote). Failures inside the dispatcher are logged and swallowed by the
 * vessel; they MUST NOT cascade to the emitting execution (spec §E.2).
 */
export type SubscriberDispatcher = (
  template: ActivityTemplate,
  event: LifecycleEvent,
  context: { lifecycleShape: string; payload: Record<string, unknown> },
) => Promise<void> | void;

export interface LifecycleSubscriberVesselOptions {
  /** Required — invoked once per matched, non-deduped, non-depth-capped subscriber. */
  dispatcher: SubscriberDispatcher;
  /**
   * Optional downstream sink. Every event the vessel receives is forwarded
   * here AFTER subscriber dispatch, so a host can compose this vessel with
   * a `ConsoleEventSink` or HTTP forwarder without losing observability.
   */
  downstreamSink?: EventSink;
  /**
   * Override the dedupe window. Default 5 minutes (matches minibob).
   * Exposed for tests that need to fast-forward the cache.
   */
  dedupeWindowMs?: number;
  /**
   * Optional logger for warn/debug messages. Defaults to no-op so tests
   * stay quiet; hosts can inject console or a structured logger.
   */
  logger?: { warn: (msg: string) => void; debug: (msg: string) => void };
}

/**
 * Attached vessel that subscribes to lifecycle events emitted by
 * `ExecutionRuntime` and dispatches matching subscriber templates.
 *
 * Usage:
 *
 *   const subscriber = new LifecycleSubscriberVessel({
 *     dispatcher: async (template, event) => {
 *       await executor.execute(template, { variables: { event } });
 *     },
 *   });
 *   subscriber.register(slotBindingTemplate);
 *
 *   const runtime = new ExecutionRuntime({
 *     eventSink: subscriber,
 *     attachedVessels: [{
 *       id: "lifecycle-subscriber",
 *       kind: "lifecycle-subscriber",
 *       resolverIds: [],
 *     }],
 *   });
 *
 * Spec §E.2: every matched subscriber MUST eventually be dispatched OR
 * suppressed via dedupe / depth-cap; dispatcher errors are isolated.
 */
export class LifecycleSubscriberVessel implements EventSink {
  /** Subscribers indexed by `subscription.shape` for O(1) lookup. */
  private readonly registry: Map<string, ActivityTemplate[]> = new Map();
  /** Per-process dedupe cache keyed by `${templateId}::${resolvedKey}`. */
  private readonly dedupeCache: Map<string, number> = new Map();
  private readonly dispatcher: SubscriberDispatcher;
  private readonly downstreamSink?: EventSink;
  private readonly dedupeWindowMs: number;
  private readonly logger: {
    warn: (msg: string) => void;
    debug: (msg: string) => void;
  };

  constructor(options: LifecycleSubscriberVesselOptions) {
    this.dispatcher = options.dispatcher;
    this.downstreamSink = options.downstreamSink;
    this.dedupeWindowMs = options.dedupeWindowMs ?? DEDUPE_WINDOW_MS;
    this.logger = options.logger ?? {
      warn: () => {},
      debug: () => {},
    };
  }

  /**
   * Register a subscriber template. The template must declare
   * `subscription.shape`; otherwise an error is thrown — a silent no-op
   * here would hide template-authoring bugs.
   */
  register(template: ActivityTemplate): void {
    const shape = template.subscription?.shape;
    if (!shape) {
      throw new Error(
        `LifecycleSubscriberVessel.register: template '${template.id}' has no subscription.shape`,
      );
    }
    const existing = this.registry.get(shape) ?? [];
    // Replace if already registered to keep the registry idempotent.
    const filtered = existing.filter((t) => t.id !== template.id);
    filtered.push(template);
    this.registry.set(shape, filtered);
  }

  /** Remove a subscriber by template id. */
  unregister(templateId: string): void {
    for (const [shape, templates] of this.registry.entries()) {
      const next = templates.filter((t) => t.id !== templateId);
      if (next.length === 0) {
        this.registry.delete(shape);
      } else {
        this.registry.set(shape, next);
      }
    }
  }

  /**
   * Inspect the registered subscribers for a given event type. Visible for
   * tests; not part of the EventSink contract.
   */
  listSubscribers(shape: string): ActivityTemplate[] {
    return [...(this.registry.get(shape) ?? [])];
  }

  /** Visible for tests — clears the dedupe cache. */
  _resetDedupeCache(): void {
    this.dedupeCache.clear();
  }

  /**
   * EventSink entry point. Called by `ExecutionRuntime` for every emitted
   * lifecycle event. Subscriber failures are isolated; the downstream sink
   * is always invoked regardless of subscriber outcomes.
   */
  async emit(event: LifecycleEvent): Promise<void> {
    try {
      await this.dispatchSubscribers(event);
    } catch (err) {
      // Belt-and-braces: dispatchSubscribers already isolates individual
      // dispatcher errors. This catch covers anything unexpected in the
      // matching pipeline itself.
      this.logger.warn(
        `[LifecycleSubscriberVessel] unexpected dispatch error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (this.downstreamSink) {
      await this.downstreamSink.emit(event);
    }
  }

  private async dispatchSubscribers(event: LifecycleEvent): Promise<void> {
    const templates = this.registry.get(event.type);
    if (!templates || templates.length === 0) return;

    const payload = (event.data ?? {}) as Record<string, unknown>;
    // Self-subscription guard (spec §E.2; lifecycle-subscriptions.ts:312-315):
    // when the event payload identifies the emitting template, skip it.
    const emittingTemplateId =
      typeof payload.templateId === "string" ? payload.templateId : undefined;

    for (const template of templates) {
      if (!matchesFilter(template.subscription?.filter, payload)) continue;
      if (emittingTemplateId && template.id === emittingTemplateId) continue;

      if (refuseForDepthCap(template, payload)) {
        this.logger.warn(
          `[LifecycleSubscriberVessel] depth-cap refusal — ${template.id} ` +
            `(spec R5 safety_breach)`,
        );
        continue;
      }
      if (!this.shouldDispatchAfterDedupe(template, payload)) continue;

      // Spec §E.2: subscriber dispatch MUST NOT block the parent execution.
      // Previously this awaited the dispatcher — meaning a multi-task
      // subscriber (e.g. validator-dispatch, which fires LLM calls and
      // dispatches nested validator activities) blocked the engine's task
      // loop. For a 5-task parent template that fires
      // `lifecycle:task:completed` once per task, this multiplied parent
      // duration by the cumulative subscriber-dispatch time and could
      // breach upstream HTTP timeouts (Bun's 300s, MCP's ~290s) before the
      // parent reached its later tasks. Concretely: ingest-doc-as-concepts
      // (5 tasks; task 2 = llm_completion_dispatch) consistently aborted
      // after task 2 because validator-dispatch fired LLM tasks of its own
      // and the parent engine never reached task 3.
      //
      // Fire-and-forget restores the spec-stated isolation: subscriber
      // failures and slowness are quarantined to the subscriber's own
      // execution. The engine returns from emit() as soon as the subscriber
      // is queued. The captured `template` binding is shadowed in the IIFE
      // so we report the right template id even if subsequent loop
      // iterations reassign it.
      const dispatchTemplate = template;
      const dispatchEvent = event;
      void (async () => {
        try {
          await this.dispatcher(dispatchTemplate, dispatchEvent, {
            lifecycleShape: dispatchEvent.type,
            payload,
          });
        } catch (err) {
          this.logger.warn(
            `[LifecycleSubscriberVessel] subscriber ${dispatchTemplate.id} dispatch ` +
              `failed (non-fatal): ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      })();
    }
  }

  private shouldDispatchAfterDedupe(
    template: ActivityTemplate,
    payload: Record<string, unknown>,
  ): boolean {
    const key = resolveDedupeKey(template, payload);
    if (!key) return true;
    const fullKey = `${template.id}::${key}`;
    const now = Date.now();
    const last = this.dedupeCache.get(fullKey);
    if (last !== undefined && now - last < this.dedupeWindowMs) {
      this.logger.debug(
        `[LifecycleSubscriberVessel] dedupe collapse — ${template.id} ` +
          `key=${key} suppressed (last fired ${now - last}ms ago)`,
      );
      return false;
    }
    this.dedupeCache.set(fullKey, now);
    // Opportunistic GC: keep the cache bounded. Same heuristic as minibob
    // (lifecycle-subscriptions.ts:479-483).
    if (this.dedupeCache.size > 1024) {
      const entries = Array.from(this.dedupeCache.entries()).sort(
        (a, b) => a[1] - b[1],
      );
      const drop = Math.floor(entries.length / 4);
      for (let i = 0; i < drop; i++) {
        const entry = entries[i];
        if (entry) this.dedupeCache.delete(entry[0]);
      }
    }
    return true;
  }
}
