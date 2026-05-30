import { describe, expect, test } from "bun:test";
import { ActivityApiTemplateProvider } from "../src/adapters/activity-api-provider";

/**
 * mapTask + mapTemplate field-preservation tests (2026-05-30).
 *
 * Earlier mapTask stripped inputShapes, outputShapes, retry, outputImpulses
 * (and other catalogue task fields). The engine's iteration, slot-binding,
 * and validation paths read these fields, so silently dropping them caused
 * iteration-by-shape to return zero candidates — observed in
 * ingest-doc-as-concepts (forced a chunking workaround).
 *
 * These tests assert that ActivityApiTemplateProvider preserves shape
 * declarations and downstream-consumed extras.
 */

function mockFetchOnce(body: unknown, ok = true) {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    if (called) throw new Error("fetch called more than once");
    called = true;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("ActivityApiTemplateProvider mapTemplate / mapTask", () => {
  test("preserves task inputShapes (snake_case), outputShapes, retry, outputImpulses", async () => {
    const restore = mockFetchOnce({
      id: "iterate-shape-test",
      name: "iterate-shape-test",
      input_shapes: ["section"],
      output_shapes: ["count"],
      tasks: [
        {
          id: "t1",
          description: "iterate over sections",
          resolver: "iteration",
          input_shapes: ["section"],
          output_shapes: ["section_processed"],
          retry: { max_attempts: 3, strategy: "linear" },
          output_impulses: [{ shape: "section_processed" }],
        },
      ],
    });
    try {
      const provider = new ActivityApiTemplateProvider("http://x", "k");
      const tpl = await provider.getTemplate("iterate-shape-test");
      expect(tpl).not.toBeNull();
      expect(tpl!.inputShapes).toEqual(["section"]);
      expect(tpl!.outputShapes).toEqual(["count"]);
      const t = tpl!.tasks[0]!;
      expect(t.inputShapes).toEqual(["section"]);
      expect(t.outputShapes).toEqual(["section_processed"]);
      expect((t as Record<string, unknown>).retry).toEqual({ max_attempts: 3, strategy: "linear" });
      expect((t as Record<string, unknown>).outputImpulses).toEqual([{ shape: "section_processed" }]);
    } finally {
      restore();
    }
  });

  test("preserves camelCase task fields when API returns them", async () => {
    const restore = mockFetchOnce({
      id: "camel",
      name: "camel",
      tasks: [
        {
          id: "t1",
          description: "d",
          resolver: "llm-prompt",
          inputShapes: [{ shape: "doc", cardinality: "any" }],
          outputShapes: ["concept"],
          outputImpulses: [{ shape: "concept" }],
          prompt: { template: "hi" },
        },
      ],
    });
    try {
      const provider = new ActivityApiTemplateProvider("http://x", "k");
      const tpl = await provider.getTemplate("camel");
      const t = tpl!.tasks[0]!;
      expect(t.inputShapes).toEqual([{ shape: "doc", cardinality: "any" }]);
      expect(t.outputShapes).toEqual(["concept"]);
      expect((t as Record<string, unknown>).outputImpulses).toEqual([{ shape: "concept" }]);
      expect((t as Record<string, unknown>).prompt).toEqual({ template: "hi" });
    } finally {
      restore();
    }
  });

  test("passes through unknown catalogue task fields (validation, dependencies, optional_input_shapes)", async () => {
    const restore = mockFetchOnce({
      id: "extras",
      name: "extras",
      tasks: [
        {
          id: "t1",
          description: "d",
          resolver: "bash",
          validation: { requiredFiles: ["out.json"] },
          dependencies: ["t0"],
          optional_input_shapes: ["hint"],
          conditional: { when: "true" },
        },
      ],
    });
    try {
      const provider = new ActivityApiTemplateProvider("http://x", "k");
      const tpl = await provider.getTemplate("extras");
      const t = tpl!.tasks[0]! as Record<string, unknown>;
      expect(t.validation).toEqual({ requiredFiles: ["out.json"] });
      expect(t.dependencies).toEqual(["t0"]);
      expect(t.optional_input_shapes).toEqual(["hint"]);
      expect(t.conditional).toEqual({ when: "true" });
    } finally {
      restore();
    }
  });

  test("preserves template-level subscription / tags / metadata / variables", async () => {
    const restore = mockFetchOnce({
      id: "lifecycle-sub",
      name: "lifecycle-sub",
      input_shapes: ["seed"],
      output_shapes: ["result"],
      tags: ["audit"],
      metadata: { auditDepthCap: 2 },
      variables: [{ name: "x", type: "string" }],
      subscription: { shape: "lifecycle:execution:succeeded" },
      tasks: [],
    });
    try {
      const provider = new ActivityApiTemplateProvider("http://x", "k");
      const tpl = await provider.getTemplate("lifecycle-sub") as Record<string, unknown>;
      expect(tpl.tags).toEqual(["audit"]);
      expect(tpl.metadata).toEqual({ auditDepthCap: 2 });
      expect(tpl.variables).toEqual([{ name: "x", type: "string" }]);
      expect(tpl.subscription).toEqual({ shape: "lifecycle:execution:succeeded" });
    } finally {
      restore();
    }
  });
});
