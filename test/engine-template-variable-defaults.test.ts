import { describe, expect, test } from "bun:test";
import {
  ActivityExecutor,
  ExecutionRuntime,
  type ActivityTemplate,
  type Resolver,
} from "../src";
import { SequentialRandom, SteppingClock } from "./fakes";

// A template variable declared `required: false` with a `default` was never merged
// into the execution's variables, so an unsupplied variable was simply ABSENT. In a
// conditional gate that is fatal rather than defaulted — the interpolator throws
// UNRESOLVABLE_GATE (engine.interpolation.ts: `if (!res.found) throw unresolvable`)
// — so the execution FAILS at that task instead of taking the declared-default
// branch.
//
// Observed in production on `ribosome-extract`: it ran its entire quality chain and
// then died on its final task with
//   UNRESOLVABLE_GATE: task 'dispatch_write_attempt': conditional gate references
//   {{variables.applyExtraction}} which cannot be resolved
// (218 UNRESOLVABLE_GATE / 457 failed in 6h), discarding every extraction. Three
// templates fleet-wide use a defaulted variable inside a gate, all three in the
// activity-lifecycle machinery.
//
// NOTE for future edits: the gate field is `conditional`, NOT `condition`. A task
// carrying `condition` is silently ungated — an earlier draft of this test used the
// wrong key and passed while proving nothing.

const noopResolver: Resolver = {
  id: "noop",
  tier: "deterministic",
  async resolve(ctx) {
    return [{
      id: ctx.random.id("out"),
      pointer: { type: "memo" },
      metadata: { shape: "result" },
      loaded: true,
      content: null,
    }];
  },
};

const GATE = "{{variables.applyExtraction}} == 'true'";

function makeTemplate(declared: { default: unknown } | undefined): ActivityTemplate {
  const t: Record<string, unknown> = {
    id: "gated",
    name: "Gated",
    tasks: [
      { id: "always", description: "always runs", resolver: "noop", outputShapes: ["result"] },
      {
        id: "gated_task",
        description: "gated on a defaulted variable",
        resolver: "noop",
        outputShapes: ["result"],
        conditional: { expression: GATE },
      },
    ],
  };
  if (declared) {
    t["variables"] = [
      { name: "applyExtraction", type: "boolean", required: false, default: declared.default },
    ];
  }
  return t as unknown as ActivityTemplate;
}

function newExecutor() {
  const runtime = new ExecutionRuntime({ random: new SequentialRandom(), clock: new SteppingClock() });
  runtime.resolvers.register(noopResolver);
  return new ActivityExecutor(runtime);
}

describe("template-declared variable defaults", () => {
  test("a declared default keeps an unsupplied gate variable from failing the execution", async () => {
    for (const value of [false, true]) {
      const trace = await newExecutor().execute(makeTemplate({ default: value }), {});
      expect(trace.status).not.toBe("failed");
      expect(JSON.stringify(trace.failureMode ?? {})).not.toContain("UNRESOLVABLE_GATE");
    }
  });

  test("without a declaration the gate is still UNRESOLVABLE — the default is what fixes it", async () => {
    // Pins the mechanism: the fix is the declared default being seeded, not gates
    // having been made permissive. This is the exact production failure.
    const trace = await newExecutor().execute(makeTemplate(undefined), {});
    expect(trace.status).toBe("failed");
    expect(JSON.stringify(trace.failureMode ?? {})).toContain("UNRESOLVABLE_GATE");
  });

  test("a caller-supplied value still overrides the declared default", async () => {
    const trace = await newExecutor().execute(
      makeTemplate({ default: false }),
      { variables: { applyExtraction: true } },
    );
    expect(trace.status).not.toBe("failed");
    expect(JSON.stringify(trace.failureMode ?? {})).not.toContain("UNRESOLVABLE_GATE");
  });
});
