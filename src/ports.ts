import type { ActivityTemplate, AttachedVessel, ExecutionTrace, LifecycleEvent } from "./ontology";

export interface ClockPort {
  now(): number;
}

export interface RandomPort {
  id(prefix?: string): string;
}

export interface FileSystemPort {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
}

export interface ProcessPort {
  run(command: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface GitPort {
  status(cwd: string): Promise<string>;
  diff(cwd: string, revision?: string): Promise<string>;
}

export interface FetchPort {
  request(input: string, init?: RequestInit): Promise<Response>;
}

export interface LLMPort {
  generate(input: {
    prompt: string;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}

export interface UserInputPort {
  ask(question: string, options?: string[]): Promise<string>;
}

export interface TemplateProvider {
  getTemplate(templateId: string): Promise<ActivityTemplate | null>;
}

export interface RecommendationProvider {
  recommend(taskDescription: string): Promise<ActivityTemplate[]>;
}

export interface TraceSink {
  record(trace: ExecutionTrace): Promise<void>;
}

export interface EventSink {
  emit(event: LifecycleEvent): Promise<void> | void;
}

export interface CapabilityIndex {
  listResolverIds(): Promise<string[]>;
}

export interface AttachedVesselRegistry {
  list(): Promise<AttachedVessel[]> | AttachedVessel[];
}
