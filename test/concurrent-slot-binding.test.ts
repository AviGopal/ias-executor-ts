/**
 * Concurrent executions must not consume each other's impulses.
 *
 * GoalHost keeps ONE ExecutionRuntime (one ImpulseStore) and ONE ActivityExecutor
 * for every execution it runs, and runs them concurrently. Slot binding used to
 * take the FIRST store-wide match — by `metadata.outputImpulseKey`, then by
 * `metadata.shape` — so two concurrent runs of a template that names its output
 * slots (ribosome-extract: `trace_signature`, `extracted_template`, ...) bound
 * whichever run's impulse was inserted first. Measured live: 3 of 5 concurrent
 * ribosome-extract runs cross-bound and one minted a template synthesised from
 * ANOTHER run's trace, which an unrelated goal then selected and ran.
 *
 * Three binding sites read the store, and each gets a probe here:
 *   - `{{impulse:<slot>}}` config / gate interpolation  (resolveImpulseSlot)
 *   - `inputImpulses: [<slot>]` named-slot lookup
 *   - `inputShapes: [<shape>]`                           (resolveInputs)
 *
 * Every assertion pairs "did not cross-bind" with "COMPLETED and bound its OWN
 * token": a run that simply fails to find its input would also not cross-bind,
 * and that must not read as a pass.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate, ExecutionTrace, Impulse } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Every run's observations, keyed by run token. */
type Seen = Record<string, Record<string, unknown>>;

function makeRig(runCount: number) {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  const seen: Seen = {};
  let produced = 0;
  const note = (token: string, key: string, value: unknown) => {
    (seen[token] ??= {})[key] = value;
  };

  // Emits `shape` carrying this run's token. The FIRST run to produce returns
  // at once; later ones wait a tick, so insertion order is deterministic and
  // every later run's own impulse sits BEHIND an earlier run's in the store.
  const produce: Resolver = {
    id: "produce",
    tier: "deterministic",
    async resolve(ctx) {
      const token = String(ctx.variables["token"]);
      const shape = String(ctx.task.config?.["shape"] ?? "X");
      const order = produced++;
      for (let i = 0; i < order; i++) await tick();
      return [{ id: ctx.random.id("imp"), pointer: { type: "memo" }, metadata: { shape }, loaded: true, content: token }];
    },
  };
  // Holds every run here until ALL runs have produced, so each run's binding
  // happens while every other run's same-shaped impulse is live in the store.
  const barrier: Resolver = {
    id: "barrier",
    tier: "deterministic",
    async resolve() {
      while (produced < runCount) await tick();
      await tick();
      return [];
    },
  };
  // Records what {{impulse:...}} interpolated into config.value.
  const echoConfig: Resolver = {
    id: "echo-config",
    tier: "deterministic",
    async resolve(ctx) {
      note(String(ctx.variables["token"]), `${ctx.task.id}`, ctx.task.config?.["value"]);
      return [];
    },
  };
  // Records the content of every impulse the engine bound as this task's input.
  const echoInputs: Resolver = {
    id: "echo-inputs",
    tier: "deterministic",
    async resolve(ctx) {
      note(String(ctx.variables["token"]), `${ctx.task.id}`, ctx.inputImpulses.map((i) => i.content));
      return [];
    },
  };
  for (const r of [produce, barrier, echoConfig, echoInputs]) runtime.resolvers.register(r);
  return { runtime, executor: new ActivityExecutor(runtime), seen };
}

/** ribosome-extract's binding idioms, in miniature. */
function slotTemplate(id: string, slot: string, shape: string): ActivityTemplate {
  return {
    id,
    name: id,
    tasks: [
      { id: "produce", description: "produce", resolver: "produce", outputShapes: [shape], outputImpulses: [slot], config: { shape } },
      { id: "barrier", description: "wait for every run", resolver: "barrier" },
      { id: "by_slot_placeholder", description: "{{impulse:slot}}", resolver: "echo-config", config: { value: `{{impulse:${slot}}}` } },
      { id: "by_shape_placeholder", description: "{{impulse:shape}}", resolver: "echo-config", config: { value: `{{impulse:${shape}}}` } },
      { id: "by_named_slot", description: "inputImpulses", resolver: "echo-inputs", inputImpulses: [slot] },
      { id: "by_input_shape", description: "inputShapes", resolver: "echo-inputs", inputShapes: [shape] },
    ],
  };
}

