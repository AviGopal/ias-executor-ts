/**
 * Bun server capability bundle.
 *
 * A capability bundle packages a set of adapter instances, pre-wired resolvers,
 * and vessel descriptors together so hosts can attach them to an ExecutionRuntime
 * with a single call rather than wiring each adapter manually.
 *
 * Usage:
 *   const bundle = createBunServerBundle();
 *   const runtime = new ExecutionRuntime({ attachedVessels: bundle.vessels });
 *   bundle.applyTo(runtime);
 *   const executor = new ActivityExecutor(runtime);
 *
 * This pattern satisfies task 7.6: hosts explicitly attach capability bundles;
 * the core does not silently assume filesystem or process capability is available.
 */

import type { AttachedVessel } from "../ontology";
import type { ExecutionRuntime } from "../runtime";
import type { Resolver } from "../resolvers";
import type { FileSystemPort, LLMPort, ProcessPort } from "../ports";
import { BunFileSystemAdapter } from "../adapters/bun-filesystem";
import { BunProcessAdapter } from "../adapters/bun-process";

// ---------------------------------------------------------------------------
// Resolver factories (private — hosted in the bundle, not re-exported from core)
// ---------------------------------------------------------------------------

function makeFileReadResolver(fs: FileSystemPort): Resolver {
  return {
    id: "file-read",
    tier: "deterministic",
    async resolve(ctx) {
      const path = ctx.task.config?.path;
      if (typeof path !== "string") {
        throw new Error(`file-read: task.config.path must be a string (got ${JSON.stringify(path)})`);
      }
      const content = await fs.read(path);
      return [{
        id: ctx.random.id("file"),
        pointer: { type: "file", path },
        metadata: { shape: "fileContent", summary: `${path} (${content.length} chars)` },
        loaded: true,
        content,
      }];
    },
  };
}

function makeBashResolver(proc: ProcessPort): Resolver {
  return {
    id: "bash",
    tier: "deterministic",
    async resolve(ctx) {
      const command = ctx.task.config?.command;
      if (!Array.isArray(command)) {
        throw new Error(`bash: task.config.command must be string[] (got ${JSON.stringify(command)})`);
      }
      const cwd = typeof ctx.task.config?.cwd === "string" ? ctx.task.config.cwd : undefined;
      const timeoutMs = typeof ctx.task.config?.timeoutMs === "number" ? ctx.task.config.timeoutMs : 30_000;
      const result = await proc.run(command, { cwd, timeoutMs });
      return [{
        id: ctx.random.id("bash"),
        pointer: { type: "memo" },
        metadata: { shape: "commandResult", summary: `exit=${result.exitCode} (${command.join(" ")})` },
        loaded: true,
        content: result,
      }];
    },
  };
}

function makeLLMResolver(llm: LLMPort): Resolver {
  return {
    id: "llm",
    tier: "llm",
    async resolve(ctx) {
      const prompt = ctx.task.config?.prompt;
      if (typeof prompt !== "string") {
        throw new Error(`llm: task.config.prompt must be a string (got ${JSON.stringify(prompt)})`);
      }
      const systemPrompt = typeof ctx.task.config?.systemPrompt === "string"
        ? ctx.task.config.systemPrompt : undefined;
      const text = await llm.generate({ prompt, systemPrompt });
      return [{
        id: ctx.random.id("llm"),
        pointer: { type: "memo" },
        metadata: { shape: "llmText", summary: text.slice(0, 120) },
        loaded: true,
        content: text,
      }];
    },
  };
}

// ---------------------------------------------------------------------------
// CapabilityBundle — packaged adapters + resolvers + vessel descriptors
// ---------------------------------------------------------------------------

export interface CapabilityBundle {
  /** AttachedVessel descriptors to pass to ExecutionRuntime({ attachedVessels }) */
  readonly vessels: AttachedVessel[];
  /** Register all bundle resolvers on the given runtime */
  applyTo(runtime: ExecutionRuntime): void;
}

// ---------------------------------------------------------------------------
// Bun server bundle (filesystem + process, optional LLM)
// ---------------------------------------------------------------------------

export interface BunServerBundleOptions {
  llm?: LLMPort;
}

class BunServerBundle implements CapabilityBundle {
  readonly vessels: AttachedVessel[];
  private readonly resolvers: Resolver[];

  constructor(options: BunServerBundleOptions = {}) {
    const fs = new BunFileSystemAdapter();
    const proc = new BunProcessAdapter();

    this.resolvers = [
      makeFileReadResolver(fs),
      makeBashResolver(proc),
    ];
    this.vessels = [
      { id: "bun-fs", kind: "filesystem", resolverIds: ["file-read"] },
      { id: "bun-proc", kind: "process", resolverIds: ["bash"] },
    ];

    if (options.llm) {
      this.resolvers.push(makeLLMResolver(options.llm));
      this.vessels.push({ id: "llm-vessel", kind: "llm", resolverIds: ["llm"] });
    }
  }

  applyTo(runtime: ExecutionRuntime): void {
    for (const resolver of this.resolvers) {
      runtime.resolvers.register(resolver);
    }
  }
}

/** Create the standard Bun server capability bundle (filesystem + process + optional LLM) */
export function createBunServerBundle(options: BunServerBundleOptions = {}): CapabilityBundle {
  return new BunServerBundle(options);
}
