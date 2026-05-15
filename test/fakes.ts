import type { ExecutionTrace, LifecycleEvent } from "../src/ontology";
import type { ClockPort, EventSink, RandomPort, TraceSink } from "../src/ports";

/** Clock that advances by a fixed step on each call, giving deterministic timestamps */
export class SteppingClock implements ClockPort {
  private current: number;
  private readonly step: number;

  constructor(start = 0, step = 10) {
    this.current = start;
    this.step = step;
  }

  now(): number {
    const t = this.current;
    this.current += this.step;
    return t;
  }
}

/** Random that produces sequential IDs: prefix_0001, prefix_0002, … */
export class SequentialRandom implements RandomPort {
  private counters = new Map<string, number>();

  id(prefix = "id"): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(4, "0")}`;
  }
}

/** EventSink that records all emitted events for assertions */
export class EventSinkSpy implements EventSink {
  readonly events: LifecycleEvent[] = [];

  emit(event: LifecycleEvent): void {
    this.events.push(event);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  ofType(type: LifecycleEvent["type"]): LifecycleEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}

/** TraceSink that records all traces for assertions */
export class TraceSinkSpy implements TraceSink {
  readonly traces: ExecutionTrace[] = [];

  async record(trace: ExecutionTrace): Promise<void> {
    this.traces.push(trace);
  }

  last(): ExecutionTrace | undefined {
    return this.traces[this.traces.length - 1];
  }
}

/** TraceSink that always throws, for testing error paths */
export class FailingTraceSink implements TraceSink {
  async record(_trace: ExecutionTrace): Promise<void> {
    throw new Error("TraceSink failure (intentional test error)");
  }
}
