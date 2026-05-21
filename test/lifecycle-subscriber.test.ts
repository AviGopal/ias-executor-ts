import { describe, expect, test } from "bun:test";
import {
  LifecycleSubscriberVessel,
  matchesFilter,
  resolvePayloadField,
  deepEquals,
  resolveDedupeKey,
  refuseForDepthCap,
  defaultTopKForShape,
  type ActivityTemplate,
  type LifecycleEvent,
} from "../src";

function makeTemplate(
  id: string,
  subscription: ActivityTemplate["subscription"],
  extras: Partial<ActivityTemplate> = {},
): ActivityTemplate {
  return {
    id,
    name: id,
    tasks: [],
    subscription,
    ...extras,
  };
}

function makeEvent(
  type: string,
  data: Record<string, unknown> = {},
): LifecycleEvent {
  return { type, timestamp: Date.now(), data };
}

interface DispatchRecord {
  templateId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

function recordingDispatcher() {
  const calls: DispatchRecord[] = [];
  const dispatcher = (
    template: ActivityTemplate,
    event: LifecycleEvent,
    ctx: { lifecycleShape: string; payload: Record<string, unknown> },
  ): void => {
    calls.push({
      templateId: template.id,
      eventType: event.type,
      payload: ctx.payload,
    });
  };
  return { calls, dispatcher };
}

describe("matchesFilter / resolvePayloadField / deepEquals", () => {
  test("matches plain key/value with deep equality", () => {
    expect(matchesFilter({ a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(matchesFilter({ a: 1 }, { a: 2 })).toBe(false);
  });

  test("missing payload key fails the match", () => {
    expect(matchesFilter({ a: 1 }, {})).toBe(false);
  });

  test("_contains suffix matches array membership", () => {
    expect(
      matchesFilter(
        { outputShapes_contains: "test_report" },
        { outputShapes: ["test_report", "other"] },
      ),
    ).toBe(true);
    expect(
      matchesFilter(
        { outputShapes_contains: "test_report" },
        { outputShapes: ["other"] },
      ),
    ).toBe(false);
  });

  test("_equals suffix matches deep equality on resolved field", () => {
    expect(matchesFilter({ passed_equals: false }, { passed: false })).toBe(
      true,
    );
    expect(matchesFilter({ passed_equals: false }, { passed: true })).toBe(
      false,
    );
  });

  test("snake_case filter resolves against camelCase payload", () => {
    expect(
      matchesFilter(
        { output_shapes_contains: "trace" },
        { outputShapes: ["trace"] },
      ),
    ).toBe(true);
  });

  test("resolvePayloadField prefers literal then falls back to camelCase", () => {
    expect(resolvePayloadField({ output_shapes: [1] }, "output_shapes")).toEqual([1]);
    expect(resolvePayloadField({ outputShapes: [2] }, "output_shapes")).toEqual([2]);
    expect(resolvePayloadField({}, "missing")).toBeUndefined();
  });

  test("deepEquals handles nested objects + arrays", () => {
    expect(deepEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEquals({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });
});

describe("resolveDedupeKey", () => {
  test("renders {field} placeholders", () => {
    const template = makeTemplate("t1", {
      shape: "x",
      dedupe_key: "{test_registration_id}:{audit_subtype}",
    });
    const key = resolveDedupeKey(template, {
      test_registration_id: "reg-1",
      audit_subtype: "alignment",
    });
    expect(key).toBe("reg-1:alignment");
  });

  test("falls back to camelCase on single-segment placeholder", () => {
    const template = makeTemplate("t1", {
      shape: "x",
      dedupe_key: "{test_registration_id}",
    });
    const key = resolveDedupeKey(template, { testRegistrationId: "reg-2" });
    expect(key).toBe("reg-2");
  });

  test("returns null when template has no dedupe_key", () => {
    const template = makeTemplate("t1", { shape: "x" });
    expect(resolveDedupeKey(template, {})).toBeNull();
  });
});

describe("refuseForDepthCap", () => {
  test("ALL subscriber templates participate (2026-05-20: was audit-only; universal cap prevents mutual recursion)", () => {
    const nonAudit = makeTemplate("t", { shape: "x" }, { tags: ["other"] });
    // Below cap: allowed.
    expect(refuseForDepthCap(nonAudit, { parentDepth: 1 })).toBe(false);
    // At cap: refused.
    expect(refuseForDepthCap(nonAudit, { parentDepth: 2 })).toBe(true);
  });

  test("default cap = 2; parentDepth >= cap refuses (audit-tagged baseline behaviour)", () => {
    const audit = makeTemplate("t", { shape: "x" }, { tags: ["audit"] });
    expect(refuseForDepthCap(audit, { parentDepth: 1 })).toBe(false);
    expect(refuseForDepthCap(audit, { parentDepth: 2 })).toBe(true);
  });

  test("declared auditDepthCap is honoured but capped at 4", () => {
    const audit = makeTemplate(
      "t",
      { shape: "x" },
      { tags: ["audit"], metadata: { auditDepthCap: 10 } },
    );
    expect(refuseForDepthCap(audit, { parentDepth: 3 })).toBe(false);
    expect(refuseForDepthCap(audit, { parentDepth: 4 })).toBe(true);
  });

  test("compositionChain length used when parentDepth absent", () => {
    const audit = makeTemplate("t", { shape: "x" }, { tags: ["audit"] });
    expect(
      refuseForDepthCap(audit, { compositionChain: ["a", "b"] }),
    ).toBe(true);
  });
});

describe("defaultTopKForShape", () => {
  test("high-frequency shapes => 1", () => {
    expect(defaultTopKForShape("task.completed")).toBe(1);
    expect(defaultTopKForShape("lifecycle:task:completed")).toBe(1);
  });
  test("one-shot shapes => 3", () => {
    expect(defaultTopKForShape("activity.completed")).toBe(3);
  });
});

describe("LifecycleSubscriberVessel", () => {
  test("dispatches when event type matches subscription.shape with no filter", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(makeTemplate("sub1", { shape: "activity.completed" }));

    await vessel.emit(makeEvent("activity.completed", { foo: 1 }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.templateId).toBe("sub1");
  });

  test("dispatches when _contains filter matches payload array", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("audit-test-report", {
        shape: "lifecycle:execution:succeeded",
        filter: { output_shapes_contains: "test_report" },
      }),
    );

    await vessel.emit(
      makeEvent("lifecycle:execution:succeeded", {
        outputShapes: ["test_report", "other"],
      }),
    );

    expect(calls).toHaveLength(1);
  });

  test("does not dispatch when _contains filter misses", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("audit-test-report", {
        shape: "lifecycle:execution:succeeded",
        filter: { output_shapes_contains: "test_report" },
      }),
    );

    await vessel.emit(
      makeEvent("lifecycle:execution:succeeded", {
        outputShapes: ["other"],
      }),
    );

    expect(calls).toHaveLength(0);
  });

  test("_equals suffix predicate gates dispatch", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("debug-failing-audit", {
        shape: "audit.completed",
        filter: { passed_equals: false },
      }),
    );

    await vessel.emit(makeEvent("audit.completed", { passed: true }));
    await vessel.emit(makeEvent("audit.completed", { passed: false }));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.passed).toBe(false);
  });

  test("snake_case filter matches camelCase payload field", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("sub", {
        shape: "x",
        filter: { execution_id: "exec-1" },
      }),
    );

    await vessel.emit(makeEvent("x", { executionId: "exec-1" }));

    expect(calls).toHaveLength(1);
  });

  test("dedupe_key collapses repeated fires within window", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("debug-failing-audit", {
        shape: "audit.failed",
        dedupe_key: "{test_registration_id}:{audit_subtype}",
      }),
    );

    const payload = {
      test_registration_id: "reg-1",
      audit_subtype: "alignment",
    };
    await vessel.emit(makeEvent("audit.failed", payload));
    await vessel.emit(makeEvent("audit.failed", payload));
    await vessel.emit(makeEvent("audit.failed", payload));

    expect(calls).toHaveLength(1);
  });

  test("different dedupe keys do not collide", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("sub", {
        shape: "x",
        dedupe_key: "{k}",
      }),
    );

    await vessel.emit(makeEvent("x", { k: "a" }));
    await vessel.emit(makeEvent("x", { k: "b" }));
    await vessel.emit(makeEvent("x", { k: "a" }));

    expect(calls).toHaveLength(2);
  });

  test("depth cap refuses dispatch for audit templates at depth >= cap", async () => {
    const warnings: string[] = [];
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({
      dispatcher,
      logger: {
        warn: (m) => warnings.push(m),
        debug: () => {},
      },
    });
    vessel.register(
      makeTemplate(
        "audit-template",
        { shape: "x" },
        { tags: ["audit"] },
      ),
    );

    await vessel.emit(makeEvent("x", { parentDepth: 2 }));

    expect(calls).toHaveLength(0);
    expect(warnings.some((m) => m.includes("depth-cap"))).toBe(true);
  });

  test("untagged templates ARE depth-refused at the universal cap (2026-05-20 behaviour change)", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(makeTemplate("plain", { shape: "x" }));

    // Below cap: dispatches.
    await vessel.emit(makeEvent("x", { parentDepth: 1 }));
    expect(calls).toHaveLength(1);

    // At/above cap: refused.
    await vessel.emit(makeEvent("x", { parentDepth: 100 }));
    expect(calls).toHaveLength(1);
  });

  test("multiple subscribers for the same event all dispatch in registration order", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(makeTemplate("a", { shape: "x" }));
    vessel.register(makeTemplate("b", { shape: "x" }));
    vessel.register(makeTemplate("c", { shape: "x" }));

    await vessel.emit(makeEvent("x"));

    expect(calls.map((c) => c.templateId)).toEqual(["a", "b", "c"]);
  });

  test("downstream sink receives every event regardless of matches", async () => {
    const sinkEvents: LifecycleEvent[] = [];
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({
      dispatcher,
      downstreamSink: {
        emit(event) {
          sinkEvents.push(event);
        },
      },
    });
    // No subscribers registered for "noop"
    await vessel.emit(makeEvent("noop", { a: 1 }));
    vessel.register(makeTemplate("sub", { shape: "matched" }));
    await vessel.emit(makeEvent("matched", { a: 2 }));

    expect(calls).toHaveLength(1);
    expect(sinkEvents).toHaveLength(2);
    expect(sinkEvents.map((e) => e.type)).toEqual(["noop", "matched"]);
  });

  test("dispatcher errors are isolated and do not abort sibling subscribers", async () => {
    const calls: string[] = [];
    const vessel = new LifecycleSubscriberVessel({
      dispatcher: (template) => {
        calls.push(template.id);
        if (template.id === "boom") {
          throw new Error("intentional");
        }
      },
    });
    vessel.register(makeTemplate("first", { shape: "x" }));
    vessel.register(makeTemplate("boom", { shape: "x" }));
    vessel.register(makeTemplate("last", { shape: "x" }));

    await vessel.emit(makeEvent("x"));

    expect(calls).toEqual(["first", "boom", "last"]);
  });

  test("self-subscription guard skips emitting template", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(makeTemplate("self", { shape: "x" }));
    vessel.register(makeTemplate("other", { shape: "x" }));

    // Event payload identifies the emitting template via `templateId`.
    await vessel.emit(makeEvent("x", { templateId: "self" }));

    expect(calls.map((c) => c.templateId)).toEqual(["other"]);
  });

  test("unregister removes a subscriber", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(makeTemplate("sub", { shape: "x" }));
    vessel.unregister("sub");

    await vessel.emit(makeEvent("x"));

    expect(calls).toHaveLength(0);
  });

  test("register without subscription.shape throws", () => {
    const { dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    expect(() =>
      vessel.register({
        id: "no-sub",
        name: "no-sub",
        tasks: [],
      }),
    ).toThrow(/no subscription.shape/);
  });

  test("_resetDedupeCache clears suppression", async () => {
    const { calls, dispatcher } = recordingDispatcher();
    const vessel = new LifecycleSubscriberVessel({ dispatcher });
    vessel.register(
      makeTemplate("sub", {
        shape: "x",
        dedupe_key: "{k}",
      }),
    );

    await vessel.emit(makeEvent("x", { k: "1" }));
    await vessel.emit(makeEvent("x", { k: "1" }));
    expect(calls).toHaveLength(1);

    vessel._resetDedupeCache();
    await vessel.emit(makeEvent("x", { k: "1" }));
    expect(calls).toHaveLength(2);
  });
});
