#!/usr/bin/env bun
/**
 * verify-dist-fresh — F-111 closure for ias-executor-ts.
 *
 * Context: dist/ is gitignored in this repo (it's a build artifact). The
 * substrate-live container at /vessels/ias-executor-ts/dist/ is the runtime
 * artifact. Auditors read the container's dist — but devs edit src/. If
 * the container's dist diverges from a fresh build of the local src, the
 * audit can mistake stale behavior for current intent.
 *
 * Strategy:
 *   1. Run `bun run build` locally → produces dist/ from current src/
 *   2. Compute sha256 hashes of every dist/**.js + dist/**.d.ts file
 *   3. Read the substrate container's /vessels/ias-executor-ts/dist/ via
 *      `docker exec`, compute hashes there
 *   4. Diff. Any mismatch → container has stale dist; deploy needs a
 *      `docker cp` of fresh dist/ files
 *
 * Exit codes:
 *   0 — substrate container's dist matches a fresh local build
 *   1 — drift detected (run docker cp to sync)
 *   2 — script error (build failed, container unreachable, etc.)
 *
 * Usage:
 *   bun run scripts/verify-dist-fresh.ts                  # default container 'substrate-live'
 *   IAS_CONTAINER=other-substrate bun run scripts/verify-dist-fresh.ts
 *   IAS_CONTAINER_PATH=/v/ias/dist bun run scripts/verify-dist-fresh.ts
 *
 * Pre-existing tsc errors are tolerated as long as dist/ still emits.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const LOCAL_DIST = join(REPO_ROOT, "dist");
const CONTAINER = process.env["IAS_CONTAINER"] ?? "substrate-live";
const CONTAINER_DIST = process.env["IAS_CONTAINER_PATH"] ?? "/vessels/ias-executor-ts/dist";

function run(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  return { status: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function listFiles(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && (entry.endsWith(".js") || entry.endsWith(".d.ts"))) out.push(full);
    }
  }
  walk(root);
  return out;
}

function hashLocal(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashContainer(relPath: string): string | null {
  // Read the file via docker exec and hash here. Avoids requiring sha256sum in container.
  const r = run("docker", ["exec", CONTAINER, "cat", join(CONTAINER_DIST, relPath)]);
  if (r.status !== 0) return null;
  return createHash("sha256").update(r.stdout).digest("hex");
}

function main() {
  // 1. Build locally (tolerate non-fatal tsc errors as long as dist emits)
  console.log(`verify-dist-fresh: building local dist/ from src/...`);
  const build = run("bun", ["run", "build"]);
  if (!existsSync(LOCAL_DIST)) {
    console.error("verify-dist-fresh: local build did not produce dist/");
    console.error(build.stderr.slice(0, 500));
    process.exit(2);
  }

  // 2. Hash local dist files
  const localFiles = listFiles(LOCAL_DIST);
  if (localFiles.length === 0) {
    console.error(`verify-dist-fresh: local dist/ has zero .js/.d.ts files`);
    process.exit(2);
  }
  const localHashes = new Map<string, string>();
  for (const path of localFiles) {
    localHashes.set(relative(LOCAL_DIST, path), hashLocal(path));
  }

  // 3. Check container reachable
  const probe = run("docker", ["exec", CONTAINER, "test", "-d", CONTAINER_DIST]);
  if (probe.status !== 0) {
    console.error(`verify-dist-fresh: container ${CONTAINER} unreachable or ${CONTAINER_DIST} missing`);
    console.error(probe.stderr.slice(0, 300));
    process.exit(2);
  }
  console.log(`verify-dist-fresh: comparing ${localHashes.size} local file(s) vs container ${CONTAINER}:${CONTAINER_DIST}`);

  // 4. Hash container files
  const stale: string[] = [];
  const missingInContainer: string[] = [];

  for (const [rel, localHash] of localHashes) {
    const containerHash = hashContainer(rel);
    if (containerHash === null) {
      missingInContainer.push(rel);
      continue;
    }
    if (containerHash !== localHash) stale.push(rel);
  }

  if (stale.length === 0 && missingInContainer.length === 0) {
    console.log(`verify-dist-fresh: OK — container ${CONTAINER} dist/ matches local src/`);
    process.exit(0);
  }

  console.error(`verify-dist-fresh: DRIFT DETECTED — container ${CONTAINER} dist/ is stale vs local src/`);
  console.error("");
  if (stale.length > 0) {
    console.error(`  ${stale.length} file(s) differ in content:`);
    for (const rel of stale.slice(0, 15)) console.error(`  STALE   ${rel}`);
    if (stale.length > 15) console.error(`  ... +${stale.length - 15} more`);
  }
  if (missingInContainer.length > 0) {
    console.error(`  ${missingInContainer.length} file(s) missing in container:`);
    for (const rel of missingInContainer.slice(0, 10)) console.error(`  MISSING ${rel}`);
    if (missingInContainer.length > 10) console.error(`  ... +${missingInContainer.length - 10} more`);
  }
  console.error("");
  console.error("Fix:");
  console.error(`  docker cp dist/. ${CONTAINER}:${CONTAINER_DIST}/`);
  console.error(`  docker exec ${CONTAINER} systemctl restart goal-host-vessel.service`);
  process.exit(1);
}

main();
