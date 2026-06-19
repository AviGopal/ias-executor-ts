/**
 * activity resolver — minimal port for nested template dispatch.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Used by:
 *   - validator-dispatch's dispatch_validators (config.templateId from variant_selection_result)
 *   - slot-binding's escalate_unbindable (config.templateId + variables)
 *   - any composition meta-activity that dispatches a sibling
 *
 * Minimal port of repos/minibob/src/resolvers/activity-resolver.ts (455 LOC).
 * Implements:
 *   - config.template (inline ActivityTemplate, wins over templateId)
 *   - config.templateId (resolved via TemplateProvider)
 *   - config.variables (merged with context.variables)
 *   - Recursion guard via parentExecutionId / compositionChain tracking
 *
 * The nested execution shares the same runtime (impulses, eventSink,
 * traceSink). parentExecutionId is set to the caller's executionId so the
 * trace tree is reconstructable. compositionChain extended by one level.
 *
 * Errors caught and returned as an error impulse with shape="activityExecutionError"
 * (matches minibob's contract). The calling template's outputShapes typically
 * include this shape so consumers can detect failure.
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { ActivityTemplate, Impulse } from "../ontology";
import { ActivityExecutor } from "../engine";

interface ActivityConfig {
  template?: ActivityTemplate;
  templateId?: string;
  variables?: Record<string, unknown>;
  goal?: string;
  reason?: string;
  /** Optional depth cap override; default 10 (matches minibob). */
  maxDepth?: number;
  /**
   * Optional parent-attribution overrides. When a caller dispatches a child
   * whose parent is a DIFFERENT execution than the current one (e.g. backfill
   * attributing a dispatched producer to the CONSUMING activity so a genuine
   * composition edge forms), it supplies these. Absent → exactly the prior
   * behavior: parent = context.executionId, chain = context.compositionChain.
   */
  parentExecutionId?: string;
  compositionChain?: string[];
}

const DEFAULT_MAX_DEPTH = 10;

export function makeActivityResolver(options: {
  /** Injected executor — host wires this so the resolver can spawn nested execs. */
  executor: () => ActivityExecutor;
}): Resolver {
  return {
    id: "activity",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as ActivityConfig;
      const inlineTemplate = config.template;
      const templateId = config.templateId;
      const maxDepth = typeof config.maxDepth === "number" ? config.maxDepth : DEFAULT_MAX_DEPTH;

      // Recursion guard via compositionChain length. The engine populates
      // context.compositionChain (root-first ancestor executionIds) — empty
      // for top-level runs, growing by 1 per nested execute(). Defense-in-
      // depth alongside the lifecycle-subscriber's refuseForDepthCap which
      // bounds subscriber-driven recursion separately.
      // The EFFECTIVE chain governs both attribution and the depth guard.
      // When config.compositionChain is provided (parent-attribution override),
      // depth is measured from it so recursion stays honestly bounded relative
      // to the chain the child will actually carry. Absent → current behavior.
      const effectiveParentChain = config.compositionChain ?? context.compositionChain ?? [];
      const effectiveParentExecutionId = config.parentExecutionId ?? context.executionId;
      const currentDepth = effectiveParentChain.length;
      if (currentDepth >= maxDepth) {
        return [errorImpulse(context, `activity resolver: max recursion depth ${maxDepth} reached (chain length ${currentDepth})`)];
      }

      // Resolve the template to run.
      let template: ActivityTemplate | undefined = inlineTemplate;
      if (!template && templateId) {
        // Look up via templateProvider if injected.
        if (context.templateProvider) {
          const fetched = await context.templateProvider.getTemplate(templateId);
          template = fetched ?? undefined;
        }
      }
      if (!template) {
        return [errorImpulse(context, `activity resolver: missing template (config.template or config.templateId)`)];
      }

      // Merge variables: caller's context + config-level variables.
      const variables: Record<string, unknown> = {
        ...context.variables,
        ...(config.variables ?? {}),
      };

      // Run the nested execution.
      try {
        const executor = options.executor();
        const trace = await executor.execute(template, {
          variables,
          parentExecutionId: effectiveParentExecutionId,
          // Extend the EFFECTIVE parent chain by appending the effective
          // parent executionId. Default (no override): chain =
          // [...context.compositionChain, context.executionId] — exactly the
          // prior behavior, growing monotonically so recursion depth is
          // observable + capped. With overrides, the child is attributed to a
          // different parent (backfill forming a genuine composition edge).
          compositionChain: [...effectiveParentChain, effectiveParentExecutionId],
          reason: config.reason,
          goalContext: config.goal ? { goal: config.goal } : undefined,
        });
        // Emit a summary impulse so the calling task has something to read.
        return [
          {
            id: context.random.id(`activity:${template.id}`),
            pointer: { type: "memo" },
            metadata: {
              shape: "activityExecutionSummary",
              summary: `${template.id}: ${trace.status} (${trace.tasks.length} task(s))`,
              source: "activity",
              executionId: trace.id,
              templateId: template.id,
              status: trace.status,
              taskCount: trace.tasks.length,
            },
            loaded: true,
            content: {
              executionId: trace.id,
              templateId: template.id,
              status: trace.status,
              taskCount: trace.tasks.length,
              durationMs: trace.durationMs ?? 0,
            },
          },
        ];
      } catch (err) {
        return [errorImpulse(context, err instanceof Error ? err.message : String(err))];
      }
    },
  };
}

function errorImpulse(context: ResolverContext, reason: string): Impulse {
  return {
    id: context.random.id("activity-error"),
    pointer: { type: "memo" },
    metadata: {
      shape: "activityExecutionError",
      summary: `activity resolver: ${reason}`,
      source: "activity",
      degraded: true,
    },
    loaded: true,
    content: { error: reason },
  };
}
