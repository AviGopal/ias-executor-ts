/**
 * Phase 22 — Forge Resolver Unit Tests
 *
 * Tests each deterministic forge resolver against fake ports. The LLM-tier
 * resolvers (scaffold_vessel_skeleton, wire_discovery_registration,
 * wire_auth_blueprint) are structural/registration checks only — their LLM
 * generation path is covered separately by the canary acceptance tests.
 */

import { describe, expect, test } from "bun:test";
import type { DockerPort, DiscoveryPort, FetchPort, HelmfilePort, VesselSummary } from "../src/ports";
import type { FileSystemPort } from "../src/ports";
import type { ResolverContext } from "../src/resolvers";
import type { ActivityTask, ActivityTemplate, Impulse } from "../src/ontology";
import { makeDockerBuildPushResolver } from "../src/resolvers/docker-build-push";
import { makeHelmfileSyncResolver } from "../src/resolvers/helmfile-sync";
import { makeVerifyThreeInvariantsResolver } from "../src/resolvers/verify-three-invariants";
import { SequentialRandom, SteppingClock, EventSinkSpy, TraceSinkSpy } from "./fakes";

// ---------------------------------------------------------------------------
// Fake ports
// ---------------------------------------------------------------------------

class FakeDockerPort implements DockerPort {
  built: Array<{ contextPath: string; tag: string }> = [];
  pushed: string[] = [];
  failOnPush = false;

  async build(contextPath: string, tag: string): Promise<void> {
    this.built.push({ contextPath, tag });
  }

  async push(tag: string): Promise<void> {
    if (this.failOnPush) throw new Error("registry unavailable");
    this.pushed.push(tag);
  }
}

class FakeHelmfilePort implements HelmfilePort {
  overlaysApplied: string[] = [];
  releasesWaited: string[] = [];
  failOnApply = false;

  async applyOverlay(overlayPath: string): Promise<void> {
    if (this.failOnApply) throw new Error("helmfile sync failed");
    this.overlaysApplied.push(overlayPath);
  }

  async waitForReady(release: string, _namespace: string, _timeoutMs: number): Promise<void> {
    this.releasesWaited.push(release);
  }
}

