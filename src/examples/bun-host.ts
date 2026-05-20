/**
 * Minimal Bun host integration layer for ias-executor-ts.
 *
 * This is the reference wiring pattern for embedding ias-executor-ts into a
 * server-side host process. It demonstrates:
 *
 *   1. Creating an ExecutionRuntime with real adapters injected via ports
 *   2. Registering built-in resolvers backed by those adapters
 *   3. Attaching capability vessels so the runtime is explicit about what's available
 *   4. Forwarding events to an arbitrary sink (console, WebSocket, etc.)
 *   5. Forwarding traces to a remote backend via TraceSink
 *
 * MiniBob integration path (see tasks.md §9.2/9.4):
 *   - Replace minibob's `activity.ts` executor with `ActivityExecutor` from this package
 *   - Replace minibob's `impulse.ts` singleton with `ImpulseStore` from this package
 *   - Inject minibob's LLM client as `LLMPort`, tools as `FileSystemPort`/`ProcessPort`
 *   - Replace global singletons (config, vessel-registry, llm, mcp) with per-runtime instances
 *   - Keep minibob's goal-processor, boredom, REPL, and ACP in the MiniBob shell
 */

import { ActivityExecutor, ExecutionRuntime, type ActivityTemplate, type LifecycleEvent, type ExecutionTrace } from "../index";
import { BunFileSystemAdapter, BunProcessAdapter } from "../adapters/index";
import type { FileSystemPort, ProcessPort, LLMPort, EventSink, TraceSink } from "../ports";
import type { Resolver } from "../resolvers";
import { makeLLMPromptResolver } from "../resolvers/llm-prompt";

// ---------------------------------------------------------------------------
// Built-in resolver implementations backed by Bun adapters
// ---------------------------------------------------------------------------

/** Reads a file path declared in task config and emits a text impulse */
function makeFileReadResolver(fs: FileSystemPort): Resolver {
  return {
    id: "file-read",
    tier: "deterministic",
    async resolve(context) {
      const path = context.task.config?.path;
      if (typeof path !== "string") {
        throw new Error(`file-read resolver requires task.config.path (got ${JSON.stringify(path)})`);
      }
      const content = await fs.read(path);
      return [
        {
          id: context.random.id("file"),
          pointer: { type: "file", path },
          metadata: { shape: "fileContent", summary: `${path} (${content.length} chars)` },
          loaded: true,
          content,
        },
      ];
    },
  };
}

/** Runs a shell command declared in task config and emits a commandResult impulse */
function makeBashResolver(proc: ProcessPort): Resolver {
  return {
    id: "bash",
    tier: "deterministic",
    async resolve(context) {
      const command = context.task.config?.command;
      if (!Array.isArray(command)) {
        throw new Error(`bash resolver requires task.config.command (string[]) (got ${JSON.stringify(command)})`);
      }
      const cwd = typeof context.task.config?.cwd === "string" ? context.task.config.cwd : undefined;
      const timeoutMs = typeof context.task.config?.timeoutMs === "number" ? context.task.config.timeoutMs : 30_000;
      const result = await proc.run(command, { cwd, timeoutMs });
      return [
        {
          id: context.random.id("bash"),
          pointer: { type: "memo" },
          metadata: {
            shape: "commandResult",
            summary: `exit=${result.exitCode} (${command.join(" ")})`,
          },
          loaded: true,
          content: result,
        },
      ];
    },
  };
}

