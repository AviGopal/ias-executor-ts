/**
 * iteration resolver — minimal port for slot-binding's pool_precheck +
 * select_or_produce tasks.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Ported from repos/minibob/src/resolvers/iteration-resolver.ts (654 LOC).
 * This version implements the foreach over an array + per-element body
 * dispatch via the named resolver registry. The `body.resolver === "activity"`
 * sub-activity dispatch path is OUT OF SCOPE for the minimum-viable port —
 * slot-binding's two iteration users dispatch impulse_pool_selection and
 * producer_selection (named registered resolvers), not nested activities.
 *
 * Config shape:
 *   {
 *     over: Array | JSON-stringified array | impulse-shape reference,
 *     elementVar: "shape",
 *     indexVar?: "i",
 *     body: {
 *       resolver: "<named-resolver-id>",
 *       config: { ... uses {{shape}}, {{shape.x}}, {{i}} ... }
 *     },
 *     maxIterations?: number,  // default 32
 *     stopOnError?: boolean,   // default false
 *     aggregateAs?: "list" | "first" | "last",  // default "list"
 *     outputShape?: string     // shape for the aggregated result impulse
 *   }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";
import { _interpolate as interpolate } from "./llm-prompt";

interface IterationBody {
  resolver: string;
  config?: Record<string, unknown>;
  outputShapes?: string[];
}

interface IterationConfig {
  over?: unknown;
  elementVar?: string;
  indexVar?: string;
  body?: IterationBody;
  maxIterations?: number;
  stopOnError?: boolean;
  aggregateAs?: "list" | "first" | "last";
  outputShape?: string;
}

/** Coerce config.over into an array. Returns [] on shape mismatch.
 *  Supports dotted descent: over:"<shape>.<path>" reaches an array nested
 *  inside object-shaped impulse content (e.g. "driftGapList.gaps"). */
function coerceOver(value: unknown, context: ResolverContext): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — try impulse-shape lookup.
  }
  const find = (key: string) =>
    context.inputImpulses.find((i) => i.metadata.shape === key || i.id === key);
  const toNode = (content: unknown): unknown => {
    if (typeof content === "string") {
      try { return JSON.parse(content); } catch { return content; }
    }
    return content;
  };
  const exact = find(value);
  if (exact?.content !== undefined && exact?.content !== null) {
    const node = toNode(exact.content);
    if (Array.isArray(node)) return node;
  }
  const segments = value.split(".");
  if (segments.length > 1) {
    const impulse = find(segments[0] ?? "");
    if (impulse?.content !== undefined && impulse?.content !== null) {
      let node: unknown = toNode(impulse.content);
      for (const part of segments.slice(1)) {
        if (node && typeof node === "object" && !Array.isArray(node)) {
          node = toNode((node as Record<string, unknown>)[part]);
        } else {
          return [];
        }
      }
      if (Array.isArray(node)) return node;
    }
  }
  return [];
}

/** Recursively interpolate placeholders inside an object/array tree. */
function interpolateConfig(
  config: unknown,
  variables: Record<string, unknown>,
): unknown {
  if (typeof config === "string") return interpolate(config, variables);
  if (Array.isArray(config)) return config.map((c) => interpolateConfig(c, variables));
  if (config && typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      out[k] = interpolateConfig(v, variables);
    }
    return out;
  }
  return config;
}

export function makeIterationResolver(
  resolverLookup: (id: string) => Resolver | undefined,
): Resolver {
  return {
    id: "iteration",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as IterationConfig;
      const elementVar = config.elementVar;
      if (typeof elementVar !== "string" || elementVar.length === 0) {
        throw new Error("iteration: config.elementVar is required (string)");
      }
      const indexVar = typeof config.indexVar === "string" ? config.indexVar : "i";
      const body = config.body;
      if (!body || typeof body.resolver !== "string") {
        throw new Error("iteration: config.body.resolver is required (string)");
      }
      if (body.resolver === "activity") {
        throw new Error(
          "iteration: body.resolver=\"activity\" sub-activity dispatch not yet ported. See spec §4.",
        );
      }
      const innerResolver = resolverLookup(body.resolver);
      if (!innerResolver) {
        throw new Error(`iteration: inner resolver "${body.resolver}" not registered`);
      }
      const maxIterations = typeof config.maxIterations === "number" ? config.maxIterations : 32;
      const stopOnError = config.stopOnError === true;
      const aggregateAs = config.aggregateAs ?? "list";
      const outputShape = config.outputShape ?? "iteration_result";

      const items = coerceOver(config.over, context);
      const slice = items.slice(0, maxIterations);

      const perElementResults: unknown[] = [];
      for (let i = 0; i < slice.length; i++) {
        const element = slice[i];
        const perVars: Record<string, unknown> = {
          ...context.variables,
          [elementVar]: element,
          [indexVar]: i,
        };
        const interpolatedConfig = interpolateConfig(body.config ?? {}, perVars) as Record<
          string,
          unknown
        >;
        const innerContext: ResolverContext = {
          ...context,
          task: {
            ...context.task,
            resolver: body.resolver,
            config: interpolatedConfig,
          },
          variables: perVars,
        };
        try {
          const impulses = await innerResolver.resolve(innerContext);
          // Reduce to content for aggregation; preserve the first impulse's
          // body. Iteration consumers (slot-binding) read the aggregated
          // result as a per-element list.
          perElementResults.push(
            impulses.length > 0 ? impulses[0]!.content : null,
          );
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          perElementResults.push({ error: errMsg, index: i });
          if (stopOnError) break;
        }
      }

      const aggregatedContent =
        aggregateAs === "first"
          ? perElementResults[0] ?? null
          : aggregateAs === "last"
            ? perElementResults[perElementResults.length - 1] ?? null
            : perElementResults;

      return [
        {
          id: context.random.id("iter"),
          pointer: { type: "memo" },
          metadata: {
            shape: outputShape,
            summary: `iteration over ${slice.length} element(s) via ${body.resolver}`,
          },
          loaded: true,
          content: aggregatedContent,
        },
      ];
    },
  };
}
