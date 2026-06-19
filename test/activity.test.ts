/**
 * activity resolver tests — nested template dispatch via injected executor.
 */
import { describe, expect, test } from "bun:test";
import { makeActivityResolver } from "../src/resolvers/activity";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";
import type { ActivityTemplate } from "../src/ontology";
import type { TemplateProvider } from "../src/ports";

function makeNoopResolver(id: string) {
  return {
    id,
    tier: "deterministic" as const,
    async resolve(ctx: ResolverContext) {
      return [
        {
          id: ctx.random.id(id),
          pointer: { type: "memo" as const },
          metadata: { shape: `${id}_result` },
          loaded: true as const,
          content: { ok: true },
        },
      ];
    },
  };
}

const childTemplate: ActivityTemplate = {
  id: "child_tpl",
  name: "Child",
  tasks: [{ id: "t1", description: "", resolver: "noop", config: {} } as never],
};

function makeRuntimeAndExecutor(templateProvider?: TemplateProvider) {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
    templateProvider,
  });
  runtime.resolvers.register(makeNoopResolver("noop"));
  const executor = new ActivityExecutor(runtime);
  runtime.resolvers.register(makeActivityResolver({ executor: () => executor }));
  return { runtime, executor };
}

function makeContext(
  runtime: ExecutionRuntime,
  config: Record<string, unknown>,
  variables: Record<string, unknown> = {},
): ResolverContext {
  return {
    executionId: "exec_parent",
    template: { id: "p", name: "P", tasks: [{ id: "x", resolver: "activity", config } as never] },
    task: { id: "x", description: "", resolver: "activity", config } as never,
    variables,
    inputImpulses: [],
    store: runtime.store,
    clock: runtime.clock,
    random: runtime.random,
    eventSink: runtime.eventSink,
    traceSink: runtime.traceSink,
    templateProvider: runtime.templateProvider,
    attachedVessels: runtime.attachedVessels,
  };
}

