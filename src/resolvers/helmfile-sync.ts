/**
 * helmfile_sync resolver — Phase 22
 *
 * Tier: deterministic
 * Writes a minimal Helmfile overlay YAML for the forged vessel, applies it,
 * and waits for the release to become ready (5-min timeout).
 *
 * Inputs (impulses):  vesselImagePushed { imageUri }, vesselSpec { shape }
 * Config:             (none — workingDir comes from context variables)
 * Outputs:            vesselDeployedToCanary { endpoint }
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { FileSystemPort, HelmfilePort } from "../ports";
import type { Impulse } from "../ontology";

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

export function makeHelmfileSyncResolver(
  fs: FileSystemPort,
  helmfile: HelmfilePort,
): Resolver {
  return {
    id: "helmfile_sync",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const imagePushedImpulse = findImpulseByShape(context.inputImpulses, "vesselImagePushed");
      if (!imagePushedImpulse?.content) {
        throw new Error("helmfile_sync requires a vesselImagePushed impulse");
      }
      const { imageUri } = imagePushedImpulse.content as { imageUri: string };

      const specImpulse = findImpulseByShape(context.inputImpulses, "vesselSpec");
      if (!specImpulse?.content) {
        throw new Error("helmfile_sync requires a vesselSpec impulse");
      }
      const spec = specImpulse.content as { shape: string };

      // Derive image tag from the URI (last colon-separated segment)
      const colonIdx = imageUri.lastIndexOf(":");
      const imageRepo = colonIdx > 0 ? imageUri.slice(0, colonIdx) : imageUri;
      const imageTag = colonIdx > 0 ? imageUri.slice(colonIdx + 1) : "latest";

      const workingDir =
        typeof context.variables["workingDirectory"] === "string"
          ? context.variables["workingDirectory"]
          : process.cwd();

      const uuid = context.random.id("overlay");
      const releaseName = `forge-${spec.shape}`;
      const overlayPath = `${workingDir}/repos/deployment/overlays/forged-vessels/${releaseName}-${uuid}.yaml`;

      const overlayYaml = [
        "releases:",
        `  - name: ${releaseName}`,
        "    chart: ./charts/generic-vessel",
        "    namespace: activity-system",
        "    values:",
        "      - image:",
        `          repository: ${imageRepo}`,
        `          tag: "${imageTag}"`,
      ].join("\n") + "\n";

      // 1. Write overlay file
      await fs.write(overlayPath, overlayYaml);

      // 2. Apply overlay
      await helmfile.applyOverlay(overlayPath);

      // 3. Wait for release to become ready (5 min)
      await helmfile.waitForReady(releaseName, "activity-system", 300_000);

      const endpoint = `http://${releaseName}.activity-system.svc.cluster.local:8080`;

      return [
        {
          id: context.random.id("deploy"),
          pointer: { type: "memo" },
          metadata: {
            shape: "vesselDeployedToCanary",
            summary: `${releaseName} deployed → ${endpoint}`,
          },
          loaded: true,
          content: { endpoint },
        },
      ];
    },
  };
}
