/**
 * GoalHost wiring demo.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §G (this
 * demonstrates the composition pattern end-to-end without requiring a live
 * canary).
 *
 * The script:
 *   1. Reads ANTHROPIC_API_KEY, METABOB_API_KEY, ACTIVITY_API_URL from env
 *      (all optional — when ANTHROPIC_API_KEY is missing we install a stub
 *      LLMPort so the host still constructs).
 *   2. Constructs a GoalHost.
 *   3. Calls `runGoal` with `targetTemplateId` set — bypasses the recommend
 *      step so the demo runs offline.
 *   4. Prints the trace id + selected template.
 *
 * Run:
 *   bun run repos/ias-executor-ts/src/examples/goal-host-demo.ts
 */

import { GoalHost } from "./goal-host";
import type { LLMPort } from "../ports";
import type { ActivityTemplate } from "../ontology";

class StubLLM implements LLMPort {
  async generate(_input: { prompt: string }): Promise<string> {
    return "[stub LLM response — set ANTHROPIC_API_KEY for real generation]";
  }
}

class AnthropicLLM implements LLMPort {
  private readonly model = process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";
  constructor(private readonly apiKey: string) {}
  async generate(input: { prompt: string; systemPrompt?: string }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: "user", content: input.prompt }],
    };
    if (input.systemPrompt) body.system = input.systemPrompt;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
    return data.content.find((c) => c.type === "text")?.text ?? "";
  }
}

/** Inline minimal template — sidesteps the need for a live canary or
 *  recommend response. Demonstrates that the host can run a template that
 *  isn't in SHARED_TEMPLATES by registering it on the local catalogue. */
const DEMO_TEMPLATE: ActivityTemplate = {
  id: "goal-host-demo-echo",
  name: "GoalHost Demo — Echo",
  description: "Single bash task — proves end-to-end wiring.",
  outputShapes: ["commandResult"],
  tasks: [
    {
      id: "echo",
      description: "echo hello world",
      resolver: "bash",
      config: { command: ["echo", "hello from goal-host"] },
      outputShapes: ["commandResult"],
    },
  ],
};

async function main(): Promise<void> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const metabobKey = process.env.METABOB_API_KEY ?? "demo-key";
  const activityApi = process.env.ACTIVITY_API_URL ?? "https://activity.metabob.com";

  const llm: LLMPort = anthropicKey ? new AnthropicLLM(anthropicKey) : new StubLLM();

  console.log("[goal-host-demo] constructing GoalHost...");
  console.log(`[goal-host-demo]   activity_api = ${activityApi}`);
  console.log(`[goal-host-demo]   llm          = ${anthropicKey ? "anthropic" : "stub"}`);

  const host = new GoalHost({
    llm,
    activityApiEndpoint: activityApi,
    apiKey: metabobKey,
  });
  host.catalogue.register(DEMO_TEMPLATE);

  const capabilities = await host.listCapabilities();
  console.log(`[goal-host-demo] capabilities: ${capabilities.map((c) => c.id).join(", ")}`);

  console.log("[goal-host-demo] running goal with targetTemplateId='goal-host-demo-echo'...");
  const result = await host.runGoal("demo: say hello", {
    targetTemplateId: "goal-host-demo-echo",
  });

  console.log(`[goal-host-demo] trace id              = ${result.trace.id}`);
  console.log(`[goal-host-demo] trace status          = ${result.trace.status}`);
  console.log(`[goal-host-demo] selected template id  = ${result.selectedTemplateId}`);
  console.log(`[goal-host-demo] tasks                 = ${result.trace.tasks.length}`);
  console.log("[goal-host-demo] done.");
}

main().catch((err) => {
  console.error("[goal-host-demo] FATAL:", err);
  process.exit(1);
});
