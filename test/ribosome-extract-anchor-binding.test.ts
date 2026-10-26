/**
 * Commit C — ribosome-extract.json's dispatch_write_attempt binds a REAL anchor.
 *
 * Measured: `anchor` is not a declared template variable
 * (src/templates/lifecycle/ribosome-extract.json `variables: []` lists only
 * qualityThreshold, applyExtraction, synthesisMaxTokens, lifecycle — no
 * anchor), and nothing in the lifecycle-subscriber dispatch path ever supplies
 * one. So in a REAL dispatch (no caller manually seeding an `anchor` variable,
 * which test/ribosome-extract-write-contract.test.ts's harness happened to do
 * for an unrelated reason), `{{anchor}}` was a silently-unbound placeholder:
 * every real `activityTemplate_write` call shipped the literal string
 * "{{anchor}}" as its anchor field — the exact ghost-write class commits A/B
 * exist to catch. Now that commit B fails closed on a genuinely-unbound plain
 * variable, this would turn into a hard failure on EVERY real
 * dispatch_write_attempt, with no write ever landing.
 *
 * Fix: bind `anchor` to `{{lifecycle.executionId}}` — the identifier this
 * chain already keys its own trace-signature read on (acquire_trace_signature,
 * same file), and the one thing it genuinely has at dispatch time that names
 * "the live execution this extraction is anchored to".
 */
import { afterEach, describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { Impulse } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { makeImpulseResolveResolver } from "../src/resolvers/impulse-resolve";
import { makeValidationResolver } from "../src/resolvers/validation";
import { loadTemplate } from "../src/templates";
import { SequentialRandom, SteppingClock } from "./fakes";

const realFetch = globalThis.fetch;

const TRACE = { tasks: [{ id: "t1", resolver: "fs_read", config: { paths: ["/x"] } }] };

const CLEAN = {
  id: "learned-parent",
  name: "Learned parent",
  description: "Reads a file and reports it.",
  category: "tool",
  version: "0.1.0",
  tags: ["ribosome.extracted", "lifecycle.driven"],
  input_shapes: ["goal"],
  output_shapes: ["report"],
  tasks: [{ id: "t1", description: "read", resolver: "fs_read", config: { paths: ["/x"] }, inputShapes: ["goal"], outputShapes: ["report"] }],
  metadata: { author: "ribosome-pattern", extracted_from: "exec_parent", sourceExecutionId: "exec_parent" },
};

/** Real dispatch shape: NO `anchor` variable supplied — only what the
 *  lifecycle-subscriber dispatcher actually provides (applyExtraction + the
 *  triggering lifecycle payload). This is what distinguishes this file from
 *  ribosome-extract-write-contract.test.ts's harness. */
function run() {
  const writes: Array<{ pointer: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const { pointer } = JSON.parse(init?.body as string) as { pointer: Record<string, unknown> };
    if (pointer.type === "executionTraceWithSignatures") {
      return new Response(JSON.stringify({ content: TRACE }), { status: 200 });
    }
    if (pointer.type === "activityTemplate_write") {
      writes.push({ pointer });
      return new Response(JSON.stringify({ content: { id: (pointer.templateData as Record<string, unknown> | undefined)?.id, status: "template proposed" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const llm: Resolver = {
    id: "llm_completion_dispatch",
    tier: "llm",
    async resolve(ctx) {
      const byTask: Record<string, unknown> = {
        assess_quality: { score: 0.9, extractionEligible: true },
        synthesize_template: JSON.stringify(CLEAN),
        emit_summary: { learning_summary: "ran", qualityScore: 0.9 },
      };
      return [{ id: ctx.random.id("llm"), pointer: { type: "memo" }, metadata: {}, loaded: true, content: byTask[ctx.task.id] ?? {} }];
    },
  };
  const noop: Resolver = {
    id: "noop",
    tier: "deterministic",
    async resolve(ctx) {
      return [{ id: ctx.random.id("noop"), pointer: { type: "memo" }, metadata: {}, loaded: true, content: { ok: true } }];
    },
  };
  const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
  runtime.resolvers.register(makeImpulseResolveResolver({ activityApiEndpoint: "http://activity-api.test", activityApiKey: "k" }));
  runtime.resolvers.register(makeValidationResolver());
  runtime.resolvers.register(llm);
  runtime.resolvers.register(noop);
  const executor = new ActivityExecutor(runtime);
  const template = loadTemplate("ribosome-extract");
  if (!template) throw new Error("ribosome-extract template not shipped");
  const lifecycle = {
    executionId: "exec_the_real_live_execution",
    templateId: "parent",
    templateName: "Parent",
    templateAuthor: "operator",
    taskCount: 1,
    outputShapes: ["report"],
    goalSignature: "sig",
    qualityEligible: "true",
    status: "completed",
    depth: 0,
    impulseCount: 2,
    costUsd: 0,
    durationMs: 10,
    hasGoalContext: true,
  };
  // Real dispatch shape: no `anchor` in variables.
  return executor
    .execute(template, { variables: { applyExtraction: true, lifecycle } })
    .then((trace) => {
      const outputs = trace.outputImpulseIds
        .map((id) => runtime.store.get(id))
        .filter((i): i is Impulse => i !== undefined);
      const shapes = outputs.map((i) => i.metadata.shape);
      return { trace, writes, shapes };
    });
}

describe("ribosome-extract: dispatch_write_attempt binds a real anchor", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("must-fail: a real dispatch (no `anchor` variable supplied) sends the write with the REAL anchor — the triggering execution id, not a literal placeholder", async () => {
    const r = await run();
    expect(r.writes.length).toBe(1);
    expect(r.writes[0]!.pointer.anchor).toBe("exec_the_real_live_execution");
    expect(r.shapes).toContain("activityTemplate");
  });
});
