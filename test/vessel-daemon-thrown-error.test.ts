// A resolver that throws is answered 500, and the daemon now says so in the journal: the shape and the message, with
// anything credential-like removed (agf_o3dz0xrrhz30: the hub's fast 500s left no trace on the node).
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { VesselDaemon, redactedMessage } from "../src/hosts/vessel-daemon";
import type { ResolverHandler } from "../src/hosts/vessel-daemon";
import type { ActivityExecutor } from "../src/engine";

let lines: string[] = [];
let spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  lines = [];
  spies = (["log", "warn", "error"] as const).map((m) =>
    spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }));
});
afterEach(() => { for (const s of spies) s.mockRestore(); });

const daemonThrowing = (message: string) => new VesselDaemon({
  port: 0, vesselId: "test-daemon", vesselName: "Test Daemon", shapes: ["thrower"], executor: {} as ActivityExecutor,
  resolvers: new Map<string, ResolverHandler>([["thrower", async () => { throw new Error(message); }]]),
  apiKey: "node-key", enforceCompositionChain: false,
});
const call = (d: VesselDaemon) => (d as unknown as { forwardToResolverServer(r: Request): Promise<Response> }).forwardToResolverServer(
  new Request("http://daemon.test/resolve", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { pointer: { type: "thrower" } } }) }));

describe("a resolver that throws", () => {
  it("[MUST-FAIL] is logged with its shape and message, and the call is still answered 500", async () => {
    const res = await call(daemonThrowing("upstream refused: connection reset"));
    expect(res.status).toBe(500);
    expect(lines.some((l) => l.includes("[vessel-daemon] resolver 'thrower' threw: upstream refused: connection reset"))).toBe(true);
  });

  it("[MUST-FAIL] a credential-looking value in the message never reaches the log", async () => {
    await call(daemonThrowing("auth failed for sk-or-v1-abcdef123456 with key_" + "_AbCdEf123 and Bearer eyJhbGciOiJ.payload.sig"));
    const line = lines.find((l) => l.includes("threw:")) ?? "";
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("abcdef123456");
    expect(line).not.toContain("AbCdEf123");
    expect(line).not.toContain("eyJhbGciOiJ");
  });

  it("the redaction is bounded and leaves ordinary words", () => {
    expect(redactedMessage(new Error("x".repeat(500))).length).toBe(300);
    expect(redactedMessage(new Error("no such file"))).toBe("no such file");
  });
});
