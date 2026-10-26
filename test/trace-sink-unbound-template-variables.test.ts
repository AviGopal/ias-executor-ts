/**
 * The sink forwards each task's unbound template variables, so activity-api can keep them.
 *
 * The engine stamps `unboundTemplateVariables` on a task record when a plain `{{name}}` in the task's
 * config could not be bound before dispatch. This sink projects an explicit key set, so a field the
 * engine records is not sent unless the sink names it.
 *
 * WIRE CONTRACT (must match activity-api normalizePersistedTask):
 *   unbound_template_variables: string[]
 *   - sent only when the record carries a non-empty list;
 *   - absent or empty on the record ⇒ no key (every plain name bound).
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

async function post(taskExtra: Record<string, unknown>): Promise<WireTask[]> {
  const fetch = new CapturingFetch();
  const sink = new TranslatingTraceSink("https://activity.test", "k", { fetch } as never);
  const trace: ExecutionTrace = {
    id: "exec_unbound_1",
    templateId: "tpl-unbound",
    status: "completed",
    inputImpulseIds: [],
    outputImpulseIds: [],
    tasks: [
      { taskId: "t1", resolverId: "llm", success: true, inputImpulseIds: [], outputImpulseIds: [], ...taskExtra } as never,
      { taskId: "t2", resolverId: "llm", success: true, inputImpulseIds: [], outputImpulseIds: [] } as never,
    ],
  } as ExecutionTrace;
  await sink.record(trace);
  expect(fetch.bodies.length).toBe(1);
  return (fetch.bodies[0]!.execution_trace as { tasks: WireTask[] }).tasks;
}

describe("MUST-FAIL — unbound template variables reach the wire", () => {
  test("a task with unbound names carries them, in order", async () => {
    const tasks = await post({ unboundTemplateVariables: ["goal", "target_file"] });
    expect(tasks[0]!.unbound_template_variables).toEqual(["goal", "target_file"]);
  });
});

describe("CONTROL", () => {
  test("a task without the field sends no key", async () => {
    const tasks = await post({});
    expect(tasks.some((t) => "unbound_template_variables" in t)).toBe(false);
  });

  test("an empty list sends no key", async () => {
    const tasks = await post({ unboundTemplateVariables: [] });
    expect(tasks.some((t) => "unbound_template_variables" in t)).toBe(false);
  });

  test("only the task that has the field carries it", async () => {
    const tasks = await post({ unboundTemplateVariables: ["goal"] });
    expect("unbound_template_variables" in tasks[1]!).toBe(false);
  });
});
