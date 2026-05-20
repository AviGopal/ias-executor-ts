import { describe, expect, test } from "bun:test";
import {
  ActivityExecutor,
  ExecutionRuntime,
  type ActivityTemplate,
  type LifecycleEvent,
  type Resolver,
} from "../src";

describe("ExecutionRuntime + ActivityExecutor", () => {
  test("executes a fixture activity entirely in memory", async () => {
    const runtime = new ExecutionRuntime();
    const executor = new ActivityExecutor(runtime);

    const emitResolver: Resolver = {
      id: "emit-greeting",
      tier: "deterministic",
      async resolve(context) {
        return [
          {
            id: context.random.id("imp"),
            pointer: { type: "memo" },
            metadata: { shape: "greeting", summary: "greeting created" },
            loaded: true,
            content: `hello ${String(context.variables.name ?? "world")}`,
          },
        ];
      },
    };

    runtime.resolvers.register(emitResolver);

    const template: ActivityTemplate = {
      id: "hello-world",
      name: "Hello World",
      tasks: [
        {
          id: "greet",
          description: "Create a greeting",
          resolver: "emit-greeting",
          outputShapes: ["greeting"],
        },
      ],
      outputShapes: ["greeting"],
    };

    const trace = await executor.execute(template, {
      variables: { name: "ias" },
      reason: "fixture execution",
    });

    expect(trace.status).toBe("completed");
    expect(trace.tasks).toHaveLength(1);
    const outputs = runtime.store.findByShape("greeting");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.content).toBe("hello ias");
  });

  test("emits lifecycle events through the event sink", async () => {
    const events: LifecycleEvent[] = [];
    const runtime = new ExecutionRuntime({
      eventSink: {
        emit(event) {
          events.push(event);
        },
      },
    });
    const executor = new ActivityExecutor(runtime);

    runtime.resolvers.register({
      id: "emit",
      async resolve(context) {
        return [
          {
            id: context.random.id("imp"),
            pointer: { type: "memo" },
            metadata: { shape: "result" },
            loaded: true,
            content: "done",
          },
        ];
      },
    });

    await executor.execute({
      id: "with-events",
      name: "With Events",
      tasks: [
        {
          id: "emit",
          description: "Emit output",
          resolver: "emit",
          outputShapes: ["result"],
        },
      ],
    });

    expect(events.map((event) => event.type)).toEqual([
      "activity.started",
      "task.started",
      "task.completed",
      "lifecycle:task:completed",
      "activity.completed",
      "lifecycle:execution:succeeded",
    ]);
  });

  test("keeps attached capability vessels explicit", async () => {
    const runtime = new ExecutionRuntime({
      attachedVessels: [
        {
          id: "llm-vessel",
          kind: "llm",
          resolverIds: ["llm"],
        },
      ],
    });

    expect(await runtime.listAttachedVessels()).toEqual([
      { id: "llm-vessel", kind: "llm", resolverIds: ["llm"] },
    ]);

    const executor = new ActivityExecutor(runtime);
    const trace = await executor.execute({
      id: "missing-file-capability",
      name: "Missing File Capability",
      tasks: [
        {
          id: "read-file",
          description: "Attempt file access without attaching it",
          resolver: "file",
          inputShapes: ["file"],
        },
      ],
    });

    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("shape 'file'");
  });
});
