/**
 * Tests for the resolveInputs poll-and-wait behavior (audit inv-028 C).
 *
 * Default behavior (EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS=0): throws
 * immediately when a declared input shape has no candidates in the store.
 *
 * Opt-in behavior (timeout > 0): polls every 50ms until either the shape
 * appears in the store or the deadline elapses. Lets lifecycle subscribers
 * (slot-binding) populate the store before resolveInputs throws.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import { SequentialRandom, SteppingClock, EventSinkSpy } from "./fakes";
import type { ActivityTemplate, Impulse } from "../src/ontology";

function makeTemplate(): ActivityTemplate {
  return {
    id: "tpl-test",
    name: "test template",
    description: "test",
    tasks: [
      {
        id: "task1",
        description: "needs missing-shape",
        resolver: "noop",
        inputShapes: ["missing_shape"],
        outputShapes: ["result"],
      } as never,
    ],
    outputShapes: ["result"],
    tags: ["test"],
  };
}

function makeRuntime() {
  const runtime = new ExecutionRuntime({
    clock: new SteppingClock(1_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
  runtime.resolvers.register({
    id: "noop",
    tier: "deterministic",
    async resolve() {
      return [
        {
          id: "out-1",
          pointer: { type: "memo" as const },
          metadata: { shape: "result" },
          loaded: true as const,
          content: { ok: true },
        },
      ];
    },
  });
  return runtime;
}

describe("resolveInputs poll-and-wait", () => {
  let originalTimeout: string | undefined;

  beforeEach(() => {
    originalTimeout = process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"];
  });

  afterEach(() => {
    if (originalTimeout === undefined) {
      delete process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"];
    } else {
      process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"] = originalTimeout;
    }
  });

  it("default (timeout=0): throws immediately when shape missing", async () => {
    delete process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"];
    const runtime = makeRuntime();
    const executor = new ActivityExecutor(runtime);

    const t0 = Date.now();
    const trace = await executor.execute(makeTemplate(), {});
    const elapsed = Date.now() - t0;

    expect(trace.status).toBe("failed");
    expect(elapsed).toBeLessThan(200);
  });

  it("timeout=800: still throws but only after the wait window elapses", async () => {
    process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"] = "800";
    const runtime = makeRuntime();
    const executor = new ActivityExecutor(runtime);

    const t0 = Date.now();
    const trace = await executor.execute(makeTemplate(), {});
    const elapsed = Date.now() - t0;

    expect(trace.status).toBe("failed");
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(1200);
  });

  it("timeout=2000: succeeds when subscriber populates the store before deadline", async () => {
    process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"] = "2000";
    const runtime = makeRuntime();
    const executor = new ActivityExecutor(runtime);

    // Simulate a slot-binding subscriber: 250ms after exec starts, drop
    // the missing shape into the store.
    setTimeout(() => {
      const impulse: Impulse = {
        id: "imp-late",
        pointer: { type: "memo" },
        metadata: { shape: "missing_shape" },
        loaded: true,
        content: "late-arriving content",
      };
      runtime.store.put(impulse);
    }, 250);

    const t0 = Date.now();
    const trace = await executor.execute(makeTemplate(), {});
    const elapsed = Date.now() - t0;

    expect(trace.status).toBe("completed");
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1000);
  });

  it("present-from-start shapes resolve immediately even with timeout set", async () => {
    process.env["EXECUTOR_INPUT_RESOLUTION_TIMEOUT_MS"] = "5000";
    const runtime = makeRuntime();
    const executor = new ActivityExecutor(runtime);

    const impulse: Impulse = {
      id: "imp-early",
      pointer: { type: "memo" },
      metadata: { shape: "missing_shape" },
      loaded: true,
      content: "already there",
    };

    const t0 = Date.now();
    const trace = await executor.execute(makeTemplate(), { impulses: [impulse] });
    const elapsed = Date.now() - t0;

    expect(trace.status).toBe("completed");
    expect(elapsed).toBeLessThan(200);
  });
});
