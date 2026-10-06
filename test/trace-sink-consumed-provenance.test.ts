/**
 * The sink forwards each task's consumed provenance, so activity-api can credit a producer by its
 * consumer's outcome (check-first; credit from use, user ruling 2026-10-05).
 *
 * The engine records `consumedProvenance` on every task it runs, failed tasks included (engine.ts,
 * consumedProvenanceOf). This sink projects an explicit key set and left it out, with the exemption
 * "read in-process by the executing host; no activity-api reader yet" (trace-sink-forwarding.test.ts).
 * activity-api now has the reader: normalizePersistedTask keeps `consumed_provenance` and chain credit
 * follows it (activity-api 78fe52c). So the field is forwarded here and the exemption is removed.
 *
 * WIRE CONTRACT (must match activity-api normalizePersistedTask):
 *   consumed_provenance: Array<{ impulse_id: string; producer_execution_id: string | null; origin: string }>
 *   - an EMPTY array is sent as [] — it declares that the task consumed nothing produced by an execution;
 *   - a task with no recorded provenance sends no key (data flow unknown ⇒ call-lineage credit).
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

type WireTask = Record<string, unknown>;

async function post(status: "completed" | "failed", taskExtra: Record<string, unknown>): Promise<WireTask> {
  const fetch = new CapturingFetch();
  const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch } as never);
  const trace: ExecutionTrace = {
    id: "exec_consumer_1",
    templateId: "tpl-consumer",
    status,
    compositionChain: ["exec_producer_P"],
    inputImpulseIds: ["imp-P-out"],
    outputImpulseIds: [],
    tasks: [{ taskId: "t1", resolverId: "llm", success: status === "completed", inputImpulseIds: ["imp-P-out"], outputImpulseIds: [], ...taskExtra } as never],
  } as ExecutionTrace;
  await sink.record(trace);
  expect(fetch.bodies.length).toBe(1);
  const tasks = (fetch.bodies[0]!.execution_trace as { tasks: WireTask[] }).tasks;
  return tasks[0]!;
}

const PROV = [
  { impulseId: "imp-P-out", producerExecutionId: "exec_producer_P", producerChain: ["exec_root"], origin: "ancestor" },
  { impulseId: "imp-seed", producerExecutionId: null, origin: "ambient" },
];
const WIRE = [
  { impulse_id: "imp-P-out", producer_execution_id: "exec_producer_P", origin: "ancestor" },
  { impulse_id: "imp-seed", producer_execution_id: null, origin: "ambient" },
];

describe("MUST-FAIL — consumed provenance reaches the wire", () => {
  test("a FAILED consumer task names the producer whose output it consumed", async () => {
    const t = await post("failed", { consumedProvenance: PROV });
    expect(t.consumed_provenance).toEqual(WIRE);
  });

  test("a completed task carries it the same way", async () => {
    const t = await post("completed", { consumedProvenance: PROV });
    expect(t.consumed_provenance).toEqual(WIRE);
  });

  test("a task that consumed nothing produced by an execution sends [] (declared), not nothing", async () => {
    const t = await post("failed", { consumedProvenance: [] });
    expect(t.consumed_provenance).toEqual([]);
  });
});

describe("CONTROL", () => {
  test("a task with no recorded provenance sends no consumed_provenance key", async () => {
    const t = await post("failed", {});
    expect("consumed_provenance" in t).toBe(false);
  });

  test("the rest of the task row is unchanged by forwarding provenance", async () => {
    const withProv = await post("failed", { consumedProvenance: PROV });
    const without = await post("failed", {});
    delete withProv.consumed_provenance;
    expect(withProv).toEqual(without);
  });
});
