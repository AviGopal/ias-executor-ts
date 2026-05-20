/**
 * GoalHost tests.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host
 *       §G + specs/goal-host/spec.md R1–R7.
 *
 * Uses fakes (TraceSinkSpy, fake LLMPort, fake ActivityApiAdapter) — no
 * real network. Real-canary smoke is covered by the goal-host-demo
 * script under src/examples/.
 */

import { describe, expect, test } from "bun:test";
import type { ActivityTemplate, ExecutionTrace, LifecycleEvent } from "../src/ontology";
import type { LLMPort, EventSink } from "../src/ports";
import { GoalHost } from "../src/examples/goal-host";
import { ActivityApiAdapter, type RecommendResponse } from "../src/adapters/activity-api-adapter";
import { TraceSinkSpy } from "./fakes";
import { loadSubscriberTemplates, SHARED_TEMPLATES } from "../src/templates/index";

// ────────────────────────────────────────────────────────────────────────
// Fakes
// ────────────────────────────────────────────────────────────────────────

class FakeLLM implements LLMPort {
  readonly calls: Array<{ prompt: string; systemPrompt?: string }> = [];
  constructor(private readonly response: string = "fake-llm-response") {}
  async generate(input: { prompt: string; systemPrompt?: string }): Promise<string> {
    this.calls.push({ prompt: input.prompt, systemPrompt: input.systemPrompt });
    return this.response;
  }
}

class EventSinkSpy implements EventSink {
  readonly events: LifecycleEvent[] = [];
  emit(event: LifecycleEvent): void {
    this.events.push(event);
  }
}

/**
 * Stand-in for ActivityApiAdapter — records calls, returns scripted
 * responses. Construction matches the real adapter's signature so it
 * slots straight into GoalHostOptions.activityApi.
 */
class FakeActivityApi extends ActivityApiAdapter {
  readonly recommendCalls: Array<{ goal: string; expectedOutputShapes?: string[] }> = [];
  readonly recordedTraces: ExecutionTrace[] = [];

  constructor(
    private readonly scriptedRecommend: RecommendResponse = { recommendations: [] },
    private readonly scriptedTemplates: Map<string, ActivityTemplate> = new Map(),
  ) {
    // Pass dummy endpoint + key; we override every method.
    super("http://fake-activity-api.test", "fake-api-key", {
      fetch: { request: async () => new Response("", { status: 500 }) },
    });
  }

  override async recommend(req: {
    goal: string;
    expectedOutputShapes?: string[];
  }): Promise<RecommendResponse> {
    this.recommendCalls.push({ goal: req.goal, expectedOutputShapes: req.expectedOutputShapes });
    return this.scriptedRecommend;
  }

  override async getTemplate(id: string): Promise<ActivityTemplate | null> {
    return this.scriptedTemplates.get(id) ?? null;
  }

  override async recordTrace(trace: ExecutionTrace): Promise<void> {
    this.recordedTraces.push(trace);
  }
}

const HELLO_WORLD: ActivityTemplate = {
  id: "hello-world-minimal",
  name: "Hello World Minimal",
  description: "Single bash task — wiring smoke test.",
  outputShapes: ["commandResult"],
  tasks: [
    {
      id: "say-hi",
      description: "echo hello",
      resolver: "bash",
      config: { command: ["echo", "hello"] },
      outputShapes: ["commandResult"],
    },
  ],
};

function makeHost(overrides: Partial<ConstructorParameters<typeof GoalHost>[0]> = {}) {
  const llm = new FakeLLM();
  const traceSink = new TraceSinkSpy();
  const eventSink = new EventSinkSpy();
  const host = new GoalHost({
    llm,
    activityApiEndpoint: "http://fake-activity-api.test",
    apiKey: "fake-api-key",
    eventSink,
    traceSink,
    ...overrides,
  });
  return { host, llm, traceSink, eventSink };
}

// ────────────────────────────────────────────────────────────────────────
// Constructor + capability surface
// ────────────────────────────────────────────────────────────────────────

