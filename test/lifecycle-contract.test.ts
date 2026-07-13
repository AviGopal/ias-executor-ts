/**
 * Lifecycle-subscriber template contract tests
 * (gap ias-executor-template-contract-mismatch).
 *
 * The embedded meta-templates (slot-binding, validator-dispatch,
 * create-shape-provider-goal escalation) were authored for minibob's
 * executor contract:
 *   (a) {{lifecycle.<dotted.path>}} placeholders in task config resolve
 *       from the triggering lifecycle impulse's data payload, and
 *   (b) conditional / skipIfFalse task gates are evaluated BEFORE dispatch.
 *
 * These tests pin the engine-side implementation:
 *   - whole-string placeholders substitute with type preserved (arrays stay
 *     arrays), inline placeholders substitute the stringified form
 *   - unresolvable placeholder ⇒ structured UNRESOLVABLE_PLACEHOLDER failure
 *     (the literal string must NEVER reach a resolver — that literal
 *     passthrough was the validator-dispatch HTTP-400-storm bug)
 *   - a false gate skips the task (recorded skipped, not success/failure)
 *   - dependents of a skipped task are skipped too
 *   - unresolvable gate ⇒ structured UNRESOLVABLE_GATE failure, never a
 *     silent unconditional run (the 60-bogus-escalations/hr bug)
 *
 * WIRING is the point: these run through ActivityExecutor.execute with the
 * lifecycle payload seeded exactly the way the GoalHost subscriber
 * dispatcher seeds it (metadata.source === "lifecycle-event").
 */
import { describe, expect, test } from "bun:test";
import {
  ActivityExecutor,
  ExecutionRuntime,
  type ActivityTemplate,
  type Impulse,
  type Resolver,
} from "../src";
import {
  evaluateConditionalGate,
  resolveLifecyclePlaceholders,
} from "../src/engine";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";

function lifecycleImpulse(type: string, data: Record<string, unknown>): Impulse {
  // Mirrors hosts/goal-host.ts subscriber dispatcher's seeding.
  return {
    id: `lifecycle:${type}:0001`,
    pointer: { type: "memo" },
    metadata: { shape: type, source: "lifecycle-event" },
    loaded: true,
    content: data,
  };
}

/** Resolver spy capturing the config the engine hands it. */
function makeConfigSpy(): { resolver: Resolver; seen: Array<Record<string, unknown> | undefined> } {
  const seen: Array<Record<string, unknown> | undefined> = [];
  const resolver: Resolver = {
    id: "config-spy",
    tier: "deterministic",
    async resolve(ctx) {
      seen.push(ctx.task.config);
      return [
        {
          id: ctx.random.id("out"),
          pointer: { type: "memo" },
          metadata: { shape: "spy_result" },
          loaded: true,
          content: JSON.stringify({ ok: true }),
        },
      ];
    },
  };
  return { resolver, seen };
}

function makeRuntime(resolvers: Resolver[], eventSink?: EventSinkSpy) {
  const runtime = new ExecutionRuntime({
    random: new SequentialRandom(),
    clock: new SteppingClock(),
    ...(eventSink ? { eventSink } : {}),
  });
  for (const r of resolvers) runtime.resolvers.register(r);
  return runtime;
}

// ---------------------------------------------------------------------------
// resolveLifecyclePlaceholders (unit)
// ---------------------------------------------------------------------------

