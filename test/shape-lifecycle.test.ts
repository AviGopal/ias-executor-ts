/**
 * shape-lifecycle tests — pure classifier.
 */
import { describe, expect, test } from "bun:test";
import { classifyShape, type ShapeLifecycleClass } from "../src/shape-lifecycle";

describe("classifyShape", () => {
  const cases: Array<[string, ShapeLifecycleClass]> = [
    // terminal — regex hits
    ["substrateGap", "terminal"],            // "gap"
    ["templateAuditReport", "terminal"],     // "audit"/"report"
    ["modelRealityGap", "terminal"],         // "gap"
    ["auditReport", "terminal"],             // "audit"/"report"
    ["goalVerdict", "terminal"],             // "verdict"
    ["activityExecutionSummary", "terminal"],// "summary"
    ["healthSnapshot", "terminal"],          // "health"/"snapshot"
    ["mdpState", "terminal"],                // "State$"
    ["autoDraftedOutputSomething", "terminal"], // autoDraftedOutput prefix
    // durable — allowlist beats regex
    ["activity_template", "durable"],
    ["compositionSuccess", "durable"],       // contains "success" but allowlisted durable wins
    ["authentication", "durable"],
    // stream
    ["stateSpaceSignature", "stream"],
    ["vesselHeartbeat", "stream"],
    ["pushHealth", "stream"],                // explicit stream beats "health" terminal regex
    // ephemeral default
    ["source_code", "ephemeral"],
    ["gitDiff", "ephemeral"],
  ];

  for (const [shape, expected] of cases) {
    test(`${shape} → ${expected}`, () => {
      expect(classifyShape(shape)).toBe(expected);
    });
  }

  test("ordering: durable allowlist wins over terminal regex match", () => {
    // compositionSuccess matches /result/? no — but "success" not in regex.
    // activity_metrics matches /metric/ (terminal regex) yet is durable.
    expect(classifyShape("activity_metrics")).toBe("durable");
  });

  test("ordering: stream wins over terminal regex match (pushHealth has 'health')", () => {
    expect(classifyShape("pushHealth")).toBe("stream");
  });
});
