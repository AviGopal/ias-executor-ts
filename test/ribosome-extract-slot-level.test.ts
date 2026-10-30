/**
 * ribosome-extract writes a learned template only when its tasks carry SLOTS, not
 * the run it was extracted from.
 *
 * Measured on two minted memoryNote_write compositions: a write task's config
 * carried the source note's title and body as literals, the source dispatch's id,
 * whole upstream impulse payloads inlined under their shape's name, and an object
 * KEY built from the goal sentence. Replayed on a new goal, such a template
 * re-writes the old record. The trace the synthesis reads records BOUND configs,
 * so (a) the synthesis prompt asks for slots and (b) validate_proposal (rule
 * activity_template_write_contract) refuses a proposal that still carries the run.
 *
 * The proposals below copy those templates' STRUCTURE with synthetic values. Runs
 * the REAL shipped template on the engine with the real impulse-resolve and
 * validation resolvers; only the LLM completions, the noop proxy and activity-api
 * (fetch) are stubbed.
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

const TRACE = { tasks: [{ id: "compose-step-1", resolver: "memoryNote_write", config: { type: "memoryNote_write" } }] };

const BASE_PROPOSAL = {
  id: "learned-composition-synthetic-write",
  name: "Synthetic composition",
  description: "Writes a note and reads it back.",
  category: "tool",
  version: "0.1.0",
  tags: ["ribosome.extracted", "lifecycle.driven"],
  input_shapes: [],
  output_shapes: ["memoryNote_write", "memoryNote"],
  metadata: { author: "ribosome-pattern", extracted_from: "exec_parent", sourceExecutionId: "exec_parent" },
};

const readBack = { id: "compose-step-1-read-back", description: "read the note back", resolver: "memoryNote", config: { type: "memoryNote" }, inputShapes: [], outputShapes: ["memoryNote"] };

/** A memoryNote_write task with the given config (slot-level unless the case adds a literal). */
function writeTask(config: Record<string, unknown>, inputShapes: string[] = []) {
  return { id: "compose-step-1", description: "write the note", resolver: "memoryNote_write", config: { type: "memoryNote_write", ...config }, inputShapes, outputShapes: ["memoryNote_write"] };
}
function proposal(tasks: unknown[]) {
  return { ...BASE_PROPOSAL, tasks };
}

const SLOT_WRITE = { title: "{{goal}}", body: "{{impulse:llm_completion_dispatch}}" };
const INLINED_LLM = { shape: "llmTextCompletion", success: true, body: { model: "synthetic-model", text: "synthetic answer text", usage: { cost_usd: 0.0001 } } };
const INLINED_SHELL = { shape: "shellResult", exit_code: 0, stderr: "", stdout: "synthetic stdout line" };
/** A key built from a sentence, as the minted template's composed-deliverable key was (synthetic words). */
const SENTENCE_KEY = "synthkey_keep_the_widget_colour_note_for_the_next_review_x";

