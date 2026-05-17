import type { ActivityTemplate, AttachedVessel, ExecutionTrace, LifecycleEvent } from "./ontology";

/**
 * Returns the current wall-clock time in milliseconds since epoch.
 * Implement with `Date.now()` (real time) or a stepping counter (tests).
 */
export interface ClockPort {
  now(): number;
}

/**
 * Generates unique identifiers with an optional namespace prefix.
 * Implement with `crypto.randomUUID()` (production) or a sequential counter (tests).
 */
export interface RandomPort {
  id(prefix?: string): string;
}

/**
 * Read and write files in the host's storage layer.
 * Implement with `Bun.file()` / `Bun.write()` for a Bun host, or `node:fs` for Node.
 * Keep adapter free of business logic; resolvers compose on top of it.
 */
export interface FileSystemPort {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

/**
 * Spawn and wait for OS processes.
 * Implement with `Bun.spawn()` for a Bun host.
 * Hosts that should not allow process execution must not attach this port.
 */
export interface ProcessPort {
  run(command: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

/**
 * Git VCS operations.
 * Implement via ProcessPort (shell out to `git`) or a native binding.
 * Expose only the methods needed; do not wrap the full git surface.
 */
export interface GitPort {
  status(cwd: string): Promise<string>;
  diff(cwd: string, revision?: string): Promise<string>;
}

/**
 * HTTP / HTTPS requests.
 * Implement with the global `fetch` in Bun or Node 18+.
 * Hosts that should not make outbound calls must not attach this port.
 */
export interface FetchPort {
  request(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * LLM text generation.
 * Implement by wrapping Anthropic, OpenAI, or any other model provider.
 * The core engine only calls this when a task explicitly resolves to "llm".
 * Hosts that do not supply this port cause "llm" tasks to fail with "not registered".
 */
export interface LLMPort {
  generate(input: {
    prompt: string;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}

/**
 * Human input (terminal prompt, workbench dialog, etc.).
 * Implement with readline for CLI hosts or a WebSocket channel for GUI hosts.
 * Hosts that should run non-interactively must not attach this port (tasks that
 * ask for user input will fail cleanly rather than hanging).
 */
export interface UserInputPort {
  ask(question: string, options?: string[]): Promise<string>;
}

/**
 * Look up activity templates by id.
 * Implement with an in-memory map (tests), a local JSON cache, or an HTTP call
 * to activity-api. Required for the "compose" built-in resolver to work.
 */
export interface TemplateProvider {
  getTemplate(templateId: string): Promise<ActivityTemplate | null>;
}

/**
 * Suggest activity templates for a given task description.
 * Implement by querying activity-api's Thompson Sampling recommend endpoint.
 * Optional — resolvers that do not need Thompson Sampling need not use this port.
 */
export interface RecommendationProvider {
  recommend(taskDescription: string): Promise<ActivityTemplate[]>;
}

/**
 * Persist completed execution traces.
 * Implement by POSTing to activity-api (`/v2/activities/execution-traces`) for
 * production hosts, or accumulating in an array for tests.
 * The engine always calls this — even on failure — so trace loss requires an
 * explicit no-op implementation.
 */
export interface TraceSink {
  record(trace: ExecutionTrace): Promise<void>;
}

/**
 * Receive lifecycle events emitted during execution.
 * Implement by forwarding to WebSocket (workbench), stdout (CLI), or a test spy.
 * The engine emits events synchronously; implementations may be async.
 * Errors thrown by emit are propagated to the engine and abort the execution.
 */
export interface EventSink {
  emit(event: LifecycleEvent): Promise<void> | void;
}

/**
 * Enumerate resolver ids available in the current execution context.
 * Implement with DiscoveryCapabilityIndex (dynamic, queries discovery-vessel)
 * or StaticCapabilityIndex (hardcoded, for offline/embedded hosts).
 * Used by resolvers that dispatch dynamically based on available capabilities;
 * the core engine itself does not consult this port.
 */
export interface CapabilityIndex {
  listResolverIds(): Promise<string[]>;
}

/**
 * Registry of attached capability vessels.
 * The engine reads this to determine which resolvers are explicitly available,
 * enabling hosts to fail-fast on missing capabilities rather than silently
 * falling through.
 */
export interface AttachedVesselRegistry {
  list(): Promise<AttachedVessel[]> | AttachedVessel[];
}

// ── Phase 22 forge ports ──────────────────────────────────────────────────────

/**
 * Build and push Docker images for forged vessels.
 * Implement with `BunDockerAdapter` (shells to `docker` via ProcessPort).
 * Registry auth is read from the `DOCKER_REGISTRY_AUTH` environment variable
 * (base64-encoded `user:password` — same format as `.docker/config.json`).
 * `build` throws on non-zero docker exit; `push` throws on auth failure or
 * registry unavailability. Both methods propagate stderr as the error message.
 */
export interface DockerPort {
  build(contextPath: string, tag: string, opts?: { buildArgs?: Record<string, string>; dockerfile?: string }): Promise<void>;
  push(tag: string, registry?: string): Promise<void>;
}

/**
 * Apply Helmfile overlays and wait for Kubernetes releases to become ready.
 * Implement with `BunHelmfileAdapter` (shells to `helmfile` + `kubectl` via ProcessPort).
 * `applyOverlay` runs `helmfile --file <overlayPath> sync`; throws on non-zero exit.
 * `waitForReady` polls `kubectl rollout status deployment/<release> -n <namespace>`
 * until ready or timeoutMs elapsed; throws `HelmfileTimeoutError` on timeout.
 * Both methods forward stderr to the thrown error for debuggability.
 */
export interface HelmfilePort {
  applyOverlay(overlayPath: string, cwd?: string): Promise<void>;
  waitForReady(release: string, namespace: string, timeoutMs: number): Promise<void>;
}

/** Minimal vessel summary returned by DiscoveryPort.lookupShapeProducers. */
export interface VesselSummary {
  id: string;
  resolveEndpoint: string;
  healthScore?: number;
  orgId?: string;
}

/** Minimal vessel registration payload for DiscoveryPort.registerVessel. */
export interface VesselRegistration {
  id: string;
  shapes: string[];
  resolveEndpoint: string;
  authScheme?: string;
  orgId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Query discovery-vessel for shape producers and register new vessels.
 * Implement with `HttpDiscoveryAdapter` (wraps FetchPort against discovery-vessel).
 * Results are cached for 30s to avoid thrashing; the cache is invalidated when
 * `registerVessel` completes successfully (new producers become immediately visible).
 * `lookupShapeProducers` returns an empty array (not a throw) when no producers
 * are registered — callers use this to gate the forge branch in slot-binding.
 * `registerVessel` throws on 4xx/5xx from discovery-vessel.
 */
export interface DiscoveryPort {
  lookupShapeProducers(shape: string, orgIds?: string[]): Promise<VesselSummary[]>;
  registerVessel(payload: VesselRegistration): Promise<void>;
}
