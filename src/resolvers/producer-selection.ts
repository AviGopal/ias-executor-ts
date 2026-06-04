/**
 * producer_selection resolver — minimal port for slot-binding's
 * select_or_produce task.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Ported from repos/minibob/src/resolvers/producer-selection-resolver.ts
 * (304 LOC). The minibob version wraps `POST /v2/activities/discover-by-shapes`
 * with `mode: "candidates_with_scores"` and Thompson-samples the returned
 * producers' Beta(α, β) edge-success statistics.
 *
 * THIS port queries activity-api directly via fetch with graceful
 * degradation: if the HTTP call succeeds and producers exist, picks the
 * first candidate (heuristic, not Thompson). If the call fails OR returns
 * empty, marks `unbindable: true` — slot-binding's downstream tasks
 * (escalate_unbindable, agent_fill_fallback, forge_missing_shape branch)
 * key on this signal.
 *
 * Real Thompson ranking lands when the canonical-host migration wires
 * the activity-api Beta sampler into ias-executor-ts (separate iteration).
 *
 * Config:
 *   {
 *     shape: string,                    // the missing shape we're producing
 *     taskId?: string,                  // audit trail
 *     activityApiEndpoint?: string,     // default: read from env or skip HTTP
 *     activityApiKey?: string,
 *     selectionMethod?: "deterministic" | "thompson",  // ignored in this port
 *   }
 *
 * Output impulse content:
 *   {
 *     shape: string,
 *     chosen_producer?: { activity_id, score?, ...metadata },
 *     metadata: { unbindable?: boolean, reason?: string, degraded: true },
 *     candidates: any[],
 *   }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";

interface ProducerSelectionConfig {
  shape?: string;
  taskId?: string;
  activityApiEndpoint?: string;
  activityApiKey?: string;
  selectionMethod?: "deterministic" | "thompson";
}

interface DiscoverByShapesProducer {
  activity_id?: string;
  template_id?: string;
  metrics?: { confidence?: number };
  composition_score?: { alpha?: number; beta?: number };
  [k: string]: unknown;
}

async function fetchProducers(
  endpoint: string,
  apiKey: string,
  shape: string,
): Promise<DiscoverByShapesProducer[]> {
  try {
    const res = await fetch(`${endpoint}/v2/activities/discover-by-shapes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({
        output_shapes: [shape],
        mode: "candidates_with_scores",
      }),
    });
    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return [];
    }
    const data = (await res.json()) as { producers?: DiscoverByShapesProducer[]; candidates?: DiscoverByShapesProducer[] };
    try { await res.body?.cancel(); } catch { /* swallow */ }
    return data.producers ?? data.candidates ?? [];
  } catch {
    return [];
  }
}

export function makeProducerSelectionResolver(options: {
  activityApiEndpoint?: string;
  activityApiKey?: string;
} = {}): Resolver {
  return {
    id: "producer_selection",
    tier: "pattern",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as ProducerSelectionConfig;
      const shape = typeof config.shape === "string" ? config.shape : "";
      if (shape.length === 0) {
        throw new Error("producer_selection: config.shape is required (non-empty string)");
      }
      const endpoint = config.activityApiEndpoint ?? options.activityApiEndpoint ?? "";
      const apiKey = config.activityApiKey ?? options.activityApiKey ?? "";

      let producers: DiscoverByShapesProducer[] = [];
      let httpAttempted = false;
      if (endpoint && apiKey) {
        httpAttempted = true;
        producers = await fetchProducers(endpoint, apiKey, shape);
      }

      const chosen = producers[0];
      const unbindable = chosen == null;

      const content = {
        shape,
        taskId: config.taskId,
        chosen_producer: chosen
          ? {
              activity_id: chosen.activity_id ?? chosen.template_id,
              score: chosen.composition_score?.alpha ?? null,
              metadata: chosen,
            }
          : undefined,
        candidates: producers,
        metadata: {
          unbindable,
          degraded: true as const,
          reason: !httpAttempted
            ? "no activity-api endpoint configured; treating as unbindable"
            : unbindable
              ? `no producers returned for shape "${shape}"`
              : "first candidate selected (Thompson ranking deferred)",
        },
      };

      return [
        {
          id: context.random.id("prod-select"),
          pointer: { type: "memo" },
          metadata: {
            shape: "producer_selection_result",
            summary: unbindable
              ? `unbindable: no producer for ${shape}`
              : `chose ${chosen?.activity_id ?? chosen?.template_id ?? "?"} for ${shape}`,
          },
          loaded: true,
          content,
        },
      ];
    },
  };
}
