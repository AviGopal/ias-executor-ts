import { describe, expect, test } from "bun:test";
import { BusForwardingEventSink, mapEventTypeToBusForm } from "../src/adapters/bus-forwarder";
import type { EventSink } from "../src/ports";
import type { LifecycleEvent } from "../src/ontology";

describe("mapEventTypeToBusForm", () => {
  test("converts colon-separated camelCase to dot-separated snake_case", () => {
    expect(mapEventTypeToBusForm("lifecycle:task:preBinding")).toBe("lifecycle.task.pre_binding");
    expect(mapEventTypeToBusForm("lifecycle:execution:succeeded")).toBe("lifecycle.execution.succeeded");
    expect(mapEventTypeToBusForm("lifecycle:gap:classified")).toBe("lifecycle.gap.classified");
    expect(mapEventTypeToBusForm("lifecycle:llm:dispatched")).toBe("lifecycle.llm.dispatched");
  });

  test("preserves already-dotted lowercase types", () => {
    expect(mapEventTypeToBusForm("task.started")).toBe("task.started");
    expect(mapEventTypeToBusForm("activity.completed")).toBe("activity.completed");
  });

  test("converts dotted camelCase to dotted snake_case", () => {
    expect(mapEventTypeToBusForm("tool.callDispatched")).toBe("tool.call_dispatched");
    expect(mapEventTypeToBusForm("activity.subRun")).toBe("activity.sub_run");
  });

  test("handles single-segment types", () => {
    expect(mapEventTypeToBusForm("started")).toBe("started");
    expect(mapEventTypeToBusForm("camelCase")).toBe("camel_case");
  });
});

describe("BusForwardingEventSink", () => {
  function makeEvent(type: string, data: Record<string, unknown> = {}): LifecycleEvent {
    return { type, timestamp: 1700000000000, data };
  }

  test("inner sink is called first with the original event", async () => {
    const innerCalls: LifecycleEvent[] = [];
    const inner: EventSink = { emit: (e) => { innerCalls.push(e); } };
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sink = new BusForwardingEventSink({
      inner,
      activityApiEndpoint: "http://test",
      sourceVesselId: "test-vessel",
      fetchFn,
    });

    await sink.emit(makeEvent("lifecycle:task:preBinding", { taskId: "t1" }));
    expect(innerCalls).toHaveLength(1);
    expect(innerCalls[0]!.type).toBe("lifecycle:task:preBinding");
    expect(innerCalls[0]!.data.taskId).toBe("t1");
  });

  test("forwards POST to /v2/events/publish with mapped type", async () => {
    const inner: EventSink = { emit: () => {} };
    let captured: { url: string; body: any } | null = null;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), body: init?.body ? JSON.parse(init.body as string) : null };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sink = new BusForwardingEventSink({
      inner,
      activityApiEndpoint: "http://activity-api:8080",
      apiKey: "secret",
      sourceVesselId: "goal-host-vessel",
      fetchFn,
    });

    await sink.emit(makeEvent("lifecycle:task:preBinding", { taskId: "t1", templateId: "tpl-a" }));

    // Give the fire-and-forget microtask a tick to schedule.
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("http://activity-api:8080/v2/events/publish");
    expect(captured!.body.type).toBe("lifecycle.task.pre_binding");
    expect(captured!.body.source_vessel_id).toBe("goal-host-vessel");
    expect(captured!.body.data.taskId).toBe("t1");
    expect(captured!.body.data.templateId).toBe("tpl-a");
    expect(captured!.body.data.original_event_type).toBe("lifecycle:task:preBinding");
    expect(captured!.body.data.emitted_at_ms).toBe(1700000000000);
  });

  test("forwarder failure does NOT propagate (fire-and-forget)", async () => {
    const inner: EventSink = { emit: () => {} };
    const fetchFn = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const warnings: string[] = [];

    const sink = new BusForwardingEventSink({
      inner,
      activityApiEndpoint: "http://activity-api:8080",
      sourceVesselId: "test",
      fetchFn,
      logger: { warn: (m: string) => warnings.push(m) },
    });

    // The emit call itself must not throw.
    await sink.emit(makeEvent("lifecycle:task:preBinding"));
    await new Promise((r) => setTimeout(r, 10));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("publish failed");
  });

  test("inner sink throw propagates (terminal per EventSink contract)", async () => {
    const inner: EventSink = {
      emit: () => { throw new Error("inner sink down"); },
    };
    const fetchFn = (async () => new Response("{}", { status: 200 })) as typeof fetch;

    const sink = new BusForwardingEventSink({
      inner,
      activityApiEndpoint: "http://test",
      sourceVesselId: "test",
      fetchFn,
    });

    await expect(sink.emit(makeEvent("task.started"))).rejects.toThrow("inner sink down");
  });

  test("non-2xx from publish logged once per outage", async () => {
    const inner: EventSink = { emit: () => {} };
    const fetchFn = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const warnings: string[] = [];

    const sink = new BusForwardingEventSink({
      inner,
      activityApiEndpoint: "http://test",
      sourceVesselId: "test",
      fetchFn,
      logger: { warn: (m: string) => warnings.push(m) },
    });

    await sink.emit(makeEvent("task.started"));
    await new Promise((r) => setTimeout(r, 5));
    await sink.emit(makeEvent("task.completed"));
    await new Promise((r) => setTimeout(r, 5));
    await sink.emit(makeEvent("activity.completed"));
    await new Promise((r) => setTimeout(r, 5));

    // Three emits, one log because outage suppression kicks in.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("HTTP 500");
  });

  test("auth header included when apiKey provided", async () => {
    const inner: EventSink = { emit: () => {} };
    let authHeader: string | undefined;
    const fetchFn = (async (_url: any, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authHeader = headers["Authorization"];
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const sink = new BusForwardingEventSink({
      inner,
      activityApiEndpoint: "http://test",
      apiKey: "mb-test-key",
      sourceVesselId: "test",
      fetchFn,
    });
    await sink.emit(makeEvent("task.started"));
    await new Promise((r) => setTimeout(r, 5));
    expect(authHeader).toBe("ApiKey mb-test-key");
  });
});
