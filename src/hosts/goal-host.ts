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
import { makeImpulsePreparationResolver } from "../resolvers/impulse-preparation";
import { makeIterationResolver } from "../resolvers/iteration";
import { makeImpulsePoolSelectionResolver } from "../resolvers/impulse-pool-selection";
import { makeProducerSelectionResolver } from "../resolvers/producer-selection";
import { makeImpulseResolveResolver } from "../resolvers/impulse-resolve";
import { makeValidationResolver } from "../resolvers/validation";
import { makeActivityResolver } from "../resolvers/activity";
import { makeLearningSignalWriterResolver } from "../resolvers/learning-signal-writer";
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
    const hasPromptTemplate = typeof task.prompt?.template === "string";
    // Minibob's default LLM path: tasks with task.prompt.template either
    // omit resolver entirely (resolver:null) or set resolver:"llm". Our
    // built-in "llm" resolver expects task.config.prompt, not task.prompt
    // — so route both forms to llm-prompt, which reads task.prompt.template
    // + {{var}}/{{a.b.c}} interpolation directly.
    if (hasPromptTemplate && (task.resolver == null || task.resolver === "llm")) {
      return { ...t, resolver: "llm-prompt" } as typeof t;
    }
    return t;
  });
  return { ...template, tasks } as ActivityTemplate;
}

// ────────────────────────────────────────────────────────────────────────
// LLM port implementations
//
// InProcessLLMPort — wraps an Anthropic/OpenAI client in-process.
// HttpLLMPort      — delegates to llm-resolver-vessel via HTTP.
//
// Usage:
//   // In-process (default; for tests or when LLM_VESSEL_ENDPOINT is absent):
//   const llm = new InProcessLLMPort(anthropicClient);
//
//   // HTTP (when LLM_VESSEL_ENDPOINT env var is set):
//   const llm = new HttpLLMPort("http://127.0.0.1:8220");
//
//   // Factory (reads env automatically):
//   const llm = createLLMPort(anthropicClientOrUndefined);
//
// Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 2, task 2.5.
// ────────────────────────────────────────────────────────────────────────

/**
 * InProcessLLMPort — wraps any object with an Anthropic-SDK-compatible
 * `messages.create` shape into the `LLMPort` interface.
 *
 * Callers that already hold an Anthropic client instance should prefer this
 * path for tests (zero HTTP overhead) and for single-process deploys where
 * llm-resolver-vessel is not running.
 */
export class InProcessLLMPort implements LLMPort {
  constructor(
    private readonly client: {
      messages: {
        create(body: {
          model: string;
          max_tokens: number;
          system?: string;
          messages: Array<{ role: "user"; content: string }>;
        }): Promise<{
          content: Array<{ type: string; text?: string }>;
        }>;
      };
    },
    private readonly defaultModel = "claude-sonnet-4-20250514",
    private readonly defaultMaxTokens = 4096,
  ) {}

  async generate(input: {
    prompt: string;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const model = (input.metadata?.model as string | undefined) ?? this.defaultModel;
    const maxTokens = (input.metadata?.max_tokens as number | undefined) ?? this.defaultMaxTokens;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
      messages: [{ role: "user", content: input.prompt }],
    });

    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
}

/**
 * HttpLLMPort — calls llm-resolver-vessel's `llm_completion` resolver over
 * localhost HTTP. Used when `LLM_VESSEL_ENDPOINT` is set, so that
 * ANTHROPIC_API_KEY lives only in llm-resolver-vessel's env and is not
 * needed by other vessels.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 2, task 2.5.
 *   D4 — credentials live only where they're needed (llm-resolver-vessel).
 *   D2 — localhost HTTP overhead is negligible vs ≥500ms LLM call latency.
 */
export class HttpLLMPort implements LLMPort {
  private readonly resolveUrl: string;

  constructor(
    vesselEndpoint: string,
    private readonly defaultModel = "claude-sonnet-4-20250514",
    private readonly defaultMaxTokens = 4096,
  ) {
    // Normalise: allow bare host ("http://127.0.0.1:8220") or full path
    this.resolveUrl = vesselEndpoint.endsWith("/resolve")
      ? vesselEndpoint
      : `${vesselEndpoint.replace(/\/$/, "")}/resolve`;
  }

