// CONSTRUCTING A TRACE SINK HAS NO EFFECT (2026-10-19). TranslatingTraceSink's constructor started a spool replay
// (mkdir of the spool directory, a readdir, quarantine recovery, POSTs) and a 5 s replay interval. goal-host's index.ts
// builds one at module load through GoalHost's activity-api adapter, and tests and lane checks import that module in a
// child whose spool path takes its live default, so every such import ran a replay against the LIVE spool. The replay
// now starts at the first record() or an explicit start(), both idempotent.
// MUST-FAIL at the parent: constructing the sink under the effect recorder records the spool mkdir.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslatingTraceSink } from "../src/adapters/activity-api-trace-sink.js";
import type { ExecutionTrace } from "../src/ontology";

const RECORDER = join(import.meta.dir, "fixtures", "effect-recorder.ts");
const SINK = join(import.meta.dir, "..", "src", "adapters", "activity-api-trace-sink.ts");

interface Effect { kind: string; api: string; target: string }

describe("constructing a TranslatingTraceSink touches neither the spool nor the network", () => {
  it("[MUST-FAIL] a sink constructed under the effect recorder records ZERO effects", async () => {
    const home = mkdtempSync(join(tmpdir(), "sink-lazy-"));
    try {
      // The spool path points into the scratch dir, so even a regression cannot reach a live spool.
      const code = `const { TranslatingTraceSink } = await import(${JSON.stringify(SINK)});
        new TranslatingTraceSink("http://127.0.0.1:9", "k");
        await new Promise((r) => setTimeout(r, 300));
        globalThis.__effectRecorder.report("constructed"); process.exit(0);`;
      const p = Bun.spawn([process.execPath, "--preload", RECORDER, "-e", code], {
        env: { PATH: process.env.PATH ?? "", HOME: home, NODE_ENV: "test", TZ: "UTC", IAS_TRACE_SPOOL_DIR: join(home, "spool") },
        stdout: "ignore", stderr: "pipe",
      });
      const stderr = await new Response(p.stderr).text();
      await p.exited;
      const line = stderr.split("\n").find((l) => l.startsWith("EFFECTS "));
      if (!line) throw new Error(`no effect record (rc ${p.exitCode}): ${stderr.slice(-600)}`);
      const rec = JSON.parse(line.slice("EFFECTS ".length)) as { outcome: string; effects: Effect[] };
      expect(rec.outcome).toBe("constructed");
      expect(rec.effects).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the replay starts at the first record() or start(), exactly once", () => {
  let dir = "";
  let saved: string | undefined;
  let posts: string[] = [];
  const sink = () => new TranslatingTraceSink("http://store.test", "k", {
    fetch: { request: async (_input: string, init?: RequestInit) => { posts.push(String(init?.body ?? "")); return new Response("ok", { status: 200 }); } },
  });
  /** Count the replay passes the sink starts. */
  const countPasses = (s: TranslatingTraceSink): { n: number } => {
    const c = { n: 0 };
    const inner = s as unknown as { _replaySpoolOnce(): Promise<void> };
    const orig = inner._replaySpoolOnce.bind(s);
    inner._replaySpoolOnce = () => { c.n++; return orig(); };
    return c;
  };
  const idle = async (s: TranslatingTraceSink) => {
    for (let i = 0; i < 100 && (s as unknown as { replayInFlight: boolean }).replayInFlight; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const spooled = () => writeFileSync(join(dir, "0001-exec_spooled_lazy.json"), JSON.stringify({ endpoint: "http://store.test", trace_id: "exec_spooled_lazy", spooled_at: "2026-10-19T00:00:00.000Z", body: JSON.stringify({ execution_id: "exec_spooled_lazy", activity_id: "a", success: true }) }));
  const trace = (): ExecutionTrace => ({
    id: "exec_lazy_1", templateId: "tpl-lazy", templateName: "TplLazy", status: "completed",
    inputImpulseIds: [], outputImpulseIds: [], durationMs: 1, costUsd: 0, tags: [], tasks: [],
  } as unknown as ExecutionTrace);

  beforeEach(() => {
    saved = process.env.IAS_TRACE_SPOOL_DIR;
    dir = mkdtempSync(join(tmpdir(), "sink-lazy-spool-"));
    process.env.IAS_TRACE_SPOOL_DIR = dir;
    posts = [];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.IAS_TRACE_SPOOL_DIR; else process.env.IAS_TRACE_SPOOL_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it("[CONTROL] the first record() runs ONE replay pass, which delivers the spooled backlog", async () => {
    spooled();
    const s = sink();
    const c = countPasses(s);
    await new Promise((r) => setTimeout(r, 50));
    expect(c.n).toBe(0);
    expect(readdirSync(dir)).toEqual(["0001-exec_spooled_lazy.json"]);
    await s.record(trace());
    await idle(s);
    expect(c.n).toBe(1);
    expect(posts.some((b) => b.includes("exec_spooled_lazy"))).toBe(true);
    expect(readdirSync(dir).filter((n) => n !== "quarantine")).toEqual([]);
  });

  it("[CONTROL] start() runs ONE replay pass and is idempotent", async () => {
    spooled();
    const s = sink();
    const c = countPasses(s);
    s.start();
    s.start();
    await idle(s);
    expect(c.n).toBe(1);
    expect(posts.some((b) => b.includes("exec_spooled_lazy"))).toBe(true);
  });
});
