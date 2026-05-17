/**
 * wire_discovery_registration resolver — Phase 22
 *
 * Tier: llm
 * Reads the scaffold's src/index.ts, fetches vessel_discovery_probe concepts
 * from concept-db, then uses the LLM to inject a non-blocking discovery
 * registration + 60s heartbeat pattern (per TYPESCRIPT_VESSEL_TEMPLATE.md).
 *
 * Inputs (impulses):  vesselScaffold { path }
 * Config:             conceptDbEndpoint
 * Outputs:            vesselWithDiscovery { path }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { FileSystemPort, FetchPort, LLMPort } from "../ports";
import type { Impulse } from "../ontology";

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

export function makeWireDiscoveryRegistrationResolver(
  fs: FileSystemPort,
  fetch: FetchPort,
  llm: LLMPort,
): Resolver {
  return {
    id: "wire_discovery_registration",
    tier: "llm",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const conceptDbEndpoint = context.task.config?.["conceptDbEndpoint"];
      if (typeof conceptDbEndpoint !== "string") {
        throw new Error("wire_discovery_registration requires task.config.conceptDbEndpoint");
      }

      const scaffoldImpulse = findImpulseByShape(context.inputImpulses, "vesselScaffold");
      if (!scaffoldImpulse?.content) {
        throw new Error("wire_discovery_registration requires a vesselScaffold impulse");
      }
      const scaffold = scaffoldImpulse.content as { path: string };

      // 1. Read current src/index.ts
      const indexPath = `${scaffold.path}/src/index.ts`;
      const existingIndex = await fs.read(indexPath);

      // 2. Fetch discovery probe concepts
      let conceptsText = "No discovery concepts available.";
      try {
        const res = await fetch.request(
          `${conceptDbEndpoint}/concepts/search?source_type=vessel_construction_pattern&shape=typescript_vessel_template&limit=3`,
        );
        if (res.ok) {
          const data = (await res.json()) as { concepts?: Array<{ name: string; content?: string }> };
          if (data.concepts?.length) {
            conceptsText = data.concepts
              .map((c) => `- ${c.name}: ${c.content ?? ""}`)
              .join("\n");
          }
        }
      } catch {
        // concept-db unavailable — proceed without
      }

      // 3. LLM edits src/index.ts to inject discovery registration + heartbeat
      const prompt = [
        "Edit the following TypeScript vessel entry-point to add non-blocking discovery registration",
        "and a 60-second heartbeat, following TYPESCRIPT_VESSEL_TEMPLATE.md conventions.",
        "",
        "Requirements:",
        "- Discovery registration must be non-blocking (fire-and-forget, wrapped in .catch())",
        "- 60s heartbeat via setInterval, also non-blocking",
        "- Read DISCOVERY_ENDPOINT from environment (default: http://discovery-vessel:8080)",
        "- Use fetch() for HTTP calls",
        "- Do not import any new dependencies beyond what is standard in Bun/Node",
        "",
        "Relevant concepts:",
        conceptsText,
        "",
        "Current src/index.ts:",
        "```typescript",
        existingIndex,
        "```",
        "",
        "Return ONLY the updated TypeScript source. No markdown fences, no explanation.",
      ].join("\n");

      const updated = await llm.generate({
        prompt,
        systemPrompt: "You are a TypeScript vessel wiring assistant. Output only valid TypeScript source code.",
      });

      // 4. Write updated src/index.ts
      await fs.write(indexPath, updated);

      return [
        {
          id: context.random.id("discovery"),
          pointer: { type: "memo" },
          metadata: {
            shape: "vesselWithDiscovery",
            summary: `discovery wired at ${scaffold.path}`,
          },
          loaded: true,
          content: { path: scaffold.path },
        },
      ];
    },
  };
}
