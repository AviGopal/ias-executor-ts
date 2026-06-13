import { describe, it, expect } from "bun:test";
import { isParseableJsonArtifact } from "../src/engine";

// Check 2b convergent-validity: a `.json` fs_write artifact whose bytes don't
// parse is a ghost-write. The discriminator must be FENCE-TOLERANT — it accepts
// what the downstream consumers accept (so the pipeline's intentionally-fenced
// reports don't regress) and rejects structurally-broken content (raw LLM text
// interpolated into a JSON string slot — the exact write_proposal ghost-success).
describe("isParseableJsonArtifact (fs_write JSON convergent-validity)", () => {
  it("accepts strict JSON (JSON.stringify output — the fixed write_proposal envelope)", () => {
    const valid = JSON.stringify({ proposal: { scenario_id: "fm-50" }, template_artifact: "x.draft.txt" });
    expect(isParseableJsonArtifact(valid)).toBe(true);
  });

  it("accepts a fenced JSON object (the intentionally-fenced -report.json the pipeline tolerates)", () => {
    const fenced = '```json\n{\n  "kind": "patch_proposal",\n  "summary": "x",\n  "required_code_modifications": []\n}\n```';
    expect(isParseableJsonArtifact(fenced)).toBe(true);
  });

  it("accepts a JSON array and fenced array", () => {
    expect(isParseableJsonArtifact('["a","b"]')).toBe(true);
    expect(isParseableJsonArtifact('```json\n["a","b"]\n```')).toBe(true);
  });

  it("REJECTS the old write_proposal shape — raw fenced LLM text in a JSON string slot", () => {
    // This is the literal corruption: JSON.stringify({...,template:"<token>"}) then
    // the engine substitutes <token> with raw fenced multiline text → unescaped
    // quotes + newlines inside the string break the JSON.
    const broken =
      '{"proposal":{"scenario_id":"x"},"template":"```json\n' +
      '{\n  "id": "gap-closing:x",\n  "name": "Y"\n}\n```"}';
    expect(isParseableJsonArtifact(broken)).toBe(false);
  });

  it("rejects empty / whitespace-only / prose-only content", () => {
    expect(isParseableJsonArtifact("")).toBe(false);
    expect(isParseableJsonArtifact("   \n  ")).toBe(false);
    expect(isParseableJsonArtifact("could not generate a proposal")).toBe(false);
  });

  it("rejects a truncated (never-balanced) object", () => {
    expect(isParseableJsonArtifact('{"a":1,"b":')).toBe(false);
  });
});
