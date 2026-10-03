/**
 * THE STATE SIGNATURE runGoal SENDS TO /recommend MUST DESCRIBE THIS EXECUTION, NOT THE HOST.
 *
 * GoalHost runs every execution on one ExecutionRuntime over one shared ImpulseStore.
 * runGoal (src/hosts/goal-host.ts, the `poolEntries` build before activityApi.recommend)
 * computes `impulseStateSpace` from `this.runtime.store.all()` — every impulse any
 * execution has put in the shared store — plus the goal and the run's seedImpulses. So the
 * signature a goal is selected under, and the context_thompson_scores cell its outcome is
 * graded into, depends on whatever unrelated runs happen to be in flight at that instant.
 * Two identical dispatches get different signatures; one run's intermediates condition
 * another run's selection.
 *
 * What must hold: an unrelated concurrent execution's impulses do not change this
 * execution's signature (RED today). The positive control: a shape that IS this
 * execution's own — a seed impulse — does change it (green today, and must stay green: the
 * fix is scoping, not dropping state).
 *
 * The concurrent execution is real, not a store poke: a template run through the same host
 * whose first task has produced its output while its second task is still running. That
 * keeps the test meaningful once execution ownership is tracked (impulse provenance), since
 * the in-flight run owns its impulses through the normal engine path.
 */
import { describe, expect, test } from "bun:test";
import type { ActivityTemplate, ExecutionTrace, Impulse } from "../src/ontology";
import type { LLMPort } from "../src/ports";
import { GoalHost } from "../src/hosts/goal-host";
import {
  ActivityApiAdapter,
  type ImpulseStateEntry,
  type RecommendRequest,
  type RecommendResponse,
} from "../src/adapters/activity-api-adapter";
import { TraceSinkSpy } from "./fakes";

class FakeLLM implements LLMPort {
  async generate(): Promise<string> {
    return "fake";
  }
}

/** Records the impulse_state_space of every /recommend call; recommends nothing, so runGoal
 *  stops right after computing the signature (it throws "no template id returned"). */
class SignatureCapturingApi extends ActivityApiAdapter {
  readonly signatures: ImpulseStateEntry[][] = [];
  constructor() {
    super("http://fake-activity-api.test", "fake-api-key", {
      fetch: { request: async () => new Response("", { status: 500 }) },
    });
  }
  override async recommend(req: RecommendRequest): Promise<RecommendResponse> {
    this.signatures.push([...(req.impulseStateSpace ?? [])]);
    return { recommendations: [] };
  }
  override async getTemplate(): Promise<ActivityTemplate | null> {
    return null;
  }
  override async recordTrace(_t: ExecutionTrace): Promise<void> {}
}

/** An unrelated execution: task 1 emits an `unrelatedArtifact` impulse, task 2 keeps the
 *  run in flight long enough for the goal under test to be dispatched beside it. */
const UNRELATED_IN_FLIGHT: ActivityTemplate = {
  id: "unrelated-in-flight",
  name: "Unrelated in-flight execution",
  description: "Produces an impulse of an unrelated shape, then stays running.",
  outputShapes: ["unrelatedArtifact", "commandResult"],
  tasks: [
    {
      id: "emit-unrelated",
      description: "emit an unrelated artifact",
      resolver: "bash",
      config: { command: ["echo", "unrelated"] },
      outputShapes: ["unrelatedArtifact"],
    },
    {
      id: "stay-in-flight",
      description: "keep the execution live",
      resolver: "bash",
      config: { command: ["sleep", "2"] },
      outputShapes: ["commandResult"],
    },
  ],
};

const GOAL = "summarise the open gaps for the activity-api vessel";

function makeHost() {
  const api = new SignatureCapturingApi();
  const host = new GoalHost({
    llm: new FakeLLM(),
    activityApiEndpoint: "http://fake-activity-api.test",
    apiKey: "fake-api-key",
    activityApi: api,
    traceSink: new TraceSinkSpy(),
    subscriberTemplates: [],
  });
  return { host, api };
}

/** Order-insensitive canonical form of a signature (a multiset of entries). */
function canon(sig: ImpulseStateEntry[]): string[] {
  return sig.map((e) => JSON.stringify({ shape: e.shape, task_id: e.task_id ?? null })).sort();
}

/** runGoal up to (and including) its /recommend call; returns the signature it sent. */
async function signatureOf(
  host: GoalHost,
  api: SignatureCapturingApi,
  opts: { seedImpulses?: Impulse[] } = {},
): Promise<ImpulseStateEntry[]> {
  const before = api.signatures.length;
  await expect(host.runGoal(GOAL, opts)).rejects.toThrow(/no template id returned/);
  expect(api.signatures.length).toBe(before + 1);
  return api.signatures[api.signatures.length - 1]!;
}

async function waitForShape(host: GoalHost, shape: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.runtime.store.all().some((imp) => imp.metadata.shape === shape)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for a '${shape}' impulse in the shared store`);
}

describe("GoalHost.runGoal state signature is scoped to its own execution", () => {
  test("an unrelated concurrent execution's impulses do not change the signature", async () => {
    const { host, api } = makeHost();

    const alone = await signatureOf(host, api);

    // Start an unrelated execution on the same host and wait until it has put an impulse of
    // another shape into the shared store while it is still running.
    let settled = false;
    const concurrent = host.runTemplate(UNRELATED_IN_FLIGHT).finally(() => {
      settled = true;
    });
    try {
      await waitForShape(host, "unrelatedArtifact");
      // Positive control on the address: the unrelated run is genuinely in flight and its
      // impulse genuinely sits in the store this goal is dispatched from.
      expect(settled).toBe(false);
      expect(host.runtime.store.all().some((i) => i.metadata.shape === "unrelatedArtifact")).toBe(true);

      const beside = await signatureOf(host, api);

      // THE DEFECT: the store-wide read pulls the other run's shape into this signature.
      expect(beside.map((e) => e.shape)).not.toContain("unrelatedArtifact");
      expect(canon(beside)).toEqual(canon(alone));
    } finally {
      await concurrent;
    }
  }, 15_000);

  test("control: a shape the execution itself is seeded with does change the signature", async () => {
    const { host, api } = makeHost();

    const alone = await signatureOf(host, api);
    const reachFeedback: Impulse = {
      id: "seed-reach-feedback-1",
      pointer: { type: "memo" },
      metadata: { shape: "reachFeedback" },
      loaded: true,
      content: { reached: false, reason: "hollow completion" },
    };
    const seeded = await signatureOf(host, api, { seedImpulses: [reachFeedback] });

    expect(alone.map((e) => e.shape)).toContain("goal");
    expect(seeded.map((e) => e.shape)).toContain("goal");
    expect(seeded.map((e) => e.shape)).toContain("reachFeedback");
    expect(canon(seeded)).not.toEqual(canon(alone));
  });
});