class FakeFileSystemPort implements FileSystemPort {
  files = new Map<string, string>();

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (!content) throw new Error(`File not found: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
}

class FakeDiscoveryPort implements DiscoveryPort {
  producers: VesselSummary[] = [];
  registered: Array<{ id: string; shapes: string[] }> = [];

  async lookupShapeProducers(_shape: string): Promise<VesselSummary[]> {
    return this.producers;
  }

  async registerVessel(payload: { id: string; shapes: string[]; resolveEndpoint: string }): Promise<void> {
    this.registered.push({ id: payload.id, shapes: payload.shapes });
  }
}

class FakeFetchPort implements FetchPort {
  responses: Map<string, { status: number; body?: unknown }> = new Map();

  setResponse(urlFragment: string, status: number, body?: unknown): void {
    this.responses.set(urlFragment, { status, body });
  }

  async request(input: string, init?: RequestInit): Promise<Response> {
    for (const [fragment, { status, body }] of this.responses) {
      if (input.includes(fragment)) {
        const text = body !== undefined ? JSON.stringify(body) : "";
        return new Response(text, { status });
      }
    }
    // Default: 404
    return new Response("not found", { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeImpulse(shape: string, content: unknown): Impulse {
  return {
    id: `test-${shape}`,
    pointer: { type: "memo" },
    metadata: { shape, summary: shape },
    loaded: true,
    content,
  };
}

const STUB_TEMPLATE: ActivityTemplate = {
  id: "t",
  name: "test",
  description: "test",
  output_shapes: [],
  tasks: [],
};

const STUB_TASK: ActivityTask = {
  id: "task",
  description: "test task",
  resolver: "test",
};

function makeContext(
  inputImpulses: Impulse[],
  variables: Record<string, unknown> = {},
): ResolverContext {
  return {
    executionId: "exec-test",
    template: STUB_TEMPLATE,
    task: STUB_TASK,
    variables,
    inputImpulses,
    store: { get: async () => undefined, put: async () => {}, list: async () => [] } as any,
    clock: new SteppingClock(1_000_000, 1000),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
    traceSink: new TraceSinkSpy(),
    attachedVessels: { get: () => undefined, list: () => [] } as any,
  };
}

// ---------------------------------------------------------------------------
// docker_build_push
// ---------------------------------------------------------------------------

describe("docker_build_push resolver", () => {
  test("builds and pushes image; emits vesselImagePushed with expected tag shape", async () => {
    const docker = new FakeDockerPort();
    const resolver = makeDockerBuildPushResolver(docker);

    const ctx = makeContext([
      makeImpulse("vesselWithAuth", { path: "/tmp/forge_abc123" }),
      makeImpulse("vesselSpec", { shape: "json_schema_validator" }),
    ]);

    const output = await resolver.resolve(ctx);

    expect(docker.built).toHaveLength(1);
    expect(docker.built[0].contextPath).toBe("/tmp/forge_abc123");
    // Tag must be metabobapp/forge-{shape}-{uuid}:{timestamp}
    const tag = docker.built[0].tag;
    expect(tag).toMatch(/^metabobapp\/forge-json_schema_validator-/);

    expect(docker.pushed).toHaveLength(1);
    expect(docker.pushed[0]).toBe(tag);

    expect(output).toHaveLength(1);
    expect(output[0].metadata.shape).toBe("vesselImagePushed");
    expect((output[0].content as any).imageUri).toBe(tag);
  });

  test("returns failure_mode impulse on push failure (does not throw)", async () => {
    const docker = new FakeDockerPort();
    docker.failOnPush = true;
    const resolver = makeDockerBuildPushResolver(docker);

    const ctx = makeContext([
      makeImpulse("vesselWithAuth", { path: "/tmp/forge_abc" }),
      makeImpulse("vesselSpec", { shape: "some_shape" }),
    ]);

    const output = await resolver.resolve(ctx);

    expect(output).toHaveLength(1);
    expect(output[0].metadata.shape).toBe("failure_mode");
    const fm = (output[0].content as any).failure_mode;
    expect(fm.type).toBe("verifier_negative");
    expect(fm.reason).toBe("docker_push_failed");
  });

  test("throws (not failure_mode) when vesselWithAuth impulse is missing", async () => {
    const docker = new FakeDockerPort();
    const resolver = makeDockerBuildPushResolver(docker);
    const ctx = makeContext([makeImpulse("vesselSpec", { shape: "x" })]);
    await expect(resolver.resolve(ctx)).rejects.toThrow("vesselWithAuth");
  });

  test("throws when vesselSpec impulse is missing", async () => {
    const docker = new FakeDockerPort();
    const resolver = makeDockerBuildPushResolver(docker);
    const ctx = makeContext([makeImpulse("vesselWithAuth", { path: "/tmp/x" })]);
    await expect(resolver.resolve(ctx)).rejects.toThrow("vesselSpec");
  });
});

// ---------------------------------------------------------------------------
// helmfile_sync
// ---------------------------------------------------------------------------

describe("helmfile_sync resolver", () => {
  test("writes overlay file, syncs, waits; emits vesselDeployedToCanary", async () => {
    const fs = new FakeFileSystemPort();
    const helm = new FakeHelmfilePort();
    const resolver = makeHelmfileSyncResolver(fs, helm);

    const ctx = makeContext(
      [
        makeImpulse("vesselImagePushed", { imageUri: "metabobapp/forge-xshape-uid:1000" }),
        makeImpulse("vesselSpec", { shape: "xshape" }),
      ],
      { workingDirectory: "/workspace" },
    );

    const output = await resolver.resolve(ctx);

    // Overlay written
    expect(fs.files.size).toBe(1);
    const [overlayPath, overlayContent] = [...fs.files.entries()][0];
    expect(overlayPath).toContain("forged-vessels/forge-xshape-");
    expect(overlayContent).toContain("forge-xshape");
    expect(overlayContent).toContain("metabobapp/forge-xshape-uid");
    expect(overlayContent).toContain("1000");

    // Helmfile applied
    expect(helm.overlaysApplied).toHaveLength(1);
    expect(helm.overlaysApplied[0]).toBe(overlayPath);

    // Release waited
    expect(helm.releasesWaited[0]).toBe("forge-xshape");

    // Output
    expect(output).toHaveLength(1);
    expect(output[0].metadata.shape).toBe("vesselDeployedToCanary");
    const { endpoint } = output[0].content as { endpoint: string };
    expect(endpoint).toContain("forge-xshape");
  });

  test("propagates helmfile failure", async () => {
    const fs = new FakeFileSystemPort();
    const helm = new FakeHelmfilePort();
    helm.failOnApply = true;
    const resolver = makeHelmfileSyncResolver(fs, helm);

    const ctx = makeContext([
      makeImpulse("vesselImagePushed", { imageUri: "metabobapp/forge-y:1" }),
      makeImpulse("vesselSpec", { shape: "y" }),
    ]);

    await expect(resolver.resolve(ctx)).rejects.toThrow("helmfile sync failed");
  });

  test("throws when vesselImagePushed is missing", async () => {
    const resolver = makeHelmfileSyncResolver(new FakeFileSystemPort(), new FakeHelmfilePort());
    const ctx = makeContext([makeImpulse("vesselSpec", { shape: "z" })]);
    await expect(resolver.resolve(ctx)).rejects.toThrow("vesselImagePushed");
  });
});

// ---------------------------------------------------------------------------
// verify_three_invariants
// ---------------------------------------------------------------------------

describe("verify_three_invariants resolver", () => {
  function makePassingFetch(): FakeFetchPort {
    const fetch = new FakeFetchPort();
    fetch.setResponse("/health", 200, { status: "healthy" });
    // unauthed → 401, authed → 200
    fetch.setResponse("/v2/impulses/resolve", 200);
    return fetch;
  }

  test("all three probes pass → vesselVerified impulse", async () => {
    const discovery = new FakeDiscoveryPort();
    discovery.producers = [{ id: "forge-1", resolveEndpoint: "http://forge-1:8080" }];

    const fetch = new FakeFetchPort();
    // unauthenticated → 401, authenticated → 200
    // We need to differentiate based on header — use the simpler approach:
    // first call has no Authorization header → 401, second has header → 200
    let calls = 0;
    fetch.request = async (input: string, init?: RequestInit) => {
      if (input.includes("/health")) return new Response("{}", { status: 200 });
      // /v2/impulses/resolve
      calls++;
      if (!init?.headers || !(init.headers as Record<string, string>)["Authorization"]) {
        return new Response("", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    };

    const resolver = makeVerifyThreeInvariantsResolver(discovery, fetch);
    const ctx = makeContext([
      makeImpulse("vesselDeployedToCanary", { endpoint: "http://forge-1:8080" }),
      makeImpulse("vesselSpec", { shape: "json_schema_validator" }),
    ]);

    const output = await resolver.resolve(ctx);
    expect(output).toHaveLength(1);
    expect(output[0].metadata.shape).toBe("vesselVerified");
    const content = output[0].content as any;
    expect(content.shape).toBe("json_schema_validator");
    expect(content.probeResults).toHaveLength(3);
    expect(content.probeResults.every((p: any) => p.passed)).toBe(true);
  });

  test("discovery probe failure → vesselVerified is failure_mode with failed probe names", async () => {
    const discovery = new FakeDiscoveryPort();
    // No producers registered

    const fetch = new FakeFetchPort();
    fetch.request = async (input: string, init?: RequestInit) => {
      if (input.includes("/health")) return new Response("{}", { status: 200 });
      if (!(init?.headers as Record<string, string> | undefined)?.["Authorization"]) {
        return new Response("", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    };

    const resolver = makeVerifyThreeInvariantsResolver(discovery, fetch);
    const ctx = makeContext([
      makeImpulse("vesselDeployedToCanary", { endpoint: "http://forge-2:8080" }),
      makeImpulse("vesselSpec", { shape: "missing_shape" }),
    ]);

    const output = await resolver.resolve(ctx);
    expect(output).toHaveLength(1);
    expect(output[0].metadata.shape).toBe("failure_mode");
    const fm = (output[0].content as any).failure_mode;
    expect(fm.type).toBe("verifier_negative");
    const failedProbes: string[] = fm.context.failedProbes.map((p: any) => p.probe);
    expect(failedProbes).toContain("discovery");
  });

  test("auth probe: unauth returning non-401 → failure_mode", async () => {
    const discovery = new FakeDiscoveryPort();
    discovery.producers = [{ id: "f", resolveEndpoint: "http://f:8080" }];

    const fetch = new FakeFetchPort();
    fetch.request = async (input: string) => {
      if (input.includes("/health")) return new Response("{}", { status: 200 });
      // /resolve always returns 200 (auth not enforced) → probe should fail
      return new Response("{}", { status: 200 });
    };

    const resolver = makeVerifyThreeInvariantsResolver(discovery, fetch);
    const ctx = makeContext([
      makeImpulse("vesselDeployedToCanary", { endpoint: "http://f:8080" }),
      makeImpulse("vesselSpec", { shape: "s" }),
    ]);

    const output = await resolver.resolve(ctx);
    expect(output[0].metadata.shape).toBe("failure_mode");
    const fm = (output[0].content as any).failure_mode;
    expect(fm.context.failedProbes.some((p: any) => p.probe === "auth")).toBe(true);
  });

  test("throws when vesselDeployedToCanary impulse is missing", async () => {
    const resolver = makeVerifyThreeInvariantsResolver(new FakeDiscoveryPort(), new FakeFetchPort());
    const ctx = makeContext([makeImpulse("vesselSpec", { shape: "x" })]);
    await expect(resolver.resolve(ctx)).rejects.toThrow("vesselDeployedToCanary");
  });

  test("throws when vesselSpec impulse is missing", async () => {
    const resolver = makeVerifyThreeInvariantsResolver(new FakeDiscoveryPort(), new FakeFetchPort());
    const ctx = makeContext([makeImpulse("vesselDeployedToCanary", { endpoint: "http://x" })]);
    await expect(resolver.resolve(ctx)).rejects.toThrow("vesselSpec");
  });
});

// ---------------------------------------------------------------------------
// Resolver registration: VesselForgeHost exposes expected resolver IDs
// ---------------------------------------------------------------------------

describe("VesselForgeHost resolver registration", () => {
  test("VesselForgeHost registers all 6 expected forge resolver IDs", async () => {
    const { VesselForgeHost } = await import("../src/examples/vessel-forge-host");
    const host = new VesselForgeHost({
      discoveryEndpoint: "http://discovery:8080",
    });
    // Access via host.runtime.resolvers.list()
    const runtime = (host as any).runtime;
    const registeredIds: string[] = runtime.resolvers.list();
    const expected = [
      "scaffold_vessel_skeleton",
      "wire_discovery_registration",
      "wire_auth_blueprint",
      "docker_build_push",
      "helmfile_sync",
      "verify_three_invariants",
    ];
    for (const id of expected) {
      expect(registeredIds).toContain(id);
    }
  });
});
