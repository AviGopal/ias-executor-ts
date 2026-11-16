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
    await call(daemonThrowing("auth failed for sk-or-v1-abcdef123456 with key_" + "_AbCdEf1234567890xyzQ and Bearer eyJhbGciOiJ.payload.sig"));
    const line = lines.find((l) => l.includes("threw:")) ?? "";
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("abcdef123456");
    expect(line).not.toContain("AbCdEf1234567890xyzQ");
    expect(line).not.toContain("eyJhbGciOiJ");
  });

  it("the redaction is bounded and leaves ordinary words", () => {
    expect(redactedMessage(new Error("word ".repeat(100))).length).toBe(300);
    expect(redactedMessage(new Error("no such file"))).toBe("no such file");
  });

  it("[MUST-FAIL] this fleet's key id form is removed at any length, in plain prose (deployment)", () => {
    const out = redactedMessage(new Error("key_" + "_Ab3dEf9 failed"));
    expect(out).toBe("[redacted] failed");
    expect(redactedMessage(new Error("upstream rejected key_" + "_abcd1234 now"))).toBe("upstream rejected [redacted] now");
    expect(redactedMessage(new Error("the keyboard broke"))).toBe("the keyboard broke");
    // qa's fakes: short key ids, and short provider-prefixed keys, in prose
    for (const fake of ["key_" + "_FAKEab12", "key_" + "_FAKEFAKE12345", "sk-" + "FAKE1", "gsk_" + "FAKE2", "pk_" + "FAKE3", "rk_" + "FAKE4"]) {
      expect([fake, redactedMessage(new Error(`rejected ${fake} now`))]).toEqual([fake, "rejected [redacted] now"]);
    }
    expect(redactedMessage(new Error("a risk-free task"))).toBe("a risk-free task");
  });

  it("[MUST-FAIL] credentials are removed by their form, whatever the provider (qa's six shapes, fake values)", () => {
    const cases: Array<[string, string]> = [
      ["GET https://api.example.test/v1/models?key=AIzaFAKEFAKEFAKEFAKE123 failed", "AIzaFAKE"],
      ["provider said: invalid gsk_FAKEfake1234567890abcdefghij", "gsk_FAKE"],
      ["request header x-api-key: fakeplainvalue failed", "fakeplainvalue"],
      ["Authorization: Basic ZmFrZTpmYWtl rejected", "ZmFrZTpmYWtl"],
      ["fetch https://user:FAKEPASSWORD@host.test/x failed", "FAKEPASSWORD"],
      ["callback with token=abc123fake rejected", "abc123fake"],
    ];
    for (const [message, secret] of cases) {
      const out = redactedMessage(new Error(message));
      expect([message, out.includes(secret)]).toEqual([message, false]);
    }
    expect(redactedMessage(new Error("no such file"))).toBe("no such file");
  });

  it("[MUST-FAIL] the resolve trace gets the redacted message too", async () => {
    const d = daemonThrowing("auth failed with token=abc123fake");
    const traced: Array<Record<string, unknown>> = [];
    (d as unknown as { emitResolveTrace: (t: Record<string, unknown>) => void }).emitResolveTrace = (t) => { traced.push(t); };
    await call(d);
    expect(JSON.stringify(traced)).not.toContain("abc123fake");
    expect(JSON.stringify(traced)).toContain("[redacted]");
  });
});
