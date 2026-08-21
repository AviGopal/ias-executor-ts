/**
 * Test isolation for the trace spool.
 *
 * `activity-api-trace-sink.ts:322` defaults `IAS_TRACE_SPOOL_DIR` to
 * `/workspace/trace-spool` — the LIVE spool in a running substrate. Any suite
 * that constructs a TranslatingTraceSink and lets a record fail therefore
 * writes into production's retry queue.
 *
 * Measured 2026-08-21, on the box this repo was being validated on: **81 of 83
 * spool files were `exec_test_1` debris** written by test runs, burying two
 * genuine production traces. That is not merely litter — `drainSpool` takes
 * `.sort().slice(0, 25)`, oldest-first by timestamp-prefixed filename, so every
 * test run pushes real traces further behind a permanently-retryable prefix.
 * The two real ones had fallen to ranks 64 and 73 and would never be attempted,
 * including one whose recorded endpoint was the live store that answers 200 and
 * would have accepted it on the first try.
 *
 * Running the tests degraded the system the tests exist to protect. Preload this
 * so the default can never point at production again:
 *
 *   bun test --preload ./test/setup-spool-isolation.ts
 *
 * (wired via bunfig.toml so a bare `bun test` gets it too.)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.IAS_TRACE_SPOOL_DIR) {
  process.env.IAS_TRACE_SPOOL_DIR = mkdtempSync(join(tmpdir(), "ias-trace-spool-"));
}
