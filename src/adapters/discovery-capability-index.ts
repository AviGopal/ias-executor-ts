import type { CapabilityIndex } from "../ports";

/**
 * Discovery-vessel-backed CapabilityIndex adapter.
 *
 * Implements CapabilityIndex by querying a discovery-vessel registry endpoint.
 * Hosts inject this into the runtime instead of hardcoding resolver ids, so
 * capability lookup is dynamic (task 6.6: discovery lives behind the port).
 *
 * Usage (MiniBob host integration):
 *   const capIndex = new DiscoveryCapabilityIndex("https://discovery.metabob.com", apiKey);
 *   const runtime = new ExecutionRuntime({ ... });
 *   // Pass capIndex to resolvers that need capability discovery
 *
 * The adapter uses a TTL cache to avoid hitting discovery-vessel on every task.
 */
export interface DiscoveryCapabilityIndexOptions {
  /** TTL for cached resolver ids in milliseconds (default: 60_000) */
  cacheTtlMs?: number;
}

export class DiscoveryCapabilityIndex implements CapabilityIndex {
  private cachedIds: string[] | null = null;
  private cacheExpiresAt = 0;
  private readonly cacheTtlMs: number;

  constructor(
    private readonly discoveryEndpoint: string,
    private readonly apiKey: string,
    options: DiscoveryCapabilityIndexOptions = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
  }

  async listResolverIds(): Promise<string[]> {
    const now = Date.now();
    if (this.cachedIds && now < this.cacheExpiresAt) {
      return this.cachedIds;
    }

    const res = await fetch(`${this.discoveryEndpoint}/shapes`, {
      headers: { Authorization: `ApiKey ${this.apiKey}` },
    });

    if (!res.ok) {
      // Fail gracefully — return stale cache if available, empty list otherwise
      if (this.cachedIds) return this.cachedIds;
      return [];
    }

    const body = await res.json() as { shapes?: string[] };
    const ids = Array.isArray(body.shapes) ? body.shapes : [];
    this.cachedIds = ids;
    this.cacheExpiresAt = now + this.cacheTtlMs;
    return ids;
  }

  /** Invalidate the cache, forcing the next call to re-fetch */
  invalidate(): void {
    this.cachedIds = null;
    this.cacheExpiresAt = 0;
  }
}

/**
 * Static CapabilityIndex backed by a hardcoded list of resolver ids.
 * Useful for tests and offline/embedded hosts where discovery is unavailable.
 */
export class StaticCapabilityIndex implements CapabilityIndex {
  constructor(private readonly ids: string[]) {}

  async listResolverIds(): Promise<string[]> {
    return [...this.ids];
  }
}
