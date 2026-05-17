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
      const spec = specImpulse.content as VesselSpecContent;

      // 1. Fetch construction concepts from concept-db
      let conceptsText = "No construction concepts available.";
      try {
        const conceptRes = await fetch.request(
          `${conceptDbEndpoint}/concepts/search?source_type=vessel_construction_pattern&limit=5`,
        );
        if (conceptRes.ok) {
          const conceptData = (await conceptRes.json()) as { concepts?: Array<{ name: string; content?: string }> };
          if (conceptData.concepts?.length) {
            conceptsText = conceptData.concepts
              .map((c) => `- ${c.name}: ${c.content ?? ""}`)
              .join("\n");
          }
        }
      } catch {
        // concept-db unavailable — proceed without
      }

      // 2. LLM generates file tree
      const prompt = [
        "Generate a minimal TypeScript vessel skeleton for the following spec.",
        "",
        `Shape: ${spec.shape}`,
        `Description: ${spec.description ?? "(none)"}`,
        `Output shapes: ${(spec.outputShapes ?? []).join(", ") || "(none)"}`,
        "",
        "Relevant vessel-construction patterns:",
        conceptsText,
        "",
        'Respond with EXACTLY a JSON object {"files": [{"path": "...", "content": "..."}]}',
        "Include these files: package.json, src/index.ts, Dockerfile, helm/Chart.yaml, helm/values.yaml",
        "No markdown fences, no explanation — only the JSON object.",
      ].join("\n");

      const raw = await llm.generate({
        prompt,
        systemPrompt: "You are a TypeScript vessel scaffolding assistant. Output only valid JSON.",
      });

      let tree: LLMFileTree;
      try {
        tree = JSON.parse(raw) as LLMFileTree;
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
