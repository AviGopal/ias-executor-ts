// NORMAL RUNS OF THE COUNTED LIFECYCLE SUBSCRIBERS ARE COUNTED, NOT TRACED; ANOMALOUS RUNS STILL TRACE IN FULL (DB1).
//
//   [MUST-FAIL] mode 1: normal validator-dispatch / slot-binding runs write NO trace and flush as ONE counts batch
//               (runs, ok, duration and cost sums, per-parent counts).
//   [MUST-FAIL] an ANOMALOUS run (status failed, or a task with success:false) still writes its FULL trace.
//   [CONTROL]   mode 0, an absent or unreadable row: every trace is forwarded unchanged (fail-open to today).
//   [CONTROL]   a template outside the counted set (ribosome-extract, a user template) is always forwarded.
//   [CONTROL]   a failed flush is logged and counted, and the SAME batch (same id) is resent first, then cleared.
//   [CONTROL]   wiring: goal-host wraps its default trace sink with the counter and reads the shaped row.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { SubscriberRunCounter, isAnomalousTrace, COUNTED_SUBSCRIBER_TEMPLATES, type SubscriberCountsBatch } from "../src/adapters/subscriber-run-counter";

const trace = (templateId: string, over: Record<string, unknown> = {}) => ({
  id: `exec-${Math.random().toString(36).slice(2, 8)}`, templateId, templateName: templateId, status: "completed",
  parentExecutionId: "exec_parent01", inputImpulseIds: [], inputShapes: [], outputImpulseIds: [],
  tasks: [{ taskId: "t1", description: "", resolverId: "r", success: true }], durationMs: 12, costUsd: 0.001, ...over,
}) as never;
function harness(mode: number | null | (() => never), post: (b: SubscriberCountsBatch) => Promise<boolean> = async () => true) {
  const traced: Array<{ templateId: string }> = [];
  const sent: SubscriberCountsBatch[] = [];
  const logs: string[] = [];
  let n = 0;
  const c = new SubscriberRunCounter({ record: async (t) => { traced.push(t as never); } }, {
    readMode: async () => (typeof mode === "function" ? mode() : mode),
    post: async (b) => { sent.push(structuredClone(b)); return post(b); },
    log: (m) => logs.push(m), newId: () => `b${++n}`,
  }, 0);
  return { c, traced, sent, logs };
}

describe("lifecycle subscriber runs are counted, anomalies traced", () => {
  it("[MUST-FAIL] mode 1: normal counted runs write no trace and flush as one batch", async () => {
    const { c, traced, sent } = harness(1);
    await c.record(trace("validator-dispatch"));
    await c.record(trace("validator-dispatch", { parentExecutionId: "exec_parent02" }));
    await c.record(trace("slot-binding"));
    expect(traced.length).toBe(0);
    await c.flush();
    expect(sent.length).toBe(1);
    const vd = sent[0]!.entries.find((e) => e.template_id === "validator-dispatch")!;
    expect(vd).toMatchObject({ runs: 2, ok: 2, fail: 0, duration_ms_sum: 24 });
    expect(vd.parents.sort((a, b) => a.parent_execution_id.localeCompare(b.parent_execution_id))).toEqual([
      { parent_execution_id: "exec_parent01", runs: 1, ok: 1 }, { parent_execution_id: "exec_parent02", runs: 1, ok: 1 }]);
    expect(sent[0]!.entries.find((e) => e.template_id === "slot-binding")).toMatchObject({ runs: 1, ok: 1 });
    expect(c.stats()).toMatchObject({ counted: 3, flushed_runs: 3, pending_runs: 0 });
  });

  it("[MUST-FAIL] an anomalous run still writes its full trace", async () => {
    const { c, traced } = harness(1);
    await c.record(trace("validator-dispatch", { status: "failed" }));
    await c.record(trace("slot-binding", { tasks: [{ taskId: "t1", description: "", resolverId: "r", success: false }] }));
    expect(traced.map((t) => t.templateId)).toEqual(["validator-dispatch", "slot-binding"]);
    expect(isAnomalousTrace(trace("x", { status: "failed" }))).toBe(true);
    expect(isAnomalousTrace(trace("x"))).toBe(false);
  });

  it("[CONTROL] mode 0, absent or unreadable: everything is forwarded", async () => {
    for (const mode of [0, null, () => { throw new Error("down"); }] as Array<number | null | (() => never)>) {
      const { c, traced, sent } = harness(mode);
      await c.record(trace("validator-dispatch"));
      await c.flush();
      expect(traced.length).toBe(1);
      expect(sent.length).toBe(0);
    }
  });

  it("[CONTROL] a template outside the counted set is always forwarded", async () => {
    const { c, traced } = harness(1);
    await c.record(trace("ribosome-extract"));
    await c.record(trace("activity:⟨development-vessel:coverage-tick⟩"));
    expect(traced.length).toBe(2);
    expect([...COUNTED_SUBSCRIBER_TEMPLATES].sort()).toEqual(["slot-binding", "validator-dispatch"]);
  });

  it("[CONTROL] a failed flush is logged and counted; the same batch id is resent first, then cleared", async () => {
    let fail = true;
    const { c, sent, logs } = harness(1, async () => !fail);
    await c.record(trace("validator-dispatch"));
    await c.flush();
    expect(c.stats()).toMatchObject({ failed_flushes: 1, retry_runs: 1 });
    expect(logs.some((l) => l.includes("flush FAILED: batch b1"))).toBe(true);
    await c.record(trace("slot-binding"));
    fail = false;
    await c.flush();
    expect(sent.map((b) => b.batch_id)).toEqual(["b1", "b1", "b2"]);
    expect(sent[1]).toEqual(sent[0]);
    expect(c.stats()).toMatchObject({ retry_runs: 0, pending_runs: 0, flushed_runs: 2 });
  });

  it("[CONTROL] wiring: goal-host wraps its default trace sink and reads the shaped row", () => {
    const src = readFileSync(new URL("../src/hosts/goal-host.ts", import.meta.url), "utf8");
    expect(src).toContain("traceSink: options.traceSink ?? (this.subscriberRunCounter = new SubscriberRunCounter(this.activityApi.asTraceSink(), {");
    expect(src).toContain("readMode: () => this.activityApi.readTuningNumber(SUBSCRIBER_TRACE_MODE_ROW),");
    expect(src).toContain("async flushSubscriberCounts()");
  });
});
