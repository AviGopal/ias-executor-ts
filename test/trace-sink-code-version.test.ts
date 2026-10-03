/**
 * Traces must carry the code version that produced them (check-first).
 *
 * Gap: traces-carry-no-code-version-so-a-regression-cannot-be-attributed-to-the-commit-that-caused-it
 * (WIRING step 2: code version per step).
 *
 * activity-api already accepts and persists a top-level `vessel_version` string on
 * POST /v2/activities/execution-traces (it projects it only when present). No engine
 * that writes through this sink ever sets it, so a posterior that drops after a landing
 * cannot be joined to the commit that landed: every trace looks like it came from the
 * same code.
 *
 * TranslatingTraceSink is the narrowest seam — the one wire translator every engine
 * host (goal-host, development-vessel, the ias-executor adapter) posts through.
 *
 * CONTRACT pinned here:
 *   - `TranslatingTraceSinkOptions.codeVersion?: string` — the running vessel's
 *     build-stamped identity (e.g. "<vessel>@<sha>"), handed to the constructor once.
 *     This is bootstrap identity (like a port or a key), frozen at build time by
 *     definition, so a constant is the right carrier; it is NOT read from an env var
 *     inside the sink (law 1: no env-gated behavior), and the sink never guesses it.
 *   - The sink passes it through VERBATIM as the top-level `vessel_version`.
 *   - With no version source (absent or empty), `vessel_version` is ABSENT — never a
 *     fabricated "unknown"/"" that would read as a real version and pool every
 *     unstamped trace into one fake build.
 *   - Stamping changes nothing else on the wire.
 *
 * Options are built in a variable (not passed as a literal) so this file typechecks
 * before `codeVersion` exists on the options type.
 */
import { describe, expect, test } from "bun:test";
import { TranslatingTraceSink } from "../src/adapters/activity-api-trace-sink";
import type { ExecutionTrace } from "../src/ontology";
import type { FetchPort } from "../src/ports";

class CapturingFetch implements FetchPort {
  bodies: Record<string, unknown>[] = [];
  async request(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }
}

function makeTrace(): ExecutionTrace {
  return {
    id: "exec_codever_1",
    templateId: "tpl-codever",
    templateName: "TplCodever",
    status: "completed",
    inputImpulseIds: ["in-1"],
    outputImpulseIds: ["out-1"],
    durationMs: 42,
    costUsd: 0.01,
    tags: ["operator:test"],
    tasks: [
      {
        taskId: "t1",
        resolverId: "bash",
        success: true,
        outputImpulseIds: ["out-1"],
        inputImpulseIds: ["in-1"],
        outputShapes: ["report"],
        durationMs: 40,
      } as never,
    ],
  };
}

// Distinctive, not the package.json version — a fix that hardcodes a constant
// inside the sink cannot satisfy this.
const STAMP = "goal-host-vessel@ed58e66";

async function postOnce(options: object): Promise<Record<string, unknown>> {
  const fetch = new CapturingFetch();
  const opts = { ...options, fetch };
  const sink = new TranslatingTraceSink("https://activity.test", "k", opts);
  await sink.record(makeTrace());
  expect(fetch.bodies.length).toBe(1);
  return fetch.bodies[0]!;
}

describe("TranslatingTraceSink code version", () => {
  test("CHECK: a trace posted through a sink given codeVersion carries it verbatim as vessel_version", async () => {
    const body = await postOnce({ codeVersion: STAMP });
    expect(body.vessel_version).toBe(STAMP);

    // Two sinks with different identities stamp their own — the value comes from
    // the injected source, not from anything process-wide.
    const other = await postOnce({ codeVersion: "development-vessel@0123abc" });
    expect(other.vessel_version).toBe("development-vessel@0123abc");
  });

  test("CONTROL: stamping a version changes no other field on the wire", async () => {
    const unstamped = await postOnce({});
    const stamped = await postOnce({ codeVersion: STAMP });
    delete stamped.vessel_version;
    expect(stamped).toEqual(unstamped);
    expect(unstamped.execution_id).toBe("exec_codever_1");
    expect(unstamped.template_id).toBe("tpl-codever");
  });

  test("MUST-FAIL: a sink with no version source sends no fabricated vessel_version", async () => {
    const none = await postOnce({});
    expect("vessel_version" in none).toBe(false);

    const empty = await postOnce({ codeVersion: "" });
    expect("vessel_version" in empty).toBe(false);
  });
});
