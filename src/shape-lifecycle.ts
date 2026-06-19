/**
 * shape-lifecycle — pure shape classifier.
 *
 * Classifies an impulse shape into a lifecycle class so callers can reason
 * about whether a shape is ever produced for binding:
 *
 *   - "terminal": sink/observer shapes (reports, audits, findings, gaps, …).
 *     Never produced FOR another task to consume as a required input — they
 *     are consumed by observation. Wiring one as a required input is a
 *     template-authoring bug (see engine.resolveInputs).
 *   - "durable": long-lived/registry/identity shapes that persist across
 *     executions (templates, metrics, auth). An explicit durable name wins
 *     over an incidental terminal-regex match.
 *   - "stream": continuously-emitted signals (heartbeats, state-space
 *     signatures, push-health) rather than discrete produced artifacts.
 *   - "ephemeral": the default — ordinary in-flight produced artifacts that
 *     feed downstream tasks (source_code, diffs, …).
 *
 * Pure function: no I/O, no state. Seeded from the substrate's autonomy
 * metrics terminal regex (scripts/substrate/autonomy-metrics.ts) so the
 * engine's notion of "terminal" matches the observability layer's.
 */

export type ShapeLifecycleClass = "ephemeral" | "durable" | "terminal" | "stream";

/**
 * Durable allowlist — registry/learning/identity shapes that persist.
 * Matched case-sensitively against the exact shape name.
 */
const DURABLE_SHAPES: ReadonlySet<string> = new Set([
  "activity_template",
  "activity_metrics",
  "impulseRelevance",
  "compositionSuccess",
  "conceptPromptPriors",
  // identity / auth
  "authentication",
  "apiKey",
  "session",
]);

/**
 * Stream shapes — continuously emitted, not discrete produced artifacts.
 */
const STREAM_SHAPES: ReadonlySet<string> = new Set([
  "stateSpaceSignature",
  "pushHealth",
]);

/**
 * Terminal regex — mirrors scripts/substrate/autonomy-metrics.ts (~line 348)
 * so the engine and the observability layer agree on what "terminal" means.
 */
const TERMINAL_RE =
  /report|audit|health|sentinel|metric|finding|verdict|result|summary|log|observ|status|gap|score|stats|snapshot|diagnos|recorded|State$/i;

/**
 * Classify a shape into its lifecycle class.
 *
 * Resolution order (first match wins):
 *   1. durable allowlist  — explicit durable name beats an incidental regex hit
 *   2. stream             — explicit stream name / heartbeat
 *   3. terminal regex     — sink/observer shapes + autoDraftedOutput*
 *   4. ephemeral          — default
 */
export function classifyShape(shape: string): ShapeLifecycleClass {
  if (DURABLE_SHAPES.has(shape)) return "durable";

  if (STREAM_SHAPES.has(shape) || shape.toLowerCase().includes("heartbeat")) return "stream";

  if (TERMINAL_RE.test(shape) || shape.startsWith("autoDraftedOutput")) return "terminal";

  return "ephemeral";
}
