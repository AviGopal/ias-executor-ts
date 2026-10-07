// The spool replay must read the format the sink writes (gap
// the-trace-sink-spools-rejected-traces-to-disk-and-nothing-ever-replays-them).
//
// spoolTrace writes a WRAPPER { endpoint, trace_id, spooled_at, body }. The replay that ran,
// _replaySpoolOnce, accepted only a bare trace with a top-level execution_id, so it moved every
// wrapper to quarantine/ unread; the replay that understood the wrapper (drainSpool) had no caller.
// Measured on node 1 2026-10-07: 168 traces in quarantine/, 09-25 to 10-07, 40 of 40 sampled wrappers.
// These pin: a trace spooled while the store is down is delivered (as the inner body) once it is
// back, a wrapper already in quarantine/ is recovered by the same replay, a recovered file that is
// rejected again is not recovered a second time, and a legacy bare trace still replays (control).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslatingTraceSink } from "../src/adapters/activity-api-trace-sink.js";

type Call = { url: string; body: string; idem: string | null };
let dir = "";
let saved: string | undefined;
let calls: Call[] = [];
let respond: (c: Call) => Response = () => new Response("ok", { status: 200 });

const sink = () => new TranslatingTraceSink("http://store.test", "k", {
  fetch: {
    request: async (input: string, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const c = { url: String(input), body: String(init?.body ?? ""), idem: h.get("Idempotency-Key") };
      calls.push(c);
      return respond(c);
    },
  },
});
// The constructor starts one replay pass at once and then every 5 s; wait for the first to finish
// on the empty spool, then drive single passes explicitly.
async function settled(s: TranslatingTraceSink): Promise<TranslatingTraceSink> {
  for (let i = 0; i < 50 && (s as unknown as { replayInFlight: boolean }).replayInFlight; i++) await new Promise((r) => setTimeout(r, 10));
  calls = [];
  return s;
}
const pass = (s: TranslatingTraceSink) => (s as unknown as { _replaySpoolOnce(): Promise<void> })._replaySpoolOnce();
const spool = (s: TranslatingTraceSink, json: string, id: string) =>
  (s as unknown as { spoolTrace(j: string, i: string): Promise<boolean> }).spoolTrace(json, id);
const files = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n !== "quarantine") : []);
const quarantined = () => files(join(dir, "quarantine"));
const traceJson = (id: string) => JSON.stringify({ execution_id: id, activity_id: "a", success: true });

beforeEach(() => {
  saved = process.env.IAS_TRACE_SPOOL_DIR;
  dir = mkdtempSync(join(tmpdir(), "spool-replay-"));
  process.env.IAS_TRACE_SPOOL_DIR = dir;
  calls = [];
  respond = () => new Response("ok", { status: 200 });
});
afterEach(() => {
  if (saved === undefined) delete process.env.IAS_TRACE_SPOOL_DIR; else process.env.IAS_TRACE_SPOOL_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("trace spool replay reads the format the sink writes", () => {
  it("MUST-FAIL: a trace spooled while the store was down is delivered as its inner body once it is back", async () => {
    const s = await settled(sink());
    expect(await spool(s, traceJson("exec_spooled_1"), "exec_spooled_1")).toBe(true);
    expect(files(dir).length).toBe(1);
    await pass(s);
    expect(calls.map((c) => c.body)).toEqual([traceJson("exec_spooled_1")]);
    expect(calls[0]!.url).toBe("http://store.test/v2/activities/execution-traces");
    expect(calls[0]!.idem).toBe("exec_spooled_1");
    expect(files(dir)).toEqual([]);
    expect(quarantined()).toEqual([]);
  });

  it("MUST-FAIL: a wrapper already moved to quarantine/ by the old replay is recovered and delivered", async () => {
    const s = await settled(sink());
    mkdirSync(join(dir, "quarantine"), { recursive: true });
    writeFileSync(join(dir, "quarantine", "1790325919333-exec_old.json"),
      JSON.stringify({ endpoint: "http://store.test", trace_id: "exec_old", spooled_at: "2026-09-25T08:45:19Z", body: traceJson("exec_old") }));
    await pass(s);
    await pass(s);
    expect(calls.map((c) => c.body)).toEqual([traceJson("exec_old")]);
    expect(quarantined()).toEqual([]);
    expect(files(dir)).toEqual([]);
  });

  it("MUST-FAIL: a store that already holds the trace counts as delivered, not as a retry forever", async () => {
    const s = await settled(sink());
    await spool(s, traceJson("exec_dup"), "exec_dup");
    respond = () => new Response('Database record `execution:x` already contains execution_id', { status: 500 });
    await pass(s);
    expect(calls.length).toBe(1);
    expect(files(dir)).toEqual([]);
  });

  it("a recovered file the store rejects again is quarantined once and not recovered a second time", async () => {
    const s = await settled(sink());
    mkdirSync(join(dir, "quarantine"), { recursive: true });
    writeFileSync(join(dir, "quarantine", "1790325919333-exec_bad.json"),
      JSON.stringify({ endpoint: "http://store.test", trace_id: "exec_bad", spooled_at: "2026-09-25T08:45:19Z", body: traceJson("exec_bad") }));
    respond = () => new Response("schema", { status: 422 });
    for (let i = 0; i < 4; i++) await pass(s);
    expect(calls.length).toBe(1);
    expect(quarantined().length).toBe(1);
    expect(files(dir)).toEqual([]);
  });

  it("CONTROL: a legacy bare trace (top-level execution_id) still replays", async () => {
    const s = await settled(sink());
    writeFileSync(join(dir, "1790000000000-exec_bare.json"), traceJson("exec_bare"));
    await pass(s);
    expect(calls.map((c) => c.body)).toEqual([traceJson("exec_bare")]);
    expect(files(dir)).toEqual([]);
  });

  it("MUST-FAIL: a store outage keeps the spooled wrapper for the next pass instead of quarantining it", async () => {
    const s = await settled(sink());
    await spool(s, traceJson("exec_wait"), "exec_wait");
    respond = () => new Response("down", { status: 503 });
    await pass(s);
    expect(files(dir).length).toBe(1);
    expect(quarantined()).toEqual([]);
  });
});
