import type { ProcessPort } from "../ports";

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
    }
  }
}
