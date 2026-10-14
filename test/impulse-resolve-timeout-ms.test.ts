/**
 * impulse-resolve: the caller's deadline is per call. A pointer's `timeout_ms` (a finite integer, clamped to
 * 1000..60000) overrides the process-wide default, and is stripped from the pointer the producer receives.
 * Against a real local producer (Bun.serve) that answers after a fixed delay.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeImpulseResolveResolver } from "../src/resolvers/impulse-resolve";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";

let server: ReturnType<typeof Bun.serve>;
let lastBody: Record<string, unknown> = {};
const prevTimeout = process.env.IMPULSE_RESOLVE_TIMEOUT_MS;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      lastBody = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const p = (lastBody["pointer"] ?? {}) as { delay_ms?: number; type?: string };
      await Bun.sleep(typeof p.delay_ms === "number" ? p.delay_ms : 0);
      return Response.json({ success: true, content: "ROWS-7f3c", metadata: { shape: String(p.type) } });
    },
  });
  // the process-wide default, set LOWER than the producer's delay: without a per-call deadline the read times out
  process.env.IMPULSE_RESOLVE_TIMEOUT_MS = "200";
});
afterAll(() => {
  server.stop(true);
  if (prevTimeout === undefined) delete process.env.IMPULSE_RESOLVE_TIMEOUT_MS;
  else process.env.IMPULSE_RESOLVE_TIMEOUT_MS = prevTimeout;
});

function makeContext(config: Record<string, unknown>): ResolverContext {
  const runtime = new ExecutionRuntime({ clock: new SteppingClock(1_000_000, 5), random: new SequentialRandom(), eventSink: new EventSinkSpy() });
  return {
    executionId: "exec_test",
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "impulse-resolve", config } as never] },
    task: { id: "x", description: "", resolver: "impulse-resolve", config } as never,
    variables: {},
    inputImpulses: [],
    store: runtime.store,
    clock: runtime.clock,
    random: runtime.random,
    eventSink: runtime.eventSink,
    traceSink: runtime.traceSink,
    attachedVessels: runtime.attachedVessels,
  };
}
const resolve = (pointer: Record<string, unknown>) => {
  const resolver = makeImpulseResolveResolver({ activityApiEndpoint: `http://127.0.0.1:${server.port}`, activityApiKey: "k" });
  const config = { pointer };
  return { run: () => resolver.resolve(makeContext(config)), config };
};

describe("impulse-resolve: a per-call timeout_ms on the pointer", () => {
  test("[MUST-FAIL] (a) a producer slower than the default but inside the pointer's timeout_ms answers, and its content binds", async () => {
    const imps = await resolve({ type: "slowReport", delay_ms: 600, timeout_ms: 2000 }).run();
    expect(imps[0]!.content).toBe("ROWS-7f3c");
    expect(imps[0]!.metadata.degraded).toBeUndefined();
  });

  test("(b) with no timeout_ms, today's default applies: a producer slower than it is a timeout (a failed read)", async () => {
    await expect(resolve({ type: "slowReport", delay_ms: 600 }).run()).rejects.toThrow("impulse-resolve: timeout after 200ms");
  });

  test("(c) timeout_ms below the floor is clamped to 1000 (so a 600 ms producer answers); a non-integer falls back to the default", async () => {
    const imps = await resolve({ type: "slowReport", delay_ms: 600, timeout_ms: 50 }).run();
    expect(imps[0]!.content).toBe("ROWS-7f3c");
    await expect(resolve({ type: "slowReport", delay_ms: 1500, timeout_ms: 50 }).run()).rejects.toThrow("impulse-resolve: timeout after 1000ms");
    await expect(resolve({ type: "slowReport", delay_ms: 600, timeout_ms: 2000.5 }).run()).rejects.toThrow("impulse-resolve: timeout after 200ms");
  });

  test("(d) the producer never sees timeout_ms (the rest of the pointer is forwarded), and the template's config is not mutated", async () => {
    const r = resolve({ type: "fastReport", group_by: "activity_id", timeout_ms: 30000 });
    await r.run();
    const fwd = lastBody["pointer"] as Record<string, unknown>;
    expect(fwd["timeout_ms"]).toBeUndefined();
    expect(fwd["group_by"]).toBe("activity_id");
    expect(fwd["type"]).toBe("fastReport");
    expect(r.config.pointer["timeout_ms"]).toBe(30000);
  });
});
