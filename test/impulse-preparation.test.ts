/**
 * impulse_preparation resolver tests — synthesise_from_variables operation.
 *
 * Port verification: byte-for-byte behaviour parity with minibob's
 * synthesiseFromVariables (impulse-preparation-resolver.ts:342).
 */
import { describe, expect, test } from "bun:test";
import { makeImpulsePreparationResolver } from "../src/resolvers/impulse-preparation";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";

function makeContext(
  config: Record<string, unknown>,
  variables: Record<string, unknown> = {},
): ResolverContext {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  return {
    executionId: "exec_test",
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "impulse_preparation", config } as never] },
    task: { id: "x", description: "", resolver: "impulse_preparation", config } as never,
    variables,
    inputImpulses: [],
    store: runtime.store,
    clock: runtime.clock,
    random: runtime.random,
    eventSink: runtime.eventSink,
    traceSink: runtime.traceSink,
    attachedVessels: runtime.attachedVessels,
  };
}

describe("impulse_preparation: synthesise_from_variables", () => {
  test("wraps same-named variable in memo-pointer impulse with shape metadata", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: ["goal"] },
      { goal: "do the thing" },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.metadata.shape).toBe("goal");
    expect(impulses[0]!.content).toBe("do the thing");
    expect(impulses[0]!.pointer.type).toBe("memo");
  });

  test("skips shapes with no matching variable", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: ["goal", "context"] },
      { goal: "g" },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.metadata.shape).toBe("goal");
  });

  test("skips nullish and empty values", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: ["a", "b", "c"] },
      { a: null, b: "", c: undefined },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(0);
  });

  test("coerces number and boolean to string", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: ["n", "b"] },
      { n: 42, b: true },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(2);
    expect(impulses[0]!.content).toBe("42");
    expect(impulses[1]!.content).toBe("true");
  });

  test("rejects complex object values (LLM-agent territory)", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: ["x"] },
      { x: { nested: "object" } },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(0);
  });

  test("tolerates JSON-stringified missingShapes (template interpolation)", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: '["goal","ctx"]' },
      { goal: "g", ctx: "c" },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(2);
    expect(impulses.map((i) => i.metadata.shape)).toEqual(["goal", "ctx"]);
  });

  test("tolerates JSON-stringified variables (template interpolation)", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      {
        operation: "synthesise_from_variables",
        missingShapes: ["goal"],
        variables: '{"goal":"interpolated"}',
      },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.content).toBe("interpolated");
  });

  test("falls back to context.variables when config.variables is empty", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext(
      { operation: "synthesise_from_variables", missingShapes: ["goal"] },
      { goal: "from-context" },
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.content).toBe("from-context");
  });

  test("throws on unported operation", async () => {
    const resolver = makeImpulsePreparationResolver();
    const ctx = makeContext({ operation: "agent_fill", missingShapes: ["x"] });
    await expect(resolver.resolve(ctx)).rejects.toThrow(/not yet ported/);
  });
});
