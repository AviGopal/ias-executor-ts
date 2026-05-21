/**
 * validation resolver tests — rule-mode port for audit-test-report.
 */
import { describe, expect, test } from "bun:test";
import { makeValidationResolver } from "../src/resolvers/validation";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";
import type { Impulse } from "../src/ontology";

function makeImpulse(shape: string, content: unknown): Impulse {
  return {
    id: `imp-${shape}`,
    pointer: { type: "memo" },
    metadata: { shape },
    loaded: true,
    content,
  };
}

function makeContext(
  config: Record<string, unknown>,
  inputImpulses: Impulse[] = [],
): ResolverContext {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  return {
    executionId: "exec_test",
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "validation", config } as never] },
    task: { id: "x", description: "", resolver: "validation", config } as never,
    variables: {},
    inputImpulses,
    store: runtime.store,
    clock: runtime.clock,
    random: runtime.random,
    eventSink: runtime.eventSink,
    traceSink: runtime.traceSink,
    attachedVessels: runtime.attachedVessels,
  };
}

describe("validation rule=decision_record_completeness", () => {
  test("passes when all passes[] entries have the required field", async () => {
    const resolver = makeValidationResolver();
    const report = makeImpulse("test_report", {
      passes: [
        { trace_event_id_or_impulse_id: "evt-1" },
        { trace_event_id_or_impulse_id: "evt-2" },
      ],
    });
    const ctx = makeContext({ rule: "decision_record_completeness" }, [report]);
    const impulses = await resolver.resolve(ctx);
    const result = impulses[0]!.content as { passed: boolean; details?: { total_passes: number } };
    expect(result.passed).toBe(true);
    expect(result.details?.total_passes).toBe(2);
  });

  test("fails when entries are missing required fields", async () => {
    const resolver = makeValidationResolver();
    const report = makeImpulse("test_report", {
      passes: [
        { trace_event_id_or_impulse_id: "evt-1" },
        { someOtherField: "x" }, // missing
      ],
    });
    const ctx = makeContext(
      { rule: "decision_record_completeness", audit_subtype_on_fail: "audit_record_incomplete" },
      [report],
    );
    const impulses = await resolver.resolve(ctx);
    const result = impulses[0]!.content as { passed: boolean; audit_subtype?: string; details?: { missing_entries?: unknown[] } };
    expect(result.passed).toBe(false);
    expect(result.audit_subtype).toBe("audit_record_incomplete");
    expect((result.details?.missing_entries ?? []).length).toBe(1);
  });

  test("fails when test_report impulse absent", async () => {
    const resolver = makeValidationResolver();
    const ctx = makeContext({ rule: "decision_record_completeness" });
    const impulses = await resolver.resolve(ctx);
    const result = impulses[0]!.content as { passed: boolean; error?: string };
    expect(result.passed).toBe(false);
    expect(result.error).toContain("test_report impulse");
  });
});

describe("validation rule=witness_presence", () => {
  test("passes when witnesses cover declared witness_types", async () => {
    const resolver = makeValidationResolver();
    const report = makeImpulse("test_report", {
      witnesses: [
        { type: "differential_solve", x: 1 },
        { type: "oracle_label", y: 2 },
      ],
    });
    const reg = makeImpulse("test_registration", {
      witness_types: ["differential_solve", "oracle_label"],
    });
    const ctx = makeContext({ rule: "witness_presence" }, [report, reg]);
    const impulses = await resolver.resolve(ctx);
    expect((impulses[0]!.content as { passed: boolean }).passed).toBe(true);
  });

  test("fails when a declared witness type is missing", async () => {
    const resolver = makeValidationResolver();
    const report = makeImpulse("test_report", { witnesses: [{ type: "differential_solve" }] });
    const reg = makeImpulse("test_registration", {
      witness_types: ["differential_solve", "oracle_label"],
    });
    const ctx = makeContext({ rule: "witness_presence" }, [report, reg]);
    const impulses = await resolver.resolve(ctx);
    const result = impulses[0]!.content as { passed: boolean; error?: string };
    expect(result.passed).toBe(false);
    expect(result.error).toContain("oracle_label");
  });

  test("vacuously passes when no witness_types declared", async () => {
    const resolver = makeValidationResolver();
    const report = makeImpulse("test_report", { witnesses: [] });
    const reg = makeImpulse("test_registration", {});
    const ctx = makeContext({ rule: "witness_presence" }, [report, reg]);
    const impulses = await resolver.resolve(ctx);
    expect((impulses[0]!.content as { passed: boolean }).passed).toBe(true);
  });
});

describe("validation general", () => {
  test("unknown rule reports unknown", async () => {
    const resolver = makeValidationResolver();
    const ctx = makeContext({ rule: "made_up_rule" });
    const impulses = await resolver.resolve(ctx);
    const result = impulses[0]!.content as { passed: boolean; error?: string };
    expect(result.passed).toBe(false);
    expect(result.error).toContain("unknown rule");
  });

  test("missing rule fails with a clear message", async () => {
    const resolver = makeValidationResolver();
    const ctx = makeContext({});
    const impulses = await resolver.resolve(ctx);
    const result = impulses[0]!.content as { passed: boolean; error?: string };
    expect(result.passed).toBe(false);
    expect(result.error).toContain("config.rule is required");
  });

  test("emits validation_result-shape impulse", async () => {
    const resolver = makeValidationResolver();
    const ctx = makeContext({ rule: "decision_record_completeness" });
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.shape).toBe("validation_result");
  });
});
