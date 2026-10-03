/**
 * The verification half of the cross-binding fix: a run that consumed another run's
 * impulse must not be graded reached, and must not be extracted into a template.
 *
 * Scoped binding (concurrent-slot-binding.test.ts) stops the engine from handing a task a
 * foreign impulse. This gate is the independent check on the result: every task records
 * the provenance of what it consumed, and `foreignConsumption` re-derives "was this ours?"
 * from the trace's own facts (its id, its composition chain, the ids it was seeded with)
 * rather than trusting the recorded label — the reach verdict and the reach->mint path in
 * goal-host call it before grading or extracting.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { foreignConsumption } from "../src/impulse-provenance";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate, ExecutionTrace } from "../src/ontology";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

function rig() {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  runtime.resolvers.register({
    id: "produce",
    tier: "deterministic",
    async resolve(ctx) {
      return [{ id: ctx.random.id("imp"), pointer: { type: "memo" }, metadata: { shape: "draft" }, loaded: true, content: String(ctx.variables["token"]) }];
    },
  });
  runtime.resolvers.register({ id: "consume", tier: "deterministic", async resolve() { return []; } });
  return { runtime, executor: new ActivityExecutor(runtime) };
}

const produceThenConsume: ActivityTemplate = {
  id: "tpl-pc",
  name: "produce then consume",
  tasks: [
    { id: "produce", description: "p", resolver: "produce", outputShapes: ["draft"], outputImpulses: ["draft_slot"] },
    { id: "consume", description: "c", resolver: "consume", inputShapes: ["draft"], config: { v: "{{impulse:draft_slot}}" } },
  ],
};

/** What the pre-fix engine did: hand B's consume task A's impulse. */
function crossBind(b: ExecutionTrace, a: ExecutionTrace, label: "own" | "foreign"): ExecutionTrace {
  const aDraft = a.tasks.find((t) => t.taskId === "produce")!.outputImpulseIds[0]!;
  return {
    ...b,
    tasks: b.tasks.map((t) =>
      t.taskId !== "consume"
        ? t
        : {
            ...t,
            inputImpulseIds: [aDraft],
            consumedProvenance: [{ impulseId: aDraft, producerExecutionId: a.id, producerChain: [], origin: label }],
          },
    ),
  };
}

describe("(e) a run that consumed a foreign impulse is not reached and not extracted", () => {
  test("a real run records provenance for every consumed impulse, and grades clean", async () => {
    const { executor } = rig();
    const t = await executor.execute(produceThenConsume, { variables: { token: "a" } });
    expect(t.status).toBe("completed");
    const consume = t.tasks.find((x) => x.taskId === "consume")!;
    expect(consume.consumedProvenance).toEqual([
      expect.objectContaining({ producerExecutionId: t.id, origin: "own" }),
    ]);
    expect(foreignConsumption(t)).toEqual({ status: "clean", foreign: [] });
  });

  test("concurrent real runs both grade clean", async () => {
    const { executor } = rig();
    const [a, b] = await Promise.all([
      executor.execute(produceThenConsume, { variables: { token: "a" } }),
      executor.execute(produceThenConsume, { variables: { token: "b" } }),
    ]);
    expect(foreignConsumption(a).status).toBe("clean");
    expect(foreignConsumption(b).status).toBe("clean");
  });

  test("a cross-bound consumption is FOREIGN — even when its recorded label claims 'own'", async () => {
    const { executor } = rig();
    const a = await executor.execute(produceThenConsume, { variables: { token: "a" } });
    const b = await executor.execute(produceThenConsume, { variables: { token: "b" } });
    for (const label of ["foreign", "own"] as const) {
      const v = foreignConsumption(crossBind(b, a, label));
      expect(v.status).toBe("foreign");
      expect(v.foreign).toEqual([expect.objectContaining({ taskId: "consume", producerExecutionId: a.id })]);
    }
  });

  test("positive control: another run's impulse DECLARED as a seed is clean", async () => {
    const { runtime, executor } = rig();
    const a = await executor.execute(produceThenConsume, { variables: { token: "a" } });
    const handed = runtime.store.get(a.outputImpulseIds[0]!)!;
    const consumeOnly: ActivityTemplate = {
      id: "tpl-c",
      name: "consume",
      tasks: [{ id: "consume", description: "c", resolver: "consume", inputShapes: ["draft"] }],
    };
    const b = await executor.execute(consumeOnly, { impulses: [handed] });
    const consume = b.tasks[0]!;
    expect(consume.consumedProvenance).toEqual([
      expect.objectContaining({ impulseId: handed.id, producerExecutionId: a.id, origin: "declared" }),
    ]);
    expect(foreignConsumption(b)).toEqual({ status: "clean", foreign: [] });
  });

  test("a trace with no provenance is UNKNOWN, never clean", () => {
    const legacy: ExecutionTrace = {
      id: "exec_legacy",
      templateId: "t",
      status: "completed",
      inputImpulseIds: [],
      outputImpulseIds: [],
      tasks: [{ taskId: "x", description: "", resolverId: "r", inputImpulseIds: ["i"], outputImpulseIds: [], success: true }],
    };
    expect(foreignConsumption(legacy).status).toBe("unknown");
  });
});
