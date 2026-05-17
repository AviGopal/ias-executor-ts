/**
 * VesselForgeHost — Phase 22 forge integration layer.
 *
 * Extends the BunHost pattern with Docker, Helmfile, and Discovery ports plus
 * the 6 forge resolvers for autonomous vessel creation.
 *
 * Usage:
 *   const host = new VesselForgeHost({ llm, docker, helmfile });
 *   await host.execute(forgeTemplate, { variables: { workingDirectory: '/repo' } });
 */

import { ActivityExecutor, ExecutionRuntime, type ActivityTemplate, type ExecutionTrace } from "../index";
import { BunFileSystemAdapter, BunProcessAdapter } from "../adapters/index";
import { FetchAdapter } from "../adapters/fetch-adapter";
import { BunDockerAdapter } from "../adapters/docker-adapter";
import { BunHelmfileAdapter } from "../adapters/helmfile-adapter";
import { HttpDiscoveryAdapter } from "../adapters/discovery-adapter";
import type {
  DockerPort,
  HelmfilePort,
  DiscoveryPort,
  LLMPort,
  EventSink,
  TraceSink,
} from "../ports";
import { makeScaffoldVesselSkeletonResolver } from "../resolvers/scaffold-vessel-skeleton";
import { makeWireDiscoveryRegistrationResolver } from "../resolvers/wire-discovery-registration";
import { makeWireAuthBlueprintResolver } from "../resolvers/wire-auth-blueprint";
import { makeDockerBuildPushResolver } from "../resolvers/docker-build-push";
import { makeHelmfileSyncResolver } from "../resolvers/helmfile-sync";
import { makeVerifyThreeInvariantsResolver } from "../resolvers/verify-three-invariants";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface VesselForgeHostOptions {
  /** LLM port required for the llm-tier forge resolvers */
  llm: LLMPort;

  /**
   * DockerPort. When omitted a BunDockerAdapter backed by BunProcessAdapter is
   * created automatically. Inject a fake in tests.
   */
  docker?: DockerPort;

  /**
   * HelmfilePort. When omitted a BunHelmfileAdapter is created automatically.
   */
  helmfile?: HelmfilePort;

  /**
   * DiscoveryPort. When omitted an HttpDiscoveryAdapter targeting
   * `discoveryEndpoint` is created automatically.
   */
  discovery?: DiscoveryPort;

  /**
   * Discovery-vessel base URL used when `discovery` is not provided.
   * Default: http://discovery-vessel:8080
   */
  discoveryEndpoint?: string;

  /** Event sink — defaults to no-op */
  eventSink?: EventSink;

  /** Trace sink — defaults to no-op */
  traceSink?: TraceSink;
}

// ---------------------------------------------------------------------------
// VesselForgeHost
// ---------------------------------------------------------------------------

export class VesselForgeHost {
  readonly runtime: ExecutionRuntime;
  readonly executor: ActivityExecutor;

  readonly fs: BunFileSystemAdapter;
  readonly proc: BunProcessAdapter;
  readonly fetchAdapter: FetchAdapter;
  readonly docker: DockerPort;
  readonly helmfile: HelmfilePort;
  readonly discovery: DiscoveryPort;

  constructor(options: VesselForgeHostOptions) {
    this.fs = new BunFileSystemAdapter();
    this.proc = new BunProcessAdapter();
    this.fetchAdapter = new FetchAdapter();

    // Use provided ports or create defaults from adapters
    this.docker = options.docker ?? new BunDockerAdapter(this.proc);
    this.helmfile = options.helmfile ?? new BunHelmfileAdapter(this.proc);
    this.discovery =
      options.discovery ??
      new HttpDiscoveryAdapter(
        this.fetchAdapter,
        options.discoveryEndpoint ?? "http://discovery-vessel:8080",
      );

    this.runtime = new ExecutionRuntime({
      eventSink: options.eventSink,
      traceSink: options.traceSink,
      attachedVessels: [
        { id: "bun-fs", kind: "filesystem", resolverIds: ["file-read"] },
        { id: "bun-proc", kind: "process", resolverIds: ["bash"] },
        { id: "llm-vessel", kind: "llm", resolverIds: ["llm"] },
        { id: "docker-vessel", kind: "docker", resolverIds: ["docker_build_push"] },
        {
          id: "helmfile-vessel",
          kind: "helmfile",
          resolverIds: ["helmfile_sync"],
        },
        {
          id: "discovery-vessel",
          kind: "discovery",
          resolverIds: ["verify_three_invariants"],
        },
        {
          id: "forge-vessel",
          kind: "forge",
          resolverIds: [
            "scaffold_vessel_skeleton",
            "wire_discovery_registration",
            "wire_auth_blueprint",
          ],
        },
      ],
    });

    // Register forge resolvers
    this.runtime.resolvers.register(
      makeScaffoldVesselSkeletonResolver(this.fs, this.fetchAdapter, options.llm),
    );
    this.runtime.resolvers.register(
      makeWireDiscoveryRegistrationResolver(this.fs, this.fetchAdapter, options.llm),
    );
    this.runtime.resolvers.register(
      makeWireAuthBlueprintResolver(this.fs, this.fetchAdapter, options.llm),
    );
    this.runtime.resolvers.register(makeDockerBuildPushResolver(this.docker));
    this.runtime.resolvers.register(makeHelmfileSyncResolver(this.fs, this.helmfile));
    this.runtime.resolvers.register(
      makeVerifyThreeInvariantsResolver(this.discovery, this.fetchAdapter),
    );

    this.executor = new ActivityExecutor(this.runtime);
  }

  /** Execute a forge template and return its trace */
  execute(
    template: ActivityTemplate,
    options?: Parameters<ActivityExecutor["execute"]>[1],
  ): Promise<ExecutionTrace> {
    return this.executor.execute(template, options);
  }

  /** List all capability vessels attached to this host */
  listCapabilities(): Promise<import("../ontology").AttachedVessel[]> {
    return this.runtime.listAttachedVessels();
  }
}
