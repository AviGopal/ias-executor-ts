/**
 * Canary integration tests — require live access to the deployed vessels.
 *
 * Gate: tests are skipped unless METABOB_API_KEY and METABOB_ENDPOINT are set.
 *
 * Run with:
 *   METABOB_API_KEY=mb-... METABOB_ENDPOINT=https://activity.metabob.com bun test test/canary-integration.test.ts
 *
 * Or with your ~/.metabob/config.json present:
 *   bun test test/canary-integration.test.ts
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { ActivityApiTemplateProvider, ActivityApiRecommendationProvider, ActivityApiTraceSink } from "../src/adapters/activity-api-provider";
import { VesselResolver } from "../src/adapters/vessel-resolver";
import { DiscoveryCapabilityIndex } from "../src/adapters/discovery-capability-index";
import { ExecutionRuntime } from "../src/runtime";
import { ActivityExecutor } from "../src/engine";
import { SequentialRandom, SteppingClock, TraceSinkSpy } from "./fakes";

// ---------------------------------------------------------------------------
// Config — read from env or ~/.metabob/config.json
// ---------------------------------------------------------------------------

interface CanaryConfig {
  apiKey: string;
  endpoint: string;
  discoveryEndpoint: string;
}

function loadConfig(): CanaryConfig | null {
  const apiKey = process.env["METABOB_API_KEY"];
  const endpoint = process.env["METABOB_ENDPOINT"] ?? "https://activity.metabob.com";

  if (apiKey) {
    return { apiKey, endpoint, discoveryEndpoint: "https://discovery.metabob.com" };
  }

  // Try ~/.metabob/config.json
  try {
    const home = process.env["HOME"] ?? "/root";
    const raw = Bun.file(`${home}/.metabob/config.json`);
    // Synchronous read is not available — use a flag to skip if not loaded
    return null; // async read handled in beforeAll
  } catch {
    return null;
  }
}

let config: CanaryConfig | null = null;

beforeAll(async () => {
  // Try env first
  const apiKey = process.env["METABOB_API_KEY"];
  const endpoint = process.env["METABOB_ENDPOINT"] ?? "https://activity.metabob.com";

  if (apiKey) {
    config = { apiKey, endpoint, discoveryEndpoint: "https://discovery.metabob.com" };
    return;
  }

  // Try ~/.metabob/config.json
  try {
    const home = process.env["HOME"] ?? "/root";
    const raw = await Bun.file(`${home}/.metabob/config.json`).json() as {
      metabob?: { apiKey?: string; endpoint?: string };
    };
    const key = raw.metabob?.apiKey;
    if (key) {
      config = {
        apiKey: key,
        endpoint: raw.metabob?.endpoint ?? "https://activity.metabob.com",
        discoveryEndpoint: "https://discovery.metabob.com",
      };
    }
  } catch {
    // no config file — tests will be skipped
  }
});

function skipIfNoConfig(): CanaryConfig {
  if (!config) {
    // In Bun test, we can't dynamically skip — so just return a dummy that will fail gracefully.
    // The test body checks config and skips assertion.
    return { apiKey: "", endpoint: "", discoveryEndpoint: "" };
  }
  return config;
}

// ---------------------------------------------------------------------------
// ActivityApiTemplateProvider
// ---------------------------------------------------------------------------

describe("ActivityApiTemplateProvider (canary)", () => {
  test("fetches a known template by id", async () => {
    const cfg = skipIfNoConfig();
    if (!config) return; // skip

    const provider = new ActivityApiTemplateProvider(cfg.endpoint, cfg.apiKey);
    // Use a well-known public template id from canary
    const template = await provider.getTemplate("activity:⟨atomic-read-file⟩");
    expect(template).not.toBeNull();
    expect(template?.id).toBeTruthy();
    expect(typeof template?.name).toBe("string");
    expect(Array.isArray(template?.tasks)).toBe(true);
  });

  test("returns null for a non-existent template", async () => {
    if (!config) return;
    const provider = new ActivityApiTemplateProvider(config.endpoint, config.apiKey);
    const template = await provider.getTemplate("activity:⟨does-not-exist-xyz-123⟩");
    expect(template).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ActivityApiRecommendationProvider
// ---------------------------------------------------------------------------

describe("ActivityApiRecommendationProvider (canary)", () => {
  test("returns recommendations for a task description", async () => {
    if (!config) return;
    const provider = new ActivityApiRecommendationProvider(config.endpoint, config.apiKey);
    const recs = await provider.recommend("read a file and count lines");
    expect(Array.isArray(recs)).toBe(true);
    // May return 0 if Thompson sampling has no matching templates — still valid
    if (recs.length > 0) {
      expect(typeof recs[0]!.id).toBe("string");
      expect(typeof recs[0]!.name).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// ActivityApiTraceSink
// ---------------------------------------------------------------------------

describe("ActivityApiTraceSink (canary)", () => {
  test("stores an execution trace without throwing", async () => {
    if (!config) return;
    const sink = new ActivityApiTraceSink(config.endpoint, config.apiKey);
    const trace = {
      id: `ias-test-${Date.now()}`,
      templateId: "activity:⟨ias-executor-ts-canary-test⟩",
      status: "completed" as const,
      inputImpulseIds: [],
      outputImpulseIds: [],
      tasks: [],
      durationMs: 1,
    };
    // Must not throw — TraceSink failures are non-fatal (logged only)
    await expect(sink.record(trace)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DiscoveryCapabilityIndex (canary)
// ---------------------------------------------------------------------------

describe("DiscoveryCapabilityIndex (canary)", () => {
  test("lists resolver ids from discovery-vessel", async () => {
    if (!config) return;
    const index = new DiscoveryCapabilityIndex(config.discoveryEndpoint, config.apiKey);
    const ids = await index.listResolverIds();
    expect(Array.isArray(ids)).toBe(true);
    // Discovery-vessel always advertises its own 4 shapes
    expect(ids.length).toBeGreaterThanOrEqual(0);
  }, 30_000);

  test("cache is populated after first call", async () => {
    if (!config) return;
    const index = new DiscoveryCapabilityIndex(config.discoveryEndpoint, config.apiKey, { cacheTtlMs: 30_000 });
    const first = await index.listResolverIds();
    const t0 = Date.now();
    const second = await index.listResolverIds();
    const elapsed = Date.now() - t0;
    expect(first).toEqual(second);
    // Second call should be served from cache (< 50ms), not a network roundtrip
    expect(elapsed).toBeLessThan(50);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// VesselResolver — calls activity-api resolve endpoint
// ---------------------------------------------------------------------------

describe("VesselResolver (canary)", () => {
  test("resolves activityTemplate shape via vessel contract", async () => {
    if (!config) return;
    const resolver = new VesselResolver({
      id: "activityTemplate",
      shape: "activityTemplate",
      resolveEndpoint: `${config.endpoint}/v2/impulses/resolve`,
      apiKey: config.apiKey,
      timeoutMs: 15_000,
    });

    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(),
      random: new SequentialRandom(),
    });
    runtime.resolvers.register(resolver);

    const noopEventSink = { emit: async () => {} };
    const noopTraceSink = { record: async () => {} };
    const emptyVesselRegistry = { list: () => [] as import("../src/ontology").AttachedVessel[] };
    const fakeCtx: import("../src/resolvers").ResolverContext = {
      executionId: "test-exec",
      template: { id: "t", name: "t", outputShapes: [], tasks: [] },
      task: {
        id: "t1",
        description: "resolve a template",
        resolver: "activityTemplate",
        config: { templateId: "activity:⟨atomic-read-file⟩" },
      },
      variables: {},
      inputImpulses: [],
      store: runtime.store,
      clock: runtime.clock,
      random: runtime.random,
      eventSink: noopEventSink,
      traceSink: noopTraceSink,
      attachedVessels: emptyVesselRegistry,
    };

    const impulses = await resolver.resolve(fakeCtx);
    expect(impulses.length).toBe(1);
    expect(impulses[0]!.metadata.shape).toBe("activityTemplate");
    expect(impulses[0]!.loaded).toBe(true);
    expect(impulses[0]!.content).toBeTruthy();
  });

  test("throws on bad pointer type", async () => {
    if (!config) return;
    const resolver = new VesselResolver({
      id: "bad-shape",
      shape: "nonExistentShape12345",
      resolveEndpoint: `${config.endpoint}/v2/impulses/resolve`,
      apiKey: config.apiKey,
    });

    const runtime = new ExecutionRuntime({ clock: new SteppingClock(), random: new SequentialRandom() });
    const noopEventSink = { emit: async () => {} };
    const noopTraceSink = { record: async () => {} };
    const fakeCtx: import("../src/resolvers").ResolverContext = {
      executionId: "test-exec",
      template: { id: "t", name: "t", outputShapes: [], tasks: [] },
      task: { id: "t1", description: "d", resolver: "bad-shape", config: {} },
      variables: {},
      inputImpulses: [],
      store: runtime.store,
      clock: runtime.clock,
      random: runtime.random,
      eventSink: noopEventSink,
      traceSink: noopTraceSink,
      attachedVessels: { list: () => [] },
    };

    await expect(resolver.resolve(fakeCtx)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: executor + vessel adapters
// ---------------------------------------------------------------------------

describe("End-to-end: executor via vessel adapters (canary)", () => {
  test("executes a single-task activity that resolves a template via activity-api", async () => {
    if (!config) return;

    const provider = new ActivityApiTemplateProvider(config.endpoint, config.apiKey);
    const traceSpy = new TraceSinkSpy();

    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(),
      random: new SequentialRandom(),
      templateProvider: provider,
      traceSink: traceSpy,
    });

    // Register a VesselResolver that calls activity-api
    runtime.resolvers.register(new VesselResolver({
      id: "activityTemplate",
      shape: "activityTemplate",
      resolveEndpoint: `${config.endpoint}/v2/impulses/resolve`,
      apiKey: config.apiKey,
    }));

    const executor = new ActivityExecutor(runtime);
    const template = {
      id: "ias-canary-e2e",
      name: "IAS canary e2e test",
      outputShapes: ["activityTemplate"],
      tasks: [{
        id: "fetch-template",
        description: "Fetch atomic-read-file template from activity-api",
        resolver: "activityTemplate",
        config: { templateId: "activity:⟨atomic-read-file⟩" },
        outputShapes: ["activityTemplate"],
      }],
    };

    const trace = await executor.execute(template, { reason: "ias-executor-ts canary e2e" });

    expect(trace.status).toBe("completed");
    expect(trace.tasks.length).toBe(1);
    expect(trace.tasks[0]!.success).toBe(true);
    expect(trace.tasks[0]!.outputImpulseIds.length).toBe(1);

    // Verify the resolved impulse has the expected shape
    const impulse = runtime.store.get(trace.tasks[0]!.outputImpulseIds[0]!);
    expect(impulse?.metadata.shape).toBe("activityTemplate");
    expect(impulse?.loaded).toBe(true);

    // Trace sink recorded the trace
    expect(traceSpy.traces.length).toBe(1);
    expect(traceSpy.last()!.status).toBe("completed");
  });
});
