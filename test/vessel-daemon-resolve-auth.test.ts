// VesselDaemon /resolve: a shape that changes state needs an authorized caller.
//
// The defect: forwardToResolverServer copied the request headers and checked nothing,
// so a key from any org, or no key at all, could resolve local-tools' shell and fs_*
// writes. These tests drive the daemon's /resolve routing in-process (no port, no
// network). identity-vessel, discovery and this node's pool (the daemonAuthPolicy row)
// are stubbed through globalThis.fetch.
//
// The gate runs in the node's mode (user ruling 2026-10-20, report first, enforce by
// 20:00Z): `enforce` refuses, `report` resolves exactly as before and logs what it would
// have refused. The refusal cases run under an operator-attested enforce row.
// MUST-FAIL at the parent: every enforce refusal asserts BOTH the status and that the
// handler was never invoked; the parent invokes it and answers 200.
import { describe, it, expect, beforeEach, afterEach, setSystemTime, spyOn } from "bun:test";
import * as daemonModule from "../src/hosts/vessel-daemon";
import { VesselDaemon } from "../src/hosts/vessel-daemon";
import type { ResolverHandler } from "../src/hosts/vessel-daemon";
import type { ActivityExecutor } from "../src/engine";

// Read through the namespace so this file still LOADS at the parent (where neither exists) and its
// cases fail on their assertions, not on an import error.
const CREDENTIAL_TTL_MS: number = (daemonModule as Record<string, unknown>)["CREDENTIAL_TTL_MS"] as number ?? 60_000;
const POLICY_TTL_MS: number = (daemonModule as Record<string, unknown>)["POLICY_TTL_MS"] as number ?? 30_000;

const NODE_KEY = "node-own-key-for-tests";
const IDENTITY = "http://identity.test";
const DISCOVERY = "http://127.0.0.1:8100";
const POOL = "http://127.0.0.1:8090/v2/impulses/resolve";

const originalFetch = globalThis.fetch;
const originalIdentity = process.env["IDENTITY_VESSEL_URL"];

let invoked: string[] = [];
let identityCalls = 0;
let poolReads = 0;
let lines: string[] = [];
let spies: Array<ReturnType<typeof spyOn>> = [];

// What this node's pool answers for daemonAuthPolicy.
type PoolState = { mode?: "report" | "enforce" | "bogus"; verified?: boolean; by?: string; up?: boolean; producers?: Array<Record<string, unknown>> };
let pool: PoolState = {};

const authenticated = (scopes: string[], orgId: string) =>
  Response.json({ success: true, data: { authenticated: true, orgId, userId: "user-test", keyId: "kid-test", scopes } });

// Keys the stubbed identity knows: the scopes and org each carries.
const KEYS: Record<string, { scopes: string[]; org: string }> = {
  "key-admin": { scopes: ["read", "write", "admin"], org: "org-node" },
  "key-tools-exec": { scopes: ["read", "write", "tools-exec"], org: "org-node" },
  "key-read-write": { scopes: ["read", "write"], org: "org-node" },
  // A tenant of ANOTHER org: identity authenticates it, with the default scopes every issued key gets.
  "key-other-org": { scopes: ["read", "write"], org: "org-elsewhere" },
};
let identityAnswer: (apiKey: string) => Response | Promise<Response> = () => new Response("unset", { status: 500 });
const defaultIdentity = (k: string) => (KEYS[k] ? authenticated(KEYS[k]!.scopes, KEYS[k]!.org) : Response.json({ success: false, error: { code: "AUTHENTICATION_FAILED" } }, { status: 401 }));

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
    if (url === `${IDENTITY}/v1/auth/resolve`) {
      identityCalls++;
      return identityAnswer(body?.impulse?.pointer?.apiKey ?? "");
    }
    if (url === `${DISCOVERY}/resolve` && body?.pointer?.type === "vesselCapability" && body?.pointer?.shape === "poolImpulse") {
      return Response.json({ vessels: pool.producers ?? [{ id: "development-vessel", resolve_endpoint: POOL, origin: "local" }] });
    }
    if (url.startsWith("http://127.0.0.1:8090/") || url.startsWith("http://127.0.0.1:8401/")) {
      poolReads++;
      if (pool.up === false) throw new TypeError("connect ECONNREFUSED");
      const impulses = pool.mode
        ? [{ id: "daemonAuthPolicy", shape: "daemonAuthPolicy", status: "open", body: { mode: pool.mode }, attested_verified: pool.verified ?? true, attested: { by: pool.by ?? "operator", key_id: "kid-operator" } }]
        : [];
      return Response.json({ shape: "poolImpulse", body: { impulses } });
    }
    return new Response("unexpected fetch", { status: 599 });
  }) as unknown as typeof fetch;
}

