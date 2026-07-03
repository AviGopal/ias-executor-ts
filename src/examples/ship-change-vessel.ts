/**
 * ship-change vessel — substrate-driven git commit pipeline.
 *
 * Spec context: 2026-05-21 user pivot — the impulse-activity system
 * itself manages its work. Shipping (commit, branch state advancement)
 * is just another activity orchestrated by the substrate, not a sequence
 * of conventional shell calls outside it.
 *
 * Pattern:
 *   Caller provides { paths: string[], message: string }; the vessel
 *   stages those paths, commits with the message, and emits a
 *   gitCommitResult impulse carrying { sha, shortSha, branch, message,
 *   filesStaged, beforeHead, afterHead }. The TRACE replaces the
 *   conventional "git log" entry as the durable record of the work.
 *
 * Failure modes (the four pivot criteria materialized):
 *   - CREATE: runShipChange({ paths, message, cwd }) always returns a
 *     trace + (possibly null) report.
 *   - DETECT-WORKS: trace.status === "completed" ∧ report.sha matches
 *     `git rev-parse HEAD` after the call.
 *   - DETECT-BROKEN: trace.status === "failed" or any task `success=false`.
 *     `git_add` fails when a path doesn't exist; `git_commit` fails when
 *     nothing is staged (e.g. caller asked to commit unchanged files);
 *     `git_show_head` fails outside a repo. Each failure carries the
 *     git stderr verbatim.
 *   - DIAGNOSE-WHY: the synthesizer aggregates each bash task's stderr
 *     into the report's `notes` array — same idiom as branch-health, so
 *     downstream consumers learn one pattern.
 *
 * Bootstrap note: this file's own first commit MUST be conventional
 * (git CLI directly); after that, every commit in this codebase can go
 * through `runShipChange()`. Self-application is intentional.
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

export interface GitCommitResult {
  ok: boolean;
  degraded: boolean;
  branch: string;
  /** Full sha of the commit produced (or HEAD on failure). */
  sha: string;
  shortSha: string;
  /** sha of HEAD before the operation; equal to sha when commit failed. */
  beforeHead: string;
  message: string;
  filesStaged: string[];
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
            taskId: context.task.id,
          },
          loaded: true,
          content: result,
        },
      ];
    },
  };
}

