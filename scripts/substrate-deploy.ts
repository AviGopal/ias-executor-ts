#!/usr/bin/env bun
/**
 * substrate-deploy — vessel-owned deploy hook for ias-executor-ts.
 *
 * Runs INSIDE the substrate container as the `substrate:deploy` npm script,
 * invoked by the mitosis cutover (vessel-mitosis-cutover.ts step 9b) after the
 * cutover has mirrored this package's staged `src/` into the runtime base root.
 *
 * Why this exists: ias-executor-ts ships as a BUILT `dist/` (package.json
 * `main: ./dist/index.js`) and is a `file:` dependency of several running
 * vessels. Bun copies `dist/` PHYSICALLY into each consumer's
 * `node_modules/@avigopal/ias-executor-ts/dist` rather than symlinking, so a
 * `src/` cutover alone leaves every consumer running the OLD compiled code —
 * the change lands but stays inert. The cutover restarts only the target unit,
 * and ias-executor-ts is a library with no unit of its own, so nothing picks
 * the change up. This hook closes that gap: rebuild dist from the freshly
 * mirrored src, fan it into every consumer's node_modules, and bounce the
 * consumers so they reload the new module. It is the in-container equivalent of
 * the operator's `make sync-ias-executor-ts RESTART=1` (Makefile) — but run by
 * the substrate itself, on its own terms, as part of every executor cutover.
 *
 * Contract:
 *   - env SUBSTRATE_BASE_ROOT: the runtime base root for this vessel
 *     (e.g. /vessels/ias-executor-ts) where the cutover mirrored src/. dist is
 *     built HERE (this dir has node_modules/typescript + tsconfig.build.json).
 *   - Best-effort + fail-soft: a failed consumer copy/restart logs and
 *     continues; the deploy never throws the cutover into failure over one
 *     consumer. Exit 0 unless the build itself fails (then the new dist would
 *     be missing and propagating a stale/partial dist is worse than a loud no).
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";

// Consumers with @avigopal/ias-executor-ts as a `file:` dep (mirrors the
// Makefile IAS_CONSUMERS list). development-vessel is a consumer too, but it is
// the vessel RUNNING this hook — restarting it here would kill the in-flight
// cutover, so it is copied-into but NOT restarted (it picks up the new dist on
// its own next self-restart via the cutover loop).
const CONSUMERS = [
  "goal-host-vessel",
  "ribosome-vessel",
  "boredom-vessel",
  "development-vessel",
  "local-tools-vessel",
  "llm-resolver-vessel",
  "analysis-vessel",
];
const NO_RESTART = new Set(["development-vessel"]);
const VESSELS_ROOT = "/vessels";

const baseRoot = process.env["SUBSTRATE_BASE_ROOT"] ?? "/vessels/ias-executor-ts";
const log = (m: string) => console.log(`[substrate-deploy:ias-executor-ts] ${m}`);

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { encoding: "utf-8", cwd });
  return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// 1. Build dist from the freshly-mirrored src (baseRoot has node_modules + tsconfig).
log(`building dist in ${baseRoot} …`);
const build = run("bun", ["run", "build"], baseRoot);
const freshDist = join(baseRoot, "dist");
if (build.status !== 0 || !existsSync(freshDist)) {
  log(`BUILD FAILED (status=${build.status}) — refusing to propagate. stderr:\n${build.stderr.slice(-800)}`);
  process.exit(1);
}
log("build ok");

// 2. Fan the fresh dist into every consumer's node_modules copy.
for (const v of CONSUMERS) {
  const depRoot = join(VESSELS_ROOT, v, "node_modules", "@avigopal", "ias-executor-ts");
  if (!existsSync(depRoot)) {
    log(`skip ${v} (no @avigopal/ias-executor-ts in node_modules)`);
    continue;
  }
  const target = join(depRoot, "dist");
  try {
    rmSync(target, { recursive: true, force: true });
    cpSync(freshDist, target, { recursive: true });
    log(`pushed dist → ${target}`);
  } catch (e) {
    log(`WARN: copy to ${v} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 3. Restart the consumers so they reload the new compiled module.
for (const v of CONSUMERS) {
  if (NO_RESTART.has(v)) {
    log(`defer restart ${v} (running this hook / self-restarts)`);
    continue;
  }
  const unit = `${v}.service`;
  const check = run("systemctl", ["list-unit-files", unit]);
  if (check.status !== 0) {
    log(`skip restart ${v} (no unit)`);
    continue;
  }
  const r = run("systemctl", ["restart", unit]);
  log(r.status === 0 ? `restarted ${unit}` : `WARN: restart ${unit} failed: ${r.stderr.slice(-200)}`);
}

log("deploy complete");
