import { afterEach, expect, test } from "bun:test";

import * as mod from "../../src/adapters/vessel-resolver";

type VesselResolverInstance = InstanceType<typeof mod.VesselResolver>;
type ResolverContextArg = Parameters<VesselResolverInstance["resolve"]>[0];

const originalFetch = globalThis.fetch;

function stubResolverResponse(payload: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeContext(): ResolverContextArg {
  return {
    task: { config: {} },
    random: { id: (shape: string) => `${shape}-test` },
  } as unknown as ResolverContextArg;
}

function makeResolver(): VesselResolverInstance {
  return new mod.VesselResolver({
    id: "shell",
    shape: "boundedShellResult",
    resolveEndpoint: "http://local-tools.test/resolve",
    apiKey: "test-key",
  });
}

test("an activity step that exits 5 is recorded as a failed task naming exit_code 5", async () => {
  stubResolverResponse({
    success: true,
    content: {
      shape: "boundedShellResult",
      stdout: "",
      stderr: "guard failed",
      exit_code: 5,
    },
    metadata: { exit_code: 5 },
    exit_code: 5,
  });

  const resolver = makeResolver();

  await expect(resolver.resolve(makeContext())).rejects.toThrow(/exit_code 5/);
});

test("an activity step that exits 0 is recorded as a successful task with its stdout as content", async () => {
  stubResolverResponse({
    success: true,
    content: "hello",
    body: {
      shape: "boundedShellResult",
      stdout: "hello",
      stderr: "",
      exit_code: 0,
    },
    metadata: { exit_code: 0 },
    exit_code: 0,
  });

  const resolver = makeResolver();
  const impulses = await resolver.resolve(makeContext());

  expect(impulses).toHaveLength(1);
  expect(impulses[0]?.content).toBe("hello");
});
