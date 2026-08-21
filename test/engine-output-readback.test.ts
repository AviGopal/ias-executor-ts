/**
 * Output read-back after a top-level execution (seam R3-execute-04).
 *
 * The goal-host walk reads each step's real content back out of the impulse
 * store AFTER `execute()` returns:
 *
 *   goal-host-vessel/src/index.ts:9380  const imp = store?.get(id);
 *   goal-host-vessel/src/index.ts:9386  addToPool(shape, imp.content, ...)
 *
 * A walk step is top-level by the engine's own test — no `parentExecutionId`
 * and an empty `compositionChain` — so `evictExecutionScope` took the
 * `isTopLevel` branch and ran `store.impulses.clear()` on the way out. Every
 * `store.get(id)` then missed, the walk fell through to its stub branch, and
 * pooled `{producedBy, executionId}` in place of the produced data. Because
 * `addToPool` is first-write-wins with no upgrade path, that substitution was
 * permanent for the rest of the walk: step N+1 interpolated a metadata object
 * where the data belonged, and the reach judge graded the stub as evidence.
 *
 * Nothing observed it — the walk logged `new_shapes=1` for a stub exactly as
 * for real content.
 *
 * The contract these tests pin:
 *   - a top-level execution's DECLARED OUTPUTS are readable after it returns;
 *   - everything else it created is still evicted (the leak this branch exists
 *     to prevent must not come back).
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate, Impulse } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

/** Emits the declared output shape carrying real content, plus one extra
 *  intermediate impulse that the template does NOT declare. */
function emitWithIntermediate(shape: string, content: unknown): Resolver {
  return {
    id: `emit-${shape}`,
    tier: "deterministic",
    async resolve(ctx) {
      return [
        {
          id: ctx.random.id("imp"),
          pointer: { type: "memo" },
          metadata: { shape },
          loaded: true,
          content,
        },
        {
          id: ctx.random.id("imp"),
          pointer: { type: "memo" },
          metadata: { shape: "scratch_intermediate" },
          loaded: true,
          content: "x".repeat(64),
        },
      ];
    },
  };
}

function makeRuntime(): ExecutionRuntime {
  return new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
}

function storeOf(runtime: ExecutionRuntime): Map<string, Impulse> {
  return (runtime.store as unknown as { impulses: Map<string, Impulse> }).impulses;
}

describe("top-level output read-back (R3-execute-04)", () => {
  test("declared outputs survive eviction and carry their real content", async () => {
    const runtime = makeRuntime();
    const payload = { dependencies: 42, source: "package.json" };
    runtime.resolvers.register(emitWithIntermediate("httpResponse", payload));
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "tpl-readback",
      name: "Readback",
      tasks: [
        {
          id: "t1",
          description: "produce httpResponse",
          resolver: "emit-httpResponse",
          outputShapes: ["httpResponse"],
        },
      ],
    };

    // Top-level exactly as a walk step dispatches it: no parent, no chain.
    const trace = await executor.execute(template);

    // Reproduce the walk's read-back loop (index.ts:9376-9387).
    const recovered: Array<{ shape: string; content: unknown }> = [];
    for (const t of trace.tasks ?? []) {
      for (const id of (t as { outputImpulseIds?: string[] }).outputImpulseIds ?? []) {
        const imp = runtime.store.get(id);
        if (!imp) continue;
        const shape = imp.metadata?.shape;
        if (!shape || shape === "activityExecutionSummary") continue;
        if (imp.content === undefined || imp.content === null) continue;
        recovered.push({ shape, content: imp.content });
      }
    }

    const http = recovered.find((r) => r.shape === "httpResponse");
    expect(http).toBeDefined();
    // The precise regression: the walk must get the DATA, not a stub.
    expect(http?.content).toEqual(payload);
  });

  test("seeded inputs are evicted, and retention does not accumulate across runs", async () => {
    const runtime = makeRuntime();
    runtime.resolvers.register(emitWithIntermediate("httpResponse", { ok: true }));
    const executor = new ActivityExecutor(runtime);
    const template: ActivityTemplate = {
      id: "tpl-leak",
      name: "Leak",
      tasks: [
        {
          id: "t1",
          description: "produce httpResponse",
          resolver: "emit-httpResponse",
          outputShapes: ["httpResponse"],
        },
      ],
    };

    await executor.execute(template, {
      impulses: [
        {
          id: "seed-1",
          pointer: { type: "memo" },
          metadata: { shape: "goal" },
          loaded: true,
          content: "g",
        },
      ],
    });

    // The seeded input is gone — that is what the eviction branch is for.
    expect(storeOf(runtime).has("seed-1")).toBe(false);
    const afterFirst = storeOf(runtime).size;
    expect(afterFirst).toBeGreaterThan(0); // outputs retained for read-back

    // The invariant that actually matters: N runs do not leave N runs' worth of
    // impulses behind. Retention is one execution deep, reaped at the next entry.
    for (let i = 0; i < 5; i++) await executor.execute(template);
    expect(storeOf(runtime).size).toBe(afterFirst);
  });
});
