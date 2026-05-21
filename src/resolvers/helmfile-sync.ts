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
      // vesselSpec content may be raw LLM text (JSON string) or already-parsed object
      let spec: { shape?: string; vesselSpec?: { shape?: string; name?: string } };
      if (typeof specImpulse.content === "string") {
        try {
          const stripped = (specImpulse.content as string).replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/m, "$1").trim();
          spec = JSON.parse(stripped);
        } catch {
          spec = {};
        }
      } else {
        spec = specImpulse.content as typeof spec;
      }
      // Flatten: LLM often returns {"vesselSpec": {"shape": ...}}
      const specShape = String(spec.shape ?? spec.vesselSpec?.shape ?? context.variables["missingShape"] ?? "forged");

      // Derive image tag from the URI (last colon-separated segment)
      const colonIdx = imageUri.lastIndexOf(":");
      const imageRepo = colonIdx > 0 ? imageUri.slice(0, colonIdx) : imageUri;
      const imageTag = colonIdx > 0 ? imageUri.slice(colonIdx + 1) : "latest";

      const workingDir =
        typeof context.variables["workingDirectory"] === "string"
          ? context.variables["workingDirectory"]
          : process.cwd();

      const uuid = context.random.id("overlay");
      const releaseName = `forge-${specShape.replace(/_/g, "-")}`;
      const overlayPath = `${workingDir}/repos/deployment/helmfiles/forged-vessels/${releaseName}-${uuid}.yaml`;
      // Chart path must be absolute — helmfile resolves relative paths from the overlay file's dir
      const chartPath = `${workingDir}/repos/deployment/charts/forged-vessel`;

      const serviceEndpoint = `http://${releaseName}.activity-system.svc.cluster.local:8080`;
      // 2026-05-19 fix: previously the overlay only set VESSEL_ENDPOINT and
      // VESSEL_ID. The scaffolded vessel's registerWithDiscovery call thus
      // got 401 from discovery (no Authorization header) and 0.0.0.0 endpoint
      // fallbacks the cluster couldn't reach back to. Add DISCOVERY_ENDPOINT
      // explicitly, plus METABOB_API_KEY as plain env (chart doesn't yet
      // support valueFrom: secretKeyRef — chart upgrade is a follow-up;
      // forge demonstration prioritizes registration working over secret
      // mechanism). See task 24 in tasks.md.
      const apiKey = process.env["METABOB_API_KEY"] ?? "";
      const overlayYaml = [
        "releases:",
        `  - name: ${releaseName}`,
        `    chart: ${chartPath}`,
        "    namespace: activity-system",
        "    values:",
        "      - fullnameOverride: " + releaseName,
        "        imagePullSecrets:",
        "          - name: docker-hub-pull",
        "        image:",
        `          repository: ${imageRepo}`,
        `          tag: "${imageTag}"`,
        "        env:",
        "          - name: VESSEL_ENDPOINT",
        `            value: "${serviceEndpoint}"`,
        "          - name: VESSEL_ID",
        `            value: "${specShape}-vessel"`,
        "          - name: DISCOVERY_ENDPOINT",
        `            value: "http://discovery-vessel.activity-system.svc.cluster.local:8080"`,
        "          - name: METABOB_API_KEY",
        `            value: "${apiKey}"`,
      ].join("\n") + "\n";

      // 1. Write overlay file
      await fs.write(overlayPath, overlayYaml);

      // Run helmfile from the deployment repo root so `./charts/forged-vessel` resolves correctly
      const deploymentRoot = `${workingDir}/repos/deployment`;
      // 2. Apply overlay
      await helmfile.applyOverlay(overlayPath, deploymentRoot);

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
