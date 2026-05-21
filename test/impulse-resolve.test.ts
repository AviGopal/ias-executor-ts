/**
 * impulse-resolve resolver tests — minimal port (static pointer only).
 */
import { describe, expect, test, afterEach } from "bun:test";
import { makeImpulseResolveResolver } from "../src/resolvers/impulse-resolve";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ResolverContext } from "../src/resolvers";

function makeContext(config: Record<string, unknown>): ResolverContext {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  return {
    executionId: "exec_test",
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "impulse-resolve", config } as never] },
    task: { id: "x", description: "", resolver: "impulse-resolve", config } as never,
    variables: {},
    inputImpulses: [],
    store: runtime.store,
    clock: runtime.clock,
    random: runtime.random,
    eventSink: runtime.eventSink,
    traceSink: runtime.traceSink,
    attachedVessels: runtime.attachedVessels,
  };
}

const realFetch = globalThis.fetch;

describe("impulse-resolve resolver", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POSTs pointer to /v2/impulses/resolve and returns content as impulse", async () => {
    let receivedBody: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      receivedBody = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ content: { found: 42 }, metadata: { summary: "ok" } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const resolver = makeImpulseResolveResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ pointer: { type: "test_report", test_id: "x" } });
    const impulses = await resolver.resolve(ctx);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.metadata.shape).toBe("test_report");
    expect(impulses[0]!.content).toEqual({ found: 42 });
    expect(receivedBody).toEqual({ pointer: { type: "test_report", test_id: "x" } });
  });

  test("graceful degradation when no activity-api endpoint", async () => {
    const resolver = makeImpulseResolveResolver();
    const ctx = makeContext({ pointer: { type: "x" } });
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.degraded).toBe(true);
    expect(impulses[0]!.content).toBeNull();
  });

  test("HTTP non-2xx degrades to null content with error in metadata", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const resolver = makeImpulseResolveResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ pointer: { type: "x" } });
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.degraded).toBe(true);
    expect(impulses[0]!.metadata.summary).toContain("HTTP 500");
  });

  test("network error degrades to null content", async () => {
    globalThis.fetch = (async () => {
      throw new Error("net down");
    }) as typeof fetch;
    const resolver = makeImpulseResolveResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ pointer: { type: "x" } });
    const impulses = await resolver.resolve(ctx);
    expect(impulses[0]!.metadata.degraded).toBe(true);
    expect((impulses[0]!.metadata as { error?: string }).error).toContain("net down");
  });

  test("missing pointer.type throws", async () => {
    const resolver = makeImpulseResolveResolver({ activityApiEndpoint: "http://act", activityApiKey: "k" });
    const ctx = makeContext({ pointer: {} });
    await expect(resolver.resolve(ctx)).rejects.toThrow(/pointer.type is required/);
  });

  test("config-level endpoint/apiKey override host-level options", async () => {
    let urlSeen = "";
    globalThis.fetch = (async (url: string) => {
      urlSeen = url;
      return new Response(JSON.stringify({ content: null }), { status: 200 });
    }) as typeof fetch;
    const resolver = makeImpulseResolveResolver({ activityApiEndpoint: "http://host-default", activityApiKey: "h" });
    const ctx = makeContext({
      pointer: { type: "x" },
      activityApiEndpoint: "http://config-override",
      activityApiKey: "c",
    });
    await resolver.resolve(ctx);
    expect(urlSeen).toContain("http://config-override");
  });

  test("forwards backend metadata transparently on success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          content: { v: 1 },
          metadata: { custom_field: "abc", summary: "ok" },
        }),
        { status: 200 },
      )) as typeof fetch;
    const resolver = makeImpulseResolveResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ pointer: { type: "x" } });
    const impulses = await resolver.resolve(ctx);
    expect((impulses[0]!.metadata as { custom_field?: string }).custom_field).toBe("abc");
  });
});