function run(p: Record<string, unknown>) {
  const writes: Array<{ templateData: Record<string, unknown> }> = [];
  const prompts: Record<string, string> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const { pointer } = JSON.parse(init?.body as string) as { pointer: Record<string, unknown> };
    if (pointer.type === "executionTraceWithSignatures") return new Response(JSON.stringify({ content: TRACE }), { status: 200 });
    if (pointer.type === "activityTemplate_write") {
      const td = pointer.templateData as Record<string, unknown>;
      writes.push({ templateData: td });
      return new Response(JSON.stringify({ content: { id: td.id, status: "template proposed" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;

  const llm: Resolver = {
    id: "llm_completion_dispatch",
    tier: "llm",
    async resolve(ctx) {
      prompts[ctx.task.id] = String((ctx.task.config as Record<string, unknown> | undefined)?.["prompt"] ?? "");
      const byTask: Record<string, unknown> = {
        assess_quality: { score: 0.9, extractionEligible: true },
        synthesize_template: JSON.stringify(p),
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
  const template = loadTemplate("ribosome-extract");
  if (!template) throw new Error("ribosome-extract template not shipped");
  const lifecycle = {
    executionId: "exec_parent",
    templateId: "composition-synthetic-write",
    templateName: "Composition",
    templateAuthor: "operator",
    taskCount: 2,
    outputShapes: ["memoryNote_write", "memoryNote"],
    goalSignature: "sig",
    qualityEligible: "true",
    status: "completed",
    depth: 0,
    impulseCount: 2,
    costUsd: 0,
    durationMs: 10,
    hasGoalContext: true,
  };
  return new ActivityExecutor(runtime)
    .execute(template, { variables: { applyExtraction: true, lifecycle } })
    .then((trace) => {
      const outputs = trace.outputImpulseIds.map((id) => runtime.store.get(id)).filter((i): i is Impulse => i !== undefined);
      const shapes = outputs.map((i) => i.metadata.shape);
      const validation = outputs.find((i) => i.metadata.shape === "validation_result")?.content as
        | { passed: boolean; details?: { refusals?: string[] } }
        | undefined;
      const ran = (id: string) => trace.tasks.some((t) => t.taskId === id && !t.skipped && t.success);
      return { writes, shapes, validation, ran, prompts };
    });
}

/** A refused proposal: no write, the refusal names the kind at its path, and the summary still runs. */
async function expectRefused(p: Record<string, unknown>, ...kindAtPath: string[]) {
  const r = await run(p);
  expect(r.writes).toEqual([]);
  expect(r.validation?.passed).toBe(false);
  const refusals = (r.validation?.details?.refusals ?? []).join(" ");
  for (const k of kindAtPath) expect(refusals).toContain(k);
  expect(r.ran("emit_summary")).toBe(true);
  expect(r.shapes).toContain("learningSummary");
  expect(r.shapes).not.toContain("activityTemplate");
}

/** A written proposal: one write, carrying the proposal's tasks unchanged. */
async function expectWrittenUnchanged(p: { tasks: unknown[] }) {
  const r = await run(p as Record<string, unknown>);
  expect(r.validation?.passed).toBe(true);
  expect(r.writes.length).toBe(1);
  expect(r.writes[0]!.templateData.tasks).toEqual(p.tasks);
  expect(r.shapes).toContain("activityTemplate");
}

describe("ribosome-extract: a learned template carries slots, not its source run", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("[MUST-FAIL] a write task carrying the source dispatch's id is refused before the write", async () => {
    await expectRefused(proposal([writeTask({ ...SLOT_WRITE, dispatch_id: "d0000000-0000-4000-8000-000000000000" }), readBack]),
      "tasks_slot_level", "run-id@compose-step-1.config.dispatch_id");
  });

  test("[MUST-FAIL] upstream payloads inlined under their shape's name are refused before the write", async () => {
    await expectRefused(proposal([writeTask({ ...SLOT_WRITE, llm_completion_dispatch: INLINED_LLM, shellResult: INLINED_SHELL }, ["shellResult", "llm_completion_dispatch"]), readBack]),
      "inlined-impulse@compose-step-1.config.llm_completion_dispatch", "inlined-impulse@compose-step-1.config.shellResult");
  });

  test("[MUST-FAIL] a write task's literal title and body (the source record) are refused before the write", async () => {
    await expectRefused(proposal([writeTask({ title: "Synthetic note title", body: "Synthetic note body text." }), readBack]),
      "write-content-literal@compose-step-1.config.title", "write-content-literal@compose-step-1.config.body");
  });

  test("[MUST-FAIL] a config KEY built from the goal sentence is refused before the write", async () => {
    await expectRefused(proposal([writeTask({ ...SLOT_WRITE, [SENTENCE_KEY]: "{{goal}}" }), readBack]),
      `goal-derived-key@compose-step-1.config.${SENTENCE_KEY}`);
  });

  test("[MUST-FAIL] the minted composition's full structure (shell -> llm -> write -> read-back) is refused, every kind named", async () => {
    await expectRefused(
      proposal([
        { id: "compose-step-1", description: "run the command", resolver: "shellResult", config: { type: "shellResult" }, inputShapes: [], outputShapes: ["shellResult"] },
        { id: "compose-step-2", description: "complete the text", resolver: "llm_completion_dispatch", config: { type: "llm_completion_dispatch" }, inputShapes: [], outputShapes: ["llm_completion_dispatch"] },
        { ...writeTask({ title: "Synthetic title", body: "Synthetic body.", content: "Synthetic body.", dispatch_id: "d1111111-1111-4111-8111-111111111111", llm_completion_dispatch: INLINED_LLM, shellResult: INLINED_SHELL, [SENTENCE_KEY]: "synthetic deliverable text" }, ["shellResult", "llm_completion_dispatch"]), id: "compose-step-3" },
        { ...readBack, id: "compose-step-3-read-back" },
      ]),
      "run-id@compose-step-3.config.dispatch_id", "inlined-impulse@compose-step-3.config.shellResult",
      "write-content-literal@compose-step-3.config.title", `goal-derived-key@compose-step-3.config.${SENTENCE_KEY}`,
    );
  });

  test("[MUST-FAIL] the synthesis prompt asks for slots, and its slot forms reach the model unbound", async () => {
    const r = await run(proposal([writeTask(SLOT_WRITE), readBack]));
    const prompt = r.prompts["synthesize_template"] ?? "";
    expect(prompt).not.toContain("Copy that field through to the task you emit, unchanged");
    expect(prompt).toContain("{{impulse:<that shape>}}");
    expect(prompt).toContain("{{goal}}");
    expect(prompt).toContain("tasks_slot_level");
  });

  test("CONTROL: legitimate constant config (paths, model, max_tokens, prompt) is written unchanged", async () => {
    await expectWrittenUnchanged({
      ...BASE_PROPOSAL,
      tasks: [
        { id: "t1", description: "read", resolver: "fs_read", config: { paths: ["/vessels/example/src"] }, inputShapes: ["goal"], outputShapes: ["fs_read"] },
        { id: "t2", description: "summarise", resolver: "llm_completion_dispatch", config: { type: "llm_completion_dispatch", model: "auto", max_tokens: 800, prompt: "Summarise {{impulse:fs_read}} for {{goal}}." }, inputShapes: ["fs_read"], outputShapes: ["llm_completion_dispatch"] },
      ],
    });
  });

  test("CONTROL: a slot-level write (title/body/upstream payload as {{...}} slots) is written unchanged", async () => {
    await expectWrittenUnchanged(proposal([writeTask({ ...SLOT_WRITE, shellResult: "{{impulse:shellResult}}" }, ["shellResult"]), readBack]));
  });

  test("CONTROL: a literal title on a NON-write task is a constant, and is written unchanged", async () => {
    await expectWrittenUnchanged(proposal([
      { id: "t1", description: "fetch", resolver: "http_fetch", config: { url: "http://example.test/report", method: "GET", title: "Weekly report" }, inputShapes: [], outputShapes: ["http_fetch"] },
    ]));
  });
});
