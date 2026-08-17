import { describe, it, expect } from "bun:test";
import { redactResolvedConfig } from "./engine";

// WHY THE TRACE NOW CARRIES A TASK'S ARGUMENTS (2026-08-17).
//
// A trace recorded which resolver ran and which shapes moved, and never what the resolver was
// called with. The ribosome extracts from traces, so with no arguments recorded there were none
// to extract: all 98 tasks across the 26 stored learned compositions carry config {type} and
// nothing else. Replaying one invokes its resolvers with undefined arguments, which the engine
// reports verbatim as:
//
//   fs_read            "The paths[0] property must be of type string, got undefined"   (18 runs)
//   http_fetch         "invalid URL: undefined"                                        (8)
//   json_path_extract  "undefined is not an object (evaluating 'path.split')"
//
// Learned compositions completed 6 of 61 runs; five-hop ones 0 of 12. The fact needed to make a
// pathway reusable existed exactly once, at dispatch, and was discarded — law 8 at its origin.
//
// These tests pin the two constraints that make persisting it safe, because both are ways this
// could do harm rather than good.

describe("redactResolvedConfig — secrets", () => {
  it("replaces secret-looking keys rather than truncating them", () => {
    // Truncation is not redaction: a cut secret is still a leaked prefix.
    const out = redactResolvedConfig({ url: "https://x/y", api_key: "sk-live-abcdef123456" })!;
    expect(out.api_key).toBe("[redacted]");
    expect(out.url).toBe("https://x/y");
  });

  it("redacts by KEY NAME, across the common spellings", () => {
    const out = redactResolvedConfig({
      Authorization: "Bearer t", password: "p", privateKey: "k", session_token: "s", cookie: "c",
    })!;
    for (const k of ["Authorization", "password", "privateKey", "session_token", "cookie"]) {
      expect(out[k]).toBe("[redacted]");
    }
  });

  it("redacts nested secrets, not just top-level ones", () => {
    const out = redactResolvedConfig({ headers: { authorization: "Bearer t", accept: "json" } })!;
    expect((out.headers as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((out.headers as Record<string, unknown>).accept).toBe("json");
  });
});

describe("redactResolvedConfig — size", () => {
  it("cuts long values with a marker that says how much was dropped", () => {
    const out = redactResolvedConfig({ body: "x".repeat(1000) })!;
    expect(String(out.body)).toContain("…[+400 chars]");
    expect(String(out.body).length).toBeLessThan(1000);
  });

  it("keeps short values byte-exact — the point is to replay them", () => {
    const cmd = "curl -s http://127.0.0.1:8100/registry/stats | jq .totalShapes";
    expect(redactResolvedConfig({ command: cmd })!.command).toBe(cmd);
  });

  it("caps arrays and depth so a pathological config cannot bloat a trace", () => {
    const out = redactResolvedConfig({ items: Array.from({ length: 100 }, (_, i) => i) })!;
    expect((out.items as unknown[]).length).toBe(20);
    expect(redactResolvedConfig({ a: { b: { c: { d: { e: { f: 1 } } } } } })!.a).toBeDefined();
  });
});

describe("redactResolvedConfig — the arguments that matter for rebinding survive", () => {
  it("preserves exactly the fields whose absence broke replay", () => {
    // These three are the arguments the engine reported as undefined on replay.
    const out = redactResolvedConfig({ paths: ["/vessels/x/src"], url: "https://api.example/z", path: "$.body.count" })!;
    expect(out.paths).toEqual(["/vessels/x/src"]);
    expect(out.url).toBe("https://api.example/z");
    expect(out.path).toBe("$.body.count");
  });

  it("returns undefined for a non-object config rather than inventing one", () => {
    expect(redactResolvedConfig(undefined)).toBeUndefined();
    expect(redactResolvedConfig("a string")).toBeUndefined();
    expect(redactResolvedConfig([1, 2])).toBeUndefined();
  });
});
