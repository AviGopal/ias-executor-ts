import type { ActivityTask, ActivityTemplate, Impulse, ResolverTier } from "./ontology";
import type { AttachedVesselRegistry, ClockPort, EventSink, RandomPort, TemplateProvider, TraceSink } from "./ports";
import type { ImpulseStore } from "./impulses";

export interface ResolverContext {
  executionId: string;
  template: ActivityTemplate;
  task: ActivityTask;
  variables: Record<string, unknown>;
  inputImpulses: Impulse[];
  store: ImpulseStore;
  clock: ClockPort;
  random: RandomPort;
  eventSink: EventSink;
  traceSink: TraceSink;
  templateProvider?: TemplateProvider;
  attachedVessels: AttachedVesselRegistry;
  /**
   * Ancestor executionIds (root-first), populated by the engine from the
   * execute() options. Empty for top-level runs. Resolvers that dispatch
   * nested executions (e.g. activity, compose) read `.length` for recursion
   * guards. Read-only — resolvers must not mutate.
   */
  compositionChain?: readonly string[];
}

export interface Resolver {
  readonly id: string;
  readonly tier?: ResolverTier;
  resolve(context: ResolverContext): Promise<Impulse[]>;
}

export class ResolverRegistry {
  private readonly resolvers = new Map<string, Resolver>();

  register(resolver: Resolver): void {
    this.resolvers.set(resolver.id, resolver);
  }

  get(resolverId: string): Resolver | undefined {
    return this.resolvers.get(resolverId);
  }

  has(resolverId: string): boolean {
    return this.resolvers.has(resolverId);
  }

  list(): string[] {
    return Array.from(this.resolvers.keys()).sort();
  }
}
