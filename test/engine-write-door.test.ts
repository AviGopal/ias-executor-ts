// THE WRITE DOOR, TASK LEVEL (src/write-door.ts). Measured: on a goal not admitted as a change, a learned composition ran
// its own tasks uiPanel_write and code_modification_proposal, and an activity-as-resolver whose child wrote
// concept_write. The host's doors see only a template's declared shapes, so the engine checks each task.
// Namespace import, so on an engine without the door the assertions (not the module link) fail.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as ias from "../src";
import type { ActivityTemplate, ExecuteOptions, ExecutionTrace, Resolver } from "../src";
import { TranslatingTraceSink } from "../src/adapters/activity-api-trace-sink";
import { ActivityApiAdapter, type RecommendResponse } from "../src/adapters/activity-api-adapter";
import { GoalHost } from "../src/hosts/goal-host";
import { makeActivityResolver } from "../src/resolvers/activity";
import { makeIterationResolver } from "../src/resolvers/iteration";
import { EventSinkSpy, SequentialRandom, SteppingClock, TraceSinkSpy } from "./fakes";

const GOVERNS = (s: string) => /_write$/.test(s) || s === "code_modification_proposal";
const NOT_ADMITTED = { writeDoor: { admitted: false, governs: GOVERNS } } as unknown as ExecuteOptions;

function setup() {
  const calls: string[] = [];
  const events = new EventSinkSpy();
  const traces = new TraceSinkSpy();
  const runtime = new ias.ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(), eventSink: events, traceSink: traces });
  for (const id of ["resolver_pattern_report", "concept_write", "uiPanel_write", "code_modification_proposal", "impulse-resolve"]) {
    const r: Resolver = {
      id,
      tier: "pattern",
      async resolve(ctx) {
        calls.push(id);
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: id }, loaded: true, content: `${id} ran` }];
      },
    };
    runtime.resolvers.register(r);
  }
  const provider = new ias.InMemoryTemplateProvider();
  provider.register({
    id: "composed-cap-child",
    name: "child",
    tasks: [
      { id: "c-read", description: "read", resolver: "resolver_pattern_report", outputShapes: ["resolver_pattern_report"] },
      { id: "c-concept", description: "write a concept", resolver: "concept_write", outputShapes: ["concept_write"] },
    ],
  });
  runtime.registerTemplateProvider(provider);
  const executor = new ias.ActivityExecutor(runtime);
  // The resolvers that dispatch nested work, wired as the hosts wire them.
  runtime.resolvers.register(makeActivityResolver({ executor: () => executor }));
  runtime.resolvers.register(makeIterationResolver((id) => runtime.resolvers.get(id)));
  return { calls, events, traces, runtime, executor };
}

const LEARNED: ActivityTemplate = {
  id: "learned-composition-uipanel-write-to-resolver-pattern-report",
  name: "learned",
  tasks: [
    // The resolver id IS the shape it writes; the declared output is something else.
    { id: "t1", description: "panel", resolver: "uiPanel_write", outputShapes: ["panel"] },
    { id: "t2", description: "read", resolver: "resolver_pattern_report", outputShapes: ["resolver_pattern_report"] },
    { id: "t3", description: "write a concept", resolver: "concept_write", outputShapes: ["concept_write"] },
    { id: "t4", description: "propose", resolver: "code_modification_proposal", outputShapes: ["code_modification_proposal"] },
  ],
};

