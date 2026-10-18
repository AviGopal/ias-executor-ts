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
 * in the measured trace), so a task can write without declaring the shape as an output.
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

/** The shapes this task would write that the door refuses; empty when the task runs.
 *  An impulse-resolve task writes the shape its config.pointer.type names (audit-test-report's test_audit_report_write,
 *  ribosome-extract's activityTemplate_write), so that type counts too. The engine checks before interpolation, so a
 *  `{{…}}` pointer type, or one set at run time from pointerFromImpulseSlots, is not recognised here; impulse-resolve
 *  checks the final type itself before it sends (and, when not admitted, refuses a type it cannot read). */
export function refusedTaskWrites(task: Pick<ActivityTask, "resolver" | "outputShapes" | "config">, door: WriteDoorOption | undefined): string[] {
  if (!door || door.admitted === true || typeof door.governs !== "function") return [];
  const pointer = (task.config as { pointer?: { type?: unknown } } | undefined)?.pointer;
  const pointerType = pointer && typeof pointer === "object" ? pointer.type : undefined;
  const shapes = [task.resolver, pointerType, ...(Array.isArray(task.outputShapes) ? task.outputShapes : [])]
    .filter((s): s is string => typeof s === "string" && s.length > 0 && s !== "compose" && s !== "compose_parallel");
  return [...new Set(shapes)].filter((s) => door.governs(s));
}

/** Count one skipped task and return its tagged line. */
export function noteTaskWriteDrop(refused: readonly string[]): string {
  counters.dropped_tasks++;
  for (const s of refused) counters.by_shape[s] = (counters.by_shape[s] ?? 0) + 1;
  return `[write-door] ias dropped task ${refused.join(",")} (dispatch not admitted)`;
}
