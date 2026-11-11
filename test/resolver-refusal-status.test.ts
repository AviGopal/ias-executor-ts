// A resolver that refuses the request itself throws with a 4xx status, and the caller gets that status: a missing
// directory or an unusable field is the request's fault, and a caller that learns from failures (the walk's credit)
// must be able to tell it from an outage. Anything else stays a 500.
import { afterAll, describe, expect, it } from "bun:test";
import { ResolverServer, statusOf } from "../src/hosts/resolver-server";

const refusal = (message: string, status: number) => Object.assign(new Error(message), { status });
const server = new ResolverServer({
  port: 0,
  resolvers: new Map([
    ["refuses", async () => { throw refusal("no such directory: repos/x", 422); }],
    ["breaks", async () => { throw new Error("database unreachable"); }],
    ["claims", async () => { throw refusal("not a client error", 503); }],
  ]),
});
const s = server.start();
afterAll(() => server.stop());
const call = (type: string) => fetch(`http://127.0.0.1:${s.port}/resolve`, { method: "POST", body: JSON.stringify({ type }) });

describe("a resolver's thrown error", () => {
  it("[MUST-FAIL] a refusal of the request keeps its 4xx status and message", async () => {
    const r = await call("refuses");
    expect(r.status).toBe(422);
    expect(((await r.json()) as { error: string }).error).toContain("no such directory: repos/x");
  });
  it("anything else, a 5xx claimed included, is a 500", async () => {
    expect((await call("breaks")).status).toBe(500);
    expect((await call("claims")).status).toBe(500);
    expect(statusOf(null)).toBe(500);
  });
});
