/**
 * Repro: subscriber dispatch with seeded lifecycle-payload impulse.
 *
 * Task 40 hang: when GoalHost's dispatcher seeds the lifecycle event
 * payload as an impulse (so subscriber templates with
 * inputShapes:["lifecycle:task:preBinding"] can run), `bun test`
 * hangs. Direct slot-binding execution doesn't hang. So the issue
 * is in the subscriber dispatch + seeded-impulse interaction.
 *
 * This test reproduces the dispatch chain in isolation with minimal
 * scaffolding so we can observe what loops.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { LifecycleSubscriberVessel } from "../src/lifecycle-subscriber";
import { makeImpulsePreparationResolver } from "../src/resolvers/impulse-preparation";
import { makeIterationResolver } from "../src/resolvers/iteration";
import { makeImpulsePoolSelectionResolver } from "../src/resolvers/impulse-pool-selection";
import { makeProducerSelectionResolver } from "../src/resolvers/producer-selection";
import { SequentialRandom, SteppingClock } from "./fakes";
import type { ActivityTemplate, Impulse, LifecycleEvent } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import slotBindingJson from "../src/templates/lifecycle/slot-binding.json" with { type: "json" };
import validatorDispatchJson from "../src/templates/lifecycle/validator-dispatch.json" with { type: "json" };

const SLOT_BINDING = slotBindingJson as unknown as ActivityTemplate;
const VALIDATOR_DISPATCH = validatorDispatchJson as unknown as ActivityTemplate;

describe("seeded subscriber dispatch repro (task 40)", () => {
  test("dispatching slot-binding+validator-dispatch with seeded impulse — does it hang?", async () => {
    // Track every dispatch + event emission. If it loops, the arrays grow.
    const dispatchLog: string[] = [];
    const events: LifecycleEvent[] = [];

    // Forward declaration; the dispatcher closure captures `executor`.
    let executor!: ActivityExecutor;

    const subscriber = new LifecycleSubscriberVessel({
      dispatcher: async (template, event) => {
        dispatchLog.push(
          `${template.id} ← ${event.type} (parentDepth=${(event.data as { parentDepth?: number })?.parentDepth ?? "?"})`,
        );
        if (dispatchLog.length > 50) {
          throw new Error(`RUNAWAY: >50 dispatches — log: ${dispatchLog.slice(-5).join(" | ")}`);
        }
        const data = event.data as { executionId?: string; compositionChain?: string[] };
        const parentChain = data.compositionChain ?? [];
        const chain = data.executionId ? [...parentChain, data.executionId] : parentChain;
        // Seed the lifecycle event as an impulse (matches GoalHost's would-be fix).
        const lifecycleImpulse: Impulse = {
          id: `seed_${event.type}_${Math.random().toString(36).slice(2, 8)}`,
          pointer: { type: "memo" },
          metadata: { shape: event.type, source: "lifecycle-event" },
          loaded: true,
          content: event.data,
        };
        await executor.execute(template, {
          parentExecutionId: data.executionId,
          compositionChain: chain,
          impulses: [lifecycleImpulse],
        });
      },
      downstreamSink: { emit(e) { events.push(e); } },
      logger: { warn: (m) => dispatchLog.push(`WARN: ${m}`), debug: () => {} },
    });
    subscriber.register(SLOT_BINDING);
    subscriber.register(VALIDATOR_DISPATCH);

    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(1_000_000, 5),
      random: new SequentialRandom(),
      eventSink: subscriber,
    });
    runtime.resolvers.register(makeImpulsePreparationResolver());
    runtime.resolvers.register(makeIterationResolver((id) => runtime.resolvers.get(id)));
    runtime.resolvers.register(makeImpulsePoolSelectionResolver());
    runtime.resolvers.register(makeProducerSelectionResolver());
    // Add stub resolvers for the slot-binding tasks that need them, so they
    // fail-fast rather than throwing "not registered" before any work.
    const stub = (id: string): Resolver => ({
      id,
      tier: "deterministic",
      async resolve(ctx) {
        return [{
          id: ctx.random.id(`stub:${id}`),
          pointer: { type: "memo" },
          metadata: { shape: `${id}_result` },
          loaded: true,
          content: { stub: true, resolver: id },
        }];
      },
    });
    runtime.resolvers.register(stub("impulse-resolve"));
    runtime.resolvers.register(stub("activity"));
    runtime.resolvers.register(stub("llm"));
    executor = new ActivityExecutor(runtime);

    // Trigger the chain: a tiny parent template whose 1 task emits a goal
    // shape. Slot-binding subscribes preBinding; validator-dispatch
    // subscribes completed.
    const PARENT: ActivityTemplate = {
      id: "parent",
      name: "Parent",
      tasks: [
        {
          id: "p1",
          description: "parent task",
          resolver: "impulse_preparation",
          inputShapes: ["goal"],
          outputShapes: ["goal"],
          config: { operation: "synthesise_from_variables", missingShapes: ["goal"] },
        } as ActivityTemplate["tasks"][number],
      ],
    };

    const trace = await Promise.race([
      executor.execute(PARENT, { variables: { goal: "test" } }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`HANG: parent execution exceeded 5s. dispatchLog length=${dispatchLog.length}. last 5: ${dispatchLog.slice(-5).join(" | ")}`)), 5000),
      ),
    ]);

    console.log(`[repro] parent trace status=${trace.status}`);
    console.log(`[repro] dispatch count=${dispatchLog.length}, event count=${events.length}`);
    console.log("[repro] dispatch log:");
    for (const entry of dispatchLog) console.log(`  ${entry}`);
    console.log("[repro] event type counts:");
    const byType = new Map<string, number>();
    for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    for (const [type, count] of byType.entries()) console.log(`  ${type}: ${count}`);

    expect(trace).toBeDefined();
    expect(dispatchLog.length).toBeLessThan(50);
  }, 8000);
});
