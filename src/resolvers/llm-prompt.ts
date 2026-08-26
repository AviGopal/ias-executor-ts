/**
 * llm-prompt resolver — bridge for minibob-authored templates.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §I
 *   (canonical-host migration; minibob templates use task.prompt.template
 *    + {{var}} interpolation instead of task.config.prompt as a string).
 *
 * Activity-api `/v2/activities/recommend` returns templates whose tasks are
 * shaped like:
 *
 *   {
 *     id: "task-1",
 *     resolver: null,                          // minibob's default-LLM path
 *     prompt: {
 *       template: "Analyse: {{goal}}\n{{ctx}}",
 *       maxTokens?: number,
 *       compressionStrategy?: string,
 *     }
 *   }
 *
 * The existing `llm` resolver in bun-host.ts expects `task.config.prompt`
 * as a string. To run minibob templates through ias-executor-ts without
 * rewriting them, this resolver reads `task.prompt.template`, interpolates
 * `{{varName}}` and dotted `{{a.b.c}}` placeholders from
 * `context.variables`, and dispatches to LLMPort.
 *
 * Naming choice: registered as `llm-prompt` (not `llm`) so the existing
 * `llm` resolver remains the canonical ias-executor-ts-style entrypoint.
 * A template author who wants the canonical executor path uses
 * `resolver: "llm"` with `task.config.prompt`. A consumer running a
 * minibob-style template uses `resolver: "llm-prompt"`.
 *
 * Default-resolver-when-null path: this resolver does NOT auto-fire when
 * `task.resolver === null`. That auto-fallback lives in
 * GoalHost/BunHost's template-load adapter (when one ships) — keeping the
 * engine dispatcher pure (explicit resolver id required) per the
 * ias-executor-ts README rule "do not smuggle hidden built-ins".
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { LLMPort } from "../ports";
import type { Impulse } from "../ontology";

/** Interpolate {{var}} and {{a.b.c}} placeholders. Unresolved placeholders
 *  remain literal (matches minibob's interpolate semantics — a missing var
 *  is a soft warning, not a hard error). Arrays/objects serialise as JSON. */
function interpolate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{([\w]+(?:\.[\w]+)*)\}\}/g, (match, path: string) => {
    const segs = path.split(".");
    let cur: unknown = variables;
    for (const seg of segs) {
      if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return match;
      }
    }
    if (cur === undefined || cur === null) return match;
    if (typeof cur === "string") return cur;
    if (typeof cur === "number" || typeof cur === "boolean") return String(cur);
    try {
      return JSON.stringify(cur);
    } catch {
      return match;
    }
  });
}

export function makeLLMPromptResolver(llm: LLMPort): Resolver {
  return {
    id: "llm-prompt",
    tier: "llm",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      // Minibob templates put the prompt block at task.prompt (not task.config).
      // Read via cast — ActivityTask doesn't declare `prompt` natively in
      // ias-executor-ts ontology, but the index signature on ActivityTask
      // (added in §2 template catalogue work) tolerates it.
      const taskAny = context.task as { prompt?: { template?: string; maxTokens?: number; systemPrompt?: string } };
      const template = taskAny.prompt?.template;
      if (typeof template !== "string") {
        throw new Error(
          `llm-prompt resolver requires task.prompt.template (got ${JSON.stringify(taskAny.prompt)})`,
        );
      }
      // Merge resolved inputImpulses into variables, keyed by shape name.
      // This makes declared inputShapes available as {{shapeName}} placeholders —
      // the foundation-native path that was already wired but never honored here.
      // context.variables wins on collision so explicit overrides still work.
      const impulseVars: Record<string, unknown> = {};
      for (const imp of context.inputImpulses) {
        const shape = (imp.metadata as Record<string, unknown> | undefined)?.["shape"] as string | undefined;
        if (!shape || (shape in impulseVars)) continue;
        if (imp.loaded && imp.content != null) {
          impulseVars[shape] = imp.content;
          continue;
        }
        // Law 8: an unmaterialized (loaded:false) input used to reach the prompt as
        // NOTHING, silently — the structural root of confabulation-from-starvation.
        // Try to materialize the lazy pointer via the resolve endpoint before dropping
        // it. Fail OPEN to the prior skip on any error, but never SILENTLY: emit a loud
        // lifecycle event so a missing input is observable rather than invisible.
        let materialized = false;
        const resolveEndpoint = process.env.IMPULSE_RESOLVE_ENDPOINT ?? process.env.ACTIVITY_API_ENDPOINT;
        if (resolveEndpoint && imp.pointer) {
          try {
            const r = await fetch(`${resolveEndpoint}/v2/impulses/resolve`, {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(process.env.METABOB_API_KEY ? { Authorization: `ApiKey ${process.env.METABOB_API_KEY}` } : {}) },
              body: JSON.stringify({ pointer: imp.pointer }),
              signal: AbortSignal.timeout(10_000),
            });
            if (r.ok) {
              const d = (await r.json().catch(() => null)) as { content?: unknown } | null;
              // Size cap: don't splice an unbounded blob into a prompt.
              const asStr = d?.content == null ? "" : (typeof d.content === "string" ? d.content : JSON.stringify(d.content));
              if (d && d.content != null && asStr.length <= 100_000) {
                impulseVars[shape] = d.content;
                materialized = true;
              }
            }
          } catch {
            /* fail open — fall through to the drop-event below */
          }
        }
        if (!materialized) {
          await context.eventSink.emit({
            type: "lifecycle:llm:input-dropped",
            timestamp: context.clock.now(),
            data: {
              executionId: context.executionId,
              taskId: context.task.id,
              shape,
              impulseId: imp.id,
              reason: imp.loaded ? "content-null" : "unmaterialized",
              pointerType: imp.pointer?.type,
            },
          });
        }
      }
      const prompt = interpolate(template, { ...impulseVars, ...context.variables });
      const systemPrompt = typeof taskAny.prompt?.systemPrompt === "string"
        ? taskAny.prompt.systemPrompt
        : undefined;

      // Emit lifecycle:llm:dispatched before the LLM call so audit subscribers can
      // verify the rendered prompt contains the expected input-impulse content.
      // This is the audit primitive that makes the inputImpulses fix verifiable
      // without log archaeology (investigation-027 §lifecycle:llm:dispatched).
      await context.eventSink.emit({
        type: "lifecycle:llm:dispatched",
        timestamp: context.clock.now(),
        data: {
          executionId: context.executionId,
          taskId: context.task.id,
          templateId: context.template.id,
          renderedPrompt: prompt,
          inputImpulseIds: context.inputImpulses.map((imp) => imp.id),
          inputShapes: context.inputImpulses.map(
            (imp) => (imp.metadata as Record<string, unknown> | undefined)?.["shape"] ?? imp.pointer.type,
          ),
          variables: context.variables,
        },
      });

      const text = await llm.generate({ prompt, systemPrompt });
      const usage = (llm as { lastUsage?: { input_tokens: number; output_tokens: number } | null }).lastUsage ?? null;
      return [
        {
          id: context.random.id("llm"),
          pointer: { type: "memo" },
          metadata: {
            shape: "llmText",
            summary: text.slice(0, 120),
            ...(usage ? { usage } : {}),
          },
          loaded: true,
          content: text,
        },
      ];
    },
  };
}

/** Visible for tests: deterministic interpolation behaviour. */
export { interpolate as _interpolate };