const HANDLER_RESULT = (name: string) => ({ shape: name, ok: true, stdout: "unchanged", n: 1 });

function makeDaemon(opts: { mutatingShapes?: string[]; noDiscovery?: boolean } = {}): VesselDaemon {
  const handler = (name: string): ResolverHandler => async () => {
    invoked.push(name);
    return HANDLER_RESULT(name);
  };
  const resolvers = new Map<string, ResolverHandler>(
    ["shellResult", "shell", "fs_write", "git_commit", "fs_read", "fileContent", "llmModelPolicy_write", "declared_mutator"].map((n) => [n, handler(n)]),
  );
  return new VesselDaemon({
    port: 0,
    vesselId: "test-daemon",
    vesselName: "Test Daemon",
    shapes: Array.from(resolvers.keys()),
    executor: {} as ActivityExecutor,
    resolvers,
    apiKey: NODE_KEY,
    enforceCompositionChain: false,
    ...(opts.noDiscovery ? {} : { discoveryEndpoint: DISCOVERY }),
    ...(opts.mutatingShapes ? { mutatingShapes: opts.mutatingShapes } : {}),
  });
}

async function resolve(daemon: VesselDaemon, type: string, authorization?: string): Promise<Response> {
  const req = new Request("http://daemon.test/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify({ impulse: { pointer: { type, command: "true", path: "/tmp/x", content: "x" } } }),
  });
  return (daemon as unknown as { forwardToResolverServer(r: Request): Promise<Response> }).forwardToResolverServer(req);
}

const tagged = (tag: string) => lines.filter((l) => l.startsWith(`[daemon-auth] ${tag} `));

beforeEach(() => {
  invoked = [];
  identityCalls = 0;
  poolReads = 0;
  lines = [];
  pool = { mode: "enforce" };
  identityAnswer = defaultIdentity;
  process.env["IDENTITY_VESSEL_URL"] = IDENTITY;
  installFetch();
  spies = (["log", "warn", "error"] as const).map((m) =>
    spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }),
  );
});

afterEach(() => {
  setSystemTime();
  for (const s of spies) s.mockRestore();
  globalThis.fetch = originalFetch;
  if (originalIdentity === undefined) delete process.env["IDENTITY_VESSEL_URL"];
  else process.env["IDENTITY_VESSEL_URL"] = originalIdentity;
});

const GUARDED = ["shell", "fs_write", "git_commit"];

