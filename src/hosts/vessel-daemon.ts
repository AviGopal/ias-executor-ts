/**
 * VesselDaemon — composes ActivityExecutor + LifecycleSubscriberVessel +
 * DiscoveryRegistrationLoop + ResolverServer into a single substrate unit.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 0, task 0.2.
 *
 * Exposes:
 *   POST /resolve       — routes to registered resolver handlers
 *   POST /run-goal      — executes a goal via the injected executor
 *   GET  /health        — liveness probe
 *
 * Accepts parent_execution_id and composition_chain in request bodies and
 * threads them into ExecuteOptions (D3 — composition-chain threading).
 *
 * Usage:
 *   const daemon = new VesselDaemon({ port: 8230, vesselId: "local-tools", ... });
 *   await daemon.start();
 *   // listens + registered with discovery
 *   await daemon.stop();
 */

import type { ActivityTemplate } from "../ontology";
import type { ExecuteOptions } from "../engine";
import { ActivityExecutor } from "../engine";
import { ResolverServer } from "./resolver-server";
import type { ResolverHandler } from "./resolver-server";
import { DiscoveryRegistrationLoop } from "./discovery-registration-loop";
export type { ResolverHandler, ResolverContext } from "./resolver-server";

export interface VesselDaemonConfig {
  /** TCP port to listen on */
  port: number;
  /** Stable vessel id — matches the identity-vessel-issued key */
  vesselId: string;
  vesselName: string;
  /** Shapes this vessel advertises to discovery-vessel */
  shapes: string[];
  /** The pre-built ActivityExecutor to use for /run-goal */
  executor: ActivityExecutor;
  /** Map of pointerType → handler for /resolve routing */
  resolvers?: Map<string, ResolverHandler>;
  /** discovery-vessel endpoint, e.g. http://localhost:8100 */
  discoveryEndpoint?: string;
  /** activity-api endpoint — used in composition-chain assertions */
  activityApiEndpoint?: string;
  /** API key for outbound calls (discovery registration, activity-api writes) */
  apiKey?: string;
  /** Package version string emitted on /health */
  version?: string;
  /**
   * When true (default), enforce that non-root invocations of /run-goal
   * MUST include parent_execution_id (design §D3 safety guard).
   * Set false only in tests.
   */
  enforceCompositionChain?: boolean;
}

export class VesselDaemon {
  private readonly resolverServer: ResolverServer;
  private readonly discoveryLoop: DiscoveryRegistrationLoop | undefined;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(private readonly config: VesselDaemonConfig) {
    const resolvers = config.resolvers ?? new Map<string, ResolverHandler>();

    this.resolverServer = new ResolverServer({
      port: config.port,
      version: config.version ?? "0.0.0",
      resolvers,
    });

    if (config.discoveryEndpoint && config.apiKey) {
      this.discoveryLoop = new DiscoveryRegistrationLoop({
        discoveryEndpoint: config.discoveryEndpoint,
        vesselId: config.vesselId,
        vesselName: config.vesselName,
        shapes: config.shapes,
        resolveEndpoint: `http://localhost:${config.port}/resolve`,
        apiKey: config.apiKey,
        port: config.port,
      });

      this.discoveryLoop.onUnhealthy(() => {
        console.warn(`[VesselDaemon:${config.vesselId}] discovery heartbeat failed 3×; vessel may be unreachable`);
      });
    }
  }

  /** Start the HTTP server, register with discovery-vessel, and wire SIGTERM. */
  async start(): Promise<void> {
    const { config } = this;
    const enforce = config.enforceCompositionChain !== false;

    this.server = Bun.serve({
      port: config.port,
      fetch: async (req) => {
        const url = new URL(req.url);

        if (req.method === "GET" && url.pathname === "/health") {
          return Response.json({
            status: "healthy",
            vesselId: config.vesselId,
            vesselName: config.vesselName,
            shapes: config.shapes,
            version: config.version ?? "0.0.0",
          });
        }

        if (req.method === "POST" && url.pathname === "/resolve") {
          // Delegate to ResolverServer's internal handler — re-issue the
          // request to the resolver server running on the same port. Since
          // they share the same Bun.serve, we inline the routing here to
          // avoid a loopback HTTP hop.
          return this.forwardToResolverServer(req);
        }

        if (req.method === "POST" && url.pathname === "/run-goal") {
          return this.handleRunGoal(req, enforce);
        }

        return new Response("Not Found", { status: 404 });
      },
      error(err) {
        console.error(`[VesselDaemon] unhandled error:`, err);
        return new Response("Internal Server Error", { status: 500 });
      },
    });

    console.log(`[VesselDaemon:${config.vesselId}] listening on port ${config.port}`);

    if (this.discoveryLoop) {
      await this.discoveryLoop.start();
    }

    // Graceful shutdown on SIGTERM (systemd sends this before SIGKILL).
    process.on("SIGTERM", () => { void this.stop(); });
  }

