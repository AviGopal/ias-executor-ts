/**
 * Commit B — FAIL CLOSED on whatever {{name}} remains unbound after commit A's
 * substitution pass, BEFORE any resolver dispatches.
 *
 * Commit A substitutes every plain {{name}} it can resolve from the run's
 * variables (accumulatedVariables), including inside config.prompt. Anything
 * still literal after that is a genuine unbound binding — a cross-task
 * `<taskId>_text` reference whose producer never ran (or never produced
 * output), or a request-level variable nobody supplied. Previously that
 * literal token shipped straight to the resolver: a VesselResolver-routed
 * task forwards task.config AS-IS, so the literal became real written/sent
 * content. This closes the task BEFORE dispatch instead, with
 * `unbound_template_variable:<name>`.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

function makeRuntime() {
  return new ExecutionRuntime({
    clock: new SteppingClock(2_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
}

describe("unbound required template variable — fail closed before dispatch", () => {
  test("must-fail: write_report-style fs_write task whose content is {{analyze_text}} (truly unbound — no analyze task ran) fails closed and never calls fs_write", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    const fsWrite: Resolver = {
      id: "fs_write_fake",
      tier: "external",
      async resolve(ctx) {
        calls.push(ctx.task.config);
        return [{ id: ctx.random.id("out"), pointer: { type: "fs_write" }, metadata: { shape: "fs_write" }, loaded: true, content: "written" }];
      },
    };
    runtime.resolvers.register(fsWrite);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "gap-closing:must-fail-unbound",
      name: "write_report with an unbound {{analyze_text}}",
      tasks: [
        {
          id: "write_report",
          description: "write the analysis report",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "{{analyze_text}}" },
        },
      ],
    };

    const trace = await executor.execute(template, {});

    // fs_write was NEVER invoked — the literal placeholder never reached the resolver.
    expect(calls).toEqual([]);
    expect(trace.status).toBe("failed");
    const rec = trace.tasks.find((t) => t.taskId === "write_report");
    expect(rec?.success).toBe(false);
    expect(rec?.error).toBe("unbound_template_variable:analyze_text");
  });

  test("control: an {{impulse:<slot>}} placeholder that IS bound still interpolates exactly as before and dispatches", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    const produce: Resolver = {
      id: "produce_analysis",
      tier: "deterministic",
      async resolve(ctx) {
        return [{
          id: ctx.random.id("imp"),
          pointer: { type: "memo" },
          metadata: { shape: "analyze", outputImpulseKey: "analyze_slot" },
          loaded: true,
          content: "the real analysis text",
        }];
      },
    };
    const fsWrite: Resolver = {
      id: "fs_write_fake",
      tier: "external",
      async resolve(ctx) {
        calls.push(ctx.task.config);
        return [{ id: ctx.random.id("out"), pointer: { type: "fs_write" }, metadata: { shape: "fs_write" }, loaded: true, content: "written" }];
      },
    };
    runtime.resolvers.register(produce);
    runtime.resolvers.register(fsWrite);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "gap-closing:control-bound-impulse-slot",
      name: "write_report with a BOUND {{impulse:analyze_slot}}",
      tasks: [
        { id: "analyze", description: "analyze", resolver: "produce_analysis", outputShapes: ["analyze"] },
        {
          id: "write_report",
          description: "write the analysis report",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "{{impulse:analyze_slot}}" },
        },
      ],
    };

    const trace = await executor.execute(template, {});

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([
      { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "the real analysis text" },
    ]);
  });
});
