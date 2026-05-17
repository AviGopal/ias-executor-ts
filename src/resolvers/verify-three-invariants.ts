/**
 * verify_three_invariants resolver — Phase 22
 *
 * Tier: deterministic
 * Performs 3 parallel probes against the deployed vessel:
 *   1. Discovery probe  — DiscoveryPort.lookupShapeProducers(shape) expects ≥1 producer
 *   2. Observation probe — GET /health expects 200
 *   3. Auth probe       — GET /v2/impulses/resolve without JWT expects 401;
 *                         same endpoint with ApiKey header expects 200 or 401 (not 500)
 *
 * Inputs (impulses):  vesselDeployedToCanary { endpoint }, vesselSpec { shape }
 * Outputs:            vesselVerified { shape, endpoint, probeResults }
 *                  OR failure_mode impulse when any probe fails
 */

import type { Resolver, ResolverContext } from "../resolvers";
import type { DiscoveryPort, FetchPort } from "../ports";
import type { Impulse } from "../ontology";

interface ProbeResult {
  probe: string;
  passed: boolean;
  detail: string;
}

function findImpulseByShape(impulses: Impulse[], shape: string): Impulse | undefined {
  return impulses.find((i) => (i.metadata.shape ?? i.pointer.type) === shape);
}

export function makeVerifyThreeInvariantsResolver(
  discovery: DiscoveryPort,
  fetch: FetchPort,
): Resolver {
  return {
    id: "verify_three_invariants",
    tier: "deterministic",
    async resolve(context: ResolverContext): Promise<Impulse[]> {
      const deployedImpulse = findImpulseByShape(context.inputImpulses, "vesselDeployedToCanary");
      if (!deployedImpulse?.content) {
        throw new Error("verify_three_invariants requires a vesselDeployedToCanary impulse");
      }
      const { endpoint } = deployedImpulse.content as { endpoint: string };

      const specImpulse = findImpulseByShape(context.inputImpulses, "vesselSpec");
      if (!specImpulse?.content) {
        throw new Error("verify_three_invariants requires a vesselSpec impulse");
      }
      const spec = specImpulse.content as { shape: string };

      // Run all 3 probes in parallel
      const [discoveryResult, observationResult, authResult] = await Promise.all([
        // 1. Discovery probe
        (async (): Promise<ProbeResult> => {
          try {
            const producers = await discovery.lookupShapeProducers(spec.shape);
            if (producers.length >= 1) {
              return { probe: "discovery", passed: true, detail: `${producers.length} producer(s) found` };
            }
            return { probe: "discovery", passed: false, detail: `0 producers found for shape "${spec.shape}"` };
          } catch (err) {
            return { probe: "discovery", passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
          }
        })(),

        // 2. Observation probe — GET /health → 200
        (async (): Promise<ProbeResult> => {
          try {
            const res = await fetch.request(`${endpoint}/health`);
            if (res.status === 200) {
              return { probe: "observation", passed: true, detail: "GET /health returned 200" };
            }
            return { probe: "observation", passed: false, detail: `GET /health returned ${res.status}` };
          } catch (err) {
            return { probe: "observation", passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
          }
        })(),

        // 3. Auth probe — no JWT → 401; with ApiKey → 200 or 401 (not 500)
        (async (): Promise<ProbeResult> => {
          try {
            const unauthRes = await fetch.request(`${endpoint}/v2/impulses/resolve`);
            if (unauthRes.status !== 401) {
              return {
                probe: "auth",
                passed: false,
                detail: `unauthenticated request returned ${unauthRes.status} (expected 401)`,
              };
            }

            const authRes = await fetch.request(`${endpoint}/v2/impulses/resolve`, {
              headers: { Authorization: "ApiKey test" },
            });
            if (authRes.status === 500) {
              return {
                probe: "auth",
                passed: false,
                detail: `authenticated request returned 500 (server error)`,
              };
            }
            return {
              probe: "auth",
              passed: true,
              detail: `unauth=401, authenticated=${authRes.status} (not 500)`,
            };
          } catch (err) {
            return { probe: "auth", passed: false, detail: `error: ${err instanceof Error ? err.message : String(err)}` };
          }
        })(),
      ]);

      const probeResults: ProbeResult[] = [discoveryResult, observationResult, authResult];
      const failed = probeResults.filter((p) => !p.passed);

      if (failed.length > 0) {
        return [
          {
            id: context.random.id("invariant-fail"),
            pointer: { type: "memo" },
            metadata: {
              shape: "failure_mode",
              summary: `invariant check failed: ${failed.map((p) => p.probe).join(", ")}`,
            },
            loaded: true,
            content: {
              failure_mode: {
                type: "verifier_negative",
                reason: "vessel_invariant_check_failed",
                context: {
                  failedProbes: failed,
                  allProbes: probeResults,
                },
              },
            },
          },
        ];
      }

      return [
        {
          id: context.random.id("verified"),
          pointer: { type: "memo" },
          metadata: {
            shape: "vesselVerified",
            summary: `all 3 invariants passed for ${spec.shape} at ${endpoint}`,
          },
          loaded: true,
          content: { shape: spec.shape, endpoint, probeResults },
        },
      ];
    },
  };
}
