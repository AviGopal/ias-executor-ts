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

interface ValidationConfig {
  rule?: string;
  validator_id?: string;
  audit_subtype_on_fail?: string;
  report_impulse?: string;
  registration_impulse?: string;
  required_fields_per_assertion?: string[];
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

export function makeValidationResolver(): Resolver {
  return {
    id: "validation",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as ValidationConfig;
      const impulses = context.inputImpulses;
      let result: ValidationResult;
      switch (config.rule) {
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
      return [
        {
          id: context.random.id(`validation:${config.rule ?? "x"}`),
          pointer: { type: "memo" },
          metadata: {
            shape: "validation_result",
            summary: `${config.rule ?? "?"}: ${result.passed ? "PASS" : "FAIL"}`,
            source: "validation",
          },
          loaded: true,
          content: result,
        },
      ];
    },
  };
}
