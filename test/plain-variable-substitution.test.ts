/**
 * Commit A — plain {{name}} substitution from the run's variables, pre-dispatch.
 *
 * Measured: a draft-gap-closing-shaped chain (read_scenario -> fetch_traces ->
 * analyze -> write_report) ships every one of these literal, EXACTLY because
 * nothing ever substituted a plain `{{<taskId>_text}}` token into task.config
 * before a resolver ran: analyze's `config.prompt` kept the literal
 * `{{read_scenario_text}}` / `{{fetch_traces_text}}` tokens, and write_report's
 * `config.content` kept the literal `{{analyze_text}}` token. For resolvers
 * dispatched externally via VesselResolver, `ctx.task.config` is forwarded
 * AS-IS (vessel-resolver.ts), so the literal survived all the way into the
 * real write/send. engine.ts's pre-dispatch pass now substitutes plain
 * `{{name}}` tokens from accumulatedVariables (the SAME map every resolver
 * reads as `ctx.variables`) into task.config, including `config.prompt` —
 * BEFORE any resolver runs. `{{lifecycle.*}}` and `{{impulse:*}}` keep their
 * own existing resolution; dispatcher-style resolvers (llm-prompt, compose,
 * compose_parallel, iteration, activity) keep their nested spec untouched.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

function makeRuntime() {
  return new ExecutionRuntime({
    clock: new SteppingClock(3_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
}

describe("plain {{name}} substitution from run variables, pre-dispatch", () => {
  test("must-fail: a draft-gap-closing-shaped chain substitutes analyze's prompt AND write_report's content from prior task outputs (not the literal placeholders)", async () => {
    const analyzeCalls: unknown[] = [];
    const writeCalls: unknown[] = [];
    const runtime = makeRuntime();

    runtime.resolvers.register({
      id: "fs_read_fake",
      tier: "external",
      async resolve(ctx) {
        return [{ id: ctx.random.id("imp"), pointer: { type: "fs_read" }, metadata: { shape: "fs_read" }, loaded: true, content: "SCENARIO_DATA" }];
      },
    });
    runtime.resolvers.register({
      id: "http_fetch_fake",
      tier: "external",
      async resolve(ctx) {
        return [{ id: ctx.random.id("imp"), pointer: { type: "http_fetch" }, metadata: { shape: "http_fetch" }, loaded: true, content: "TRACE_DATA" }];
      },
    });
    runtime.resolvers.register({
      id: "llm_completion_dispatch_fake",
      tier: "external",
      async resolve(ctx) {
        analyzeCalls.push(ctx.task.config);
        return [{ id: ctx.random.id("imp"), pointer: { type: "llm_completion_dispatch" }, metadata: { shape: "llm_completion_dispatch" }, loaded: true, content: "ANALYSIS_RESULT" }];
      },
    });
    runtime.resolvers.register({
      id: "fs_write_fake",
      tier: "external",
      async resolve(ctx) {
        writeCalls.push(ctx.task.config);
        return [{ id: ctx.random.id("imp"), pointer: { type: "fs_write" }, metadata: { shape: "fs_write" }, loaded: true, content: "written" }];
      },
    });
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "gap-closing:plain-var-substitution",
      name: "read -> analyze -> write_report",
      tasks: [
        { id: "read_scenario", description: "read", resolver: "fs_read_fake", config: { type: "fs_read", path: "/workspace/x.json" } },
        { id: "fetch_traces", description: "fetch", resolver: "http_fetch_fake", config: { type: "http_fetch", url: "http://x" } },
        {
          id: "analyze",
          description: "analyze",
          resolver: "llm_completion_dispatch_fake",
          config: {
            type: "llm_completion_dispatch",
            prompt: "Scenario: {{read_scenario_text}}\nTraces: {{fetch_traces_text}}",
          },
        },
        {
          id: "write_report",
          description: "write the report",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "{{analyze_text}}" },
        },
      ],
    };

    const trace = await executor.execute(template, {});

    expect(trace.status).toBe("completed");
    expect(analyzeCalls).toEqual([
      { type: "llm_completion_dispatch", prompt: "Scenario: SCENARIO_DATA\nTraces: TRACE_DATA" },
    ]);
    expect(writeCalls).toEqual([
      { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "ANALYSIS_RESULT" },
    ]);
  });

  test("control: {{lifecycle.*}} and {{impulse:<slot>}} placeholders in the SAME config still resolve exactly as before, alongside a plain {{name}} substitution", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register({
      id: "produce_slot",
      tier: "deterministic",
      async resolve(ctx) {
        return [{ id: ctx.random.id("imp"), pointer: { type: "memo" }, metadata: { shape: "produced", outputImpulseKey: "my_slot" }, loaded: true, content: "SLOT_VALUE" }];
      },
    });
    runtime.resolvers.register({
      id: "fs_write_fake",
      tier: "external",
      async resolve(ctx) {
        calls.push(ctx.task.config);
        return [{ id: ctx.random.id("imp"), pointer: { type: "fs_write" }, metadata: { shape: "fs_write" }, loaded: true, content: "written" }];
      },
    });
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "control-lifecycle-and-impulse-and-plain",
      name: "mixed placeholders",
      tasks: [
        { id: "produce", description: "produce", resolver: "produce_slot", outputShapes: ["produced"] },
        {
          id: "write_report",
          description: "write",
          resolver: "fs_write_fake",
          config: {
            type: "fs_write",
            path: "/workspace/x.json",
            content: "slot={{impulse:my_slot}} name={{produce_text}}",
          },
        },
      ],
    };

    const trace = await executor.execute(template, {});

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([
      { type: "fs_write", path: "/workspace/x.json", content: "slot=SLOT_VALUE name=SLOT_VALUE" },
    ]);
  });

  test("control: an `iteration` task's nested body config (its OWN {{elementVar}} placeholder) is left untouched by the run-variable substitution pass", async () => {
    const runtime = makeRuntime();
    const elementCalls: unknown[] = [];
    runtime.resolvers.register({
      id: "record_element",
      tier: "deterministic",
      async resolve(ctx) {
        elementCalls.push(ctx.task.config);
        return [{ id: ctx.random.id("imp"), pointer: { type: "memo" }, metadata: { shape: "element" }, loaded: true, content: "ok" }];
      },
    });
    const { makeIterationResolver } = await import("../src/resolvers/iteration");
    runtime.resolvers.register(makeIterationResolver((id) => runtime.resolvers.get(id)));
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "control-iteration-body-untouched",
      name: "iteration",
      tasks: [
        {
          id: "iterate",
          description: "iterate",
          resolver: "iteration",
          config: { over: '["a","b"]', elementVar: "x", body: { resolver: "record_element", config: { name: "{{x}}" } } },
          outputShapes: ["iteration_result"],
        },
      ],
    };

    const trace = await executor.execute(template, {});
    expect(trace.status).toBe("completed");
    // The iteration resolver's OWN per-element {{x}} binding still ran correctly —
    // proof the outer run-variable substitution pass did not consume/corrupt it.
    expect(elementCalls).toEqual([{ name: "a" }, { name: "b" }]);
  });
});