function expectBoundOwn(seen: Seen, token: string, trace: ExecutionTrace) {
  // One structural comparison so a failure shows EVERY site's binding at once.
  // inputShapes (cardinality "any") used to union every live match.
  const observed: Record<string, unknown> = { token, status: trace.status, ...(seen[token] ?? {}) };
  expect(observed).toEqual({
    token,
    status: "completed",
    by_slot_placeholder: token,
    by_shape_placeholder: token,
    by_named_slot: [token],
    by_input_shape: [token],
  });
}

describe("concurrent executions never consume each other's impulses", () => {
  test("(a) concurrent runs of the SAME template bind only their own slot outputs", async () => {
    const { executor, seen } = makeRig(3);
    const tpl = slotTemplate("tpl-same", "extracted_template", "extractedTemplate");
    const traces = await Promise.all(
      ["run-A", "run-B", "run-C"].map((token) => executor.execute(tpl, { variables: { token } })),
    );
    // Later runs first: their own impulse sits behind an earlier run's.
    for (const i of [2, 1, 0]) expectBoundOwn(seen, ["run-A", "run-B", "run-C"][i]!, traces[i]!);
  });

  test("(b) DIFFERENT templates needing the same shape bind only their own", async () => {
    const { executor, seen } = makeRig(2);
    const t1 = slotTemplate("tpl-one", "slot_one", "sharedShape");
    const t2 = slotTemplate("tpl-two", "slot_two", "sharedShape");
    const [a, b] = await Promise.all([
      executor.execute(t1, { variables: { token: "one" } }),
      executor.execute(t2, { variables: { token: "two" } }),
    ]);
    expectBoundOwn(seen, "two", b);
    expectBoundOwn(seen, "one", a);
  });

  test("(b') separate executor instances on one runtime are isolated the same way", async () => {
    const { runtime, seen } = makeRig(2);
    const tpl = slotTemplate("tpl-sep", "s", "sepShape");
    const [a, b] = await Promise.all([
      new ActivityExecutor(runtime).execute(tpl, { variables: { token: "p" } }),
      new ActivityExecutor(runtime).execute(tpl, { variables: { token: "q" } }),
    ]);
    expectBoundOwn(seen, "q", b);
    expectBoundOwn(seen, "p", a);
  });
});

describe("legitimate cross-execution inputs still bind (positive controls)", () => {
  test("(c) an impulse DECLARED as a seed binds, even while a concurrent run holds the same shape", async () => {
    const { runtime, executor, seen } = makeRig(1);
    // Run P produces the impulse the consumer will be handed.
    const producerTpl: ActivityTemplate = {
      id: "tpl-producer",
      name: "producer",
      tasks: [{ id: "produce", description: "produce", resolver: "produce", outputShapes: ["handoff"], config: { shape: "handoff" } }],
    };
    const p = await executor.execute(producerTpl, { variables: { token: "declared" } });
    const handed = runtime.store.get(p.outputImpulseIds[0]!) as Impulse;
    expect(handed.content).toBe("declared");

    // A concurrent unrelated run holding a same-shaped impulse in the store.
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    runtime.resolvers.register({
      id: "hold",
      tier: "deterministic",
      async resolve() {
        await hold;
        return [];
      },
    });
    const intruderTpl: ActivityTemplate = {
      id: "tpl-intruder",
      name: "intruder",
      tasks: [
        { id: "produce", description: "produce", resolver: "produce", outputShapes: ["handoff"], config: { shape: "handoff" } },
        { id: "hold", description: "stay live", resolver: "hold" },
      ],
    };
    const intruder = executor.execute(intruderTpl, { variables: { token: "intruder" } });
    for (let i = 0; i < 5; i++) await tick();

    const consumerTpl: ActivityTemplate = {
      id: "tpl-consumer",
      name: "consumer",
      tasks: [
        { id: "by_shape_placeholder", description: "{{impulse:handoff}}", resolver: "echo-config", config: { value: "{{impulse:handoff}}" } },
        { id: "by_input_shape", description: "inputShapes", resolver: "echo-inputs", inputShapes: ["handoff"] },
      ],
    };
    // Same declaration the goal-host walk uses: pass the prior step's impulse
    // as a seed, chained to the producer.
    const c = await executor.execute(consumerTpl, {
      variables: { token: "consumer" },
      impulses: [handed],
      parentExecutionId: p.id,
      compositionChain: [p.id],
    });
    release();
    await intruder;
    expect(c.status).toBe("completed");
    expect(seen["consumer"]?.["by_shape_placeholder"]).toBe("declared");
    expect(seen["consumer"]?.["by_input_shape"]).toEqual(["declared"]);
  });

  test("(c') nested executions: a child binds its ancestor's output, and the parent binds its child's", async () => {
    const { runtime, executor, seen } = makeRig(1);
    // Mirrors the lifecycle-subscriber dispatcher: a child run chained under the
    // parent's execution id, seeded with nothing the parent declared.
    const childTpl: ActivityTemplate = {
      id: "tpl-child",
      name: "child",
      tasks: [
        { id: "child_reads_parent", description: "ancestor output", resolver: "echo-inputs", inputShapes: ["parentOut"] },
        { id: "produce", description: "produce for parent", resolver: "produce", outputShapes: ["childOut"], config: { shape: "childOut" } },
      ],
    };
    runtime.resolvers.register({
      id: "dispatch-child",
      tier: "deterministic",
      async resolve(ctx) {
        await executor.execute(childTpl, {
          variables: { token: "child" },
          parentExecutionId: ctx.executionId,
          compositionChain: [...(ctx.compositionChain ?? []), ctx.executionId],
        });
        return [];
      },
    });
    const parentTpl: ActivityTemplate = {
      id: "tpl-parent",
      name: "parent",
      tasks: [
        { id: "produce", description: "produce", resolver: "produce", outputShapes: ["parentOut"], config: { shape: "parentOut" } },
        { id: "spawn", description: "subscriber-style child", resolver: "dispatch-child" },
        { id: "parent_reads_child", description: "descendant output", resolver: "echo-inputs", inputShapes: ["childOut"] },
      ],
    };
    const t = await executor.execute(parentTpl, { variables: { token: "parent" } });
    expect(t.status).toBe("completed");
    expect(seen["child"]?.["child_reads_parent"]).toEqual(["parent"]);
    expect(seen["parent"]?.["parent_reads_child"]).toEqual(["child"]);
  });
});

