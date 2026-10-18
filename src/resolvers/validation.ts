/**
 * validation resolver — minimal port for audit-test-report's check_* tasks.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Ported from repos/minibob/src/resolvers/validation-resolver.ts (~300 LOC).
 * Two modes:
 *   - Rule mode (config.rule): semantic checks dispatched by rule name.
 *     Implemented rules:
 *       - "decision_record_completeness": test_report.passes[] entries must
 *         carry required fields (default ["trace_event_id_or_impulse_id"]).
 *       - "witness_presence": test_report.witnesses[] must include ≥1
 *         entry per declared test_registration.witness_types.
 *       - "activity_template_write_contract": a template proposal is checked
 *         against the store's write contract before the write; when it
 *         passes, the normalised proposal is a second output impulse.
 *     Other rules return validation_result with passed:false + "unknown rule".
 *   - Pattern mode (config.requiredPatterns / forbiddenPatterns): regex
 *     checks over content. OUT OF SCOPE for the minimum-viable port —
 *     audit-test-report uses rule mode exclusively.
 *
 * Output: one impulse with shape="validation_result" carrying passed/error
 * fields, plus the validator_id and audit_subtype_on_fail for downstream
 * diagnostics.
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";
import { parseSlotContent } from "./impulse-resolve";

interface ValidationConfig {
  rule?: string;
  validator_id?: string;
  audit_subtype_on_fail?: string;
  report_impulse?: string;
  registration_impulse?: string;
  required_fields_per_assertion?: string[];
  /** activity_template_write_contract: the named slot carrying the proposal. */
  proposal_impulse?: string;
}

interface ValidationResult {
  passed: boolean;
  rule?: string;
  validator_id?: string;
  audit_subtype?: string;
  error?: string;
  details?: Record<string, unknown>;
}

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

function parseContent(impulse: Impulse | undefined): Record<string, unknown> | null {
  if (!impulse?.content) return null;
  if (typeof impulse.content === "string") {
    try { return JSON.parse(impulse.content) as Record<string, unknown>; } catch { return null; }
  }
  if (typeof impulse.content === "object" && impulse.content !== null && !Array.isArray(impulse.content)) {
    return impulse.content as Record<string, unknown>;
  }
  return null;
}

function checkDecisionRecordCompleteness(
  impulses: Impulse[],
  config: ValidationConfig,
): ValidationResult {
  const reportImpulse = findImpulseByShape(impulses, "test_report");
  const report = parseContent(reportImpulse);
  if (!report) {
    return {
      passed: false,
      rule: "decision_record_completeness",
      error: "test_report impulse not found or unparseable",
      validator_id: config.validator_id,
      audit_subtype: config.audit_subtype_on_fail,
    };
  }
  const passes = Array.isArray(report.passes) ? report.passes : [];
  const requiredFields = config.required_fields_per_assertion ?? ["trace_event_id_or_impulse_id"];
  const missing: Array<{ index: number; missing: string[] }> = [];
  for (let i = 0; i < passes.length; i++) {
    const entry = passes[i] as Record<string, unknown>;
    const missingFields = requiredFields.filter((f) => !(f in entry) || entry[f] == null);
    if (missingFields.length > 0) missing.push({ index: i, missing: missingFields });
  }
  if (missing.length > 0) {
    return {
      passed: false,
      rule: "decision_record_completeness",
      error: `${missing.length} pass entries missing required fields`,
      validator_id: config.validator_id,
      audit_subtype: config.audit_subtype_on_fail,
      details: { missing_entries: missing, total_passes: passes.length },
    };
  }
  return {
    passed: true,
    rule: "decision_record_completeness",
    validator_id: config.validator_id,
    details: { total_passes: passes.length },
  };
}

