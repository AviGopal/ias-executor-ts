/**
 * THE SINK PROJECTS AN EXPLICIT KEY SET — A RECORDED FIELD IS NOT A SENT FIELD.
 *
 * MEASURED 2026-08-17, and the most expensive mistake of the day: the argument-recording chain
 * was declared closed across four layers (engine record → store write → store read → extractor
 * prompt) while being inert end-to-end, because a FIFTH layer sat between the first two. This
 * sink builds its per-task payload key by key. `resolvedConfig` was recorded onto
 * ExecutionTaskRecord at five engine sites and then dropped one function later, before the
 * HTTP request was even built.
 *
 * Every individual layer was correct. Every test passed. Nothing worked.
 *
 * The lesson is narrower than "check the whole path": an EXPLICIT PROJECTION is a silent
 * dropper by construction. Adding a field to the record type produces no error, no warning and
 * no test failure here — the projection simply does not mention it, and TypeScript is happy
 * because omitting an optional field is legal.
 *
 * This test makes that omission loud. A field added to ExecutionTaskRecord must either be
 * forwarded by the sink or explicitly exempted with a reason.
 */

import { describe, it, expect } from "bun:test";

const ONTOLOGY = new URL("../ontology.ts", import.meta.url);
const SINK = new URL("./activity-api-trace-sink.ts", import.meta.url);

/** Declared fields of ExecutionTaskRecord. */
async function recordFields(): Promise<string[]> {
  const src = await Bun.file(ONTOLOGY).text();
  const start = src.indexOf("export interface ExecutionTaskRecord");
  expect(start).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open, i);
  return [...new Set([...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!))];
}

/** Fields deliberately NOT forwarded, each with the reason it stays local. */
const NOT_FORWARDED: Record<string, string> = {
  // Recorded at four engine sites for in-process composition tracking. activity-api has no
  // reader for `child_execution_id` anywhere, so forwarding it would add an unread key to
  // every task row — the same dead-weight class as `consumed_from_task_ids`, which is already
  // written by this sink and read by nothing. Do not "fix" this by sending it; fix it by
  // wiring a reader first, then removing this exemption.
  childExecutionId: "no reader exists in activity-api; sending it would add dead weight",
};

describe("trace sink — every recorded task field is forwarded or exempted", () => {
  it("reads the record's fields (guards the parser)", async () => {
    const fields = await recordFields();
    // A broken parse makes the assertion below vacuously green, which is precisely how the
    // fifth layer survived four rounds of checking.
    expect(fields.length).toBeGreaterThanOrEqual(15);
    expect(fields).toContain("taskId");
    expect(fields).toContain("resolvedConfig");
  });

  it("THE REGRESSION: resolvedConfig reaches the wire", async () => {
    const sink = await Bun.file(SINK).text();
    // The specific field whose loss made four correct commits inert. Asserted by name rather
    // than left to the general check below, because this one has already been lost once.
    expect(sink).toContain("resolved_config");
    expect(sink).toMatch(/resolved_config:\s*\(t as \{ resolvedConfig/);
  });

  it("no recorded field is silently dropped by the projection", async () => {
    const [fields, sink] = [await recordFields(), await Bun.file(SINK).text()];
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const dropped = fields.filter(
      (f) => !(f in NOT_FORWARDED) && !sink.includes(f) && !sink.includes(snake(f)),
    );
    // Names the field, so the failure says what to forward rather than that something broke.
    expect(dropped).toEqual([]);
  });

  it("every exemption is still genuinely unforwarded — the list must not go stale", async () => {
    const sink = await Bun.file(SINK).text();
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const field of Object.keys(NOT_FORWARDED)) {
      // If someone starts forwarding it, the exemption is wrong and must be deleted. A stale
      // exemption is indistinguishable from a detector that stopped detecting.
      expect(sink.includes(field) || sink.includes(snake(field))).toBe(false);
    }
  });
});
