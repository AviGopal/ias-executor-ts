import type { AttachedVessel, ActivityTemplate, ExecutionTrace, LifecycleEvent } from "./ontology";
import type { AttachedVesselRegistry, ClockPort, EventSink, RandomPort, TemplateProvider, TraceSink } from "./ports";
import { ImpulseStore } from "./impulses";
import { ResolverRegistry } from "./resolvers";

class NoopEventSink implements EventSink {
  emit(_event: LifecycleEvent): void {}
}

class NoopTraceSink implements TraceSink {
  async record(_trace: ExecutionTrace): Promise<void> {}
}

class SystemClock implements ClockPort {
  now(): number {
    return Date.now();
  }
}

class DefaultRandom implements RandomPort {
  id(prefix = "id"): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

class StaticAttachedVesselRegistry implements AttachedVesselRegistry {
  constructor(private readonly vessels: AttachedVessel[]) {}

  list(): AttachedVessel[] {
    return [...this.vessels];
  }

  add(vessel: AttachedVessel): void {
    this.vessels.push(vessel);
  }
}

export interface ExecutionRuntimeOptions {
  clock?: ClockPort;
  random?: RandomPort;
  eventSink?: EventSink;
  traceSink?: TraceSink;
  templateProvider?: TemplateProvider;
  attachedVessels?: AttachedVessel[];
}

export class ExecutionRuntime {
  readonly store: ImpulseStore;
  readonly resolvers: ResolverRegistry;
  readonly clock: ClockPort;
  readonly random: RandomPort;
  readonly eventSink: EventSink;
  readonly traceSink: TraceSink;
  templateProvider?: TemplateProvider;
  readonly attachedVessels: AttachedVesselRegistry;
  private readonly attachedVesselRegistry: StaticAttachedVesselRegistry;

  constructor(options: ExecutionRuntimeOptions = {}) {
    this.store = new ImpulseStore();
    this.resolvers = new ResolverRegistry();
    this.clock = options.clock ?? new SystemClock();
    this.random = options.random ?? new DefaultRandom();
    this.eventSink = options.eventSink ?? new NoopEventSink();
    this.traceSink = options.traceSink ?? new NoopTraceSink();
    this.templateProvider = options.templateProvider;
    this.attachedVesselRegistry = new StaticAttachedVesselRegistry(options.attachedVessels ?? []);
    this.attachedVessels = this.attachedVesselRegistry;
  }

  attachVessel(vessel: AttachedVessel): ExecutionRuntime {
    this.attachedVesselRegistry.add(vessel);
    return this;
  }

  async listAttachedVessels(): Promise<AttachedVessel[]> {
    return await this.attachedVessels.list();
  }

  registerTemplateProvider(provider: TemplateProvider): ExecutionRuntime {
    this.templateProvider = provider;
    return this;
  }
}

export class InMemoryTemplateProvider implements TemplateProvider {
  private readonly templates = new Map<string, ActivityTemplate>();

  register(template: ActivityTemplate): void {
    this.templates.set(template.id, template);
  }

  async getTemplate(templateId: string): Promise<ActivityTemplate | null> {
    return this.templates.get(templateId) ?? null;
  }
}
