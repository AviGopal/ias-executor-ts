import type { HelmfilePort, ProcessPort } from "../ports";

export class HelmfileTimeoutError extends Error {
  constructor(release: string, namespace: string, timeoutMs: number) {
    super(`Timed out waiting for ${release} in ${namespace} after ${timeoutMs}ms`);
    this.name = "HelmfileTimeoutError";
  }
}

/**
 * Bun-backed Helmfile + kubectl adapter.
 * `applyOverlay` runs `helmfile --file <overlayPath> sync`.
 * `waitForReady` polls `kubectl rollout status deployment/<release> -n <namespace>`
 * until ready or timeoutMs elapsed.
 */
export class BunHelmfileAdapter implements HelmfilePort {
  constructor(private readonly process: ProcessPort) {}

  async applyOverlay(overlayPath: string): Promise<void> {
    const { exitCode, stderr } = await this.process.run(
      ["helmfile", "--file", overlayPath, "sync"],
    );
    if (exitCode !== 0) throw new Error(`helmfile sync failed (exit ${exitCode}): ${stderr}`);
  }

  async waitForReady(release: string, namespace: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const pollInterval = 5_000;

    while (Date.now() < deadline) {
      const { exitCode } = await this.process.run([
        "kubectl", "rollout", "status", `deployment/${release}`,
        "-n", namespace,
        "--timeout=10s",
      ]);
      if (exitCode === 0) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((r) => setTimeout(r, Math.min(pollInterval, remaining)));
    }

    throw new HelmfileTimeoutError(release, namespace, timeoutMs);
  }
}