  /** Stop the HTTP server and deregister from discovery-vessel. */
  async stop(): Promise<void> {
    if (this.discoveryLoop) {
      await this.discoveryLoop.stop();
    }
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
    console.log(`[VesselDaemon:${this.config.vesselId}] stopped`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Request handlers
  // ────────────────────────────────────────────────────────────────────────

  private async forwardToResolverServer(req: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const resolvers = (this.resolverServer as unknown as { config: { resolvers: Map<string, ResolverHandler> } }).config.resolvers;

    // Extract pointer type
    const pointerType = extractPointerType(body);
    if (!pointerType) {
      return Response.json({ error: "body.impulse.pointer.type or body.type required" }, { status: 400 });
    }

    const handler = resolvers.get(pointerType);
    if (!handler) {
      return Response.json(
        { error: `no resolver for '${pointerType}'`, registeredTypes: Array.from(resolvers.keys()) },
        { status: 404 },
      );
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });

    try {
      const result = await handler({ body, pointerType, headers });
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  private async handleRunGoal(req: Request, enforceChain: boolean): Promise<Response> {
    let body: Record<string, unknown>;
    try {
      const parsed = await req.json();
      if (typeof parsed !== "object" || parsed === null) throw new Error("body must be an object");
      body = parsed as Record<string, unknown>;
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }

    // D3 guard: non-root invocations (identified by X-Caller-Vessel header)
    // must carry parent_execution_id so credit attribution is preserved.
    const callerVessel = req.headers.get("x-caller-vessel");
    if (enforceChain && callerVessel && !body.parent_execution_id) {
      const selfTrace = {
        id: `guard-${Date.now()}`,
        vessel_id: this.config.vesselId,
        error: "missing parent_execution_id on cross-vessel invocation (D3 guard)",
        caller_vessel: callerVessel,
      };
      console.warn(`[VesselDaemon:${this.config.vesselId}] D3 guard triggered`, selfTrace);
      return Response.json(
        { error: "parent_execution_id required for cross-vessel goal dispatch (D3)", details: selfTrace },
        { status: 400 },
      );
    }

    const templateId = typeof body.templateId === "string" ? body.templateId : undefined;
    const variables = typeof body.variables === "object" && body.variables !== null
      ? (body.variables as Record<string, unknown>)
      : {};
    const parentExecutionId = typeof body.parent_execution_id === "string"
      ? body.parent_execution_id
      : undefined;
    const compositionChain = Array.isArray(body.composition_chain)
      ? (body.composition_chain as string[])
      : [];

    if (!templateId) {
      return Response.json({ error: "templateId is required in /run-goal body" }, { status: 400 });
    }

    // Load the template from the executor's runtime template provider.
    const template = await this.config.executor["runtime"].templateProvider?.getTemplate(templateId) as ActivityTemplate | null | undefined;
    if (!template) {
      return Response.json({ error: `template '${templateId}' not found` }, { status: 404 });
    }

    const opts: ExecuteOptions = {
      variables,
      parentExecutionId,
      compositionChain,
    };

    try {
      const trace = await this.config.executor.execute(template, opts);
      return Response.json({ trace, executionId: trace.id, status: trace.status });
    } catch (err) {
      console.error(`[VesselDaemon:${this.config.vesselId}] /run-goal error:`, err);
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }
}

function extractPointerType(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.impulse === "object" && b.impulse !== null) {
    const imp = b.impulse as Record<string, unknown>;
    if (typeof imp.pointer === "object" && imp.pointer !== null) {
      const ptr = imp.pointer as Record<string, unknown>;
      if (typeof ptr.type === "string") return ptr.type;
    }
  }
  if (typeof b.type === "string") return b.type;
  return undefined;
}
