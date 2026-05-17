/**
 * wire_auth_blueprint resolver — Phase 22
 *
 * Tier: llm
 * Reads src/index.ts from the scaffold, fetches vessel_auth_blueprint concepts
 * from concept-db, then uses the LLM to inject identity-vessel client,
 * requireAuth() middleware, and JWT_SECRET env wiring.
 *
 * Inputs (impulses):  vesselWithDiscovery { path }
 * Config:             conceptDbEndpoint
 * Outputs:            vesselWithAuth { path }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { FileSystemPort, FetchPort, LLMPort } from "../ports";
import type { Impulse } from "../ontology";

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

export function makeWireAuthBlueprintResolver(
  fs: FileSystemPort,
  fetch: FetchPort,
  llm: LLMPort,
): Resolver {
  return {
    id: "wire_auth_blueprint",
    tier: "llm",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const conceptDbEndpoint = context.task.config?.["conceptDbEndpoint"];
      if (typeof conceptDbEndpoint !== "string") {
        throw new Error("wire_auth_blueprint requires task.config.conceptDbEndpoint");
      }

      const discoveryImpulse = findImpulseByShape(context.inputImpulses, "vesselWithDiscovery");
      if (!discoveryImpulse?.content) {
        throw new Error("wire_auth_blueprint requires a vesselWithDiscovery impulse");
      }
      const scaffold = discoveryImpulse.content as { path: string };

      // 1. Read current src/index.ts
      const indexPath = `${scaffold.path}/src/index.ts`;
      const existingIndex = await fs.read(indexPath);

      // 2. Fetch auth blueprint concepts from concept-db
      let conceptsText = "No auth concepts available.";
      try {
        const res = await fetch.request(
          `${conceptDbEndpoint}/concepts/search?source_type=vessel_construction_pattern&shape=vessel_auth_blueprint&limit=3`,
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

      // 3. LLM injects auth middleware
      const prompt = [
        "Edit the following TypeScript vessel entry-point to add identity-vessel-backed authentication.",
        "",
        "Requirements:",
        "- Add a requireAuth() middleware that validates API keys against identity-vessel",
        "- Read IDENTITY_VESSEL_ENDPOINT from environment (default: http://identity-vessel:8080)",
        "- Read JWT_SECRET from environment for JWT validation",
        "- Unauthenticated requests to non-public routes must return 401",
        "- Wire requireAuth() on all /v2/* routes",
        "- Keep the health endpoint public (no auth required)",
        "- Use fetch() for identity-vessel calls; no new imports",
        "",
        "Relevant auth patterns:",
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
        systemPrompt: "You are a TypeScript vessel auth wiring assistant. Output only valid TypeScript source code.",
      });

      // 4. Write updated src/index.ts
      await fs.write(indexPath, updated);

      return [
        {
          id: context.random.id("auth"),
          pointer: { type: "memo" },
          metadata: {
            shape: "vesselWithAuth",
            summary: `auth wired at ${scaffold.path}`,
          },
          loaded: true,
          content: { path: scaffold.path },
        },
      ];
    },
  };
}
