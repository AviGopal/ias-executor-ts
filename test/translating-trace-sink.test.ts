/**
 * TranslatingTraceSink wire-format tests.
 *
 * Pins the body shape sent to activity-api's POST /v2/activities/execution-traces:
 *   - top-level template_id, execution_id, status, success, duration_ms
 *   - execution_trace.tasks[].{task_id, taskId, resolver_id, success,
 *     duration_ms, cost_usd, input_impulse_ids, output_impulse_ids}
 *
 * Field names must match activity-api's normalizePersistedTask reader
 * (execution-traces.ts:82-130). A regression here would silently drop
 * learning-loop attribution again. The fix landed in 2026-05-21 commit
 * e60d2c0 — these tests pin it.
 */
import { describe, expect, test } from "bun:test";
import { TranslatingTraceSink } from "../src/adapters/activity-api-trace-sink";
import type { ExecutionTrace } from "../src/ontology";
import type { FetchPort } from "../src/ports";

class CapturingFetch implements FetchPort {
  capturedUrl: string | URL | Request | null = null;
  capturedInit: RequestInit | undefined;
  async request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.capturedUrl = input;
    this.capturedInit = init;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: "exec_test_1",
    templateId: "tpl-x",
    templateName: "TplX",
    status: "completed",
    inputImpulseIds: ["in-1"],
    outputImpulseIds: ["out-1"],
    durationMs: 1234,
    costUsd: 0.05,
    tasks: [
      {
        taskId: "t1",
        resolverId: "bash",
        success: true,
        outputImpulseIds: ["out-1"],
        inputImpulseIds: ["in-1"],
        durationMs: 800,
        costUsd: 0.02,
      } as never,
    ],
    ...overrides,
  };
}

describe("TranslatingTraceSink wire format", () => {
  test("posts to /v2/activities/execution-traces with ApiKey auth", async () => {
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "key-123", { fetch });
    await sink.record(makeTrace());
    expect(fetch.capturedUrl).toBe("https://activity.test/v2/activities/execution-traces");
    expect(fetch.capturedInit?.method).toBe("POST");
    expect((fetch.capturedInit?.headers as Record<string, string>).Authorization).toBe(
      "ApiKey key-123",
    );
  });

  test("top-level body carries execution_id + template_id + status + success", async () => {
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await sink.record(makeTrace());
    const body = JSON.parse(fetch.capturedInit!.body as string) as Record<string, unknown>;
    expect(body.execution_id).toBe("exec_test_1");
    expect(body.template_id).toBe("tpl-x");
    expect(body.status).toBe("success");
    expect(body.success).toBe(true);
    expect(body.duration_ms).toBe(1234);
    expect(body.cost_usd).toBe(0.05);
  });

  test("failed trace maps status → 'failure' and success → false", async () => {
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await sink.record(makeTrace({ status: "failed" }));
    const body = JSON.parse(fetch.capturedInit!.body as string) as Record<string, unknown>;
    expect(body.status).toBe("failure");
    expect(body.success).toBe(false);
  });

  test("per-task fields land at TOP LEVEL for activity-api normalizePersistedTask", async () => {
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await sink.record(makeTrace());
    const body = JSON.parse(fetch.capturedInit!.body as string) as {
      execution_trace: { tasks: Array<Record<string, unknown>> };
    };
    expect(body.execution_trace.tasks.length).toBe(1);
    const task = body.execution_trace.tasks[0]!;
    // Match the field names normalizePersistedTask reads.
    expect(task.task_id).toBe("t1");
    expect(task.taskId).toBe("t1");
    expect(task.resolver_id).toBe("bash");
    expect(task.success).toBe(true);
    expect(task.status).toBe("success");
    expect(task.duration_ms).toBe(800);
    expect(task.cost_usd).toBe(0.02);
    expect(task.input_impulse_ids).toEqual(["in-1"]);
    expect(task.output_impulse_ids).toEqual(["out-1"]);
  });

  test("nested result block preserved for legacy readers", async () => {
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await sink.record(makeTrace());
    const body = JSON.parse(fetch.capturedInit!.body as string) as {
      execution_trace: { tasks: Array<{ result: Record<string, unknown> }> };
    };
    const result = body.execution_trace.tasks[0]!.result;
    expect(result.status).toBe("success");
    const metadata = result.metadata as Record<string, unknown>;
    expect(metadata.resolver_id).toBe("bash");
    expect(metadata.output_impulse_ids).toEqual(["out-1"]);
  });

  test("non-2xx response is logged and swallowed (does not throw)", async () => {
    const fetch: FetchPort = {
      async request() {
        return new Response("server is sad", { status: 503 });
      },
    };
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    // Spec R5: trace-sink failure never aborts execution.
    await expect(sink.record(makeTrace())).resolves.toBeUndefined();
  });

  test("canonical failure_mode passes through to activity-api", async () => {
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await sink.record(
      makeTrace({
        status: "failed",
        failureMode: {
          type: "budget_exhausted",
          reason: "cost cap hit",
          context: { budget_type: "cost", consumed: 1, allowed: 0.5 },
        },
      }),
    );
    const body = JSON.parse(fetch.capturedInit!.body as string) as Record<string, unknown>;
    expect((body.failure_mode as { type: string }).type).toBe("budget_exhausted");
  });

  test("non-canonical failure_mode (execution_error) is stripped at wire boundary", async () => {
    // activity-api's FailureModeSchema is a discriminatedUnion of 5 literal
    // types. Sending `type: "execution_error"` (engine's internal label for
    // unhandled resolver throws) would fail the discriminator. The sink
    // filters it so the trace still lands with status=failed.
    const fetch = new CapturingFetch();
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await sink.record(
      makeTrace({
        status: "failed",
        failureMode: { type: "execution_error", reason: "resolver threw" },
      }),
    );
    const body = JSON.parse(fetch.capturedInit!.body as string) as Record<string, unknown>;
    expect(body.failure_mode).toBeUndefined();
    expect(body.status).toBe("failure");
  });

  test("network error is logged and swallowed", async () => {
    const fetch: FetchPort = {
      async request() {
        throw new Error("ECONNREFUSED");
      },
    };
    const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch });
    await expect(sink.record(makeTrace())).resolves.toBeUndefined();
  });
});
