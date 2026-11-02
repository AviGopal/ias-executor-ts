import { describe, it, expect } from "bun:test";
import * as mod from "../../src/hosts/goal-host";

// This test targets the live path around the dispatcher closure in src/hosts/goal-host.ts:
//   const dispatcher: SubscriberDispatcher = async (template, event) => { ... }
// We construct a GoalHost with a fake activity-api adapter so we can observe whether
// lifecycle-subscriber-dispatched runs POST execution traces via the activity-api trace sink.
//
// The defect: counted (meta) lifecycle subscribers (slot-binding, validator-dispatch, ...)
// are journaled-only via a SubscriberRunCounter instead of being traced via the same
// executor/trace-sink used for goal work. The correct behavior is that EVERY subscriber
// run is posted as a full execution trace (so it touches context_thompson_scores on
// activity-api). The first test asserts the correct behavior and is expected to fail
// today because record() on the underlying trace sink is not called for these runs.

describe("goal-host lifecycle subscriber tracing", () => {
  it("expected: every subscriber run posts a full execution trace (activity-api record called)", async () => {
    // Fake ActivityApi facade that GoalHost uses. It exposes the minimal surface that
    // GoalHost's constructor/runtime read: asTraceSink(), readTuningNumber(), postSubscriberCounts().
    class FakeActivityApi {
      public tracePosts: unknown[] = [];
      public countPosts: unknown[] = [];
      asTraceSink() {
        return {
          // ExecutionRuntime->TraceSink.record(trace)
          record: async (trace: unknown) => {
            this.tracePosts.push(trace);
          },
        } as { record: (t: unknown) => Promise<void> };
      }
      // Row value that toggles counted-only behavior for subscriber runs. 1 => count, don't trace.
      readTuningNumber(_row: string): number | Promise<number> { return 1; }
      async postSubscriberCounts(batch: unknown): Promise<void> { this.countPosts.push(batch); }
    }

    const fakeApi = new FakeActivityApi();

    // Construct GoalHost. Do NOT override subscriberTemplates to ensure the shared
    // built-in lifecycle subscribers (slot-binding, validator-dispatch, ...) are registered.
    const host = new mod.GoalHost({
      activityApiEndpoint: "http://activity-api.invalid",
      apiKey: "test-key",
      activityApi: fakeApi as unknown as object, // accept as any-like facade
    } as unknown as mod.GoalHostOptions);

    // Emit a lifecycle event directly into the subscriber vessel. This exercises the
    // exact dispatcher closure (capturing the executor) in goal-host.ts.
    const subscriber = (host as unknown as { subscriber: { emit: (e: unknown) => Promise<void> } }).subscriber;

    // Minimal lifecycle event; dispatcher reads data.executionId / compositionChain / tags defensively.
    const event = {
      type: "lifecycle:task:completed",
      timestamp: Date.now(),
      data: {
        executionId: "parent-exec-1",
        compositionChain: [],
        tags: ["intent:unit-test"],
        parentDepth: 0,
      },
    };

    await subscriber.emit(event);

    // Correct behavior: the lifecycle-subscriber-dispatched run should be traced via the
    // same activity-api trace sink as goal work.
    // This assertion is expected to FAIL due to the current defect (tracePosts.length === 0).
    expect(fakeApi.tracePosts.length).toBeGreaterThan(0);
  });

  it("control: GoalHost constructs with a fake activity-api facade", () => {
    class FakeActivityApi {
      asTraceSink() { return { record: async () => { /* no-op */ } }; }
      readTuningNumber(): number { return 0; }
      async postSubscriberCounts(): Promise<void> { /* no-op */ }
    }
    const host = new mod.GoalHost({
      activityApiEndpoint: "http://activity-api.invalid",
      apiKey: "test-key",
      activityApi: new FakeActivityApi() as unknown as object,
    } as unknown as mod.GoalHostOptions);
    // Behavior: constructing the host should not throw and yields an object instance.
    expect(host).toBeInstanceOf(mod.GoalHost);
  });
});
