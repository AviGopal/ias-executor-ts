/**
 * llm-prompt resolver tests.
 *
 * Covers the minibob-template bridge: task.prompt.template + {{var}}
 * interpolation → LLMPort.generate → llmText impulse.
 */
import { describe, expect, test } from "bun:test";
import { makeLLMPromptResolver, _interpolate } from "../src/resolvers/llm-prompt";
import type { LLMPort } from "../src/ports";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";

class CapturingLLM implements LLMPort {
  public lastInput: { prompt: string; systemPrompt?: string } | null = null;
  public response: string;
  constructor(response = "ok") { this.response = response; }
  async generate(input: { prompt: string; systemPrompt?: string }): Promise<string> {
    this.lastInput = input;
    return this.response;
  }
}

function makeContext(
  task: Record<string, unknown>,
  variables: Record<string, unknown> = {},
): ResolverContext & { eventSpy: EventSinkSpy } {
  const eventSpy = new EventSinkSpy();
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: eventSpy,
  });
  return {
    executionId: "exec_test",
    template: { id: "t", name: "Test", tasks: [task as never] },
    task: task as never,
    variables,
    inputImpulses: [],
    store: runtime.store,
    clock: runtime.clock,
    random: runtime.random,
    eventSink: runtime.eventSink,
    traceSink: runtime.traceSink,
    attachedVessels: runtime.attachedVessels,
    eventSpy,
  };
}

describe("interpolate", () => {
  test("simple {{var}} substitution", () => {
    expect(_interpolate("hello {{name}}", { name: "world" })).toBe("hello world");
  });

  test("dotted-path {{a.b.c}} substitution", () => {
    expect(_interpolate("k={{ctx.user.name}}", { ctx: { user: { name: "alice" } } })).toBe("k=alice");
  });

  test("unresolved placeholders remain literal", () => {
    expect(_interpolate("a {{missing}} b", { other: 1 })).toBe("a {{missing}} b");
  });

  test("number / boolean / object values stringify cleanly", () => {
    expect(_interpolate("{{n}}/{{b}}/{{o}}", { n: 42, b: true, o: { x: 1 } })).toBe('42/true/{"x":1}');
  });

  test("multiple occurrences of the same variable", () => {
    expect(_interpolate("{{g}} and {{g}}", { g: "hi" })).toBe("hi and hi");
  });
});

describe("makeLLMPromptResolver", () => {
  test("reads task.prompt.template, interpolates, dispatches to LLMPort, emits llmText impulse", async () => {
    const llm = new CapturingLLM("the answer");
    const resolver = makeLLMPromptResolver(llm);
    const context = makeContext(
      {
        id: "task-1",
        description: "analyse",
        resolver: null,
        prompt: { template: "Analyse {{goal}}", maxTokens: 1000 },
      },
      { goal: "do the thing" },
    );
    const impulses = await resolver.resolve(context);
    expect(llm.lastInput?.prompt).toBe("Analyse do the thing");
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.metadata.shape).toBe("llmText");
    expect(impulses[0]!.content).toBe("the answer");
  });

  test("forwards systemPrompt when set on task.prompt.systemPrompt", async () => {
    const llm = new CapturingLLM();
    const resolver = makeLLMPromptResolver(llm);
    const context = makeContext({
      id: "t", description: "", resolver: null,
      prompt: { template: "p", systemPrompt: "you are helpful" },
    });
    await resolver.resolve(context);
    expect(llm.lastInput?.systemPrompt).toBe("you are helpful");
  });

  test("throws when task.prompt.template is missing", async () => {
    const llm = new CapturingLLM();
    const resolver = makeLLMPromptResolver(llm);
    const context = makeContext({ id: "t", description: "", resolver: null });
    await expect(resolver.resolve(context)).rejects.toThrow(/requires task.prompt.template/);
  });

  test("injects resolved inputImpulses as {{shapeName}} variables (vars win on collision)", async () => {
    const llm = new CapturingLLM("result");
    const resolver = makeLLMPromptResolver(llm);
    const context = makeContext(
      { id: "t", description: "", resolver: null, prompt: { template: "report: {{failureModeReport}} goal: {{goal}}" } },
      { goal: "find gaps", failureModeReport: "override-wins" },
    );
    // Add a loaded impulse with shape failureModeReport — should be shadowed by the explicit variable
    (context.inputImpulses as unknown[]).push({
      id: "imp_1",
      pointer: { type: "memo" },
      metadata: { shape: "failureModeReport", summary: "..." },
      loaded: true,
      content: "impulse-content-should-not-appear",
    });
    // Add a second impulse with a different shape — should be injected
    (context.inputImpulses as unknown[]).push({
      id: "imp_2",
      pointer: { type: "memo" },
      metadata: { shape: "coverageReport", summary: "..." },
      loaded: true,
      content: "coverage-data",
    });
    const impulses = await resolver.resolve(context);
    // explicit variable wins over impulse: "report: override-wins goal: find gaps"
    expect(llm.lastInput?.prompt).toContain("report: override-wins");
    expect(llm.lastInput?.prompt).toContain("goal: find gaps");
    expect(impulses[0]!.metadata.shape).toBe("llmText");
  });

  test("inputImpulse content available as {{shapeName}} when no variable collision", async () => {
    const llm = new CapturingLLM("done");
    const resolver = makeLLMPromptResolver(llm);
    const context = makeContext(
      { id: "t", description: "", resolver: null, prompt: { template: "data: {{myReport}}" } },
      {},
    );
    (context.inputImpulses as unknown[]).push({
      id: "imp_1",
      pointer: { type: "memo" },
      metadata: { shape: "myReport", summary: "..." },
      loaded: true,
      content: "the-report-body",
    });
    await resolver.resolve(context);
    expect(llm.lastInput?.prompt).toBe("data: the-report-body");
  });

  test("resolver id is 'llm-prompt' (distinct from 'llm')", () => {
    const resolver = makeLLMPromptResolver(new CapturingLLM());
    expect(resolver.id).toBe("llm-prompt");
    expect(resolver.tier).toBe("llm");
  });

  test("emits lifecycle:llm:dispatched with rendered prompt and input impulse metadata", async () => {
    const llm = new CapturingLLM("result");
    const resolver = makeLLMPromptResolver(llm);
    const ctx = makeContext(
      { id: "task-audit", description: "", resolver: null, prompt: { template: "data: {{myReport}}" } },
      {},
    );
    (ctx.inputImpulses as unknown[]).push({
      id: "imp_audit",
      pointer: { type: "memo" },
      metadata: { shape: "myReport", summary: "..." },
      loaded: true,
      content: "the-report",
    });
    await resolver.resolve(ctx);
    const events = ctx.eventSpy.ofType("lifecycle:llm:dispatched");
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.data["executionId"]).toBe("exec_test");
    expect(ev.data["taskId"]).toBe("task-audit");
    expect(ev.data["templateId"]).toBe("t");
    expect(ev.data["renderedPrompt"]).toBe("data: the-report");
    expect(ev.data["inputImpulseIds"]).toEqual(["imp_audit"]);
    expect(ev.data["inputShapes"]).toEqual(["myReport"]);
  });
});
