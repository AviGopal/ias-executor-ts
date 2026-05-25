export * from "./ontology";
export * from "./ports";
export * from "./impulses";
export * from "./resolvers";
export * from "./runtime";
export * from "./engine";
export * from "./lifecycle-subscriber";
export * from "./templates";

// hosts/ — VesselDaemon toolkit (Phase 0). GoalHost canonical location is
// src/hosts/goal-host.ts. The examples/goal-host.ts copy is kept for
// backward compat but is no longer re-exported here (would shadow the
// updated hosts/ version and lose new opts like `tags`).
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
