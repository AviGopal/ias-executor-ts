/**
 * learning_signal_writer resolver tests.
 */
import { describe, expect, test } from "bun:test";
import { makeLearningSignalWriterResolver } from "../src/resolvers/learning-signal-writer";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";

function makeContext(config: Record<string, unknown>): ResolverContext {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  return {
    executionId: "exec_test",
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "learning_signal_writer", config } as never] },
    task: { id: "x", description: "", resolver: "learning_signal_writer", config } as never,
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

describe("learning_signal_writer", () => {
  test("no endpoint configured → degraded no-op success", async () => {
    const resolver = makeLearningSignalWriterResolver({});
    const ctx = makeContext({
      signals: ["impulse_relevance"],
      templateId: "tpl_1",
      allImpulseIds: ["imp-a", "imp-b"],
      executionSucceeded: true,
    });
    const out = await resolver.resolve(ctx);
    expect(out[0]!.metadata.shape).toBe("learning_signal_write_result");
    const result = out[0]!.content as { degraded: boolean; errors: unknown[] };
    expect(result.degraded).toBe(true);
    expect(result.errors.length).toBe(2);
  });

  test("empty signals → no-op success", async () => {
    const resolver = makeLearningSignalWriterResolver({});
    const ctx = makeContext({ signals: [], templateId: "tpl_1" });
    const out = await resolver.resolve(ctx);
    const r = out[0]!.content as { signalsAttempted: string[]; errors: unknown[] };
    expect(r.signalsAttempted).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test("missing templateId → impulse_relevance is no-op success", async () => {
    const resolver = makeLearningSignalWriterResolver({ activityApiEndpoint: "http://nope" });
    const ctx = makeContext({
      signals: ["impulse_relevance"],
      allImpulseIds: ["imp-a"],
    });
    const out = await resolver.resolve(ctx);
    const r = out[0]!.content as { signalsSucceeded: string[]; errors: unknown[] };
    expect(r.signalsSucceeded).toContain("impulse_relevance");
    expect(r.errors).toEqual([]);
  });

  test("JSON-stringified allImpulseIds is parsed", async () => {
    const resolver = makeLearningSignalWriterResolver({});
    const ctx = makeContext({
      signals: ["impulse_relevance"],
      templateId: "tpl_1",
      allImpulseIds: '["imp-a","imp-b","imp-c"]',
      executionSucceeded: false,
    });
    const out = await resolver.resolve(ctx);
    const r = out[0]!.content as { errors: unknown[] };
    expect(r.errors.length).toBe(3);
  });

  test("unknown signal → recorded as error, others run", async () => {
    const resolver = makeLearningSignalWriterResolver({});
    const ctx = makeContext({
      signals: ["bogus_signal", "impulse_relevance"],
      templateId: "tpl_1",
      allImpulseIds: [],
    });
    const out = await resolver.resolve(ctx);
    const r = out[0]!.content as { errors: Array<{ signal: string }>; signalsSucceeded: string[] };
    expect(r.errors.some((e) => e.signal === "bogus_signal")).toBe(true);
    expect(r.signalsSucceeded).toContain("impulse_relevance");
  });
});
