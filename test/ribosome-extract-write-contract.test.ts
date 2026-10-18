/**
 * ribosome-extract must check its proposal against the activityTemplate_write
 * contract BEFORE the write, and summarise the run whether or not it wrote.
 *
 * Measured: activity-api's zod rejected the LLM proposal ("Tags must be lowercase
 * alphanumeric with dots" on tags[0]; "description Required"), so write_result had
 * no id, dispatch_write_succeeded skipped, and emit_summary — which depended on it —
 * was skipped by dependency propagation. Neither activityTemplate nor
 * learningSummary was produced and the run read hollow.
 *
 * Runs the REAL shipped template on the engine with the real impulse-resolve and
 * validation resolvers. Only the LLM completions, the noop proxy, and activity-api
 * (fetch) are stubbed; the stub enforces the two zod rules that were measured.
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

/** The two zod rules measured rejecting live proposals (activity-api TagSchema + description). */
function zodErrors(td: Record<string, unknown>): string[] {
  const errs: string[] = [];
  if (typeof td.description !== "string") errs.push("description Required");
  for (const t of (td.tags as unknown[] | undefined) ?? []) {
    if (typeof t !== "string" || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(t)) {
      errs.push("Tags must be lowercase alphanumeric with dots");
    }
  }
  return errs;
}

function run(proposal: Record<string, unknown>) {
  const writes: Array<{ templateData: Record<string, unknown>; status: number }> = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const { pointer } = JSON.parse(init?.body as string) as { pointer: Record<string, unknown> };
    if (pointer.type === "executionTraceWithSignatures") {
      return new Response(JSON.stringify({ content: TRACE }), { status: 200 });
    }
    if (pointer.type === "activityTemplate_write") {
      const td = pointer.templateData as Record<string, unknown>;
      const errs = zodErrors(td);
      writes.push({ templateData: td, status: errs.length ? 400 : 200 });
      if (errs.length) return new Response(JSON.stringify({ success: false, error: errs.join("; ") }), { status: 400 });
      return new Response(JSON.stringify({ content: { id: td.id, status: "template proposed" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const llm: Resolver = {
    id: "llm_completion_dispatch",
    tier: "llm",
    async resolve(ctx) {
      const byTask: Record<string, unknown> = {
        assess_quality: { score: 0.9, extractionEligible: true },
        synthesize_template: JSON.stringify(proposal),
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
    executionId: "exec_parent",
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
  return executor
    .execute(template, { variables: { applyExtraction: true, anchor: "a", lifecycle } })
    .then((trace) => {
      const outputs = trace.outputImpulseIds
        .map((id) => runtime.store.get(id))
        .filter((i): i is Impulse => i !== undefined);
      const shapes = outputs.map((i) => i.metadata.shape);
      const validation = outputs.find((i) => i.metadata.shape === "validation_result")?.content as
        | { passed: boolean; error?: string; details?: { changes?: string[]; refusals?: string[] } }
        | undefined;
      const ran = (id: string) => trace.tasks.some((t) => t.taskId === id && !t.skipped && t.success);
      return { trace, writes, shapes, validation, ran };
    });
}

describe("ribosome-extract: the write contract is checked before the write", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("MUST-FAIL: tag 'Tag_X' and no description is refused before the write; the summary still runs", async () => {
    const { description: _omit, ...noDescription } = CLEAN;
    const r = await run({ ...noDescription, tags: ["Tag_X", "ribosome.extracted"] });
    // No write the store would 400 is ever sent — here, no write at all.
    expect(r.writes.filter((w) => w.status === 400)).toEqual([]);
    expect(r.writes).toEqual([]);
    expect(r.validation?.passed).toBe(false);
    expect(r.validation?.details?.refusals?.join(" ")).toContain("description");
    // A refused write must not skip the summary.
    expect(r.ran("emit_summary")).toBe(true);
    expect(r.shapes).toContain("learningSummary");
    expect(r.shapes).not.toContain("activityTemplate");
  });

  test("MUST-FAIL: an invalid tag with a description is normalised before the write, which then lands", async () => {
    const r = await run({ ...CLEAN, tags: ["Tag_X", "Ribosome.Extracted", "lifecycle.driven"] });
    expect(r.writes.map((w) => w.status)).toEqual([200]);
    expect(r.writes[0]!.templateData.tags).toEqual(["ribosome.extracted", "lifecycle.driven"]);
    expect(r.validation?.passed).toBe(true);
    expect(r.validation?.details?.changes?.join(" ")).toContain("Tag_X");
    expect(r.shapes).toContain("activityTemplate");
    expect(r.shapes).toContain("learningSummary");
  });

  test("control: a clean proposal is written, emit_summary runs, and the run reaches its declared outputs", async () => {
    const r = await run(CLEAN);
    expect(r.writes.map((w) => w.status)).toEqual([200]);
    expect(r.writes[0]!.templateData.id).toBe("learned-parent");
    expect(r.trace.status).toBe("completed");
    expect(r.ran("dispatch_write_succeeded")).toBe(true);
    expect(r.ran("emit_summary")).toBe(true);
    // Reached: every shape the template declares as its output was produced.
    for (const s of loadTemplate("ribosome-extract")!.output_shapes ?? []) expect(r.shapes).toContain(s);
  });
});
