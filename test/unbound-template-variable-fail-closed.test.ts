/**
 * Unbound plain {{name}} template variables are COUNTED, not refused.
 *
 * A plain {{name}} the template author wrote that cannot be bound before dispatch
 * (a cross-task `<taskId>_text` reference whose producer never ran, or a request-level
 * variable nobody supplied) is recorded on the task's ExecutionTaskRecord as
 * `unboundTemplateVariables`. Dispatch proceeds as it did before plain substitution
 * existed, with the token literal, so a reach judge or the ribosome grades the run
 * rather than the engine refusing it. (This file previously asserted a fail-closed
 * throw; qa ruled count-don't-throw.)
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
  test("must-fail: a write_report-style fs_write task whose content is {{analyze_text}} (truly unbound) dispatches with the token literal and records unboundTemplateVariables", async () => {
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
          config: { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "{{analyze_text}} / {{missing_too}} / {{analyze_text}}" },
        },
      ],
    };

    const trace = await executor.execute(template, {});

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([
      { type: "fs_write", path: "/workspace/proposals/x-report.json", content: "{{analyze_text}} / {{missing_too}} / {{analyze_text}}" },
    ]);
    const rec = trace.tasks.find((t) => t.taskId === "write_report");
    expect(rec?.success).toBe(true);
    expect(rec?.unboundTemplateVariables).toEqual(["analyze_text", "missing_too"]);
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
    expect(trace.tasks.every((t) => t.unboundTemplateVariables === undefined)).toBe(true);
  });
});
