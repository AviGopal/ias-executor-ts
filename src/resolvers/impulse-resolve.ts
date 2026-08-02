const LLM_ENVELOPE_META = new Set(["model","requested_model","fallback_from","provider","usage","tokens_used","cost","costUsd","cost_usd","finish_reason","stop_reason","latencyMs","latency_ms","duration_ms","cached","degraded"]);/**
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
  /** Dynamic pointer fields resolved from input-impulse slots at run time:
   *  { "<pointerField>": "<slotName>" }. The slot's content is parsed
   *  (markdown fences stripped, JSON.parse attempted) and merged into the
   *  pointer as a VALUE — never string-spliced into a JSON body, which is
   *  how raw multi-line LLM output breaks http_fetch-style writes. */
  pointerFromImpulseSlots?: Record<string, string>;
  activityApiEndpoint?: string;
  activityApiKey?: string;
}

/** Parse an impulse slot's content into a pointer-safe value: objects pass
 *  through; strings get markdown fences stripped and a JSON.parse attempt;
 *  unparseable strings pass through as strings. */
function parseSlotContent(raw: unknown): unknown {
  if (raw === null || raw === undefined) return raw;
  // LLM proxy resolvers often wrap the completion in an envelope object —
  // unwrap the single text-bearing field before parsing, otherwise the
  // envelope itself lands in the pointer (e.g. templateData = {text: "..."}).
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    for (const k of ["text", "content", "completion", "body"]) {
      if (typeof obj[k] === "string" && Object.keys(obj).every((key) => key === k || LLM_ENVELOPE_META.has(key))) {
        return parseSlotContent(obj[k]);
      }
    }
    return raw;
  }
  if (typeof raw !== "string") return raw;
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/m.exec(s);
  if (fence?.[1]) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // Noisy completion (prose around the JSON): slice the first balanced
    // top-level object and parse that — mirrors apply-proposal-as-patch's
    // parseFirstJsonObject tolerance.
    const start = s.indexOf("{");
    if (start !== -1) {
      let depth = 0;
      let inStr = false;
      let esc = false;
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (esc) { esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(s.slice(start, i + 1)); } catch { break; }
          }
        }
      }
    }
    return raw;
  }
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
      const pointer = config.pointer ? { ...config.pointer } : undefined;
      if (!pointer || typeof pointer.type !== "string" || pointer.type.length === 0) {
        throw new Error("impulse-resolve: config.pointer.type is required (non-empty string)");
      }
      // Dynamic slot merge: resolve declared input-impulse slots into pointer
      // fields as parsed VALUES. A missing slot throws loudly — silently
      // omitting a field like templateData would turn a write into a 400 the
      // chain can't see (the ribosome mint-leg failure class).
      if (config.pointerFromImpulseSlots) {
        for (const [field, slot] of Object.entries(config.pointerFromImpulseSlots)) {
          const imp = [...context.inputImpulses].reverse().find((i) => {
            const meta = i.metadata as Record<string, unknown> | undefined;
            return meta?.["outputImpulseKey"] === slot || meta?.["shape"] === slot;
          });
          if (!imp) {
            throw new Error(
              `impulse-resolve: pointerFromImpulseSlots['${field}'] references slot '${slot}' but no input impulse carries it`,
            );
          }
          pointer[field] = parseSlotContent(imp.content);
        }
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
        // Connection timeout via AbortController. Without this, fake or
        // unreachable endpoints (test fixtures, dev clusters) hang executors
        // indefinitely. Default is 8s: a congested store legitimately answers
        // in 1-6s, and the previous 1s abort turned that congestion into
        // degraded-impulse failures that got retried (load amplification —
        // gap: store-pressure-invisible-to-sensing-2026-07-13). Ops can tune
        // via IMPULSE_RESOLVE_TIMEOUT_MS without a rebuild.
        const timeoutMs =
          Number.parseInt(process.env.IMPULSE_RESOLVE_TIMEOUT_MS ?? "", 10) > 0
            ? Number.parseInt(process.env.IMPULSE_RESOLVE_TIMEOUT_MS ?? "", 10)
            : 8000;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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
          try { await res.body?.cancel(); } catch { /* swallow */ }
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
        try { await res.body?.cancel(); } catch { /* swallow */ }
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
