/**
 * ActivityApiAdapter — single-facade HTTP adapter for activity-api.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §G.2
 *       openspec/changes/2026-05-19-ias-executor-as-canonical-host/specs/goal-host/spec.md R1
 *
 * Exposes the three activity-api methods GoalHost needs:
 *   - recommend(req)  — POST /v2/activities/recommend (Thompson Sampling)
 *   - recordTrace(t)  — POST /v2/activities/execution-traces (TraceSink)
 *   - getTemplate(id) — GET  /v2/activities/templates/:variantId (templateProvider fallback)
 *
 * The corresponding single-method providers in `activity-api-provider.ts`
 * (`ActivityApiTemplateProvider`, `ActivityApiRecommendationProvider`,
 * `ActivityApiTraceSink`) remain for hosts that only need one slice. This
 * adapter wraps them so GoalHost can hold a single dependency, matching the
 * spec's `ActivityApiAdapter` shape (R1) without duplicating the wire mapping.
 *
 * Failure semantics (spec R5 — trace sink failures must NOT abort execution):
 *   - recommend on non-2xx → returns `{ recommendations: [] }` and logs warning.
 *   - getTemplate on non-2xx → returns `null` and logs warning.
 *   - recordTrace on non-2xx or transport error → logs warning, never throws.
 *
 * The schema mapping (snake_case ↔ camelCase, status: completed ↔ success)
 * lives in `activity-api-trace-sink.ts` (TranslatingTraceSink); this adapter
 * composes it. Callers that want the simpler unmapped sink can construct
 * `ActivityApiTraceSink` from `activity-api-provider.ts` directly.
 */

import type { ActivityTemplate, ExecutionTrace } from "../ontology";
import type { FetchPort, TraceSink } from "../ports";
import {
  ActivityApiTemplateProvider,
  ActivityApiTraceSink,
} from "./activity-api-provider";
import { TranslatingTraceSink } from "./activity-api-trace-sink";

export interface RecommendRequest {
  /** Free-form goal text. Required — activity-api 400s without it. */
  goal: string;
  /** Optional shape filter — used as `expected_output_shapes`. */
  expectedOutputShapes?: string[];
  /** Top-K cap; default 3 matches activity-api's default. */
  limit?: number;
}

export interface RecommendCandidate {
  /** Canonical template id from activity-api response. */
  template_id: string;
  /** Thompson sampling score (if surfaced by the response). */
  score?: number;
  /** Raw selection_metadata bag, preserved for callers that want detail. */
  selection_metadata?: Record<string, unknown>;
}

export interface RecommendResponse {
  recommendations: RecommendCandidate[];
  fallback_tier?: string | null;
  /** Forwarded verbatim; useful for trace persistence. */
  decision_record?: Record<string, unknown>;
}

export interface ActivityApiAdapterOptions {
  /** Inject a fake fetch in tests; defaults to `globalThis.fetch`. */
  fetch?: FetchPort;
  /**
   * When true, recordTrace uses the canonical wire-translating sink. Defaults
   * to true to match what the forge wrapper (and minibob) send today. Set to
   * false to send the bare ExecutionTrace as JSON (matches the simpler
   * `ActivityApiTraceSink` in `activity-api-provider.ts`).
   */
  useTranslatingTraceSink?: boolean;
}

export class ActivityApiAdapter {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetch: FetchPort;
  private readonly templateProvider: ActivityApiTemplateProvider;
  private readonly traceSink: TraceSink;

  constructor(
    endpoint: string,
    apiKey: string,
    options: ActivityApiAdapterOptions = {},
  ) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetch = options.fetch ?? {
      request: (input, init) => globalThis.fetch(input, init),
    };
    this.templateProvider = new ActivityApiTemplateProvider(this.endpoint, this.apiKey);
    this.traceSink = options.useTranslatingTraceSink === false
      ? new ActivityApiTraceSink(this.endpoint, this.apiKey)
      : new TranslatingTraceSink(this.endpoint, this.apiKey, { fetch: this.fetch });
  }

  /**
   * POST /v2/activities/recommend. Returns an empty list (never throws) when
   * the endpoint is unreachable or returns non-2xx — GoalHost's `runGoal`
   * uses the length to decide whether to surface an error to the caller.
   */
  async recommend(req: RecommendRequest): Promise<RecommendResponse> {
    const body: Record<string, unknown> = {
      task_description: req.goal,
    };
    if (req.expectedOutputShapes?.length) {
      body.expected_output_shapes = req.expectedOutputShapes;
    }
    if (req.limit !== undefined) {
      body.limit = req.limit;
    }

    try {
      const res = await this.fetch.request(`${this.endpoint}/v2/activities/recommend`, {
        method: "POST",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        try { await res.body?.cancel(); } catch { /* swallow */ }
        console.warn(
          `[ActivityApiAdapter] recommend non-2xx (${res.status}): ${text.slice(0, 200)}`,
        );
        return { recommendations: [] };
      }
      const data = (await res.json()) as {
        recommendations?: Array<{
          template_id?: string;
          activity_id?: string;
          variant_id?: string;
          selection_metadata?: Record<string, unknown>;
        }>;
        fallback_tier?: string | null;
        decision_record?: Record<string, unknown>;
      };
      try { await res.body?.cancel(); } catch { /* swallow */ }
      const recommendations: RecommendCandidate[] = [];
      for (const r of data.recommendations ?? []) {
        // template_id is the canonical field; accept activity_id/variant_id
        // as legacy aliases that have shown up in older responses.
        const id = r.template_id ?? r.activity_id ?? r.variant_id;
        if (!id) continue;
        const meta = r.selection_metadata ?? {};
        const score = typeof meta.score === "number" ? meta.score : undefined;
        recommendations.push({ template_id: id, score, selection_metadata: meta });
      }
      return {
        recommendations,
        fallback_tier: data.fallback_tier ?? null,
        decision_record: data.decision_record,
      };
    } catch (err) {
      console.warn(
        `[ActivityApiAdapter] recommend transport error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { recommendations: [] };
    }
  }

  /**
   * GET /v2/activities/templates/:variantId. Returns null on not-found or
   * transport error — `TemplateProvider` callers handle null by falling
   * back to the in-memory catalogue.
   */
  async getTemplate(templateId: string): Promise<ActivityTemplate | null> {
    return this.templateProvider.getTemplate(templateId);
  }

  /**
   * Spec R5: trace-sink failures MUST NOT abort execution. The underlying
   * sink already logs-and-swallows on non-2xx; this method just forwards.
   */
  async recordTrace(trace: ExecutionTrace): Promise<void> {
    return this.traceSink.record(trace);
  }

  /** TraceSink view for hosts that want to attach the sink to a runtime. */
  asTraceSink(): TraceSink {
    return { record: (trace) => this.recordTrace(trace) };
  }
}
