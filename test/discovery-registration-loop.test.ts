import { describe, it, expect, afterEach } from "bun:test";
import { DiscoveryRegistrationLoop } from "../src/hosts/discovery-registration-loop";

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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
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
    globalThis.fetch = (async (input: RequestInfo | URL) => {
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
