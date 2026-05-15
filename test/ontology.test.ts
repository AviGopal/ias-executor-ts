import { describe, expect, test } from "bun:test";
import type { ActivityTemplate, Impulse } from "../src";
import { getImpulseShape } from "../src";

describe("ontology", () => {
  test("getImpulseShape prefers metadata.shape", () => {
    const impulse: Impulse = {
      id: "imp-1",
      pointer: { type: "memo" },
      metadata: { shape: "goal" },
      loaded: true,
      content: "build the runtime",
    };

    expect(getImpulseShape(impulse)).toBe("goal");
  });

  test("activity template shape is structurally valid", () => {
    const template: ActivityTemplate = {
      id: "hello-world",
      name: "Hello World",
      tasks: [
        {
          id: "emit",
          description: "Emit a greeting",
          resolver: "emit",
          outputShapes: ["greeting"],
        },
      ],
    };

    expect(template.tasks[0]?.resolver).toBe("emit");
  });
});
