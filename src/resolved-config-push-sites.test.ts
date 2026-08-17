/**
 * EVERY POST-INTERPOLATION PUSH SITE MUST RECORD THE ARGUMENTS.
 *
 * The first attempt at recording resolver arguments populated exactly ONE of the engine's
 * EIGHT `taskRecords.push({...})` sites — the commit said "the main push site" and meant it,
 * which is how seven others went unnoticed. One of the seven (the child-activity dispatch)
 * is a SUCCESS path, and success paths are precisely what the ribosome extracts compositions
 * from. So the chain would have stayed broken for dispatched sub-activities while looking
 * fixed everywhere I checked.
 *
 * This is the "enumerate the sibling call sites when you patch your own breakage" rule,
 * applied to the patch itself.
 *
 * The invariant, rather than the instances: a push site that names an INTERPOLATED task
 * (`task` / `inFlightTask`, whose `.config` has had its placeholders substituted) must record
 * `resolvedConfig`. Sites that name `rawTask` are exempt and must STAY exempt — at those three
 * (skip, gate failure, interpolation failure) no resolver ran and `rawTask.config` still holds
 * literal `{{placeholders}}`. Recording those would put un-substituted templates into traces
 * and, downstream, into extracted compositions — a replay that fails confusingly rather than
 * one that fails honestly.
 *
 * A new push site added without the field fails this test rather than silently reintroducing
 * the amputation.
 */

import { describe, it, expect } from "bun:test";

const ENGINE = new URL("./engine.ts", import.meta.url);

/** Returns each `taskRecords.push({` block's source text. */
function pushSites(src: string): string[] {
  const out: string[] = [];
  const marker = "taskRecords.push({";
  let i = src.indexOf(marker);
  while (i !== -1) {
    // Walk braces from the opening `{` so nested object literals are included.
    let depth = 0;
    let j = i + marker.length - 1;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(i, j + 1));
    i = src.indexOf(marker, j);
  }
  return out;
}

describe("engine trace records — the arguments are recorded wherever they exist", () => {
  it("finds every push site (guards the parser itself)", async () => {
    const sites = pushSites(await Bun.file(ENGINE).text());
    // If this drops to a handful the brace-walk broke and every assertion below goes
    // vacuously green — the failure mode this whole file exists to prevent.
    expect(sites.length).toBeGreaterThanOrEqual(8);
  });

  it("THE REGRESSION: every post-interpolation push site records resolvedConfig", async () => {
    const sites = pushSites(await Bun.file(ENGINE).text());
    const interpolated = sites.filter(
      (s) => /taskId:\s*task\.id/.test(s) || /taskId:\s*inFlightTask\.id/.test(s),
    );
    // Before the sweep this was 1 of 5.
    expect(interpolated.length).toBeGreaterThanOrEqual(5);
    const missing = interpolated.filter((s) => !s.includes("resolvedConfig"));
    expect(missing.map((s) => s.slice(0, 90))).toEqual([]);
  });

  it("raw-task sites stay exempt — un-interpolated config must NOT be recorded", async () => {
    const sites = pushSites(await Bun.file(ENGINE).text());
    const raw = sites.filter((s) => /taskId:\s*rawTask\.id/.test(s));
    expect(raw.length).toBeGreaterThanOrEqual(3);
    for (const s of raw) {
      // Recording here would persist literal {{placeholders}} as if they were arguments.
      expect(s).not.toContain("resolvedConfig");
    }
  });

  it("every recorded config goes through the redactor, never raw", async () => {
    const sites = pushSites(await Bun.file(ENGINE).text());
    for (const s of sites.filter((x) => x.includes("resolvedConfig"))) {
      // A raw `resolvedConfig: task.config` would ship secrets into the trace store.
      expect(s).toMatch(/resolvedConfig:\s*redactResolvedConfig\(/);
    }
  });
});
