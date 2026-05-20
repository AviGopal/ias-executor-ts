/**
 * Lifecycle Subscriber demo — smoke test for the §1 port from minibob.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §E.
 *
 * Wires a `LifecycleSubscriberVessel` into an `ExecutionRuntime`'s event
 * sink, registers a single subscriber that fires on `activity.completed`,
 * runs a one-task activity through `ActivityExecutor`, and verifies the
 * dispatcher was called.
 *
 * This example uses a recording dispatcher rather than running real
 * templates — the goal here is to demonstrate the wiring pattern, not the
 * full slot-binding / validator-dispatch / audit-test-report meta-activity
 * stack (those land in tasks §1.3+ once the shared catalogue is ported).
 */

import { ActivityExecutor } from "../engine";
import { LifecycleSubscriberVessel } from "../lifecycle-subscriber";
import { ExecutionRuntime } from "../runtime";
import type { ActivityTemplate, LifecycleEvent } from "../ontology";
import type { Resolver } from "../resolvers";

interface DispatchRecord {
  templateId: string;
  eventType: string;
}

export async function runLifecycleSubscriberDemo(): Promise<{
  dispatchedSubscribers: DispatchRecord[];
  forwardedEvents: LifecycleEvent[];
}> {
  const dispatchedSubscribers: DispatchRecord[] = [];
  const forwardedEvents: LifecycleEvent[] = [];

  // Subscriber template: fires on every activity.completed event.
  const ribosomeStub: ActivityTemplate = {
    id: "ribosome-extract-stub",
    name: "Ribosome Extract (stub)",
    tasks: [],
    subscription: { shape: "activity.completed" },
  };

  const subscriber = new LifecycleSubscriberVessel({
    dispatcher: (template, event) => {
      dispatchedSubscribers.push({
        templateId: template.id,
        eventType: event.type,
      });
    },
    downstreamSink: {
      emit(event) {
        forwardedEvents.push(event);
      },
    },
  });
  subscriber.register(ribosomeStub);

  const runtime = new ExecutionRuntime({
    eventSink: subscriber,
    attachedVessels: [
      {
        id: "lifecycle-subscriber",
        kind: "lifecycle-subscriber",
        resolverIds: [],
      },
    ],
  });

  // Trivial resolver that produces one impulse.
  const emitResolver: Resolver = {
    id: "emit-noop",
    tier: "deterministic",
    async resolve(context) {
      return [
        {
          id: context.random.id("imp"),
          pointer: { type: "memo" },
          metadata: { shape: "noop" },
          loaded: true,
          content: "ok",
        },
      ];
    },
  };
  runtime.resolvers.register(emitResolver);

  const template: ActivityTemplate = {
    id: "demo-activity",
    name: "Demo Activity",
    outputShapes: ["noop"],
    tasks: [
      {
        id: "t1",
        description: "Emit a noop impulse",
        resolver: "emit-noop",
        outputShapes: ["noop"],
      },
    ],
  };

  const executor = new ActivityExecutor(runtime);
  await executor.execute(template);

  return { dispatchedSubscribers, forwardedEvents };
}

// Allow `bun run src/examples/lifecycle-subscriber-demo.ts`.
if (import.meta.main) {
  runLifecycleSubscriberDemo().then((result) => {
    // biome-ignore lint/suspicious/noConsole: demo output
    console.log(
      `Dispatched subscribers: ${JSON.stringify(result.dispatchedSubscribers, null, 2)}`,
    );
    // biome-ignore lint/suspicious/noConsole: demo output
    console.log(
      `Forwarded events: ${result.forwardedEvents.map((e) => e.type).join(", ")}`,
    );
  });
}
