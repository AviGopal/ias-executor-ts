/**
 * impulse_preparation resolver — minimal port for slot-binding's prepare_pool task.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *   (slot-binding resolver chain port).
 *
 * Ported from repos/minibob/src/resolvers/impulse-preparation-resolver.ts
 * (716 LOC across multiple operations). This version implements only the
 * synthesise_from_variables operation — the one slot-binding's prepare_pool
 * task uses. Other operations (agent_fill, infer_expected_shapes,
 * create_goal_impulse, prepare_impulses_for_goal) are out of scope for the
 * minimum-viable slot-binding port; they can land incrementally.
 *
 * synthesise_from_variables: for each declared shape in config.missingShapes,
 * look up variables[shape] (same-named lookup; no aliasing) and wrap the
 * value in a memo-pointer impulse with metadata.shape set. Skips nullish or
 * empty values. Only string/number/boolean values are coerced — complex
 * objects are left to the LLM-tier agent (out of scope here).
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";

interface SynthesiseConfig {
  operation?: string;
  missingShapes?: string | string[];
  variables?: string | Record<string, unknown>;
  executionId?: string;
}

/** Tolerate both JSON-stringified and native shapes from template interpolation. */
function coerceArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  if (typeof value === "string") {
    if (value.length === 0) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function coerceObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    if (value.length === 0) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function makeImpulsePreparationResolver(): Resolver {
  return {
    id: "impulse_preparation",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as SynthesiseConfig;
      const operation = config.operation ?? "synthesise_from_variables";
      if (operation !== "synthesise_from_variables") {
        // Out of scope for the minimum-viable port. Other operations
        // (agent_fill, infer_expected_shapes, etc.) land separately.
        throw new Error(
          `impulse_preparation: operation "${operation}" not yet ported to ias-executor-ts. ` +
            `Only synthesise_from_variables is implemented. See spec §4.`,
        );
      }
      // Slot-binding's prepare_pool task fills config from lifecycle payload
      // via dotted-path interpolation — arrays/objects arrive as
      // JSON-stringified strings. Tolerate both forms.
      const missingShapes = coerceArray(config.missingShapes);
      // Variables can come from EITHER the config OR the execution context.
      // When invoked as a subscriber-dispatched template, context.variables
      // carries the full goal-execution variable set (the subscriber
      // dispatcher in GoalHost passes lifecycle event data through). Prefer
      // config when explicit; fall back to context for the unconfigured path.
      const variables = Object.keys(config.variables ?? {}).length > 0
        ? coerceObject(config.variables)
        : context.variables;
      const executionId =
        typeof config.executionId === "string" && config.executionId.length > 0
          ? config.executionId
          : context.executionId;

      const out: Impulse[] = [];
      for (const shape of missingShapes) {
        const value = variables[shape];
        if (value == null) continue;
        const content =
          typeof value === "string"
            ? value
            : typeof value === "number" || typeof value === "boolean"
              ? String(value)
              : null;
        if (content == null || content.length === 0) continue;

        const impulse: Impulse = {
          id: context.random.id(`var-shape:${shape}:${executionId}`),
          pointer: { type: "memo" },
          metadata: { shape, source: "variable-synth" },
          loaded: true,
          content,
        };
        out.push(impulse);
      }
      return out;
    },
  };
}
