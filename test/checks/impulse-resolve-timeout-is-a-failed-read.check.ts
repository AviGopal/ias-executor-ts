// GAP CHECK (intended red until fixed; a .check.ts, so the gate's `bun test` glob does not run it).
// impulse-resolve aborts its fetch at IMPULSE_RESOLVE_TIMEOUT_MS (default 8000) and returns a degraded
// "network error" impulse with null content. The engine exempts an all-degraded impulse-resolve output from its
// convergent-validity check as information-absence (engine.ts, "A degraded READ from the impulse-resolve lookup
// resolver"), so a request the producer WAS serving, cut off by the caller's own deadline, is recorded as a
// SUCCESSFUL task with null content: the next task binds "" and the walk stubs the shape, with no log anywhere.
// This check runs a real executor against a local producer that answers after the deadline.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ActivityExecutor, ExecutionRuntime, type ActivityTemplate, type Resolver } from "../../src";
import { makeImpulseResolveResolver } from "../../src/resolvers/impulse-resolve";
import { SequentialRandom, SteppingClock } from "../fakes";

const ROWS = "ROWS-PROBE-5d2a";
let server: ReturnType<typeof Bun.serve>;
const prevTimeout = process.env.IMPULSE_RESOLVE_TIMEOUT_MS;

beforeAll(() => {
  // One producer, answering by pointer type: slowShape is served but only after the caller's deadline;
  // absentShape is not served (404, a true absence); okShape answers at once.
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json().catch(() => ({}))) as { pointer?: { type?: string } };
      const type = body.pointer?.type;
      if (type === "slowShape") {
        await Bun.sleep(600);
        return Response.json({ success: true, content: ROWS, metadata: { shape: "slowShape" } });
      }
      if (type === "absentShape") return new Response("not served", { status: 404 });
      return Response.json({ success: true, content: ROWS, metadata: { shape: String(type) } });
    },
  });
  process.env.IMPULSE_RESOLVE_TIMEOUT_MS = "100";
});
afterAll(() => {
  server.stop(true);
  if (prevTimeout === undefined) delete process.env.IMPULSE_RESOLVE_TIMEOUT_MS;
  else process.env.IMPULSE_RESOLVE_TIMEOUT_MS = prevTimeout;
});

const seen: Record<string, unknown> = {};
const echo: Resolver = {
  id: "echo_config", tier: "deterministic",
  async resolve(ctx) {
    const key = String((ctx.task.config as { key?: unknown } | undefined)?.key ?? "");
    const v = (ctx.variables as Record<string, unknown>)[key];
    seen[ctx.task.id] = v;
    return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "echoed" }, loaded: true, content: v ?? null }];
  },
};

async function run(shape: string): Promise<{ t1Success: boolean | undefined; t2Saw: unknown }> {
  const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
  runtime.resolvers.register(makeImpulseResolveResolver({ activityApiEndpoint: `http://127.0.0.1:${server.port}`, activityApiKey: "check-key" }));
  runtime.resolvers.register(echo);
  delete seen["t2"];
  const template = {
    id: "resolve-then-read", name: "Resolve then read",
    tasks: [
      { id: "t1", description: "resolve", resolver: "impulse-resolve", outputShapes: [shape], config: { pointer: { type: shape } } },
      { id: "t2", description: "read t1", resolver: "echo_config", outputShapes: ["echoed"], config: { key: "t1" } },
    ],
  } as unknown as ActivityTemplate;
  const trace = await new ActivityExecutor(runtime).execute(template, {});
  const t1 = trace.tasks.find((t) => t.taskId === "t1");
  return { t1Success: t1?.success, t2Saw: seen["t2"] };
}

describe("impulse-resolve: a caller-side timeout is a failed read, not information-absence", () => {
  test("a resolve whose fetch the caller aborts at its timeout (the producer answers later) is a FAILED task, not success with null", async () => {
    const r = await run("slowShape");
    expect(r.t1Success).toBe(false);
  });
  test("CONTROL: a true absence (the producer answers 404) is still exempt: the task succeeds", async () => {
    const r = await run("absentShape");
    expect(r.t1Success).toBe(true);
  });
  test("CONTROL: a normal answer inside the deadline succeeds and the next task binds its content", async () => {
    const r = await run("okShape");
    expect(r.t1Success).toBe(true);
    expect(r.t2Saw).toBe(ROWS);
  });
});
