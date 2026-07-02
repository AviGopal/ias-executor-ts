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
  /**
   * Mark this vessel as a system-level vessel (not tenant-scoped).
   * Required for substrate services so they appear in all org-scoped discovery
   * queries. Vessels without orgId AND without systemVessel=true are invisible.
   */
  systemVessel?: boolean;
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
    // Advertised-endpoint contract (2026-07-02): the registry stores what the
    // vessel advertises; the vessel advertises what its callers can reach.
    // Precedence: explicit VESSEL_ADVERTISE_ENDPOINT (per-vessel) >
    // SUBSTRATE_ADVERTISE_HOST (container-level, spoke joining a hub — the
    // host-published port follows the fleet's internal+offset convention,
    // default +10000, override via SUBSTRATE_ADVERTISE_PORT_OFFSET) >
    // loopback (same-container fleet, unchanged default).
    const advertised = process.env.VESSEL_ADVERTISE_ENDPOINT;
    const advertiseHost = process.env.SUBSTRATE_ADVERTISE_HOST;
    const portOffset = Number(process.env.SUBSTRATE_ADVERTISE_PORT_OFFSET ?? 10_000);
    const baseUrl = advertised && advertised.length > 0
      ? advertised.replace(/\/+$/, "")
      : advertiseHost && advertiseHost.length > 0
        ? `http://${advertiseHost}:${this.config.port + portOffset}`
        : `http://127.0.0.1:${this.config.port}`;
    // SC-P4 discovery-vessel contract: `endpoint` is the substrate-internal
    // URL; `public_endpoint` is an optional host/LAN-reachable URL for callers
    // OUTSIDE the container network. Advertised only when explicitly set.
    const publicEndpoint = process.env.VESSEL_PUBLIC_ENDPOINT;
    return {
      vesselId: this.config.vesselId,
      name: this.config.vesselName,
      endpoint: baseUrl,
      ...(publicEndpoint && publicEndpoint.length > 0
        ? { public_endpoint: publicEndpoint.replace(/\/+$/, "") }
        : {}),
      shapes: this.config.shapes,
      resolve_endpoint: this.config.resolveEndpoint,
      resolve_request_format: "pointer",
      auth_scheme: "ApiKey",
      resolve_timeout_ms: 10_000,
      port: this.config.port,
      ...(this.config.systemVessel ? { systemVessel: true } : {}),
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
        return;
      }
      // V12 (2026-06-05): heartbeat 404 means discovery has no record of us
      // (most likely because discovery-vessel restarted and dropped its
      // in-memory registry). Re-register immediately — this is the
      // structurally correct response and prevents silent fleet-wide
      // disappearance after any discovery restart. Without this re-register,
      // failureCount would just climb until onUnhealthy fires, leaving the
      // vessel unreachable in the meantime. The register() call resets
      // failureCount on success.
      if (res.status === 404) {
        console.warn(
          `[DiscoveryRegistrationLoop] heartbeat 404 — discovery has no record; re-registering ${this.config.vesselId}`,
        );
        await this.register();
        return;
      }
      this.failureCount += 1;
      console.warn(`[DiscoveryRegistrationLoop] heartbeat HTTP ${res.status} (failure #${this.failureCount})`);
      if (this.failureCount >= 3 && this.unhealthyCallback) {
        this.unhealthyCallback();
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
