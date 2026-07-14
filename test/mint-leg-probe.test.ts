/** Temp probe: pointerFromImpulseSlots through the executor. */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { makeImpulseResolveResolver } from "../src/resolvers/impulse-resolve";
import type { ActivityTemplate } from "../src/ontology";
import type { Resolver } from "../src/resolvers";

const producer: Resolver = {
  id: "fake-llm",
  tier: "pattern",
  async resolve(ctx: any) {
    return [{
      id: ctx.random.id("fake"),
      pointer: { type: "memo" },
      metadata: { shape: "llm_completion_dispatch" },
      loaded: true,
      content: "```json\n{\"id\":\"probe-tmpl\",\"name\":\"Probe\",\"tasks\":[]}\n```",
    }];
  },
};

describe("pointerFromImpulseSlots", () => {
  test("write task receives parsed slot content in pointer", async () => {
    let captured: any = null;
    const origFetch = globalThis.fetch;
    // @ts-expect-error probe stub
    globalThis.fetch = async (url: any, init: any) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: { id: "activity:probe" } }), { status: 200 });
    };
    try {
      const runtime = new ExecutionRuntime();
      runtime.resolvers.register(producer);
      runtime.resolvers.register(makeImpulseResolveResolver({ activityApiEndpoint: "http://fake", activityApiKey: "k" }));
      const executor = new ActivityExecutor(runtime);
      const template: ActivityTemplate = {
        id: "probe", name: "Probe",
        tasks: [
          { id: "synth", description: "p", resolver: "fake-llm", outputImpulses: ["extracted_template"] },
          { id: "write", description: "w", resolver: "impulse-resolve",
            inputImpulses: ["extracted_template"], dependencies: ["synth"],
            config: { pointer: { type: "activityTemplate_write", operation: "create" },
                      pointerFromImpulseSlots: { templateData: "extracted_template" } } },
        ],
      };
      const trace = await executor.execute(template, {});
      const rec = trace.tasks.find((t) => t.taskId === "write");
      console.log("write task:", JSON.stringify(rec));
      expect(rec?.success).toBe(true);
      expect(captured?.pointer?.templateData?.id).toBe("probe-tmpl");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
