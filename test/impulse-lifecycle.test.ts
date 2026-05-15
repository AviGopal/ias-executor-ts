import { describe, expect, test } from "bun:test";
import { ImpulseStore } from "../src";

describe("ImpulseStore — lifecycle", () => {
  test("update merges fields without replacing the whole impulse", () => {
    const store = new ImpulseStore();
    store.create({
      id: "i1",
      pointer: { type: "memo" },
      metadata: { shape: "goal", summary: "original" },
      loaded: false,
    });

    const updated = store.update("i1", { loaded: true, content: "loaded content" });
    expect(updated?.loaded).toBe(true);
    expect(updated?.content).toBe("loaded content");
    expect(updated?.metadata.shape).toBe("goal"); // unchanged field preserved
  });

  test("update returns undefined for missing id", () => {
    const store = new ImpulseStore();
    expect(store.update("ghost", { loaded: true })).toBeUndefined();
  });

  test("unload sets loaded=false and clears content", () => {
    const store = new ImpulseStore();
    store.create({
      id: "i2",
      pointer: { type: "memo" },
      metadata: { shape: "trace" },
      loaded: true,
      content: { big: "payload" },
    });

    const unloaded = store.unload("i2");
    expect(unloaded?.loaded).toBe(false);
    expect(unloaded?.content).toBeUndefined();
  });

  test("unload does not affect other impulses", () => {
    const store = new ImpulseStore();
    store.create({ id: "a", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true, content: "keep" });
    store.create({ id: "b", pointer: { type: "memo" }, metadata: { shape: "y" }, loaded: true, content: "drop" });

    store.unload("b");

    expect(store.get("a")?.content).toBe("keep");
    expect(store.get("b")?.content).toBeUndefined();
  });

  test("findByShape includes unloaded impulses", () => {
    const store = new ImpulseStore();
    store.create({ id: "loaded-x", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true });
    store.create({ id: "unloaded-x", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: false });

    expect(store.findByShape("x")).toHaveLength(2);
  });

  test("loadedSummaries excludes unloaded impulses", () => {
    const store = new ImpulseStore();
    store.create({ id: "l", pointer: { type: "memo" }, metadata: { shape: "x", summary: "loaded one" }, loaded: true });
    store.create({ id: "u", pointer: { type: "memo" }, metadata: { shape: "x", summary: "not here" }, loaded: false });

    const summaries = store.loadedSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe("l");
  });
});

describe("ImpulseStore — formatForContext (5.3)", () => {
  test("returns all impulses as metadata-first entries by default", () => {
    const store = new ImpulseStore();
    store.create({ id: "a", pointer: { type: "memo" }, metadata: { shape: "goal", summary: "ship it" }, loaded: true, content: "big payload" });
    store.create({ id: "b", pointer: { type: "file" }, metadata: { shape: "code" }, loaded: false });

    const entries = store.formatForContext();
    expect(entries).toHaveLength(2);
    // content is NOT included by default
    expect(entries.find((e) => e.id === "a")?.content).toBeUndefined();
  });

  test("filters by shape when shapes option is provided", () => {
    const store = new ImpulseStore();
    store.create({ id: "g1", pointer: { type: "memo" }, metadata: { shape: "goal" }, loaded: true });
    store.create({ id: "t1", pointer: { type: "memo" }, metadata: { shape: "trace" }, loaded: true });
    store.create({ id: "g2", pointer: { type: "memo" }, metadata: { shape: "goal" }, loaded: false });

    const entries = store.formatForContext({ shapes: ["goal"] });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.shape === "goal")).toBe(true);
  });

  test("includes content only when includeContent=true and impulse is loaded", () => {
    const store = new ImpulseStore();
    store.create({ id: "loaded", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true, content: "the data" });
    store.create({ id: "unloaded", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: false, content: "hidden" });

    const entries = store.formatForContext({ includeContent: true });
    const loadedEntry = entries.find((e) => e.id === "loaded");
    const unloadedEntry = entries.find((e) => e.id === "unloaded");

    expect(loadedEntry?.content).toBe("the data");
    expect(unloadedEntry?.content).toBeUndefined(); // not loaded, so content excluded
  });

  test("summary is null when metadata has no summary string", () => {
    const store = new ImpulseStore();
    store.create({ id: "nosummary", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true });

    const entry = store.formatForContext()[0];
    expect(entry?.summary).toBeNull();
  });

  test("loaded flag is correctly reflected per impulse", () => {
    const store = new ImpulseStore();
    store.create({ id: "l", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: true });
    store.create({ id: "u", pointer: { type: "memo" }, metadata: { shape: "x" }, loaded: false });

    const entries = store.formatForContext();
    expect(entries.find((e) => e.id === "l")?.loaded).toBe(true);
    expect(entries.find((e) => e.id === "u")?.loaded).toBe(false);
  });
});
