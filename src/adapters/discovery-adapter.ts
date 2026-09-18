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
      // If it's not an absolute URL and not a bare path, return an empty string
      // so the caller's skip-empty logic drops it - one bad row shouldn't abort
      // the whole lookup when other valid producers exist for this shape.
      return "";
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
      resolveEndpoint: this.buildResolveUrl(v),
      healthScore: typeof v["health_score"] === "number" ? v["health_score"] : undefined,
      orgId: typeof v["org_id"] === "string" ? v["org_id"] : undefined,
    }));

    this.cache.set(cacheKey, { results, expiresAt: Date.now() + this.cacheTtlMs });
    return results;
  }


  /**
   * Build a fetchable resolve URL from a registry row (mirrors the goal-host
   * walk routeFor helper). Three row kinds arrive here:
   *  1. libp2p facade rows (protocol "libp2p" + circuit multiaddr) are not
   *     HTTP-dialable at all — route them through the local federation
   *     transport egress with the multiaddr as ?target=.
   *  2. Absolute http(s) resolve_endpoints pass through verbatim.
   *  3. Bare paths join onto the row endpoint field.
   * Never throws: an unusable row degrades to "" so the caller existing
   * skip-empty pick loop drops it — one malformed row must not abort the
   * whole lookup for a shape that has other producers.
   */
  private buildResolveUrl(v: Record<string, unknown>): string {
    const ma = v["libp2p_multiaddr"];
    if (v["protocol"] === "libp2p" && Array.isArray(ma) && typeof ma[0] === "string" && ma[0]) {
      const egress = process.env["FED_TRANSPORT_EGRESS"] ?? "http://127.0.0.1:8401";
      const vid = String(v["id"] ?? v["vesselId"] ?? "");
      return egress.replace(/\/+$/, "") + "/egress/resolve?target=" + encodeURIComponent(ma[0]) + (vid ? "&vessel=" + encodeURIComponent(vid) : "");
    }
    const re = String(v["resolve_endpoint"] ?? "");
    if (/^https?:\/\//.test(re)) return re;
    const ep = String(v["endpoint"] ?? "");
    if (re && ep) {
      try {
        const url = new URL(ep);
        url.pathname = re.startsWith("/") ? re : "/" + re;
        return url.toString();
      } catch {
        return "";
      }
    }
    return "";
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
