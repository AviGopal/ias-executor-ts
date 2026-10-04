/**
 * THE SIGNATURE runGoal SENDS MUST STILL TRIGGER activity-api's v1 (context_thompson) PATH.
 * activity-api keys context_thompson_scores only when the /recommend body carries a
 * non-empty impulse_state_space (routes/activities.ts: hasStateSpace / sigShapes). Scoping
 * the signature to the execution (ed58e66) must not empty it: the goal shape and every seed
 * shape must reach the wire.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityTemplate, ExecutionTrace, Impulse } from "../src/ontology";
import type { LLMPort } from "../src/ports";
import { GoalHost } from "../src/hosts/goal-host";
import { ActivityApiAdapter } from "../src/adapters/activity-api-adapter";
import { TraceSinkSpy } from "./fakes";

class FakeLLM implements LLMPort {
  async generate(): Promise<string> { return "fake"; }
}

/** Real adapter, fake transport: captures the exact /recommend JSON body on the wire. */
function makeHost() {
  const bodies: Array<Record<string, unknown>> = [];
  const api = new (class extends ActivityApiAdapter {
    override async getTemplate(): Promise<ActivityTemplate | null> { return null; }
    override async recordTrace(_t: ExecutionTrace): Promise<void> {}
  })("http://fake-activity-api.test", "fake-api-key", {
    fetch: {
      request: async (input, init) => {
        if (String(input).endsWith("/v2/activities/recommend")) {
          bodies.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ recommendations: [] }), { status: 200 });
        }
        return new Response("", { status: 500 });
      },
    },
  });
  const host = new GoalHost({
    llm: new FakeLLM(),
    activityApiEndpoint: "http://fake-activity-api.test",
    apiKey: "fake-api-key",
    activityApi: api,
    traceSink: new TraceSinkSpy(),
    subscriberTemplates: [],
  });
  return { host, bodies };
}

describe("GoalHost.runGoal state signature still triggers context_thompson v1", () => {
  test("the /recommend body carries impulse_state_space with the goal and every seed shape", async () => {
    const { host, bodies } = makeHost();
    const seed: Impulse = {
      id: "seed-reach-feedback-1",
      pointer: { type: "memo" },
      metadata: { shape: "reachFeedback" },
      loaded: true,
      content: { reached: false },
    };
    await expect(host.runGoal("summarise the open gaps", { seedImpulses: [seed] })).rejects.toThrow(
      /no template id returned/,
    );
    expect(bodies.length).toBe(1);
    const iss = bodies[0]!.impulse_state_space as Array<{ shape: string }> | undefined;
    expect(Array.isArray(iss)).toBe(true);
    expect(iss!.length).toBeGreaterThan(0);
    const shapes = iss!.map((e) => e.shape);
    expect(shapes).toContain("goal");
    expect(shapes).toContain("reachFeedback");
  });
});
