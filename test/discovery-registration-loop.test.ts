import { describe, it, expect, afterEach } from "bun:test";
import { DiscoveryRegistrationLoop } from "../src/hosts/discovery-registration-loop";
import { VesselDaemon } from "../src/hosts/vessel-daemon";
import type { ActivityExecutor } from "../src/engine";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeLoop(): DiscoveryRegistrationLoop {
  return new DiscoveryRegistrationLoop({
    discoveryEndpoint: "http://discovery.test",
    vesselId: "test-vessel-1",
    vesselName: "test-vessel",
    shapes: ["test_shape"],
    resolveEndpoint: "http://localhost:9999/resolve",
    apiKey: "test-key",
    port: 9999,
  });
}

describe("DiscoveryRegistrationLoop V12 re-register on heartbeat 404", () => {
  it("triggers register() when heartbeat returns 404", async () => {
    // Simulate the discovery-restart sequence:
    //   1. initial /register → 200 (vessel known)
    //   2. discovery restarts; vessel sends /heartbeat → 404 (not known)
    //   3. loop should fire /register again, NOT just increment counter
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) {
        calls.push("register");
        return new Response("ok", { status: 200 });
      }
      if (url.endsWith("/heartbeat")) {
        calls.push("heartbeat");
        return new Response("not found", { status: 404 });
      }
      return new Response("?", { status: 500 });
    }) as unknown as typeof fetch;

    const loop = makeLoop();
    // Drive private methods deterministically — no timer setup needed for
    // this contract test.
    type Private = {
      register(): Promise<void>;
      heartbeat(): Promise<void>;
      failureCount: number;
    };
    const p = loop as unknown as Private;
    await p.register();
    expect(calls).toEqual(["register"]);
    await p.heartbeat();
    // heartbeat 404 → triggers register; failureCount stays at 0.
    expect(calls).toEqual(["register", "heartbeat", "register"]);
    expect(p.failureCount).toBe(0);
  });

  it("does NOT re-register on non-404 heartbeat failure (e.g. 500)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/register")) {
        calls.push("register");
        return new Response("ok", { status: 200 });
      }
      if (url.endsWith("/heartbeat")) {
        calls.push("heartbeat");
        return new Response("server error", { status: 500 });
      }
      return new Response("?", { status: 500 });
    }) as unknown as typeof fetch;

    const loop = makeLoop();
    type Private = {
      register(): Promise<void>;
      heartbeat(): Promise<void>;
      failureCount: number;
    };
    const p = loop as unknown as Private;
    await p.register();
    await p.heartbeat();
    // 500 → no re-register; failureCount increments.
    expect(calls).toEqual(["register", "heartbeat"]);
    expect(p.failureCount).toBe(1);
  });
});

describe("DiscoveryRegistrationLoop advertised resolve_timeout_ms", () => {
  const registered = async (extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const loop = new DiscoveryRegistrationLoop({
      discoveryEndpoint: "http://discovery.test",
      vesselId: "test-vessel-1",
      vesselName: "test-vessel",
      shapes: ["test_shape"],
      resolveEndpoint: "http://localhost:9999/resolve",
      apiKey: "test-key",
      port: 9999,
      ...extra,
    });
    await (loop as unknown as { register(): Promise<void> }).register();
    return body;
  };

  it("keeps the 10 s default when a vessel declares none", async () => {
    expect((await registered({})).resolve_timeout_ms).toBe(10_000);
  });

  it("advertises the bound a vessel declares", async () => {
    expect((await registered({ resolveTimeoutMs: 300_000 })).resolve_timeout_ms).toBe(300_000);
  });
});

describe("VesselDaemon resolveTimeoutMs", () => {
  const loopOf = (extra: Record<string, unknown>) =>
    (new VesselDaemon({
      port: 0,
      vesselId: "test-daemon",
      vesselName: "Test Daemon",
      shapes: ["test_shape"],
      executor: {} as ActivityExecutor,
      resolvers: new Map(),
      apiKey: "test-key",
      discoveryEndpoint: "http://discovery.test",
      ...extra,
    }) as unknown as { discoveryLoop: { config: { resolveTimeoutMs?: number } } }).discoveryLoop.config;

  it("passes a declared bound to its discovery registration", () => {
    expect(loopOf({ resolveTimeoutMs: 300_000 }).resolveTimeoutMs).toBe(300_000);
  });

  it("passes nothing when none is declared, so the loop keeps its default", () => {
    expect("resolveTimeoutMs" in loopOf({})).toBe(false);
  });
});

describe("DiscoveryRegistrationLoop advertised shape descriptions and inputs", () => {
  const INPUTS = { test_shape: { type: "object", required: ["path"], properties: { path: { type: "string" } } } };
  const registered = async (extra: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const loop = new DiscoveryRegistrationLoop({
      discoveryEndpoint: "http://discovery.test",
      vesselId: "test-vessel-1",
      vesselName: "test-vessel",
      shapes: ["test_shape"],
      resolveEndpoint: "http://localhost:9999/resolve",
      apiKey: "test-key",
      port: 9999,
      ...extra,
    });
    await (loop as unknown as { register(): Promise<void> }).register();
    return body;
  };

  it("advertises what a vessel declares", async () => {
    const body = await registered({ shapeDescriptions: { test_shape: "Reads a test." }, shapeInputs: INPUTS });
    expect(body.shape_descriptions).toEqual({ test_shape: "Reads a test." });
    expect(body.shape_inputs).toEqual(INPUTS);
  });

  it("sends neither field when a vessel declares none", async () => {
    const body = await registered({});
    expect("shape_descriptions" in body).toBe(false);
    expect("shape_inputs" in body).toBe(false);
  });
});

describe("VesselDaemon shape descriptions and inputs", () => {
  const loopOf = (extra: Record<string, unknown>) =>
    (new VesselDaemon({
      port: 0,
      vesselId: "test-daemon",
      vesselName: "Test Daemon",
      shapes: ["test_shape"],
      executor: {} as ActivityExecutor,
      resolvers: new Map(),
      apiKey: "test-key",
      discoveryEndpoint: "http://discovery.test",
      ...extra,
    }) as unknown as { discoveryLoop: { config: Record<string, unknown> } }).discoveryLoop.config;

  it("passes declared descriptions and inputs to its discovery registration", () => {
    const config = loopOf({ shapeDescriptions: { test_shape: "x" }, shapeInputs: { test_shape: { type: "object" } } });
    expect(config.shapeDescriptions).toEqual({ test_shape: "x" });
    expect(config.shapeInputs).toEqual({ test_shape: { type: "object" } });
  });

  it("passes neither when none is declared", () => {
    const config = loopOf({});
    expect("shapeDescriptions" in config).toBe(false);
    expect("shapeInputs" in config).toBe(false);
  });
});