describe("eviction under concurrency", () => {
  test("one run's exit leaves running runs' data alone, and retention stays bounded", async () => {
    const storeSize = (rt: ExecutionRuntime) => (rt.store as unknown as { impulses: Map<string, Impulse> }).impulses.size;
    const batch = async () => {
      const { runtime, executor, seen } = makeRig(3);
      const tpl = slotTemplate("tpl-evict", "slot", "evictShape");
      const run = (token: string) => executor.execute(tpl, { variables: { token } });
      const traces = await Promise.all([run("e1"), run("e2"), run("e3")]);
      // Bound their own data to the end, even though the first finisher swept the store.
      traces.forEach((t, i) => expectBoundOwn(seen, `e${i + 1}`, t));
      return { runtime, executor, run };
    };
    const { runtime, executor } = await batch();
    const afterFirst = storeSize(runtime);
    expect(afterFirst).toBeGreaterThan(0); // outputs retained for read-back
    // Repeated concurrent batches on the SAME runtime do not accumulate.
    const tpl = slotTemplate("tpl-evict", "slot", "evictShape");
    for (let i = 0; i < 4; i++) {
      await Promise.all(["x", "y", "z"].map((token) => executor.execute(tpl, { variables: { token } })));
    }
    // Each batch's three top-level runs retain their outputs (one impulse each);
    // the next batch's entries reap them.
    expect(storeSize(runtime)).toBeLessThanOrEqual(afterFirst);
  });
});

