/**
 * Parity fixture test (Phase 20.2.6)
 * Loads predicate-binding.json and verifies ias-executor-ts produces
 * exactly the expected bindings. minibob must pass the same assertions
 * against the same fixture to satisfy 20.S5.
 */

import { describe, test, expect } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate, Impulse, InputShapeRef } from "../src/ontology";
import { SteppingClock, SequentialRandom, TraceSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";

const fixture = await Bun.file(new URL("./fixtures/predicate-binding.json", import.meta.url)).json() as {
  template: ActivityTemplate;
  seed_impulses: Array<{ id: string; shape: string; producedBy: string | null }>;
  expected_bindings: Record<string, string[]>;
};

describe("predicate-binding fixture (20.2.6 parity)", () => {
  test("produces expected bindings for all three tasks", async () => {
    const clock = new SteppingClock();
    const random = new SequentialRandom();
    const traceSink = new TraceSinkSpy();
    const runtime = new ExecutionRuntime({ clock, random, traceSink });

    // Seed impulses from fixture
    for (const si of fixture.seed_impulses) {
      const imp: Impulse = {
        id: si.id,
        pointer: { type: "memo" },
        metadata: { shape: si.shape, ...(si.producedBy ? { producedBy: si.producedBy } : {}) },
        loaded: true,
        content: `seed-${si.id}`,
      };
      runtime.store.put(imp);
    }

    // Capture resolver that records bindings per task
    const bindingsPerTask: Record<string, string[]> = {};
    runtime.resolvers.register({
      id: "capture",
      tier: "deterministic",
      async resolve(ctx: ResolverContext) {
        bindingsPerTask[ctx.task.id] = ctx.inputImpulses.map((i) => i.id).sort();
        return [{
          id: ctx.random.id("out"),
          pointer: { type: "memo" },
          metadata: { shape: ctx.task.outputShapes?.[0] ?? "result" },
          loaded: true,
          content: "ok",
        }];
      },
    });

    const trace = await new ActivityExecutor(runtime).execute(fixture.template);
    expect(trace.status).toBe("completed");

    // Verify each task received exactly the expected impulse ids
    for (const [taskId, expectedIds] of Object.entries(fixture.expected_bindings)) {
      const actual = (bindingsPerTask[taskId] ?? []).sort();
      const expected = [...expectedIds].sort();
      expect(actual).toEqual(expected);
    }
  });
});