describe("write door, task level", () => {
  beforeEach(() => (ias as unknown as { resetWriteDoorTaskCounters?: () => void }).resetWriteDoorTaskCounters?.());

  test("must-fail: on a dispatch not admitted, every write task is skipped and recorded; the read task runs", async () => {
    const { calls, events, executor } = setup();
    const trace = await executor.execute(LEARNED, NOT_ADMITTED);
    expect(calls).toEqual(["resolver_pattern_report"]);
    const byId = Object.fromEntries(trace.tasks.map((t) => [t.taskId, t]));
    for (const id of ["t1", "t3", "t4"]) {
      expect(byId[id]!.skipped).toBe(true);
      expect((byId[id] as { skipReason?: string }).skipReason).toBe("write_door_not_admitted");
    }
    expect(byId["t2"]!.skipped).toBeUndefined();
    const skipped = events.ofType("task.skipped").map((e) => (e.data as { refusedShapes?: string[] }).refusedShapes);
    expect(skipped).toEqual([["uiPanel_write"], ["concept_write"], ["code_modification_proposal"]]);
    const counters = (ias as unknown as { writeDoorTaskCounters?: () => { dropped_tasks: number; by_shape: Record<string, number> } }).writeDoorTaskCounters?.();
    expect(counters?.dropped_tasks).toBe(3);
    expect(counters?.by_shape["concept_write"]).toBe(1);
  });

  test("must-fail: the door holds inside an activity-as-resolver's composed child", async () => {
    const { calls, executor } = setup();
    const parent: ActivityTemplate = {
      id: "learned-parent",
      name: "parent",
      tasks: [{ id: "p1", description: "compose the cap", resolver: "compose", subActivityId: "composed-cap-child", outputShapes: ["resolver_pattern_report"] }],
    };
    await executor.execute(parent, NOT_ADMITTED);
    expect(calls).toEqual(["resolver_pattern_report"]);
  });

  test("control: write_door absent runs every task (back-compat for every other caller)", async () => {
    const { calls, executor } = setup();
    const trace = await executor.execute(LEARNED, {});
    expect(calls).toEqual(["uiPanel_write", "resolver_pattern_report", "concept_write", "code_modification_proposal"]);
    expect(trace.tasks.every((t) => !t.skipped)).toBe(true);
  });

  test("control: an admitted dispatch runs every task", async () => {
    const { calls, executor } = setup();
    await executor.execute(LEARNED, { writeDoor: { admitted: true, governs: GOVERNS } } as unknown as ExecuteOptions);
    expect(calls).toEqual(["uiPanel_write", "resolver_pattern_report", "concept_write", "code_modification_proposal"]);
  });

  test("control: a read-only template is unaffected on a dispatch not admitted", async () => {
    const { calls, executor } = setup();
    const trace = await executor.execute(
      { id: "reader", name: "reader", tasks: [{ id: "r1", description: "read", resolver: "resolver_pattern_report", outputShapes: ["resolver_pattern_report"] }] },
      NOT_ADMITTED,
    );
    expect(calls).toEqual(["resolver_pattern_report"]);
    expect(trace.status).toBe("completed");
  });
});

