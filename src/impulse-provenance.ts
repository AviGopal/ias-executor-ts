/**
 * Impulse provenance — which execution an impulse in a SHARED store belongs to.
 *
 * A host keeps one ImpulseStore for every execution it runs (GoalHost builds one
 * ExecutionRuntime and one ActivityExecutor and runs goals, walk steps, lifecycle
 * subscribers and ribosome extractions on it concurrently). Slot binding used to take
 * the first store-wide match by `outputImpulseKey` or `shape`, so two concurrent runs
 * of a template that names its slots bound whichever run's impulse landed first:
 * measured live, 3 of 5 concurrent ribosome-extract runs cross-bound and one minted a
 * template synthesised from another run's trace, which an unrelated goal then ran.
 *
 * This ledger records, beside the store and without touching impulse metadata (seeds are
 * re-put per execution and the same object is seeded into concurrent siblings):
 *   - which execution PRODUCED each impulse, with that execution's composition chain;
 *   - which executions were SEEDED with it (a set — siblings share seeds);
 *   - which executions are LIVE, so eviction never deletes a running execution's data;
 *   - which finished outputs are RETAINED for the caller's read-back.
 *
 * Binding then asks one question — `originFor` — and the engine refuses `foreign`.
 */
import type { ConsumedImpulseOrigin, ConsumedImpulseProvenance, ExecutionTrace } from "./ontology";

interface ProducerRecord {
  executionId: string;
  chain: readonly string[];
}

/** What an execution may bind: itself, its chain, and the ids it was seeded with. */
export interface BindingScope {
  executionId: string;
  /** Ancestor execution ids, root-first. */
  chain: readonly string[];
  /** Ids seeded into this execution — the explicit cross-execution declaration. */
  declared: ReadonlySet<string>;
}

/** Lower is preferred when several in-scope impulses match one slot. */
export const ORIGIN_RANK: Record<ConsumedImpulseOrigin, number> = {
  own: 0,
  declared: 0,
  descendant: 1,
  ancestor: 2,
  ambient: 3,
  foreign: 99,
};

export class ProvenanceLedger {
  private readonly producedBy = new Map<string, ProducerRecord>();
  private readonly claimants = new Map<string, Set<string>>();
  private readonly live = new Map<string, readonly string[]>();
  /** Outputs of finished executions that no live execution owns, held so the caller can
   *  read them back after execute() returns; reaped at the next top-level entry. */
  readonly retained = new Set<string>();

  begin(executionId: string, chain: readonly string[]): void {
    this.live.set(executionId, [...chain]);
  }

  end(executionId: string): void {
    this.live.delete(executionId);
  }

  isLive(executionId: string): boolean {
    return this.live.has(executionId);
  }

  /** First producer wins: re-putting another execution's impulse (a compose parent
   *  stamping a slot on its child's output) must not re-attribute it. */
  recordProduced(impulseId: string, executionId: string, chain: readonly string[]): void {
    if (!this.producedBy.has(impulseId)) this.producedBy.set(impulseId, { executionId, chain: [...chain] });
  }

  claim(impulseId: string, executionId: string): void {
    let s = this.claimants.get(impulseId);
    if (!s) this.claimants.set(impulseId, (s = new Set()));
    s.add(executionId);
  }

  release(impulseId: string, executionId: string): void {
    const s = this.claimants.get(impulseId);
    if (!s) return;
    s.delete(executionId);
    if (s.size === 0) this.claimants.delete(impulseId);
  }

  /** Drop every record of an impulse that has left the store. */
  forget(impulseId: string): void {
    this.producedBy.delete(impulseId);
    this.claimants.delete(impulseId);
    this.retained.delete(impulseId);
  }

  producerOf(impulseId: string): ProducerRecord | undefined {
    return this.producedBy.get(impulseId);
  }

  originFor(impulseId: string, scope: BindingScope): ConsumedImpulseOrigin {
    if (scope.declared.has(impulseId)) return "declared";
    const prod = this.producedBy.get(impulseId);
    if (prod) {
      if (prod.executionId === scope.executionId) return "own";
      if (prod.chain.includes(scope.executionId)) return "descendant";
      if (scope.chain.includes(prod.executionId)) return "ancestor";
      return "foreign";
    }
    const owners = this.claimants.get(impulseId);
    if (!owners || owners.size === 0) return "ambient";
    for (const owner of owners) {
      if (owner === scope.executionId) return "declared";
      if (scope.chain.includes(owner)) return "ancestor";
      if (this.live.get(owner)?.includes(scope.executionId)) return "descendant";
    }
    return "foreign";
  }

