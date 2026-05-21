/**
 * Repro test for the slot-binding subscriber-seeding hang (task 40).
 *
 * Hypothesis: running slot-binding template directly with a seeded
 * lifecycle:task:preBinding impulse hangs the executor for some reason
 * we haven't isolated. Subscriber dispatch isn't involved here — this is
 * a minimal repro of the executor + ported resolvers + slot-binding tasks.
 *
 * Loop discipline: DEBUG iteration after the failed seeding attempt.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { makeImpulsePreparationResolver } from "../src/resolvers/impulse-preparation";
import { makeIterationResolver } from "../src/resolvers/iteration";
import { makeImpulsePoolSelectionResolver } from "../src/resolvers/impulse-pool-selection";
import { makeProducerSelectionResolver } from "../src/resolvers/producer-selection";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import slotBindingJson from "../src/templates/lifecycle/slot-binding.json" with { type: "json" };
import type { ActivityTemplate, Impulse } from "../src/ontology";

const SLOT_BINDING = slotBindingJson as unknown as ActivityTemplate;

describe("slot-binding template direct execution (no subscriber dispatch)", () => {
  test("with seeded lifecycle:task:preBinding impulse, slot-binding terminates (no hang)", async () => {
    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(1_000_000, 5),
      random: new SequentialRandom(),
      eventSink: new EventSinkSpy(),
    });
    runtime.resolvers.register(makeImpulsePreparationResolver());
    runtime.resolvers.register(makeIterationResolver((id) => runtime.resolvers.get(id)));
    runtime.resolvers.register(makeImpulsePoolSelectionResolver());
    runtime.resolvers.register(makeProducerSelectionResolver());
    const executor = new ActivityExecutor(runtime);

    // Seed the impulse the same way the dispatcher would.
    const seed: Impulse = {
      id: "seed_test",
      pointer: { type: "memo" },
      metadata: { shape: "lifecycle:task:preBinding", source: "test-seed" },
      loaded: true,
      content: {
        taskId: "test-task",
        templateId: "test-template",
        executionId: "exec_test_parent",
        inputShapes: ["goal"],
        missingShapes: ["goal"],
        variables: { goal: "hello" },
        parentDepth: 0,
      },
    };

    // Run slot-binding template directly with the seed. If this hangs, the
    // hang is in the executor + slot-binding's task chain, NOT in subscriber
    // dispatch.
    const trace = await Promise.race([
      executor.execute(SLOT_BINDING, {
        impulses: [seed],
        parentExecutionId: "exec_test_parent",
        compositionChain: ["exec_test_parent"],
        variables: { goal: "hello" },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("HANG: slot-binding direct execution exceeded 5s")), 5000),
      ),
    ]);

    // Whatever the outcome, we want to see it documented.
    console.log(`[repro] slot-binding direct execution: status=${trace.status}`);
    console.log(`[repro]   tasks executed: ${trace.tasks.length}`);
    for (const t of trace.tasks) {
      console.log(`[repro]     ${t.taskId} (${t.resolverId}): success=${t.success}`);
    }
    if (trace.failureMode) {
      console.log(`[repro] failureMode: ${JSON.stringify(trace.failureMode)}`);
    }

    // We don't assert success — we assert NO HANG.
    expect(trace).toBeDefined();
  }, 8000);
});