function checkWitnessPresence(
  impulses: Impulse[],
  config: ValidationConfig,
): ValidationResult {
  const reportImpulse = findImpulseByShape(impulses, "test_report");
  const report = parseContent(reportImpulse);
  if (!report) {
    return {
      passed: false,
      rule: "witness_presence",
      error: "test_report impulse not found or unparseable",
      validator_id: config.validator_id,
      audit_subtype: config.audit_subtype_on_fail,
    };
  }
  const registrationImpulse = findImpulseByShape(impulses, "test_registration");
  const registration = parseContent(registrationImpulse);
  const witnesses = Array.isArray(report.witnesses) ? report.witnesses : [];
  const declaredTypes = Array.isArray(registration?.witness_types)
    ? (registration!.witness_types as string[])
    : [];
  if (declaredTypes.length === 0) {
    // No declared witness types — vacuously passes (per minibob's contract).
    return {
      passed: true,
      rule: "witness_presence",
      validator_id: config.validator_id,
      details: { witnesses_observed: witnesses.length, witness_types_declared: 0 },
    };
  }
  const seenTypes = new Set<string>();
  for (const w of witnesses) {
    if (w && typeof w === "object" && typeof (w as { type?: string }).type === "string") {
      seenTypes.add((w as { type: string }).type);
    }
  }
  const missingTypes = declaredTypes.filter((t) => !seenTypes.has(t));
  if (missingTypes.length > 0) {
    return {
      passed: false,
      rule: "witness_presence",
      error: `missing witness types: ${missingTypes.join(", ")}`,
      validator_id: config.validator_id,
      audit_subtype: config.audit_subtype_on_fail,
      details: { missing_types: missingTypes, witnesses_observed: witnesses.length },
    };
  }
  return {
    passed: true,
    rule: "witness_presence",
    validator_id: config.validator_id,
    details: { witnesses_observed: witnesses.length, witness_types_declared: declaredTypes.length },
  };
}

/**
 * The activityTemplate_write contract, as activity-api's zod enforces it on the
 * write (CreateTemplateRequestSchema + TagSchema + LegacyCategorySchema +
 * TemplateTaskSchema in repos/activity-api/src/models/schemas.ts). That schema
 * lives in another package and is not served as a shape, so it is not reachable
 * from here at validation time; this is the single restatement of it. When the
 * contract changes there, change it here.
 */
export const ACTIVITY_TEMPLATE_WRITE_CONTRACT = {
  tagPattern: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/,
  tagMaxLength: 100,
  categories: ["feature", "bugfix", "refactor", "tool", "infrastructure", "meta", "system", "security"],
} as const;

/**
 * Checks a synthesized template proposal against the activityTemplate_write
 * contract BEFORE the write, so a proposal the store would 400 never reaches it.
 * Repairs only what can be repaired without inventing content: tags are
 * lowercased and the ones still outside the contract are dropped, a category
 * outside the enum is dropped. A missing description (or a task missing its
 * description / resolver) is a refusal with a structured reason — never filled
 * in. The extract chain's own rules (id form, recursion-safe author, declared
 * shapes) are recorded as evidence rows but do not refuse: the store accepts them.
 */
