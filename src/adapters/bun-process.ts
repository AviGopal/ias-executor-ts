import type { ProcessPort } from "../ports";

function releaseStream(stream: ReadableStream | null | undefined): void {
  if (!stream || stream.locked || typeof stream.cancel !== "function") return;
  try {
    void Promise.resolve(stream.cancel()).catch(() => { /* swallow */ });
  } catch { /* swallow */ }
}

/**
 * Bun-backed process adapter.
 * Satisfies ProcessPort using Bun.spawn().
 * Hosts attach this to make shell-execution resolvers available.
 */
export class BunProcessAdapter implements ProcessPort {
  async run(
    command: string[],
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(command, {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const killPromise =
      options.timeoutMs !== undefined
        ? new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              proc.kill();
              reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${command.join(" ")}`));
            }, options.timeoutMs);
          })
        : null;

    try {
      const [stdout, stderr, exitCode] = await Promise.race(
        [
          Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
          ]),
          killPromise,
        ].filter(Boolean) as [Promise<[string, string, number]>],
      );
      return { exitCode, stdout, stderr };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // On the timeout path, the stdout/stderr ReadableStreams started
      // by `new Response(proc.stdout).text()` are still pending — they
      // hold native pipe FDs + buffers. Explicit cancel + await exited
      // releases them. Idempotent on the success path (streams already
      // closed). See `concept_response_pattern_oom_cascade_solved`.
      // cancel() on a LOCKED stream (its Response reader still holds it) does not throw: it returns a rejected
      // promise, which a try/catch cannot see, so it surfaced as an unhandled rejection failing whichever test was
      // running. A locked stream belongs to its reader and is skipped; an async rejection is swallowed too.
      releaseStream(proc.stdout as ReadableStream | null);
      releaseStream(proc.stderr as ReadableStream | null);
      try { await proc.exited; } catch { /* swallow */ }
    }
  }
}
