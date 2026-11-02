import { test, expect } from "bun:test";
import * as mod from "../../src/adapters/activity-api-trace-sink";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "ias-spool-check-"));
  try {
    return await fn(dir);
  } finally {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }
}

// MUST-FAIL: a trace spooled during a window and replayed after it arrives with a completed_at
// inside the window. Today spoolTrace writes top-level spooled_at but does NOT inject that value
// into the stored body; replay posts the body without completed_at. This assertion expects the
// body to carry completed_at equal to spooled_at, so it fails under the current defect.
test("spooled trace body should carry completed_at equal to spooled_at (defect: missing)", async () => {
  await withTempDir(async (dir) => {
    const prev = process.env.IAS_TRACE_SPOOL_DIR;
    process.env.IAS_TRACE_SPOOL_DIR = dir;
    try {
      const sink = new mod.TranslatingTraceSink("http://example.test", "api-key");
      const traceId = "exec-123";
      const bodyJson = { execution_id: traceId, duration_ms: 42 }; // no completed_at
      const ok: boolean = await (sink as unknown as { spoolTrace: (json: string, id: string) => Promise<boolean> }).spoolTrace(JSON.stringify(bodyJson), traceId);
      expect(ok).toBe(true);

      const files = await readdir(dir);
      expect(files.length).toBe(1);
      const content = await readFile(join(dir, files[0]!), "utf8");
      const envelope = JSON.parse(content) as { spooled_at: string; body: string };
      const body = JSON.parse(envelope.body) as Record<string, unknown>;

      // EXPECTED AFTER FIX: completed_at is injected into body equal to the envelope's spooled_at.
      // CURRENTLY: body.completed_at is undefined, so this fails.
      expect(body["completed_at"]).toBe(envelope.spooled_at);
    } finally {
      if (prev === undefined) delete process.env.IAS_TRACE_SPOOL_DIR; else process.env.IAS_TRACE_SPOOL_DIR = prev;
    }
  });
});

// CONTROL: An input the defect does not touch — the spool envelope must still record endpoint and trace_id.
// This behavior should remain unchanged both before and after the fix.
test("spool file records endpoint and trace_id (control)", async () => {
  await withTempDir(async (dir) => {
    const prev = process.env.IAS_TRACE_SPOOL_DIR;
    process.env.IAS_TRACE_SPOOL_DIR = dir;
    try {
      const endpoint = "http://control.test";
      const sink = new mod.TranslatingTraceSink(endpoint, "api-key");
      const traceId = "ctrl-456";
      const ok: boolean = await (sink as unknown as { spoolTrace: (json: string, id: string) => Promise<boolean> }).spoolTrace(JSON.stringify({ execution_id: traceId, duration_ms: 1 }), traceId);
      expect(ok).toBe(true);

      const files = await readdir(dir);
      expect(files.length).toBe(1);
      const content = await readFile(join(dir, files[0]!), "utf8");
      const envelope = JSON.parse(content) as { endpoint: string; trace_id: string };
      expect(envelope.endpoint).toBe(endpoint);
      expect(envelope.trace_id).toBe(traceId);
    } finally {
      if (prev === undefined) delete process.env.IAS_TRACE_SPOOL_DIR; else process.env.IAS_TRACE_SPOOL_DIR = prev;
    }
  });
});
