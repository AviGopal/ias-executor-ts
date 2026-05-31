/**
 * learning_signal_writer resolver — minimal port.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §4
 *
 * Dispatched by validator-dispatch.write_learning_signals (task 5) after
 * the per-task validator chain completes. Mirrors the minibob resolver
 * (repos/minibob/src/resolvers/learning-signal-writer-resolver.ts) but
 * trimmed to the HTTP-write essentials needed for the canonical-host
 * substrate:
 *
 *   - "impulse_relevance" → one POST /v2/activities/impulse-relevance per
 *     impulse id in allImpulseIds. Body shape matches activity-api's
 *     route handler (impulse_id + activity_variant_id + was_loaded +
 *     execution_succeeded).
 *   - "tool_argument_pattern" → one POST /v2/activities/tool-usage per
 *     tool-call record. Body carries tool_name + arguments + success.
 *
 * Behaviour:
 *   - No activityApiEndpoint configured → no-op (returns degraded result).
 *   - HTTP failure → captured into `errors`, loop continues. Best-effort.
 *   - Missing templateId or empty allImpulseIds/toolCallRecords →
 *     individual signal is a no-op (no error).
 *   - Tolerates JSON-stringified array forms (interpolation artefact —
 *     dotted-path interpolator stringifies array leaves in template config).
 *
 * Deferred:
 *   - Stable argument-id hashing (inferArgumentShape / generateStableArgumentId
 *     from minibob's tool-argument-extractor) — required for cross-call
 *     dedup but not for "does the resolver exist" verification.
 *   - Failure-type stratification (validation/execution/tool_failure/timeout).
 */
import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse } from "../ontology";

interface ToolCallRecord {
  toolName?: string;
  name?: string;
  params?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  result?: { success?: boolean; error?: string };
  timestamp?: number;
}

interface LearningSignalConfig {
  signals?: string[];
  taskId?: string;
  templateId?: string;
  executionId?: string;
  executionSucceeded?: boolean;
  allImpulseIds?: string[] | string;
  loadedImpulseIds?: string[] | string;
  toolCallRecords?: ToolCallRecord[] | string;
  taskDurationMs?: number;
  failureType?: string;
  failureReason?: string;
}

function coerceArray<T = unknown>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function makeLearningSignalWriterResolver(options: {
  activityApiEndpoint?: string;
  activityApiKey?: string;
}): Resolver {
  return {
    id: "learning_signal_writer",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const config = (context.task.config ?? {}) as LearningSignalConfig;
      const signals = Array.isArray(config.signals) ? config.signals : [];
      const errors: Array<{ signal: string; message: string }> = [];
      const succeeded: string[] = [];

      const endpoint = options.activityApiEndpoint;
      const apiKey = options.activityApiKey;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;

      const post = async (path: string, body: unknown) => {
        if (!endpoint) throw new Error("no activityApiEndpoint configured");
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2000);
        try {
          const res = await fetch(`${endpoint}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          // Drain body to release Bun's native HTTP buffers — multiple
          // posts per validator-dispatch would otherwise accumulate.
          try { await res.body?.cancel(); } catch { /* swallow */ }
        } finally {
          clearTimeout(timer);
        }
      };

      const templateId = config.templateId;
      const allIds = coerceArray<string>(config.allImpulseIds).filter((x) => typeof x === "string" && x.length > 0);
      const loadedIds = new Set(coerceArray<string>(config.loadedImpulseIds));
      const toolRecords = coerceArray<ToolCallRecord>(config.toolCallRecords);

      for (const signal of signals) {
        if (signal === "impulse_relevance") {
          if (!templateId || allIds.length === 0) {
            succeeded.push(signal);
            continue;
          }
          let signalOk = true;
          for (const impulseId of allIds) {
            try {
              await post("/v2/activities/impulse-relevance", {
                impulse_id: impulseId,
                activity_variant_id: templateId,
                execution_id: config.executionId,
                was_loaded: loadedIds.has(impulseId),
                execution_succeeded: !!config.executionSucceeded,
              });
            } catch (err) {
              signalOk = false;
              errors.push({
                signal,
                message: `impulse=${impulseId}: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
          if (signalOk) succeeded.push(signal);
        } else if (signal === "tool_argument_pattern") {
          if (!templateId || toolRecords.length === 0) {
            succeeded.push(signal);
            continue;
          }
          let signalOk = true;
          for (const record of toolRecords) {
            const toolName = record.toolName || record.name || "";
            if (!toolName) continue;
            const args = record.params ?? record.arguments ?? {};
            try {
              await post("/v2/activities/tool-usage", {
                template_id: templateId,
                tool_name: toolName,
                arguments: args,
                success: record.result?.success !== false,
                execution_ms: config.taskDurationMs ?? 0,
                failure_type: config.failureType,
                failure_reason: config.failureReason,
              });
            } catch (err) {
              signalOk = false;
              errors.push({
                signal,
                message: `tool=${toolName}: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          }
          if (signalOk) succeeded.push(signal);
        } else {
          errors.push({ signal, message: `unknown signal: ${signal}` });
        }
      }

      return [
        {
          id: context.random.id("learning_signal_write_result"),
          pointer: { type: "memo" },
          metadata: {
            shape: "learning_signal_write_result",
            summary: `signals=${signals.join(",")} ok=${succeeded.length} err=${errors.length}`,
            source: "learning_signal_writer",
            degraded: !endpoint,
          },
          loaded: true,
          content: {
            signalsAttempted: signals,
            signalsSucceeded: succeeded,
            errors,
            degraded: !endpoint,
          },
        },
      ];
    },
  };
}
