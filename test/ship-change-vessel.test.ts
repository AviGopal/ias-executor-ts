/**
 * ship-change vessel tests — substrate-driven commit pipeline.
 * Same four pivot criteria as branch-health: CREATE, DETECT-WORKS,
 * DETECT-BROKEN, DIAGNOSE-WHY. All driven by scripted ProcessPort so
 * tests are deterministic and don't touch real git state.
 */
import { describe, expect, test } from "bun:test";
import { runShipChange, type GitCommitResult } from "../src/examples/ship-change-vessel";
import type { ProcessPort } from "../src/ports";

class ScriptedProc implements ProcessPort {
  public readonly calls: string[][] = [];
  constructor(private readonly script: (command: string[]) => { exitCode: number; stdout: string; stderr: string }) {}
  async run(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.calls.push(command);
    return this.script(command);
  }
}

describe("ship-change vessel", () => {
  test("CREATE: happy path produces sha + branch + filesStaged", async () => {
    const proc = new ScriptedProc((cmd) => {
      const key = cmd.join(" ");
      if (key === "git symbolic-ref --short HEAD") return { exitCode: 0, stdout: "dev\n", stderr: "" };
      if (key === "git rev-parse HEAD" && cmd.length === 3) {
        // We can't distinguish before/after here without state; use sequence.
        return { exitCode: 0, stdout: "AAAA\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { trace, report } = await runShipChange({
      cwd: "/tmp/fake",
      message: "test commit",
      paths: ["foo.ts", "bar.ts"],
      proc,
    });
    expect(trace.status).toBe("completed");
    expect(report).toBeDefined();
    const r = report as GitCommitResult;
    expect(r.branch).toBe("dev");
    expect(r.message).toBe("test commit");
    expect(r.filesStaged).toEqual(["foo.ts", "bar.ts"]);
  });

  test("DETECT-WORKS: sha advances from beforeHead → afterHead", async () => {
    let calls = 0;
    const proc = new ScriptedProc((cmd) => {
      const key = cmd.join(" ");
      if (key === "git symbolic-ref --short HEAD") return { exitCode: 0, stdout: "dev\n", stderr: "" };
      if (key === "git rev-parse HEAD") {
        calls++;
        return { exitCode: 0, stdout: (calls === 1 ? "AAAA0000" : "BBBB1111") + "\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { report } = await runShipChange({ cwd: "/tmp/fake", message: "x", paths: ["a"], proc });
    const r = report as GitCommitResult;
    expect(r.beforeHead).toBe("AAAA0000");
    expect(r.sha).toBe("BBBB1111");
    expect(r.shortSha).toBe("BBBB1111");
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.notes).toEqual([]);
  });

  test("DETECT-BROKEN: git commit failure marks degraded + sha unchanged", async () => {
    const proc = new ScriptedProc((cmd) => {
      const key = cmd.join(" ");
      if (key === "git symbolic-ref --short HEAD") return { exitCode: 0, stdout: "dev\n", stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "rev-parse") return { exitCode: 0, stdout: "AAAA\n", stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "add") return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "commit") {
        return { exitCode: 1, stdout: "", stderr: "nothing to commit, working tree clean\n" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const { report } = await runShipChange({ cwd: "/tmp/fake", message: "x", paths: ["a"], proc });
    const r = report as GitCommitResult;
    expect(r.ok).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.sha).toBe("AAAA");
    expect(r.beforeHead).toBe("AAAA");
    expect(r.notes.some((n) => n.includes("git commit failed"))).toBe(true);
  });

  test("DIAGNOSE-WHY: notes carry stderr verbatim", async () => {
    const proc = new ScriptedProc((cmd) => {
      const key = cmd.join(" ");
      if (key === "git symbolic-ref --short HEAD") return { exitCode: 0, stdout: "dev\n", stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "rev-parse") return { exitCode: 0, stdout: "AAAA\n", stderr: "" };
      if (cmd[0] === "git" && cmd[1] === "add") {
        return { exitCode: 128, stdout: "", stderr: "fatal: pathspec 'does-not-exist' did not match any files\n" };
      }
      return { exitCode: 1, stdout: "", stderr: "skipped\n" };
    });
    const { report } = await runShipChange({
      cwd: "/tmp/fake",
      message: "x",
      paths: ["does-not-exist"],
      proc,
    });
    const r = report as GitCommitResult;
    const addNote = r.notes.find((n) => n.includes("git add failed"));
    expect(addNote).toBeDefined();
    expect(addNote!).toContain("pathspec 'does-not-exist'");
  });

  test("uses git add -- to separate paths from flags", async () => {
    const proc = new ScriptedProc(() => ({ exitCode: 0, stdout: "AAAA\n", stderr: "" }));
    await runShipChange({ cwd: "/tmp/fake", message: "x", paths: ["--mistake"], proc });
    const addCall = proc.calls.find((c) => c[0] === "git" && c[1] === "add");
    expect(addCall).toBeDefined();
    expect(addCall!.indexOf("--")).toBeGreaterThan(-1);
    // path appears AFTER the separator so it's treated as a path, not a flag.
    expect(addCall!.indexOf("--mistake")).toBeGreaterThan(addCall!.indexOf("--"));
  });
});
