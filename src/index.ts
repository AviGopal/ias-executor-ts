export * from "./ontology";
export * from "./ports";
export * from "./impulses";
export * from "./resolvers";
export * from "./runtime";
export * from "./engine";
export * from "./lifecycle-subscriber";
export * from "./templates";

// Hosts — composed entry points. Spec:
//   openspec/changes/2026-05-19-ias-executor-as-canonical-host §G
//   openspec/changes/2026-05-23-substrate-explicit-vessels Phase 0
// The canonical location is src/hosts/; the examples/goal-host.ts copy
// is kept for backward compatibility (imports that already use it still work).
export { GoalHost } from "./examples/goal-host";
export type { GoalHostOptions, GoalRunResult } from "./examples/goal-host";

// hosts/ — VesselDaemon toolkit (Phase 0). Also re-exports GoalHost from
// its promoted location so new code can import from the canonical path.
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
