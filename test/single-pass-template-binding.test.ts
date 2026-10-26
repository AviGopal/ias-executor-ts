/**
 * Every {{lifecycle.*}}, {{impulse:*}} and plain {{name}} token OCCURRENCE in the raw
 * task config is bound in ONE pass, and no replacement text is ever rescanned.
 *
 * Sequential passes rescanned each other's output, so data that itself carries {{...}}
 * text was re-bound: an impulse resolving to "PAGE says {{analyze_text}}" had the run
 * variable substituted inside it, and a lifecycle value holding "{{impulse:page}}" had
 * the impulse expanded inside it. Binding is positional — the same name written raw AND
 * arriving inside injected data binds only at the raw occurrence. Plain names are not
 * substituted into llm_completion_dispatch prompt text, so drafting prompts ship as
 * authored.
 */
import { describe, expect, test } from "bun:test";
import { ActivityExecutor } from "../src/engine";
import { ExecutionRuntime } from "../src/runtime";
import type { ActivityTask, ActivityTemplate } from "../src/ontology";
import type { Resolver } from "../src/resolvers";
import { EventSinkSpy, SequentialRandom, SteppingClock } from "./fakes";
import draftViaLlmFixture from "./fixtures/dv-9eba9b93-draft-via-llm.json";

function makeRuntime() {
  return new ExecutionRuntime({
    clock: new SteppingClock(4_000_000, 5),
    random: new SequentialRandom(),
    eventSink: new EventSinkSpy(),
  });
}

function recorder(id: string, calls: unknown[], content = "written"): Resolver {
  return {
    id,
    tier: "external",
    async resolve(ctx) {
      calls.push(ctx.task.config);
      return [{ id: ctx.random.id("out"), pointer: { type: id }, metadata: { shape: id }, loaded: true, content }];
    },
  };
}

function pageProducer(content: string): Resolver {
  return {
    id: "fetch_page",
    tier: "deterministic",
    async resolve(ctx) {
      return [{ id: ctx.random.id("imp"), pointer: { type: "memo" }, metadata: { shape: "page", outputImpulseKey: "page" }, loaded: true, content }];
    },
  };
}

const fetchTask: ActivityTask = { id: "fetch", description: "fetch", resolver: "fetch_page", outputShapes: ["page"] };
const writeTask = (content: string): ActivityTask => ({
  id: "write",
  description: "write",
  resolver: "fs_write_fake",
  config: { type: "fs_write", path: "/workspace/out.txt", content },
});

