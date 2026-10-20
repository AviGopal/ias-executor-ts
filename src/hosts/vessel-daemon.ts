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
import { createHash, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { HttpDiscoveryAdapter } from "../adapters/discovery-adapter";
import { FetchAdapter } from "../adapters/fetch-adapter";
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
  /**
   * Mark this vessel as a system-level substrate service (not tenant-scoped).
   * Propagated to DiscoveryRegistrationLoop so the vessel appears in all
   * org-scoped discovery queries. Required for substrate services.
   */
  systemVessel?: boolean;
  /**
   * Shapes this vessel serves that change state, in addition to
   * DEFAULT_MUTATING_SHAPES and every `*_write` shape. A mutating shape is
   * resolved only for a caller mayResolveMutating admits.
   */
  mutatingShapes?: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// AUTHENTICATION IS NOT AUTHORIZATION. /resolve used to hand every request to its
// handler with the headers merely copied, so any caller that could reach a daemon
// (a key from ANY org, or no key at all) could resolve local-tools' shell,
// bounded_shell and fs_* writes. Reads are unchanged here (read authentication is
// a separate step: several fleet callers send no credential for reads today).
// A shape that changes state now needs a principal mayResolveMutating admits:
//   - node-self: the presented ApiKey is this daemon's own config.apiKey, compared
//     in constant time over SHA-256 digests, identity not asked (development-vessel
//     lib/caller-credential.ts makes the same node-self call);
//   - otherwise identity-vessel's POST /v1/auth/resolve (the validator discovery
//     and development-vessel use) must authenticate the key, and its scopes decide.
// FAIL CLOSED: no usable ApiKey or a refused key is 401, an admitted-but-unscoped
// key is 403, identity unreachable, erroring, timing out or unconfigured is 503.
// The handler is never invoked on a refusal and no trace is emitted for it.
//
// MODE (user ruling 2026-10-20, "Report first, enforce by 20:00Z"). The gate runs in
// the per-node mode of a shaped policy row, read at use time, never an env var:
//   - report (the default): every request resolves exactly as before; a call the gate
//     would refuse logs one `[daemon-auth] WOULD-REFUSE` line, an admitted one logs one
//     `[daemon-auth] ADMIT` line;
//   - enforce: refusals are real (`[daemon-auth] REFUSED`).
// The row is development-vessel's pool record daemonAuthPolicy {mode}, the same store and
// the same operator-attested trust-root path as fedIngressAuthPolicy. It counts only when
// read from THIS node's pool (a local-origin, loopback, non-egress producer) and marked
// attested_verified by operator; anything else is unreadable. A readable row always wins
// (writing `report` is the revert). An unreadable, missing or erroring row keeps the
// LAST-KNOWN mode and says so; it never falls back to report once enforce was read. Only a
// daemon that has not yet read a row this process runs in report, so a restart while the
// pool is unreachable reports until the first successful read (start() reads eagerly and a
// failed read is retried after POLICY_RETRY_MS).
// No log line carries a key or any header value; each is one line with a fixed prefix.
// ────────────────────────────────────────────────────────────────────────────

/** Shapes the daemon's vessels serve that change files, git or run commands. code_verify_typecheck
 *  is here because its caller supplies the command (`${bun_cmd} run ${script}`). Output-shape
 *  aliases are listed because discovery-routed resolves arrive under the advertised shape. */
export const DEFAULT_MUTATING_SHAPES: ReadonlySet<string> = new Set([
  "shell", "bash", "bounded_shell", "shellResult",
  "fs_write", "fs_edit", "fileWriteResult", "fileEditResult",
  "git_commit", "gitCommitResult",
  "code_insert_after_line", "codeInsertResult",
  "code_replace_lines", "codeReplaceResult",
  "code_add_import", "codeAddImportResult",
  "code_verify_typecheck", "codeTypecheckResult",
  "scriptRunResult",
]);

export type DaemonPrincipal =
  | { kind: "node-self" }
  | { kind: "key"; scopes: string[]; keyId?: string };

/** THE ONE AUTHORIZATION RULE for mutating shapes. */
export function mayResolveMutating(p: DaemonPrincipal): boolean {
  return p.kind === "node-self" || p.scopes.includes("admin") || p.scopes.includes("tools-exec");
}

export const IDENTITY_TIMEOUT_MS = 5_000;
// identity rate-limits /v1/auth/resolve per (source IP, key prefix), so a positive answer is reused
// for this long (development-vessel's and discovery's TTL). Refusals and errors are never cached.
export const CREDENTIAL_TTL_MS = 60_000;
const CREDENTIAL_CACHE_MAX = 256;

// identity unreachable: further asks within this window answer 503 at once (a report-mode
// walk is not stalled IDENTITY_TIMEOUT_MS per call during an outage).
export const IDENTITY_DOWN_BACKOFF_MS = 10_000;

export type DaemonAuthMode = "report" | "enforce";
export const DAEMON_AUTH_POLICY_SHAPE = "daemonAuthPolicy";
/** A verified policy read is reused this long; a failed read is retried after POLICY_RETRY_MS. */
export const POLICY_TTL_MS = 30_000;
export const POLICY_RETRY_MS = 5_000;

/** The mode from a development-vessel poolImpulse read, ONLY for a verified operator row (fed's
 *  policyFromPoolResponse twin). Anything else (no row, unattested, forged, malformed) is null. */
export function daemonAuthModeFromPoolResponse(j: unknown): DaemonAuthMode | null {
  const rows = (j as { body?: { impulses?: unknown } } | null)?.body?.impulses;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (!row || row["attested_verified"] !== true) return null;
  if ((row["attested"] as { by?: unknown } | undefined)?.by !== "operator") return null;
  const mode = (row["body"] as { mode?: unknown } | undefined)?.mode;
  return mode === "report" || mode === "enforce" ? mode : null;
}

/** A pool producer on THIS node: local origin (a label discovery stamps on any plain registration),
 *  AND a loopback resolve endpoint, AND not the federation egress (a peer's row reached through it). */
function isThisNodesProducer(origin: string | undefined, resolveEndpoint: string): boolean {
  if (origin !== "local") return false;
  try {
    const u = new URL(resolveEndpoint);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    return (host === "127.0.0.1" || host === "localhost" || host === "::1") && !u.pathname.startsWith("/egress");
  } catch { return false; }
}

type CallerAuth =
  | { ok: true; principal: DaemonPrincipal }
  | { ok: false; status: 401 | 503; kind: "none" | "key"; why: string };

/** One log field value: no whitespace or line breaks, bounded. */
const field = (v: unknown): string => String(v ?? "-").replace(/\s+/g, "_").slice(0, 200) || "-";

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

export class VesselDaemon {
  private readonly resolverServer: ResolverServer;
  private readonly discoveryLoop: DiscoveryRegistrationLoop | undefined;
  private server?: ReturnType<typeof Bun.serve>;
  private readonly mutatingShapes: ReadonlySet<string>;
  private readonly validated = new Map<string, { principal: DaemonPrincipal; at: number }>();
  private identityDownUntil = 0;
  private readonly policyDiscovery: HttpDiscoveryAdapter | undefined;
  private lastKnownMode: DaemonAuthMode | null = null;
  private policyCheckedAt = Number.NEGATIVE_INFINITY;
  private policyReadOk = false;
  private policyInflight: Promise<DaemonAuthMode> | null = null;
  private readonly node = hostname();

  constructor(private readonly config: VesselDaemonConfig) {
    this.mutatingShapes = new Set([...DEFAULT_MUTATING_SHAPES, ...(config.mutatingShapes ?? [])]);
    this.policyDiscovery = config.discoveryEndpoint
      ? new HttpDiscoveryAdapter(new FetchAdapter(), config.discoveryEndpoint, config.apiKey ? { apiKey: config.apiKey } : {})
      : undefined;
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
        ...(config.systemVessel ? { systemVessel: true } : {}),
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
    void this.authMode();

    if (this.discoveryLoop) {
      await this.discoveryLoop.start();
    }

    // Graceful shutdown on SIGTERM (systemd sends this before SIGKILL).
    process.on("SIGTERM", () => { void this.stop(); });
  }

  /** Stop the HTTP server and deregister from discovery-vessel. */
  public async setShapes(shapes: string[]): Promise<void> {
    await this.discoveryLoop?.setShapes(shapes);
  }

  async stop(): Promise<void> {
    if (this.discoveryLoop) {
      await this.discoveryLoop.stop();
    }
    if (this.server) {
      // BOUNDED DRAIN (2026-08-05). This was `this.server.stop(true)`, and in Bun the `true`
      // means CLOSE EVERY ACTIVE CONNECTION IMMEDIATELY. start() wires this to SIGTERM, so every
      // vessel on the shared daemon destroyed its in-flight work the instant systemd asked it to
      // stop. No vessel could drain, and raising a unit's TimeoutStopSec bought nothing because
      // the force-close happened first.
      //
      // That is what made restarts destructive rather than merely disruptive. development-vessel
      // hosts feature_compose, whose runs take 5-8 MINUTES, and edit-intent goals are excluded
      // from goal-host's auto-resume (index.ts:10315) because re-running a partially applied edit
      // could double-apply it — so a killed compose is PERMANENT loss. Measured tonight: the
      // compose drafting a grounding-evidence edit died mid-run and pull-sync later reaped its
      // orphan, "REAPING leaked authoring marker patch_with_tools-activity-api.json (pid DEAD)",
      // after development-vessel restarted under a cutover triggered by an earlier edit. Landed
      // edits were killing the edits that followed them.
      //
      // Order matters. Deregister from discovery FIRST (above) so no new work routes here, then
      // stop accepting new connections while leaving in-flight requests alive, then wait on the
      // server's own pendingRequests counter. Force-close stays as the BACKSTOP it should always
      // have been, not the normal path.
      //
      // The budget must sit UNDER the unit's TimeoutStopSec or systemd's SIGKILL lands first and
      // the drain can never complete — the same by-construction defect as a caller timeout below
      // its callee's floor. The paired drop-ins set 300s stop against this 240s default, leaving
      // headroom for deregistration and the backstop. Note the llm-resolver arms run
      // TimeoutStopSec=15, so VESSEL_DRAIN_MS must be set below that for those units.
      const server = this.server;
      this.server = undefined;
      const parsed = Number.parseInt(process.env["VESSEL_DRAIN_MS"] ?? "", 10);
      const drainMs = Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
      void server.stop(false);
      const pending = server.pendingRequests;
      if (pending > 0) {
        console.log(`[VesselDaemon:${this.config.vesselId}] draining ${pending} in-flight request(s), budget ${Math.round(drainMs / 1000)}s`);
      }
      const deadline = Date.now() + drainMs;
      while (server.pendingRequests > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const left = server.pendingRequests;
      if (left > 0) {
        console.warn(`[VesselDaemon:${this.config.vesselId}] drain budget exhausted with ${left} request(s) still in flight — force-closing`);
      } else if (pending > 0) {
        console.log(`[VesselDaemon:${this.config.vesselId}] drained cleanly`);
      }
      await server.stop(true);
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

    if (this.isMutatingShape(pointerType)) {
      const refusal = await this.mutatingRefusal(pointerType, req.headers.get("authorization") ?? undefined);
      if (refusal) return refusal;
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

    const startedAt = Date.now();
    try {
      const result = await handler({ body, pointerType, headers });
      // Fire-and-forget trace emission. Triggers an `impulse.resolved`-equivalent
      // WS event (we use `task.completed` shape because that's what concept-db's
      // ExecutionObserver currently filters on; see openspec 2026-05-23
      // substrate-explicit-vessels and concept-db/src/services/execution-observer.ts).
      this.emitResolveTrace({
        pointerType,
        result,
        latencyMs: Date.now() - startedAt,
        success: !(result && typeof result === "object" && "error" in (result as Record<string, unknown>)),
      });
      return Response.json(result);
    } catch (err) {
      this.emitResolveTrace({
        pointerType,
        result: { error: (err as Error).message },
        latencyMs: Date.now() - startedAt,
        success: false,
      });
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  /** The gate for a mutating shape: a refusal Response under enforce, or null to resolve as before. */
  private async mutatingRefusal(shape: string, authHeader: string | undefined): Promise<Response | null> {
    const auth = await this.authenticateCaller(authHeader);
    const mode = await this.authMode();
    let status: 401 | 403 | 503 | 0 = 0;
    let why = "";
    let kind: "node-self" | "key" | "none";
    let scopes = "-";
    let keyId = "-";
    if (!auth.ok) {
      status = auth.status; why = auth.why; kind = auth.kind;
    } else {
      const p = auth.principal;
      kind = p.kind;
      if (p.kind === "key") { scopes = p.scopes.join(",") || "none"; keyId = p.keyId ?? "-"; }
      if (!mayResolveMutating(p)) { status = 403; why = "the credential lacks the admin or tools-exec scope"; }
    }
    const fields = `node=${field(this.node)} vessel=${field(this.config.vesselId)} shape=${field(shape)} mode=${mode}`;
    const who = `principal_kind=${kind} scopes=${field(scopes)} key_id=${field(keyId)}`;
    if (status === 0) {
      if (mode === "report") console.log(`[daemon-auth] ADMIT ${fields} ${who}`);
      return null;
    }
    const tag = mode === "enforce" ? "REFUSED" : "WOULD-REFUSE";
    console.warn(`[daemon-auth] ${tag} ${fields} would_status=${status} ${who} why=${field(why)}`);
    if (mode !== "enforce") return null;
    return Response.json({ error: `'${shape}' changes state: ${why}` }, { status });
  }

  /** The node's gate mode: the last verified daemonAuthPolicy read, refreshed every POLICY_TTL_MS. */
  private async authMode(): Promise<DaemonAuthMode> {
    const ttl = this.policyReadOk ? POLICY_TTL_MS : POLICY_RETRY_MS;
    if (Date.now() - this.policyCheckedAt < ttl) return this.lastKnownMode ?? "report";
    if (!this.policyInflight) {
      this.policyInflight = (async () => {
        const r = await this.readPolicy();
        this.policyCheckedAt = Date.now();
        this.policyReadOk = r.ok;
        if (r.ok) {
          if (r.mode !== this.lastKnownMode) console.log(`[daemon-auth] MODE node=${field(this.node)} vessel=${field(this.config.vesselId)} mode=${r.mode} was=${this.lastKnownMode ?? "unread"}`);
          this.lastKnownMode = r.mode;
        } else {
          console.warn(`[daemon-auth] POLICY-UNREADABLE node=${field(this.node)} vessel=${field(this.config.vesselId)} keeping=${this.lastKnownMode ?? "report(never-read)"} why=${field(r.why)}`);
        }
        return this.lastKnownMode ?? "report";
      })().finally(() => { this.policyInflight = null; });
    }
    return this.policyInflight;
  }

  private async readPolicy(): Promise<{ ok: true; mode: DaemonAuthMode } | { ok: false; why: string }> {
    if (!this.policyDiscovery) return { ok: false, why: "no discovery endpoint configured" };
    try {
      const look = await this.policyDiscovery.lookup("poolImpulse");
      if (!look.ok) return { ok: false, why: this.policyDiscovery.describe(look) };
      const local = look.producers.find((p) => isThisNodesProducer(p.origin, p.resolveEndpoint));
      if (!local) return { ok: false, why: `no local poolImpulse producer (${look.producers.length} other)` };
      const res = await fetch(local.resolveEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.config.apiKey ? { Authorization: `ApiKey ${this.config.apiKey}` } : {}) },
        body: JSON.stringify({ impulse: { pointer: { type: "poolImpulse", shape: DAEMON_AUTH_POLICY_SHAPE, status: "open", limit: 1 } } }),
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, why: `pool answered HTTP ${res.status}` };
      const mode = daemonAuthModeFromPoolResponse(await res.json());
      return mode ? { ok: true, mode } : { ok: false, why: "no open operator-attested verified daemonAuthPolicy row" };
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      console.warn(`[daemon-auth] POLICY-READ-ERROR node=${field(this.node)} vessel=${field(this.config.vesselId)} why=${field(detail)}`);
      return { ok: false, why: detail };
    }
  }

  private isMutatingShape(pointerType: string): boolean {
    return pointerType.endsWith("_write") || this.mutatingShapes.has(pointerType);
  }

  /** Who is calling, for a mutating shape. Reads `Authorization: ApiKey <key>` only. */
  private async authenticateCaller(authHeader: string | undefined): Promise<CallerAuth> {
    const m = /^ApiKey\s+(\S+)$/i.exec(String(authHeader ?? "").trim());
    if (!m) return { ok: false, status: 401, kind: "none", why: authHeader ? "Authorization is not one ApiKey credential" : "no Authorization header" };
    const presented = m[1]!;
    const own = this.config.apiKey ?? "";
    if (own && timingSafeEqual(sha256(presented), sha256(own))) return { ok: true, principal: { kind: "node-self" } };

    const k = sha256(presented).toString("hex");
    const hit = this.validated.get(k);
    if (hit && Date.now() - hit.at < CREDENTIAL_TTL_MS) return { ok: true, principal: hit.principal };
    if (hit) this.validated.delete(k);

    const base = (process.env["IDENTITY_VESSEL_URL"] ?? "").trim().replace(/\/+$/, "");
    if (!base) return { ok: false, status: 503, kind: "key", why: "IDENTITY_VESSEL_URL unset: identity cannot be asked" };
    if (Date.now() < this.identityDownUntil) return { ok: false, status: 503, kind: "key", why: "identity unreachable (backing off)" };
    let res: Response;
    try {
      res = await fetch(`${base}/v1/auth/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ impulse: { type: "authentication", pointer: { type: "apiKey", apiKey: presented } } }),
        signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      });
    } catch (err) {
      const detail = String((err as Error)?.message ?? err);
      this.identityDownUntil = Date.now() + IDENTITY_DOWN_BACKOFF_MS;
      console.error(`[daemon-auth] IDENTITY-UNAVAILABLE node=${field(this.node)} vessel=${field(this.config.vesselId)} why=${field(detail)}`);
      return { ok: false, status: 503, kind: "key", why: `identity unreachable: ${detail}` };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, status: 401, kind: "key", why: `identity refused the credential (HTTP ${res.status})` };
    if (!res.ok) return { ok: false, status: 503, kind: "key", why: `identity answered HTTP ${res.status}` };
    let j: { data?: { authenticated?: unknown; scopes?: unknown; keyId?: unknown; key_id?: unknown } };
    try {
      j = (await res.json()) as typeof j;
    } catch (err) {
      console.error(`[daemon-auth] IDENTITY-UNAVAILABLE node=${field(this.node)} vessel=${field(this.config.vesselId)} why=${field("answer not JSON: " + String((err as Error)?.message ?? err))}`);
      return { ok: false, status: 503, kind: "key", why: "identity answer was not JSON" };
    }
    if (j?.data?.authenticated !== true) return { ok: false, status: 401, kind: "key", why: "credential not authenticated" };
    const scopes = Array.isArray(j.data.scopes) ? j.data.scopes.map(String) : [];
    const rawKeyId = j.data.keyId ?? j.data.key_id;
    const principal: DaemonPrincipal = { kind: "key", scopes, ...(typeof rawKeyId === "string" && rawKeyId ? { keyId: rawKeyId } : {}) };
    this.validated.set(k, { principal, at: Date.now() });
    while (this.validated.size > CREDENTIAL_CACHE_MAX) {
      const oldest = this.validated.keys().next().value;
      if (oldest === undefined) break;
      this.validated.delete(oldest);
    }
    return { ok: true, principal };
  }

  /**
   * Fire-and-forget emission to activity-api's neutral event bus so that
   * standalone /resolve hits (no surrounding goal execution) still produce a
   * WS event visible to substrate-wide observers (concept-db, dashboard,
   * ribosome, etc.). Disabled when activityApiEndpoint or apiKey is absent.
   *
   * Non-blocking: errors are logged via console.error but never thrown.
   */
  private emitResolveTrace(args: {
    pointerType: string;
    result: unknown;
    latencyMs: number;
    success: boolean;
  }): void {
    const { activityApiEndpoint, apiKey, vesselId } = this.config;
    if (!activityApiEndpoint || !apiKey) return;

    const { pointerType, result, latencyMs, success } = args;
    const ts = Date.now();
    // Synthesize ids so the event is self-consistent even though no
    // persisted execution row exists. Observers key off shape/impulse_id,
    // not execution_id, so a synthetic id is acceptable.
    const executionId = `resolve-${vesselId}-${ts}`;
    const taskId = `resolve-${pointerType}-${ts}`;
    const impulseId = `impulse:${pointerType}:${ts}`;

    // Pull shape from resolver result when available; otherwise use pointer type.
    let shape: string = pointerType;
    if (result && typeof result === "object") {
      const candidate = (result as Record<string, unknown>).shape;
      if (typeof candidate === "string" && candidate.length > 0) {
        shape = candidate;
      }
    }

    // task.completed payload mirrors what activity-api's broadcaster emits
    // during full goal execution; observer code in concept-db already knows
    // how to parse this shape.
    const data = {
      execution_id: executionId,
      task_id: taskId,
      task_index: 0,
      success,
      duration_ms: latencyMs,
      completed_at: new Date(ts).toISOString(),
      input_impulse_ids: [] as string[],
      output_impulse_ids: success ? [impulseId] : [],
      impulse_resolutions: [{
        impulse_id: impulseId,
        resolver_id: pointerType,
        resolver_tier: "deterministic" as const,
        vessel_id: vesselId,
        shape,
        latency_ms: latencyMs,
        cost_usd: 0,
      }],
      source: "vessel_daemon_resolve",
    };

    // Activity-api's /v2/events/publish accepts <source>.<noun>.<verb> form.
    // `task.completed` matches its regex and dispatches the standard
    // task.completed WS message that concept-db's ExecutionObserver consumes.
    const payload = {
      type: "task.completed",
      source_vessel_id: vesselId,
      scope: "broadcast",
      data,
    };

    const url = `${activityApiEndpoint.replace(/\/+$/, "")}/v2/events/publish`;

    // Detached promise; never awaited. Bun's fetch returns a Promise that
    // would otherwise hold the event loop, so we attach a no-op .catch and
    // discard the handle deliberately.
    void fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `ApiKey ${apiKey}`,
      },
      body: JSON.stringify(payload),
    }).catch((err: unknown) => {
      console.error(
        `[VesselDaemon:${vesselId}] trace emit failed (non-fatal):`,
        (err as Error)?.message ?? err,
      );
    });
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