describe("ENFORCE: /resolve refuses mutating shapes to unauthorized callers (MUST-FAIL at parent)", () => {
  for (const shape of GUARDED) {
    it(`an authenticated OTHER-ORG key (scopes read,write) is 403 on ${shape}, handler not invoked`, async () => {
      const res = await resolve(makeDaemon(), shape, "ApiKey key-other-org");
      expect(res.status).toBe(403);
      expect(identityCalls).toBe(1);
      expect(invoked).toEqual([]);
    });

    it(`no key is 401 on ${shape}, identity not asked, handler not invoked`, async () => {
      const res = await resolve(makeDaemon(), shape);
      expect(res.status).toBe(401);
      expect(identityCalls).toBe(0);
      expect(invoked).toEqual([]);
    });
  }

  it("no Authorization header on shellResult (the advertised alias) is 401, handler not invoked", async () => {
    const res = await resolve(makeDaemon(), "shellResult");
    expect(res.status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it("a non-ApiKey scheme on shell is 401, identity not asked, handler not invoked", async () => {
    const res = await resolve(makeDaemon(), "shell", `Bearer ${NODE_KEY}`);
    expect(res.status).toBe(401);
    expect(identityCalls).toBe(0);
    expect(invoked).toEqual([]);
  });

  it("a key identity refuses is 401 on shell, handler not invoked", async () => {
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-from-nowhere");
    expect(res.status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it("a valid read,write key (any org's default scopes) is 403 on shellResult, handler not invoked", async () => {
    const res = await resolve(makeDaemon(), "shellResult", "ApiKey key-read-write");
    expect(res.status).toBe(403);
    expect(invoked).toEqual([]);
  });

  it("every *_write shape is gated: read,write key is 403 on llmModelPolicy_write, handler not invoked", async () => {
    const res = await resolve(makeDaemon(), "llmModelPolicy_write", "ApiKey key-read-write");
    expect(res.status).toBe(403);
    expect(invoked).toEqual([]);
  });

  it("a shape the vessel declares mutating is gated: no header is 401, handler not invoked", async () => {
    const res = await resolve(makeDaemon({ mutatingShapes: ["declared_mutator"] }), "declared_mutator");
    expect(res.status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it("identity unreachable is 503 on fs_write (fail closed), handler not invoked", async () => {
    identityAnswer = () => { throw new TypeError("connect ECONNREFUSED"); };
    const res = await resolve(makeDaemon(), "fs_write", "ApiKey key-admin");
    expect(res.status).toBe(503);
    expect(invoked).toEqual([]);
  });

  it("identity timing out is 503 on shell, handler not invoked", async () => {
    identityAnswer = () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-admin");
    expect(res.status).toBe(503);
    expect(invoked).toEqual([]);
  });

  it("identity answering 5xx is 503 on shell, handler not invoked", async () => {
    identityAnswer = () => new Response("boom", { status: 500 });
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-admin");
    expect(res.status).toBe(503);
    expect(invoked).toEqual([]);
  });

  it("IDENTITY_VESSEL_URL unset is 503 for a non-node key on shell, handler not invoked", async () => {
    delete process.env["IDENTITY_VESSEL_URL"];
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-admin");
    expect(res.status).toBe(503);
    expect(identityCalls).toBe(0);
    expect(invoked).toEqual([]);
  });

  it("identity unreachable backs off: a second call within the window is 503 without asking again", async () => {
    identityAnswer = () => { throw new TypeError("connect ECONNREFUSED"); };
    const d = makeDaemon();
    expect((await resolve(d, "shell", "ApiKey key-admin")).status).toBe(503);
    expect((await resolve(d, "shell", "ApiKey key-tools-exec")).status).toBe(503);
    expect(identityCalls).toBe(1);
    expect(invoked).toEqual([]);
    expect(tagged("IDENTITY-UNAVAILABLE")).toHaveLength(1);
  });

  it("each enforce refusal logs exactly one REFUSED line with its status", async () => {
    const d = makeDaemon();
    await resolve(d, "shell");
    await resolve(d, "fs_write", "ApiKey key-other-org");
    const refused = tagged("REFUSED");
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain("would_status=401");
    expect(refused[0]).toContain("principal_kind=none");
    expect(refused[1]).toContain("would_status=403");
    expect(refused[1]).toContain("principal_kind=key");
    expect(refused[1]).toContain("key_id=kid-test");
    expect(tagged("WOULD-REFUSE")).toHaveLength(0);
  });
});

describe("ENFORCE: authorized callers are admitted (controls)", () => {
  it("node-self (the daemon's own key) runs shellResult without asking identity", async () => {
    const res = await resolve(makeDaemon(), "shellResult", `ApiKey ${NODE_KEY}`);
    expect(res.status).toBe(200);
    expect(identityCalls).toBe(0);
    expect(invoked).toEqual(["shellResult"]);
  });

  it("node-self still works when identity is unreachable", async () => {
    identityAnswer = () => { throw new TypeError("connect ECONNREFUSED"); };
    const res = await resolve(makeDaemon(), "fs_write", `ApiKey ${NODE_KEY}`);
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["fs_write"]);
  });

  it("an admin-scoped key runs shell", async () => {
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-admin");
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["shell"]);
  });

  it("a tools-exec-scoped key (goal-host's per-vessel key) runs shell", async () => {
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-tools-exec");
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["shell"]);
  });

  it("a tools-exec-scoped key runs fs_write", async () => {
    const res = await resolve(makeDaemon(), "fs_write", "ApiKey key-tools-exec");
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["fs_write"]);
  });

  it("the node key runs git_commit", async () => {
    const res = await resolve(makeDaemon(), "git_commit", `ApiKey ${NODE_KEY}`);
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["git_commit"]);
  });

  it("a read,write key is allowed on a read shape (fs_read) and identity is not asked", async () => {
    const res = await resolve(makeDaemon(), "fs_read", "ApiKey key-read-write");
    expect(res.status).toBe(200);
    expect(identityCalls).toBe(0);
    expect(invoked).toEqual(["fs_read"]);
  });

  it("reads are unchanged: an other-org key on a read shape resolves, identity not asked", async () => {
    const res = await resolve(makeDaemon(), "fileContent", "ApiKey key-other-org");
    expect(res.status).toBe(200);
    expect(identityCalls).toBe(0);
    expect(invoked).toEqual(["fileContent"]);
  });

  it("reads are unchanged: a read shape with no header still resolves", async () => {
    const res = await resolve(makeDaemon(), "fileContent");
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["fileContent"]);
  });

  it("a positive identity answer is reused within the TTL (identity asked once for two writes)", async () => {
    const d = makeDaemon();
    expect((await resolve(d, "shell", "ApiKey key-admin")).status).toBe(200);
    expect((await resolve(d, "fs_write", "ApiKey key-admin")).status).toBe(200);
    expect(identityCalls).toBe(1);
    expect(invoked).toEqual(["shell", "fs_write"]);
  });

  it("an admitted entry older than CREDENTIAL_TTL_MS is re-asked of identity, not served from cache", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "shell", "ApiKey key-admin")).status).toBe(200);
    expect(identityCalls).toBe(1);
    setSystemTime(new Date(t0 + CREDENTIAL_TTL_MS - 1));
    expect((await resolve(d, "shell", "ApiKey key-admin")).status).toBe(200);
    expect(identityCalls).toBe(1);
    setSystemTime(new Date(t0 + CREDENTIAL_TTL_MS + 1));
    expect((await resolve(d, "shell", "ApiKey key-admin")).status).toBe(200);
    expect(identityCalls).toBe(2);
  });

  it("past the TTL a key identity now refuses (revoked or rotated) loses mutating access", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "fs_write", "ApiKey key-admin")).status).toBe(200);
    identityAnswer = () => Response.json({ success: false, error: { code: "REVOKED_API_KEY" } }, { status: 401 });
    setSystemTime(new Date(t0 + CREDENTIAL_TTL_MS + 1));
    const res = await resolve(d, "fs_write", "ApiKey key-admin");
    expect(res.status).toBe(401);
    expect(identityCalls).toBe(2);
    expect(invoked).toEqual(["fs_write"]);
  });
});

