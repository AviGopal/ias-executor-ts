/**
 * THE WRITE DOOR, TASK LEVEL: a template run for a dispatch NOT admitted as a change skips every task that would write.
 *
 * Measured: on a goal not admitted as a change, a learned composition the walk picked ran its own tasks uiPanel_write,
 * code_modification_proposal and an activity-as-resolver whose child wrote concept_write. The host's write doors
 * (goal-host src/write-door.ts) filter the walk's picks, targets and composites by their DECLARED shapes; a template's
 * own tasks are not picks, so none of those doors saw them. The engine is where every task, composed children included,
 * is dispatched, so the host hands its door here.
 *
 * THE OPTION (ExecuteOptions.writeDoor): `{ admitted, governs }`. The host owns the class decision; `governs(shape)` is
 * its predicate (a change shape, or a store write outside the goal's own product), so this module keeps no list.
 *   - ABSENT  ⇒ every task runs. That is the default for every caller that does not pass it: lifecycle subscribers,
 *     ribosome extraction, tests, other hosts. Back-compatible by construction.
 *   - admitted: true ⇒ every task runs.
 *   - admitted: false ⇒ a task whose resolver id, pointer type or any declared output shape `governs` refuses is SKIPPED: no resolver
 *     runs, the task record carries skipped:true with skipReason "write_door_not_admitted", the task.skipped event names
 *     the shapes, one tagged line is logged, and writeDoorTaskCounters counts it. A task depending on it is
 *     dependency-skipped. compose / compose_parallel and activities-as-resolvers pass the option to their children.
 * The resolver id counts because a vessel resolver is registered under the shape it serves (`uiPanel_write/pattern`
 * in the measured trace), so a task can write without declaring the shape as an output; servedShape strips the `/kind`.
 */
import type { ActivityTask } from "./ontology";

export interface WriteDoorOption {
  /** The dispatch was admitted as a change: every task runs. */
  admitted: boolean;
  /** The host's governed class: true when producing `shape` is refused on a dispatch not admitted. */
  governs: (shape: string) => boolean;
}

export const WRITE_DOOR_SKIP_REASON = "write_door_not_admitted";

const counters = { dropped_tasks: 0, by_shape: {} as Record<string, number> };

/** Tasks skipped at the door since process start, in total and per refused shape (for a host's /health). */
export function writeDoorTaskCounters(): { dropped_tasks: number; by_shape: Record<string, number> } {
  return { dropped_tasks: counters.dropped_tasks, by_shape: { ...counters.by_shape } };
}
export function resetWriteDoorTaskCounters(): void {
  counters.dropped_tasks = 0;
  counters.by_shape = {};
}

/** The shape a resolver id serves: a vessel resolver is registered as `<shape>/<kind>`, so the id less its final
 *  `/segment`; an id with no `/` is its own shape. Compare this, not the raw id, to a shape name. */
export function servedShape(resolverId: string): string {
  const slash = resolverId.lastIndexOf("/");
  return slash > 0 ? resolverId.slice(0, slash) : resolverId;
}

/** The shapes this task would write that the door refuses; empty when the task runs.
 *  An impulse-resolve task writes the shape its config.pointer.type names (audit-test-report's test_audit_report_write,
 *  ribosome-extract's activityTemplate_write), so that type counts too. The engine checks before interpolation, so a
 *  `{{…}}` pointer type, or one set at run time from pointerFromImpulseSlots, is not recognised here; impulse-resolve
 *  checks the final type itself before it sends (and, when not admitted, refuses a type it cannot read). */
