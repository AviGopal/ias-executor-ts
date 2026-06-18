import type { ActivityTemplate, ExecutionTrace } from "../ontology";
import type { TemplateProvider, TraceSink, RecommendationProvider } from "../ports";

/**
 * ActivityApiTemplateProvider — fetches ActivityTemplates from activity-api.
 *
 * Calls GET /v2/activities/templates?id=<templateId>.  Strips embedding
 * vectors before returning (they're large and irrelevant to execution).
 * Returns null when the template is not found or the response is malformed.
 */
export class ActivityApiTemplateProvider implements TemplateProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async getTemplate(templateId: string): Promise<ActivityTemplate | null> {
    // Use the path-param route: GET /v2/activities/templates/:variantId
    const url = `${this.endpoint}/v2/activities/templates/${encodeURIComponent(templateId)}`;
    const res = await globalThis.fetch(url, {
      headers: { Authorization: `ApiKey ${this.apiKey}` },
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return null;
    }

    const raw = await res.json() as RawTemplate;
    try { await res.body?.cancel(); } catch { /* swallow */ }
    if (!raw?.id) return null;
    return mapTemplate(raw);
  }
}

/**
 * ActivityApiRecommendationProvider — queries /v2/activities/recommend.
 *
 * Returns templates sorted by Thompson Sampling score. Accepts an optional
 * expected_output_shapes array to pre-filter recommendations by shape.
 */
export class ActivityApiRecommendationProvider implements RecommendationProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async recommend(taskDescription: string, expectedOutputShapes?: string[]): Promise<ActivityTemplate[]> {
    const body: Record<string, unknown> = { task_description: taskDescription };
    if (expectedOutputShapes?.length) body.expected_output_shapes = expectedOutputShapes;

