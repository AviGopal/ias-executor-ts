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
// Budget: task count
// ---------------------------------------------------------------------------

describe("Budget — task count", () => {
  function makeManyTaskTemplate(count: number): ActivityTemplate {
    return {
      id: "many-tasks",
      name: "Many Tasks",
      tasks: Array.from({ length: count }, (_, i) => ({
        id: `t${i}`,
        description: `task ${i}`,
        resolver: "noop",
        outputShapes: ["result"],
      })),
    };
  }

  const noopResolver: Resolver = {
    id: "noop",
    tier: "deterministic",
    async resolve(ctx) {
      return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "result" }, loaded: true, content: null }];
    },
  };

  test("completes when task count is within budget", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register(noopResolver);
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute(makeManyTaskTemplate(3), { budget: { maxTaskCount: 5 } });
    expect(trace.status).toBe("completed");
    expect(trace.tasks).toHaveLength(3);
  });

  test("fails with budget_exhausted when task count exceeds limit", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register(noopResolver);
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute(makeManyTaskTemplate(5), { budget: { maxTaskCount: 2 } });
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.type).toBe("budget_exhausted");
    expect(trace.failureMode?.context?.budget_type).toBe("task_count");
    expect(trace.tasks).toHaveLength(2); // 2 tasks ran before limit kicked in
  });
});

// ---------------------------------------------------------------------------
// Budget: duration
// ---------------------------------------------------------------------------

