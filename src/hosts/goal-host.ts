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
import { getImpulseShape } from "../ontology";
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
  type ImpulseStateEntry,
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
          metadata: { shape: "llmText", summary: text.slice(0, 120), usage: llm.lastUsage ?? undefined },
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
  // Bounded TTL cache for remote fetches. Every runGoal() calls
  // templateProvider.getTemplate(id); without caching, a 5-task chain that
  // references the same authored template via `compose` re-fetches it from
  // activity-api per task — each fetch allocating the full JSON body
  // (templates can be 50-200 KB) and holding it in V8 until the next GC.
  // TTL default 60 s; cap at REMOTE_CACHE_MAX entries (LRU-ish via insertion
  // order). Negative results (template not found) are cached for a shorter
  // window to avoid wedging on transient 404s.
  private readonly remoteCache: Map<string, { value: ActivityTemplate | null; expiresAt: number }> = new Map();
  private readonly remoteCacheTtlMs: number;
  private readonly remoteCacheNegativeTtlMs: number;
  private readonly remoteCacheMax = 128;

  constructor(
    private readonly local: InMemoryTemplateProvider,
    private readonly remote: { getTemplate(id: string): Promise<ActivityTemplate | null> },
  ) {
    const rawTtl = typeof process !== "undefined" ? process.env?.IAS_TEMPLATE_CACHE_TTL_MS : undefined;
    const ttl = rawTtl ? parseInt(rawTtl, 10) : 60_000;
    this.remoteCacheTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : 60_000;
    this.remoteCacheNegativeTtlMs = Math.min(5_000, this.remoteCacheTtlMs);
  }

  async getTemplate(id: string): Promise<ActivityTemplate | null> {
    const hit = await this.local.getTemplate(id);
    if (hit) {
      return hit;
    }
    const now = Date.now();
    const cached = this.remoteCache.get(id);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    const remote = await this.remote.getTemplate(id);
    const value = remote ? normalizeMinibobTemplate(remote) : null;
    const ttl = value ? this.remoteCacheTtlMs : this.remoteCacheNegativeTtlMs;
    // LRU-ish eviction: drop the oldest insertion when over cap. Map's
    // iteration order is insertion order; refresh on hit by deleting + re-
    // inserting so frequently-fetched ids stay live.
    if (this.remoteCache.size >= this.remoteCacheMax) {
      const oldest = this.remoteCache.keys().next().value;
      if (oldest !== undefined) this.remoteCache.delete(oldest);
    }
    this.remoteCache.delete(id);
    this.remoteCache.set(id, { value, expiresAt: now + ttl });
    return value;
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
    private readonly defaultModel = "auto",
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
  lastUsage: { input_tokens: number; output_tokens: number } | null = null;
  private readonly resolveUrl: string;

  constructor(
    vesselEndpoint: string,
    private readonly defaultModel = "auto",
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
      usage?: { input_tokens: number; output_tokens: number };
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

    this.lastUsage = json.usage ?? null;
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

  // Retained so the bypass guard in runGoal can read a pinned template's LEARNED
  // posterior before executing it. The adapter keeps its own private copies and
  // exposes no metrics accessor, so these are held here rather than reaching
  // through it.
  private readonly activityApiEndpointForPosterior: string;
  private readonly apiKeyForPosterior: string;

  constructor(options: GoalHostOptions) {
    this.activityApiEndpointForPosterior = options.activityApiEndpoint;
    this.apiKeyForPosterior = options.apiKey;
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
      { apiKey: options.apiKey },
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
        tags?: string[];
      };
      const parentExecutionId = data.executionId;
      const parentChain = data.compositionChain ?? [];
      const chain = parentExecutionId ? [...parentChain, parentExecutionId] : parentChain;
      // Inherit parent's tags (state_signature:<hash>, dispatcher_used:, intent:*).
      // Without this, lifecycle-subscriber-dispatched executions (slot-binding,
      // validator-dispatch, etc.) emit untagged traces — starving boredom's
      // per-(signature, goal_idx) Thompson cells. See engine.ts emit sites for
      // the data.tags producer.
      const parentTags = Array.isArray(data.tags) ? data.tags : undefined;
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
        ...(parentTags ? { tags: parentTags } : {}),
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
      discovery: this.discovery,
      vesselApiKey: options.apiKey,
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
      /**
       * Extra impulses to seed into the execution pool alongside the goal impulse.
       * Their shapes also join the impulse_state_space signature, so selection is
       * conditioned on them and they are routable via discover-by-shapes. Used by
       * in-flight recovery to seed the reach-gate verdict as a first-class
       * `reachFeedback` impulse (a hollow completion is data with a shape — not a
       * dead end), so the next attempt both SEES it (execution context) and is
       * SELECTED under a signature that includes it.
       */
      seedImpulses?: Impulse[];
    } = {},
  ): Promise<GoalRunResult> {
    // Make the goal text resolvable as `{{goal}}` in every task by default
    // (2026-06-24). Tasks — notably author_producer's goal_file_extract entry
    // step — bind from {{goal}}, but the goal previously lived only in the goal
    // impulse + goalContext, never in `variables`, so `{{goal}}` stayed literal.
    // Explicit opts.variables still win (spread last).
    const variables = { goal: goalText, ...(opts.variables ?? {}) };
    const goalImpulse: Impulse = {
      id: this.runtime.random.id("goal"),
      pointer: { type: "memo" },
      metadata: { shape: "goal" },
      loaded: true,
      content: { text: goalText, variables },
    };

    let templateId: string | undefined = opts.targetTemplateId;
    let candidates: RecommendCandidate[] | undefined;
    // Only fall through to the next ranked candidate when the id came from SELECTION.
    // An explicitly requested opts.targetTemplateId that does not exist must still throw:
    // silently running something else than the caller asked for would be worse than failing.
    let selectedFromRecommendations = false;

    if (!templateId) {
      // Build impulse_state_space from the current pool + the about-to-be-seeded
      // goal impulse. This activates activity-api's v1 precondition-conditioned
      // Thompson path (context_thompson_scores). Without this field the endpoint
      // falls back to the shape-blind posterior and context_thompson_scores
      // accumulates zero v1 rows.
      const poolEntries: ImpulseStateEntry[] = this.runtime.store.all().map((imp) => {
        const entry: ImpulseStateEntry = { shape: getImpulseShape(imp) };
        const producedBy =
          (imp.metadata.produced_at_task_id as string | undefined) ??
          (imp.metadata.producedBy as string | undefined);
        if (producedBy) entry.task_id = producedBy;
        return entry;
      });
      // Include the goal impulse that will seed this execution.
      poolEntries.push({ shape: "goal" });
      // Seed impulses (e.g. the reach-gate verdict) join the signature too, so
      // selection is conditioned on the failure-state shape being present.
      for (const si of opts.seedImpulses ?? []) poolEntries.push({ shape: getImpulseShape(si) });

      const response = await this.activityApi.recommend({
        goal: goalText,
        expectedOutputShapes: opts.expectedOutputShapes,
        impulseStateSpace: poolEntries,
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
      selectedFromRecommendations = true;
    }

    let template = await this.runtime.templateProvider!.getTemplate(templateId);
    if (!template && selectedFromRecommendations) {
      // A RECOMMENDED TEMPLATE THAT DOES NOT EXIST USED TO KILL THE DISPATCH (2026-08-09).
      //
      // Selection returned 'development-vessel:db_performance_slow_queries'; that id
      // 404s on activity-api. The throw below then escaped before any trace was written,
      // and goal-host reported exactly what that costs:
      //
      //   reach-patch NOT ATTEMPTED (walk-threw): no executionId on the dispatch record
      //   — this execution stays ungraded and its arm learns nothing from it
      //
      // Which makes it SELF-PERPETUATING. The phantom arm keeps its prior because its
      // failures are never recorded, so it keeps winning selection and keeps killing
      // every dispatch that draws it. A broken arm that cannot be observed failing is
      // exactly the defect this repo already names for scripts nothing invokes: it can
      // never be trusted when it passes, because it is never seen when it fails.
      //
      // The recommendation list is ranked, so the honest response to an unresolvable
      // top pick is to take the next one — not to abandon a goal the substrate is
      // otherwise equipped to serve. Each skip is logged loudly so a phantom is visible
      // as a phantom rather than as a mysteriously dead goal class.
      for (const cand of candidates ?? []) {
        if (cand.template_id === templateId) continue;
        const next = await this.runtime.templateProvider!.getTemplate(cand.template_id);
        if (next) {
          console.warn(
            `[goal-host] recommended template '${templateId}' does not exist (404) — ` +
              `falling through to next ranked candidate '${cand.template_id}'. ` +
              `The missing arm still holds a posterior it cannot earn; prune it.`,
          );
          templateId = cand.template_id;
          template = next;
          break;
        }
      }
    }
    if (!template) {
      throw new Error(
        `GoalHost.runGoal: template '${templateId}' not found in shared catalogue or activity-api`,
      );
    }

    // Law-12 join key: stamp the correlation id of the candidate we ACTUALLY ran
    // (templateId may have moved to a fallback candidate above) so the execution can
    // be joined back to the Thompson draw that chose it. activity-api's ingest lifts
    // `correlation:<id>` off the tags into execution.correlation_id, and the credit
    // path (posterior-update → recordDecisionOutcome) joins it to thompson_selection_log.
    // Only present when this run came from a recommend draw that carried the id.
    const pickedCorrelationId = candidates?.find(
      (c) => c.template_id === templateId,
    )?.correlation_id;
    const correlationTags = pickedCorrelationId ? [`correlation:${pickedCorrelationId}`] : [];
    const mergedTags = [...(opts.tags ?? []), ...correlationTags];

    // PINNING A TARGET MUST NOT ALSO SKIP THE EVIDENCE (2026-09-06).
    //
    // When a caller pins opts.targetTemplateId the recommender is bypassed
    // entirely — that is deliberate and stays, because it stops selection from
    // misrouting a goal to an unrelated high-alpha template. But bypassing the
    // CHOICE and bypassing the RECORD are separable, and until now they were the
    // same act: nothing on this path ever asked whether the pinned template works.
    //
    // Measured cost of that on one arm: development-vessel:scaffold-and-publish-vessel
    // sat at thompson_alpha 6.05 against thompson_beta 8601.67 — one success in
    // 7997 executions, every one of its 2340 trace rows a failure, not deprecated —
    // and it kept being dispatched here, twice more during a thirty-minute
    // observation window, because the component whose whole job is to weigh what
    // happened last time was never consulted.
    //
    // PROCEEDS ON ABSENCE OF EVIDENCE, deliberately. No match, transport failure,
    // unparseable body, missing or non-finite metric, or fewer than 100 combined
    // observations all fall through and execute as before. A template with no
    // history has to stay reachable or this becomes a permanent block on anything
    // new — the failure shape of a threshold that can never be met.
    //
    // Control run against every pinned target in the fleet before this landed
    // (22 templates: boredom's AUTONOMOUS_GOAL_TARGET_TEMPLATES plus the direct
    // callers): exactly ONE declines. The nearest healthy template is
    // mitosis-tick at 0.0883, roughly 9x above the cutoff; the rest sit at
    // 0.63-0.86 or below the evidence floor.
    if (opts.targetTemplateId) {
      const verdict = await this.pinnedTargetPosteriorVerdict(opts.targetTemplateId);
      if (verdict) {
        throw new Error(
          `refusing pinned target ${opts.targetTemplateId}: learned posterior is decisively negative ` +
            `(alpha=${verdict.alpha.toFixed(2)} beta=${verdict.beta.toFixed(2)} ` +
            `rate=${verdict.rate.toExponential(2)} over ${Math.round(verdict.alpha + verdict.beta)} observations). ` +
            `Pinning a target bypasses selection, not the evidence.`,
        );
      }
    }

    const trace = await this.executor.execute(template, {
      variables,
      impulses: [goalImpulse, ...(opts.seedImpulses ?? [])],
      goalContext: { goal: goalText },
      ...(mergedTags.length ? { tags: mergedTags } : {}),
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
   * Read a pinned template's LEARNED posterior and report whether it is
   * decisively negative. Returns null — meaning "proceed" — for every condition
   * other than a confident negative, including any failure to obtain the record.
   *
   * BY-ID, NOT A LIST SCAN. `/v2/activities/templates?limit=N` reports a total in
   * the thousands but caps the page at 100 and ignores a larger limit, so a scan
   * silently misses and this check would fail open forever while typechecking
   * clean. Two earlier attempts at this same guard were inert, one of them for
   * exactly that reason.
   *
   * READS metrics.* AND NOT THE TOP LEVEL. The template record carries a
   * top-level `thompson_alpha` that is the static prior and is literally 1 on the
   * very record this was built against; reading it would make the check pass
   * unconditionally.
   */
  private async pinnedTargetPosteriorVerdict(
    templateId: string,
  ): Promise<{ alpha: number; beta: number; rate: number } | null> {
    try {
      const base = this.activityApiEndpointForPosterior;
      if (!base) return null;
      const res = await fetch(
        `${base}/v2/activities/templates/${encodeURIComponent(templateId)}`,
        {
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKeyForPosterior
              ? { Authorization: `ApiKey ${this.apiKeyForPosterior}` }
              : {}),
          },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        metrics?: { thompson_alpha?: number; thompson_beta?: number };
      };
      const alpha = body.metrics?.thompson_alpha;
      const beta = body.metrics?.thompson_beta;
      if (!Number.isFinite(alpha) || !Number.isFinite(beta)) return null;
      const a = alpha as number;
      const b = beta as number;
      const total = a + b;
      // Evidence floor: below this the arm has not been observed enough to refuse.
      if (total < 100) return null;
      const rate = a / total;
      if (rate >= 0.01) return null;
      return { alpha: a, beta: b, rate };
    } catch {
      // Transport failure, timeout, bad JSON — proceed. Never let this check
      // become a new way for a dispatch to die.
      return null;
    }
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
    // RETIREMENT IS SELECTION-SCOPED; THIS ENTRY POINT IS NOT SELECTION.
    //
    // Every retirement mechanism here filters a LIST: the promote/prune sweep
    // and the recommend path both require
    // `proposed = true AND (retired = false OR retired IS NONE) AND
    // (deprecated = false OR deprecated IS NONE)`. runTemplate takes a template
    // OBJECT the caller already holds, so none of that applies — a caller that
    // pins an id reaches execution having consulted no filter at all.
    //
    // Demonstrated, not argued: a template flagged deprecated AND retired was
    // pin-dispatched and executed normally (exec_0hgne02w, exec_ruyd2s5z).
    // Deprecating a bad arm was therefore unenforceable.
    //
    // The instrumentation line is deliberate and stays until the flags are
    // confirmed present on this object: four previous guards against this exact
    // defect were inert because each was placed at a door chosen by READING
    // code, and a silent no-op is indistinguishable from a door that is never
    // used. Logging what actually arrives here makes the next failure legible.
    const t = template as unknown as Record<string, unknown>;
    const retired = t["retired"] === true;
    const deprecated = t["deprecated"] === true;
    if (retired || deprecated) {
      throw new Error(
        `refusing to execute ${template.id}: template is ` +
          `${retired ? "retired" : ""}${retired && deprecated ? " and " : ""}${deprecated ? "deprecated" : ""}. ` +
          `Retirement is selection-scoped and this entry point bypasses selection.`,
      );
    }
    return this.executor.execute(template, { variables, ...extra });
  }

  /** Passthrough to the runtime — for inspection / debugging. */
  listCapabilities() {
    return this.runtime.listAttachedVessels();
  }
}
