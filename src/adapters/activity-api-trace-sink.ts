/**
 * TranslatingTraceSink — schema-bridge sink from ias-executor-ts → activity-api.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §G.2 (TraceSink)
 *       and §H Phase 2 (forge migration — first consumer).
 *
 * activity-api's POST /v2/activities/execution-traces expects
 * `StoreExecutionTraceRequestSchema` (see repos/metabob-activity-api/src/
 * models/schemas.ts): snake_case top-level keys, `status: "success" |
 * "failure" | "partial"`, and `execution_trace.tasks` rows carrying
 * actualPrompt/response/inputState/outputState fields.
 *
 * ias-executor-ts's ExecutionTrace is camelCase, status is
 * `"completed" | "failed"`, and task records carry only the minimum the
 * substrate observes (taskId, success, resolverId, durationMs,
 * outputImpulseIds). The simpler `ActivityApiTraceSink` in
 * `activity-api-provider.ts` POSTs the bare trace — activity-api rejects
 * it with 400 ("Unrecognized key" / "Required field missing").
 *
 * This sink translates at the wire boundary so any host can send canary-
 * compatible traces without the caller knowing the schema.
 *
 * Functional equivalence to `validation/scripts/_forge-via-ias-executor.ts`'s
 * inline TranslatingTraceSink: identical body mapping, same defaulting rules,
 * same log-and-swallow failure semantics. The forge wrapper can switch to
 * this exported class in a follow-up commit.
 *
 * Failure semantics (spec R5): non-2xx and transport errors log to console
 * and return; execution never aborts due to trace-sink failure.
 */

import type { ExecutionTrace } from "../ontology";
import type { FetchPort, TraceSink } from "../ports";

export interface TranslatingTraceSinkOptions {
  /** Inject a fake fetch in tests; defaults to `globalThis.fetch`. */
  fetch?: FetchPort;
}

export class TranslatingTraceSink implements TraceSink {
  private readonly fetch: FetchPort;

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    options: TranslatingTraceSinkOptions = {},
  ) {
    this.fetch = options.fetch ?? {
      request: (input, init) => globalThis.fetch(input, init),
    };
  }

  async record(trace: ExecutionTrace): Promise<void> {
    const statusMap: Record<string, string> = {
      completed: "success",
      failed: "failure",
    };
    const body = {
      execution_id: trace.id,
      template_id: trace.templateId,
      status: statusMap[trace.status] ?? "partial",
      duration_ms: trace.durationMs ?? 0,
      cost_usd: trace.costUsd ?? 0,
      execution_trace: {
        tasks: trace.tasks.map((t) => ({
          id: t.taskId,
          description: (t as { description?: string }).description ?? t.taskId,
          actualPrompt: (t as { actualPrompt?: string }).actualPrompt ?? "",
          toolCalls: [],
          response: (t as { response?: string }).response ?? "",
          result: {
            status: t.success ? "success" : "failure",
            error: t.error,
            metadata: {
              resolver_id: t.resolverId,
              output_impulse_ids: t.outputImpulseIds,
            },
          },
          inputState: {
            filesAvailable: [],
            environment: {},
            impulses: t.inputImpulseIds ?? [],
            variables: {},
            git: { branch: "unknown", commit: "unknown", dirty: false },
          },
          outputState: {
            filesModified: [],
            filesCreated: [],
            filesDeleted: [],
          },
        })),
        impulsesCreated: trace.outputImpulseIds ?? [],
        filesModified: [],
      },
      parent_execution_id: trace.parentExecutionId,
      composition_chain: trace.compositionChain,
      failure_mode: trace.failureMode,
    };
    try {
      const res = await this.fetch.request(
        `${this.endpoint}/v2/activities/execution-traces`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `ApiKey ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          `[TranslatingTraceSink] ${res.status} recording trace ${trace.id}: ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      console.warn(
        `[TranslatingTraceSink] network error recording trace ${trace.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