function checkActivityTemplateWriteContract(
  impulses: Impulse[],
  config: ValidationConfig,
): { result: ValidationResult; normalized?: Record<string, unknown> } {
  const rule = "activity_template_write_contract";
  const slot = config.proposal_impulse ?? "extracted_template";
  const proposalImpulse =
    impulses.find((i) => (i.metadata as Record<string, unknown>)["outputImpulseKey"] === slot) ??
    findImpulseByShape(impulses, "extractedTemplate");
  const parsed = parseSlotContent(proposalImpulse?.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      result: {
        passed: false,
        rule,
        error: `proposal impulse '${slot}' not found or not a JSON object`,
        validator_id: config.validator_id,
        audit_subtype: config.audit_subtype_on_fail,
      },
    };
  }
  const proposal = { ...(parsed as Record<string, unknown>) };
  const evidence: Array<{ rule: string; passed: boolean; message: string }> = [];
  const refusals: string[] = [];
  const changes: string[] = [];
  // A contract row refuses the write; an advisory row is evidence only (the
  // store accepts the proposal regardless, so refusing on it would lose a write).
  const row = (name: string, passed: boolean, message = "", refuses = true) => {
    evidence.push({ rule: name, passed, message: passed ? "" : message });
    if (!passed && refuses) refusals.push(`${name}: ${message}`);
  };

  // Contract: description is required. Refuse rather than invent one.
  row(
    "description_required",
    typeof proposal.description === "string" && proposal.description.trim() !== "",
    "description is absent; the write contract requires it and the validator does not invent one",
  );

  // Contract: every tag matches TagSchema; tags, when present, has at least one.
  if (proposal.tags !== undefined) {
    const raw = Array.isArray(proposal.tags) ? proposal.tags : [];
    const kept: string[] = [];
    const dropped: unknown[] = [];
    for (const t of raw) {
      const lower = typeof t === "string" ? t.toLowerCase() : "";
      if (lower.length <= ACTIVITY_TEMPLATE_WRITE_CONTRACT.tagMaxLength && ACTIVITY_TEMPLATE_WRITE_CONTRACT.tagPattern.test(lower)) {
        if (lower !== t) changes.push(`tag '${String(t)}' lowercased to '${lower}'`);
        if (!kept.includes(lower)) kept.push(lower);
      } else {
        dropped.push(t);
      }
    }
    if (dropped.length > 0) changes.push(`tags dropped (outside the write contract): ${JSON.stringify(dropped)}`);
    if (kept.length > 0) {
      proposal.tags = kept;
    } else {
      delete proposal.tags;
      changes.push("tags removed: none conformed, and the contract rejects an empty tags array");
    }
    evidence.push({ rule: "tags_conform", passed: true, message: dropped.length > 0 ? `${dropped.length} dropped` : "" });
  }

  // Contract: category, when present, is one of the legacy enum values.
  if (proposal.category !== undefined && !(ACTIVITY_TEMPLATE_WRITE_CONTRACT.categories as readonly string[]).includes(proposal.category as string)) {
    changes.push(`category ${JSON.stringify(proposal.category)} dropped (outside the write contract's enum)`);
    delete proposal.category;
  }

  // Contract: tasks is optional, but each task present carries an id, a
  // description, and a prompt or resolver.
  if (proposal.tasks !== undefined) {
    const tasks = Array.isArray(proposal.tasks) ? (proposal.tasks as Array<Record<string, unknown>>) : null;
    const badTasks = (tasks ?? [])
      .map((t, i) => ({ i, t }))
      .filter(({ t }) => !t || typeof t.id !== "string" || typeof t.description !== "string" || (t.prompt === undefined && t.resolver === undefined))
      .map(({ i, t }) => (t && typeof t.id === "string" ? t.id : `#${i}`));
    row("tasks_conform", tasks !== null && badTasks.length === 0,
      tasks === null ? "tasks is not an array" : `tasks missing id, description, or prompt/resolver: ${badTasks.join(", ")}`);
  }

  // Extract-chain rules: advisory evidence, not the store's contract.
  row("id_form", typeof proposal.id === "string" && /^[a-z0-9-]+$/.test(proposal.id), "id must match /^[a-z0-9-]+$/", false);
  const meta = proposal.metadata as Record<string, unknown> | undefined;
  row("author_recursion_safe", meta?.["author"] === "ribosome-pattern", "metadata.author must be 'ribosome-pattern'", false);
  row("input_shapes_declared", Array.isArray(proposal.input_shapes), "top-level input_shapes must be an array", false);
  row("output_shapes_declared", Array.isArray(proposal.output_shapes) && proposal.output_shapes.length > 0,
    "top-level output_shapes must be a non-empty array", false);

  const passed = refusals.length === 0;
  return {
    result: {
      passed,
      rule,
      validator_id: config.validator_id,
      ...(passed ? {} : { error: `refused before write: ${refusals.join("; ")}`, audit_subtype: config.audit_subtype_on_fail }),
      details: { evidence, changes, refusals },
    },
    normalized: passed ? proposal : undefined,
  };
}

export function makeValidationResolver(): Resolver {
  return {
    id: "validation",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as ValidationConfig;
      const impulses = context.inputImpulses;
      let result: ValidationResult;
      // A normalised proposal the write consumes (activity_template_write_contract only).
      let normalized: Record<string, unknown> | undefined;
      switch (config.rule) {
        case "activity_template_write_contract":
          ({ result, normalized } = checkActivityTemplateWriteContract(impulses, config));
          break;
        case "decision_record_completeness":
          result = checkDecisionRecordCompleteness(impulses, config);
          break;
        case "witness_presence":
          result = checkWitnessPresence(impulses, config);
          break;
        case undefined:
        case "":
          result = {
            passed: false,
            error: "validation: config.rule is required (no pattern mode in port)",
            validator_id: config.validator_id,
          };
          break;
        default:
          result = {
            passed: false,
            rule: config.rule,
            error: `unknown rule: ${config.rule}`,
            validator_id: config.validator_id,
            audit_subtype: config.audit_subtype_on_fail,
          };
      }
      const resultImpulse: Impulse = {
          id: context.random.id(`validation:${config.rule ?? "x"}`),
          pointer: { type: "memo" },
          metadata: {
            shape: "validation_result",
            summary: `${config.rule ?? "?"}: ${result.passed ? "PASS" : "FAIL"}`,
            source: "validation",
          },
          loaded: true,
          content: result,
        };
      if (!normalized) return [resultImpulse];
      return [
        resultImpulse,
        {
          id: context.random.id(`validation:${config.rule}:proposal`),
          pointer: { type: "memo" },
          metadata: { shape: "extractedTemplate", summary: "proposal normalised to the write contract", source: "validation" },
          loaded: true,
          content: normalized,
        },
      ];
    },
  };
}
