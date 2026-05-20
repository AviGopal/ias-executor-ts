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

      // Extract shape from vesselSpec (for advertising the correct shapes)
      const specImpulse = findImpulseByShape(context.inputImpulses, "vesselSpec");
      let vesselShape = context.variables["missingShape"] as string ?? "unknown";
      if (specImpulse?.content) {
        let specObj: { shape?: string; vesselSpec?: { shape?: string } };
        if (typeof specImpulse.content === "string") {
          try {
            const stripped = (specImpulse.content as string).replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, "$1").trim();
            specObj = JSON.parse(stripped);
          } catch { specObj = {}; }
        } else {
          specObj = specImpulse.content as typeof specObj;
        }
        vesselShape = specObj.shape ?? specObj.vesselSpec?.shape ?? vesselShape;
      }

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
      // Prompt-design note (2026-05-19): the previous prompt produced code that
      // POSTed to /register WITHOUT an Authorization header AND swallowed all
      // errors via .catch(() => {}). Discovery requires API-key auth on
      // mutations; the register call always 401'd and the silent-catch made
      // it invisible. Pod logs only ever showed "Started development server".
      // Fix: require the LLM to attach Authorization: ApiKey ${METABOB_API_KEY}
      // and to log errors before swallowing them.
      const prompt = [
        "Edit the following TypeScript vessel entry-point to add non-blocking discovery registration",
        "and a 60-second heartbeat.",
        "",
        `This vessel provides the shape: ${vesselShape}`,
        "",
        "EXACT REQUIREMENTS — follow these precisely:",
        "- Read DISCOVERY_ENDPOINT from environment: const discoveryEndpoint = process.env.DISCOVERY_ENDPOINT ?? 'http://discovery-vessel:8080';",
        `- Read VESSEL_ENDPOINT from environment: const vesselEndpoint = process.env.VESSEL_ENDPOINT ?? \`http://\${host}:\${port}\`;`,
        "- Read METABOB_API_KEY from environment: const apiKey = process.env.METABOB_API_KEY ?? '';",
        `- On startup, register with discovery by POSTing to \`\${discoveryEndpoint}/register\` with:`,
        "  headers: { 'Content-Type': 'application/json', 'Authorization': `ApiKey ${apiKey}` }",
        `  body: { id: process.env.VESSEL_ID ?? '${vesselShape}-vessel', name: '${vesselShape}-vessel', version, shapes: ['${vesselShape}'], endpoint: vesselEndpoint, resolve_endpoint: \`\${vesselEndpoint}/v2/impulses/resolve\`, auth_scheme: 'ApiKey' }`,
        "- Registration must be non-blocking but VISIBLY logged on failure:",
        "  registerWithDiscovery().catch((err) => console.warn('[discovery] registration failed:', err?.message ?? err));",
        "  (no await at top level; do NOT use .catch(() => {}) — silent failures are bugs)",
        "- Send heartbeat every 60s via setInterval to `${discoveryEndpoint}/heartbeat` with the SAME Authorization header",
        "  body: { id: process.env.VESSEL_ID ?? '<shape>-vessel', shapes: ['<shape>'] }",
        "- Heartbeat must be non-blocking but VISIBLY logged on failure:",
        "  .catch((err) => console.warn('[discovery] heartbeat failed:', err?.message ?? err))",
        "- Do not import any new dependencies",
        "- Do not use await at the top level for registration or heartbeat setup",
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

      const rawUpdated = await llm.generate({
        prompt,
        systemPrompt: "You are a TypeScript vessel wiring assistant. Output only valid TypeScript source code.",
      });
      const updated = rawUpdated.replace(/^```(?:typescript|ts)?\s*\n([\s\S]*?)\n?```\s*$/m, "$1").trim();

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
