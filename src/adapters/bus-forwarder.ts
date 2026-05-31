import type { EventSink } from "../ports";
import type { LifecycleEvent } from "../ontology";

/**
 * BusForwardingEventSink — wraps an inner EventSink and forwards each emit
 * to activity-api's substrate event bus via POST /v2/events/publish.
 *
 * Per openspec change 2026-05-27-neutral-emitter-lifecycle-bus, the
 * `lifecycle-events-bridge` capability. Engine lifecycle events that today
 * only reach in-process subscribers now also flow onto the substrate WS bus
 * so any vessel (concept-db, ribosome, audit-vessel, future analyzers) can
 * subscribe by connecting to wss://activity-api/ws.
 *
 * The inner sink is called first, synchronously. The HTTP forwarding is
 * fire-and-forget: no `await`, no retry, errors logged via console.warn only.
 * Engine progression must not block on bus availability — durable state lives
 * in the trace store; the bus is a hot reactivity channel.
 *
 * Event-name mapping: replace `:` with `.` and convert camelCase to snake_case.
 *   lifecycle:task:preBinding       → lifecycle.task.pre_binding
 *   lifecycle:execution:succeeded   → lifecycle.execution.succeeded
 *   lifecycle:gap:classified        → lifecycle.gap.classified
 *   lifecycle:llm:dispatched        → lifecycle.llm.dispatched
 *
 * Event types that are already in dotted snake_case (e.g. "task.completed"
 * emitted by some adapters) pass through unchanged.
 */
export interface BusForwardingEventSinkOptions {
  /** Inner EventSink the engine emits to first. Existing behaviour preserved. */
  inner: EventSink;
  /** Activity-api base URL (e.g. http://localhost:8080). */
  activityApiEndpoint: string;
  /** API key used in the Authorization header on each publish. Optional; if
   *  unset, publish requests go without auth (activity-api may reject). */
  apiKey?: string;
  /** Identity stamped on every published event so subscribers can attribute. */
  sourceVesselId: string;
  /** Per-publish HTTP timeout in ms. Default 2000. */
  publishTimeoutMs?: number;
  /** Optional fetch override for tests; defaults to globalThis.fetch. */
  fetchFn?: typeof globalThis.fetch;
  /** Optional logger override; defaults to console. */
  logger?: { warn(msg: string, meta?: unknown): void };
}

/**
 * Convert an in-process event name to its substrate-bus form.
 *   colon-separated  → dot-separated
 *   camelCase parts  → snake_case
 *
 * Examples:
 *   lifecycle:task:preBinding         → lifecycle.task.pre_binding
 *   activity.started                  → activity.started   (already dotted)
 *   lifecycle:execution:succeeded     → lifecycle.execution.succeeded
 *   tool.callDispatched               → tool.call_dispatched
 */
export function mapEventTypeToBusForm(eventType: string): string {
  const dotted = eventType.replace(/:/g, ".");
  return dotted
    .split(".")
    .map((segment) =>
      segment
        // Insert underscore between lower→upper transitions
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        // Insert underscore between adjacent caps where followed by lowercase
        .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
        .toLowerCase(),
    )
    .join(".");
}

export class BusForwardingEventSink implements EventSink {
  private readonly inner: EventSink;
  private readonly publishUrl: string;
  private readonly apiKey?: string;
  private readonly sourceVesselId: string;
  private readonly publishTimeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly logger: { warn(msg: string, meta?: unknown): void };
  private outageLogged = false;

  constructor(opts: BusForwardingEventSinkOptions) {
    this.inner = opts.inner;
    this.publishUrl = opts.activityApiEndpoint.replace(/\/$/, "") + "/v2/events/publish";
    this.apiKey = opts.apiKey;
    this.sourceVesselId = opts.sourceVesselId;
    this.publishTimeoutMs = opts.publishTimeoutMs ?? 2000;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger ?? console;
  }

  async emit(event: LifecycleEvent): Promise<void> {
    // Inner sink first — preserves all existing in-process subscribers.
    // We swallow errors here to avoid masking the forwarding work; the inner
    // sink is responsible for its own error handling, and the engine treats
    // emit errors as terminal — propagating an inner-sink throw is the
    // expected behavior. So we ONLY catch on the forwarder side, not here.
    try {
      const inner = this.inner.emit(event);
      if (inner && typeof (inner as Promise<void>).then === "function") {
        await inner;
      }
    } catch (err) {
      // Inner sink threw. Per the EventSink contract that's a terminal
      // condition. Re-throw so the engine sees it.
      throw err;
    }

    // Fire-and-forget bus forward. Never throws.
    this.forward(event);
  }

  /** Fire-and-forget HTTP publish. Errors logged once per outage window. */
  private forward(event: LifecycleEvent): void {
    const busType = mapEventTypeToBusForm(event.type);
    const body = JSON.stringify({
      type: busType,
      source_vessel_id: this.sourceVesselId,
      data: {
        ...(event.data ?? {}),
        original_event_type: event.type,
        emitted_at_ms: event.timestamp,
      },
    });

    void (async () => {
      try {
        const res = await this.fetchFn(this.publishUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey ? { Authorization: `ApiKey ${this.apiKey}` } : {}),
          },
          body,
          signal: AbortSignal.timeout(this.publishTimeoutMs),
        });
        if (!res.ok) {
          if (!this.outageLogged) {
            this.logger.warn(
              `[BusForwardingEventSink] publish HTTP ${res.status} for ${busType} ` +
                "(suppressing further outage logs)",
            );
            this.outageLogged = true;
          }
        } else if (this.outageLogged) {
          this.logger.warn("[BusForwardingEventSink] bus recovered");
          this.outageLogged = false;
        }
        // CRITICAL: drain the response body even on success. Bun's native
        // HTTP layer retains the response's underlying readable stream
        // (anonymous mmap'd pipe buffers) until consumed or cancelled.
        // Leaving this dangling is invisible to V8 heap accounting but
        // shows up in cgroup memory + /proc/<pid>/maps as anonymous rw-p
        // mappings. With one publish per lifecycle event (~6–12 per task,
        // dozens per execution), this is the dominant per-runGoal leak.
        // See `concept_response_pattern_oom_cascade_solved`.
        try {
          await res.body?.cancel();
        } catch {
          // body may already be closed; swallow.
        }
      } catch (err) {
        if (!this.outageLogged) {
          this.logger.warn(
            `[BusForwardingEventSink] publish failed for ${busType}: ${(err as Error).message} ` +
              "(suppressing further outage logs)",
          );
          this.outageLogged = true;
        }
      }
    })();
  }
}
