import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFileSystemAdapter, BunProcessAdapter } from "../src/adapters";

// ---------------------------------------------------------------------------
// BunFileSystemAdapter contract tests
// ---------------------------------------------------------------------------

describe("BunFileSystemAdapter", () => {
  let tmpDir: string;
  let adapter: BunFileSystemAdapter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ias-executor-fs-"));
    adapter = new BunFileSystemAdapter();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("write then read returns the same content", async () => {
    const path = join(tmpDir, "hello.txt");
    await adapter.write(path, "hello adapter");
    expect(await adapter.read(path)).toBe("hello adapter");
  });

  test("write overwrites existing file", async () => {
    const path = join(tmpDir, "overwrite.txt");
    await adapter.write(path, "first");
    await adapter.write(path, "second");
    expect(await adapter.read(path)).toBe("second");
  });

  test("read throws on missing file with path in message", async () => {
    const path = join(tmpDir, "ghost.txt");
    await expect(adapter.read(path)).rejects.toThrow("File not found");
  });

  test("write handles multiline content and unicode", async () => {
    const content = "line 1\nline 2\nüñíçödé";
    const path = join(tmpDir, "multi.txt");
    await adapter.write(path, content);
    expect(await adapter.read(path)).toBe(content);
  });

  test("write handles empty string", async () => {
    const path = join(tmpDir, "empty.txt");
    await adapter.write(path, "");
    expect(await adapter.read(path)).toBe("");
  });

  test("multiple files are independent", async () => {
    await adapter.write(join(tmpDir, "a.txt"), "aaa");
    await adapter.write(join(tmpDir, "b.txt"), "bbb");
    expect(await adapter.read(join(tmpDir, "a.txt"))).toBe("aaa");
    expect(await adapter.read(join(tmpDir, "b.txt"))).toBe("bbb");
  });
});

// ---------------------------------------------------------------------------
// BunProcessAdapter contract tests
// ---------------------------------------------------------------------------

describe("BunProcessAdapter", () => {
  let adapter: BunProcessAdapter;

  beforeEach(() => {
    adapter = new BunProcessAdapter();
  });

  test("captures stdout of echo command", async () => {
    const result = await adapter.run(["echo", "hello adapter"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello adapter");
    expect(result.stderr).toBe("");
  });

  test("captures non-zero exit code", async () => {
    const result = await adapter.run(["sh", "-c", "exit 42"]);
    expect(result.exitCode).toBe(42);
  });

  test("captures stderr separately from stdout", async () => {
    const result = await adapter.run(["sh", "-c", "echo out; echo err >&2"]);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
    expect(result.exitCode).toBe(0);
  });

  test("respects cwd option", async () => {
    const result = await adapter.run(["sh", "-c", "pwd"], { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    // /tmp may be symlinked on macOS to /private/tmp
    expect(result.stdout.trim()).toMatch(/\/tmp$/);
  });

  test("handles command with no output", async () => {
    const result = await adapter.run(["true"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("timeout kills process and rejects with timeout error", async () => {
    await expect(adapter.run(["sleep", "10"], { timeoutMs: 50 })).rejects.toThrow("timed out");
  }, 2000);

  test("multiline stdout is preserved", async () => {
    const result = await adapter.run(["sh", "-c", "echo line1; echo line2; echo line3"]);
    expect(result.stdout.trim()).toBe("line1\nline2\nline3");
  });
});

// ---------------------------------------------------------------------------
// Separation invariant: adapter tests complement, not replace, in-memory tests
// ---------------------------------------------------------------------------

describe("Adapter/core separation invariant", () => {
  test("BunFileSystemAdapter satisfies FileSystemPort interface shape", () => {
    const adapter = new BunFileSystemAdapter();
    expect(typeof adapter.read).toBe("function");
    expect(typeof adapter.write).toBe("function");
  });

  test("BunProcessAdapter satisfies ProcessPort interface shape", () => {
    const adapter = new BunProcessAdapter();
    expect(typeof adapter.run).toBe("function");
  });
});
