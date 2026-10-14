// GAP CHECK (intended red until fixed; a .check.ts, so the gate's `bun test` glob does not run it).
// The engine binds a sibling task's output as BARE {{<taskId>}} = its first output's content (engine.ts, the
// "Bare key (no suffix)" block), beside {{<taskId>_text}} and {{<taskId>_<shape>}}. Since 2026-08-01 the bare key
// is assigned `(this as any).executionId`, which nothing sets, so the bound value is undefined and every {{t1}} in a
// later task's config stays literal. This check reads the execution's bound variables as the next task sees them.
import { describe, expect, test } from "bun:test";
import { ActivityExecutor, ExecutionRuntime, InMemoryTemplateProvider, type ActivityTemplate, type Resolver } from "../../src";
import { SequentialRandom, SteppingClock } from "../fakes";

const PROBE = "PROBE-T1-OUTPUT-7c1e";
const emit: Resolver = {
  id: "emit_probe", tier: "deterministic",
  async resolve(ctx) { return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "probe_out" }, loaded: true, content: PROBE }]; },
};
const seen: Record<string, unknown> = {};
const echo: Resolver = {
  id: "echo_config", tier: "deterministic",
  async resolve(ctx) {
    // the value the engine bound for the key the config names (the resolver sees the execution's variables)
    const key = String((ctx.task.config as { key?: unknown } | undefined)?.key ?? "");
    const v = (ctx.variables as Record<string, unknown>)[key];
    seen[ctx.task.id] = v;
    return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "echoed" }, loaded: true, content: v ?? null }];
  },
};
const template = (ref: string): ActivityTemplate => ({
  id: "bare-binding", name: "Bare binding",
  tasks: [
    { id: "t1", description: "emit", resolver: "emit_probe", outputShapes: ["probe_out"] },
    { id: "t2", description: "read t1", resolver: "echo_config", outputShapes: ["echoed"], config: { key: ref } },
  ],
} as unknown as ActivityTemplate);
async function run(ref: string, nested = false): Promise<unknown> {
  const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
  runtime.resolvers.register(emit); runtime.resolvers.register(echo);
  // NESTED: t1 names an ACTIVITY template, not a resolver (the activities-as-resolvers path), whose own task emits the output
  if (nested) {
    const provider = new InMemoryTemplateProvider();
    provider.register({ id: "probe_activity", name: "Probe activity", tasks: [{ id: "inner", description: "emit", resolver: "emit_probe", outputShapes: ["probe_out"] }], outputShapes: ["probe_out"] } as unknown as ActivityTemplate);
    runtime.registerTemplateProvider(provider);
  }
  delete seen["t2"];
  const t = template(ref);
  if (nested) (t.tasks[0] as unknown as Record<string, unknown>)["resolver"] = "probe_activity";
  await new ActivityExecutor(runtime).execute(t, {});
  return seen["t2"];
}

describe("engine bare task-id binding", () => {
  test("the next task sees bare key t1 bound to t1's first output content", async () => {
    expect(await run("t1")).toBe(PROBE);
  });
  test("CONTROL: key t1_text is bound to t1's first output content", async () => {
    expect(await run("t1_text")).toBe(PROBE);
  });
  test("CONTROL: the shape-suffixed key t1_probe_out is bound to t1's output", async () => {
    expect(String(await run("t1_probe_out"))).toContain(PROBE);
  });
  test("CONTROL: when t1 is a nested ACTIVITY (activities-as-resolvers), the bare key t1 is bound to its first output", async () => {
    expect(await run("t1", true)).toBe(PROBE);
  });
});
