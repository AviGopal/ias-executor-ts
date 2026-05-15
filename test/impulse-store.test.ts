import { describe, expect, test } from "bun:test";
import { ImpulseStore } from "../src";

describe("ImpulseStore", () => {
  test("creates and retrieves impulses", () => {
    const store = new ImpulseStore();
    const impulse = store.create({
      id: "goal-1",
      pointer: { type: "memo" },
      metadata: { shape: "goal", summary: "ship Milestone A" },
      loaded: true,
      content: "ship Milestone A",
    });

    expect(store.get("goal-1")).toEqual(impulse);
    expect(store.findByShape("goal")).toHaveLength(1);
  });

  test("returns loaded summaries only", () => {
    const store = new ImpulseStore();
    store.create({
      id: "loaded",
      pointer: { type: "memo" },
      metadata: { shape: "goal", summary: "loaded" },
      loaded: true,
      content: "loaded",
    });
    store.create({
      id: "unloaded",
      pointer: { type: "memo" },
      metadata: { shape: "goal", summary: "unloaded" },
      loaded: false,
    });

    expect(store.loadedSummaries()).toEqual([
      { id: "loaded", shape: "goal", summary: "loaded" },
    ]);
  });
});
