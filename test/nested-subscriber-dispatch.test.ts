/**
 * Nested-execution dispatch via LifecycleSubscriberVessel.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §E.2,
 * specs/goal-host/spec.md R3.
 *
 * Proves the load-bearing property for GoalHost: a subscriber's dispatcher
 * can wrap `executor.execute(template, options)` so subscriber templates run
 * as nested executions in the SAME runtime, with composition_chain
 * correctly carrying the parent's executionId.
 *
 * This is the slot-binding → forge escalation pattern at the
 * substrate level: a parent activity emits a triggering impulse;
 * a child subscriber template fires and runs as a nested execution; its
 * trace's compositionChain[] contains the parent's executionId. The
 * mechanics here are exactly what the production GoalHost will plumb.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { LifecycleSubscriberVessel } from "../src/lifecycle-subscriber";
import type { ActivityTemplate, ExecutionTrace, LifecycleEvent } from "../src/ontology";
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

describe("LifecycleSubscriberVessel + nested executor.execute", () => {
  test("subscriber's dispatcher can run a child template via the same executor; child carries parent's executionId in compositionChain", async () => {
    const downstreamEvents: LifecycleEvent[] = [];
    const childTraces: ExecutionTrace[] = [];

    // The runtime + executor are created first; the dispatcher reads the
    // executor by closure (intentional — the host owns the wiring; the
    // vessel is dispatch-strategy-agnostic per spec §E.2).
    let executor!: ActivityExecutor;

    const subscriber = new LifecycleSubscriberVessel({
      dispatcher: async (template, event) => {
        // The lifecycle:execution:succeeded payload carries the parent's
        // executionId and compositionChain. The dispatcher composes a new
        // chain that includes the parent and runs the child template.
        const parentExecutionId = (event.data as { executionId?: string })?.executionId;
        const parentChain = ((event.data as { compositionChain?: string[] })?.compositionChain) ?? [];
        const chain = parentExecutionId ? [...parentChain, parentExecutionId] : parentChain;
        const trace = await executor.execute(template, {
          parentExecutionId,
          compositionChain: chain,
        });
        childTraces.push(trace);
      },
      downstreamSink: { emit(e) { downstreamEvents.push(e); } },
    });

    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(1_000_000, 5),
      random: new SequentialRandom(),
      eventSink: subscriber,
    });
    runtime.resolvers.register(emitNoop("trigger_shape"));
    runtime.resolvers.register(emitNoop("child_output"));
    executor = new ActivityExecutor(runtime);

    // Child template: subscribes on lifecycle:execution:succeeded filtered by
    // output_shapes_contains:"trigger_shape". Single task emits child_output.
    const child: ActivityTemplate = {
      id: "child-on-trigger",
      name: "Child On Trigger",
      tasks: [
        {
          id: "emit-child",
          resolver: "emit-child_output",
          outputShapes: ["child_output"],
        } as ActivityTemplate["tasks"][number],
      ],
      subscription: {
        shape: "lifecycle:execution:succeeded",
        filter: { output_shapes_contains: "trigger_shape" },
      },
    };
    subscriber.register(child);

    // Parent template: emits trigger_shape — this drives the subscriber fire.
    const parent: ActivityTemplate = {
      id: "parent-emits-trigger",
      name: "Parent",
      tasks: [
        {
          id: "emit-parent",
          resolver: "emit-trigger_shape",
          outputShapes: ["trigger_shape"],
        } as ActivityTemplate["tasks"][number],
      ],
    };

    const parentTrace = await executor.execute(parent);

    // The dispatcher fires *during* parent's lifecycle:execution:succeeded
    // emission (sequential await in subscriber.emit). By the time
    // parent.execute() resolves, the child has fully run.
    expect(parentTrace.status).toBe("completed");
    expect(childTraces.length).toBe(1);

    const childTrace = childTraces[0]!;
    expect(childTrace.status).toBe("completed");
    expect(childTrace.id).not.toBe(parentTrace.id);

    // Load-bearing assertion: the child's compositionChain contains the
    // parent's executionId.
    expect(childTrace.compositionChain).toEqual([parentTrace.id]);
    expect(childTrace.parentExecutionId).toBe(parentTrace.id);

    // The child's own lifecycle:execution:succeeded was forwarded to the
    // downstream sink alongside the parent's.
    const succEvents = downstreamEvents.filter((e) => e.type === "lifecycle:execution:succeeded");
    expect(succEvents.length).toBe(2);
    const ids = succEvents.map((e) => (e.data as { executionId?: string }).executionId);
    expect(ids).toContain(parentTrace.id);
    expect(ids).toContain(childTrace.id);
  });

  test("child output_shape mismatch: parent emits a non-matching shape; subscriber does not fire", async () => {
    let executor!: ActivityExecutor;
    const calls: string[] = [];

    const subscriber = new LifecycleSubscriberVessel({
      dispatcher: async (template, event) => {
        const parentExecutionId = (event.data as { executionId?: string })?.executionId;
        await executor.execute(template, {
          parentExecutionId,
          compositionChain: parentExecutionId ? [parentExecutionId] : [],
        });
        calls.push(template.id);
      },
    });

    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(1_000_000, 5),
      random: new SequentialRandom(),
      eventSink: subscriber,
    });
    runtime.resolvers.register(emitNoop("other_shape"));
    runtime.resolvers.register(emitNoop("child_output"));
    executor = new ActivityExecutor(runtime);

    const child: ActivityTemplate = {
      id: "child",
      name: "Child",
      tasks: [{ id: "t", resolver: "emit-child_output", outputShapes: ["child_output"] } as ActivityTemplate["tasks"][number]],
      subscription: { shape: "lifecycle:execution:succeeded", filter: { output_shapes_contains: "trigger_shape" } },
    };
    subscriber.register(child);

    const parent: ActivityTemplate = {
      id: "parent",
      name: "Parent",
      tasks: [{ id: "t", resolver: "emit-other_shape", outputShapes: ["other_shape"] } as ActivityTemplate["tasks"][number]],
    };

    const trace = await executor.execute(parent);
    expect(trace.status).toBe("completed");
    expect(calls.length).toBe(0); // subscriber filter did not match
  });
});
