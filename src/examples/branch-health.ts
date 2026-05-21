/**
 * Branch-health vessel — first concrete vessel-driven environ.
 *
 * Spec context: 2026-05-21 user pivot — primary use of ias-executor-ts is
 * to replace conventional software with vessel-based environs. Branch-health
 * is a small, self-contained example showing the full pattern:
 *
 *   - Activity template with three deterministic data-gathering tasks
 *     (git status / git diff stat / git log summary) plus one deterministic
 *     synthesis task that aggregates into a typed `branchHealthReport`
 *     impulse.
 *   - Zero LLM, zero network — runs entirely off ProcessPort + the local
 *     git binary. Reproducible across machines.
 *   - Success and failure are both readable from the returned trace:
 *     - trace.status (completed | failed) and per-task `success` booleans
 *       answer "did it work?".
 *     - per-task `error` strings + the report's `notes` array answer
 *       "why did it break?" — the synthesizer marks a degraded report
 *       when any data-gathering task failed but still produces a report
 *       so the consumer can render partial state.
 *
 * Success criteria for this example (per the pivot's four criteria):
 *   (1) Create — runBranchHealth(workdir) produces a report end-to-end.
 *   (2) Detect-works — report.degraded === false ∧ all tasks success=true.
 *   (3) Detect-broken — report.degraded === true with `notes` enumerating
 *       the failed steps.
 *   (4) Diagnose — each `notes` entry carries the failing task's stderr
 *       so the cause is one hop away from the report.
 */

import { ActivityExecutor } from "../engine";
import { ExecutionRuntime } from "../runtime";
import { ResolverRegistry } from "../resolvers";
import { BunProcessAdapter } from "../adapters/bun-process";
import type { Resolver, ResolverContext } from "../resolvers";
import type { Impulse, ActivityTemplate, ExecutionTrace } from "../ontology";
import type { ProcessPort } from "../ports";

// ---------------------------------------------------------------------------
// Output shape
// ---------------------------------------------------------------------------

