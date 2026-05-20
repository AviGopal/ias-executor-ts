/**
 * lifecycle:* event emission from ActivityExecutor.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §E.
 *
 * Confirms that engine.ts emits `lifecycle:execution:succeeded`,
 * `lifecycle:task:completed`, and `lifecycle:task:preBinding` alongside the
 * simpler `activity.completed`/`task.completed`/`task.started` events so
 * subscriber meta-activities ported from minibob fire end-to-end.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { LifecycleSubscriberVessel } from "../src/lifecycle-subscriber";
import type { ActivityTemplate } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

function emitNoop(shape: string): Resolver {
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
          content: "ok",
        },
      ];
    },
  };
}

function makeRuntime(sink = new EventSinkSpy()): {
  runtime: ExecutionRuntime;
  sink: EventSinkSpy;
} {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: sink,
  });
  return { runtime, sink };
}

describe("ActivityExecutor lifecycle:* emission", () => {
  test("emits lifecycle:execution:succeeded after a top-level activity", async () => {
    const { runtime, sink } = makeRuntime();
    runtime.resolvers.register(emitNoop("test_report"));
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "tpl-succ",
      name: "Success",
      tasks: [
        {
          id: "t1",
          description: "produce test_report",
          resolver: "emit-test_report",
          outputShapes: ["test_report"],
        },
      ],
    };

    await executor.execute(template);

    const succ = sink.ofType("lifecycle:execution:succeeded");
    expect(succ).toHaveLength(1);
    const data = succ[0]?.data as Record<string, unknown>;
    expect(data.templateId).toBe("tpl-succ");
    expect(data.status).toBe("completed");
    expect(data.outputShapes).toEqual(["test_report"]);
    expect(data.taskCount).toBe(1);
    expect(data.parentDepth).toBe(0);
    expect(data.compositionChain).toEqual([]);
    expect(typeof data.durationMs).toBe("number");
  });

  test("does NOT emit lifecycle:execution:succeeded on failure", async () => {
    const { runtime, sink } = makeRuntime();
    // Resolver throws → activity fails.
    runtime.resolvers.register({
      id: "boom",
      tier: "deterministic",
      async resolve() {
        throw new Error("boom");
      },
    });
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute({
      id: "tpl-fail",
      name: "Fail",
      tasks: [{ id: "t1", description: "boom", resolver: "boom" }],
    });

    expect(trace.status).toBe("failed");
    expect(sink.ofType("lifecycle:execution:succeeded")).toHaveLength(0);
    // The simpler `activity.failed` event remains.
    expect(sink.ofType("activity.failed")).toHaveLength(1);
  });

  test("emits lifecycle:task:completed with input/output shapes per task", async () => {
    const { runtime, sink } = makeRuntime();
    runtime.resolvers.register(emitNoop("alpha"));
    runtime.resolvers.register(emitNoop("beta"));
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "tpl-tasks",
      name: "Two tasks",
      tasks: [
        {
          id: "first",
          description: "produce alpha",
          resolver: "emit-alpha",
          outputShapes: ["alpha"],
        },
        {
          id: "second",
          description: "produce beta consuming alpha",
          resolver: "emit-beta",
          inputShapes: ["alpha"],
          outputShapes: ["beta"],
        },
      ],
    };

    await executor.execute(template);

    const completed = sink.ofType("lifecycle:task:completed");
    expect(completed).toHaveLength(2);
    const first = completed[0]?.data as Record<string, unknown>;
    expect(first.taskId).toBe("first");
    expect(first.success).toBe(true);
    expect(first.inputShapes).toEqual([]);
    expect(first.outputShapes).toEqual(["alpha"]);

    const second = completed[1]?.data as Record<string, unknown>;
    expect(second.taskId).toBe("second");
    expect(second.inputShapes).toEqual(["alpha"]);
    expect(second.outputShapes).toEqual(["beta"]);
    expect(Array.isArray(second.inputImpulseIds)).toBe(true);
    expect((second.inputImpulseIds as unknown[]).length).toBe(1);
  });

  test("emits lifecycle:task:preBinding before task.started when inputShapes declared", async () => {
    const { runtime, sink } = makeRuntime();
    runtime.resolvers.register(emitNoop("alpha"));
    runtime.resolvers.register(emitNoop("beta"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute({
      id: "tpl-prebind",
      name: "PreBinding",
      tasks: [
        {
          id: "t1",
          description: "produce alpha",
          resolver: "emit-alpha",
          outputShapes: ["alpha"],
        },
        {
          id: "t2",
          description: "consume alpha",
          resolver: "emit-beta",
          inputShapes: ["alpha"],
          outputShapes: ["beta"],
        },
      ],
    });

    const preBind = sink.ofType("lifecycle:task:preBinding");
    // Only `t2` declares inputShapes → exactly one preBinding event.
    expect(preBind).toHaveLength(1);
    const data = preBind[0]?.data as Record<string, unknown>;
    expect(data.taskId).toBe("t2");
    expect(data.inputShapes).toEqual(["alpha"]);
    expect(data.missingShapes).toEqual([]);
    expect((data.currentImpulseShapes as unknown[]).includes("alpha")).toBe(true);

    // Ordering: preBinding emitted before its task's task.started.
    // Sequence for two-task run with second declaring inputShapes:
    //   activity.started, task.started(t1), task.completed(t1),
    //   lifecycle:task:completed(t1), lifecycle:task:preBinding(t2),
    //   task.started(t2), task.completed(t2), lifecycle:task:completed(t2),
    //   activity.completed, lifecycle:execution:succeeded
    const sequence = sink.types();
    const preIdx = sequence.lastIndexOf("lifecycle:task:preBinding");
    const startIndices = sequence
      .map((t, i) => (t === "task.started" ? i : -1))
      .filter((i) => i >= 0);
    const startAfterPre = startIndices.find((i) => i > preIdx);
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(startAfterPre).toBeDefined();
    expect(startAfterPre).toBeGreaterThan(preIdx);
  });

  test("does NOT emit lifecycle:task:preBinding when task has no inputShapes", async () => {
    const { runtime, sink } = makeRuntime();
    runtime.resolvers.register(emitNoop("alpha"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute({
      id: "tpl-noinputs",
      name: "No inputs",
      tasks: [
        {
          id: "t1",
          description: "produce alpha",
          resolver: "emit-alpha",
          outputShapes: ["alpha"],
        },
      ],
    });

    expect(sink.ofType("lifecycle:task:preBinding")).toHaveLength(0);
  });

  test("preserves compositionChain in lifecycle:execution:succeeded payload", async () => {
    const { runtime, sink } = makeRuntime();
    runtime.resolvers.register(emitNoop("noop"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute(
      {
        id: "tpl-chain",
        name: "Chain",
        tasks: [
          {
            id: "t1",
            description: "produce noop",
            resolver: "emit-noop",
            outputShapes: ["noop"],
          },
        ],
      },
      {
        compositionChain: ["root-exec-1", "mid-exec-2"],
      },
    );

    const succ = sink.ofType("lifecycle:execution:succeeded");
    const data = succ[0]?.data as Record<string, unknown>;
    expect(data.compositionChain).toEqual(["root-exec-1", "mid-exec-2"]);
    expect(data.parentDepth).toBe(2);
  });

  test("LifecycleSubscriberVessel fires on lifecycle:execution:succeeded with output_shapes_contains filter", async () => {
    const dispatched: Array<{ id: string; payload: Record<string, unknown> }> =
      [];
    const subscriber = new LifecycleSubscriberVessel({
      dispatcher: (template, _event, ctx) => {
        dispatched.push({ id: template.id, payload: ctx.payload });
      },
    });
    const auditTemplate: ActivityTemplate = {
      id: "audit-test-report-stub",
      name: "Audit stub",
      tasks: [],
      subscription: {
        shape: "lifecycle:execution:succeeded",
        filter: { output_shapes_contains: "test_report" },
      },
    };
    subscriber.register(auditTemplate);

    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(2_000_000, 5),
      random: new SequentialRandom(),
      eventSink: subscriber,
    });
    runtime.resolvers.register(emitNoop("test_report"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute({
      id: "tpl-produces-report",
      name: "Produces test_report",
      tasks: [
        {
          id: "t1",
          description: "produce test_report",
          resolver: "emit-test_report",
          outputShapes: ["test_report"],
        },
      ],
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.id).toBe("audit-test-report-stub");
    expect(
      (dispatched[0]?.payload.outputShapes as string[]).includes("test_report"),
    ).toBe(true);
    // Self-suppression guard: the subscriber template's own id ≠ emitting
    // template id, so it must fire (sanity check the guard didn't false-positive).
    expect(dispatched[0]?.payload.templateId).toBe("tpl-produces-report");

  });
});
