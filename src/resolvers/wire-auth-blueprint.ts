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
        "EXACT REQUIREMENTS — follow these precisely:",
        "- Read IDENTITY_VESSEL_ENDPOINT from environment: const identityVesselEndpoint = process.env.IDENTITY_VESSEL_ENDPOINT ?? 'http://identity-vessel:8080';",
        "- Accept Authorization header in TWO forms: 'ApiKey <key>' and 'Bearer <token>'",
        "- For ApiKey auth: extract the key (everything after 'ApiKey '), POST to `${identityVesselEndpoint}/v1/keys/validate` with body { api_key: '<extracted_key>' }, check response.data.valid === true",
        "- For Bearer auth: if JWT_SECRET is set, validate JWT locally; otherwise call identity-vessel",
        "- If Authorization header is missing or invalid, return 401 immediately",
        "- Wire requireAuth() as middleware on all /v2/* routes",
        "- Keep GET /health public (no auth)",
        "- Use fetch() for identity-vessel HTTP calls; do NOT import any new modules",
        "",
        "EXAMPLE requireAuth middleware (use this pattern exactly):",
        "```",
        "const requireAuth = async (c: any, next: any) => {",
        "  const authHeader = c.req.header('Authorization');",
        "  if (!authHeader) return c.json({ error: 'Unauthorized' }, 401);",
        "  const [scheme, credential] = authHeader.split(' ');",
        "  if (scheme === 'ApiKey' && credential) {",
        "    const res = await fetch(`${identityVesselEndpoint}/v1/keys/validate`, {",
        "      method: 'POST', headers: { 'Content-Type': 'application/json' },",
        "      body: JSON.stringify({ api_key: credential })",
        "    }).catch(() => null);",
        "    if (!res?.ok) return c.json({ error: 'Unauthorized' }, 401);",
        "    const data = await res.json();",
        "    if (!data?.data?.valid) return c.json({ error: 'Unauthorized' }, 401);",
        "    await next(); return;",
        "  }",
        "  return c.json({ error: 'Unauthorized' }, 401);",
        "};",
        "```",
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

      const rawUpdated = await llm.generate({
        prompt,
        systemPrompt: "You are a TypeScript vessel auth wiring assistant. Output only valid TypeScript source code.",
      });
      // Strip markdown code fences if LLM wrapped the output
      const updated = rawUpdated.replace(/^```(?:typescript|ts)?\s*\n([\s\S]*?)\n?```\s*$/m, "$1").trim();

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
