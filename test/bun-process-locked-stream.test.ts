// BunProcessAdapter's cleanup cancels the child's stdout/stderr streams (src/adapters/bun-process.ts). Measured: under the
// one-process suite, "TypeError: Cannot cancel a locked ReadableStream" from that cleanup failed whichever test was
// running (BunProcessAdapter, BunHost, GoalHost) and once aborted a later file between tests. cancel() on a LOCKED stream
// does not throw, it returns a rejected promise, so the cleanup's try/catch never saw it.
// Deterministic: Bun.spawn is replaced by a fake process whose stream, at cleanup time, is one the test controls.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { BunProcessAdapter } from "../src/adapters/bun-process";

const text = (s: string) =>
  new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(s)); c.close(); } });

/** A fake child: the first read of stdout/stderr (the adapter's Response) gets a readable stream with `out`; every later
 *  read (the cleanup) gets the stream `atCleanup` returns. */
function fakeProc(out: string, atCleanup: () => ReadableStream) {
  const reads = { stdout: 0, stderr: 0 };
  return {
    get stdout() { return reads.stdout++ === 0 ? text(out) : atCleanup(); },
    get stderr() { return reads.stderr++ === 0 ? text("") : atCleanup(); },
    exited: Promise.resolve(0),
    kill() {},
  };
}

let spawn: ReturnType<typeof spyOn> | undefined;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
afterEach(() => {
  spawn?.mockRestore();
  spawn = undefined;
  process.off("unhandledRejection", onUnhandled);
  unhandled = [];
});
const settle = () => new Promise((r) => setTimeout(r, 25));

describe("BunProcessAdapter cleanup, a locked stream", () => {
  test("must-fail: cancelling a locked stream neither throws nor rejects unhandled, and the result is unchanged", async () => {
    process.on("unhandledRejection", onUnhandled);
    const locked = () => { const s = text("held"); s.getReader(); return s; };
    spawn = spyOn(Bun, "spawn").mockImplementation((() => fakeProc("hi", locked)) as never);
    let outcome: unknown;
    await new BunProcessAdapter().run(["echo", "hi"]).then((r) => { outcome = r; }, (e) => { outcome = { threw: String(e) }; });
    await settle();
    expect(outcome).toEqual({ exitCode: 0, stdout: "hi", stderr: "" });
    expect(unhandled.map(String)).toEqual([]);
  });

  test("control: an unlocked stream is still cancelled at cleanup", async () => {
    let cancelled = 0;
    const open = () => new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    spawn = spyOn(Bun, "spawn").mockImplementation((() => fakeProc("hi", open)) as never);
    const r = await new BunProcessAdapter().run(["echo", "hi"]);
    await settle();
    expect(r).toEqual({ exitCode: 0, stdout: "hi", stderr: "" });
    expect(cancelled).toBe(2);
  });
});
