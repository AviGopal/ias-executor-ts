import type { DiscoveryPort, FetchPort, VesselRegistration, VesselSummary } from "../ports";

/**
 * THE LOOKUP BUDGET MUST EXCEED DISCOVERY'S FORWARDING BUDGET (09-30).
 *
 * On a federated node a vesselCapability lookup is not answered locally: discovery-vessel
 * forwards it to every peer discovery with AbortSignal.timeout(5000) and waits for all of them
 * (forwardToPeers, PEER_FANOUT_MODE=union), so one slow peer makes the whole answer arrive at
 * ~5 s. Measured on a spoke over 24 h: 445 lookups answered at 5 s, one at 6 s, one at 7 s, none
 * later. A client that gives up before discovery does turns a slow peer into "no producer":
 * development-vessel's policy readers gave discovery 3 s, logged "no poolImpulse producer
 * discovered", and failed closed on every undirected landing on that node.
 *
 * Why the client waits rather than discovery answering early: the union is load-bearing. The
 * spend envelope and the autonomy scope must read EVERY node's pool (a partial read can miss the
 * one node holding a pause), so a short-circuited partial union is worse than a slow one. The
 * coupling is stated here, not hidden: raise this if discovery's per-peer abort grows.
 */
export const DISCOVERY_FORWARD_BUDGET_MS = 5_000;
export const DISCOVERY_LOOKUP_BUDGET_MS = DISCOVERY_FORWARD_BUDGET_MS + 3_000;
/** A failed lookup, and an EMPTY answer, are remembered only this long, so a burst of readers
 *  does not re-dial a dead discovery and the first read after it re-dials. A failure is never
 *  cached as "no producer". An empty answer gets the same short life because discovery's union
 *  can come back PARTIAL without saying so: a peer that times out inside discovery yields a 200
 *  with fewer producers, or none, so an empty answer is the one most likely to be a partial read. */
export const DISCOVERY_FAILURE_BACKOFF_MS = 2_000;

/** Why a lookup could not be answered. None of these means "no producer". */
export type DiscoveryLookupFailureReason = "timeout" | "network" | "http" | "malformed";

/**
 * A discovery lookup. `ok:true` with an empty `producers` is a real answer: discovery replied and
 * nothing serves the shape. `ok:false` means discovery could not be read, so the caller does not
 * know whether a producer exists and must not report it as absent.
 */
export type DiscoveryLookup =
  | { ok: true; shape: string; producers: VesselSummary[]; cached: boolean }
  | { ok: false; shape: string; reason: DiscoveryLookupFailureReason; status?: number; detail: string; cached: boolean };

