/**
 * impulse-resolve resolver — minimal port for templates that need to
 * dispatch arbitrary shape pointers through activity-api.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Used by:
 *   - audit-test-report's fetch_test_report (pointer.type === "test_report")
 *   - slot-binding's consult_gap_cache (pointer.type === "shape_gap_resolution")
 *   - many other lifecycle / registry-quality templates
 *
 * Minimal port of repos/minibob/src/resolvers/impulse-resolve-resolver.ts
 * (459 LOC). This version implements the STATIC pointer variant only —
 * config.pointer is a literal object with a type field. The dynamic
 * pointerFromImpulse variant (which reads pointer from an input impulse's
 * JSON content) is OUT OF SCOPE for the minimum-viable port; both
 * subscriber-chain use cases (fetch_test_report, consult_gap_cache) use
 * static pointers.
 *
 * Contract:
 *   - config.pointer must be an object with non-empty .type
 *   - POSTs to {activityApiEndpoint}/v2/impulses/resolve with {pointer}
 *   - Returns the response body as a memo impulse with the pointer's type
 *     as the metadata.shape — consumers interpret content based on the
 *     shape they asked for.
 *   - On HTTP failure, returns a degraded impulse with content describing
 *     the failure mode (matches minibob's "graceful degradation" pattern).
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";

interface ImpulseResolveConfig {
  pointer?: { type?: string; [k: string]: unknown };
  activityApiEndpoint?: string;
  activityApiKey?: string;
}

export function makeImpulseResolveResolver(options: {
  activityApiEndpoint?: string;
  activityApiKey?: string;
} = {}): Resolver {
  return {
    id: "impulse-resolve",
    tier: "pattern",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as ImpulseResolveConfig;
      const pointer = config.pointer;
      if (!pointer || typeof pointer.type !== "string" || pointer.type.length === 0) {
        throw new Error("impulse-resolve: config.pointer.type is required (non-empty string)");
      }
      const endpoint = config.activityApiEndpoint ?? options.activityApiEndpoint ?? "";
      const apiKey = config.activityApiKey ?? options.activityApiKey ?? "";
      if (!endpoint || !apiKey) {
        // Graceful degradation: caller didn't wire activity-api access.
        // Return an empty impulse with the requested shape so downstream
        // consumers can detect the no-config state.
        return [
          {
            id: context.random.id(`resolve:${pointer.type}`),
            pointer: { type: "memo" },
            metadata: {
              shape: pointer.type,
              summary: `impulse-resolve: no activity-api endpoint configured`,
              source: "impulse-resolve",
              degraded: true,
            },
            loaded: true,
            content: null,
          },
        ];
      }

      try {
        // 1-second connection timeout via AbortController. Without this,
        // fake/unreachable endpoints (test fixtures, dev clusters) hang
        // executors indefinitely. Real canary roundtrip is ~tens of ms.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        const res = await fetch(`${endpoint}/v2/impulses/resolve`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `ApiKey ${apiKey}`,
          },
          body: JSON.stringify({ pointer }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          return [
            {
              id: context.random.id(`resolve:${pointer.type}`),
              pointer: { type: "memo" },
              metadata: {
                shape: pointer.type,
                summary: `impulse-resolve: HTTP ${res.status}`,
                source: "impulse-resolve",
                degraded: true,
                error: text.slice(0, 200),
              },
              loaded: true,
              content: null,
            },
          ];
        }
        const data = (await res.json()) as { content?: unknown; metadata?: Record<string, unknown> };
        return [
          {
            id: context.random.id(`resolve:${pointer.type}`),
            pointer: { type: "memo" },
            metadata: {
              shape: pointer.type,
              summary:
                typeof data.metadata?.summary === "string"
                  ? data.metadata.summary
                  : `impulse-resolve(${pointer.type})`,
              source: "impulse-resolve",
              // Forward backend metadata transparently for consumers that need it.
              ...(data.metadata ?? {}),
            },
            loaded: true,
            content: data.content ?? null,
          },
        ];
      } catch (err) {
        return [
          {
            id: context.random.id(`resolve:${pointer.type}`),
            pointer: { type: "memo" },
            metadata: {
              shape: pointer.type,
              summary: `impulse-resolve: network error`,
              source: "impulse-resolve",
              degraded: true,
              error: err instanceof Error ? err.message : String(err),
            },
            loaded: true,
            content: null,
          },
        ];
      }
    },
  };
}