// The door's refusal must reach the DURABLE trace: the sink projects an explicit key set, so a reason the engine records
// is not sent unless the sink names it (src/adapters/trace-sink-forwarding.test.ts).
async function projectedTasks(trace: ExecutionTrace): Promise<Array<Record<string, unknown>>> {
  let body = "";
  const sink = new TranslatingTraceSink("https://activity.test", "k", {
    fetch: {
      async request(_u: string | URL | Request, init?: RequestInit) {
        body = init?.body as string;
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    },
  });
  await sink.record(trace);
  return (JSON.parse(body) as { execution_trace: { tasks: Array<Record<string, unknown>> } }).execution_trace.tasks;
}

describe("write door, the skip reaches the trace", () => {
  test("must-fail: a door-skipped task's skipReason is in the trace sink's projected task", async () => {
    const { executor } = setup();
    const trace = await executor.execute(LEARNED, NOT_ADMITTED);
    const byId = Object.fromEntries((await projectedTasks(trace)).map((t) => [t.task_id, t]));
    for (const id of ["t1", "t3", "t4"]) {
      expect(byId[id]!.status).toBe("skipped");
      expect(byId[id]!.skip_reason).toBe(ias.WRITE_DOOR_SKIP_REASON);
    }
    expect("skip_reason" in byId["t2"]!).toBe(false);
  });

  test("control: a task that ran sends no skip_reason key", async () => {
    const { executor } = setup();
    const tasks = await projectedTasks(await executor.execute(LEARNED, {}));
    expect(tasks.length).toBe(4);
    expect(tasks.some((t) => "skip_reason" in t)).toBe(false);
  });
});

// The host's entry point: a caller with no admission context passes no door, and its run is the pre-door run.
class QuietApi extends ActivityApiAdapter {
  constructor() {
    super("http://127.0.0.1:9/activity", "k", { fetch: { request: async () => new Response("", { status: 500 }) } });
  }
  override async recommend(): Promise<RecommendResponse> {
    return { recommendations: [] };
  }
  override async getTemplate(): Promise<ActivityTemplate | null> {
    return null;
  }
  override async recordTrace(): Promise<void> {}
}

describe("write door, GoalHost.runTemplate", () => {
  let realFetch: typeof globalThis.fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    // Nothing leaves the process.
    globalThis.fetch = (async (input: string | URL | Request) => {
      throw new TypeError(`refused ${typeof input === "string" ? input : String(input)}`);
    }) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function hostWithWriters() {
    const host = new GoalHost({
      llm: { generate: async () => "fake" },
      activityApiEndpoint: "http://127.0.0.1:9/activity",
      apiKey: "k",
      activityApi: new QuietApi(),
      traceSink: new TraceSinkSpy(),
      subscriberTemplates: [],
    });
    const calls: string[] = [];
    for (const id of ["concept_write", "resolver_pattern_report"]) {
      host.runtime.resolvers.register({
        id,
        tier: "pattern",
        async resolve(ctx) {
          calls.push(id);
          return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: id }, loaded: true, content: `${id} ran` }];
        },
      } as Resolver);
    }
    const tpl: ActivityTemplate = {
      id: "host-writer",
      name: "host writer",
      tasks: [
        { id: "w", description: "write a concept", resolver: "concept_write", outputShapes: ["concept_write"] },
        { id: "r", description: "read", resolver: "resolver_pattern_report", outputShapes: ["resolver_pattern_report"] },
      ],
    };
    return { host, calls, tpl };
  }

  test("control: runTemplate with no writeDoor runs the write task (absent door = the pre-door run)", async () => {
    const { host, calls, tpl } = hostWithWriters();
    const trace = await host.runTemplate(tpl);
    expect(calls).toEqual(["concept_write", "resolver_pattern_report"]);
    expect(trace.tasks.every((t) => !t.skipped)).toBe(true);
    expect(trace.status).toBe("completed");
  });

  test("control: runTemplate with {admitted:false} skips the write task with WRITE_DOOR_SKIP_REASON", async () => {
    const { host, calls, tpl } = hostWithWriters();
    const trace = await host.runTemplate(tpl, {}, NOT_ADMITTED);
    expect(calls).toEqual(["resolver_pattern_report"]);
    const w = trace.tasks.find((t) => t.taskId === "w")!;
    expect(w.skipped).toBe(true);
    expect(w.skipReason).toBe(ias.WRITE_DOOR_SKIP_REASON);
  });
});

// Learned composites are built as {resolver:"activity", config:{templateId}}, and an iteration body is a task the engine
// never dispatches: both run nested work the door must reach.
const VIA_ACTIVITY: ActivityTemplate = {
  id: "learned-composite-via-activity",
  name: "via activity",
  tasks: [{ id: "a1", description: "run the cap", resolver: "activity", config: { templateId: "composed-cap-child" }, outputShapes: ["activityExecutionSummary"] }],
};
const VIA_ITERATION: ActivityTemplate = {
  id: "iterate-writes",
  name: "via iteration",
  tasks: [{
    id: "i1", description: "write each", resolver: "iteration",
    config: { over: '["a","b"]', elementVar: "x", body: { resolver: "concept_write", config: { name: "{{x}}" } } },
    outputShapes: ["iteration_result"],
  }],
};
const iterationResult = (runtime: ias.ExecutionRuntime) =>
  runtime.store.all().find((i) => i.metadata.shape === "iteration_result")?.content as Array<Record<string, unknown>>;

