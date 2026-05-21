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
import type { LLMPort } from "../ports";

interface SynthesiseConfig {
  operation?: string;
  missingShapes?: string | string[];
  variables?: string | Record<string, unknown>;
  executionId?: string;
  /** agent_fill: optional goal/task description hint. */
  goalDescription?: string;
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

/**
 * agent_fill: LLM-of-last-resort for unbindable shapes. Dispatched by
 * slot-binding.agent_fill_fallback when no producer exists. The LLM is
 * asked to synthesise a JSON value for each missing shape; the output is
 * wrapped as a degraded impulse so downstream tasks can proceed.
 *
 * Graceful degradation:
 *   - No LLM port injected → emit one placeholder impulse per missing
 *     shape with `degraded:true` and empty content. Slot-binding's
 *     downstream tasks treat these as caveats.
 *   - LLM call throws → same fallback as no-LLM path.
 *   - LLM returns unparseable text → wrap the raw string as content.
 */
async function runAgentFill(
  context: ResolverContext,
  config: SynthesiseConfig,
  llm: LLMPort | undefined,
): Promise<Impulse[]> {
  const missingShapes = coerceArray(config.missingShapes);
  const variables = Object.keys(config.variables ?? {}).length > 0
    ? coerceObject(config.variables)
    : context.variables;
  const executionId =
    typeof config.executionId === "string" && config.executionId.length > 0
      ? config.executionId
      : context.executionId;
  const goalHint = config.goalDescription ?? context.task.description ?? "";

  const out: Impulse[] = [];
  for (const shape of missingShapes) {
    let content: string = "";
    let degraded = true;
    if (llm) {
      try {
        const prompt =
          `You are the agent_fill fallback. The activity requires an impulse with shape "${shape}" ` +
          `but no producer exists. Synthesise a minimal JSON object that plausibly represents this shape.\n\n` +
          (goalHint ? `Task hint: ${goalHint}\n` : "") +
          (Object.keys(variables).length > 0
            ? `Known variables: ${JSON.stringify(variables).slice(0, 500)}\n`
            : "") +
          `Reply with ONLY the JSON value (no markdown, no prose).`;
        const raw = await llm.generate({ prompt });
        content = typeof raw === "string" ? raw.trim() : "";
        degraded = content.length === 0;
      } catch {
        content = "";
        degraded = true;
      }
    }
    out.push({
      id: context.random.id(`agent-fill:${shape}:${executionId}`),
      pointer: { type: "memo" },
      metadata: {
        shape,
        source: "agent-fill",
        degraded,
      },
      loaded: true,
      content: content.length > 0 ? content : `{"_agent_fill_placeholder":true,"shape":"${shape}"}`,
    });
  }
  return out;
}

export function makeImpulsePreparationResolver(options: {
  /** Optional LLM port for agent_fill operation. */
  llm?: LLMPort;
  /** Gate the agent_fill operation. Default false to preserve the
   *  fail-fast "unbindable" semantics that slot-binding's downstream
   *  tasks (consult_gap_cache / escalate_unbindable) depend on for
   *  the fast-fail loop. Hosts that want LLM-of-last-resort opt in
   *  explicitly. */
  enableAgentFill?: boolean;
} = {}): Resolver {
  return {
    id: "impulse_preparation",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as SynthesiseConfig;
      const operation = config.operation ?? "synthesise_from_variables";
      if (operation === "agent_fill") {
        if (!options.enableAgentFill) {
          throw new Error(
            `impulse_preparation: operation "agent_fill" not enabled — pass enableAgentFill:true to opt in. ` +
              `Without it, slot-binding's fail-fast unbindable path is preserved. See spec §4.`,
          );
        }
        return await runAgentFill(context, config, options.llm);
      }
      if (operation !== "synthesise_from_variables") {
        // Other operations (infer_expected_shapes, create_goal_impulse,
        // prepare_impulses_for_goal) land separately if needed.
        throw new Error(
          `impulse_preparation: operation "${operation}" not yet ported to ias-executor-ts. ` +
            `Only synthesise_from_variables and agent_fill are implemented. See spec §4.`,
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
