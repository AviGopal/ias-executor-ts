import type { Impulse, ImpulseMetadata, ImpulsePointer, ImpulsePriority } from "./ontology";
import { getImpulseShape } from "./ontology";

export interface CreateImpulseInput {
  id: string;
  pointer: ImpulsePointer;
  metadata?: ImpulseMetadata;
  loaded?: boolean;
  content?: unknown;
  budget?: number;
  priority?: ImpulsePriority;
}

export interface ImpulseContextEntry {
  id: string;
  shape: string;
  summary: string | null;
  loaded: boolean;
  content?: unknown;
}

export interface FormatForContextOptions {
  /** If specified, only include impulses whose shape is in this list */
  shapes?: string[];
  /** If true, include loaded content in the result */
  includeContent?: boolean;
}

export class ImpulseStore {
  private readonly impulses = new Map<string, Impulse>();

  create(input: CreateImpulseInput): Impulse {
    const impulse: Impulse = {
      id: input.id,
      pointer: input.pointer,
      metadata: input.metadata ?? {},
      loaded: input.loaded ?? false,
      content: input.content,
      budget: input.budget,
      priority: input.priority,
    };
    this.impulses.set(impulse.id, impulse);
    return impulse;
  }

  put(impulse: Impulse): void {
    this.impulses.set(impulse.id, impulse);
  }

  /** Partial update — merges fields into the stored copy */
  update(id: string, patch: Partial<Omit<Impulse, "id">>): Impulse | undefined {
    const existing = this.impulses.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch };
    this.impulses.set(id, updated);
    return updated;
  }

  /** Mark an impulse as unloaded and clear its content */
  unload(id: string): Impulse | undefined {
    return this.update(id, { loaded: false, content: undefined });
  }

  get(id: string): Impulse | undefined {
    return this.impulses.get(id);
  }

  all(): Impulse[] {
    return Array.from(this.impulses.values());
  }

  findByShape(shape: string): Impulse[] {
    return this.all().filter((impulse) => getImpulseShape(impulse) === shape);
  }

  loadedSummaries(): Array<{ id: string; shape: string; summary: string | null }> {
    return this.all()
      .filter((impulse) => impulse.loaded)
      .map((impulse) => ({
        id: impulse.id,
        shape: getImpulseShape(impulse),
        summary:
          typeof impulse.metadata.summary === "string" ? impulse.metadata.summary : null,
      }));
  }

  /**
   * Metadata-first view of the pool suitable for injecting into LLM prompts or
   * UI panels without needing to load content. Content is only included when
   * includeContent=true AND the impulse is already loaded.
   */
  formatForContext(options: FormatForContextOptions = {}): ImpulseContextEntry[] {
    let candidates = this.all();
    if (options.shapes && options.shapes.length > 0) {
      const shapeSet = new Set(options.shapes);
      candidates = candidates.filter((impulse) => shapeSet.has(getImpulseShape(impulse)));
    }
    return candidates.map((impulse) => {
      const entry: ImpulseContextEntry = {
        id: impulse.id,
        shape: getImpulseShape(impulse),
        summary: typeof impulse.metadata.summary === "string" ? impulse.metadata.summary : null,
        loaded: impulse.loaded,
      };
      if (options.includeContent && impulse.loaded) {
        entry.content = impulse.content;
      }
      return entry;
    });
  }
}
