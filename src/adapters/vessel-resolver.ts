import type { Impulse } from "../ontology";
import type { Resolver, ResolverContext } from "../resolvers";

/**
 * VesselResolver — wraps a discovery-vessel-advertised resolve_endpoint as a Resolver.
 *
 * Sends the standard impulse-resolve contract:
 *   POST <resolve_endpoint>
 *   Authorization: ApiKey <apiKey>
 *   { pointer: { type: <shape>, ...task.config } }
 *
 * The response must be { success: true, content: <any>, metadata?: {...} }
 * or { success: false, error: string }.
 *
 * The resolved content becomes a single impulse with the given shape.
 *
 * Usage:
 *   const resolver = new VesselResolver({
 *     id: "activityTemplate",
 *     shape: "activityTemplate",
 *     resolveEndpoint: "https://activity.metabob.com/v2/impulses/resolve",
 *     apiKey: "mb-...",
 *     timeoutMs: 10_000,
 *   });
 *   runtime.resolvers.register(resolver);
 */
export interface VesselResolverOptions {
  /** Resolver id — must match the task.resolver field in the template */
  id: string;
  /** Shape name injected as pointer.type in the request body */
  shape: string;
  /** Full URL of the vessel's resolve endpoint */
  resolveEndpoint: string;
  /** API key sent as "Authorization: ApiKey <apiKey>" */
  apiKey: string;
  /** Timeout in milliseconds (default: 10_000) */
  timeoutMs?: number;
  /** Resolver tier for trace annotation (default: "external") */
  tier?: "deterministic" | "pattern" | "llm" | "external";
}

export class VesselResolver implements Resolver {
  readonly id: string;
  readonly tier: "deterministic" | "pattern" | "llm" | "external";

  private readonly shape: string;
  private readonly resolveEndpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: VesselResolverOptions) {
    this.id = options.id;
    this.tier = options.tier ?? "external";
    this.shape = options.shape;
    this.resolveEndpoint = options.resolveEndpoint;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async resolve(ctx: ResolverContext): Promise<Impulse[]> {
    const pointer: Record<string, unknown> = {
      type: this.shape,
      ...ctx.task.config,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res: Response;
    try {
      res = await globalThis.fetch(this.resolveEndpoint, {
        method: "POST",
        headers: {
          Authorization: `ApiKey ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ pointer }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`VesselResolver(${this.id}): fetch failed — ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const body = await res.json() as { success: boolean; content?: unknown; body?: unknown; shape?: string; error?: string; metadata?: Record<string, unknown> };
    // Compat: dev-vessel-style resolvers return { success, shape, body } (the
    // resolver result), not { success, content }. Without this fallback the
    // adapter set impulse.content = undefined, so any compose template feeding a
    // custom-resolver output into a downstream task got an EMPTY/unbound
    // {{taskid_*}} variable (root cause of the stalled cross-template synthesis
    // loop, 2026-06-19). Prefer content; fall back to the body payload.
    let resolvedContent: unknown = body.content !== undefined ? body.content : body.body;
        if (body.shape === "llm_completion_result" && resolvedContent && typeof resolvedContent === "object" && typeof (resolvedContent as Record<string, unknown>)["text"] === "string") {
          resolvedContent = ((resolvedContent as Record<string, unknown>)["text"] as string).replace(/^```(?:json|JSON)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        }
    // Drain Bun's native HTTP buffers — without this the response's mmap'd
    // read stream is retained until the runtime's incremental GC catches it,
    // and at high vessel-resolver call rates this dominates per-runGoal RSS.
    try { await res.body?.cancel(); } catch { /* swallow */ }

    if (!body.success) {
      throw new Error(`VesselResolver(${this.id}): vessel returned error — ${body.error ?? res.status}`);
    }

    const summary = typeof resolvedContent === "string"
      ? resolvedContent.slice(0, 120)
      : JSON.stringify(resolvedContent ?? "").slice(0, 120);

    return [{
      id: ctx.random.id(this.shape),
      pointer: { type: this.shape, ...ctx.task.config } as Impulse["pointer"],
      metadata: {
        shape: (typeof body.shape === "string" ? body.shape : this.shape),
        summary,
        ...(body.metadata ?? {}),
      },
      loaded: true,
      content: resolvedContent,
    }];
  }
}
