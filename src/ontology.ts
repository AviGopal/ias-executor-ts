export type ImpulsePriority = "critical" | "high" | "medium" | "low";

export interface ImpulsePointer {
  type: string;
  [key: string]: unknown;
}

export interface ImpulseMetadata {
  shape?: string;
  summary?: string;
  producedBy?: string;
  [key: string]: unknown;
}

export interface Impulse {
  id: string;
  pointer: ImpulsePointer;
  metadata: ImpulseMetadata;
  loaded: boolean;
  content?: unknown;
  budget?: number;
  priority?: ImpulsePriority;
}

/**
 * Predicate-constrained input shape reference.
 * Plain strings in inputShapes are equivalent to { shape, cardinality: "any" }.
 */
export interface InputShapeRef {
  shape: string;
  /** Filter candidates to those produced by this task id */
  producedBy?: string;
  /** "any" = pass all matching instances (default); "all" = pass full filtered list;
   *  "exactly_one" = error if filtered list has > 1 candidate */
  cardinality?: "any" | "all" | "exactly_one";
  /** Advisory affinity — execution hint only, not enforced until H2 */
  vessel_affinity?: string;
}

export interface ActivityTask {
  id: string;
  description: string;
  resolver: string;
  /** Accepts plain shape names or predicate-constrained InputShapeRef objects.
   *  Plain strings behave as { shape: s, cardinality: "any" }. */
  inputShapes?: (string | InputShapeRef)[];
  outputShapes?: string[];
  config?: Record<string, unknown>;
  /** When resolver is "compose", dispatch to this template id via the templateProvider */
  subActivityId?: string;
  /** When resolver is "compose_parallel", dispatch to ALL of these template ids
   *  concurrently as sibling trajectories sharing this task's parent execution id,
   *  then join their output impulse pools by shape-union (SUBSTRATE_AS_MDP §7
   *  horizontal composition — the breadth-first dual of vertical `compose`). */
  subActivityIds?: string[];
  /**
   * Shared-catalogue templates carry additional task fields beyond the
   * engine's minimum surface (notes, outputImpulses, inputImpulses,
   * optionalInputShapes, conditional, dependencies, retry, validation,
   * prompt, ...). The canonical executor doesn't read these — they are
   * consumed by host-side resolvers and lifecycle dispatchers — but the
   * loader needs JSON files to typecheck cleanly.
   *
   * See openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §F.
   */
  [extra: string]: unknown;
}

/**
 * Subscription declaration for meta-activities that fire on lifecycle events.
 * See openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §E.
 */
export interface ActivityTemplateSubscription {
  /** Lifecycle event type to subscribe to (e.g. "lifecycle:task:preBinding"). */
  shape: string;
  /** Optional structural filter; supports `_contains` / `_equals` suffix predicates. */
  filter?: Record<string, unknown>;
  /** When true, bypass top-K winnowing. Not load-bearing in the Phase 1 port. */
  must_fire?: boolean;
  /**
   * Optional dedupe-key template (test-audit-loop spec §H). Placeholders
   * `{field}` and `{nested.field}` resolve against the lifecycle payload.
   * Example: `"{test_registration_id}:{audit_subtype}"`.
   * May also live on the template directly (`ActivityTemplate.dedupe_key`)
   * for parity with minibob's split between subscription-level and
   * template-level dedupe keys.
   */
  dedupe_key?: string;
}

/**
 * Variable declaration carried on shared-catalogue templates. Consumed by
 * hosts that surface user-facing knobs (workbench, CLI flags); the executor
 * itself only reads `variables` opaquely through `ExecuteOptions.variables`.
 */
