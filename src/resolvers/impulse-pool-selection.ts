/**
 * impulse_pool_selection resolver — minimal port for slot-binding's
 * pool_precheck task.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Ported from repos/minibob/src/resolvers/impulse-pool-selection-resolver.ts
 * (385 LOC). The minibob version Thompson-ranks candidates against
 * activity-api `impulse_relevance_metrics`. THIS version intentionally
 * skips the HTTP fetch and Thompson sampling — it returns the first
 * shape-matching candidate with `degraded: true`, mirroring the
 * graceful-degradation contract that minibob exposes when MCP is
 * unavailable. Real Thompson ranking lands when the HTTP impulse-relevance
 * fetch is wired into ias-executor-ts (separate iteration).
 *
 * The structural surface — config shape, output impulse — matches minibob
 * so slot-binding's iteration body works unchanged.
 *
 * Config:
 *   {
 *     shape: string,                 // the missing shape we're selecting for
 *     taskId?: string,               // audit-trail; reflected on output
 *     candidates?: ImpulseRef[],     // pre-narrowed pool
 *     poolCandidates?: Array<{ id, shape, producedBy? }>,  // unfiltered pool
 *     predicateProducedBy?: string,  // optional producer-id filter
 *     selectionMethod?: "deterministic" | "thompson",  // ignored in this port
 *   }
 *
 * Output impulse content (matches minibob result envelope):
 *   {
 *     shape: string,
 *     selected?: ImpulseRef,         // first shape-matching candidate
 *     candidates: ImpulseRef[],      // filtered pool
 *     no_pool_candidates?: true,     // when filtered pool is empty
 *     degraded: true,                // signal heuristic-not-Thompson selection
 *     reason: string,
 *   }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";

interface ImpulseRef {
  id: string;
  shape?: string;
  producedBy?: string;
}

interface PoolSelectionConfig {
  shape?: string;
  taskId?: string;
  candidates?: ImpulseRef[];
  poolCandidates?: ImpulseRef[];
  predicateProducedBy?: string;
  selectionMethod?: "deterministic" | "thompson";
}

function coerceCandidates(raw: unknown): ImpulseRef[] {
  if (Array.isArray(raw)) {
    return raw.filter(
      (x): x is ImpulseRef =>
        x != null && typeof x === "object" && typeof (x as ImpulseRef).id === "string",
    );
  }
  if (typeof raw === "string") {
    if (raw.length === 0) return [];
    try {
      const parsed = JSON.parse(raw);
      return coerceCandidates(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export function makeImpulsePoolSelectionResolver(): Resolver {
  return {
    id: "impulse_pool_selection",
    tier: "pattern",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as PoolSelectionConfig;
      const shape = typeof config.shape === "string" ? config.shape : "";
      if (shape.length === 0) {
        throw new Error("impulse_pool_selection: config.shape is required (non-empty string)");
      }

      // Source pool: either pre-narrowed `candidates` or unfiltered `poolCandidates`.
      const rawPool =
        config.candidates !== undefined
          ? coerceCandidates(config.candidates)
          : coerceCandidates(config.poolCandidates);

      // Filter by shape + optional producer predicate.
      const filtered = rawPool.filter((c) => {
        if (c.shape && c.shape !== shape) return false;
        if (config.predicateProducedBy && c.producedBy !== config.predicateProducedBy) return false;
        return true;
      });

      const noCandidates = filtered.length === 0;
      const selected = noCandidates ? undefined : filtered[0];

      const content = {
        shape,
        taskId: config.taskId,
        selected,
        candidates: filtered,
        no_pool_candidates: noCandidates ? true : undefined,
        degraded: true as const,
        reason:
          "Thompson ranking unavailable in ias-executor-ts port; returning first shape-matching candidate.",
      };

      return [
        {
          id: context.random.id("pool-select"),
          pointer: { type: "memo" },
          metadata: {
            shape: "impulse_pool_selection_result",
            summary: noCandidates
              ? `no pool candidates for ${shape}`
              : `selected ${selected?.id ?? "?"} from ${filtered.length} candidates (degraded)`,
          },
          loaded: true,
          content,
        },
      ];
    },
  };
}
