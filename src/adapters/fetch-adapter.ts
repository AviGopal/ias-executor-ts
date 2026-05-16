import type { FetchPort } from "../ports";

/**
 * FetchAdapter — thin wrapper around globalThis.fetch.
 *
 * Works in browsers, Bun, and Node 18+. Inject this as the FetchPort
 * wherever the executor needs outbound HTTP (vessel resolvers, etc.).
 */
export class FetchAdapter implements FetchPort {
  async request(input: string, init?: RequestInit): Promise<Response> {
    return globalThis.fetch(input, init);
  }
}
