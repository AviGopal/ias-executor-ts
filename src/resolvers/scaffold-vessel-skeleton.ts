/**
 * scaffold_vessel_skeleton resolver — Phase 22
 *
 * Tier: llm
 * Fetches vessel-construction concepts from concept-db, then uses the LLM to
 * generate a file tree (package.json, src/index.ts, Dockerfile, helm/) and
 * writes the files to /tmp/forge_{uuid}/.
 *
 * Inputs (impulses):  vesselSpec  { shape, description, outputShapes? }
 * Config:             conceptDbEndpoint, tagPrefix
 * Outputs:            vesselScaffold { path }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { FileSystemPort, FetchPort, LLMPort } from "../ports";
import type { Impulse } from "../ontology";

interface VesselSpecContent {
  shape: string;
  description?: string;
  outputShapes?: string[];
  [key: string]: unknown;
}

interface GeneratedFile {
  path: string;
  content: string;
}

interface LLMFileTree {
  files: GeneratedFile[];
}

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

export function makeScaffoldVesselSkeletonResolver(
  fs: FileSystemPort,
  fetch: FetchPort,
  llm: LLMPort,
): Resolver {
  return {
    id: "scaffold_vessel_skeleton",
    tier: "llm",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const conceptDbEndpoint = context.task.config?.["conceptDbEndpoint"];
      if (typeof conceptDbEndpoint !== "string") {
        throw new Error("scaffold_vessel_skeleton requires task.config.conceptDbEndpoint");
      }

      const specImpulse = findImpulseByShape(context.inputImpulses, "vesselSpec");
      if (!specImpulse?.content) {
        throw new Error("scaffold_vessel_skeleton requires a vesselSpec impulse");
      }
      // vesselSpec content may be a raw JSON string from the LLM resolver
      let spec: VesselSpecContent;
      if (typeof specImpulse.content === "string") {
        try {
          const stripped = (specImpulse.content as string).replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, "$1").trim();
          const parsed = JSON.parse(stripped) as Record<string, unknown>;
          // unwrap { vesselSpec: { shape, ... } } → { shape, ... }
          spec = ((parsed["vesselSpec"] as VesselSpecContent) ?? parsed) as VesselSpecContent;
        } catch { spec = {} as VesselSpecContent; }
      } else {
        spec = specImpulse.content as VesselSpecContent;
      }
      // Fall back to missingShape variable if shape not present in spec
      if (!spec.shape) {
        spec = { ...spec, shape: (context.variables["missingShape"] as string) ?? "unknown" };
      }

      // 1. Fetch construction concepts from concept-db
      // conceptDbEndpoint may include ?apiKey=... for auth
      let conceptsText = "";
      try {
        const endpointUrl = new URL(`${conceptDbEndpoint}/concepts/search`);
        const apiKey = endpointUrl.searchParams.get("apiKey") ?? "";
        endpointUrl.searchParams.delete("apiKey");
        endpointUrl.searchParams.set("source_type", "vessel_construction_pattern");
        endpointUrl.searchParams.set("limit", "8");
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers["Authorization"] = `ApiKey ${apiKey}`;
        const conceptRes = await fetch.request(endpointUrl.toString(), { headers });
        if (conceptRes.ok) {
          const conceptData = (await conceptRes.json()) as { concepts?: Array<{ metadata?: { name?: string }; content?: string }> };
          if (conceptData.concepts?.length) {
            conceptsText = conceptData.concepts
              .map((c) => `- ${c.metadata?.name ?? "concept"}: ${c.content ?? ""}`)
              .join("\n");
          }
        }
      } catch {
        // concept-db unavailable — proceed without
      }

      // 2. LLM generates file tree
      const prompt = [
        "Generate a minimal TypeScript/Bun vessel skeleton for the following spec.",
        "",
        `Shape: ${spec.shape}`,
        `Description: ${spec.description ?? "(none)"}`,
        `Output shapes: ${(spec.outputShapes ?? []).join(", ") || "(none)"}`,
        "",
        "MANDATORY STACK: TypeScript, Bun runtime, Hono web framework. Use oven-sh/bun Docker image.",
        "MANDATORY files: package.json (bun scripts), src/index.ts, Dockerfile (FROM oven/bun:1-alpine)",
        "package.json must use bun as runtime: { \"scripts\": { \"start\": \"bun run src/index.ts\" }, \"dependencies\": { \"hono\": \"^4\" } }",
        "Dockerfile must use: FROM oven/bun:1-alpine / WORKDIR /app / COPY package.json . / RUN bun install / COPY . . / CMD [\"bun\", \"run\", \"src/index.ts\"]",
        "src/index.ts MUST start the server with: const port = parseInt(process.env.PORT ?? '8080', 10); const host = process.env.HOST ?? '0.0.0.0'; export default { port, hostname: host, fetch: app.fetch };",
        "src/index.ts must implement:",
        "  1. GET /health returning { version, status: 'healthy' }",
        `  2. POST /v2/impulses/resolve that handles pointer.type === '${spec.shape}'`,
        `     Input body: { pointer: { type: '${spec.shape}', schema: <JSONSchema object>, data: <any object> } }`,
        `     NOTE: schema and data are direct fields on pointer (not nested under config)`,
        `     Implement the actual ${spec.shape} logic based on the description`,
        "     Return { shape: pointer.type, result: <output>, ok: true } on success with HTTP 200",
        "     Return 400 only if pointer.schema or pointer.data is missing/null",
        "     Return 500 for unexpected errors",
        "",
        ...(conceptsText ? ["Vessel construction patterns to follow:", conceptsText, ""] : []),
        'Respond with EXACTLY a JSON object: {"files": [{"path": "relative/path", "content": "file content as string"}]}',
        "No markdown fences, no prose, no explanation — only the raw JSON object.",
      ].join("\n");

      const raw = await llm.generate({
        prompt,
        systemPrompt: "You are a TypeScript vessel scaffolding assistant. Output only valid JSON.",
      });

      let tree: LLMFileTree;
      try {
        // Strip markdown code fences if present (LLMs often wrap JSON in ```json...```)
        const stripped = raw.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, "$1").trim();
        tree = JSON.parse(stripped) as LLMFileTree;
      } catch {
        throw new Error(`scaffold_vessel_skeleton: LLM output was not valid JSON: ${raw.slice(0, 200)}`);
      }

      if (!Array.isArray(tree.files)) {
        throw new Error('scaffold_vessel_skeleton: LLM output missing "files" array');
      }

      // 3. Write files to /tmp/forge_{uuid}/
      const uuid = context.random.id("forge");
      const basePath = `/tmp/${uuid}`;

      for (const file of tree.files) {
        await fs.write(`${basePath}/${file.path}`, file.content);
      }

      return [
        {
          id: context.random.id("scaffold"),
          pointer: { type: "memo" },
          metadata: {
            shape: "vesselScaffold",
            summary: `scaffold at ${basePath} (${tree.files.length} files)`,
          },
          loaded: true,
          content: { path: basePath },
        },
      ];
    },
  };
}