describe("write door, nested resolvers", () => {
  test("must-fail: an activity-resolver task's child write is skipped with WRITE_DOOR_SKIP_REASON", async () => {
    const { calls, traces, executor } = setup();
    await executor.execute(VIA_ACTIVITY, NOT_ADMITTED);
    expect(calls).toEqual(["resolver_pattern_report"]);
    const child = traces.traces.find((t) => t.templateId === "composed-cap-child")!;
    const write = child.tasks.find((t) => t.taskId === "c-concept")!;
    expect(write.skipped).toBe(true);
    expect(write.skipReason).toBe(ias.WRITE_DOOR_SKIP_REASON);
  });

  test("must-fail: an iteration body that writes is skipped per element and recorded", async () => {
    const { calls, runtime, executor } = setup();
    const before = ias.writeDoorTaskCounters().by_shape["concept_write"] ?? 0;
    await executor.execute(VIA_ITERATION, NOT_ADMITTED);
    expect(calls).toEqual([]);
    const out = iterationResult(runtime);
    expect(out.map((r) => r.skipReason)).toEqual([ias.WRITE_DOOR_SKIP_REASON, ias.WRITE_DOOR_SKIP_REASON]);
    expect(out[0]!.refusedShapes).toEqual(["concept_write"]);
    expect(ias.writeDoorTaskCounters().by_shape["concept_write"]).toBe(before + 2);
  });

  test("control: with no door, the activity child and every iteration element write", async () => {
    const { calls, executor } = setup();
    await executor.execute(VIA_ACTIVITY, {});
    await executor.execute(VIA_ITERATION, {});
    expect(calls).toEqual(["resolver_pattern_report", "concept_write", "concept_write", "concept_write"]);
  });

  test("control: an admitted dispatch runs the activity child's write and every iteration element", async () => {
    const { calls, executor } = setup();
    const admitted = { writeDoor: { admitted: true, governs: GOVERNS } } as unknown as ExecuteOptions;
    await executor.execute(VIA_ACTIVITY, admitted);
    await executor.execute(VIA_ITERATION, admitted);
    expect(calls).toEqual(["resolver_pattern_report", "concept_write", "concept_write", "concept_write"]);
  });
});

// An impulse-resolve task writes the shape its pointer names: the lifecycle audit-test-report persists through
// pointer test_audit_report_write, ribosome-extract through activityTemplate_write.
const viaPointer = (type: string): ActivityTemplate => ({
  id: `resolve-${type}`,
  name: "via pointer",
  tasks: [{ id: "r1", description: "resolve", resolver: "impulse-resolve", config: { pointer: { type } }, outputShapes: ["writeAttempt"] }],
});

describe("write door, impulse-resolve pointer", () => {
  test("must-fail: an impulse-resolve task whose pointer.type is a write is skipped with WRITE_DOOR_SKIP_REASON", async () => {
    const { calls, events, executor } = setup();
    const trace = await executor.execute(viaPointer("concept_write"), NOT_ADMITTED);
    expect(calls).toEqual([]);
    expect(trace.tasks[0]!.skipped).toBe(true);
    expect(trace.tasks[0]!.skipReason).toBe(ias.WRITE_DOOR_SKIP_REASON);
    expect(events.ofType("task.skipped").map((e) => (e.data as { refusedShapes?: string[] }).refusedShapes)).toEqual([["concept_write"]]);
  });

  test("control: an impulse-resolve read runs on a dispatch not admitted; a write runs with no door", async () => {
    const { calls, executor } = setup();
    await executor.execute(viaPointer("resolver_pattern_report"), NOT_ADMITTED);
    await executor.execute(viaPointer("concept_write"), {});
    expect(calls).toEqual(["impulse-resolve", "impulse-resolve"]);
  });
});
