/**
 * THE ADAPTER MUST CARRY correlation_id — a dropped join key is why 0 organic
 * executions ever linked to their Thompson draw (law 12).
 *
 * MEASURED 2026-08-24: `activity_execution_traces`/`execution` carried
 * correlation_id on 0 organic rows. /recommend mints a correlation_id per
 * candidate (activities.ts:7150) and writes it to thompson_selection_log, and
 * the trace-store lifts a `correlation:<id>` tag back onto the execution — but
 * this adapter's response mapping never read `r.correlation_id`, so
 * host.runGoal's internal recommend had nothing to stamp. The selection→outcome
 * join was severed HERE, at the mapping, before the host could ever see the id.
 *
 * This test makes the omission loud: a recommend response carrying correlation_id
 * must surface it on the RecommendCandidate; one without it must yield undefined.
 */

import { describe, it, expect } from "bun:test";
import { ActivityApiAdapter } from "./activity-api-adapter";
import type { FetchPort } from "../ports";

function fetchReturning(json: unknown): FetchPort {
  return {
    request: async () =>
      new Response(JSON.stringify(json), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  };
}

describe("ActivityApiAdapter.recommend correlation_id", () => {
  it("preserves correlation_id from the recommend response onto the candidate", async () => {
    const adapter = new ActivityApiAdapter("http://x", "k", {
      fetch: fetchReturning({
        recommendations: [
          { template_id: "t1", correlation_id: "sel_abc_0", selection_metadata: { score: 0.9 } },
          { template_id: "t2", correlation_id: "sel_abc_1" },
        ],
      }),
    });
    const res = await adapter.recommend({ goal: "do a thing" });
    expect(res.recommendations[0]!.correlation_id).toBe("sel_abc_0");
    expect(res.recommendations[1]!.correlation_id).toBe("sel_abc_1");
  });

  it("leaves correlation_id undefined when the response omits it", async () => {
    const adapter = new ActivityApiAdapter("http://x", "k", {
      fetch: fetchReturning({
        recommendations: [{ template_id: "t1", selection_metadata: {} }],
      }),
    });
    const res = await adapter.recommend({ goal: "do a thing" });
    expect(res.recommendations[0]!.correlation_id).toBeUndefined();
  });

  it("does not treat an empty-string correlation_id as a join key", async () => {
    const adapter = new ActivityApiAdapter("http://x", "k", {
      fetch: fetchReturning({
        recommendations: [{ template_id: "t1", correlation_id: "" }],
      }),
    });
    const res = await adapter.recommend({ goal: "do a thing" });
    expect(res.recommendations[0]!.correlation_id).toBeUndefined();
  });
});
