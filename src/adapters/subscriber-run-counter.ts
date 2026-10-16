/**
 * COUNT NORMAL LIFECYCLE-SUBSCRIBER RUNS INSTEAD OF TRACING EACH ONE (CHANGE DB1).
 *
 * Every lifecycle-subscriber run (dispatched by goal-host's SubscriberDispatcher) was recorded as a full execution
 * trace. Measured on node1 (2 h to 2026-10-16T07:54Z): 32.1 lifecycle trace writes per run-goal start, ~93% of them
 * validator-dispatch and slot-binding (journal mentions over 1 h: 7,719 and 2,093, vs ribosome-extract 760, the two
 * audit subscribers 0). This wrapper sits around goal-host's trace sink:
 *   - a trace of a COUNTED subscriber template that is NORMAL is folded into a per-template count (runs / ok / fail,
 *     duration and cost sums, per parent execution) and flushed about once a minute to activity-api's
 *     POST /v2/activities/execution-traces/subscriber-counts, which feeds the readers a normal trace fed;
 *   - an ANOMALOUS run (status "failed", or any task with success:false) is traced in full, as before, so a failure
 *     the learner needs is never hidden. (The impulse-level `degraded` flag is NOT the test: impulse-pool-selection
 *     marks every output degraded.)
 *   - everything else passes straight through.
 * The switch is the shaped tuning row lifecycle.subscriber_trace_mode (1 = count, anything else = full traces),
 * read at use time with a 30 s cache and failing open to full traces. Seeded 0 by activity-api migration 223.
 *
 * COUNTED SET = the subscribers that are META by development-vessel's shared definition (src/lib/meta-templates.ts
 * META_TEMPLATE_IDS: routing activities that legitimately run no task of their own); a dv test asserts the two lists
 * agree. A membership list that decides behaviour is better as a shaped read (law 1): when the trace-mode row's channel
 * can carry the set, that is the follow-up.
 *
 * A LEARNING EDGE IS NEVER FIRE-AND-FORGET: a failed flush is logged and counted, and the SAME batch (same id) is resent
 * first on the next flush, so activity-api's batch dedupe makes a lost answer harmless (never dropped, never doubled); flush() can be awaited on shutdown; stats() exposes pending and failed counts.
 * A counts entry keeps at most MAX_PARENTS parent executions; runs beyond that are still counted for the posterior and
 * reported as `parents_overflow` (they lose only their hub-edge attribution).
 */
import type { ExecutionTrace } from "../ontology";
import type { TraceSink } from "../ports";

export const COUNTED_SUBSCRIBER_TEMPLATES: ReadonlySet<string> = new Set(["validator-dispatch", "slot-binding"]);
export const SUBSCRIBER_TRACE_MODE_ROW = "lifecycle.subscriber_trace_mode";
export const MODE_TTL_MS = 30_000;
export const FLUSH_MS = 60_000;
export const MAX_PARENTS = 500;

/** A run the learner must see in full: it failed, or one of its tasks did not succeed. */
export function isAnomalousTrace(t: ExecutionTrace): boolean {
  return t.status !== "completed" || (t.tasks ?? []).some((task) => task.success === false);
}
const bareTemplateId = (id: string | undefined): string => String(id ?? "").replace(/^activity:⟨(.+)⟩$/, "$1").replace(/^activity:/, "");

export interface SubscriberCountsBatch {
  batch_id: string;
  window_start: string;
  window_end: string;
  entries: Array<{ template_id: string; runs: number; ok: number; fail: number; duration_ms_sum: number; cost_usd_sum: number; parents: Array<{ parent_execution_id: string; runs: number; ok: number }>; parents_overflow?: number }>;
}
export interface SubscriberRunCounterDeps {
  /** The tuning row's number, or null when absent/unreadable. */
  readMode: () => Promise<number | null>;
  /** POST the batch; true when activity-api applied (or deduplicated) it. */
  post: (batch: SubscriberCountsBatch) => Promise<boolean>;
  now?: () => number;
  log?: (msg: string) => void;
  newId?: () => string;
}
interface Acc { runs: number; ok: number; fail: number; duration_ms_sum: number; cost_usd_sum: number; parents: Map<string, { runs: number; ok: number }>; parents_overflow: number }

export class SubscriberRunCounter implements TraceSink {
  private pending = new Map<string, Acc>();
  private windowStart: number;
  private mode: { at: number; v: number } | null = null;
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly s = { counted: 0, forwarded: 0, anomalous_traced: 0, flushed_runs: 0, flushes: 0, failed_flushes: 0, mode_read_failures: 0 };