describe("REPORT: resolves exactly as today and logs what enforce would refuse", () => {
  const cases: Array<[string, string | undefined, number]> = [
    ["shell", undefined, 401],
    ["fs_write", "ApiKey key-other-org", 403],
    ["git_commit", "ApiKey key-from-nowhere", 401],
  ];
  for (const [shape, auth, would] of cases) {
    it(`MUST-FAIL (mode): a report row does NOT refuse ${shape} (${would} under enforce); the result is byte-identical`, async () => {
      pool = { mode: "report" };
      const res = await resolve(makeDaemon(), shape, auth);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(JSON.stringify(HANDLER_RESULT(shape)));
      expect(invoked).toEqual([shape]);
      const w = tagged("WOULD-REFUSE");
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(`shape=${shape}`);
      expect(w[0]).toContain(`would_status=${would}`);
      expect(w[0]).toContain("vessel=test-daemon");
      expect(w[0]).toContain("node=");
      expect(tagged("REFUSED")).toHaveLength(0);
    });

    it(`MUST-FAIL (mode): the same call under an enforce row IS refused ${would}`, async () => {
      pool = { mode: "enforce" };
      const res = await resolve(makeDaemon(), shape, auth);
      expect(res.status).toBe(would);
      expect(invoked).toEqual([]);
    });
  }

  it("a node that has never read a row (no row) runs in report", async () => {
    pool = {};
    const res = await resolve(makeDaemon(), "shell");
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["shell"]);
    expect(tagged("WOULD-REFUSE")).toHaveLength(1);
    expect(tagged("POLICY-UNREADABLE")[0]).toContain("keeping=report(never-read)");
  });

  it("identity down in report mode: 503 would-refuse logged, the call still resolves", async () => {
    pool = { mode: "report" };
    identityAnswer = () => { throw new TypeError("connect ECONNREFUSED"); };
    const res = await resolve(makeDaemon(), "shell", "ApiKey key-admin");
    expect(res.status).toBe(200);
    expect(invoked).toEqual(["shell"]);
    expect(tagged("WOULD-REFUSE")[0]).toContain("would_status=503");
  });

  it("an admitted mutating call logs one ADMIT line (node-self, and a key with key_id and scopes)", async () => {
    pool = { mode: "report" };
    const d = makeDaemon();
    await resolve(d, "shell", `ApiKey ${NODE_KEY}`);
    await resolve(d, "fs_write", "ApiKey key-tools-exec");
    await resolve(d, "fs_read", "ApiKey key-tools-exec");
    const a = tagged("ADMIT");
    expect(a).toHaveLength(2);
    expect(a[0]).toContain("principal_kind=node-self");
    expect(a[0]).toContain("shape=shell");
    expect(a[1]).toContain("principal_kind=key");
    expect(a[1]).toContain("key_id=kid-test");
    expect(a[1]).toContain("scopes=read,write,tools-exec");
  });

  it("enforce admits are not logged per call", async () => {
    await resolve(makeDaemon(), "shell", `ApiKey ${NODE_KEY}`);
    expect(tagged("ADMIT")).toHaveLength(0);
  });
});