export interface ActivityTemplateVariable {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

export interface ActivityTemplate {
  id: string;
  name: string;
  description?: string;
  inputShapes?: string[];
  outputShapes?: string[];
  tasks: ActivityTask[];
  /** Tags for classification; consumed by depth-cap (`tags ∋ "audit"`). */
  tags?: string[];
  /** Free-form metadata (e.g. `auditDepthCap` consumed by the lifecycle subscriber). */
  metadata?: Record<string, unknown>;
  /** Lifecycle subscription declaration (design §E). */
  subscription?: ActivityTemplateSubscription;
  /** Top-level dedupe-key template (mirrors subscription.dedupe_key for parity). */
  dedupe_key?: string;
  /** Catalogue-canonical fields preserved from minibob templates. */
  category?: string;
  version?: string;
  variables?: ActivityTemplateVariable[];
  /** snake_case aliases used by some catalogue templates (audit-test-report etc.). */
  input_shapes?: string[];
  output_shapes?: string[];
  /**
   * Catalogue templates occasionally carry vessel-specific fields
   * (`composition`, `hooks`, `integration`, `learning`, `metabob`,
   * `contextRequirements`, ...). The executor ignores them; the index
   * signature lets the JSON imports typecheck without per-template
   * carve-outs. See openspec/changes/2026-05-19-ias-executor-as-canonical-host/design.md §F.
   */
  [extra: string]: unknown;
}

export type ResolverTier = "deterministic" | "pattern" | "llm" | "external";

export interface FailureMode {
  type: string;
  reason: string;
  context?: Record<string, unknown>;
}

export interface ExecutionTaskRecord {
  taskId: string;
  description: string;
  resolverId: string;
  resolverTier?: ResolverTier;
  inputImpulseIds: string[];
  outputImpulseIds: string[];
  /** Declared input shapes for this task (template.tasks[i].inputShapes, normalized
   *  to bare shape names). Populated by the engine so the trace sink can union
   *  per-task inputShapes into the top-level trace.input_impulse_shapes — the
   *  field that activity-api's server-side state_signature path
   *  (execution-traces.ts:2381-2390) requires for context_thompson_scores.
   *  Without this, autonomous traces ship empty input_impulse_shapes and the
   *  M1 continuous trainer reports n_training_samples=0 every cycle. */
  inputShapes?: string[];
  /** Actual shapes of the output impulses produced by this task.
   *  Populated from impulse.metadata.shape at execution time so coverage_tick
   *  and activity-api trace queries reflect what was genuinely produced,
   *  not just what the template declares it might produce. */
  outputShapes?: string[];
  success: boolean;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  childExecutionId?: string;
  /** Producer task ids whose outputs this task consumed via {{<taskId>}} /
   *  {{<taskId>_<shape>}} placeholder references. The provenance signal for
   *  placeholder-based composition (option B): combined with childActivityId it
   *  yields a genuine producer->consumer capability edge when the referenced
   *  producer task dispatched an activity. Captured at runtime because
   *  actualPrompt has placeholders already substituted by persist time, so this
   *  cannot be recovered reconcile-side. */
  consumedFromTaskIds?: string[];
  /** When this task dispatched a sub-activity (resolver "compose" /
   *  "compose_parallel" or an activities-as-resolvers id), the dispatched
   *  activity's template id. Lets the composition-edge reconcile map a consumed
   *  producer task -> its producing activity to derive activity->activity edges. */
  childActivityId?: string;
}

export interface ExecutionTrace {
  id: string;
  templateId: string;
  templateName?: string;
  status: "completed" | "failed";
  reason?: string;
  parentExecutionId?: string;
  compositionChain?: string[];
  inputImpulseIds: string[];
  outputImpulseIds: string[];
  tasks: ExecutionTaskRecord[];
  failureMode?: FailureMode;
  costUsd?: number;
  durationMs?: number;
  /** Classification tags propagated from `ExecuteOptions.tags`; consumed by
   *  trace-sinks and depth-cap predicates (e.g. `tags ∋ "audit"`). */
  tags?: string[];
  /**
   * Caller's originally-requested template id, when dispatch bypassed
   * recommendation (e.g. `POST /run-goal { targetTemplateId }`). When the
   * caller did NOT pin a target — i.e. selection ran and `templateId` is
   * whatever recommend returned — this field is undefined.
   *
   * Recorded so the substrate can detect dispatch-target drift
   * (caller pinned X, recommend/Thompson selected Y) without operator
   * inspection. See `concept_t2jHO8I-LxD3` (detection_template_pattern_dispatch_drift).
   */
  dispatchTargetTemplateId?: string;
  /** Optional free-form bag for cross-vessel metadata. The activity-api
   *  trace-sink stores this verbatim into `body.metadata` so future schema-
   *  free additions (e.g. dispatch-target instrumentation) don't require
   *  another wire-level rev. */
  metadata?: Record<string, unknown>;
}

/**
 * Built-in lifecycle event types emitted by ActivityExecutor. Open-ended:
 * the `lifecycle-subscriber` vessel (see lifecycle-subscriber.ts) matches on
 * arbitrary string types like `"lifecycle:task:preBinding"` once future
 * emissions are wired up. Keep the union as a documentation aid; the engine
 * accepts any string.
 */
export type LifecycleEventType =
  | "activity.started"
  | "task.started"
  | "task.completed"
  | "activity.completed"
  | "activity.failed"
  | "impulse.created"
  | "impulse.loaded"
  | "lifecycle.emitted"
  | (string & {});

export interface LifecycleEvent {
  type: LifecycleEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface AttachedVessel {
  id: string;
  kind: string;
  resolverIds: string[];
  metadata?: Record<string, unknown>;
}

export function getImpulseShape(impulse: Impulse): string {
  return impulse.metadata.shape ?? impulse.pointer.type;
}
