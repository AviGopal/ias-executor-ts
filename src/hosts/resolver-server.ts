/**
 * ResolverServer — Bun HTTP router binding resolver ids to pointer-typed routes.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 0, task 0.3.
 *
 * One file replaces the six near-identical Hono apps across existing vessels.
 * Uses Bun's native HTTP server (Bun.serve) — Hono is not yet a dependency.
 *
 * Routes:
 *   POST /resolve  — routes to the appropriate resolver handler by impulse pointer type
 *   GET  /health   — returns { status, resolvers, version }
 */

export interface ResolverContext {
  /** The raw parsed JSON body of the request */
  body: unknown;
  /** Convenience: the pointer type extracted from body.impulse.pointer.type or body.type */
  pointerType: string | undefined;
  /** Forwarded request headers */
  headers: Record<string, string>;
}

/** Handler for a single resolver. Receives the parsed request body. Returns a JSON-serialisable response. */
export type ResolverHandler = (ctx: ResolverContext) => Promise<unknown>;

export interface ResolverServerConfig {
  port: number;
  version?: string;
  /** Map of resolverName → handler */
  resolvers: Map<string, ResolverHandler>;
}

export class ResolverServer {
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly config: ResolverServerConfig) {}

  /** Start listening. Returns the bound server. */
  start(): ReturnType<typeof Bun.serve> {
    const { port, version = "0.0.0", resolvers } = this.config;

    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({
            status: "healthy",
            resolvers: Array.from(resolvers.keys()),
            version,
          });
        }

        if (req.method === "POST" && url.pathname === "/resolve") {
          return this.handleResolve(req, resolvers);
        }

        return new Response("Not Found", { status: 404 });
      },
      error(err) {
        console.error("[ResolverServer] unhandled error:", err);
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    console.log(`[ResolverServer] listening on port ${port}`);
    return this.server;
  }

  /** Stop the server. */
  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  private async handleResolve(
    req: Request,
    resolvers: Map<string, ResolverHandler>,
  ): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    // Extract pointer type — supports both discovery-contract form
    //   { impulse: { pointer: { type } } }
    // and the simpler direct form
    //   { type: "..." }
    const pointerType = extractPointerType(body);

    if (!pointerType) {
      return Response.json(
        { error: "cannot determine resolver: body.impulse.pointer.type or body.type is required" },
        { status: 400 },
      );
    }

    const handler = resolvers.get(pointerType);
    if (!handler) {
      return Response.json(
        { error: `no resolver registered for pointer type '${pointerType}'`, registeredTypes: Array.from(resolvers.keys()) },
        { status: 404 },
      );
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => { headers[key] = value; });

    try {
      const result = await handler({ body, pointerType, headers });
      return Response.json(result);
    } catch (err) {
      console.error(`[ResolverServer] resolver '${pointerType}' error:`, err);
      return Response.json(
        { error: (err as Error).message ?? "resolver error" },
        { status: 500 },
      );
    }
  }
}

function extractPointerType(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;

  // Discovery-contract form: { impulse: { pointer: { type: "..." } } }
  if (typeof b.impulse === "object" && b.impulse !== null) {
    const impulse = b.impulse as Record<string, unknown>;
    if (typeof impulse.pointer === "object" && impulse.pointer !== null) {
      const pointer = impulse.pointer as Record<string, unknown>;
      if (typeof pointer.type === "string") return pointer.type;
    }
  }

  // Simpler direct form: { type: "..." }
  if (typeof b.type === "string") return b.type;

  return undefined;
}
