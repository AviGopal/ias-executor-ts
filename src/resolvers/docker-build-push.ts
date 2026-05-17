/**
 * docker_build_push resolver — Phase 22
 *
 * Tier: deterministic
 * Reads vesselWithAuth and vesselSpec impulses, builds a Docker image from the
 * scaffold directory, and pushes it to the registry. On push failure emits a
 * typed failure_mode impulse rather than throwing.
 *
 * Inputs (impulses):  vesselWithAuth { path }, vesselSpec { shape }
 * Outputs:            vesselImagePushed { imageUri }
 *                  OR failure_mode impulse on push failure
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { DockerPort } from "../ports";
import type { Impulse } from "../ontology";

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

export function makeDockerBuildPushResolver(docker: DockerPort): Resolver {
  return {
    id: "docker_build_push",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const authImpulse = findImpulseByShape(context.inputImpulses, "vesselWithAuth");
      if (!authImpulse?.content) {
        throw new Error("docker_build_push requires a vesselWithAuth impulse");
      }
      const scaffold = authImpulse.content as { path: string };

      const specImpulse = findImpulseByShape(context.inputImpulses, "vesselSpec");
      if (!specImpulse?.content) {
        throw new Error("docker_build_push requires a vesselSpec impulse");
      }
      // vesselSpec content may be raw LLM text (JSON string) or already-parsed object
      let specObj: { shape?: string; vesselSpec?: { shape?: string } };
      if (typeof specImpulse.content === "string") {
        try {
          const stripped = (specImpulse.content as string).replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, "$1").trim();
          specObj = JSON.parse(stripped);
        } catch { specObj = {}; }
      } else {
        specObj = specImpulse.content as typeof specObj;
      }
      const specShape = specObj.shape ?? specObj.vesselSpec?.shape ?? context.variables["missingShape"] ?? "forged";

      // Generate tag: metabobapp/forge-{shape}:{timestamp}-{short-uuid}
      // Shape name sanitized: underscores → dashes, lowercase
      const safeShape = specShape.replace(/_/g, "-").toLowerCase();
      const uuid = context.random.id("v").split("_")[1] ?? context.random.id("v");
      const timestamp = context.clock.now();
      const tag = `metabobapp/forge-${safeShape}:${timestamp}-${uuid}`;

      // Build
      await docker.build(scaffold.path, tag);

      // Push — on failure emit a failure_mode impulse rather than throwing
      try {
        await docker.push(tag);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return [
          {
            id: context.random.id("push-failure"),
            pointer: { type: "memo" },
            metadata: {
              shape: "failure_mode",
              summary: `docker push failed: ${reason.slice(0, 120)}`,
            },
            loaded: true,
            content: {
              failure_mode: {
                type: "verifier_negative",
                reason: "docker_push_failed",
                context: { detail: reason },
              },
            },
          },
        ];
      }

      return [
        {
          id: context.random.id("image"),
          pointer: { type: "memo" },
          metadata: {
            shape: "vesselImagePushed",
            summary: tag,
          },
          loaded: true,
          content: { imageUri: tag },
        },
      ];
    },
  };
}