describe("GoalHost — construction", () => {
  test("constructs without error with minimal options", () => {
    const { host } = makeHost();
    expect(host.runtime).toBeDefined();
    expect(host.executor).toBeDefined();
    expect(host.activityApi).toBeDefined();
    expect(host.subscriber).toBeDefined();
  });

  test("attaches the canonical capability vessels (bun-fs, bun-proc, llm-vessel, discovery-vessel, lifecycle-subscriber)", async () => {
    const { host } = makeHost();
    const caps = await host.listCapabilities();
    const kinds = caps.map((c) => c.kind);
    expect(kinds).toContain("filesystem");
    expect(kinds).toContain("process");
    expect(kinds).toContain("llm");
    expect(kinds).toContain("discovery");
    expect(kinds).toContain("lifecycle-subscriber");
  });

  test("auto-registers every subscriber template from SHARED_TEMPLATES (spec R4)", () => {
    const { host } = makeHost();
    const expected = loadSubscriberTemplates();
    // Walk every shape declared by the catalogue subscribers; each should
    // be registered on the vessel.
    let registered = 0;
    for (const t of expected) {
      const shape = t.subscription!.shape;
      const subs = host.subscriber.listSubscribers(shape);
      if (subs.find((s) => s.id === t.id)) registered++;
    }
    expect(registered).toBe(expected.length);
    expect(expected.length).toBeGreaterThan(0); // sanity — catalogue isn't empty
  });

  test("subscriberTemplates override replaces the default set", () => {
    const custom: ActivityTemplate = {
      id: "custom-sub",
      name: "Custom Subscriber",
      tasks: [],
      subscription: { shape: "lifecycle:custom:event" },
    };
    const { host } = makeHost({ subscriberTemplates: [custom] });
    expect(host.subscriber.listSubscribers("lifecycle:custom:event").length).toBe(1);
    // Default subscribers should NOT be registered.
    for (const t of loadSubscriberTemplates()) {
      const subs = host.subscriber.listSubscribers(t.subscription!.shape);
      expect(subs.find((s) => s.id === t.id)).toBeUndefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// runTemplate — direct execution path
// ────────────────────────────────────────────────────────────────────────

describe("GoalHost — runTemplate", () => {
  test("executes a simple template through the wired runtime", async () => {
    // Override subscriberTemplates to [] so catalogue subscribers
    // (validator-dispatch et al.) don't fire and spawn extra traces — we
    // want to isolate the trace-count assertion to the parent.
    const { host, traceSink } = makeHost({ subscriberTemplates: [] });
    const trace = await host.runTemplate(HELLO_WORLD);
    expect(trace.status).toBe("completed");
    expect(trace.templateId).toBe("hello-world-minimal");
    expect(trace.tasks.length).toBe(1);
    expect(trace.tasks[0]!.success).toBe(true);
    expect(traceSink.traces.length).toBe(1);
    expect(traceSink.traces[0]!.id).toBe(trace.id);
  });

  test("trace flows to TranslatingTraceSink when host uses default sink", async () => {
    const fakeApi = new FakeActivityApi({ recommendations: [] });
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
      subscriberTemplates: [],
      // No traceSink override → host should call activityApi.recordTrace.
    });
    const trace = await host.runTemplate(HELLO_WORLD);
    expect(trace.status).toBe("completed");
    expect(fakeApi.recordedTraces.length).toBe(1);
    expect(fakeApi.recordedTraces[0]!.id).toBe(trace.id);
  });
});

// ────────────────────────────────────────────────────────────────────────
// runGoal — recommend + targetTemplateId paths
// ────────────────────────────────────────────────────────────────────────

describe("GoalHost — runGoal", () => {
  test("targetTemplateId bypasses recommend and runs the named template", async () => {
    const fakeApi = new FakeActivityApi({ recommendations: [] });
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
    });
    // Pre-register the test template in the local catalogue so the
    // CatalogueWithFallback resolves it.
    host.catalogue.register(HELLO_WORLD);

    const result = await host.runGoal("say hello", {
      targetTemplateId: "hello-world-minimal",
    });
    expect(result.trace.status).toBe("completed");
    expect(result.selectedTemplateId).toBe("hello-world-minimal");
    // recommend MUST NOT have been called.
    expect(fakeApi.recommendCalls.length).toBe(0);
    expect(result.recommendCandidates).toBeUndefined();
  });

  test("without targetTemplateId, calls ActivityApiAdapter.recommend with the goal_text and runs the top candidate", async () => {
    const fakeApi = new FakeActivityApi({
      recommendations: [
        { template_id: "hello-world-minimal", score: 0.9 },
        { template_id: "some-other-template", score: 0.5 },
      ],
    });
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
    });
    host.catalogue.register(HELLO_WORLD);

    const result = await host.runGoal("greet the world");
    expect(fakeApi.recommendCalls.length).toBe(1);
    expect(fakeApi.recommendCalls[0]!.goal).toBe("greet the world");
    expect(result.selectedTemplateId).toBe("hello-world-minimal");
    expect(result.trace.status).toBe("completed");
    expect(result.recommendCandidates?.length).toBe(2);
  });

  test("falls back to activityApi.getTemplate when the template id is not in the local catalogue (spec R2.3)", async () => {
    const remoteTemplate: ActivityTemplate = {
      ...HELLO_WORLD,
      id: "remote-only-template",
    };
    const fakeApi = new FakeActivityApi(
      { recommendations: [{ template_id: "remote-only-template" }] },
      new Map([["remote-only-template", remoteTemplate]]),
    );
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
    });

    const result = await host.runGoal("anything");
    expect(result.selectedTemplateId).toBe("remote-only-template");
    expect(result.trace.status).toBe("completed");
  });

  test("throws a clear error when recommend returns no candidates and no targetTemplateId is given", async () => {
    const fakeApi = new FakeActivityApi({ recommendations: [] });
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
    });

    await expect(host.runGoal("no match")).rejects.toThrow(/no template id returned/);
  });

  test("seeds a goal-shape impulse into the runtime store", async () => {
    const fakeApi = new FakeActivityApi({ recommendations: [] });
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
    });
    host.catalogue.register(HELLO_WORLD);

    await host.runGoal("seed me", { targetTemplateId: "hello-world-minimal" });
    // After the run, the store should contain at least one impulse with
    // metadata.shape === "goal".
    const goals = host.runtime.store
      .all()
      .filter((imp) => imp.metadata.shape === "goal");
    expect(goals.length).toBeGreaterThanOrEqual(1);
    const content = goals[0]!.content as { text?: string };
    expect(content?.text).toBe("seed me");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Lifecycle-subscriber integration with the engine emission path
