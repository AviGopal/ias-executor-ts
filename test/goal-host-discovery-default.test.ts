/**
 * AN OMITTED discoveryEndpoint MUST NOT SEND A DISCOVERY LOOKUP (OR THE API KEY) OFF THE FLEET.
 *
 * GoalHost builds one HttpDiscoveryAdapter that the runtime, the engine's shape-producer
 * lookups and verify-three-invariants all use. `discoveryEndpoint` is optional; when it is
 * omitted the adapter must target nothing reachable, and the host's apiKey must not be
 * attached to whatever it does try.
 *
 * Every fetch here goes to a recorder that never reaches the network: the stub origin gets a
 * canned registry answer, everything else is refused as a network failure (as an unroutable
 * name would be).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ActivityTemplate, ExecutionTrace } from "../src/ontology";
import type { LLMPort } from "../src/ports";
import { GoalHost, type GoalHostOptions } from "../src/hosts/goal-host";
import {
  ActivityApiAdapter,
  type RecommendRequest,
  type RecommendResponse,
} from "../src/adapters/activity-api-adapter";
import { TraceSinkSpy } from "./fakes";

const API_KEY = "recorder-test-api-key-7f3a";
const STUB_ORIGIN = "http://127.0.0.1:65531";

interface Recorded {
  url: string;
  host: string;
  headers: Record<string, string>;
  body: string;
}

let recorded: Recorded[] = [];
let realFetch: typeof globalThis.fetch;

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers ?? {}).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

beforeEach(() => {
  recorded = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {
      /* unparseable: recorded with empty host */
    }
    recorded.push({ url, host, headers: headersOf(init), body: typeof init?.body === "string" ? init.body : "" });
    if (url.startsWith(STUB_ORIGIN + "/")) {
      return new Response(
        JSON.stringify({ vessels: [{ id: "stub-producer", resolve_endpoint: `${STUB_ORIGIN}/v1/resolve` }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    // Never fall through to the real network.
    throw new TypeError(`recorder: refused ${url}`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

class FakeLLM implements LLMPort {
  async generate(): Promise<string> {
    return "fake";
  }
}

class QuietApi extends ActivityApiAdapter {
  constructor() {
    super(`${STUB_ORIGIN}/activity`, API_KEY, {
      fetch: { request: async () => new Response("", { status: 500 }) },
    });
  }
  override async recommend(_req: RecommendRequest): Promise<RecommendResponse> {
    return { recommendations: [] };
  }
  override async getTemplate(): Promise<ActivityTemplate | null> {
    return null;
  }
  override async recordTrace(_t: ExecutionTrace): Promise<void> {}
}

function makeHost(extra: Partial<GoalHostOptions> = {}): GoalHost {
  return new GoalHost({
    llm: new FakeLLM(),
    activityApiEndpoint: `${STUB_ORIGIN}/activity`,
    apiKey: API_KEY,
    activityApi: new QuietApi(),
    traceSink: new TraceSinkSpy(),
    subscriberTemplates: [],
    ...extra,
  });
}

/** Hosts a request may legitimately name: loopback, the stub, or a reserved unroutable name. */
function isAllowedHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "127.0.0.1" || name === "localhost" || name === "::1" || name.endsWith(".invalid");
}

function carriesKey(r: Recorded): boolean {
  return Object.values(r.headers).some((v) => v.includes(API_KEY)) || r.body.includes(API_KEY) || r.url.includes(API_KEY);
}

describe("GoalHost discovery adapter without discoveryEndpoint", () => {
  test("a lookup names no non-fleet host, carries no apiKey, and fails closed", async () => {
    const host = makeHost();
    let producers: unknown[] | null = null;
    let threw = false;
    try {
      producers = await host.discovery.lookupShapeProducers("vesselCapabilityProbe");
    } catch {
      threw = true;
    }

    const offFleet = recorded.filter((r) => !isAllowedHost(r.host));
    expect(offFleet.map((r) => r.url)).toEqual([]);

    const keyed = recorded.filter((r) => carriesKey(r) && !r.url.startsWith(STUB_ORIGIN + "/"));
    expect(keyed.map((r) => r.url)).toEqual([]);

    // Fails closed: either the documented "unreachable" throw or no producers.
    expect(threw || (Array.isArray(producers) && producers.length === 0)).toBe(true);
  });

  test("the typed lookup reports a failure, not producers", async () => {
    const host = makeHost();
    const r = await host.discovery.lookup("vesselCapabilityProbe");
    expect(r.ok).toBe(false);
    expect(recorded.filter((x) => !isAllowedHost(x.host)).map((x) => x.url)).toEqual([]);
  });
});

describe("GoalHost discovery adapter with discoveryEndpoint (control)", () => {
  test("lookups go to the configured endpoint with the apiKey and return its producers", async () => {
    const host = makeHost({ discoveryEndpoint: STUB_ORIGIN });
    const producers = await host.discovery.lookupShapeProducers("vesselCapabilityProbe");

    expect(producers.map((p) => p.id)).toEqual(["stub-producer"]);
    expect(producers[0]?.resolveEndpoint).toBe(`${STUB_ORIGIN}/v1/resolve`);

    expect(recorded.length).toBe(1);
    expect(recorded[0]?.url).toBe(`${STUB_ORIGIN}/resolve`);
    expect(recorded[0]?.headers["authorization"]).toBe(`ApiKey ${API_KEY}`);
  });
});