export function refusedTaskWrites(task: Pick<ActivityTask, "resolver" | "outputShapes" | "config">, door: WriteDoorOption | undefined): string[] {
  if (!door || door.admitted === true || typeof door.governs !== "function") return [];
  const pointer = (task.config as { pointer?: { type?: unknown } } | undefined)?.pointer;
  const pointerType = pointer && typeof pointer === "object" ? pointer.type : undefined;
  // The raw id too, for a host that registers bare ids.
  const resolver = typeof task.resolver === "string" ? task.resolver : undefined;
  const shapes = [resolver, resolver && servedShape(resolver), pointerType, ...(Array.isArray(task.outputShapes) ? task.outputShapes : [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0 && s !== "compose" && s !== "compose_parallel");
  return [...new Set(shapes)].filter((s) => door.governs(s));
}

/** The marker refused for a resolve POST whose body names no literal impulse type (goal-host's door uses the same). */
export const OPAQUE_RESOLVE_WRITE = "opaque_resolve_write";

/** The shapes an http_fetch task's POST to an impulse resolve endpoint would write that the door refuses; empty when it
 *  runs. Such a task writes whatever impulse its BODY names, so its resolver id, pointer type and outputs say nothing of
 *  it. The same classification as goal-host's door, judged here on the BOUND config (call it after template binding):
 *  - an http_fetch task: resolver (less its `/kind`), config.type or config.pointer.type is `http_fetch`; the request is
 *    config.pointer when that carries the url, else config;
 *  - GET/HEAD (the http_fetch default) and a POST to a URL whose path does not end in `/resolve` (`/v2/impulses/resolve`
 *    included) are not judged; any host counts, since a remote resolve POST writes too;
 *  - the body's impulse.type, impulse.pointer.type, pointer.type and type are judged like a native task's shape;
 *  - a missing or unparseable body, one naming no literal type, or one still holding `{{` is OPAQUE_RESOLVE_WRITE,
 *    refused without asking governs (fail closed). */
export function refusedResolvePostWrites(task: Pick<ActivityTask, "resolver" | "config">, door: WriteDoorOption | undefined): string[] {
  if (!door || door.admitted === true || typeof door.governs !== "function") return [];
  const field = (o: unknown, k: string): unknown => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined);
  const config = task.config;
  const pointer = field(config, "pointer");
  const isFetch =
    (typeof task.resolver === "string" && servedShape(task.resolver) === "http_fetch") ||
    field(config, "type") === "http_fetch" ||
    field(pointer, "type") === "http_fetch";
  if (!isFetch) return [];
  const request = typeof field(pointer, "url") === "string" ? pointer : config;
  const url = field(request, "url");
  if (typeof url !== "string") return [];
  const method = field(request, "method");
  const verb = typeof method === "string" ? method.toUpperCase() : "GET";
  if (verb === "GET" || verb === "HEAD") return [];
  if (!url.split(/[?#]/)[0]!.replace(/\/+$/, "").endsWith("/resolve")) return [];
  const raw = field(request, "body");
  let body: unknown = raw;
  if (typeof raw === "string") {
    if (raw.includes("{{")) return [OPAQUE_RESOLVE_WRITE];
    try {
      body = JSON.parse(raw);
    } catch {
      return [OPAQUE_RESOLVE_WRITE];
    }
  } else if (raw && typeof raw === "object" && JSON.stringify(raw).includes("{{")) {
    return [OPAQUE_RESOLVE_WRITE];
  }
  const impulse = field(body, "impulse");
  const types = [field(impulse, "type"), field(field(impulse, "pointer"), "type"), field(field(body, "pointer"), "type"), field(body, "type")]
    .filter((s): s is string => typeof s === "string" && s.length > 0);
  if (types.length === 0) return [OPAQUE_RESOLVE_WRITE];
  return [...new Set(types)].filter((s) => door.governs(s));
}

/** Count one skipped task and return its tagged line. */
export function noteTaskWriteDrop(refused: readonly string[]): string {
  counters.dropped_tasks++;
  for (const s of refused) counters.by_shape[s] = (counters.by_shape[s] ?? 0) + 1;
  return `[write-door] ias dropped task ${refused.join(",")} (dispatch not admitted)`;
}
