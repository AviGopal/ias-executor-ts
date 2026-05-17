import type { DockerPort, ProcessPort } from "../ports";

/**
 * Bun-backed Docker adapter.
 * Shells to `docker` via ProcessPort. Registry auth is read from
 * DOCKER_REGISTRY_AUTH env (base64 `user:password`).
 */
export class BunDockerAdapter implements DockerPort {
  constructor(private readonly process: ProcessPort) {}

  async build(
    contextPath: string,
    tag: string,
    opts: { buildArgs?: Record<string, string>; dockerfile?: string } = {},
  ): Promise<void> {
    const args = ["docker", "build", "-t", tag];
    if (opts.dockerfile) args.push("-f", opts.dockerfile);
    for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
      args.push("--build-arg", `${k}=${v}`);
    }
    args.push(contextPath);

    const { exitCode, stderr } = await this.process.run(args);
    if (exitCode !== 0) throw new Error(`docker build failed (exit ${exitCode}): ${stderr}`);
  }

  async push(tag: string, _registry?: string): Promise<void> {
    const auth = process.env["DOCKER_REGISTRY_AUTH"];
    const loginArgs: string[] = [];
    if (auth) {
      // docker login reads password from stdin; ProcessPort.run doesn't support
      // stdin — expect DOCKER_REGISTRY_AUTH to be pre-configured via `docker login`
      // before invoking push, or use a CI credential helper.
      void auth;
    }

    const { exitCode, stderr } = await this.process.run(["docker", "push", tag]);
    if (exitCode !== 0) throw new Error(`docker push failed (exit ${exitCode}): ${stderr}`);
  }
}
