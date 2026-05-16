import { describe, test, expect } from "bun:test";
import { createBunServerBundle } from "../src/bundles/bun-server";
import { StaticCapabilityIndex } from "../src/adapters/discovery-capability-index";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock } from "./fakes";

// ---------------------------------------------------------------------------
// Stub LLMPort
// ---------------------------------------------------------------------------

function makeLLM(response = "hello"): { generate: (input: { prompt: string }) => Promise<string> } {
  return { async generate() { return response; } };
}

// ---------------------------------------------------------------------------
// createBunServerBundle — structural tests (no real I/O)
// ---------------------------------------------------------------------------

describe("createBunServerBundle", () => {
  test("returns a CapabilityBundle with vessels", () => {
    const bundle = createBunServerBundle();
    expect(Array.isArray(bundle.vessels)).toBe(true);
    expect(bundle.vessels.length).toBeGreaterThanOrEqual(2);
  });

  test("includes bun-fs and bun-proc vessels without LLM option", () => {
    const bundle = createBunServerBundle();
    const ids = bundle.vessels.map((v) => v.id);
    expect(ids).toContain("bun-fs");
    expect(ids).toContain("bun-proc");
    expect(ids).not.toContain("llm-vessel");
  });

  test("includes llm-vessel when LLM port provided", () => {
    const bundle = createBunServerBundle({ llm: makeLLM() });
    const ids = bundle.vessels.map((v) => v.id);
    expect(ids).toContain("llm-vessel");
  });

  test("applyTo registers resolvers on runtime", () => {
    const bundle = createBunServerBundle();
    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(),
      random: new SequentialRandom(),
      attachedVessels: bundle.vessels,
    });
    bundle.applyTo(runtime);
    expect(runtime.resolvers.get("file-read")).toBeDefined();
    expect(runtime.resolvers.get("bash")).toBeDefined();
    expect(runtime.resolvers.get("llm")).toBeUndefined();
  });

  test("applyTo registers llm resolver when LLM port provided", () => {
    const bundle = createBunServerBundle({ llm: makeLLM() });
    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(),
      random: new SequentialRandom(),
      attachedVessels: bundle.vessels,
    });
    bundle.applyTo(runtime);
    expect(runtime.resolvers.get("llm")).toBeDefined();
  });

  test("file-read vessel advertises file-read resolver", () => {
    const bundle = createBunServerBundle();
    const fsVessel = bundle.vessels.find((v) => v.id === "bun-fs");
    expect(fsVessel?.resolverIds).toContain("file-read");
  });

  test("bun-proc vessel advertises bash resolver", () => {
    const bundle = createBunServerBundle();
    const procVessel = bundle.vessels.find((v) => v.id === "bun-proc");
    expect(procVessel?.resolverIds).toContain("bash");
  });

  test("applyTo can be called multiple times idempotently", () => {
    const bundle = createBunServerBundle();
    const runtime = new ExecutionRuntime({
      clock: new SteppingClock(),
      random: new SequentialRandom(),
    });
    bundle.applyTo(runtime);
    bundle.applyTo(runtime);
    expect(runtime.resolvers.get("file-read")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// StaticCapabilityIndex
// ---------------------------------------------------------------------------

describe("StaticCapabilityIndex", () => {
  test("returns the provided ids", async () => {
    const index = new StaticCapabilityIndex(["bash", "file-read", "llm"]);
    const ids = await index.listResolverIds();
    expect(ids).toEqual(["bash", "file-read", "llm"]);
  });

  test("returns a copy, not the original array", async () => {
    const original = ["bash"];
    const index = new StaticCapabilityIndex(original);
    const ids = await index.listResolverIds();
    ids.push("mutated");
    expect(await index.listResolverIds()).toEqual(["bash"]);
  });

  test("returns empty list when constructed with no ids", async () => {
    const index = new StaticCapabilityIndex([]);
    const ids = await index.listResolverIds();
    expect(ids).toEqual([]);
  });

  test("multiple calls return the same ids", async () => {
    const index = new StaticCapabilityIndex(["a", "b"]);
    expect(await index.listResolverIds()).toEqual(["a", "b"]);
    expect(await index.listResolverIds()).toEqual(["a", "b"]);
  });
});
