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

import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExecutionTrace } from "../ontology";
import type { FetchPort, TraceSink } from "../ports";

export interface TranslatingTraceSinkOptions {
  /** Inject a fake fetch in tests; defaults to `globalThis.fetch`. */
  fetch?: FetchPort;
}

/**
 * Canonical failure types accepted by activity-api's FailureModeSchema
 * (discriminatedUnion in repos/metabob-activity-api/src/models/schemas.ts).
 * Any other type the engine produces (e.g. "execution_error" for unhandled
 * resolver throws) is filtered out at the wire boundary.
 */
const CANONICAL_FAILURE_TYPES = new Set([
  "verifier_negative",
  "budget_exhausted",
  "safety_breach",
  "cascading",
  "user_abort",
]);

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
    this.maybeStartSpoolReplay();
  }

  async record(trace: ExecutionTrace): Promise<void> {
    // 2026-05-20 bug fix: StoreExecutionTraceRequestSchema's status enum is
    // {"success","failure","partial"}, but the route's derivation logic at
    // execution-traces.ts:1560 only treats body.status === "completed" OR
    // body.success === true as actual success. Sending "success" alone
    // falls through to `success = false → status = 'failure'`. Send both
    // the schema-valid enum AND the explicit boolean so the route lands
    // on the right answer regardless of which path it reads. Until the
    // route + schema are aligned at the source, this dual-key write is
    // the smallest defensible bridge.
    const isSuccess = trace.status === "completed";
    const statusMap: Record<string, string> = {
      completed: "success",
      failed: "failure",
    };
    const body = {
      execution_id: trace.id,
      template_id: trace.templateId,
      status: statusMap[trace.status] ?? "partial",
      success: isSuccess,
      duration_ms: trace.durationMs ?? 0,
      cost_usd: trace.costUsd ?? 0,
      tokens: { input: trace.tokensInput ?? 0, output: trace.tokensOutput ?? 0, cache: 0 },
      execution_trace: {
        tasks: trace.tasks.map((t) => ({
          // Field names match activity-api's normalizePersistedTask reader
          // (execution-traces.ts:82-130) — task_id / resolver_id / success /
          // duration_ms / cost_usd are read at the top level, not nested.
          // Earlier nested shape stored empty rows (task_id=undefined,
          // resolver_id=undefined) which broke learning-loop attribution.
          taskId: t.taskId,
          task_id: t.taskId,
          description: (t as { description?: string }).description ?? t.taskId,
          status: t.success ? "success" : "failure",
          success: t.success,
          resolver_id: t.resolverId,
          resolver_tier: t.resolverTier,
          duration_ms: (t as { durationMs?: number }).durationMs,
          cost_usd: (t as { costUsd?: number }).costUsd,
          actualPrompt: (t as { actualPrompt?: string }).actualPrompt ?? "",
          toolCalls: [],
          response: (t as { response?: string }).response ?? "",
          input_impulse_ids: t.inputImpulseIds ?? [],
          output_impulse_ids: t.outputImpulseIds ?? [],
          // Option-B placeholder-provenance: which producer tasks this task
          // consumed via {{placeholders}}, and (for dispatch tasks) the activity
          // it ran. The composition-edge reconcile maps consumer.consumed_from
          // -> producer task -> producer.child_activity_id to derive genuine
          // producer->consumer capability edges.
          consumed_from_task_ids: (t as { consumedFromTaskIds?: string[] }).consumedFromTaskIds ?? [],
          child_activity_id: (t as { childActivityId?: string }).childActivityId,
          error: t.error,
          // Keep nested result block too for any reader expecting the legacy shape.
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
            filesModified: t.filesModified ?? [],
            filesCreated: t.filesCreated ?? [],
            filesDeleted: [],
            ...(t.materialsConsulted && t.materialsConsulted.length > 0 ? { materialsConsulted: t.materialsConsulted } : {}),
          },
        })),
        impulsesCreated: trace.outputImpulseIds ?? [],
        filesModified: [...new Set(trace.tasks.flatMap((t) => [...(t.filesModified ?? []), ...(t.filesCreated ?? [])]))],
      },
      tags: trace.tags,
      parent_execution_id: trace.parentExecutionId,
      composition_chain: trace.compositionChain,
      // activity-api's FailureModeSchema is a closed discriminatedUnion over
      // five canonical types: verifier_negative, budget_exhausted,
      // safety_breach, cascading, user_abort. The engine sometimes emits
      // `type: "execution_error"` for unhandled resolver throws — useful
      // internally but rejected by the discriminator. Filter at the wire
      // boundary so the trace still lands (status: "failure" is the load-
      // bearing signal); rich error info travels in the per-task error
      // field instead.
      failure_mode: CANONICAL_FAILURE_TYPES.has(trace.failureMode?.type as string)
        ? trace.failureMode
        : undefined,
      // extras-bag Phase 1 (inv-071): pass raw failure_mode regardless of canonical type.
      // Diagnostic data lost by the filter above is preserved here so audit agents
      // and harnesses can see `execution_error` and other non-canonical types.
      // activity-api stores this in the loose metadata bag; it never influences selection.
      failure_mode_raw: trace.failureMode,
      // Collect input shapes for state_space_signature derivation. Prefer a top-level
      // `trace.inputShapes` (the decision-time pool snapshot the walk conditioned on) and
      // union with per-task inputShapes. Populating this is what un-starves the
      // state-conditioned Thompson posterior: execution-traces derives the v1 signature
      // from these shapes via the SAME computeStateSpaceSignature the recommend read-side
      // uses on effectiveShapes, so the write key matches the read key (previously empty
      // on ~96% of traces → cts cells cold → selection state-blind).
      input_impulse_shapes: [...new Set([
        ...((trace as { inputShapes?: string[] }).inputShapes ?? []),
        ...trace.tasks.flatMap(t => (t as { inputShapes?: string[] }).inputShapes ?? []),
      ])],
      // Aggregate actual output shapes from all tasks into the top-level trace.
      // activity-api accepts this as "output_impulse_shapes" (its field name for this concept).
      // coverage_tick reads "output_impulse_shapes" from trace rows.
      // Previously absent → coverage_tick fell back to template.output_shapes (a proxy, not a measurement).
      output_impulse_shapes: [...new Set(trace.tasks.flatMap(t => t.outputShapes ?? []))],
      // Stash any non-canonical metadata (free-form bag accepted by activity-api
      // execution-traces POST → ExecutionRecordSchema.metadata). The
      // dispatch-target field is the first instrumentation member: it records
      // the caller's originally-requested template id when /run-goal was
      // dispatched with `targetTemplateId`. Substrate-side
      // audit-dispatch-target-drift reads `metadata.dispatch_target_template_id`
      // and compares against `variant_id` to surface
      // selection-vs-dispatch divergence (concept_t2jHO8I-LxD3).
      ...(() => {
        const meta: Record<string, unknown> = {
          ...(trace.metadata ?? {}),
          ...(trace.dispatchTargetTemplateId
            ? { dispatch_target_template_id: trace.dispatchTargetTemplateId }
            : {}),
        };
        return Object.keys(meta).length > 0 ? { metadata: meta } : {};
      })(),
    };
    const json = JSON.stringify(body);
    const persisted = await this.postWithRetry(this.endpoint, json, trace.id);
    if (!persisted) {
      // Durable spool (2026-07-05, gap trace-persistence-loss-2026-07-05):
      // live delivery failed all attempts, so park the trace on disk for the
      // replay loop — WAN blips must never lose traces regardless of where the
      // store lives. TRACE_PERSIST_LOSS is reserved for the truly-lost case:
      // when even the spool write fails.
      const spooled = await this.spoolTrace(json, trace.id);
      if (!spooled) {
        console.error(
          `[TranslatingTraceSink] TRACE_PERSIST_LOSS execution_id=${trace.id} template_id=${trace.templateId} bytes=${json.length} endpoint=${this.endpoint} (spool write also failed)`,
        );
      }
    }
    // Best-effort mirror endpoints (e.g. a federation hub): single attempt,
    // fire-and-forget, never blocks or fails the primary path. Configure via
    // IAS_TRACE_SINK_MIRROR_ENDPOINTS (comma-separated base URLs).
    const mirrorRaw = typeof process !== "undefined" ? process.env?.IAS_TRACE_SINK_MIRROR_ENDPOINTS : undefined;
    if (mirrorRaw) {
      for (const mirror of mirrorRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0 && s !== this.endpoint)) {
        void this.postOnce(mirror, json, trace.id).then((outcome) => {
          if (outcome !== "ok") console.warn(`[TranslatingTraceSink] mirror miss for ${trace.id} at ${mirror}`);
        }).catch(() => { /* mirror is best-effort */ });
      }
    }
  }

  /**
   * POST the translated body once. Returns "ok" on 2xx, "fatal" on 4xx
   * (deterministic schema/auth rejection — retrying cannot help), and
   * "retryable" on 5xx or transport error (socket closed, timeout).
   */
  private async postOnce(endpoint: string, json: string, traceId: string): Promise<"ok" | "retryable" | "fatal"> {
    try {
      const res = await this.fetch.request(
        `${endpoint}/v2/activities/execution-traces`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `ApiKey ${this.apiKey}`,
          },
          body: json,
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(
          `[TranslatingTraceSink] ${res.status} recording trace ${traceId} at ${endpoint}: ${text.slice(0, 200)}`,
        );
        if (res.status >= 500 && text.includes("already contains") && text.includes("execution_id")) {
          console.warn(`[TranslatingTraceSink] duplicate delivery ${traceId} at ${endpoint} — already stored upstream, treating as delivered`);
          return "ok";
        }
        return res.status >= 500 ? "retryable" : "fatal";
      }
      // Drain response body to release Bun's native HTTP stream buffers.
      // Without this, anonymous mmap'd response buffers accumulate per
      // recordTrace call (once per execution). See bus-forwarder.ts.
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return "ok";
    } catch (err) {
      console.warn(
        `[TranslatingTraceSink] network error recording trace ${traceId} at ${endpoint}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return "retryable";
    }
  }

  /**
   * POST with bounded retry: up to 3 attempts, 250ms then 1000ms backoff,
   * retrying only transport errors and 5xx. Added 2026-07-05 after burst
   * concurrency to a slow endpoint closed sockets mid-request and every
   * such trace was silently lost (log-and-swallow, no second attempt).
   */
  private async postWithRetry(endpoint: string, json: string, traceId: string): Promise<boolean> {
    const backoffsMs = [250, 1000];
    for (let attempt = 0; attempt <= backoffsMs.length; attempt++) {
      const outcome = await this.postOnce(endpoint, json, traceId);
      if (outcome === "ok") return true;
      if (outcome === "fatal") return false;
      if (attempt < backoffsMs.length) {
        await new Promise((resolve) => setTimeout(resolve, backoffsMs[attempt]));
      }
    }
    return false;
  }

  private static spoolReplayStarted = false;
  private static spoolDraining = false;

  /** Spool directory for traces that failed all live delivery attempts. */
  private spoolDir(): string {
    return (typeof process !== "undefined" ? process.env?.IAS_TRACE_SPOOL_DIR : undefined) ?? "/workspace/trace-spool";
  }

  /**
   * Write a failed trace to the durable spool. Returns true when the spool
   * file was written; the 60s replay loop re-POSTs it when the store returns.
   */
  private async spoolTrace(json: string, traceId: string): Promise<boolean> {
    try {
      const dir = this.spoolDir();
      await mkdir(dir, { recursive: true });
      const safeId = traceId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const file = join(dir, `${Date.now()}-${safeId}.json`);
      await writeFile(file, JSON.stringify({ endpoint: this.endpoint, trace_id: traceId, spooled_at: new Date().toISOString(), body: json }));
      console.warn(`[TranslatingTraceSink] TRACE_SPOOLED execution_id=${traceId} bytes=${json.length} file=${file}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start the spool replay loop once per process. Every 60s it re-POSTs
   * spooled traces: delete on 2xx, delete + TRACE_PERSIST_LOSS on a
   * deterministic 4xx, keep for the next cycle on transport errors / 5xx.
   * Disable with IAS_TRACE_SPOOL_REPLAY=0 (tests, oneshot tools).
   */
  private maybeStartSpoolReplay(): void {
    if (TranslatingTraceSink.spoolReplayStarted) return;
    if (typeof process !== "undefined" && process.env?.IAS_TRACE_SPOOL_REPLAY === "0") return;
    if (typeof setInterval !== "function") return;
    TranslatingTraceSink.spoolReplayStarted = true;
    const timer = setInterval(() => { void this.drainSpool(); }, 60_000);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  private async drainSpool(): Promise<void> {
    if (TranslatingTraceSink.spoolDraining) return;
    TranslatingTraceSink.spoolDraining = true;
    try {
      const dir = this.spoolDir();
      let files: string[];
      try { files = await readdir(dir); } catch { return; }
      for (const name of files.filter((f) => f.endsWith(".json")).sort().slice(0, 25)) {
        const file = join(dir, name);
        try {
          const rec = JSON.parse(await readFile(file, "utf8")) as { endpoint?: string; trace_id?: string; body?: string };
          if (!rec.body) { await unlink(file); continue; }
          const outcome = await this.postOnce(rec.endpoint ?? this.endpoint, rec.body, rec.trace_id ?? name);
          if (outcome === "ok") {
            console.warn(`[TranslatingTraceSink] spool replay delivered ${rec.trace_id ?? name}`);
            await unlink(file);
          } else if (outcome === "fatal") {
            console.error(`[TranslatingTraceSink] TRACE_PERSIST_LOSS execution_id=${rec.trace_id ?? name} endpoint=${rec.endpoint ?? this.endpoint} (spool replay got deterministic 4xx — dropping spool file ${file})`);
            await unlink(file);
          }
          // retryable → keep the file for the next cycle
        } catch { /* unreadable spool file — leave it for operator inspection */ }
      }
    } finally {
      TranslatingTraceSink.spoolDraining = false;
    }
  }
}
