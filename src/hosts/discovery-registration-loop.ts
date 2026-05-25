/**
 * DiscoveryRegistrationLoop — register on startup, 60s heartbeat, deregister on stop.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 0, task 0.4.
 *
 * Usage:
 *   const loop = new DiscoveryRegistrationLoop({ discoveryEndpoint, vesselId, ... });
 *   await loop.start();
 *   // ...
 *   await loop.stop();
 */

export interface DiscoveryRegistrationLoopConfig {
  discoveryEndpoint: string;
  vesselId: string;
  vesselName: string;
  /** Advertised shapes — forwarded as-is to /register */
  shapes: string[];
  /** Full URL of this vessel's /resolve endpoint, e.g. http://localhost:8230/resolve */
  resolveEndpoint: string;
  /** API key for discovery-vessel auth (Authorization: ApiKey <key>) */
  apiKey: string;
  /** Port this vessel listens on — included in registration metadata */
  port: number;
  /** Heartbeat interval in ms. Default 60_000. */
  heartbeatIntervalMs?: number;
}

export class DiscoveryRegistrationLoop {
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private failureCount = 0;
  private unhealthyCallback?: () => void;

  constructor(private readonly config: DiscoveryRegistrationLoopConfig) {}

  /**
   * Register with discovery-vessel and start the heartbeat timer.
   * Non-blocking: a registration failure is logged but does not throw.
   */
  async start(): Promise<void> {
    await this.register();

    const intervalMs = this.config.heartbeatIntervalMs ?? 60_000;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, intervalMs);
  }

  /**
   * Send a DELETE to discovery-vessel and clear the heartbeat timer.
   * Called on SIGTERM / graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    await this.deregister();
  }

  /**
   * Register a callback that fires when three consecutive heartbeats fail.
   * The daemon can use this to mark itself unhealthy / restart.
   */
  onUnhealthy(callback: () => void): void {
    this.unhealthyCallback = callback;
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ────────────────────────────────────────────────────────────────────────

  private registrationPayload() {
    const baseUrl = `http://127.0.0.1:${this.config.port}`;
    return {
      vesselId: this.config.vesselId,
      name: this.config.vesselName,
      endpoint: baseUrl,
      shapes: this.config.shapes,
      resolve_endpoint: this.config.resolveEndpoint,
      resolve_request_format: "pointer",
      auth_scheme: "ApiKey",
      resolve_timeout_ms: 10_000,
      port: this.config.port,
    };
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `ApiKey ${this.config.apiKey}`,
    };
  }

  private async register(): Promise<void> {
    try {
      const res = await fetch(`${this.config.discoveryEndpoint}/register`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(this.registrationPayload()),
      });
      if (!res.ok) {
        console.warn(
          `[DiscoveryRegistrationLoop] register failed: ${res.status} — vessel will be unreachable via discovery`,
        );
      } else {
        this.failureCount = 0;
        console.log(`[DiscoveryRegistrationLoop] registered ${this.config.vesselId} at ${this.config.discoveryEndpoint}`);
      }
    } catch (err) {
      console.warn(`[DiscoveryRegistrationLoop] register error: ${(err as Error).message}`);
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      const res = await fetch(`${this.config.discoveryEndpoint}/heartbeat`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ vesselId: this.config.vesselId }),
      });
      if (res.ok) {
        this.failureCount = 0;
      } else {
        this.failureCount += 1;
        console.warn(`[DiscoveryRegistrationLoop] heartbeat HTTP ${res.status} (failure #${this.failureCount})`);
        if (this.failureCount >= 3 && this.unhealthyCallback) {
          this.unhealthyCallback();
        }
      }
    } catch (err) {
      this.failureCount += 1;
      console.warn(`[DiscoveryRegistrationLoop] heartbeat error: ${(err as Error).message} (failure #${this.failureCount})`);
      if (this.failureCount >= 3 && this.unhealthyCallback) {
        this.unhealthyCallback();
      }
    }
  }

  private async deregister(): Promise<void> {
    try {
      await fetch(`${this.config.discoveryEndpoint}/vessels/${this.config.vesselId}`, {
        method: "DELETE",
        headers: this.headers(),
      });
      console.log(`[DiscoveryRegistrationLoop] deregistered ${this.config.vesselId}`);
    } catch (err) {
      console.warn(`[DiscoveryRegistrationLoop] deregister error: ${(err as Error).message}`);
    }
  }
}
