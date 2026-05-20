/**
 * GoalHost — the canonical entry point for autonomous goal execution.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host
 *   §G — composition pattern (this file is the reference implementation).
 *   §I — non-goals (no CLI / REPL / boredom / daemon / Thompson internals).
 *   specs/goal-host/spec.md R1–R7.
 *
 * Replaces `spawn(MINIBOB_BIN, ["--single", goal])`. Composes:
 *   - BunHost-equivalent resolver layer (file-read, bash, llm) backed by
 *     BunFileSystemAdapter, BunProcessAdapter, and a host-injected LLMPort.
 *   - ActivityApiAdapter for recommend + getTemplate + recordTrace.
 *   - HttpDiscoveryAdapter for shape-based vessel routing.
 *   - LifecycleSubscriberVessel pre-registered with SHARED_TEMPLATES'
 *     subscriber set (slot-binding, validator-dispatch, audit-test-report,
 *     ribosome-extract, ...). Subscribers are dispatched via the same
 *     ActivityExecutor that runs the parent — proving the nested-dispatch
 *     property load-bearing for the test-audit-loop spec.
 *   - InMemoryTemplateProvider seeded with SHARED_TEMPLATES, with fall-
 *     through to activity-api's getTemplate for ids not in the catalogue.
 *
 * Architecture notes:
 *   - Subscriber failures NEVER cascade to the parent (spec §E.2). The
 *     vessel's dispatcher wraps `executor.execute` in a try/catch; the
 *     vessel itself also log-and-swallows.
 *   - Trace-sink failures NEVER abort execution (spec R5). The
 *     ActivityApiAdapter's recordTrace log-and-swallows.
 *   - GoalHost holds no state across `runGoal` calls (spec R6). Hosts
 *     that want conversation history build it externally and pass it via
 *     `opts.variables`.
 *
 * Non-goals (spec §I): no goal-text-to-template pattern matching, no
 * vessel registration, no daemon, no CLI parsing. Hosts compose the
 * executor with whatever UI / loop they need.
 */

import {
  ActivityExecutor,
  ExecutionRuntime,
  InMemoryTemplateProvider,
} from "../index";
import type {
  ActivityTemplate,
  ExecutionTrace,
  Impulse,
} from "../ontology";
import type {
  EventSink,
  FileSystemPort,
  LLMPort,
  ProcessPort,
  TemplateProvider,
  TraceSink,
} from "../ports";
import type { Resolver } from "../resolvers";
import { makeLLMPromptResolver } from "../resolvers/llm-prompt";
import {
  BunFileSystemAdapter,
  BunProcessAdapter,
  FetchAdapter,
  HttpDiscoveryAdapter,
} from "../adapters/index";
import {
  ActivityApiAdapter,
  type RecommendCandidate,
} from "../adapters/activity-api-adapter";
import {
  LifecycleSubscriberVessel,
  type SubscriberDispatcher,
} from "../lifecycle-subscriber";
import { SHARED_TEMPLATES, loadSubscriberTemplates } from "../templates/index";
import type { ExecuteOptions } from "../engine";

// ────────────────────────────────────────────────────────────────────────
// Built-in resolver factories (BunHost-equivalent surface; duplicated from
// bun-host.ts so GoalHost is self-contained — the spec calls for "a BunHost-
// equivalent resolver layer", not literal BunHost subclassing).
// ────────────────────────────────────────────────────────────────────────

