// THE WRITE DOOR, an http_fetch POST to an impulse resolve endpoint (src/write-door.ts refusedResolvePostWrites).
// Found: a task `http_fetch` POSTing {impulse:{pointer:{type:"substrateGap_write",…}}} to a loopback /v2/impulses/resolve
// looks like a plain fetch to a door that reads resolver id, pointer type and outputs only, so a read goal's run wrote a
// gap. The drafter teaches exactly that form (concept_create_write and substrateGap_write POSTs). The body's type is
// judged like a native task's shape, on the BOUND config, and a body the door cannot read is refused.
// Namespace import, so on an engine without the check the assertions (not the module link) fail.
import { beforeEach, describe, expect, test } from "bun:test";
import * as ias from "../src";
import type { ActivityTask, ActivityTemplate, ExecuteOptions, Resolver } from "../src";
import { makeIterationResolver } from "../src/resolvers/iteration";
import { EventSinkSpy, SequentialRandom, SteppingClock, TraceSinkSpy } from "./fakes";

const GOVERNS = (s: string) => /_write$/.test(s);
const NOT_ADMITTED = { writeDoor: { admitted: false, governs: GOVERNS } } as unknown as ExecuteOptions;
// A goal whose own product is substrateGap_write: the host's governs passes its declared write.
const DECLARED = { writeDoor: { admitted: false, governs: (s: string) => GOVERNS(s) && s !== "substrateGap_write" } } as unknown as ExecuteOptions;
const OPAQUE = "opaque_resolve_write";
const RESOLVE = "http://127.0.0.1:8270/v2/impulses/resolve";
const GAP_BODY = JSON.stringify({ impulse: { pointer: { type: "substrateGap_write", gap: { id: "g1", summary: "s", status: "open" } } } });

function setup() {
  const sent: Array<Record<string, unknown>> = [];
  const events = new EventSinkSpy();
  const runtime = new ias.ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock(), eventSink: events, traceSink: new TraceSinkSpy() });
  for (const id of ["http_fetch", "http_fetch/vessel"]) {
    const r: Resolver = {
      id,
      tier: "pattern",
      async resolve(ctx) {
        sent.push(ctx.task.config as Record<string, unknown>);
        return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "httpResponse" }, loaded: true, content: "ok" }];
      },
    };
    runtime.resolvers.register(r);
  }
  runtime.resolvers.register(makeIterationResolver((id) => runtime.resolvers.get(id)));
  return { sent, events, runtime, executor: new ias.ActivityExecutor(runtime) };
}

const fetchTask = (config: Record<string, unknown>, resolver = "http_fetch"): ActivityTask =>
  ({ id: "f1", description: "fetch", resolver, config, outputShapes: ["httpResponse"] }) as ActivityTask;
const one = (task: ActivityTask, more: ActivityTask[] = []): ActivityTemplate => ({ id: "fetch-tpl", name: "fetch", tasks: [task, ...more] });
const post = (body: unknown, url = RESOLVE) => ({ type: "http_fetch", method: "POST", url, headers: { "Content-Type": "application/json" }, body });
const refusedOf = (events: EventSinkSpy) => events.ofType("task.skipped").map((e) => (e.data as { refusedShapes?: string[] }).refusedShapes);