/** LLM resolver — requires an LLMPort to be injected by the host */
function makeLLMResolver(llm: LLMPort): Resolver {
  return {
    id: "llm",
    tier: "llm",
    async resolve(context) {
      const prompt = context.task.config?.prompt;
      const systemPrompt = typeof context.task.config?.systemPrompt === "string"
        ? context.task.config.systemPrompt
        : undefined;
      if (typeof prompt !== "string") {
        throw new Error(`llm resolver requires task.config.prompt (got ${JSON.stringify(prompt)})`);
      }
      const text = await llm.generate({ prompt, systemPrompt });
      return [
        {
          id: context.random.id("llm"),
          pointer: { type: "memo" },
          metadata: { shape: "llmText", summary: text.slice(0, 120) },
          loaded: true,
          content: text,
        },
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// BunHost — the integration layer
// ---------------------------------------------------------------------------

export interface BunHostOptions {
  /**
   * Optional LLM port. When present, the "llm" resolver is registered.
   * When absent, activities that use "llm" tasks will fail with "not registered".
   */
  llm?: LLMPort;

  /** Event sink — defaults to a no-op sink */
  eventSink?: EventSink;

  /** Trace sink — defaults to a no-op sink (useful for tests; replace with HTTP sink in production) */
  traceSink?: TraceSink;
}

export class BunHost {
  readonly runtime: ExecutionRuntime;
  readonly executor: ActivityExecutor;

  readonly fs: BunFileSystemAdapter;
  readonly proc: BunProcessAdapter;

  constructor(options: BunHostOptions = {}) {
    this.fs = new BunFileSystemAdapter();
    this.proc = new BunProcessAdapter();

    this.runtime = new ExecutionRuntime({
      eventSink: options.eventSink,
      traceSink: options.traceSink,
      // Capability vessels make available adapters explicit and inspectable
      attachedVessels: [
        { id: "bun-fs", kind: "filesystem", resolverIds: ["file-read"] },
        { id: "bun-proc", kind: "process", resolverIds: ["bash"] },
        ...(options.llm ? [{ id: "llm-vessel", kind: "llm", resolverIds: ["llm"] }] : []),
      ],
    });

    // Register built-in resolvers
    this.runtime.resolvers.register(makeFileReadResolver(this.fs));
    this.runtime.resolvers.register(makeBashResolver(this.proc));
    if (options.llm) {
      this.runtime.resolvers.register(makeLLMResolver(options.llm));
      // Minibob-template bridge: registers `llm-prompt` so templates with
      // task.prompt.template + {{var}} interpolation (the recommend-route
      // output shape) run through ias-executor-ts without rewriting them.
      // See src/resolvers/llm-prompt.ts for the contract.
      this.runtime.resolvers.register(makeLLMPromptResolver(options.llm));
    }

    this.executor = new ActivityExecutor(this.runtime);
  }

  /** Execute a template and return its trace */
  execute(template: ActivityTemplate, options?: Parameters<ActivityExecutor["execute"]>[1]): Promise<ExecutionTrace> {
    return this.executor.execute(template, options);
  }

  /** List all capability vessels attached to this host */
  listCapabilities(): Promise<import("../ontology").AttachedVessel[]> {
    return this.runtime.listAttachedVessels();
  }
}

// ---------------------------------------------------------------------------
// Console event sink (useful for debugging / CLI hosts)
// ---------------------------------------------------------------------------

export class ConsoleEventSink implements EventSink {
  emit(event: LifecycleEvent): void {
    const ts = new Date(event.timestamp).toISOString();
    // biome-ignore lint/suspicious/noConsole: intentional for debug output
    console.log(`[${ts}] ${event.type}`, JSON.stringify(event.data));
  }
}

// ---------------------------------------------------------------------------
// HTTP trace sink (reference implementation for production hosts)
// ---------------------------------------------------------------------------

export class HttpTraceSink implements TraceSink {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async record(trace: ExecutionTrace): Promise<void> {
    const res = await fetch(`${this.endpoint}/v2/activities/execution-traces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${this.apiKey}`,
      },
      body: JSON.stringify(trace),
    });
    if (!res.ok) {
      // Non-blocking — don't throw; trace loss is better than execution failure
      console.warn(`[HttpTraceSink] Failed to record trace ${trace.id}: ${res.status}`);
    }
  }
}