    const res = await globalThis.fetch(`${this.endpoint}/v2/activities/recommend`, {
      method: "POST",
      headers: {
        Authorization: `ApiKey ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return [];
    }

    const data = await res.json() as { recommendations?: RawTemplate[] };
    try { await res.body?.cancel(); } catch { /* swallow */ }
    return (data.recommendations ?? []).map(mapTemplate);
  }
}

/**
 * ActivityApiTraceSink — persists ExecutionTraces to activity-api.
 *
 * Calls POST /v2/activities/execution-traces.  Non-blocking on failure —
 * logs and continues rather than throwing, so trace loss never aborts execution.
 */
export class ActivityApiTraceSink implements TraceSink {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async record(trace: ExecutionTrace): Promise<void> {
    // Bounded retry with backoff. The sink is best-effort (never throws, so a
    // failed POST never aborts execution), but a SINGLE silent drop was the
    // dominant cause of orphaned parent traces: under activity-api load a
    // parent's trace POST returned 429/5xx and was discarded while its
    // lifecycle children (already posted) survived, leaving children whose
    // parent_execution_id resolves to nothing. That starved the composition
    // graph / lambda1 (only ~21 of 32K nested compositions became edges).
    // Re-POST after a non-OK is safe: activity-api UPSERTs by execution_id.
    const payload = mapTraceToApiBody(trace);
    const url = `${this.endpoint}/v2/activities/execution-traces`;
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await globalThis.fetch(url, {
          method: "POST",
          headers: {
            Authorization: `ApiKey ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          try { await res.body?.cancel(); } catch { /* swallow */ }
          return;
        }
        const text = await res.text().catch(() => "");
        try { await res.body?.cancel(); } catch { /* swallow */ }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === MAX_ATTEMPTS) {
          console.warn(`[ActivityApiTraceSink] trace POST failed (${res.status}) after ${attempt} attempt(s): ${text}`);
          return;
        }
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          console.warn(`[ActivityApiTraceSink] trace POST threw after ${attempt} attempt(s):`, err);
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Internal mapping helpers
// ---------------------------------------------------------------------------

interface RawTemplate {
  id?: string;
  name?: string;
  description?: string;
  input_shapes?: string[];
  output_shapes?: string[];
  tasks?: RawTask[];
  [key: string]: unknown;
}

interface RawTask {
  id?: string;
  description?: string;
  resolver?: string;
  config?: Record<string, unknown>;
  prompt?: Record<string, unknown>;
  // Snake_case shape fields as returned by activity-api / catalogue JSON.
  input_shapes?: (string | Record<string, unknown>)[];
  output_shapes?: string[];
  // CamelCase aliases — some catalogue templates already store them this way.
  inputShapes?: (string | Record<string, unknown>)[];
  outputShapes?: string[];
  // Retry policy + impulse declarations carried by shared catalogue tasks.
  retry?: Record<string, unknown>;
  output_impulses?: unknown[];
  outputImpulses?: unknown[];
  input_impulses?: unknown[];
  inputImpulses?: unknown[];
  // Sub-activity dispatch id (compose resolver).
  sub_activity_id?: string;
  subActivityId?: string;
  [key: string]: unknown;
}

function mapTemplate(raw: RawTemplate): ActivityTemplate {
  const out: ActivityTemplate = {
    id: raw.id ?? "",
    name: raw.name ?? "",
    description: raw.description,
    inputShapes: raw.input_shapes ?? (raw.inputShapes as string[] | undefined),
    outputShapes: raw.output_shapes ?? (raw.outputShapes as string[] | undefined) ?? [],
    tasks: (raw.tasks ?? []).map(mapTask),
  };
  // Pass through catalogue-canonical template-level extras (subscription,
  // tags, variables, metadata, dedupe_key, category, version, ...) so the
  // lifecycle subscriber / depth-cap / iteration paths see them.
  const KNOWN = new Set([
    "id", "name", "description",
    "input_shapes", "inputShapes",
    "output_shapes", "outputShapes",
    "tasks",
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN.has(k) && v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function mapTask(raw: RawTask): import("../ontology").ActivityTask {
  // 2026-05-20: when raw.prompt is present, default resolver to "llm-prompt"
  // (NOT "llm") — the llm-prompt resolver (src/resolvers/llm-prompt.ts)
  // reads task.prompt.template and interpolates {{var}} placeholders, which
  // is the canonical minibob template shape returned by activity-api's
  // recommend endpoint. The plain "llm" resolver requires task.config.prompt
  // as a string and would fail on these templates.
  // ALSO preserve raw.prompt on the output ActivityTask — previously it was
  // dropped, leaving the llm-prompt resolver with no template to read.
  const resolver = raw.resolver ?? (raw.prompt ? "llm-prompt" : "bash");

  // 2026-05-30: previously mapTask stripped inputShapes / outputShapes / retry /
  // outputImpulses (and other catalogue fields). The engine's iteration,
  // slot-binding, and validation paths all read these — silently dropping
  // them caused iteration-by-shape to return zero candidates and forced a
  // chunking workaround in ingest-doc-as-concepts. Now we (a) map the
  // snake_case shape fields to camelCase, and (b) pass through any remaining
  // catalogue-canonical fields via the ActivityTask `[extra]` index signature.
  const inputShapes =
    (raw.inputShapes as (string | import("../ontology").InputShapeRef)[] | undefined) ??
    (raw.input_shapes as (string | import("../ontology").InputShapeRef)[] | undefined);
  const outputShapes = raw.outputShapes ?? raw.output_shapes;
  const outputImpulses = raw.outputImpulses ?? raw.output_impulses;
  const inputImpulses = raw.inputImpulses ?? raw.input_impulses;
  const subActivityId = raw.subActivityId ?? raw.sub_activity_id;

  const out: import("../ontology").ActivityTask = {
    id: raw.id ?? "",
    description: raw.description ?? "",
    resolver,
    config: raw.config as Record<string, unknown> | undefined,
  };
  if (inputShapes !== undefined) out.inputShapes = inputShapes;
  if (outputShapes !== undefined) out.outputShapes = outputShapes;
  if (raw.retry !== undefined) (out as Record<string, unknown>).retry = raw.retry;
  if (outputImpulses !== undefined) (out as Record<string, unknown>).outputImpulses = outputImpulses;
  if (inputImpulses !== undefined) (out as Record<string, unknown>).inputImpulses = inputImpulses;
  if (subActivityId !== undefined) out.subActivityId = subActivityId;
  if (raw.prompt) {
    (out as { prompt?: unknown }).prompt = raw.prompt;
  }

  // Pass through any other catalogue-canonical extras (validation,
  // dependencies, optional_input_shapes / optionalInputShapes, conditional,
  // notes, ...) without re-keying — host-side resolvers consume them.
  const KNOWN = new Set([
    "id", "description", "resolver", "config", "prompt",
    "input_shapes", "inputShapes", "output_shapes", "outputShapes",
    "retry", "output_impulses", "outputImpulses",
    "input_impulses", "inputImpulses",
    "sub_activity_id", "subActivityId",
  ]);
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN.has(k) && v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

function mapTraceToApiBody(trace: ExecutionTrace): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    ...(trace.metadata ?? {}),
    ...(trace.dispatchTargetTemplateId
      ? { dispatch_target_template_id: trace.dispatchTargetTemplateId }
      : {}),
  };
  return {
    execution_id: trace.id,
    template_id: trace.templateId,
    status: trace.status,
    reason: trace.reason,
    parent_execution_id: trace.parentExecutionId,
    composition_chain: trace.compositionChain,
    input_impulse_ids: trace.inputImpulseIds,
    output_impulse_ids: trace.outputImpulseIds,
    cost_usd: trace.costUsd,
    duration_ms: trace.durationMs,
    failure_mode: trace.failureMode ?? null,
    tasks: trace.tasks.map((t) => ({
      task_id: t.taskId,
      description: t.description,
      resolver_id: t.resolverId,
      resolver_tier: t.resolverTier,
      input_impulse_ids: t.inputImpulseIds,
      output_impulse_ids: t.outputImpulseIds,
      success: t.success,
      error: t.error,
      cost_usd: t.costUsd,
      duration_ms: t.durationMs,
    })),
    ...(Object.keys(meta).length > 0 ? { metadata: meta } : {}),
  };
}
