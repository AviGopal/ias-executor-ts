import type { DiscoveryPort, FetchPort, VesselRegistration, VesselSummary } from "../ports";

interface CacheEntry {
  results: VesselSummary[];
  expiresAt: number;
}

/**
 * HTTP-backed discovery adapter.
 * Wraps FetchPort against discovery-vessel. Results are cached for 30s.
 * Cache is invalidated after registerVessel completes so new producers
 * are immediately visible to subsequent lookupShapeProducers calls.
 */
export class HttpDiscoveryAdapter implements DiscoveryPort {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly apiKey?: string;

  constructor(
    private readonly fetch: FetchPort,
    private readonly discoveryEndpoint: string,
    opts: { cacheTtlMs?: number; apiKey?: string } = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.apiKey = opts.apiKey;
  }

  // This resolves the vessel's internal resolve_endpoint. If it's a bare path,
  // it's treated as relative to the discovery service's own transport egress.
  // e.g. for libp2p vessels, this means the discovery service acts as a proxy.
  private resolveVesselEndpoint(vesselId: string, resolveEndpoint: string): string {
    if (resolveEndpoint.startsWith("/")) {
      // This is a bare path; resolve it against the discovery endpoint.
      // Vessels may register bare paths, for example libp2p vessels can use
      // the discovery service's HTTP proxy for transport egress.
      const url = new URL(this.discoveryEndpoint);
      url.pathname = `/vessels/${vesselId}/resolve`;
      url.searchParams.set("target", resolveEndpoint);
      return url.toString();
    }
    try {
      new URL(resolveEndpoint);
      return resolveEndpoint;
    } catch {
      // If it's not an absolute URL and not a bare path, it's invalid.
      // This should ideally not happen if vessels register valid URLs.
      throw new Error(`Invalid resolve endpoint for vessel ${vesselId}: ${resolveEndpoint}. Must be an absolute URL or a bare path.`);
    }
  }

  async lookupShapeProducers(shape: string, orgIds?: string[]): Promise<VesselSummary[]> {
    const cacheKey = `${shape}:${(orgIds ?? []).sort().join(",")}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.results;

    const body: Record<string, unknown> = { shape };
    if (orgIds?.length) body["org_ids"] = orgIds;

    const res = await this.fetch.request(`${this.discoveryEndpoint}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: "ApiKey " + this.apiKey } : {}) },
      body: JSON.stringify({ pointer: { type: "vesselCapability", ...body } }),
    });

    if (!res.ok) {
      // Non-2xx means discovery is down or the shape is unknown — return empty.
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return [];
    }

    const data = (await res.json()) as { vessels?: Array<Record<string, unknown>>; content?: { vessels?: Array<Record<string, unknown>> } };
    try { await res.body?.cancel(); } catch { /* swallow */ }
    const rows = data.content?.vessels ?? data.vessels ?? [];
    const results: VesselSummary[] = rows.map((v) => ({
      id: String(v["id"] ?? v["vesselId"] ?? ""),
      resolveEndpoint: String(v["resolve_endpoint"] ?? ""),
      healthScore: typeof v["health_score"] === "number" ? v["health_score"] : undefined,
      orgId: typeof v["org_id"] === "string" ? v["org_id"] : undefined,
    }));

    this.cache.set(cacheKey, { results, expiresAt: Date.now() + this.cacheTtlMs });
    return results;
  }

  async registerVessel(payload: VesselRegistration): Promise<void> {
    const res = await this.fetch.request(`${this.discoveryEndpoint}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vessel_id: payload.id,
        shapes: payload.shapes,
        resolve_endpoint: payload.resolveEndpoint,
        auth_scheme: payload.authScheme ?? "ApiKey",
        org_id: payload.orgId,
        metadata: payload.metadata,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`discovery registerVessel failed (${res.status}): ${text}`);
    }
    // Drain success body to release Bun's native HTTP buffers (heartbeat
    // fires every ~30s and would otherwise leak a response per beat).
    try { await res.body?.cancel(); } catch { /* swallow */ }

    // Invalidate the cache for all shapes this vessel produces.
    for (const shape of payload.shapes) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${shape}:`)) this.cache.delete(key);
      }
    }
  }
}
