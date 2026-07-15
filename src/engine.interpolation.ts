// Extracted from engine.ts by parity-gated seam extraction (behavior-neutral move).
import type { ActivityTask, ActivityTemplate, ExecutionTaskRecord, ExecutionTrace, FailureMode, Impulse, InputShapeRef, LifecycleEvent } from "./ontology";
import { getImpulseShape } from "./ontology";
import type { CreateImpulseInput } from "./impulses";
import type { ResolverContext } from "./resolvers";
import { ExecutionRuntime } from "./runtime";
import { classifyShape } from "./shape-lifecycle";

export const ACCUMULATED_VAR_MAX_BYTES = (() => {
  const raw = typeof process !== "undefined" ? process.env?.IAS_ACCUMULATED_VAR_MAX_BYTES : undefined;
  const n = raw ? parseInt(raw, 10) : 262_144;
  return Number.isFinite(n) && n > 0 ? n : 262_144;
})();

export function capForAccumulator(value: string): string {
  if (typeof value !== "string" || value.length <= ACCUMULATED_VAR_MAX_BYTES) return value;
  return value.slice(0, ACCUMULATED_VAR_MAX_BYTES) +
    `…[truncated ${value.length - ACCUMULATED_VAR_MAX_BYTES} bytes]`;
}

export function isParseableJsonArtifact(raw: string): boolean {
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  try { JSON.parse(raw); return true; } catch { /* fall through to fence-tolerant path */ }
  const s = raw.replace(/^\s*```(?:json)?\n?/i, "").trimStart();
  const startObj = s.indexOf("{");
  const startArr = s.indexOf("[");
  const candidates: Array<[number, string, string]> = [];
  if (startObj >= 0) candidates.push([startObj, "{", "}"]);
  if (startArr >= 0) candidates.push([startArr, "[", "]"]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [start, open, close] of candidates) {
    let depth = 0, inStr = false, escape = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i]!;
      if (escape) { escape = false; continue; }
      if (inStr) {
        if (ch === "\\") { escape = true; continue; }
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { JSON.parse(s.slice(start, i + 1)); return true; } catch { break; }
        }
      }
    }
  }
  return false;
}

export function structuredError(code: string, message: string, context: Record<string, unknown>): Error {
  return Object.assign(new Error(message), { code, ...context });
}

export function resolveDottedPath(
  data: Record<string, unknown>,
  dottedPath: string,
): { found: boolean; value?: unknown } {
  let cur: unknown = data;
  for (const seg of dottedPath.split(".")) {
    if (cur === null || typeof cur !== "object") return { found: false };
    const obj = cur as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, seg)) {
      cur = obj[seg];
      continue;
    }
    const camel = seg.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    if (camel !== seg && Object.prototype.hasOwnProperty.call(obj, camel)) {
      cur = obj[camel];
      continue;
    }
    return { found: false };
  }
  return cur === undefined ? { found: false } : { found: true, value: cur };
}

export function stringifyForInline(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const WHOLE_LIFECYCLE_RE = /^\{\{\s*lifecycle\.([^{}\s]+)\s*\}\}$/;

export const INLINE_LIFECYCLE_RE = /\{\{\s*lifecycle\.([^{}\s]+)\s*\}\}/g;

export function resolveLifecyclePlaceholders(
  config: Record<string, unknown>,
  lifecycleData: Record<string, unknown>,
  taskId: string,
): Record<string, unknown> {
  const resolveOrThrow = (path: string): unknown => {
    const res = resolveDottedPath(lifecycleData, path);
    if (!res.found) {
      throw structuredError(
        "UNRESOLVABLE_PLACEHOLDER",
        `UNRESOLVABLE_PLACEHOLDER: task '${taskId}': unresolvable placeholder {{lifecycle.${path}}} — ` +
          `path not present in the triggering lifecycle impulse data`,
        { code: "UNRESOLVABLE_PLACEHOLDER", taskId, placeholder: `{{lifecycle.${path}}}` },
      );
    }
    return res.value;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const whole = WHOLE_LIFECYCLE_RE.exec(value);
      if (whole) return resolveOrThrow(whole[1]!);
      return value.replace(INLINE_LIFECYCLE_RE, (_m, path: string) =>
        stringifyForInline(resolveOrThrow(path)),
      );
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = k.startsWith("_") ? v : walk(v);
      }
      return out;
    }
    return value;
  };
  return walk(config) as Record<string, unknown>;
}

export interface GateEvaluationContext {
  taskId: string;
  /** Triggering lifecycle impulse data ({} when the execution has none). */
  lifecycleData: Record<string, unknown>;
  /** Accumulated variables (request-level + prior-task projections). */
  variables: Record<string, unknown>;
  /** Resolve an {{impulse:<slot>}} reference to the impulse's content string. */
  resolveImpulseSlot: (slot: string) => string | undefined;
}

export function evaluateConditionalGate(
  conditional: unknown,
  ctx: GateEvaluationContext,
): boolean {
  if (typeof conditional === "boolean") return conditional;
  let expression: string;
  if (typeof conditional === "string") {
    expression = conditional;
  } else if (conditional !== null && typeof conditional === "object") {
    const expr = (conditional as { expression?: unknown }).expression;
    if (typeof expr === "boolean") return expr;
    if (typeof expr !== "string") {
      throw structuredError(
        "UNRESOLVABLE_GATE",
        `UNRESOLVABLE_GATE: task '${ctx.taskId}': conditional gate has no boolean/string expression ` +
          `(got ${JSON.stringify(conditional)})`,
        { code: "UNRESOLVABLE_GATE", taskId: ctx.taskId },
      );
    }
    expression = expr;
  } else {
    throw structuredError(
      "UNRESOLVABLE_GATE",
      `UNRESOLVABLE_GATE: task '${ctx.taskId}': conditional gate must be a boolean, string expression, ` +
        `or { expression } object (got ${JSON.stringify(conditional)})`,
      { code: "UNRESOLVABLE_GATE", taskId: ctx.taskId },
    );
  }

  const unresolvable = (ref: string): Error =>
    structuredError(
      "UNRESOLVABLE_GATE",
      `UNRESOLVABLE_GATE: task '${ctx.taskId}': conditional gate references ${ref} which cannot be resolved`,
      { code: "UNRESOLVABLE_GATE", taskId: ctx.taskId, placeholder: ref },
    );

  const resolveOperand = (raw: string): string => {
    let s = raw.trim();
    // Strip one layer of matching quotes (template gates quote literals AND
    // sometimes quote placeholders: '{{lifecycle.outputShapes}}').
    if (
      s.length >= 2 &&
      ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))
    ) {
      s = s.slice(1, -1);
    }
    return s.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_m, token: string) => {
      if (token.startsWith("lifecycle.")) {
        const res = resolveDottedPath(ctx.lifecycleData, token.slice("lifecycle.".length));
        if (!res.found) throw unresolvable(`{{${token}}}`);
        return stringifyForInline(res.value);
      }
      if (token.startsWith("impulse:")) {
        const v = ctx.resolveImpulseSlot(token.slice("impulse:".length));
        if (v === undefined) throw unresolvable(`{{${token}}}`);
        return v;
      }
      const path = token.startsWith("variables.") ? token.slice("variables.".length) : token;
      const res = resolveDottedPath(ctx.variables, path);
      if (!res.found) throw unresolvable(`{{${token}}}`);
      return stringifyForInline(res.value);
    });
  };

  const truthy = (v: string): boolean => {
    const t = v.trim();
    return t !== "" && t !== "false" && t !== "0" && t !== "null" && t !== "undefined" && t !== "[]";
  };

  const CLAUSE_RE = /^(.+?)\s+(===|!==|==|!=|not-contains|contains)\s+(.+)$/;
  for (const clause of expression.split(/\s+AND\s+/)) {
    const m = CLAUSE_RE.exec(clause.trim());
    let clauseResult: boolean;
    if (!m) {
      clauseResult = truthy(resolveOperand(clause));
    } else {
      const lhs = resolveOperand(m[1]!);
      const rhs = resolveOperand(m[3]!);
      switch (m[2]) {
        case "===":
        case "==":
          clauseResult = lhs === rhs;
          break;
        case "!==":
        case "!=":
          clauseResult = lhs !== rhs;
          break;
        case "contains":
          clauseResult = lhs.includes(rhs);
          break;
        case "not-contains":
          clauseResult = !lhs.includes(rhs);
          break;
        default:
          clauseResult = false;
      }
    }
    if (!clauseResult) return false; // AND semantics — first false short-circuits
  }
  return true;
}