describe("the mode row: verified, local, and never silently downgraded", () => {
  it("MUST-FAIL: after reading enforce, an unreachable pool keeps ENFORCE (never falls back to report)", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "shell")).status).toBe(401);
    pool = { up: false };
    setSystemTime(new Date(t0 + POLICY_TTL_MS + 1));
    const res = await resolve(d, "shell");
    expect(res.status).toBe(401);
    expect(invoked).toEqual([]);
    expect(poolReads).toBe(2);
    expect(tagged("POLICY-UNREADABLE").some((l) => l.includes("keeping=enforce"))).toBe(true);
  });

  it("after reading enforce, a missing row keeps enforce", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "shell")).status).toBe(401);
    pool = {};
    setSystemTime(new Date(t0 + POLICY_TTL_MS + 1));
    expect((await resolve(d, "shell")).status).toBe(401);
  });

  it("after reading enforce, a FORGED (unverified) report row keeps enforce", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "shell")).status).toBe(401);
    pool = { mode: "report", verified: false };
    setSystemTime(new Date(t0 + POLICY_TTL_MS + 1));
    expect((await resolve(d, "shell")).status).toBe(401);
    pool = { mode: "report", by: "runner" };
    setSystemTime(new Date(t0 + 2 * POLICY_TTL_MS + 2));
    expect((await resolve(d, "shell")).status).toBe(401);
    expect(invoked).toEqual([]);
  });

  it("the revert path: a verified operator `report` row written after enforce switches back to report", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "shell")).status).toBe(401);
    pool = { mode: "report" };
    setSystemTime(new Date(t0 + POLICY_TTL_MS + 1));
    expect((await resolve(d, "shell")).status).toBe(200);
    expect(tagged("MODE").some((l) => l.includes("mode=report") && l.includes("was=enforce"))).toBe(true);
  });

  it("the mode is cached for POLICY_TTL_MS: two calls inside it read the pool once", async () => {
    const d = makeDaemon();
    await resolve(d, "shell");
    await resolve(d, "fs_write");
    expect(poolReads).toBe(1);
  });

  it("an unverified enforce row on a never-read node is unreadable: report", async () => {
    pool = { mode: "enforce", verified: false };
    expect((await resolve(makeDaemon(), "shell")).status).toBe(200);
  });

  it("a malformed mode is unreadable: report on a never-read node", async () => {
    pool = { mode: "bogus" };
    expect((await resolve(makeDaemon(), "shell")).status).toBe(200);
  });

  it("a PEER's pool row is not this node's policy: a non-local producer is unreadable (report)", async () => {
    pool = { mode: "enforce", producers: [{ id: "development-vessel", resolve_endpoint: POOL, origin: "peer" }] };
    expect((await resolve(makeDaemon(), "shell")).status).toBe(200);
    expect(poolReads).toBe(0);
  });

  it("a row reached through the federation egress (loopback, but a peer's) is unreadable (report)", async () => {
    pool = { mode: "enforce", producers: [{ id: "development-vessel", protocol: "libp2p", libp2p_multiaddr: ["/ip4/10.0.0.1/tcp/1/p2p/QmPeer"], origin: "local" }] };
    expect((await resolve(makeDaemon(), "shell")).status).toBe(200);
    expect(poolReads).toBe(0);
  });

  it("a daemon with no discovery endpoint never reads a row: report", async () => {
    expect((await resolve(makeDaemon({ noDiscovery: true }), "shell")).status).toBe(200);
  });
});