// ────────────────────────────────────────────────────────────────────────

describe("GoalHost — lifecycle subscriber integration", () => {
  test("a subscriber template fires when an emitted lifecycle event matches its subscription", async () => {
    // Custom subscriber that fires on lifecycle:execution:succeeded with no
    // filter (so any successful execution triggers it). The dispatcher in
    // GoalHost runs the subscriber template via the same executor — we
    // observe via the EventSinkSpy that the child execution also emits
    // activity.started.
    const childTemplate: ActivityTemplate = {
      id: "lifecycle-child",
      name: "Lifecycle Child",
      tasks: [
        {
          id: "child-task",
          description: "child bash",
          resolver: "bash",
          config: { command: ["echo", "child"] },
          outputShapes: ["commandResult"],
        },
      ],
      subscription: { shape: "lifecycle:execution:succeeded" },
    };

    const fakeApi = new FakeActivityApi({ recommendations: [] });
    const llm = new FakeLLM();
    const eventSink = new EventSinkSpy();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
      subscriberTemplates: [childTemplate],
      eventSink,
    });

    const trace = await host.runTemplate(HELLO_WORLD);
    expect(trace.status).toBe("completed");

    // The downstream sink should have seen TWO lifecycle:execution:succeeded
    // events — one for the parent (HELLO_WORLD), one for the child fired
    // by the subscriber.
    const succEvents = eventSink.events.filter(
      (e) => e.type === "lifecycle:execution:succeeded",
    );
    expect(succEvents.length).toBe(2);

    // The child's trace should have parentExecutionId pointing to HELLO_WORLD's run.
    const ids = succEvents.map((e) => (e.data as { executionId?: string }).executionId);
    expect(ids).toContain(trace.id);
  });

  test("subscriber failures NEVER cascade to the parent execution (spec §E.2)", async () => {
    // Subscriber template that references a non-existent resolver — execution
    // will fail, but the parent trace must still be `completed`.
    const failingChild: ActivityTemplate = {
      id: "failing-child",
      name: "Failing Child",
      tasks: [
        {
          id: "broken",
          description: "missing resolver",
          resolver: "this-resolver-does-not-exist",
        },
      ],
      subscription: { shape: "lifecycle:execution:succeeded" },
    };

    const fakeApi = new FakeActivityApi({ recommendations: [] });
    const llm = new FakeLLM();
    const host = new GoalHost({
      llm,
      activityApiEndpoint: "http://fake.test",
      apiKey: "k",
      activityApi: fakeApi,
      subscriberTemplates: [failingChild],
    });

    const trace = await host.runTemplate(HELLO_WORLD);
    expect(trace.status).toBe("completed");
  });
});

// ────────────────────────────────────────────────────────────────────────
// Catalogue sanity
// ────────────────────────────────────────────────────────────────────────

describe("GoalHost — catalogue", () => {
  test("SHARED_TEMPLATES is non-empty and every entry has an id (spec R4)", () => {
    expect(SHARED_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of SHARED_TEMPLATES) {
      expect(typeof t.id).toBe("string");
      expect(t.id.length).toBeGreaterThan(0);
    }
  });
});