export interface BranchHealthReport {
  /** Working directory the probe ran against. */
  workdir: string;
  /** Branch name at the time of probe; `unknown` if `git symbolic-ref` failed. */
  branch: string;
  /** True if every data-gathering task succeeded. */
  ok: boolean;
  /** True if any data-gathering task failed; report is still emitted. */
  degraded: boolean;
  /** Line count from `git status --porcelain` (working-tree dirtiness). */
  workingTreeChanges: number;
  /** Files changed + insertions/deletions vs HEAD (best-effort). */
  diffStat: { filesChanged: number; insertions: number; deletions: number };
  /** Last N commit subjects (best-effort). */
  recentCommits: string[];
  /** Per-step diagnostic notes — empty when ok. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

function makeBashResolver(proc: ProcessPort): Resolver {
  return {
    id: "bash",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const command = context.task.config?.command;
      if (!Array.isArray(command)) {
        throw new Error(`bash resolver requires task.config.command (string[])`);
      }
      const cwd = typeof context.task.config?.cwd === "string" ? context.task.config.cwd : undefined;
      const timeoutMs = typeof context.task.config?.timeoutMs === "number" ? context.task.config.timeoutMs : 10_000;
      const result = await proc.run(command, { cwd, timeoutMs });
      return [
        {
          id: context.random.id("bash"),
          pointer: { type: "memo" },
          metadata: {
            shape: "commandResult",
            summary: `exit=${result.exitCode} (${command.slice(0, 3).join(" ")})`,
            source: "bash",
          },
          loaded: true,
          content: result,
        },
      ];
    },
  };
}

/**
 * Synthesizer resolver — reads the four commandResult impulses in the
 * input pool and folds them into a single branchHealthReport.
 *
 * Diagnostics: when a step's commandResult has `exitCode !== 0`, the
 * synthesizer adds a note (`<step>: <stderr-summary>`). The consumer can
 * grep notes to see what broke; the per-task trace record holds the same
 * info one level deeper.
 */
function makeBranchHealthSynthesizer(workdir: string): Resolver {
  return {
    id: "branch_health_synth",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const byShape = (shape: string) =>
        context.inputImpulses.find(
          (i) => i.metadata.shape === shape || i.metadata.summary?.toString().includes(shape),
        );
      // Bash results are tagged by impulse id in the order they were added,
      // but each task only emits one commandResult, so we collect all and
      // align by order: [branch, status, diff-stat, log].
      const cmds = context.inputImpulses
        .filter((i) => i.metadata.shape === "commandResult")
        .map((i) => i.content as { exitCode: number; stdout: string; stderr: string });
      // Defensive: if upstream tasks failed, some indices will be missing —
      // every getter must tolerate undefined.
      const [branchRes, statusRes, diffRes, logRes] = cmds;
      void byShape; // shape lookup reserved for future fan-in changes
      const notes: string[] = [];

      const branch = branchRes?.exitCode === 0
        ? branchRes.stdout.trim().replace(/^refs\/heads\//, "")
        : "unknown";
      if (!branchRes || branchRes.exitCode !== 0) {
        notes.push(`branch lookup failed: ${branchRes?.stderr.slice(0, 200) ?? "no output"}`);
      }

      const workingTreeChanges = statusRes?.exitCode === 0
        ? statusRes.stdout.trim().split("\n").filter((l) => l.length > 0).length
        : 0;
      if (!statusRes || statusRes.exitCode !== 0) {
        notes.push(`git status failed: ${statusRes?.stderr.slice(0, 200) ?? "no output"}`);
      }

      let diffStat = { filesChanged: 0, insertions: 0, deletions: 0 };
      if (diffRes?.exitCode === 0) {
        // `git diff --shortstat` output: " 3 files changed, 27 insertions(+), 4 deletions(-)"
        const text = diffRes.stdout.trim();
        const filesM = /(\d+) files? changed/.exec(text);
        const insM = /(\d+) insertions?\(\+\)/.exec(text);
        const delM = /(\d+) deletions?\(-\)/.exec(text);
        diffStat = {
          filesChanged: filesM ? parseInt(filesM[1]!, 10) : 0,
          insertions: insM ? parseInt(insM[1]!, 10) : 0,
          deletions: delM ? parseInt(delM[1]!, 10) : 0,
        };
      } else {
        notes.push(`git diff --shortstat failed: ${diffRes?.stderr.slice(0, 200) ?? "no output"}`);
      }

      const recentCommits = logRes?.exitCode === 0
        ? logRes.stdout.trim().split("\n").filter((l) => l.length > 0)
        : [];
      if (!logRes || logRes.exitCode !== 0) {
        notes.push(`git log failed: ${logRes?.stderr.slice(0, 200) ?? "no output"}`);
      }

      const degraded = notes.length > 0;
      const report: BranchHealthReport = {
        workdir,
        branch,
        ok: !degraded,
        degraded,
        workingTreeChanges,
        diffStat,
        recentCommits,
        notes,
      };
      return [
        {
          id: context.random.id("branch-health"),
          pointer: { type: "memo" },
          metadata: {
            shape: "branchHealthReport",
            summary: `${branch}: ${workingTreeChanges} change(s), ${diffStat.filesChanged} file(s) diff${degraded ? " [degraded]" : ""}`,
            source: "branch-health-synth",
            degraded,
          },
          loaded: true,
          content: report,
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function makeBranchHealthTemplate(workdir: string): ActivityTemplate {
  return {
    id: "branch-health",
    name: "Branch Health",
    description: "Probe the working tree + recent commits and emit a branchHealthReport.",
    outputShapes: ["branchHealthReport"],
    tasks: [
      {
        id: "get-branch",
        description: "Resolve the current branch name (HEAD ref).",
        resolver: "bash",
        config: { command: ["git", "symbolic-ref", "--short", "HEAD"], cwd: workdir },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "get-status",
        description: "Capture working-tree changes via git status --porcelain.",
        resolver: "bash",
        config: { command: ["git", "status", "--porcelain"], cwd: workdir },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "get-diff-stat",
        description: "Capture cumulative diff stat vs HEAD.",
        resolver: "bash",
        config: { command: ["git", "diff", "--shortstat", "HEAD"], cwd: workdir },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "get-recent-log",
        description: "Capture the last 5 commit subjects.",
        resolver: "bash",
        config: { command: ["git", "log", "-5", "--pretty=%s"], cwd: workdir },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "synthesize",
        description: "Fold the four commandResult impulses into a typed report.",
        resolver: "branch_health_synth",
        config: {},
        inputShapes: ["commandResult"],
        outputShapes: ["branchHealthReport"],
      } as ActivityTemplate["tasks"][number],
    ],
  };
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface BranchHealthResult {
  trace: ExecutionTrace;
  report: BranchHealthReport | null;
}

export async function runBranchHealth(
  workdir: string = process.cwd(),
  options: { proc?: ProcessPort } = {},
): Promise<BranchHealthResult> {
  const proc = options.proc ?? new BunProcessAdapter();
  let counter = 0;
  const runtime = new ExecutionRuntime({
    clock: { now: () => Date.now() },
    random: { id: (prefix: string) => `${prefix}_${++counter}` },
    eventSink: { emit: () => {} },
  });
  runtime.resolvers = new ResolverRegistry();
  runtime.resolvers.register(makeBashResolver(proc));
  runtime.resolvers.register(makeBranchHealthSynthesizer(workdir));

  const executor = new ActivityExecutor(runtime);
  const template = makeBranchHealthTemplate(workdir);
  const trace = await executor.execute(template);
  const reportImpulse = runtime.store
    .all()
    .find((i) => i.metadata.shape === "branchHealthReport");
  return {
    trace,
    report: reportImpulse ? (reportImpulse.content as BranchHealthReport) : null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const workdir = process.argv[2] ?? process.cwd();
  const { trace, report } = await runBranchHealth(workdir);
  console.log(`trace.status     = ${trace.status}`);
  console.log(`trace.tasks      = ${trace.tasks.length} (success: ${trace.tasks.filter((t) => t.success).length})`);
  for (const t of trace.tasks) {
    console.log(`  ${t.taskId} (${t.resolverId}): success=${t.success}${t.error ? ` error=${t.error.slice(0, 80)}` : ""}`);
  }
  if (report) {
    console.log("");
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\nNO REPORT — synthesizer never fired (upstream failure).");
  }
}

// Run when invoked directly (matches Bun's import.meta.main convention).
if ((import.meta as { main?: boolean }).main) {
  main().catch((err) => {
    console.error("[branch-health] FATAL:", err.message ?? err);
    process.exit(1);
  });
}