describe("impulse ids are not unique across executions", () => {
  // Ids are minted by whoever builds the impulse — resolvers, remote vessels, the
  // goal-host walk pool (whose per-boot counter used to restart at 1) — so the
  // same id can name DIFFERENT impulses in different executions. Scoping by id
  // alone would then still cross-bind: the shared store holds one object per id,
  // and whichever run put it last wins for both.
  test("two concurrent runs SEEDED with the same impulse id each bind their own content", async () => {
    const { executor, seen } = makeRig(0);
    const tpl: ActivityTemplate = {
      id: "tpl-same-seed-id",
      name: "same seed id",
      tasks: [
        { id: "barrier", description: "both runs seeded", resolver: "barrier" },
        { id: "by_shape_placeholder", description: "{{impulse:shape}}", resolver: "echo-config", config: { value: "{{impulse:seedShape}}" } },
        { id: "by_input_shape", description: "inputShapes", resolver: "echo-inputs", inputShapes: ["seedShape"] },
      ],
    };
    const seed = (content: string): Impulse => ({ id: "walk-pool-1", pointer: { type: "memo" }, metadata: { shape: "seedShape" }, loaded: true, content });
    const [a, b] = await Promise.all([
      executor.execute(tpl, { variables: { token: "A" }, impulses: [seed("A")] }),
      executor.execute(tpl, { variables: { token: "B" }, impulses: [seed("B")] }),
    ]);
    for (const [token, t] of [["A", a], ["B", b]] as const) {
      expect({ token, status: t.status, ...(seen[token] ?? {}) } as Record<string, unknown>).toEqual({
        token,
        status: "completed",
        by_shape_placeholder: token,
        by_input_shape: [token],
      });
    }
  });

  test("two concurrent runs whose resolver emits the same output id each bind their own", async () => {
    const { runtime, executor, seen } = makeRig(2);
    let emitted = 0;
    runtime.resolvers.register({
      id: "produce-fixed-id",
      tier: "deterministic",
      async resolve(ctx) {
        const order = emitted++;
        for (let i = 0; i < order; i++) await tick();
        return [{ id: "fixed-output-id", pointer: { type: "memo" }, metadata: { shape: "fixedShape" }, loaded: true, content: String(ctx.variables["token"]) }];
      },
    });
    const tpl: ActivityTemplate = {
      id: "tpl-fixed-id",
      name: "fixed output id",
      tasks: [
        { id: "produce", description: "p", resolver: "produce-fixed-id", outputShapes: ["fixedShape"], outputImpulses: ["fixed_slot"] },
        { id: "wait", description: "both produced", resolver: "barrier-fixed" },
        { id: "by_slot_placeholder", description: "slot", resolver: "echo-config", config: { value: "{{impulse:fixed_slot}}" } },
        { id: "by_named_slot", description: "inputImpulses", resolver: "echo-inputs", inputImpulses: ["fixed_slot"] },
        { id: "by_input_shape", description: "inputShapes", resolver: "echo-inputs", inputShapes: ["fixedShape"] },
      ],
    };
    runtime.resolvers.register({
      id: "barrier-fixed",
      tier: "deterministic",
      async resolve() {
        while (emitted < 2) await tick();
        await tick();
        return [];
      },
    });
    const [a, b] = await Promise.all([
      executor.execute(tpl, { variables: { token: "A" } }),
      executor.execute(tpl, { variables: { token: "B" } }),
    ]);
    for (const [token, t] of [["A", a], ["B", b]] as const) {
      expect({ token, status: t.status, ...(seen[token] ?? {}) } as Record<string, unknown>).toEqual({
        token,
        status: "completed",
        by_slot_placeholder: token,
        by_named_slot: [token],
        by_input_shape: [token],
      });
      // The caller's read-back must hand each run ITS output, not the last writer's.
      const outId = t.tasks.find((x) => x.taskId === "produce")!.outputImpulseIds[0]!;
      expect(runtime.store.get(outId)?.content).toBe(token);
    }
  });
});

describe("ledger hygiene", () => {
  test("a throw before the task loop does not leave the run marked live (its seeds stay evictable)", async () => {
    const { runtime, executor } = makeRig(0);
    let fail = true;
    const sink = { emit(e: { type: string }) { if (fail && e.type === "activity.started") throw new Error("sink down"); } };
    const rt = new ExecutionRuntime({ clock: new SteppingClock(1, 1), random: new SequentialRandom(), eventSink: sink as never });
    for (const id of ["echo-inputs"]) rt.resolvers.register(runtime.resolvers.get(id)!);
    const ex = new ActivityExecutor(rt);
    const seed: Impulse = { id: "orphan-seed", pointer: { type: "memo" }, metadata: { shape: "s" }, loaded: true, content: "x" };
    const tpl: ActivityTemplate = { id: "t", name: "t", tasks: [{ id: "a", description: "a", resolver: "echo-inputs", inputShapes: ["s"] }] };
    await expect(ex.execute(tpl, { impulses: [seed] })).rejects.toThrow("sink down");
    fail = false;
    // The next top-level run's exit sweeps everything no live run owns.
    await ex.execute({ id: "u", name: "u", tasks: [] });
    expect(rt.store.get("orphan-seed")).toBeUndefined();
    void executor;
  });
});