describe("Budget — duration", () => {
  test("fails with budget_exhausted when duration limit is exceeded", async () => {
    // SteppingClock advances by 100ms per call — will quickly exceed a 50ms budget
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(0, 100) });
    runtime.resolvers.register({
      id: "slow",
      async resolve(ctx) {
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "r" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "t",
      name: "t",
      tasks: [
        { id: "t1", description: "a", resolver: "slow", outputShapes: ["r"] },
        { id: "t2", description: "b", resolver: "slow", outputShapes: ["r"] },
        { id: "t3", description: "c", resolver: "slow", outputShapes: ["r"] },
      ],
    };
    // maxDurationMs=50 but clock steps by 100, so first elapsed check after t1 = 200ms > 50
    const trace = await executor.execute(template, { budget: { maxDurationMs: 50 } });
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.type).toBe("budget_exhausted");
    expect(trace.failureMode?.context?.budget_type).toBe("duration");
  });

  test("duration is recorded on the trace", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(0, 5) });
    runtime.resolvers.register({
      id: "fast",
      async resolve(ctx) {
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "r" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute({
      id: "t",
      name: "t",
      tasks: [{ id: "t1", description: "a", resolver: "fast", outputShapes: ["r"] }],
    });
    expect(trace.status).toBe("completed");
    expect(typeof trace.durationMs).toBe("number");
    expect(trace.durationMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Nested composition via "compose" resolver
// ---------------------------------------------------------------------------

describe("Nested composition (compose resolver)", () => {
  test("dispatches to sub-activity and collects its outputs", async () => {
    const provider = new InMemoryTemplateProvider();
    const subTemplate: ActivityTemplate = {
      id: "sub",
      name: "Sub Activity",
      tasks: [
        {
          id: "sub-t1",
          description: "produce result",
          resolver: "produce",
          outputShapes: ["sub-result"],
        },
      ],
      outputShapes: ["sub-result"],
    };
    provider.register(subTemplate);

    const runtime = new ExecutionRuntime({
      random: new SequentialRandom(),
      clock: new SteppingClock(),
    });
    runtime.registerTemplateProvider(provider);
    runtime.resolvers.register({
      id: "produce",
      tier: "deterministic",
      async resolve(ctx) {
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "sub-result" }, loaded: true, content: "sub-output" }];
      },
    });

    const parentTemplate: ActivityTemplate = {
      id: "parent",
      name: "Parent",
      tasks: [
        {
          id: "compose-task",
          description: "dispatch to sub",
          resolver: "compose",
          subActivityId: "sub",
          outputShapes: ["sub-result"],
        },
      ],
      outputShapes: ["sub-result"],
    };

    const executor = new ActivityExecutor(runtime);
    const trace = await executor.execute(parentTemplate);

    expect(trace.status).toBe("completed");
    expect(trace.tasks[0]?.taskId).toBe("compose-task");
    expect(trace.tasks[0]?.childExecutionId).toBeDefined();

    const results = runtime.store.findByShape("sub-result");
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe("sub-output");
  });

  test("compose task records child execution id and parent execution id on child trace", async () => {
    const provider = new InMemoryTemplateProvider();
    const traces = new TraceSinkSpy();

    const subTemplate: ActivityTemplate = {
      id: "sub",
      name: "Sub",
      tasks: [{ id: "s1", description: "x", resolver: "echo", outputShapes: ["data"] }],
      outputShapes: ["data"],
    };
    provider.register(subTemplate);

    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(), traceSink: traces });
    runtime.registerTemplateProvider(provider);
    runtime.resolvers.register({
      id: "echo",
      async resolve(ctx) {
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "data" }, loaded: true, content: "x" }];
      },
    });

    const parent: ActivityTemplate = {
      id: "parent",
      name: "Parent",
      tasks: [{ id: "c1", description: "compose", resolver: "compose", subActivityId: "sub", outputShapes: ["data"] }],
    };

    const executor = new ActivityExecutor(runtime);
    await executor.execute(parent);

    expect(traces.traces).toHaveLength(2); // sub first, then parent
    const [childTrace, parentTrace] = traces.traces;
    expect(childTrace?.parentExecutionId).toBe(parentTrace?.id);
    expect(childTrace?.compositionChain).toContain(parentTrace?.id);
  });

  test("compose fails when templateProvider is absent", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute({
      id: "p",
      name: "P",
      tasks: [{ id: "c", description: "compose", resolver: "compose", subActivityId: "nonexistent" }],
    });

    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("templateProvider");
  });

  test("compose fails when sub-activity template is not found", async () => {
    const provider = new InMemoryTemplateProvider(); // empty
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.registerTemplateProvider(provider);
    const executor = new ActivityExecutor(runtime);

    const trace = await executor.execute({
      id: "p",
      name: "P",
      tasks: [{ id: "c", description: "compose", resolver: "compose", subActivityId: "ghost" }],
    });

    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("ghost");
  });

  test("failure in sub-activity propagates to parent as failed trace", async () => {
    const provider = new InMemoryTemplateProvider();
    const subTemplate: ActivityTemplate = {
      id: "failing-sub",
      name: "Failing Sub",
      tasks: [{ id: "boom", description: "explode", resolver: "explode" }],
    };
    provider.register(subTemplate);

    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.registerTemplateProvider(provider);
    runtime.resolvers.register({ id: "explode", async resolve() { throw new Error("sub exploded"); } });

    const executor = new ActivityExecutor(runtime);
    const trace = await executor.execute({
      id: "p",
      name: "P",
      tasks: [{ id: "c", description: "compose", resolver: "compose", subActivityId: "failing-sub" }],
    });

    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("failing-sub");
    expect(trace.failureMode?.reason).toContain("sub exploded");
  });
});

// ---------------------------------------------------------------------------
// Composition chain propagation
// ---------------------------------------------------------------------------