describe("the MODE line says why", () => {
  const modeLines = () => tagged("MODE");
  it("a pool unreachable from the start reports with reason=never-read", async () => {
    pool = { up: false };
    expect((await resolve(makeDaemon(), "shell")).status).toBe(200);
    const m = modeLines();
    expect(m).toHaveLength(1);
    expect(m[0]).toContain("mode=report reason=never-read");
  });

  it("a verified report row reports with reason=row (a deliberate report, distinguishable from never-read)", async () => {
    pool = { mode: "report" };
    expect((await resolve(makeDaemon(), "shell")).status).toBe(200);
    expect(modeLines()).toHaveLength(1);
    expect(modeLines()[0]).toContain("mode=report reason=row");
  });

  it("enforce read, then the pool unreachable: mode=enforce reason=last-known", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    expect((await resolve(d, "shell")).status).toBe(401);
    pool = { up: false };
    setSystemTime(new Date(t0 + POLICY_TTL_MS + 1));
    expect((await resolve(d, "shell")).status).toBe(401);
    const m = modeLines();
    expect(m).toHaveLength(2);
    expect(m[0]).toContain("mode=enforce reason=row");
    expect(m[1]).toContain("mode=enforce reason=last-known");
  });

  it("an unchanged mode and reason logs no further MODE line", async () => {
    const t0 = new Date("2026-01-01T00:00:00Z").getTime();
    setSystemTime(new Date(t0));
    const d = makeDaemon();
    await resolve(d, "shell");
    setSystemTime(new Date(t0 + POLICY_TTL_MS + 1));
    await resolve(d, "shell");
    expect(poolReads).toBe(2);
    expect(modeLines()).toHaveLength(1);
  });
});

describe("log hygiene", () => {
  it("a presented key never appears in any log line, and every line is one line", async () => {
    const FAKE = "mb-FAKEKEY-do-not-log-7f3a9c";
    KEYS[FAKE] = { scopes: ["read", "write"], org: "org-elsewhere" };
    try {
      for (const mode of ["report", "enforce"] as const) {
        pool = { mode };
        const d = makeDaemon();
        await resolve(d, "shell", `ApiKey ${FAKE}`);                 // 403 / WOULD-REFUSE 403
        await resolve(d, "shell", `Bearer ${FAKE}`);                 // 401, non-ApiKey scheme
        await resolve(d, "shell", `ApiKey ${FAKE}x`);                // 401, identity refuses
        await resolve(d, "fs_write", `ApiKey ${FAKE}`);              // cache hit, 403
        identityAnswer = () => { throw new TypeError(`connect ECONNREFUSED`); };
        await resolve(makeDaemon(), "shell", `ApiKey ${FAKE}y`);     // 503 + IDENTITY-UNAVAILABLE
        identityAnswer = defaultIdentity;
        KEYS[`${FAKE}z`] = { scopes: ["read", "write", "tools-exec"], org: "org-node" };
        await resolve(d, "shell", `ApiKey ${FAKE}z`);                // ADMIT in report
      }
      expect(lines.length).toBeGreaterThan(0);
      expect(tagged("ADMIT").length).toBeGreaterThan(0);
      expect(tagged("WOULD-REFUSE").length).toBeGreaterThan(0);
      expect(tagged("REFUSED").length).toBeGreaterThan(0);
      expect(tagged("IDENTITY-UNAVAILABLE").length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l).not.toContain("FAKEKEY");
        expect(l).not.toContain("\n");
      }
    } finally {
      delete KEYS[FAKE];
      delete KEYS[`${FAKE}z`];
    }
  });
});
