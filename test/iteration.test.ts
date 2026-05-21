/**
 * iteration resolver tests.
 *
 * Cover the slot-binding use cases: foreach over an array (or
 * JSON-stringified array from template interpolation), dispatch a named
 * inner resolver per element, aggregate as list.
 */
import { describe, expect, test } from "bun:test";
import { makeIterationResolver } from "../src/resolvers/iteration";
import type { Resolver, ResolverContext } from "../src/resolvers";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";

function makeFakeResolver(id: string, fn: (ctx: ResolverContext) => Promise<unknown>): Resolver {
  return {
    id,
    tier: "deterministic",
    async resolve(ctx) {
      const content = await fn(ctx);
      return [
        {
          id: ctx.random.id(id),
          pointer: { type: "memo" },
          metadata: { shape: `${id}_result` },
          loaded: true,
          content,
        },
      ];
    },
  };
}

function makeContext(
  config: Record<string, unknown>,
  inner: Resolver,
  variables: Record<string, unknown> = {},
): ResolverContext {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  runtime.resolvers.register(inner);
  return {
    executionId: "exec_test",
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "iteration", config } as never] },
    task: { id: "x", description: "", resolver: "iteration", config } as never,
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

describe("iteration resolver", () => {
  test("iterates an array, dispatches inner resolver per element, aggregates as list", async () => {
    const seen: string[] = [];
    const inner = makeFakeResolver("rec", async (ctx) => {
      const shape = (ctx.task.config as { shape?: string })?.shape ?? "";
      seen.push(shape);
      return `picked:${shape}`;
    });
    const resolver = makeIterationResolver((id) => id === "rec" ? inner : undefined);
    const ctx = makeContext(
      {
        over: ["goal", "context"],
        elementVar: "shape",
        body: { resolver: "rec", config: { shape: "{{shape}}" } },
      },
      inner,
    );
    const impulses = await resolver.resolve(ctx);
    expect(seen).toEqual(["goal", "context"]);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.content).toEqual(["picked:goal", "picked:context"]);
  });

  test("tolerates JSON-stringified over (template interpolation)", async () => {
    const inner = makeFakeResolver("rec", async () => "ok");
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      {
        over: '["a","b","c"]',
        elementVar: "x",
        body: { resolver: "rec" },
      },
      inner,
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.content).toEqual(["ok", "ok", "ok"]);
  });

  test("indexVar interpolation provides numeric position", async () => {
    const seenIndices: unknown[] = [];
    const inner = makeFakeResolver("rec", async (ctx) => {
      seenIndices.push((ctx.task.config as { i?: unknown })?.i);
      return null;
    });
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      {
        over: ["a", "b"],
        elementVar: "x",
        indexVar: "i",
        body: { resolver: "rec", config: { i: "{{i}}" } },
      },
      inner,
    );
    await resolver.resolve(ctx);
    expect(seenIndices).toEqual(["0", "1"]);
  });

  test("aggregateAs:first returns the first element's result only", async () => {
    let n = 0;
    const inner = makeFakeResolver("rec", async () => ++n);
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      {
        over: ["a", "b", "c"],
        elementVar: "x",
        aggregateAs: "first",
        body: { resolver: "rec" },
      },
      inner,
    );
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.content).toBe(1);
  });

  test("respects maxIterations", async () => {
    const inner = makeFakeResolver("rec", async () => "x");
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      {
        over: ["1", "2", "3", "4", "5"],
        elementVar: "x",
        maxIterations: 2,
        body: { resolver: "rec" },
      },
      inner,
    );
    const impulses = await resolver.resolve(ctx);
    expect((impulses[0]!.content as unknown[]).length).toBe(2);
  });

  test("error in body propagates as per-element error entry unless stopOnError", async () => {
    const inner = makeFakeResolver("rec", async (ctx) => {
      if ((ctx.task.config as { shape?: string })?.shape === "bad") {
        throw new Error("nope");
      }
      return "ok";
    });
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      {
        over: ["good", "bad", "good"],
        elementVar: "shape",
        body: { resolver: "rec", config: { shape: "{{shape}}" } },
      },
      inner,
    );
    const impulses = await resolver.resolve(ctx);
    const list = impulses[0]!.content as Array<{ error?: string } | string>;
    expect(list.length).toBe(3);
    expect(list[0]).toBe("ok");
    expect((list[1] as { error?: string }).error).toBe("nope");
    expect(list[2]).toBe("ok");
  });

  test("stopOnError stops the loop at the first error", async () => {
    const inner = makeFakeResolver("rec", async (ctx) => {
      if ((ctx.task.config as { shape?: string })?.shape === "bad") throw new Error("stop");
      return "ok";
    });
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      {
        over: ["good", "bad", "good"],
        elementVar: "shape",
        stopOnError: true,
        body: { resolver: "rec", config: { shape: "{{shape}}" } },
      },
      inner,
    );
    const impulses = await resolver.resolve(ctx);
    const list = impulses[0]!.content as unknown[];
    expect(list.length).toBe(2); // good + bad, stopped
  });

  test("throws when inner resolver is not registered", async () => {
    const inner = makeFakeResolver("present", async () => "x");
    const resolver = makeIterationResolver((id) => (id === "present" ? inner : undefined));
    const ctx = makeContext(
      { over: ["a"], elementVar: "x", body: { resolver: "absent" } },
      inner,
    );
    await expect(resolver.resolve(ctx)).rejects.toThrow(/not registered/);
  });

  test("throws when body.resolver === \"activity\" (out of scope for §4 port)", async () => {
    const inner = makeFakeResolver("x", async () => "x");
    const resolver = makeIterationResolver(() => inner);
    const ctx = makeContext(
      { over: ["a"], elementVar: "x", body: { resolver: "activity" } },
      inner,
    );
    await expect(resolver.resolve(ctx)).rejects.toThrow(/not yet ported/);
  });
});
