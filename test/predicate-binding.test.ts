/**
 * Predicate-aware input binding tests (Phase 20.2.5)
 *
 * Covers:
 *  (a) plain-string inputShapes — backward compat
 *  (b) InputShapeRef predicate match with single candidate
 *  (c) predicate miss when other instances of same shape are present
 *  (d) cardinality "all" returns all matching candidates
 *  (e) cardinality "exactly_one" throws when > 1 candidate
 *  (f) producedBy filters by impulse.metadata.producedBy
 *  (g) producedBy also accepts produced_at_task_id metadata field
 */

import { describe, test, expect } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate, Impulse } from "../src/ontology";
import { SteppingClock, SequentialRandom, TraceSinkSpy } from "./fakes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntime() {
  const clock = new SteppingClock();
  const random = new SequentialRandom();
  const traceSink = new TraceSinkSpy();
  const runtime = new ExecutionRuntime({ clock, random, traceSink });
  return { runtime, traceSink };
}

function impulse(id: string, shape: string, producedBy?: string): Impulse {
  return {
    id,
    pointer: { type: "memo" },
    metadata: { shape, ...(producedBy ? { producedBy } : {}) },
    loaded: true,
    content: `content-${id}`,
  };
}

function captureResolver(captured: Impulse[][] = []) {
  return {
    id: "capture",
    tier: "deterministic" as const,
    async resolve(ctx: import("../src/resolvers").ResolverContext) {
      captured.push([...ctx.inputImpulses]);
      return [{ id: ctx.random.id("out"), pointer: { type: "memo" }, metadata: { shape: "result" }, loaded: true, content: "ok" }];
    },
  };
}

// ---------------------------------------------------------------------------
// (a) Plain-string inputShapes — backward compat
// ---------------------------------------------------------------------------

describe("predicate binding — backward compat (plain strings)", () => {
  test("plain string shape resolves all matching impulses", async () => {
    const { runtime } = makeRuntime();
    const imp1 = impulse("i1", "fileContent");
    const imp2 = impulse("i2", "fileContent");
    runtime.store.put(imp1);
    runtime.store.put(imp2);

    const captured: Impulse[][] = [];
    runtime.resolvers.register(captureResolver(captured));

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{ id: "t1", description: "d", resolver: "capture", inputShapes: ["fileContent"] }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("completed");
    expect(captured[0]?.length).toBe(2);
    expect(captured[0]?.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  test("plain string throws when shape absent", async () => {
    const { runtime } = makeRuntime();
    runtime.resolvers.register(captureResolver());

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{ id: "t1", description: "d", resolver: "capture", inputShapes: ["missingShape"] }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("missingShape");
  });
});

// ---------------------------------------------------------------------------
// (b) producedBy predicate match
// ---------------------------------------------------------------------------

describe("predicate binding — producedBy filter", () => {
  test("(b) predicate match: returns only the impulse with matching producedBy", async () => {
    const { runtime } = makeRuntime();
    runtime.store.put(impulse("i1", "shellOutput", "task_a"));
    runtime.store.put(impulse("i2", "shellOutput", "task_b"));

    const captured: Impulse[][] = [];
    runtime.resolvers.register(captureResolver(captured));

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: [{ shape: "shellOutput", producedBy: "task_a" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("completed");
    expect(captured[0]?.length).toBe(1);
    expect(captured[0]?.[0]?.id).toBe("i1");
  });

  test("(c) predicate miss: shape present but instance mismatch → fails", async () => {
    const { runtime } = makeRuntime();
    // Both instances are "shellOutput" but neither is from "task_z"
    runtime.store.put(impulse("i1", "shellOutput", "task_a"));
    runtime.store.put(impulse("i2", "shellOutput", "task_b"));

    runtime.resolvers.register(captureResolver());

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: [{ shape: "shellOutput", producedBy: "task_z" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("shellOutput");
    expect(trace.failureMode?.reason).toContain("task_z");
  });

  test("(g) producedBy matches produced_at_task_id metadata field", async () => {
    const { runtime } = makeRuntime();
    // Store an impulse with produced_at_task_id instead of producedBy
    runtime.store.put({
      id: "i1",
      pointer: { type: "memo" },
      metadata: { shape: "codeFile", produced_at_task_id: "task_compile" },
      loaded: true,
      content: "code",
    });

    const captured: Impulse[][] = [];
    runtime.resolvers.register(captureResolver(captured));

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: [{ shape: "codeFile", producedBy: "task_compile" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("completed");
    expect(captured[0]?.[0]?.id).toBe("i1");
  });
});

// ---------------------------------------------------------------------------
// (d) cardinality "all"
// ---------------------------------------------------------------------------

describe("predicate binding — cardinality", () => {
  test("(d) cardinality all: returns all filtered candidates", async () => {
    const { runtime } = makeRuntime();
    runtime.store.put(impulse("i1", "patch", "task_gen"));
    runtime.store.put(impulse("i2", "patch", "task_gen"));
    runtime.store.put(impulse("i3", "patch", "task_other")); // filtered out

    const captured: Impulse[][] = [];
    runtime.resolvers.register(captureResolver(captured));

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: [{ shape: "patch", producedBy: "task_gen", cardinality: "all" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("completed");
    expect(captured[0]?.length).toBe(2);
    expect(captured[0]?.map((i) => i.id).sort()).toEqual(["i1", "i2"]);
  });

  test("(e) cardinality exactly_one: throws when > 1 candidate", async () => {
    const { runtime } = makeRuntime();
    runtime.store.put(impulse("i1", "config"));
    runtime.store.put(impulse("i2", "config"));

    runtime.resolvers.register(captureResolver());

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: [{ shape: "config", cardinality: "exactly_one" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("failed");
    expect(trace.failureMode?.reason).toContain("exactly one");
    expect(trace.failureMode?.reason).toContain("config");
  });

  test("exactly_one succeeds when exactly 1 candidate exists", async () => {
    const { runtime } = makeRuntime();
    runtime.store.put(impulse("i1", "config"));

    const captured: Impulse[][] = [];
    runtime.resolvers.register(captureResolver(captured));

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: [{ shape: "config", cardinality: "exactly_one" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("completed");
    expect(captured[0]?.length).toBe(1);
  });

  test("mixed entry list: plain string + InputShapeRef in same task", async () => {
    const { runtime } = makeRuntime();
    runtime.store.put(impulse("i1", "goal"));
    runtime.store.put(impulse("i2", "patch", "task_gen"));

    const captured: Impulse[][] = [];
    runtime.resolvers.register(captureResolver(captured));

    const template: ActivityTemplate = {
      id: "t", name: "t", outputShapes: ["result"],
      tasks: [{
        id: "t1", description: "d", resolver: "capture",
        inputShapes: ["goal", { shape: "patch", producedBy: "task_gen" }],
      }],
    };
    const trace = await new ActivityExecutor(runtime).execute(template);
    expect(trace.status).toBe("completed");
    expect(captured[0]?.length).toBe(2);
    const ids = captured[0]?.map((i) => i.id).sort();
    expect(ids).toEqual(["i1", "i2"]);
  });
});
