/**
 * Shared Activity Template Catalogue
 *
 * Host-agnostic catalogue of meta-activity templates. Loaded statically so any
 * host (GoalHost, VesselForgeHost, future hosts) can construct an
 * `InMemoryTemplateProvider` without depending on minibob.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §F
 *   - §F.1 Option F.1 — templates live in-tree under `repos/ias-executor-ts/
 *     src/templates/`. Forward path to a standalone `repos/activity-templates/`
 *     package (Option F.2) is deferred until a third independent consumer
 *     emerges.
 *   - §F.2 — taxonomy: `lifecycle/`, `escalation/`, `registry-quality/`,
 *     `forge/` subdirectories group meta-activities by role.
 *
 * Type-compatibility decision (per the implementation prompt):
 *   - (a) Canonical optional fields (`category`, `version`, `variables`,
 *     `input_shapes`, `output_shapes`) are added to `ActivityTemplate` in
 *     `ontology.ts`. The executor doesn't read them; hosts and lifecycle
 *     subscribers do.
 *   - (b) One-off fields (`composition`, `hooks`, `integration`, `learning`,
 *     `metabob`, `contextRequirements`, etc.) flow through the
 *     `[extra: string]: unknown` index signature on `ActivityTemplate` and
 *     `ActivityTask`. Consumers project the fields they need.
 *
 * Minibob still owns its own `embedded-templates/` copy during the transition
 * (canonical-host spec §7 handles the eventual cleanup); these JSON files were
 * copied — not moved — from `repos/minibob/src/embedded-templates/`.
 *
 * Bun's native JSON imports (`with { type: "json" }`) drive loading; `tsc`
 * with `resolveJsonModule: true` handles typechecking.
 */

import type { ActivityTemplate } from "../ontology";

// ──────────────────────────────────────────────────────────────────────────
// Lifecycle meta-activities — subscribe to lifecycle:* events.
// ──────────────────────────────────────────────────────────────────────────
import slotBinding from "./lifecycle/slot-binding.json" with { type: "json" };
import validatorDispatch from "./lifecycle/validator-dispatch.json" with { type: "json" };
import auditTestReport from "./lifecycle/audit-test-report.json" with { type: "json" };
import runSensitivityProbe from "./lifecycle/run-sensitivity-probe.json" with { type: "json" };
import debugFailingAudit from "./lifecycle/debug-failing-audit.json" with { type: "json" };
import ribosomeExtract from "./lifecycle/ribosome-extract.json" with { type: "json" };

// ──────────────────────────────────────────────────────────────────────────
// Escalation — slot-binding's recursive sub-goal path.
// ──────────────────────────────────────────────────────────────────────────
import createShapeProviderGoal from "./escalation/create-shape-provider-goal.json" with { type: "json" };

// ──────────────────────────────────────────────────────────────────────────
// Registry-quality six-pack — audit, replace, prune, repair, evolve.
// (review-activity, extract-pattern, concept-from-pattern are ROADMAP per
// the activity-registry-quality-pass proposal; not yet in the catalogue.)
// ──────────────────────────────────────────────────────────────────────────
import coreActivityAudit from "./registry-quality/core-activity-audit.json" with { type: "json" };
import pruneActivity from "./registry-quality/prune-activity.json" with { type: "json" };
import replaceActivity from "./registry-quality/replace-activity.json" with { type: "json" };
import repairFailedActivity from "./registry-quality/repair-failed-activity.json" with { type: "json" };
import evolveActivitySelfContained from "./registry-quality/evolve-activity-self-contained.json" with { type: "json" };

// ──────────────────────────────────────────────────────────────────────────
// Forge — restored from minibob commit f36d013 on 2026-05-19. The
// submodule pointer at port time (f486361) had drifted off the commit
// containing this file.
// ──────────────────────────────────────────────────────────────────────────
import forgeVesselForShape from "./forge/forge-vessel-for-shape.json" with { type: "json" };

// ──────────────────────────────────────────────────────────────────────────
// User-goals — terminal templates for user-dispatched goals (obsidian-vessel
// GoalDispatchView, minibob --single). Distinct from substrate-self-development
// templates: these consume free-form user goal text and produce concrete
// outputs (concepts, files, summaries) the user sees, rather than gap-closing
// variants that target substrate internals.
// ──────────────────────────────────────────────────────────────────────────
import summarizeAndEmitConcept from "./user-goals/summarize-and-emit-concept.json" with { type: "json" };

// JSON imports widen to `ActivityTemplate` via the index signature on the
// ontology interfaces (`extra: unknown`). The `satisfies` shape check would
// be tighter, but bun's `with { type: "json" }` resolves to a literal type;
// casting once at the catalogue boundary keeps the consumer-side types clean.
const cast = (raw: unknown): ActivityTemplate => raw as ActivityTemplate;

/** All shared templates, ordered by taxonomy. */
export const SHARED_TEMPLATES: ActivityTemplate[] = [
  // lifecycle
  cast(slotBinding),
  cast(validatorDispatch),
  cast(auditTestReport),
  cast(runSensitivityProbe),
  cast(debugFailingAudit),
  cast(ribosomeExtract),
  // escalation
  cast(createShapeProviderGoal),
  // registry-quality
  cast(coreActivityAudit),
  cast(pruneActivity),
  cast(replaceActivity),
  cast(repairFailedActivity),
  cast(evolveActivitySelfContained),
  // forge
  cast(forgeVesselForShape),
  // user-goals
  cast(summarizeAndEmitConcept),
];

// Build an id index once at module load. The catalogue is static; recomputing
// on every lookup would be wasteful.
const TEMPLATES_BY_ID: ReadonlyMap<string, ActivityTemplate> = new Map(
  SHARED_TEMPLATES.map((t) => [t.id, t]),
);

/** Look up a template by id. Returns `undefined` if not present. */
export function loadTemplate(id: string): ActivityTemplate | undefined {
  return TEMPLATES_BY_ID.get(id);
}

/**
 * Return every template whose `tags` array contains an entry that starts with
 * `tagPrefix`. Prefix-matching (rather than exact match) lets callers ask for
 * e.g. `"audit"` and pick up `"audit.test"`, `"audit.sensitivity"`, etc.
 */
export function loadTemplatesByTag(tagPrefix: string): ActivityTemplate[] {
  return SHARED_TEMPLATES.filter((t) => {
    const tags = t.tags;
    if (!Array.isArray(tags)) return false;
    return tags.some((tag) => typeof tag === "string" && tag.startsWith(tagPrefix));
  });
}

/** Return only templates that declare a `subscription` block. */
export function loadSubscriberTemplates(): ActivityTemplate[] {
  return SHARED_TEMPLATES.filter((t) => t.subscription !== undefined);
}
