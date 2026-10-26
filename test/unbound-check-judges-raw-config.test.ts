/**
 * The unbound-template-variable check judges the RAW task config, not the
 * substituted output. A bound value may itself carry {{...}} text — a drafted
 * activity template, a fetched page, handlebars code, an LLM answer quoting a
 * template — and that text is data, not an unbound reference. Rescanning the
 * substituted config failed such a correct dispatch closed with
 * `unbound_template_variable:<name from inside the value>`.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTemplate } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";

function makeRuntime() {
  return new ExecutionRuntime({
    clock: new SteppingClock(3_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
}

function fsWriteRecorder(calls: unknown[]): Resolver {
  return {
    id: "fs_write_fake",
    tier: "external",
    async resolve(ctx) {
      calls.push(ctx.task.config);
      return [{ id: ctx.random.id("out"), pointer: { type: "fs_write" }, metadata: { shape: "fs_write" }, loaded: true, content: "written" }];
    },
  };
}

describe("unbound check — a bound value carrying its own placeholders is data", () => {
  test("must-fail: {{draft_text}} bound to a value containing {{lifecycle.x}} and {{foo_text}} dispatches with the value verbatim", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(fsWriteRecorder(calls));
    const executor = new ActivityExecutor(runtime);
    const draft = "{{lifecycle.x}} and {{foo_text}}";

    const template: ActivityTemplate = {
      id: "gap-closing:bound-value-with-placeholders",
      name: "write a drafted template whose text carries placeholders",
      tasks: [
        {
          id: "write_draft",
          description: "write the drafted activity template",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/proposals/draft.json", content: "{{draft_text}}" },
        },
      ],
    };

    const trace = await executor.execute(template, { variables: { draft_text: draft } });

    const rec = trace.tasks.find((t) => t.taskId === "write_draft");
    expect(rec?.error).toBeUndefined();
    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/proposals/draft.json", content: draft }]);
  });

  test("an inline (partial-string) binding of the same value also dispatches verbatim", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(fsWriteRecorder(calls));
    const executor = new ActivityExecutor(runtime);
    const draft = "{{lifecycle.x}} and {{foo_text}}";

    const template: ActivityTemplate = {
      id: "gap-closing:inline-bound-value-with-placeholders",
      name: "inline-bind a value carrying placeholders",
      tasks: [
        {
          id: "write_draft",
          description: "write the drafted activity template",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/proposals/draft.txt", content: "draft: {{draft_text}}" },
        },
      ],
    };

    const trace = await executor.execute(template, { variables: { draft_text: draft } });

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/proposals/draft.txt", content: `draft: ${draft}` }]);
  });

  test("control: a raw reference whose variable is bound to null still fails closed", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(fsWriteRecorder(calls));
    const executor = new ActivityExecutor(runtime);

    const template: ActivityTemplate = {
      id: "gap-closing:null-bound",
      name: "write with a null-bound {{draft_text}}",
      tasks: [
        {
          id: "write_draft",
          description: "write",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/proposals/draft.json", content: "{{draft_text}}" },
        },
      ],
    };

    const trace = await executor.execute(template, { variables: { draft_text: null } });

    expect(calls).toEqual([]);
    expect(trace.status).toBe("failed");
    expect(trace.tasks.find((t) => t.taskId === "write_draft")?.error).toBe("unbound_template_variable:draft_text");
  });
});
