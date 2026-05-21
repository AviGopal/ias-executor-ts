/**
 * branch-health vessel tests — cover the four success criteria from the
 * 2026-05-21 pivot:
 *   1. Create: runBranchHealth(workdir) returns a trace + report.
 *   2. Detect-works: report.ok === true and degraded === false when every
 *      data-gathering step succeeds.
 *   3. Detect-broken: report.degraded === true and notes enumerate the
 *      failing steps when something breaks.
 *   4. Diagnose-why: each note carries the failed step's stderr so the
 *      cause is visible from the report alone.
 */
import { describe, expect, test } from "bun:test";
import { runBranchHealth, type BranchHealthReport } from "../src/examples/branch-health";
import type { ProcessPort } from "../src/ports";

class ScriptedProc implements ProcessPort {
  constructor(private readonly script: Map<string, { exitCode: number; stdout: string; stderr: string }>) {}
  async run(command: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const key = command.join(" ");
    const hit = this.script.get(key);
    if (hit) return hit;
    // Default: succeed with empty output so unmatched commands don't
    // accidentally degrade the report.
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("branch-health vessel", () => {
  test("CREATE: returns trace + report end-to-end", async () => {
    const proc = new ScriptedProc(
      new Map([
        ["git symbolic-ref --short HEAD", { exitCode: 0, stdout: "dev\n", stderr: "" }],
        ["git status --porcelain", { exitCode: 0, stdout: "M src/foo.ts\n", stderr: "" }],
        ["git diff --shortstat HEAD", { exitCode: 0, stdout: " 1 file changed, 3 insertions(+)\n", stderr: "" }],
        ["git log -5 --pretty=%s", { exitCode: 0, stdout: "feat: add x\nfix: bar\n", stderr: "" }],
      ]),
    );
    const { trace, report } = await runBranchHealth("/tmp/fake", { proc });
    expect(trace.status).toBe("completed");
    expect(trace.tasks.length).toBe(5);
    expect(report).toBeDefined();
    expect(report!.workdir).toBe("/tmp/fake");
  });

  test("DETECT-WORKS: ok=true + degraded=false when all steps succeed", async () => {
    const proc = new ScriptedProc(
      new Map([
        ["git symbolic-ref --short HEAD", { exitCode: 0, stdout: "main\n", stderr: "" }],
        ["git status --porcelain", { exitCode: 0, stdout: "", stderr: "" }],
        ["git diff --shortstat HEAD", { exitCode: 0, stdout: "", stderr: "" }],
        ["git log -5 --pretty=%s", { exitCode: 0, stdout: "initial commit\n", stderr: "" }],
      ]),
    );
    const { report } = await runBranchHealth("/tmp/clean", { proc });
    const r = report as BranchHealthReport;
    expect(r.ok).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.notes).toEqual([]);
    expect(r.branch).toBe("main");
    expect(r.workingTreeChanges).toBe(0);
    expect(r.recentCommits).toEqual(["initial commit"]);
  });

  test("DETECT-BROKEN: degraded=true with notes when git status fails", async () => {
    const proc = new ScriptedProc(
      new Map([
        ["git symbolic-ref --short HEAD", { exitCode: 0, stdout: "dev\n", stderr: "" }],
        ["git status --porcelain", { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" }],
        ["git diff --shortstat HEAD", { exitCode: 0, stdout: "", stderr: "" }],
        ["git log -5 --pretty=%s", { exitCode: 0, stdout: "", stderr: "" }],
      ]),
    );
    const { report, trace } = await runBranchHealth("/tmp/broken", { proc });
    const r = report as BranchHealthReport;
    expect(r.degraded).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.includes("git status failed"))).toBe(true);
    // Trace still completes — partial state is renderable.
    expect(trace.status).toBe("completed");
  });

  test("DIAGNOSE-WHY: notes carry the failing step's stderr verbatim", async () => {
    const proc = new ScriptedProc(
      new Map([
        ["git symbolic-ref --short HEAD", { exitCode: 0, stdout: "dev\n", stderr: "" }],
        ["git status --porcelain", { exitCode: 0, stdout: "", stderr: "" }],
        [
          "git diff --shortstat HEAD",
          { exitCode: 1, stdout: "", stderr: "fatal: ambiguous argument 'HEAD': unknown revision\n" },
        ],
        ["git log -5 --pretty=%s", { exitCode: 0, stdout: "", stderr: "" }],
      ]),
    );
    const { report } = await runBranchHealth("/tmp/no-head", { proc });
    const r = report as BranchHealthReport;
    const diffNote = r.notes.find((n) => n.includes("git diff --shortstat failed"));
    expect(diffNote).toBeDefined();
    expect(diffNote!).toContain("ambiguous argument");
    // Cause is one hop from the report; consumer doesn't need to read the trace.
  });

  test("trace records per-task success even when report is degraded", async () => {
    const proc = new ScriptedProc(
      new Map([
        ["git symbolic-ref --short HEAD", { exitCode: 1, stdout: "", stderr: "boom\n" }],
        ["git status --porcelain", { exitCode: 0, stdout: "", stderr: "" }],
        ["git diff --shortstat HEAD", { exitCode: 0, stdout: "", stderr: "" }],
        ["git log -5 --pretty=%s", { exitCode: 0, stdout: "", stderr: "" }],
      ]),
    );
    const { trace, report } = await runBranchHealth("/tmp/no-branch", { proc });
    // Bash resolver itself succeeded (it ran the command); the synth's
    // semantic check turns the non-zero exit code into a note. This
    // separation is intentional — process invocation vs domain success.
    expect(trace.tasks.every((t) => t.success)).toBe(true);
    expect((report as BranchHealthReport).branch).toBe("unknown");
    expect((report as BranchHealthReport).notes.some((n) => n.includes("branch lookup failed"))).toBe(true);
  });
});