describe("resolveLifecyclePlaceholders", () => {
  const data = {
    taskId: "parent_task",
    executionId: "exec_9",
    outputShapes: ["commandResult", "fileContent"],
    missingShapes: ["goal"],
    parentDepth: 1,
    skip_validation: false,
    nested: { deep: "value" },
  };

  test("whole-string placeholder preserves the resolved value's type", () => {
    const out = resolveLifecyclePlaceholders(
      { shapes: "{{lifecycle.outputShapes}}", depth: "{{lifecycle.parentDepth}}" },
      data,
      "t1",
    );
    expect(out.shapes).toEqual(["commandResult", "fileContent"]); // array stays array
    expect(out.depth).toBe(1); // number stays number
  });

  test("resolves nested config objects and arrays (iteration body case)", () => {
    const out = resolveLifecyclePlaceholders(
      {
        over: "{{lifecycle.missingShapes}}",
        body: { config: { taskId: "{{lifecycle.taskId}}", el: "{{shape}}" } },
        list: ["{{lifecycle.executionId}}"],
      },
      data,
      "t1",
    ) as { over: unknown; body: { config: { taskId: string; el: string } }; list: unknown[] };
    expect(out.over).toEqual(["goal"]);
    expect(out.body.config.taskId).toBe("parent_task");
    // Non-lifecycle placeholder families are left for downstream resolvers.
    expect(out.body.config.el).toBe("{{shape}}");
    expect(out.list[0]).toBe("exec_9");
  });

  test("inline placeholders substitute the stringified form", () => {
    const out = resolveLifecyclePlaceholders(
      { body: '{"execution_id":"{{lifecycle.executionId}}","shapes":{{lifecycle.outputShapes}}}' },
      data,
      "t1",
    );
    expect(out.body).toBe('{"execution_id":"exec_9","shapes":["commandResult","fileContent"]}');
  });

  test("snake_case placeholder falls back to camelCase payload key", () => {
    const out = resolveLifecyclePlaceholders(
      { chain: "{{lifecycle.composition_chain}}" },
      { compositionChain: ["exec_1"] },
      "t1",
    );
    expect(out.chain).toEqual(["exec_1"]);
  });

  test("dotted paths descend into nested payload objects", () => {
    const out = resolveLifecyclePlaceholders({ v: "{{lifecycle.nested.deep}}" }, data, "t1");
    expect(out.v).toBe("value");
  });

  test("underscore-prefixed keys (author notes) are not interpolated", () => {
    const out = resolveLifecyclePlaceholders(
      { _variables_note: "mentions {{lifecycle.notARealField}} in prose", real: "{{lifecycle.taskId}}" },
      data,
      "t1",
    );
    expect(out._variables_note).toBe("mentions {{lifecycle.notARealField}} in prose");
    expect(out.real).toBe("parent_task");
  });

  test("unresolvable placeholder throws structured UNRESOLVABLE_PLACEHOLDER naming task + placeholder", () => {
    let caught: unknown;
    try {
      resolveLifecyclePlaceholders({ x: "{{lifecycle.doesNotExist}}" }, data, "my_task");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const e = caught as Error & { code?: string; taskId?: string; placeholder?: string };
    expect(e.code).toBe("UNRESOLVABLE_PLACEHOLDER");
    expect(e.taskId).toBe("my_task");
    expect(e.placeholder).toBe("{{lifecycle.doesNotExist}}");
    expect(e.message).toContain("my_task");
    expect(e.message).toContain("{{lifecycle.doesNotExist}}");
  });
});

// ---------------------------------------------------------------------------
// evaluateConditionalGate (unit) — the actual meta-template gate expressions
// ---------------------------------------------------------------------------

describe("evaluateConditionalGate", () => {
  const noSlots = () => undefined;

  test("validator-dispatch discover_validators gate: runs when shapes produced, skips when skip_validation", () => {
    const expr = `{{lifecycle.skip_validation}} !== 'true' AND '{{lifecycle.outputShapes}}' contains '"'`;
    const gate = { expression: expr, skipIfFalse: true };
    const run = evaluateConditionalGate(gate, {
      taskId: "discover_validators",
      lifecycleData: { skip_validation: false, outputShapes: ["commandResult"] },
      variables: {},
      resolveImpulseSlot: noSlots,
    });
    expect(run).toBe(true);
    const skipFlagged = evaluateConditionalGate(gate, {
      taskId: "discover_validators",
      lifecycleData: { skip_validation: true, outputShapes: ["commandResult"] },
      variables: {},
      resolveImpulseSlot: noSlots,
    });
    expect(skipFlagged).toBe(false);
    const emptyOutputs = evaluateConditionalGate(gate, {
      taskId: "discover_validators",
      lifecycleData: { skip_validation: false, outputShapes: [] },
      variables: {},
      resolveImpulseSlot: noSlots,
    });
    expect(emptyOutputs).toBe(false); // '[]' contains no double quote
  });

  test("slot-binding escalate_unbindable gate: {{impulse:...}} contains / not-contains", () => {
    const expr = `{{impulse:select_or_produce_result}} contains 'unbindable": true' AND {{impulse:select_or_produce_result}} not-contains '"score": null'`;
    const slots: Record<string, string> = {
      select_or_produce_result: '{"results":[{"unbindable": true,"score": 0.4}]}',
    };
    const resolveImpulseSlot = (slot: string) => slots[slot];
    expect(
      evaluateConditionalGate({ expression: expr, skipIfFalse: true }, {
        taskId: "escalate_unbindable",
        lifecycleData: {},
        variables: {},
        resolveImpulseSlot,
      }),
    ).toBe(true);
    slots.select_or_produce_result = '{"results":[{"unbindable": false,"score": 0.9}]}';
    expect(
      evaluateConditionalGate({ expression: expr, skipIfFalse: true }, {
        taskId: "escalate_unbindable",
        lifecycleData: {},
        variables: {},
        resolveImpulseSlot,
      }),
    ).toBe(false);
  });

  test("{{variables.*}} operands resolve against accumulated variables", () => {
    expect(
      evaluateConditionalGate({ expression: "{{variables.dryRun}} == 'false'" }, {
        taskId: "t",
        lifecycleData: {},
        variables: { dryRun: "false" },
        resolveImpulseSlot: noSlots,
      }),
    ).toBe(true);
  });

  test("boolean gates pass through", () => {
    const ctx = { taskId: "t", lifecycleData: {}, variables: {}, resolveImpulseSlot: noSlots };
    expect(evaluateConditionalGate(true, ctx)).toBe(true);
    expect(evaluateConditionalGate(false, ctx)).toBe(false);
    expect(evaluateConditionalGate({ expression: false }, ctx)).toBe(false);
  });

  test("unresolvable gate throws structured UNRESOLVABLE_GATE (never a silent run)", () => {
    let caught: unknown;
    try {
      evaluateConditionalGate(
        { expression: "{{lifecycle.notThere}} === 'true'", skipIfFalse: true },
        { taskId: "gated", lifecycleData: {}, variables: {}, resolveImpulseSlot: noSlots },
      );
    } catch (err) {
      caught = err;
    }
    const e = caught as (Error & { code?: string; taskId?: string }) | undefined;
    expect(e).toBeInstanceOf(Error);
    expect(e?.code).toBe("UNRESOLVABLE_GATE");
    expect(e?.taskId).toBe("gated");
  });
});

// ---------------------------------------------------------------------------
// Engine wiring (integration through ActivityExecutor.execute)
// ---------------------------------------------------------------------------

describe("ActivityExecutor — lifecycle-subscriber contract wiring", () => {
  test("resolver receives INTERPOLATED config (typed), never the literal placeholder", async () => {
    const { resolver, seen } = makeConfigSpy();
    const runtime = makeRuntime([resolver]);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "subscriber-tmpl",
      name: "Subscriber",
      tasks: [
        {
          id: "discover",
          description: "spy",
          resolver: "config-spy",
          config: {
            pointer: {
              type: "discoverByShapesQuery",
              required_shapes: "{{lifecycle.outputShapes}}",
              mode: "backward",
            },
            executionId: "{{lifecycle.executionId}}",
          },
        },
      ],
    };

    const trace = await executor.execute(template, {
      impulses: [
        lifecycleImpulse("lifecycle:task:completed", {
          executionId: "exec_parent",
          outputShapes: ["commandResult"],
        }),
      ],
    });
    expect(trace.status).toBe("completed");
    const cfg = seen[0] as { pointer: { required_shapes: unknown }; executionId: string };
    expect(cfg.pointer.required_shapes).toEqual(["commandResult"]); // array stayed an array
    expect(cfg.executionId).toBe("exec_parent");
    expect(JSON.stringify(cfg)).not.toContain("{{lifecycle.");
  });

  test("unresolvable config placeholder fails the task loudly with UNRESOLVABLE_PLACEHOLDER", async () => {
    const { resolver, seen } = makeConfigSpy();
    const runtime = makeRuntime([resolver]);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "bad-subscriber",
      name: "Bad Subscriber",
      tasks: [
        {
          id: "broken",
          description: "references a payload field that does not exist",
          resolver: "config-spy",
          config: { shapes: "{{lifecycle.producedShapes}}" },
        },
      ],
    };

    const trace = await executor.execute(template, {
      impulses: [lifecycleImpulse("lifecycle:task:completed", { outputShapes: ["x"] })],
    });
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("UNRESOLVABLE_PLACEHOLDER");
    expect(trace.failureMode?.reason).toContain("{{lifecycle.producedShapes}}");
    expect(seen.length).toBe(0); // resolver never saw the literal
    const rec = trace.tasks.find((t) => t.taskId === "broken");
    expect(rec?.success).toBe(false);
  });

  test("false gate skips the task (recorded skipped) and dependency-skip propagates", async () => {
    const { resolver, seen } = makeConfigSpy();
    const eventSink = new EventSinkSpy();
    const runtime = makeRuntime([resolver], eventSink);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "gated-tmpl",
      name: "Gated",
      tasks: [
        {
          id: "gated_off",
          description: "skips: skip_validation is set",
          resolver: "config-spy",
          conditional: {
            expression: "{{lifecycle.skip_validation}} !== 'true'",
            skipIfFalse: true,
          },
        },
        {
          id: "dependent",
          description: "skips via dependency-skip propagation",
          resolver: "config-spy",
          dependencies: ["gated_off"],
          conditional: { expression: "{{impulse:never_filled}} contains 'x'", skipIfFalse: true },
        },
        {
          id: "independent",
          description: "runs: no gate, no skipped dependency",
          resolver: "config-spy",
        },
      ],
    };

    const trace = await executor.execute(template, {
      impulses: [
        lifecycleImpulse("lifecycle:task:completed", { skip_validation: true, outputShapes: [] }),
      ],
    });
    expect(trace.status).toBe("completed");
    expect(seen.length).toBe(1); // only `independent` dispatched a resolver
    const gated = trace.tasks.find((t) => t.taskId === "gated_off");
    const dependent = trace.tasks.find((t) => t.taskId === "dependent");
    const independent = trace.tasks.find((t) => t.taskId === "independent");
    expect(gated?.skipped).toBe(true);
    expect(dependent?.skipped).toBe(true); // gate referencing unfilled slot never evaluated
    expect(independent?.skipped).toBeUndefined();
    const skipEvents = eventSink.ofType("task.skipped");
    expect(skipEvents.length).toBe(2);
  });

  test("unresolvable gate fails the execution loudly instead of running the task", async () => {
    const { resolver, seen } = makeConfigSpy();
    const runtime = makeRuntime([resolver]);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "bad-gate",
      name: "Bad Gate",
      tasks: [
        {
          id: "escalate",
          description: "gate references a slot no task filled",
          resolver: "config-spy",
          conditional: { expression: "{{impulse:missing_slot}} contains 'unbindable'", skipIfFalse: true },
        },
      ],
    };

    const trace = await executor.execute(template, {
      impulses: [lifecycleImpulse("lifecycle:task:preBinding", { missingShapes: ["goal"] })],
    });
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("UNRESOLVABLE_GATE");
    expect(seen.length).toBe(0); // the gated task did NOT run unconditionally
  });

  test("gate reads {{impulse:<slot>}} filled by a PRIOR task's named output slot", async () => {
    const seen: string[] = [];
    const producer: Resolver = {
      id: "producer",
      tier: "deterministic",
      async resolve(ctx) {
        return [
          {
            id: ctx.random.id("out"),
            pointer: { type: "memo" },
            metadata: { shape: "select_or_produce_result" },
            loaded: true,
            content: '{"unbindable": true}',
          },
        ];
      },
    };
    const consumer: Resolver = {
      id: "consumer",
      tier: "deterministic",
      async resolve(ctx) {
        seen.push(ctx.task.id);
        return [];
      },
    };
    const runtime = makeRuntime([producer, consumer]);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "slot-gate",
      name: "Slot Gate",
      tasks: [
        {
          id: "select_or_produce",
          description: "produce the slot",
          resolver: "producer",
          outputImpulses: ["select_or_produce_result"],
        },
        {
          id: "escalate_unbindable",
          description: "fires only when unbindable",
          resolver: "consumer",
          dependencies: ["select_or_produce"],
          conditional: {
            expression: `{{impulse:select_or_produce_result}} contains 'unbindable": true'`,
            skipIfFalse: true,
          },
        },
      ],
    };

    const trace = await executor.execute(template, {
      impulses: [lifecycleImpulse("lifecycle:task:preBinding", { missingShapes: ["goal"] })],
    });
    expect(trace.status).toBe("completed");
    expect(seen).toEqual(["escalate_unbindable"]); // gate opened from the slot content
  });

  test("lifecycle payload emits carry the contract fields the meta-templates interpolate", async () => {
    const { resolver } = makeConfigSpy();
    const eventSink = new EventSinkSpy();
    const runtime = makeRuntime([resolver], eventSink);
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "emitting",
      name: "Emitting",
      tasks: [
        {
          id: "t1",
          description: "declares an input shape so preBinding fires",
          resolver: "config-spy",
          inputShapes: ["seed"],
          outputShapes: ["spy_result"],
        },
      ],
    };

    const seed: Impulse = {
      id: "seed_1",
      pointer: { type: "memo" },
      metadata: { shape: "seed" },
      loaded: true,
      content: "s",
    };
    await executor.execute(template, { impulses: [seed] });

    const preBinding = eventSink.ofType("lifecycle:task:preBinding")[0];
    expect(preBinding).toBeDefined();
    const pb = preBinding!.data as Record<string, unknown>;
    // slot-binding's escalate_unbindable / agent_fill_fallback interpolate this:
    expect(Array.isArray(pb.currentImpulseIds)).toBe(true);

    const completed = eventSink.ofType("lifecycle:task:completed")[0];
    expect(completed).toBeDefined();
    const c = completed!.data as Record<string, unknown>;
    // validator-dispatch's gate + learning_signal_write interpolate these:
    expect(c.skip_validation).toBe(false);
    expect(Array.isArray(c.allImpulseIds)).toBe(true);
    expect(Array.isArray(c.loadedImpulseIds)).toBe(true);
    expect(Array.isArray(c.toolCallRecords)).toBe(true);
  });
});