describe("write door, http_fetch POST to a resolve endpoint", () => {
  beforeEach(() => ias.resetWriteDoorTaskCounters());

  test("must-fail: a POST whose body is a substrateGap_write impulse is refused at the task door on a read goal", async () => {
    const { sent, events, executor } = setup();
    const trace = await executor.execute(one(fetchTask(post(GAP_BODY))), NOT_ADMITTED);
    expect(sent).toEqual([]);
    expect(trace.tasks[0]!.skipped).toBe(true);
    expect(trace.tasks[0]!.skipReason).toBe(ias.WRITE_DOOR_SKIP_REASON);
    expect(refusedOf(events)).toEqual([["substrateGap_write"]]);
    expect(ias.writeDoorTaskCounters().by_shape["substrateGap_write"]).toBe(1);
  });

  test("must-fail: every body type field counts (impulse.type, pointer.type, type), string or object body, lowercase verb", async () => {
    for (const body of [{ impulse: { type: "substrateGap_write" } }, JSON.stringify({ pointer: { type: "concept_create_write" } }), { type: "uiView_write" }]) {
      const { sent, executor } = setup();
      const trace = await executor.execute(one(fetchTask({ ...post(body), method: "post" })), NOT_ADMITTED);
      expect(sent).toEqual([]);
      expect(trace.tasks[0]!.skipReason).toBe(ias.WRITE_DOOR_SKIP_REASON);
    }
  });

  test("must-fail: a write type bound from a {{…}} variable is judged after binding and refused", async () => {
    const { sent, events, executor } = setup();
    const body = '{"impulse":{"pointer":{"type":"{{gapShape}}","gap":{"id":"g1"}}}}';
    await executor.execute(one(fetchTask(post(body))), { ...NOT_ADMITTED, variables: { gapShape: "substrateGap_write" } } as ExecuteOptions);
    expect(sent).toEqual([]);
    expect(refusedOf(events)).toEqual([["substrateGap_write"]]);
  });

  test("must-fail: an opaque body (unparseable, no type, missing, or a {{…}} left unbound) is refused, fail closed", async () => {
    for (const config of [post("not json"), post('{"gap":{"id":"g1"}}'), { type: "http_fetch", method: "POST", url: RESOLVE }, post('{"impulse":{"type":"{{nowhere}}"}}')]) {
      const { sent, events, executor } = setup();
      await executor.execute(one(fetchTask(config)), NOT_ADMITTED);
      expect(sent).toEqual([]);
      expect(refusedOf(events)).toEqual([[OPAQUE]]);
    }
  });

  test("must-fail: a request carried in config.pointer, by a `http_fetch/<kind>` resolver, is judged the same", async () => {
    const { sent, executor } = setup();
    const trace = await executor.execute(one(fetchTask({ pointer: post(GAP_BODY) }, "http_fetch/vessel")), NOT_ADMITTED);
    expect(sent).toEqual([]);
    expect(trace.tasks[0]!.skipReason).toBe(ias.WRITE_DOOR_SKIP_REASON);
  });

  test("must-fail: a task depending on a refused POST is dependency-skipped", async () => {
    const { sent, executor } = setup();
    const after = { id: "f2", description: "after", resolver: "http_fetch", config: { type: "http_fetch", url: "http://127.0.0.1:8080/health" }, dependencies: ["f1"] } as unknown as ActivityTask;
    const trace = await executor.execute(one(fetchTask(post(GAP_BODY)), [after]), NOT_ADMITTED);
    expect(sent).toEqual([]);
    expect(trace.tasks.map((t) => t.skipped)).toEqual([true, true]);
  });

  test("must-fail: an iteration body that POSTs a write is refused per element", async () => {
    const { sent, runtime, executor } = setup();
    const tpl: ActivityTemplate = {
      id: "iterate-posts",
      name: "iterate",
      tasks: [{
        id: "i1", description: "post each", resolver: "iteration",
        config: { over: '["a","b"]', elementVar: "x", body: { resolver: "http_fetch", config: post('{"impulse":{"type":"substrateGap_write","gap":{"id":"{{x}}"}}}') } },
        outputShapes: ["iteration_result"],
      } as unknown as ActivityTask],
    };
    await executor.execute(tpl, NOT_ADMITTED);
    expect(sent).toEqual([]);
    const out = runtime.store.all().find((i) => i.metadata.shape === "iteration_result")?.content as Array<Record<string, unknown>>;
    expect(out.map((r) => r.refusedShapes)).toEqual([["substrateGap_write"], ["substrateGap_write"]]);
  });

  test("control: a GET (explicit or the default) to the resolve URL runs on a read goal", async () => {
    const { sent, executor } = setup();
    await executor.execute(one(fetchTask({ type: "http_fetch", method: "GET", url: RESOLVE })), NOT_ADMITTED);
    await executor.execute(one(fetchTask({ type: "http_fetch", url: `${RESOLVE}?x=1` })), NOT_ADMITTED);
    expect(sent.length).toBe(2);
  });

  test("control: a POST to a non-resolve URL runs, even with a *_write body", async () => {
    const { sent, executor } = setup();
    await executor.execute(one(fetchTask(post(GAP_BODY, "http://127.0.0.1:8080/v2/activities/discover-by-shapes"))), NOT_ADMITTED);
    expect(sent.length).toBe(1);
  });

  test("control: a resolve POST of a read type runs, including a read type bound from a {{…}} variable", async () => {
    const { sent, executor } = setup();
    await executor.execute(one(fetchTask(post('{"impulse":{"pointer":{"type":"executionTraceWithSignatures"}}}'))), NOT_ADMITTED);
    await executor.execute(one(fetchTask(post('{"impulse":{"pointer":{"type":"{{s}}"}}}'))), { ...NOT_ADMITTED, variables: { s: "executionTraceWithSignatures" } } as ExecuteOptions);
    expect(sent.map((c) => c.body)).toEqual(['{"impulse":{"pointer":{"type":"executionTraceWithSignatures"}}}', '{"impulse":{"pointer":{"type":"executionTraceWithSignatures"}}}']);
  });

  test("control: a declared write (in the goal's product), an admitted dispatch and no door all send the write POST", async () => {
    const { sent, executor } = setup();
    await executor.execute(one(fetchTask(post(GAP_BODY))), DECLARED);
    await executor.execute(one(fetchTask(post(GAP_BODY))), { writeDoor: { admitted: true, governs: GOVERNS } } as unknown as ExecuteOptions);
    await executor.execute(one(fetchTask(post(GAP_BODY))), {});
    await executor.execute(one(fetchTask(post("not json"))), {});
    expect(sent.length).toBe(4);
  });
});