  async generate(input: {
    prompt: string;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const model = (input.metadata?.model as string | undefined) ?? this.defaultModel;
    const maxTokens = (input.metadata?.max_tokens as number | undefined) ?? this.defaultMaxTokens;

    const body = {
      type: "llm_completion",
      prompt: input.prompt,
      model,
      max_tokens: maxTokens,
      ...(input.systemPrompt ? { system: input.systemPrompt } : {}),
    };

    let response: Response;
    try {
      response = await fetch(this.resolveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `HttpLLMPort: network error calling ${this.resolveUrl}: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(
        `HttpLLMPort: llm-resolver-vessel returned HTTP ${response.status}: ${text}`,
      );
    }

    const json = (await response.json()) as {
      resolved: boolean;
      content?: string;
      error?: string;
    };
    // ITER-4 fix: drain response body even though .json() consumed it.
    // Bun's native HTTP layer retains underlying readable-stream mmap buffers
    // until the body stream is explicitly cancelled. Cumulative leak at scale.
    try { await response.body?.cancel(); } catch { /* swallow */ }

    if (!json.resolved || !json.content) {
      throw new Error(
        `HttpLLMPort: llm-resolver-vessel responded with resolved=false: ${json.error ?? "(unknown)"}`,
      );
    }

    return json.content;
  }
}

/**
 * Factory that selects the correct `LLMPort` implementation based on
 * the `LLM_VESSEL_ENDPOINT` environment variable.
 *
 * - When `LLM_VESSEL_ENDPOINT` is set: returns `HttpLLMPort` pointing at
 *   llm-resolver-vessel. No Anthropic client is required; ANTHROPIC_API_KEY
 *   lives only in llm-resolver-vessel's environment (spec D4).
 * - Otherwise: returns `InProcessLLMPort` wrapping the supplied client.
 *   This is the pre-Phase-2 behaviour — no behavioural change today.
 *
 * @param inProcessClient An Anthropic-SDK-compatible client. May be
 *   `undefined` when `LLM_VESSEL_ENDPOINT` is set (the HTTP path does not
 *   need a client).
 */
export function createLLMPort(
  inProcessClient?: {
    messages: {
      create(body: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: Array<{ role: "user"; content: string }>;
      }): Promise<{
        content: Array<{ type: string; text?: string }>;
      }>;
    };
  },
): LLMPort {
  const vesselEndpoint = process.env.LLM_VESSEL_ENDPOINT;
  if (vesselEndpoint) {
    return new HttpLLMPort(vesselEndpoint);
  }
  if (!inProcessClient) {
    throw new Error(
      "createLLMPort: LLM_VESSEL_ENDPOINT is not set and no inProcessClient was provided. " +
      "Either set LLM_VESSEL_ENDPOINT=http://127.0.0.1:8220 or supply an Anthropic client.",
    );
  }
  return new InProcessLLMPort(inProcessClient);
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
  /**
   * Enable impulse_preparation's `agent_fill` operation (LLM-of-last-resort
   * for unbindable shapes). Default false — slot-binding's fail-fast path
   * is preserved so test harnesses don't cascade into the chain's tail.
   * Set true in production GoalHost wiring where LLM agent_fill is desired.
   */
  enableAgentFill?: boolean;
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
      // 2026-05-20 task 40 fix: seed the lifecycle event payload as an
      // impulse so subscriber templates with inputShapes:["lifecycle:*"]
      // can satisfy their input-shape requirements at task time. The prior
      // attempt hung because lifecycle:task:completed events lacked
      // parentDepth/compositionChain in the payload, so the universal
      // depth-cap never fired and runaway mutual recursion happened
      // (slot-binding emits completed → validator-dispatch fires → emits
      // preBinding/completed → slot-binding/validator-dispatch fire → ...).
      // Fix landed in engine.ts: lifecycle:task:completed now includes
      // parentDepth + compositionChain, so the cap correctly refuses past
      // depth 2.
      // Subscriber failures must not cascade (spec §E.2). The vessel's
      // emit() already wraps this in try/catch; the executor itself isolates
      // its own errors via the failed-trace branch in engine.ts.
      const lifecycleImpulse = {
        id: this.runtime.random.id(`lifecycle:${event.type}`),
        pointer: { type: "memo" as const },
        metadata: { shape: event.type, source: "lifecycle-event" },
        loaded: true as const,
        content: event.data,
      };
      await executor.execute(template, {
        parentExecutionId,
        compositionChain: chain,
        impulses: [lifecycleImpulse],
      });
    };

    this.subscriber = new LifecycleSubscriberVessel({
      dispatcher,
      downstreamSink: options.eventSink,
      logger: options.logger,
    });

    // Pre-register every subscriber template from the shared catalogue
    // unless the host overrode the set (spec R4). Apply the same
    // template-normalization (resolver:null + prompt → "llm-prompt") that
    // remote-fetched templates get — without this, SHARED_TEMPLATES with
    // null-resolver tasks fail at "Resolver 'undefined' is not registered"
    // even though they have a valid prompt.template (2026-05-21).
    const rawSubscribers = options.subscriberTemplates ?? loadSubscriberTemplates();
    const subscribers = rawSubscribers.map(normalizeMinibobTemplate);
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
    // Slot-binding resolver chain port (canonical-host §4). Only
    // synthesise_from_variables is implemented today — covers the common
    // {inputShapes:["goal"], variables:{goal:"..."}} pattern without
    // spending an LLM call. Other operations (agent_fill, etc.) land later.
    this.runtime.resolvers.register(
      makeImpulsePreparationResolver({
        llm: options.llm,
        enableAgentFill: options.enableAgentFill === true,
      }),
    );
    // iteration resolver: foreach over an array, dispatch named inner
    // resolver per element. Slot-binding tasks 2-3 (pool_precheck +
    // select_or_produce) use this to iterate over missingShapes.
    // Resolver lookup closure binds the registry at construction time —
    // resolvers registered after this point are still looked up at call
    // time because the closure reads from runtime.resolvers (mutable Map).
    this.runtime.resolvers.register(
      makeIterationResolver((id) => this.runtime.resolvers.get(id)),
    );
    // impulse_pool_selection (minimal port — heuristic, returns first
    // shape-matching candidate with degraded:true). Real Thompson ranking
    // requires HTTP fetch from activity-api impulse_relevance_metrics —
    // separate iteration.
    this.runtime.resolvers.register(makeImpulsePoolSelectionResolver());
    // producer_selection: queries activity-api discover-by-shapes for
    // producers of a missing shape. Graceful degradation: marks
    // unbindable:true on HTTP failure or empty result so slot-binding's
    // escalation chain (escalate_unbindable / agent_fill_fallback /
    // forge_missing_shape) fires correctly. Thompson ranking deferred.
    this.runtime.resolvers.register(
      makeProducerSelectionResolver({
        activityApiEndpoint: options.activityApiEndpoint,
        activityApiKey: options.apiKey,
      }),
    );
    // impulse-resolve: generic shape-pointer dispatcher. Used by
    // audit-test-report.fetch_test_report (pointer.type=test_report),
    // slot-binding.consult_gap_cache (pointer.type=shape_gap_resolution),
    // and many other lifecycle/registry-quality templates. POSTs to
    // activity-api /v2/impulses/resolve with the static pointer.
    this.runtime.resolvers.register(
      makeImpulseResolveResolver({
        activityApiEndpoint: options.activityApiEndpoint,
        activityApiKey: options.apiKey,
      }),
    );
    // validation: rule-mode validator used by audit-test-report's
    // check_decision_record_complete and check_witness_presence tasks.
    // Pattern-mode (requiredPatterns / forbiddenPatterns) deferred.
    this.runtime.resolvers.register(makeValidationResolver());
    // activity resolver: nested template dispatch via the injected executor.
    // Used by validator-dispatch.dispatch_validators, slot-binding
    // .escalate_unbindable, and any composition meta-activity that dispatches
    // a sibling template. Executor closure mirrors the lifecycle-subscriber
    // pattern — registered before the executor exists, looked up at call time.
    this.runtime.resolvers.register(
      makeActivityResolver({ executor: () => executor }),
    );
    // learning_signal_writer: validator-dispatch.write_learning_signals (task 5)
    // writes α/β + tool-argument-pattern signals back to activity-api after
    // the per-task validator chain settles. Best-effort: HTTP failures are
    // captured into the result impulse, never thrown.
    this.runtime.resolvers.register(
      makeLearningSignalWriterResolver({
        activityApiEndpoint: options.activityApiEndpoint,
        activityApiKey: options.apiKey,
      }),
    );

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
      /** For cross-vessel composition chain threading (design §D3). */
      parentExecutionId?: string;
      compositionChain?: string[];
      /** Classification tags written into the execution trace (e.g. "intent:topology_discovery"). */
      tags?: string[];
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
      ...(opts.tags?.length ? { tags: opts.tags } : {}),
      ...(opts.parentExecutionId ? { parentExecutionId: opts.parentExecutionId } : {}),
      ...(opts.compositionChain?.length ? { compositionChain: opts.compositionChain } : {}),
      // Record the caller's originally-requested template id (only when the
      // caller bypassed recommend). The substrate's audit-dispatch-target-drift
      // detector reads `metadata.dispatch_target_template_id` from AET rows
      // and flags rows where target != selected variant. Recording is
      // unconditional in the bypass path; when recommend ran, we leave the
      // field absent (the schema is open).
      ...(opts.targetTemplateId ? { dispatchTargetTemplateId: opts.targetTemplateId } : {}),
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
