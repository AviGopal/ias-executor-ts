import { describe, expect, test } from "bun:test";
import {
  ActivityExecutor,
  ExecutionRuntime,
  InMemoryTemplateProvider,
  type ActivityTemplate,
  type Resolver,
} from "../src";
import { EventSinkSpy, SequentialRandom, SteppingClock, TraceSinkSpy } from "./fakes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResolver(id: string, outputShape = "result"): Resolver {
  return {
    id,
    tier: "deterministic",
    async resolve(context) {
      return [
        {
          id: context.random.id("out"),
          pointer: { type: "memo" },
          metadata: { shape: outputShape, summary: `output from ${id}` },
          loaded: true,
          content: `result-${id}`,
        },
      ];
    },
  };
}

function makeTemplate(
  id: string,
  resolverId: string,
  inputShapes: string[] = [],
  outputShapes: string[] = ["result"],
): ActivityTemplate {
  return {
    id,
    name: id,
    tasks: [{ id: "t1", description: "run", resolver: resolverId, inputShapes, outputShapes }],
    outputShapes,
  };
}

// ---------------------------------------------------------------------------
// ResolverRegistry contract
// ---------------------------------------------------------------------------

describe("ResolverRegistry", () => {
  test("register and retrieve by id", () => {
    const runtime = new ExecutionRuntime();
    const r = makeResolver("alpha");
    runtime.resolvers.register(r);
    expect(runtime.resolvers.get("alpha")).toBe(r);
  });

  test("has returns false for unregistered id", () => {
    const runtime = new ExecutionRuntime();
    expect(runtime.resolvers.has("nonexistent")).toBe(false);
  });

  test("list returns sorted ids", () => {
    const runtime = new ExecutionRuntime();
    runtime.resolvers.register(makeResolver("bravo"));
    runtime.resolvers.register(makeResolver("alpha"));
    expect(runtime.resolvers.list()).toEqual(["alpha", "bravo"]);
  });

  test("second register overwrites first", () => {
    const runtime = new ExecutionRuntime();
    const r1 = makeResolver("dup");
    const r2 = makeResolver("dup");
    runtime.resolvers.register(r1);
    runtime.resolvers.register(r2);
    expect(runtime.resolvers.get("dup")).toBe(r2);
  });
});

// ---------------------------------------------------------------------------
// Resolver dispatch behavior
// ---------------------------------------------------------------------------

describe("Resolver dispatch", () => {
  test("unregistered resolver produces failed trace with execution_error", async () => {
    const runtime = new ExecutionRuntime();
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute(makeTemplate("t", "missing-resolver"));
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.type).toBe("execution_error");
    expect(trace.failureMode?.reason).toContain("missing-resolver");
  });

  test("resolver exception propagates as failed trace", async () => {
    const runtime = new ExecutionRuntime();
    runtime.resolvers.register({
      id: "boom",
      async resolve() {
        throw new Error("boom!");
      },
    });
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute(makeTemplate("t", "boom"));
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("boom!");
  });

  test("resolver tier is recorded in task record", async () => {
    const runtime = new ExecutionRuntime({
      random: new SequentialRandom(),
      clock: new SteppingClock(),
    });
    runtime.resolvers.register({ id: "llm-r", tier: "llm", async resolve(ctx) {
      return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "text" }, loaded: true, content: "hi" }];
    }});
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute(makeTemplate("t", "llm-r", [], ["text"]));
    expect(trace.status).toBe("completed");
    expect(trace.tasks[0]?.resolverTier).toBe("llm");
  });

  test("failed task causes trace to include partial task records up to failure", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register(makeResolver("step1"));
    runtime.resolvers.register({ id: "step2", async resolve() { throw new Error("step2 exploded"); } });

    const template: ActivityTemplate = {
      id: "two-step",
      name: "Two Step",
      tasks: [
        { id: "t1", description: "first", resolver: "step1", outputShapes: ["result"] },
        { id: "t2", description: "second", resolver: "step2" },
      ],
    };
    const executor = new ActivityExecutor(runtime);
    const trace = await executor.execute(template);

    expect(trace.status).toBe("failed");
    expect(trace.tasks).toHaveLength(1); // only t1 completed before failure
    expect(trace.tasks[0]?.taskId).toBe("t1");
    expect(trace.tasks[0]?.success).toBe(true);
  });

  test("resolved outputs are stored and retrievable by shape", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register(makeResolver("r", "greeting"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute(makeTemplate("t", "r", [], ["greeting"]));
    const greetings = runtime.store.findByShape("greeting");
    expect(greetings).toHaveLength(1);
    expect(greetings[0]?.content).toBe("result-r");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle events on resolver dispatch
// ---------------------------------------------------------------------------

describe("Lifecycle events during resolver dispatch", () => {
  test("emits task.started and task.completed on success", async () => {
    const events = new EventSinkSpy();
    const runtime = new ExecutionRuntime({ eventSink: events, random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register(makeResolver("r"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute(makeTemplate("t", "r"));
    expect(events.types()).toContain("task.started");
    expect(events.types()).toContain("task.completed");
    expect(events.types()).not.toContain("activity.failed");
  });

  test("emits activity.failed on resolver exception", async () => {
    const events = new EventSinkSpy();
    const runtime = new ExecutionRuntime({ eventSink: events, random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register({ id: "boom", async resolve() { throw new Error("x"); } });
    const executor = new ActivityExecutor(runtime);

    await executor.execute(makeTemplate("t", "boom"));
    expect(events.types()).toContain("activity.failed");
    expect(events.types()).not.toContain("activity.completed");
  });

  test("trace is recorded by traceSink", async () => {
    const traces = new TraceSinkSpy();
    const runtime = new ExecutionRuntime({ traceSink: traces, random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register(makeResolver("r"));
    const executor = new ActivityExecutor(runtime);

    await executor.execute(makeTemplate("t", "r"), { reason: "test run" });
    const trace = traces.last();
    expect(trace?.status).toBe("completed");
    expect(trace?.reason).toBe("test run");
  });
});
