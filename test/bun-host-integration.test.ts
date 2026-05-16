/**
 * Integration tests validating that a Bun host can execute fixture activities
 * by supplying real adapters, without any in-memory mocks in the hot path.
 *
 * These tests close task 10.2: "Validate that a Node/Bun host can execute the
 * same fixtures by supplying adapters only."
 *
 * The fixture activities run in BunHost with real filesystem (tmpdir) and process
 * adapters — the same activities that run in the in-memory tests work here without
 * any code changes to the core.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActivityTemplate } from "../src";
import { BunHost, ConsoleEventSink } from "../src/examples/bun-host";
import { TraceSinkSpy } from "./fakes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ias-bun-host-"));
}

// ---------------------------------------------------------------------------
// BunHost capabilities
// ---------------------------------------------------------------------------

describe("BunHost — capabilities", () => {
  test("lists filesystem and process vessels as attached capabilities", async () => {
    const host = new BunHost();
    const caps = await host.listCapabilities();
    const ids = caps.map((v) => v.id);
    expect(ids).toContain("bun-fs");
    expect(ids).toContain("bun-proc");
  });

  test("does not list llm-vessel when no LLM port is provided", async () => {
    const host = new BunHost();
    const caps = await host.listCapabilities();
    expect(caps.find((v) => v.id === "llm-vessel")).toBeUndefined();
  });

  test("lists llm-vessel when LLM port is injected", async () => {
    const host = new BunHost({
      llm: { async generate() { return ""; } },
    });
    const caps = await host.listCapabilities();
    expect(caps.find((v) => v.id === "llm-vessel")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// file-read resolver (real filesystem)
// ---------------------------------------------------------------------------

describe("BunHost — file-read resolver", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("reads a file and emits a fileContent impulse", async () => {
    const path = join(tmpDir, "fixture.txt");
    await Bun.write(path, "fixture content");

    const template: ActivityTemplate = {
      id: "read-file-fixture",
      name: "Read File Fixture",
      tasks: [
        {
          id: "t1",
          description: "read fixture",
          resolver: "file-read",
          config: { path },
          outputShapes: ["fileContent"],
        },
      ],
      outputShapes: ["fileContent"],
    };

    const host = new BunHost();
    const trace = await host.execute(template);

    expect(trace.status).toBe("completed");
    const outputs = host.runtime.store.findByShape("fileContent");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.content).toBe("fixture content");
  });

  test("fails with execution_error when file does not exist", async () => {
    const template: ActivityTemplate = {
      id: "missing-file",
      name: "Missing File",
      tasks: [
        { id: "t1", description: "read", resolver: "file-read", config: { path: join(tmpDir, "ghost.txt") } },
      ],
    };
    const host = new BunHost();
    const trace = await host.execute(template);

    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.type).toBe("execution_error");
    expect(trace.failureMode?.reason).toContain("File not found");
  });

  test("fails with execution_error when config.path is missing", async () => {
    const template: ActivityTemplate = {
      id: "bad-config",
      name: "Bad Config",
      tasks: [{ id: "t1", description: "bad config", resolver: "file-read" }],
    };
    const host = new BunHost();
    const trace = await host.execute(template);
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("config.path");
  });
});

// ---------------------------------------------------------------------------
// bash resolver (real process)
// ---------------------------------------------------------------------------

describe("BunHost — bash resolver", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("runs echo and emits commandResult impulse", async () => {
    const template: ActivityTemplate = {
      id: "echo-fixture",
      name: "Echo Fixture",
      tasks: [
        {
          id: "t1",
          description: "echo",
          resolver: "bash",
          config: { command: ["echo", "hello bun host"] },
          outputShapes: ["commandResult"],
        },
      ],
      outputShapes: ["commandResult"],
    };

    const host = new BunHost();
    const trace = await host.execute(template);

    expect(trace.status).toBe("completed");
    const results = host.runtime.store.findByShape("commandResult");
    expect(results).toHaveLength(1);
    expect((results[0]?.content as { exitCode: number }).exitCode).toBe(0);
    expect((results[0]?.content as { stdout: string }).stdout.trim()).toBe("hello bun host");
  });

  test("records non-zero exit code in commandResult without failing the activity", async () => {
    const template: ActivityTemplate = {
      id: "fail-exit",
      name: "Fail Exit",
      tasks: [
        {
          id: "t1",
          description: "fail",
          resolver: "bash",
          config: { command: ["sh", "-c", "exit 5"] },
          outputShapes: ["commandResult"],
        },
      ],
    };
    const host = new BunHost();
    const trace = await host.execute(template);

    expect(trace.status).toBe("completed"); // bash resolver doesn't convert exit code to failure
    const results = host.runtime.store.findByShape("commandResult");
    expect((results[0]?.content as { exitCode: number }).exitCode).toBe(5);
  });

  test("respects cwd config option", async () => {
    const template: ActivityTemplate = {
      id: "cwd-test",
      name: "Cwd Test",
      tasks: [
        {
          id: "t1",
          description: "pwd",
          resolver: "bash",
          config: { command: ["sh", "-c", "pwd"], cwd: tmpDir },
          outputShapes: ["commandResult"],
        },
      ],
    };
    const host = new BunHost();
    const trace = await host.execute(template);

    expect(trace.status).toBe("completed");
    const result = host.runtime.store.findByShape("commandResult")[0];
    expect((result?.content as { stdout: string }).stdout.trim()).toContain("tmp");
  });

  test("fails with execution_error when command config is missing", async () => {
    const template: ActivityTemplate = {
      id: "bad-bash",
      name: "Bad Bash",
      tasks: [{ id: "t1", description: "no command", resolver: "bash" }],
    };
    const host = new BunHost();
    const trace = await host.execute(template);
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("config.command");
  });
});

// ---------------------------------------------------------------------------
// Multi-step fixture (file-read + bash in sequence — same fixtures as in-memory tests)
// ---------------------------------------------------------------------------

describe("BunHost — multi-step fixture activity", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  test("reads a file then counts its lines via bash — trace records both tasks", async () => {
    const path = join(tmpDir, "data.txt");
    await Bun.write(path, "a\nb\nc\n");

    const template: ActivityTemplate = {
      id: "read-and-count",
      name: "Read and Count",
      tasks: [
        {
          id: "read",
          description: "read file",
          resolver: "file-read",
          config: { path },
          outputShapes: ["fileContent"],
        },
        {
          id: "count",
          description: "count lines",
          resolver: "bash",
          config: { command: ["sh", "-c", `wc -l < ${path}`] },
          outputShapes: ["commandResult"],
        },
      ],
      outputShapes: ["fileContent", "commandResult"],
    };

    const traces = new TraceSinkSpy();
    const host = new BunHost({ traceSink: traces });
    const trace = await host.execute(template, { reason: "fixture test" });

    expect(trace.status).toBe("completed");
    expect(trace.tasks).toHaveLength(2);
    expect(trace.tasks[0]?.taskId).toBe("read");
    expect(trace.tasks[1]?.taskId).toBe("count");
    expect(traces.last()?.reason).toBe("fixture test");

    const countResult = host.runtime.store.findByShape("commandResult")[0];
    expect(Number((countResult?.content as { stdout: string }).stdout.trim())).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ConsoleEventSink (smoke — no assertions, just verify it doesn't throw)
// ---------------------------------------------------------------------------

describe("ConsoleEventSink", () => {
  test("accepts events without throwing", () => {
    const sink = new ConsoleEventSink();
    expect(() => sink.emit({
      type: "activity.started",
      timestamp: Date.now(),
      data: { executionId: "test", templateId: "t" },
    })).not.toThrow();
  });
});