function makeFileReadResolver(fs: FileSystemPort): Resolver {
  return {
    id: "file-read",
    tier: "deterministic",
    async resolve(context) {
      const path = context.task.config?.path;
      if (typeof path !== "string") {
        throw new Error(
          `file-read resolver requires task.config.path (got ${JSON.stringify(path)})`,
        );
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

function makeBashResolver(proc: ProcessPort): Resolver {
  return {
    id: "bash",
    tier: "deterministic",
    async resolve(context) {
      const command = context.task.config?.command;
      if (!Array.isArray(command)) {
        throw new Error(
          `bash resolver requires task.config.command (string[]) (got ${JSON.stringify(command)})`,
        );
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

function makeLLMResolver(llm: LLMPort): Resolver {
  return {
    id: "llm",
    tier: "llm",
    async resolve(context) {
      const rawPrompt = context.task.config?.prompt;
      const systemPrompt = typeof context.task.config?.systemPrompt === "string"
        ? context.task.config.systemPrompt
        : undefined;
      if (typeof rawPrompt !== "string") {
        throw new Error(`llm resolver requires task.config.prompt (got ${JSON.stringify(rawPrompt)})`);
      }
      // Interpolate {{variableName}} placeholders from variables (matches
      // vessel-forge-host's llm resolver — shared catalogue templates use
      // this syntax for prompt parameterisation).
      const prompt: string = rawPrompt.replace(/\{\{(\w+)\}\}/g, (_match: string, key: string) => {
        const val = context.variables[key];
        return val !== undefined ? String(val) : `{{${key}}}`;
      });
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

// ────────────────────────────────────────────────────────────────────────
// Catalogue-first template provider with activity-api fallback (spec R2.3).
// ────────────────────────────────────────────────────────────────────────

class CatalogueWithFallback implements TemplateProvider {
  constructor(
    private readonly local: InMemoryTemplateProvider,
    private readonly remote: { getTemplate(id: string): Promise<ActivityTemplate | null> },
  ) {}

  async getTemplate(id: string): Promise<ActivityTemplate | null> {
    const hit = await this.local.getTemplate(id);
    if (hit) return hit;
    const remote = await this.remote.getTemplate(id);
    return remote ? normalizeMinibobTemplate(remote) : null;
  }
}

/**
 * Template-load-time adapter: rewrites minibob-authored tasks to use the
 * canonical resolver id. Minibob tasks with `resolver: null` and a
 * `prompt: { template }` block get `resolver: "llm-prompt"` so the
 * canonical-host substrate dispatches them correctly. SHARED_TEMPLATES
 * (already in the local catalogue) are untouched.
 *
 * Spec: openspec/changes/2026-05-19-ias-executor-as-canonical-host §I
 *   ("do not smuggle hidden built-ins" → keep engine dispatcher explicit;
 *    fold null→llm-prompt at the adapter layer instead).
 */
function normalizeMinibobTemplate(template: ActivityTemplate): ActivityTemplate {
  const tasks = (template.tasks ?? []).map((t) => {
    const task = t as { resolver?: string | null; prompt?: { template?: string } };
    if ((task.resolver == null) && typeof task.prompt?.template === "string") {
      return { ...t, resolver: "llm-prompt" } as typeof t;
    }
    return t;
  });
  return { ...template, tasks } as ActivityTemplate;
}

// ────────────────────────────────────────────────────────────────────────
// Options + result types
// ────────────────────────────────────────────────────────────────────────

export interface GoalHostOptions {
  /** Required — needed for llm-tier resolvers (spec §G.1). */
  llm: LLMPort;
  /** e.g. https://activity.metabob.com. */
  activityApiEndpoint: string;
  /** Canary or prod API key (`Authorization: ApiKey <key>`). */
  apiKey: string;
  /** Optional discovery endpoint (e.g. https://discovery.metabob.com). */
  discoveryEndpoint?: string;
  /** Optional identity-vessel endpoint. Reserved for per-request JWT minting
   *  (deferred per design §G.2). GoalHost itself uses `apiKey` for its own
   *  outbound calls; attached vessels may need this for their own resolvers. */
  identityVesselEndpoint?: string;
  /** Lifecycle event sink (workbench WS, console, test spy, ...). Default no-op. */
  eventSink?: EventSink;
  /**
   * Override the default trace sink. Default is the canary-translating sink
   * built into ActivityApiAdapter. Tests typically inject a TraceSinkSpy.
   */
  traceSink?: TraceSink;
  /**
   * Override the default subscriber set. Defaults to
   * `loadSubscriberTemplates()` (every template in SHARED_TEMPLATES that
   * declares a `subscription` block).
   */
  subscriberTemplates?: ActivityTemplate[];
  /**
   * Audit recursion cap forwarded to lifecycle subscribers. Default 2;
   * bounded ≤ 4 per spec R5. The cap itself is enforced in
   * `refuseForDepthCap` (lifecycle-subscriber.ts); this option exists for
   * documentation / future override (the current vessel reads
   * `template.metadata.auditDepthCap` per-template).
   */
  auditDepthCap?: number;
  /**
   * Optional ActivityApiAdapter override — useful for tests that want to
   * inject a fake. When set, `activityApiEndpoint` and `apiKey` are still
   * required (the constructor needs them to build the discovery + identity
   * adapters and the default trace sink) but the adapter itself is used as-
   * is.
   */
  activityApi?: ActivityApiAdapter;
  /**
   * Optional logger for the lifecycle-subscriber vessel. Defaults to a no-op
   * pair so tests stay quiet.
   */
  logger?: { warn: (msg: string) => void; debug: (msg: string) => void };
}

export interface GoalRunResult {
  trace: ExecutionTrace;
  selectedTemplateId: string;
  /** Top-K candidates from /recommend, sorted in response order. */
  recommendCandidates?: RecommendCandidate[];
}

// ────────────────────────────────────────────────────────────────────────
// GoalHost
// ────────────────────────────────────────────────────────────────────────

export class GoalHost {
  readonly runtime: ExecutionRuntime;
  readonly executor: ActivityExecutor;
  readonly activityApi: ActivityApiAdapter;
  readonly discovery: HttpDiscoveryAdapter;
  readonly subscriber: LifecycleSubscriberVessel;
  readonly catalogue: InMemoryTemplateProvider;

  readonly fs: BunFileSystemAdapter;
  readonly proc: BunProcessAdapter;
  readonly fetchAdapter: FetchAdapter;

  private readonly auditDepthCap: number;

  constructor(options: GoalHostOptions) {
    this.fs = new BunFileSystemAdapter();
    this.proc = new BunProcessAdapter();
    this.fetchAdapter = new FetchAdapter();
    this.auditDepthCap = Math.min(options.auditDepthCap ?? 2, 4);

    // Activity-API adapter (single facade — spec §G.2).
    this.activityApi =
      options.activityApi ??
      new ActivityApiAdapter(options.activityApiEndpoint, options.apiKey, {
        fetch: this.fetchAdapter,
      });

    // Discovery adapter (spec §G.2). Endpoint optional — when absent the
    // adapter targets a placeholder; resolvers that would call it must be
    // attached explicitly by the host.
    this.discovery = new HttpDiscoveryAdapter(
      this.fetchAdapter,
      options.discoveryEndpoint ?? "https://discovery.metabob.com",
    );

    // Catalogue: SHARED_TEMPLATES in-memory, with activity-api fallback for
    // ids not present locally (spec R2.3).
    this.catalogue = new InMemoryTemplateProvider();
    for (const tmpl of SHARED_TEMPLATES) {
      this.catalogue.register(tmpl);
    }
    const templateProvider = new CatalogueWithFallback(this.catalogue, this.activityApi);

    // Lifecycle-subscriber vessel — dispatcher closure captures the executor
    // (we cannot reference `this.executor` here because the runtime needs
    // the vessel BEFORE the executor exists; the pattern mirrors
    // test/nested-subscriber-dispatch.test.ts).
    let executor!: ActivityExecutor;
    const dispatcher: SubscriberDispatcher = async (template, event) => {
      const data = (event.data ?? {}) as {
        executionId?: string;
        compositionChain?: string[];
      };
      const parentExecutionId = data.executionId;
      const parentChain = data.compositionChain ?? [];
      const chain = parentExecutionId ? [...parentChain, parentExecutionId] : parentChain;
      // Subscriber failures must not cascade (spec §E.2). The vessel's
      // emit() already wraps this in try/catch; the executor itself isolates
      // its own errors via the failed-trace branch in engine.ts.
      await executor.execute(template, {
        parentExecutionId,
        compositionChain: chain,
      });
    };

    this.subscriber = new LifecycleSubscriberVessel({
      dispatcher,
      downstreamSink: options.eventSink,
      logger: options.logger,
    });

    // Pre-register every subscriber template from the shared catalogue
    // unless the host overrode the set (spec R4).
    const subscribers = options.subscriberTemplates ?? loadSubscriberTemplates();
    for (const sub of subscribers) {
      this.subscriber.register(sub);
    }

    // Runtime + executor.
    this.runtime = new ExecutionRuntime({
      eventSink: this.subscriber, // subscriber fans out to options.eventSink
      traceSink: options.traceSink ?? this.activityApi.asTraceSink(),
      templateProvider,
      attachedVessels: [
        { id: "bun-fs", kind: "filesystem", resolverIds: ["file-read"] },
        { id: "bun-proc", kind: "process", resolverIds: ["bash"] },
        { id: "llm-vessel", kind: "llm", resolverIds: ["llm"] },
        { id: "discovery-vessel", kind: "discovery", resolverIds: [] },
        {
          id: "lifecycle-subscriber",
          kind: "lifecycle-subscriber",
          resolverIds: [],
          metadata: { auditDepthCap: this.auditDepthCap },
        },
      ],
    });

    this.runtime.resolvers.register(makeFileReadResolver(this.fs));
    this.runtime.resolvers.register(makeBashResolver(this.proc));
    this.runtime.resolvers.register(makeLLMResolver(options.llm));
    // Minibob-template bridge: see src/resolvers/llm-prompt.ts. Enables
    // GoalHost to run recommend-returned templates that use
    // task.prompt.template + {{var}} interpolation (minibob's default-LLM
    // path) without rewriting them.
    this.runtime.resolvers.register(makeLLMPromptResolver(options.llm));

    this.executor = new ActivityExecutor(this.runtime);
    executor = this.executor; // close the loop for the dispatcher
  }

  /**
   * Run a goal end-to-end.
   *
   * Flow (spec R2):
   *   1. Seed a `goal`-shape impulse with the goal text + variables.
   *   2. If `opts.targetTemplateId` is set, load that template directly
   *      (catalogue first, activity-api fallback). Otherwise, call
   *      `activityApi.recommend` and execute the top-ranked recommendation.
   *   3. Execute via the runtime's executor (lifecycle subscribers fire
   *      automatically against emitted events).
   *   4. Return the trace + selected template id + candidate list.
   *
   * GoalHost does NOT branch on goal-text patterns (spec R2: "the flow
   * SHALL NOT branch on goal-text pattern matching"). All routing decisions
   * are activity-api's job.
   */
  async runGoal(
    goalText: string,
    opts: {
      variables?: Record<string, unknown>;
      targetTemplateId?: string;
      expectedOutputShapes?: string[];
    } = {},
  ): Promise<GoalRunResult> {
    const variables = opts.variables ?? {};
    const goalImpulse: Impulse = {
      id: this.runtime.random.id("goal"),
      pointer: { type: "memo" },
      metadata: { shape: "goal" },
      loaded: true,
      content: { text: goalText, variables },
    };

    let templateId: string | undefined = opts.targetTemplateId;
    let candidates: RecommendCandidate[] | undefined;

    if (!templateId) {
      const response = await this.activityApi.recommend({
        goal: goalText,
        expectedOutputShapes: opts.expectedOutputShapes,
      });
      candidates = response.recommendations;
      const top = candidates[0];
      if (!top) {
        throw new Error(
          `GoalHost.runGoal: no template id returned for goal "${goalText.slice(0, 80)}" ` +
            `(fallback_tier=${response.fallback_tier ?? "null"}). Pass opts.targetTemplateId ` +
            `to bypass the recommend step.`,
        );
      }
      templateId = top.template_id;
    }

    const template = await this.runtime.templateProvider!.getTemplate(templateId);
    if (!template) {
      throw new Error(
        `GoalHost.runGoal: template '${templateId}' not found in shared catalogue or activity-api`,
      );
    }

    const trace = await this.executor.execute(template, {
      variables,
      impulses: [goalImpulse],
      goalContext: { goal: goalText },
    });

    return { trace, selectedTemplateId: templateId, recommendCandidates: candidates };
  }

  /**
   * Bypass-recommend entry point: execute a template directly. Used by
   * tests, the Phase 2 forge migration (which already knows the target
   * template id), and any host that wants explicit control.
   */
  async runTemplate(
    template: ActivityTemplate,
    variables: Record<string, unknown> = {},
    extra: ExecuteOptions = {},
  ): Promise<ExecutionTrace> {
    return this.executor.execute(template, { variables, ...extra });
  }

  /** Passthrough to the runtime — for inspection / debugging. */
  listCapabilities() {
    return this.runtime.listAttachedVessels();
  }
}
