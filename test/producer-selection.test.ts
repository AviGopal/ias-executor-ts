/**
 * producer_selection resolver tests — minimal port.
 *
 * Covers the structural contract slot-binding's select_or_produce task
 * depends on. Real Thompson ranking deferred — these tests use the
 * graceful-degradation path with a stub fetch.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { makeProducerSelectionResolver } from "../src/resolvers/producer-selection";
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
    template: { id: "t", name: "T", tasks: [{ id: "x", resolver: "producer_selection", config } as never] },
    task: { id: "x", description: "", resolver: "producer_selection", config } as never,
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

describe("producer_selection (minimal port)", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns unbindable:true when no activityApiEndpoint configured", async () => {
    const resolver = makeProducerSelectionResolver();
    const ctx = makeContext({ shape: "fileEdit" });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { metadata: { unbindable: boolean; reason: string } };
    expect(c.metadata.unbindable).toBe(true);
    expect(c.metadata.reason).toContain("no activity-api endpoint");
  });

  test("returns unbindable:true when discover-by-shapes returns empty producers", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ producers: [] }), { status: 200 })) as typeof fetch;
    const resolver = makeProducerSelectionResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ shape: "fileEdit" });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { metadata: { unbindable: boolean } };
    expect(c.metadata.unbindable).toBe(true);
  });

  test("returns first producer when discover-by-shapes returns candidates", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          producers: [
            { activity_id: "tpl-1", composition_score: { alpha: 5, beta: 2 } },
            { activity_id: "tpl-2", composition_score: { alpha: 3, beta: 1 } },
          ],
        }),
        { status: 200 },
      )) as typeof fetch;
    const resolver = makeProducerSelectionResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ shape: "fileEdit" });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as {
      chosen_producer: { activity_id: string };
      metadata: { unbindable: boolean; degraded: boolean };
    };
    expect(c.metadata.unbindable).toBe(false);
    expect(c.metadata.degraded).toBe(true);
    expect(c.chosen_producer.activity_id).toBe("tpl-1");
  });

  test("treats HTTP failure as unbindable (graceful degradation)", async () => {
    globalThis.fetch = (async () => new Response("err", { status: 500 })) as typeof fetch;
    const resolver = makeProducerSelectionResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ shape: "fileEdit" });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { metadata: { unbindable: boolean } };
    expect(c.metadata.unbindable).toBe(true);
  });

  test("treats network error as unbindable", async () => {
    globalThis.fetch = (async () => {
      throw new Error("net down");
    }) as typeof fetch;
    const resolver = makeProducerSelectionResolver({
      activityApiEndpoint: "http://act",
      activityApiKey: "k",
    });
    const ctx = makeContext({ shape: "fileEdit" });
    const impulses = await resolver.resolve(ctx);
    const c = impulses[0]!.content as { metadata: { unbindable: boolean } };
    expect(c.metadata.unbindable).toBe(true);
  });

  test("config-level endpoint/apiKey override host-level options", async () => {
    let urlSeen = "";
    globalThis.fetch = (async (url: string) => {
      urlSeen = url;
      return new Response(JSON.stringify({ producers: [] }), { status: 200 });
    }) as typeof fetch;
    const resolver = makeProducerSelectionResolver({ activityApiEndpoint: "http://host", activityApiKey: "k" });
    const ctx = makeContext({
      shape: "x",
      activityApiEndpoint: "http://config",
      activityApiKey: "k2",
    });
    await resolver.resolve(ctx);
    expect(urlSeen).toContain("http://config");
  });

  test("missing shape throws", async () => {
    const resolver = makeProducerSelectionResolver({ activityApiEndpoint: "http://act", activityApiKey: "k" });
    const ctx = makeContext({});
    await expect(resolver.resolve(ctx)).rejects.toThrow(/config.shape is required/);
  });
});
