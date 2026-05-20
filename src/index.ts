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
export { GoalHost } from "./examples/goal-host";
export type { GoalHostOptions, GoalRunResult } from "./examples/goal-host";

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