function makeShipChangeSynthesizer(opts: {
  paths: string[];
  message: string;
  branch: string;
}): Resolver {
  return {
    id: "ship_change_synth",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      // Each upstream bash task tagged its task id in metadata so we can
      // pick out the specific results we need regardless of ordering.
      const byTask = (taskId: string) =>
        context.inputImpulses.find((i) => i.metadata.taskId === taskId);

      const beforeRes = byTask("git_head_before")?.content as
        | { exitCode: number; stdout: string; stderr: string }
        | undefined;
      const addRes = byTask("git_add")?.content as
        | { exitCode: number; stdout: string; stderr: string }
        | undefined;
      const commitRes = byTask("git_commit")?.content as
        | { exitCode: number; stdout: string; stderr: string }
        | undefined;
      const afterRes = byTask("git_head_after")?.content as
        | { exitCode: number; stdout: string; stderr: string }
        | undefined;

      const notes: string[] = [];
      const beforeHead = beforeRes?.exitCode === 0 ? beforeRes.stdout.trim() : "unknown";
      if (!beforeRes || beforeRes.exitCode !== 0) {
        notes.push(`HEAD-before lookup failed: ${beforeRes?.stderr.slice(0, 200) ?? "no output"}`);
      }
      if (!addRes || addRes.exitCode !== 0) {
        notes.push(`git add failed: ${addRes?.stderr.slice(0, 200) ?? "no output"}`);
      }
      if (!commitRes || commitRes.exitCode !== 0) {
        notes.push(`git commit failed: ${commitRes?.stderr.slice(0, 200) ?? "no output"}`);
      }
      const sha = afterRes?.exitCode === 0 ? afterRes.stdout.trim() : beforeHead;
      if (!afterRes || afterRes.exitCode !== 0) {
        notes.push(`HEAD-after lookup failed: ${afterRes?.stderr.slice(0, 200) ?? "no output"}`);
      }
      const degraded = notes.length > 0 || sha === beforeHead;
      const result: GitCommitResult = {
        ok: !degraded,
        degraded,
        branch: opts.branch,
        sha,
        shortSha: sha.slice(0, 8),
        beforeHead,
        message: opts.message,
        filesStaged: opts.paths,
        notes,
      };
      return [
        {
          id: context.random.id("git-commit"),
          pointer: { type: "memo" },
          metadata: {
            shape: "gitCommitResult",
            summary: `${opts.branch} ${result.shortSha}${degraded ? " [degraded]" : ""}: ${opts.message.split("\n")[0]?.slice(0, 60)}`,
            source: "ship-change-synth",
            degraded,
          },
          loaded: true,
          content: result,
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function makeShipChangeTemplate(opts: {
  paths: string[];
  message: string;
  cwd: string;
}): ActivityTemplate {
  return {
    id: "ship-change",
    name: "Ship Change",
    description: "Stage and commit a set of paths with a structured commit message.",
    outputShapes: ["gitCommitResult"],
    tasks: [
      {
        id: "git_head_before",
        description: "Capture HEAD sha before any state mutation (provides beforeHead).",
        resolver: "bash",
        config: { command: ["git", "rev-parse", "HEAD"], cwd: opts.cwd },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "git_add",
        description: "Stage the requested paths.",
        resolver: "bash",
        config: { command: ["git", "add", "--", ...opts.paths], cwd: opts.cwd },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "git_commit",
        description: "Commit with the provided message.",
        resolver: "bash",
        config: { command: ["git", "commit", "-m", opts.message], cwd: opts.cwd },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "git_head_after",
        description: "Capture HEAD sha after the commit (the new sha if successful).",
        resolver: "bash",
        config: { command: ["git", "rev-parse", "HEAD"], cwd: opts.cwd },
        outputShapes: ["commandResult"],
      } as ActivityTemplate["tasks"][number],
      {
        id: "synthesize",
        description: "Fold the four bash results into a typed gitCommitResult.",
        resolver: "ship_change_synth",
        config: {},
        inputShapes: ["commandResult"],
        outputShapes: ["gitCommitResult"],
      } as ActivityTemplate["tasks"][number],
    ],
  };
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface ShipChangeArgs {
  paths: string[];
  message: string;
  cwd?: string;
  branch?: string;
  proc?: ProcessPort;
}

export interface ShipChangeResult {
  trace: ExecutionTrace;
  report: GitCommitResult | null;
}

export async function runShipChange(args: ShipChangeArgs): Promise<ShipChangeResult> {
  const cwd = args.cwd ?? process.cwd();
  const proc = args.proc ?? new BunProcessAdapter();
  // Resolve branch eagerly so the synthesizer can fold it in even if the
  // tree was mutated mid-flight (rare; documenting the captured value).
  const branchRes = args.branch
    ? { exitCode: 0, stdout: args.branch, stderr: "" }
    : await proc.run(["git", "symbolic-ref", "--short", "HEAD"], { cwd, timeoutMs: 5000 });
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() : "unknown";

  let counter = 0;
  const runtime = new ExecutionRuntime({
    clock: { now: () => Date.now() },
    random: { id: (prefix: string) => `${prefix}_${++counter}` },
    eventSink: { emit: () => {} },
  });
  
  runtime.resolvers.register(makeBashResolver(proc));
  runtime.resolvers.register(
    makeShipChangeSynthesizer({ paths: args.paths, message: args.message, branch }),
  );

  const executor = new ActivityExecutor(runtime);
  const template = makeShipChangeTemplate({ paths: args.paths, message: args.message, cwd });
  const trace = await executor.execute(template);
  const reportImpulse = runtime.store
    .all()
    .find((i) => i.metadata.shape === "gitCommitResult");
  return {
    trace,
    report: reportImpulse ? (reportImpulse.content as GitCommitResult) : null,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Usage: bun run src/examples/ship-change-vessel.ts <cwd> <message> <path...>
  const cwd = process.argv[2];
  const message = process.argv[3];
  const paths = process.argv.slice(4);
  if (!cwd || !message || paths.length === 0) {
    console.error("usage: ship-change-vessel.ts <cwd> <message> <path...>");
    process.exit(2);
  }
  const { trace, report } = await runShipChange({ cwd, message, paths });
  console.log(`trace.status   = ${trace.status}`);
  for (const t of trace.tasks) {
    console.log(`  ${t.taskId} (${t.resolverId}): success=${t.success}${t.error ? ` error=${t.error.slice(0, 80)}` : ""}`);
  }
  console.log("");
  if (report) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.degraded ? 1 : 0);
  } else {
    console.log("NO REPORT");
    process.exit(2);
  }
}

if ((import.meta as { main?: boolean }).main) {
  main().catch((err) => {
    console.error("[ship-change] FATAL:", err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
