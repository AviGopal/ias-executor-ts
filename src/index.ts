export * from "./ontology";
export * from "./ports";
export * from "./impulses";
export * from "./resolvers";
export * from "./runtime";
export * from "./engine";
export * from "./impulse-provenance";
export * from "./lifecycle-subscriber";
export * from "./templates";
export * from "./write-door";

// hosts/ — VesselDaemon toolkit (Phase 0). GoalHost lives in src/hosts/goal-host.ts.
export * from "./hosts";

// Activity-api adapters — exposed at the top level so hosts can compose
// them without reaching into the `./adapters/` subpath.
export { ActivityApiAdapter } from "./adapters/activity-api-adapter";
export type {
  RecommendRequest,
  RecommendCandidate,
  RecommendResponse,
  ActivityApiAdapterOptions,
} from "./adapters/activity-api-adapter";
export { TranslatingTraceSink } from "./adapters/activity-api-trace-sink";
export type { TranslatingTraceSinkOptions } from "./adapters/activity-api-trace-sink";

// Bun adapters — promoted to top-level exports (task 0.5).
export { BunFileSystemAdapter } from "./adapters/bun-filesystem";
export { BunProcessAdapter } from "./adapters/bun-process";
export { FetchAdapter } from "./adapters/fetch-adapter";

// Read and report package name and version from package.json at startup.
import pkg from "../package.json";
console.log(`Starting ${pkg.name} v${pkg.version}`);