describe("Composition chain", () => {
  test("top-level execution has no composition chain", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    runtime.resolvers.register({
      id: "r",
      async resolve(ctx) {
        return [{ id: ctx.random.id("o"), pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);
    const trace = await executor.execute({ id: "root", name: "Root", tasks: [{ id: "t", description: "t", resolver: "r", outputShapes: ["x"] }] });

    expect(trace.parentExecutionId).toBeUndefined();
    expect(trace.compositionChain).toBeUndefined();
  });

  test("nested composition populates parentExecutionId and compositionChain", async () => {
    const provider = new InMemoryTemplateProvider();
    const traces = new TraceSinkSpy();

    const sub: ActivityTemplate = {
      id: "sub",
      name: "Sub",
      tasks: [{ id: "s", description: "s", resolver: "noop", outputShapes: ["x"] }],
    };
    provider.register(sub);

    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(), traceSink: traces });
    runtime.registerTemplateProvider(provider);
    runtime.resolvers.register({
      id: "noop",
      async resolve(ctx) {
        return [{ id: ctx.random.id("o"), pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true, content: null }];
      },
    });

    const executor = new ActivityExecutor(runtime);
    const parentTrace = await executor.execute({
      id: "parent",
      name: "Parent",
      tasks: [{ id: "c", description: "c", resolver: "compose", subActivityId: "sub", outputShapes: ["x"] }],
    });

    const childTrace = traces.traces.find((t) => t.templateId === "sub");
    expect(childTrace?.parentExecutionId).toBe(parentTrace.id);
    expect(childTrace?.compositionChain).toEqual([parentTrace.id]);
  });
});

// ---------------------------------------------------------------------------
// Retry semantics (task 1.6 — design §J.4)
// ---------------------------------------------------------------------------

describe("Retry semantics", () => {
  test("succeeds on first attempt when no failure", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    let callCount = 0;
    runtime.resolvers.register({
      id: "flaky",
      tier: "deterministic",
      async resolve(ctx) {
        callCount++;
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "result" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);
    const template: ActivityTemplate = {
      id: "retry-test",
      name: "Retry Test",
      tasks: [{ id: "t1", description: "task", resolver: "flaky", outputShapes: ["result"], retry: { max_attempts: 3 } }],
    };
    const trace = await executor.execute(template);
    expect(trace.status).toBe("completed");
    expect(callCount).toBe(1);
  });

  test("retries up to max_attempts on failure and succeeds", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    let callCount = 0;
    runtime.resolvers.register({
      id: "flaky",
      tier: "deterministic",
      async resolve(ctx) {
        callCount++;
        if (callCount < 3) throw new Error(`attempt ${callCount} failed`);
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "result" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);
    const template: ActivityTemplate = {
      id: "retry-test",
      name: "Retry Test",
      tasks: [{ id: "t1", description: "task", resolver: "flaky", outputShapes: ["result"], retry: { max_attempts: 3 } }],
    };
    const trace = await executor.execute(template);
    expect(trace.status).toBe("completed");
    expect(callCount).toBe(3);
  });

  test("exhausts all retries and returns failed trace", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    let callCount = 0;
    runtime.resolvers.register({
      id: "always-fail",
      tier: "deterministic",
      async resolve() {
        callCount++;
        throw new Error("always fails");
      },
    });
    const executor = new ActivityExecutor(runtime);
    const template: ActivityTemplate = {
      id: "retry-test",
      name: "Retry Test",
      tasks: [{ id: "t1", description: "task", resolver: "always-fail", retry: { max_attempts: 2 } }],
    };
    const trace = await executor.execute(template);
    expect(trace.status).toBe("failed");
    expect(callCount).toBe(2);
    expect(trace.failureMode?.reason).toContain("always fails");
  });

  test("camelCase maxAttempts is also accepted", async () => {
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
    let callCount = 0;
    runtime.resolvers.register({
      id: "flaky2",
      tier: "deterministic",
      async resolve(ctx) {
        callCount++;
        if (callCount < 2) throw new Error("first fails");
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "result" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);
    const template: ActivityTemplate = {
      id: "retry-camel",
      name: "Retry camelCase",
      tasks: [{ id: "t1", description: "task", resolver: "flaky2", retry: { maxAttempts: 3 } }],
    };
    const trace = await executor.execute(template);
    expect(trace.status).toBe("completed");
    expect(callCount).toBe(2);
  });

  test("emits task.retry event for each failed attempt", async () => {
    const sink = new EventSinkSpy();
    const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(), eventSink: sink });
    let callCount = 0;
    runtime.resolvers.register({
      id: "flaky3",
      tier: "deterministic",
      async resolve(ctx) {
        callCount++;
        if (callCount < 3) throw new Error("fail");
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "result" }, loaded: true, content: null }];
      },
    });
    const executor = new ActivityExecutor(runtime);
    const template: ActivityTemplate = {
      id: "retry-events",
      name: "Retry events",
      tasks: [{ id: "t1", description: "task", resolver: "flaky3", retry: { max_attempts: 3 } }],
    };
    await executor.execute(template);
    const retryEvents = sink.events.filter((e) => e.type === "task.retry");
    expect(retryEvents).toHaveLength(2);
    expect(retryEvents[0].data.attempt).toBe(1);
    expect(retryEvents[1].data.attempt).toBe(2);
  });
});
