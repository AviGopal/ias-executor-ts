/**
 * impulse_pool_selection resolver tests — minimal port.
 *
 * Covers structural contract that slot-binding's pool_precheck task
 * depends on, sans the Thompson ranking (deferred to a follow-up port
 * once the HTTP impulse-relevance fetch is wired).
 */
import { describe, expect, test } from "bun:test";
import { makeImpulsePoolSelectionResolver } from "../src/resolvers/impulse-pool-selection";
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
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "impulse_pool_selection", config } as never] },
    task: { id: "x", description: "", resolver: "impulse_pool_selection", config } as never,
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

describe("impulse_pool_selection (minimal port)", () => {
  test("selects first shape-matching candidate from poolCandidates", async () => {
    const resolver = makeImpulsePoolSelectionResolver();
    const ctx = makeContext({
      shape: "goal",
      poolCandidates: [
        { id: "i1", shape: "other" },
        { id: "i2", shape: "goal" },
        { id: "i3", shape: "goal" },
      ],
    });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { selected: { id: string }; candidates: { id: string }[]; degraded: boolean };
    expect(c.selected.id).toBe("i2");
    expect(c.candidates.map((x) => x.id)).toEqual(["i2", "i3"]);
    expect(c.degraded).toBe(true);
  });

  test("returns no_pool_candidates:true when filtered set is empty", async () => {
    const resolver = makeImpulsePoolSelectionResolver();
    const ctx = makeContext({
      shape: "nothing",
      poolCandidates: [
        { id: "i1", shape: "other" },
      ],
    });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { no_pool_candidates?: boolean; selected?: unknown };
    expect(c.no_pool_candidates).toBe(true);
    expect(c.selected).toBeUndefined();
  });

  test("predicateProducedBy filters within shape-matched set", async () => {
    const resolver = makeImpulsePoolSelectionResolver();
    const ctx = makeContext({
      shape: "goal",
      poolCandidates: [
        { id: "i1", shape: "goal", producedBy: "x" },
        { id: "i2", shape: "goal", producedBy: "y" },
        { id: "i3", shape: "goal", producedBy: "y" },
      ],
      predicateProducedBy: "y",
    });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { selected: { id: string }; candidates: { id: string }[] };
    expect(c.selected.id).toBe("i2");
    expect(c.candidates.map((x) => x.id)).toEqual(["i2", "i3"]);
  });

  test("tolerates JSON-stringified poolCandidates from template interpolation", async () => {
    const resolver = makeImpulsePoolSelectionResolver();
    const ctx = makeContext({
      shape: "goal",
      poolCandidates: JSON.stringify([{ id: "i1", shape: "goal" }]),
    });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { selected: { id: string } };
    expect(c.selected.id).toBe("i1");
  });

  test("missing shape throws", async () => {
    const resolver = makeImpulsePoolSelectionResolver();
    const ctx = makeContext({ poolCandidates: [] });
    await expect(resolver.resolve(ctx)).rejects.toThrow(/config.shape is required/);
  });

  test("accepts pre-narrowed `candidates` instead of poolCandidates", async () => {
    const resolver = makeImpulsePoolSelectionResolver();
    const ctx = makeContext({
      shape: "goal",
      candidates: [{ id: "p1" }, { id: "p2" }],
    });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { selected: { id: string }; candidates: { id: string }[] };
    // Pre-narrowed candidates often omit `shape`; the resolver doesn't reject
    // them — only entries with an explicit non-matching shape are filtered.
    expect(c.selected.id).toBe("p1");
    expect(c.candidates.length).toBe(2);
  });
});