/** One line for a log or a verdict reason that keeps "unreadable" and "absent" apart. */
export function describeDiscoveryLookup(r: DiscoveryLookup): string {
  if (r.ok) return r.producers.length === 0 ? `no ${r.shape} producer` : `${r.producers.length} ${r.shape} producer(s)`;
  return `${r.shape} lookup failed (${r.reason}${r.status !== undefined ? " " + r.status : ""}): ${r.detail}`;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

interface CacheEntry {
  result: DiscoveryLookup;
  expiresAt: number;
}

/**
 * HTTP-backed discovery adapter.
 * Wraps FetchPort against discovery-vessel. Every lookup is bounded by DISCOVERY_LOOKUP_BUDGET_MS.
 * A non-empty answer is cached for 30s; an empty answer and a failed lookup only for
 * DISCOVERY_FAILURE_BACKOFF_MS. Cache is invalidated after registerVessel completes so new
 * producers are immediately visible to subsequent lookups.
 */
export class HttpDiscoveryAdapter implements DiscoveryPort {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cacheTtlMs: number;
  private readonly lookupBudgetMs: number;
  /** How long a failed lookup is remembered; a caller caching its own verdict on top of a failed
   *  lookup should hold it no longer than this. */
  readonly failureBackoffMs: number;
  private readonly apiKey?: string;

  constructor(
    private readonly fetch: FetchPort,
    private readonly discoveryEndpoint: string,
    opts: { cacheTtlMs?: number; apiKey?: string; lookupBudgetMs?: number; failureBackoffMs?: number } = {},
  ) {
    this.cacheTtlMs = opts.cacheTtlMs ?? 30_000;
    this.lookupBudgetMs = opts.lookupBudgetMs ?? DISCOVERY_LOOKUP_BUDGET_MS;
    this.failureBackoffMs = opts.failureBackoffMs ?? DISCOVERY_FAILURE_BACKOFF_MS;
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

  /** describeDiscoveryLookup through the instance. A consumer then needs only the class it already
   *  imports, so a consumer tree whose node_modules still holds an older dist (the lane's push
   *  clones are never refreshed by substrate:deploy) still LOADS; only the new calls fail. */
  describe(r: DiscoveryLookup): string {
    return describeDiscoveryLookup(r);
  }

  /**
   * The typed lookup: a real answer (possibly empty) or a failure with its reason. Use this
   * wherever "discovery unreadable" and "nothing serves this shape" must lead to different
   * decisions or different log lines.
   */
  async lookup(shape: string, orgIds?: string[]): Promise<DiscoveryLookup> {
    const cacheKey = `${shape}:${[...(orgIds ?? [])].sort().join(",")}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.result, cached: true };

    const result = await this.lookupUncached(shape, orgIds);
    this.cache.set(cacheKey, { result, expiresAt: Date.now() + (result.ok && result.producers.length > 0 ? this.cacheTtlMs : this.failureBackoffMs) });
    return result;
  }

  private async lookupUncached(shape: string, orgIds?: string[]): Promise<DiscoveryLookup> {
    const body: Record<string, unknown> = { shape };
    if (orgIds?.length) body["org_ids"] = orgIds;

    let res: Response;
    try {
      res = await this.fetch.request(`${this.discoveryEndpoint}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: "ApiKey " + this.apiKey } : {}) },
        body: JSON.stringify({ pointer: { type: "vesselCapability", ...body } }),
        signal: AbortSignal.timeout(this.lookupBudgetMs),
      });
    } catch (err) {
      if (isAbort(err)) return { ok: false, shape, reason: "timeout", detail: `no answer from discovery within ${this.lookupBudgetMs} ms`, cached: false };
      return { ok: false, shape, reason: "network", detail: String((err as Error)?.message ?? err), cached: false };
    }

    if (!res.ok) {
      try { await res.body?.cancel(); } catch { /* swallow */ }
      return { ok: false, shape, reason: "http", status: res.status, detail: `discovery answered HTTP ${res.status}`, cached: false };
    }

    let data: { vessels?: unknown; content?: { vessels?: unknown } } | null;
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      if (isAbort(err)) return { ok: false, shape, reason: "timeout", detail: `discovery body not received within ${this.lookupBudgetMs} ms`, cached: false };
      return { ok: false, shape, reason: "malformed", detail: "discovery answer is not JSON", cached: false };
    }
    try { await res.body?.cancel(); } catch { /* swallow */ }
    const rows = data?.content?.vessels ?? data?.vessels;
    if (!Array.isArray(rows)) return { ok: false, shape, reason: "malformed", detail: "discovery answer carries no vessels array", cached: false };
    const producers: VesselSummary[] = (rows as Array<Record<string, unknown>>).map((v) => ({
      id: String(v["id"] ?? v["vesselId"] ?? ""),
      resolveEndpoint: this.buildResolveUrl(v),
      healthScore: typeof v["health_score"] === "number" ? v["health_score"] : undefined,
      orgId: typeof v["org_id"] === "string" ? v["org_id"] : undefined,
      // Provenance passes through untouched: dropping it would make every producer unattributable,
      // and a reader of substrate-local policy must then refuse them all.
      origin: typeof v["origin"] === "string" ? v["origin"] : undefined,
      originUpstream: typeof v["origin_upstream"] === "string" ? v["origin_upstream"] : (v["origin_upstream"] === null ? null : undefined),
    }));
    return { ok: true, shape, producers, cached: false };
  }

  /**
   * DiscoveryPort contract, unchanged for its callers (engine.ts, verify-three-invariants.ts both
   * catch): the producers; [] when discovery answered non-2xx or malformed; a throw when discovery
   * could not be reached, now including a lookup past DISCOVERY_LOOKUP_BUDGET_MS, which before
   * could hang without bound.
   */
  async lookupShapeProducers(shape: string, orgIds?: string[]): Promise<VesselSummary[]> {
    const r = await this.lookup(shape, orgIds);
    if (r.ok) return r.producers;
    if (r.reason === "timeout" || r.reason === "network") throw new Error(describeDiscoveryLookup(r));
    return [];
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