describe("single-pass template binding — injected text is never rescanned", () => {
  test("must-fail (a): an impulse resolving to text with a bound run-variable name is written verbatim", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(pageProducer("PAGE says {{analyze_text}} end"));
    runtime.resolvers.register(recorder("fs_write_fake", calls));
    const template: ActivityTemplate = { id: "bind:a", name: "a", tasks: [fetchTask, writeTask("{{impulse:page}}")] };

    const trace = await new ActivityExecutor(runtime).execute(template, { variables: { analyze_text: "INJECTED" } });

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/out.txt", content: "PAGE says {{analyze_text}} end" }]);
  });

  test("must-fail (2b): the same name raw AND injected binds only at the raw occurrence", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(pageProducer("PAGE says {{analyze_text}}"));
    runtime.resolvers.register(recorder("fs_write_fake", calls));
    const template: ActivityTemplate = { id: "bind:2b", name: "2b", tasks: [fetchTask, writeTask("{{analyze_text}} + {{impulse:page}}")] };

    const trace = await new ActivityExecutor(runtime).execute(template, { variables: { analyze_text: "BOUND" } });

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/out.txt", content: "BOUND + PAGE says {{analyze_text}}" }]);
  });

  test("(b): a run variable whose value holds {{impulse:page}} is written verbatim, no impulse expansion", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(pageProducer("PAGE_CONTENT"));
    runtime.resolvers.register(recorder("fs_write_fake", calls));
    const template: ActivityTemplate = { id: "bind:b", name: "b", tasks: [fetchTask, writeTask("{{draft_text}}")] };

    const trace = await new ActivityExecutor(runtime).execute(template, { variables: { draft_text: "x {{impulse:page}} y" } });

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/out.txt", content: "x {{impulse:page}} y" }]);
  });

  test("must-fail (b, lifecycle): a lifecycle value holding {{impulse:page}} is written verbatim, no impulse expansion", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(pageProducer("PAGE_CONTENT"));
    runtime.resolvers.register(recorder("fs_write_fake", calls));
    const template: ActivityTemplate = { id: "bind:b-lc", name: "b-lc", tasks: [fetchTask, writeTask("got: {{lifecycle.note}}")] };

    const trace = await new ActivityExecutor(runtime).execute(template, {
      variables: { lifecycle: { executionId: "EXEC_1", note: "x {{impulse:page}} y" } },
    });

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/out.txt", content: "got: x {{impulse:page}} y" }]);
  });

  test("(2c): a run variable holding {{impulse:page}} and {{lifecycle.executionId}} is written verbatim, whole and inline", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(pageProducer("PAGE_CONTENT"));
    runtime.resolvers.register(recorder("fs_write_fake", calls));
    const value = "a {{impulse:page}} b {{lifecycle.executionId}} c";
    const template: ActivityTemplate = {
      id: "bind:2c",
      name: "2c",
      tasks: [
        fetchTask,
        { id: "write", description: "write", resolver: "fs_write_fake", config: { type: "fs_write", path: "/workspace/out.txt", content: "{{draft_text}}", note: "n: {{draft_text}}" } },
      ],
    };

    const trace = await new ActivityExecutor(runtime).execute(template, {
      variables: { draft_text: value, lifecycle: { executionId: "EXEC_1" } },
    });

    expect(trace.status).toBe("completed");
    expect(calls).toEqual([{ type: "fs_write", path: "/workspace/out.txt", content: value, note: `n: ${value}` }]);
  });

  test("must-fail (c): a read -> fetch -> write chain binds prior outputs into non-prompt fields", async () => {
    const fetchCalls: unknown[] = [];
    const writeCalls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register({
      id: "fs_read_fake",
      tier: "external",
      async resolve(ctx) {
        return [{ id: ctx.random.id("imp"), pointer: { type: "fs_read" }, metadata: { shape: "fs_read" }, loaded: true, content: "SCENARIO_ID_7" }];
      },
    });
    runtime.resolvers.register(recorder("http_fetch_fake", fetchCalls, "TRACE_DATA"));
    runtime.resolvers.register(recorder("fs_write_fake", writeCalls));
    const template: ActivityTemplate = {
      id: "bind:c",
      name: "read -> fetch -> write",
      tasks: [
        { id: "read_scenario", description: "read", resolver: "fs_read_fake", config: { type: "fs_read", path: "/workspace/x.json" } },
        {
          id: "fetch_traces",
          description: "fetch",
          resolver: "http_fetch_fake",
          config: { type: "http_fetch", url: "http://traces/{{read_scenario_text}}", body: { scenario: "{{read_scenario_text}}" } },
        },
        {
          id: "write_report",
          description: "write",
          resolver: "fs_write_fake",
          config: { type: "fs_write", path: "/workspace/{{read_scenario_text}}.txt", content: "{{fetch_traces_text}}" },
        },
      ],
    };

    const trace = await new ActivityExecutor(runtime).execute(template, {});

    expect(trace.status).toBe("completed");
    expect(fetchCalls).toEqual([{ type: "http_fetch", url: "http://traces/SCENARIO_ID_7", body: { scenario: "SCENARIO_ID_7" } }]);
    expect(writeCalls).toEqual([{ type: "fs_write", path: "/workspace/SCENARIO_ID_7.txt", content: "TRACE_DATA" }]);
  });

  test("control: draft-gap-closing-activity's draft_via_llm config (dv 9eba9b93) reaches the resolver byte-identical, every plain name bound", async () => {
    const calls: unknown[] = [];
    const runtime = makeRuntime();
    runtime.resolvers.register(recorder("llm_completion_dispatch", calls, "{}"));
    const task = draftViaLlmFixture.task as unknown as ActivityTask;
    const rawText = JSON.stringify(task.config);
    const names = [...rawText.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]!.trim());
    expect(names.length).toBeGreaterThan(0);
    const variables = Object.fromEntries(names.map((n) => [n, `BOUND_${n}`]));
    const template: ActivityTemplate = { id: "bind:control-draft", name: "draft_via_llm", tasks: [task] };

    const trace = await new ActivityExecutor(runtime).execute(template, { variables });

    expect(trace.status).toBe("completed");
    expect(calls.length).toBe(1);
    expect(JSON.stringify(calls[0])).toBe(rawText);
  });
});
