// HttpDiscoveryAdapter.lookup: a discovery lookup that could not be answered is a FAILURE, never
// "no producer"; a real empty answer is "no producer"; a failure is remembered only for a short
// backoff; and the default budget outlasts discovery's per-peer forwarding abort. Exercised
// against a real HTTP server standing in for discovery-vessel, through the real FetchAdapter.
import { afterEach, describe, expect, test } from "bun:test";
import {
  HttpDiscoveryAdapter,
  describeDiscoveryLookup,
  DISCOVERY_FORWARD_BUDGET_MS,
  DISCOVERY_LOOKUP_BUDGET_MS,
} from "../src/adapters/discovery-adapter";
import { FetchAdapter } from "../src/adapters/fetch-adapter";

type Handler = (hit: number) => Promise<Response> | Response;
let server: ReturnType<typeof Bun.serve> | null = null;
let hits = 0;

function fakeDiscovery(handler: Handler): string {
  hits = 0;
  server = Bun.serve({ port: 0, fetch: async () => handler(++hits) });
  return `http://127.0.0.1:${server.port}`;
}
const answer = (vessels: unknown[]) => Response.json({ content: { shape: "poolImpulse", vessels, found: vessels.length > 0 } });
const row = { vesselId: "development-vessel-local", endpoint: "http://node-a:18090", resolve_endpoint: "/v2/impulses/resolve" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { server?.stop(true); server = null; });

describe("HttpDiscoveryAdapter.lookup", () => {
  test("a lookup that times out is a FAILURE, not 'no producer'", async () => {
    const url = fakeDiscovery(async () => { await sleep(400); return answer([row]); });
    const d = new HttpDiscoveryAdapter(new FetchAdapter(), url, { lookupBudgetMs: 60 });
    const r = await d.lookup("poolImpulse");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timeout");
    expect(describeDiscoveryLookup(r)).toContain("lookup failed (timeout)");
    expect(describeDiscoveryLookup(r)).not.toContain("no poolImpulse producer");
    // The DiscoveryPort contract keeps its caller-visible shape: unreachable throws, never [].
    await expect(new HttpDiscoveryAdapter(new FetchAdapter(), url, { lookupBudgetMs: 60 }).lookupShapeProducers("poolImpulse")).rejects.toThrow(/timeout/);
  });

  test("a 5xx is a FAILURE carrying its status", async () => {
    const url = fakeDiscovery(() => new Response("boom", { status: 503 }));
    const r = await new HttpDiscoveryAdapter(new FetchAdapter(), url).lookup("poolImpulse");
    expect(r).toMatchObject({ ok: false, reason: "http", status: 503 });
  });

  test("a real empty answer is 'no producer' (an answer, not a failure)", async () => {
    const url = fakeDiscovery(() => answer([]));
    const d = new HttpDiscoveryAdapter(new FetchAdapter(), url);
    const r = await d.lookup("poolImpulse");
    expect(r).toMatchObject({ ok: true, producers: [] });
    expect(describeDiscoveryLookup(r)).toBe("no poolImpulse producer");
    // Inside the short backoff a burst of readers shares the one answer.
    const again = await d.lookup("poolImpulse");
    expect(again).toMatchObject({ ok: true, producers: [], cached: true });
    expect(hits).toBe(1);
  });

  test("an empty answer is not held for 30 s: a partial union ([]) is re-dialled after the short backoff and the producer is read", async () => {
    // discovery-vessel's union returns 200 with [] when the only peer holding the producer timed
    // out inside discovery; the next lookup, once that peer answers, carries the producer.
    const url = fakeDiscovery((n) => answer(n === 1 ? [] : [row]));
    const d = new HttpDiscoveryAdapter(new FetchAdapter(), url, { failureBackoffMs: 80 });
    const first = await d.lookup("poolImpulse");
    expect(first).toMatchObject({ ok: true, producers: [] });
    await sleep(120); // past the short backoff, far inside the 30 s answer TTL
    const next = await d.lookup("poolImpulse");
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.producers.map((p) => p.id)).toEqual(["development-vessel-local"]);
    expect(hits).toBe(2);
  });

  test("a non-empty answer is still cached for the full answer TTL", async () => {
    const url = fakeDiscovery(() => answer([row]));
    const d = new HttpDiscoveryAdapter(new FetchAdapter(), url, { failureBackoffMs: 20 });
    await d.lookup("poolImpulse");
    await sleep(60);
    expect(await d.lookup("poolImpulse")).toMatchObject({ ok: true, cached: true });
    expect(hits).toBe(1);
  });

  test("a failure is not cached as a negative: after a short backoff the next lookup re-dials and finds the producer", async () => {
    const url = fakeDiscovery(async (n) => { if (n === 1) { await sleep(300); } return answer([row]); });
    const d = new HttpDiscoveryAdapter(new FetchAdapter(), url, { lookupBudgetMs: 60, failureBackoffMs: 80 });
    const first = await d.lookup("poolImpulse");
    expect(first.ok).toBe(false);
    // Inside the backoff the failure is replayed AS A FAILURE, never as an empty answer.
    const within = await d.lookup("poolImpulse");
    expect(within).toMatchObject({ ok: false, cached: true });
    await sleep(120);
    const after = await d.lookup("poolImpulse");
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.producers.map((p) => p.resolveEndpoint)).toEqual(["http://node-a:18090/v2/impulses/resolve"]);
  });

  test("the default budget outlasts a discovery that waits out a slow peer for the full forwarding abort", async () => {
    expect(DISCOVERY_LOOKUP_BUDGET_MS).toBeGreaterThan(DISCOVERY_FORWARD_BUDGET_MS);
    // discovery-vessel forwardToPeers: Promise.all over peers, each AbortSignal.timeout(5000);
    // a dead peer makes the union arrive at the forwarding abort, carrying the live peer's row.
    const url = fakeDiscovery(async () => { await sleep(DISCOVERY_FORWARD_BUDGET_MS + 150); return answer([{ ...row, discoveredVia: "peer" }]); });
    const r = await new HttpDiscoveryAdapter(new FetchAdapter(), url).lookup("poolImpulse");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.producers).toHaveLength(1);
  }, DISCOVERY_LOOKUP_BUDGET_MS + 4_000);

  test("provenance passes through: origin and origin_upstream reach the caller, absent stays absent", async () => {
    const url = fakeDiscovery(() => answer([
      { ...row, origin: "local" },
      { ...row, vesselId: "dv-node2", endpoint: "http://node-b:26090", origin: "peer:http://node-b:26100", origin_upstream: "local" },
      { ...row, vesselId: "dv-relayed", endpoint: "http://node-c:9000", origin: "peer:http://node-b:26100", origin_upstream: null },
      { ...row, vesselId: "dv-old", endpoint: "http://node-d:9000" },
    ]));
    const r = await new HttpDiscoveryAdapter(new FetchAdapter(), url).lookup("poolImpulse");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = Object.fromEntries(r.producers.map((p) => [p.id, p]));
    expect(by["development-vessel-local"]!.origin).toBe("local");
    expect(by["dv-node2"]).toMatchObject({ origin: "peer:http://node-b:26100", originUpstream: "local" });
    expect(by["dv-relayed"]!.originUpstream).toBeNull();
    expect(by["dv-old"]!.origin).toBeUndefined();
    expect(by["dv-old"]!.originUpstream).toBeUndefined();
  });
});
