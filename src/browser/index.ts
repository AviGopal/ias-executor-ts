/**
 * Browser-compatible entry point for ias-executor-ts.
 *
 * Re-exports everything from the core (ontology, ports, impulses, resolvers,
 * runtime, engine) plus the fetch-compatible adapters.  Does NOT export
 * BunFileSystemAdapter or BunProcessAdapter — those require Bun APIs.
 *
 * Downstream bundlers (Vite, esbuild, webpack) tree-shake unused exports.
 * Import from "@avigopal/ias-executor-ts/browser" instead of the default
 * entry when targeting browsers or edge runtimes.
 */

// Core — zero host dependencies, works everywhere
export * from "../ontology";
export * from "../ports";
export * from "../impulses";
export * from "../resolvers";
export * from "../runtime";
export * from "../engine";

// Browser-safe adapters
export { FetchAdapter } from "../adapters/fetch-adapter";
export { ActivityApiTemplateProvider, ActivityApiRecommendationProvider, ActivityApiTraceSink } from "../adapters/activity-api-provider";
export { VesselResolver } from "../adapters/vessel-resolver";
export { DiscoveryCapabilityIndex, StaticCapabilityIndex } from "../adapters/discovery-capability-index";
