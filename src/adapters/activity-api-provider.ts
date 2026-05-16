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
    if (!res.ok) return null;

    const raw = await res.json() as RawTemplate;
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
    if (!res.ok) return [];

    const data = await res.json() as { recommendations?: RawTemplate[] };
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
    try {
      const payload = mapTraceToApiBody(trace);
      const res = await globalThis.fetch(`${this.endpoint}/v2/activities/execution-traces`, {
        method: "POST",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[ActivityApiTraceSink] trace POST failed (${res.status}): ${text}`);
      }
    } catch (err) {
      console.warn("[ActivityApiTraceSink] trace POST threw:", err);
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
  [key: string]: unknown;
}

function mapTemplate(raw: RawTemplate): ActivityTemplate {
  return {
    id: raw.id ?? "",
    name: raw.name ?? "",
    description: raw.description,
    inputShapes: raw.input_shapes,
    outputShapes: raw.output_shapes ?? [],
    tasks: (raw.tasks ?? []).map(mapTask),
  };
}

function mapTask(raw: RawTask): import("../ontology").ActivityTask {
  const resolver = raw.resolver ?? (raw.prompt ? "llm" : "bash");
  return {
    id: raw.id ?? "",
    description: raw.description ?? "",
    resolver,
    config: raw.config as Record<string, unknown> | undefined,
  };
}

function mapTraceToApiBody(trace: ExecutionTrace): Record<string, unknown> {
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
  };
}
