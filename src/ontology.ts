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

export interface ActivityTask {
  id: string;
  description: string;
  resolver: string;
  inputShapes?: string[];
  outputShapes?: string[];
  config?: Record<string, unknown>;
  /** When resolver is "compose", dispatch to this template id via the templateProvider */
  subActivityId?: string;
}

export interface ActivityTemplate {
  id: string;
  name: string;
  description?: string;
  inputShapes?: string[];
  outputShapes?: string[];
  tasks: ActivityTask[];
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
  success: boolean;
  error?: string;
  costUsd?: number;
  durationMs?: number;
  childExecutionId?: string;
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
}

export interface LifecycleEvent {
  type:
    | "activity.started"
    | "task.started"
    | "task.completed"
    | "activity.completed"
    | "activity.failed"
    | "impulse.created"
    | "impulse.loaded"
    | "lifecycle.emitted";
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