  provenanceOf(impulseId: string, scope: BindingScope): ConsumedImpulseProvenance {
    const prod = this.producedBy.get(impulseId);
    return {
      impulseId,
      producerExecutionId: prod?.executionId ?? null,
      ...(prod ? { producerChain: [...prod.chain] } : {}),
      origin: this.originFor(impulseId, scope),
    };
  }

  /**
   * True when a LIVE execution still owns the impulse — seeded into it, produced by it,
   * or produced beneath it — or when it is a finished execution's retained output.
   * Eviction must leave these alone: deleting them is how one run's exit starved, or
   * (with first-match binding) redirected, a concurrent run.
   */
  isProtected(impulseId: string): boolean {
    if (this.retained.has(impulseId)) return true;
    const prod = this.producedBy.get(impulseId);
    if (prod) {
      if (this.live.has(prod.executionId)) return true;
      if (prod.chain.some((id) => this.live.has(id))) return true;
    }
    const owners = this.claimants.get(impulseId);
    if (owners) for (const o of owners) if (this.live.has(o)) return true;
    return false;
  }

  /** True when some execution in `chain` is still running. */
  anyLive(chain: readonly string[]): boolean {
    return chain.some((id) => this.live.has(id));
  }
}

const LEDGERS = new WeakMap<object, ProvenanceLedger>();

/** The ledger for a store. Keyed by the store object, so every executor sharing a
 *  runtime — GoalHost's, a subscriber's, a test's second instance — shares one ledger. */
export function provenanceLedger(store: object): ProvenanceLedger {
  let l = LEDGERS.get(store);
  if (!l) LEDGERS.set(store, (l = new ProvenanceLedger()));
  return l;
}

export interface ForeignConsumptionVerdict {
  /**
   * clean   — every consumed impulse was the run's own, declared, or nested-related.
   * foreign — at least one consumed impulse came from an unrelated execution.
   * unknown — the trace carries no provenance (written by an engine predating it).
   */
  status: "clean" | "foreign" | "unknown";
  foreign: Array<ConsumedImpulseProvenance & { taskId: string }>;
}

/**
 * Did this execution consume another, unrelated execution's impulse?
 *
 * The gate for reach verdicts and template extraction: a run fed another run's data can
 * complete, typecheck and read as reached while having done something other than what
 * was asked — and extracting it mints that mistake as a reusable template.
 *
 * Does not trust the recorded `origin` alone. Each entry with a known producer is
 * re-checked against the trace's own facts: produced by this execution, by one of its
 * ancestors (compositionChain), by an execution nested under it (producerChain contains
 * this id), or seeded into it (inputImpulseIds). An entry with no producer is a seed or
 * a host-placed impulse; it is foreign only when its recorded origin says so.
 */
export function foreignConsumption(
  trace: Pick<ExecutionTrace, "id" | "tasks" | "compositionChain" | "inputImpulseIds">,
): ForeignConsumptionVerdict {
  const foreign: ForeignConsumptionVerdict["foreign"] = [];
  const chain = new Set(trace.compositionChain ?? []);
  const seeded = new Set(trace.inputImpulseIds ?? []);
  let sawProvenance = false;
  for (const task of trace.tasks ?? []) {
    const entries = task.consumedProvenance;
    if (!Array.isArray(entries)) continue;
    sawProvenance = true;
    for (const e of entries) {
      let isForeign = e.origin === "foreign";
      const p = e.producerExecutionId;
      if (!isForeign && p) {
        const related =
          p === trace.id ||
          chain.has(p) ||
          (e.producerChain ?? []).includes(trace.id) ||
          seeded.has(e.impulseId);
        isForeign = !related;
      }
      if (isForeign) foreign.push({ ...e, taskId: task.taskId });
    }
  }
  if (foreign.length > 0) return { status: "foreign", foreign };
  return { status: sawProvenance ? "clean" : "unknown", foreign };
}