  constructor(private readonly inner: TraceSink, private readonly deps: SubscriberRunCounterDeps, flushMs: number = FLUSH_MS) {
    this.windowStart = this.now();
    if (flushMs > 0) {
      this.timer = setInterval(() => { void this.flush(); }, flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }
  private log(m: string): void { (this.deps.log ?? ((x: string) => console.warn(x)))(m); }

  private async countingOn(): Promise<boolean> {
    const t = this.now();
    if (!this.mode || t - this.mode.at >= MODE_TTL_MS) {
      let v = 0;
      try { v = (await this.deps.readMode()) ?? 0; } catch { this.s.mode_read_failures += 1; v = 0; }
      this.mode = { at: t, v };
    }
    return this.mode.v === 1;
  }

  async record(trace: ExecutionTrace): Promise<void> {
    const tpl = bareTemplateId(trace.templateId);
    if (!COUNTED_SUBSCRIBER_TEMPLATES.has(tpl)) { this.s.forwarded += 1; return this.inner.record(trace); }
    if (isAnomalousTrace(trace)) { this.s.anomalous_traced += 1; return this.inner.record(trace); }
    if (!(await this.countingOn())) { this.s.forwarded += 1; return this.inner.record(trace); }
    const a = this.pending.get(tpl) ?? { runs: 0, ok: 0, fail: 0, duration_ms_sum: 0, cost_usd_sum: 0, parents: new Map(), parents_overflow: 0 };
    a.runs += 1; a.ok += 1; // a normal run: completed with no failed task
    a.duration_ms_sum += typeof trace.durationMs === "number" ? trace.durationMs : 0;
    a.cost_usd_sum += typeof trace.costUsd === "number" ? trace.costUsd : 0;
    if (trace.parentExecutionId) {
      const p = a.parents.get(trace.parentExecutionId);
      if (p) { p.runs += 1; p.ok += 1; }
      else if (a.parents.size < MAX_PARENTS) a.parents.set(trace.parentExecutionId, { runs: 1, ok: 1 });
      else a.parents_overflow += 1;
    }
    this.pending.set(tpl, a);
    this.s.counted += 1;
  }

  /** Send the pending counts. A batch that failed is resent FIRST, unchanged and under its own batch id, so a POST
   *  that was applied but whose answer was lost is deduplicated by activity-api rather than applied twice. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private retry: SubscriberCountsBatch | null = null;
  private async send(batch: SubscriberCountsBatch): Promise<boolean> {
    const runs = batch.entries.reduce((n, e) => n + e.runs, 0);
    let ok = false;
    try { ok = await this.deps.post(batch); } catch (err) { this.log(`[subscriber-counts] flush threw: ${(err as Error)?.message ?? String(err)}`); }
    if (ok) { this.s.flushes += 1; this.s.flushed_runs += runs; return true; }
    this.s.failed_flushes += 1;
    this.log(`[subscriber-counts] flush FAILED: batch ${batch.batch_id} (${runs} run(s)) kept and resent unchanged next flush; failed flushes so far ${this.s.failed_flushes}`);
    return false;
  }
  private async doFlush(): Promise<void> {
    if (this.retry) {
      if (!(await this.send(this.retry))) return; // still failing: keep it, and keep counting new runs in pending
      this.retry = null;
    }
    if (this.pending.size === 0) return;
    const taken = this.pending;
    this.pending = new Map();
    const start = this.windowStart;
    this.windowStart = this.now();
    const batch: SubscriberCountsBatch = {
      batch_id: this.deps.newId ? this.deps.newId() : `sc-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      window_start: new Date(start).toISOString(),
      window_end: new Date(this.windowStart).toISOString(),
      entries: [...taken].map(([template_id, a]) => ({
        template_id, runs: a.runs, ok: a.ok, fail: a.fail, duration_ms_sum: a.duration_ms_sum, cost_usd_sum: a.cost_usd_sum,
        parents: [...a.parents].map(([parent_execution_id, p]) => ({ parent_execution_id, runs: p.runs, ok: p.ok })),
        ...(a.parents_overflow > 0 ? { parents_overflow: a.parents_overflow } : {}),
      })),
    };
    if (!(await this.send(batch))) this.retry = batch;
  }

  /** Flush and stop the timer (shutdown). */
  async close(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    await this.flush();
  }

  stats(): Readonly<Record<string, number>> {
    let pendingRuns = 0;
    for (const a of this.pending.values()) pendingRuns += a.runs;
    const retryRuns = this.retry ? this.retry.entries.reduce((n, e) => n + e.runs, 0) : 0;
    return { ...this.s, pending_runs: pendingRuns, retry_runs: retryRuns };
  }
}