describe("activity resolver", () => {
  test("dispatches inline template and returns summary impulse", async () => {
    const { runtime } = makeRuntimeAndExecutor();
    const resolver = runtime.resolvers.get("activity")!;
    const ctx = makeContext(runtime, { template: childTemplate });
    const impulses = await resolver.resolve(ctx);
    expect(impulses).toHaveLength(1);
    expect(impulses[0]!.metadata.shape).toBe("activityExecutionSummary");
    const content = impulses[0]!.content as { templateId: string; taskCount: number; status: string };
    expect(content.templateId).toBe("child_tpl");
    expect(content.taskCount).toBe(1);
    expect(content.status).toBe("completed");
  });

  test("resolves templateId via templateProvider", async () => {
    const provider: TemplateProvider = {
      async getTemplate(id: string) {
        return id === "child_tpl" ? childTemplate : null;
      },
    };
    const { runtime } = makeRuntimeAndExecutor(provider);
    const resolver = runtime.resolvers.get("activity")!;
    const ctx = makeContext(runtime, { templateId: "child_tpl" });
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.shape).toBe("activityExecutionSummary");
    expect((impulses[0]!.content as { templateId: string }).templateId).toBe("child_tpl");
  });

  test("returns error impulse when neither template nor templateId provided", async () => {
    const { runtime } = makeRuntimeAndExecutor();
    const resolver = runtime.resolvers.get("activity")!;
    const ctx = makeContext(runtime, {});
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.shape).toBe("activityExecutionError");
    expect((impulses[0]!.content as { error: string }).error).toContain("missing template");
  });

  test("returns error impulse when templateId unresolvable", async () => {
    const provider: TemplateProvider = { async getTemplate() { return null; } };
    const { runtime } = makeRuntimeAndExecutor(provider);
    const resolver = runtime.resolvers.get("activity")!;
    const ctx = makeContext(runtime, { templateId: "missing" });
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.shape).toBe("activityExecutionError");
  });

  test("recursion guard fires when compositionChain meets maxDepth", async () => {
    const { runtime } = makeRuntimeAndExecutor();
    const resolver = runtime.resolvers.get("activity")!;
    const ctx: ResolverContext = {
      ...makeContext(runtime, { template: childTemplate, maxDepth: 3 }),
      compositionChain: ["e1", "e2", "e3"], // depth = 3, equals cap
    };
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.shape).toBe("activityExecutionError");
    expect((impulses[0]!.content as { error: string }).error).toContain("max recursion depth");
  });

  test("child compositionChain extends parent's chain", async () => {
    const { runtime } = makeRuntimeAndExecutor();
    const resolver = runtime.resolvers.get("activity")!;
    const ctx: ResolverContext = {
      ...makeContext(runtime, { template: childTemplate }),
      compositionChain: ["root"],
    };
    const impulses = await resolver.resolve(ctx);
    // Success means depth-guard passed (depth=1 < default 10) — chain
    // extension happens inside executor.execute, observable indirectly via
    // the trace's nested-execution emission. The smoke check here is just
    // that we didn't hit the cap.
    expect(impulses[0]!.metadata.shape).toBe("activityExecutionSummary");
  });

  test("parent-attribution override absent → child parent = context.executionId", async () => {
    const { runtime, executor } = makeRuntimeAndExecutor();
    const seen: Array<{ parentExecutionId?: string; compositionChain?: string[] }> = [];
    const origExecute = executor.execute.bind(executor);
    executor.execute = ((tpl: ActivityTemplate, opts: { parentExecutionId?: string; compositionChain?: string[] } = {}) => {
      seen.push({ parentExecutionId: opts.parentExecutionId, compositionChain: opts.compositionChain });
      return origExecute(tpl, opts as never);
    }) as typeof executor.execute;
    const resolver = runtime.resolvers.get("activity")!;
    const ctx: ResolverContext = {
      ...makeContext(runtime, { template: childTemplate }),
      compositionChain: ["root"],
    };
    await resolver.resolve(ctx);
    expect(seen[0]!.parentExecutionId).toBe("exec_parent");
    expect(seen[0]!.compositionChain).toEqual(["root", "exec_parent"]);
  });

  test("parent-attribution override present → child gets overridden parent + chain", async () => {
    const { runtime, executor } = makeRuntimeAndExecutor();
    const seen: Array<{ parentExecutionId?: string; compositionChain?: string[] }> = [];
    const origExecute = executor.execute.bind(executor);
    executor.execute = ((tpl: ActivityTemplate, opts: { parentExecutionId?: string; compositionChain?: string[] } = {}) => {
      seen.push({ parentExecutionId: opts.parentExecutionId, compositionChain: opts.compositionChain });
      return origExecute(tpl, opts as never);
    }) as typeof executor.execute;
    const resolver = runtime.resolvers.get("activity")!;
    const ctx: ResolverContext = {
      ...makeContext(runtime, {
        template: childTemplate,
        parentExecutionId: "consuming_exec",
        compositionChain: ["grand", "consuming_exec_ancestor"],
      }),
      compositionChain: ["root"], // overridden by config.compositionChain
    };
    await resolver.resolve(ctx);
    expect(seen[0]!.parentExecutionId).toBe("consuming_exec");
    // depth measured from effective (override) chain; child chain appends the override parent
    expect(seen[0]!.compositionChain).toEqual(["grand", "consuming_exec_ancestor", "consuming_exec"]);
  });

  test("inline template wins over templateId", async () => {
    const provider: TemplateProvider = {
      async getTemplate() {
        return { id: "other", name: "O", tasks: [] };
      },
    };
    const { runtime } = makeRuntimeAndExecutor(provider);
    const resolver = runtime.resolvers.get("activity")!;
    const ctx = makeContext(runtime, { template: childTemplate, templateId: "other" });
    const impulses = await resolver.resolve(ctx);
    expect((impulses[0]!.content as { templateId: string }).templateId).toBe("child_tpl");
  });
});
