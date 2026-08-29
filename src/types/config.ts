/**
 * avatanel — Configuration Schema
 *
 * AvatanelConfig is validated at runtime via Zod.
 * Some low-level path defaults remain OS-appropriate fallbacks; host apps
 * that know userId should prefer user-scoped workspace paths.
 */

import { z } from 'zod';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { getUserMemoryDbPath, getUserMemoryVectorPath } from '../agent/evolution/workspace';
import {
  PersonaConfigSchema,
  PersonaProfileSchema,
  PersonaStyleSchema,
} from '../agent/persona/config';
import { EgressProfilesSchema } from '../security/egressProfiles';

// ── Helper: OS data directory ─────────────────────────────────

export function getDefaultDataDir(): string {
  const platform = typeof process !== 'undefined' ? process.platform : 'linux';
  switch (platform) {
    case 'win32': {
      // APPDATA may be undefined in sandboxed or container environments
      const appData = process.env['APPDATA'] ?? process.env['USERPROFILE'] ?? homedir();
      return join(appData, 'avatanel');
    }
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'avatanel');
    default:
      return join(homedir(), '.local', 'share', 'avatanel');
  }
}

export function getDefaultMemoryDbPath(): string {
  return getUserMemoryDbPath('default');
}

export function getDefaultVectorDbPath(): string {
  return getUserMemoryVectorPath('default');
}

// ── Provider Configs ──────────────────────────────────────────

const AnthropicConfigSchema = z.object({
  provider: z.literal('anthropic'),
  apiKey: z.string().min(1, 'Anthropic API key required'),
  model: z.string().default('claude-sonnet-4-5'),
  baseUrl: z.string().url().optional(),
  /** Optional chat model used only for turns containing image content. */
  visionModel: z.string().optional(),
  /** Optional endpoint override for image turns. */
  visionBaseUrl: z.string().url().optional(),
  /** Optional API key override for image turns. */
  visionApiKey: z.string().optional(),
});

const OpenAIConfigSchema = z.object({
  provider: z.literal('openai'),
  apiKey: z.string().min(1, 'OpenAI API key required'),
  model: z.string().default('gpt-4o'),
  baseUrl: z.string().url().optional(),
  organization: z.string().optional(),
  /** Optional chat model used only for turns containing image content. */
  visionModel: z.string().optional(),
  /** Optional endpoint override for image turns. */
  visionBaseUrl: z.string().url().optional(),
  /** Optional API key override for image turns. */
  visionApiKey: z.string().optional(),
});

const OpenAICompatibleConfigSchema = z.object({
  provider: z.literal('openaiCompatible'),
  apiKey: z.string().optional(),
  model: z.string().min(1, 'Model name required for openaiCompatible'),
  baseUrl: z.string().url('baseUrl is required for openaiCompatible provider'),
  /** Tool call format parser for non-standard models */
  toolCallParser: z.enum(['hermes', 'deepseek', 'qwen', 'llama']).optional(),
  /** Optional chat model used only for turns containing image content. */
  visionModel: z.string().optional(),
  /** Optional OpenAI-compatible endpoint override for image turns. */
  visionBaseUrl: z.string().url().optional(),
  /** Optional API key override for image turns. */
  visionApiKey: z.string().optional(),
});

const BedrockConfigSchema = z.object({
  provider: z.literal('bedrock'),
  region: z.string().min(1, 'AWS region required'),
  model: z.string().default('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  accessKeyId: z.string().optional(),
  secretAccessKey: z.string().optional(),
  /** Optional chat model used only for turns containing image content. */
  visionModel: z.string().optional(),
});

const VertexConfigSchema = z.object({
  provider: z.literal('vertex'),
  project: z.string().min(1, 'GCP project required'),
  location: z.string().default('us-central1'),
  model: z.string().default('claude-3-5-sonnet-v2@20241022'),
  /** Optional chat model used only for turns containing image content. */
  visionModel: z.string().optional(),
});

export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

const OpenAICodexConfigSchema = z.object({
  provider: z.literal('openai-codex'),
  /** Model id (e.g. gpt-5.4, gpt-5.3-codex). Default: gpt-5.4. */
  model: z.string().default('gpt-5.4'),
  /** Optional chat model used only for turns containing image content. */
  visionModel: z.string().optional(),
  /** Override the on-disk credential path. Default: ~/.avatanel/auth/openai-codex.json. */
  credPath: z.string().optional(),
  /** Default reasoning effort for gpt-5.x Responses API. */
  reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).default('medium'),
  /** Hard cap for one openai-codex Responses stream. */
  streamTotalTimeoutMs: z.number().int().positive().optional(),
  /** Idle cap for one openai-codex Responses stream when no provider event arrives. */
  streamIdleTimeoutMs: z.number().int().positive().optional(),
});

export const ProviderConfigSchema = z.discriminatedUnion('provider', [
  AnthropicConfigSchema,
  OpenAIConfigSchema,
  OpenAICompatibleConfigSchema,
  BedrockConfigSchema,
  VertexConfigSchema,
  OpenAICodexConfigSchema,
]);

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// ── Memory Config ─────────────────────────────────────────────

const UnifiedExtractionSchema = z.literal('on').default('on');

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Optional path to the MemLocal SQLite file. Relative paths are resolved
   * from cwd. Main host apps should supply the user-scoped memory/memory.db
   * path instead of relying on this low-level fallback.
   */
  dbPath: z.string().optional(),
  /** Optional path to the vector DB file. Relative paths are resolved from cwd. */
  vectorDbPath: z.string().optional(),

  // ── Memory-layer LLM endpoint ────────────────────────────────
  //
  // The memory pipeline (extractor / intent analyzer / embedder) talks to an
  // OpenAI-compatible server. By default it uses SiliconFlow
  // (see DEFAULT_CONFIG in src/agent/memory/config.ts). The main agent's
  // provider (e.g. Anthropic / MiniMax-Anthropic) is NOT reused here because
  // the memory layer is hard-wired to OpenAI's chat-completions + embeddings
  // API shape, which Anthropic-family endpoints do not expose.
  //
  // Set these to route memory extraction/embedding to any OpenAI-compatible
  // endpoint (SiliconFlow, OpenAI, DeepSeek, Moonshot, local vLLM, etc).

  /** API key for memory-layer chat + embedding calls */
  apiKey: z.string().optional(),
  /** OpenAI-compatible base URL (defaults to https://api.siliconflow.cn/v1) */
  baseUrl: z.string().url().optional(),
  /** Chat model used by extractor + intent analyzer (JSON output) */
  chatModel: z.string().optional(),
  /** Optional stronger model just for the unified extractor; falls back to `chatModel`. */
  unifiedExtractorModel: z.string().optional(),
  /** Optional dedicated API key for the unified extractor. */
  unifiedExtractorApiKey: z.string().optional(),
  /** Optional dedicated OpenAI-compatible base URL for the unified extractor. */
  unifiedExtractorBaseUrl: z.string().url().optional(),
  /** Embedding model used by the embedder */
  embeddingModel: z.string().optional(),
  /** Embedding vector dimension (must match the embedding model) */
  embeddingDim: z.number().int().positive().optional(),
  /** Override the embedding endpoint base URL (falls back to `baseUrl`) */
  embeddingBaseUrl: z.string().url().optional(),
  /** Override the embedding API key (falls back to `apiKey`) */
  embeddingApiKey: z.string().optional(),
  /**
   * When true, `AgentCore.run()` awaits post-turn memory jobs before returning,
   * so the next session is guaranteed to see the extracted memories.
   * Adds 7-60s latency per turn. Default: false (fire-and-forget).
   */
  awaitMemoryExtraction: z.boolean().default(false),

  /**
   * Unified extraction is now the only supported post-turn memory writer.
   * Omit this field or set it to 'on'. Legacy 'off' / 'dual' values are
   * rejected so stale configs fail loudly instead of implying a rollback path.
   * See docs/features/memory-system.md.
   */
  unifiedExtraction: UnifiedExtractionSchema,

  /**
   * Per-category confidence threshold overrides. Defaults are Codex-
   * calibrated (see thresholds.ts). Values must be in [0, 1].
   */
  unifiedThresholds: z.object({
    profile_update:  z.number().min(0).max(1).optional(),
    relationship:    z.number().min(0).max(1).optional(),
    active_threads:  z.number().min(0).max(1).optional(),
    focus:           z.number().min(0).max(1).optional(),
    memory_clusters: z.number().min(0).max(1).optional(),
  }).strict().optional(),

  /**
   * Multimodal memory V1. Image assets are saved locally and indexed as
   * summaries/OCR/entity links; raw images are never injected through
   * Memory Context.
   */
  multimodal: z.object({
    enabled: z.boolean().default(true),
    maxImageBytes: z.number().int().positive().default(8 * 1024 * 1024),
    maxImagesPerTurn: z.number().int().positive().default(4),
    visionExtractorModel: z.string().optional(),
    visionExtractorApiKey: z.string().optional(),
    visionExtractorBaseUrl: z.string().url().optional(),
  }).strict().default({}),
}).transform((cfg) => {
  // C3 fix: always resolve to absolute paths so downstream modules (MemLocal,
  // SessionStore) never receive relative paths — behavior is consistent across
  // Windows and macOS regardless of cwd at import time.
  const resolvedDbPath = cfg.dbPath
    ? (isAbsolute(cfg.dbPath) ? cfg.dbPath : resolve(cfg.dbPath))
    : getDefaultMemoryDbPath();
  const resolvedVectorPath = cfg.vectorDbPath
    ? (isAbsolute(cfg.vectorDbPath) ? cfg.vectorDbPath : resolve(cfg.vectorDbPath))
    : getDefaultVectorDbPath();
  return {
    enabled:                cfg.enabled,
    dbPath:                 resolvedDbPath,
    vectorDbPath:           resolvedVectorPath,
    apiKey:                 cfg.apiKey,
    baseUrl:                cfg.baseUrl,
    chatModel:              cfg.chatModel,
    unifiedExtractorModel:  cfg.unifiedExtractorModel,
    unifiedExtractorApiKey: cfg.unifiedExtractorApiKey,
    unifiedExtractorBaseUrl: cfg.unifiedExtractorBaseUrl,
    embeddingModel:         cfg.embeddingModel,
    embeddingDim:           cfg.embeddingDim,
    embeddingBaseUrl:       cfg.embeddingBaseUrl,
    embeddingApiKey:        cfg.embeddingApiKey,
    awaitMemoryExtraction:  cfg.awaitMemoryExtraction,
    unifiedExtraction:      cfg.unifiedExtraction,
    unifiedThresholds:      cfg.unifiedThresholds,
    multimodal:             cfg.multimodal,
  };
});

// ── Session Config ────────────────────────────────────────────

export const SessionConfigSchema = z.object({
  maxTurns: z.number().int().positive().default(100),
  persistSessions: z.boolean().default(true),
  sessionId: z.string().optional(),
  /** Directory where session JSON files are stored. Default: ~/.avatanel/sessions/ */
  sessionDir: z.string().optional(),
});

// ── Prompt Projection Config ─────────────────────────────────

export const ProjectionConfigSchema = z.object({
  /** Target recent-history budget for ordinary chat. */
  chatHistoryTargetTokens: z.number().int().positive().default(6_000),
  /** Target recent-history budget for active task/tool chains. Not a hard floor. */
  taskHistoryTargetTokens: z.number().int().positive().default(12_000),
  /** Maximum recent-history budget for complex active task/tool chains. */
  taskHistoryMaxTokens: z.number().int().positive().default(40_000),
  /** Max chars for the conditional recent_anchor in Current Turn Context. */
  recentAnchorMaxChars: z.number().int().positive().default(600),
  /** Fraction of the model context window used as the skill manifest char budget. */
  skillManifestBudgetPercent: z.number().positive().default(0.01),
}).default({});

export type ProjectionConfig = z.infer<typeof ProjectionConfigSchema>;

// ── Runtime Config ────────────────────────────────────────────

export const DelegationPlannerConfigSchema = z.object({
  /**
   * When enabled, AgentCore injects a non-persisted turn hint that tells the
   * model whether this request is a good candidate for subagent delegation.
   * The planner never spawns agents by itself; the model must call tools
   * explicitly so delegation remains observable.
   */
  enabled: z.boolean().default(true),
  /** Hint-only is the production-safe mode. Hidden pre-execution is unsupported. */
  mode: z.literal('hint').default('hint'),
  /** Maximum subagents the planner should recommend for one DelegateBatch call. */
  maxParallelSubagents: z.number().int().min(1).max(8).default(3),
  /** Internal subagents are currently read-only only. */
  defaultReadOnly: z.literal(true).default(true),
  /** Prefer ACP coding agents when a task needs edits, shell commands, or tests. */
  preferAcpForWrites: z.boolean().default(true),
}).default({});

export type DelegationPlannerConfig = z.infer<typeof DelegationPlannerConfigSchema>;

export const RuntimeToolSearchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['auto', 'direct', 'compact']).default('auto'),
  compactAtToolCount: z.number().int().positive().default(24),
  compactAtDefinitionChars: z.number().int().positive().default(32_000),
  searchDefaultLimit: z.number().int().min(1).default(8),
  searchMaxLimit: z.number().int().min(1).default(20),
  pinnedDirectTools: z.array(z.string().min(1)).default(['Bash', 'FileRead', 'FileEdit', 'Grep', 'Glob']),
}).default({});

export type RuntimeToolSearchConfig = z.infer<typeof RuntimeToolSearchConfigSchema>;

export const RuntimeToolLoopGuardrailsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Opt-in early finalization path. When disabled, guardrails only add
   * continuation hints / token budgets and the tool loop keeps running while
   * the provider keeps emitting real tool_use blocks.
   */
  finalizationEnabled: z.boolean().default(false),
  softMaxIterations: z.number().int().positive().default(24),
  softMaxToolCalls: z.number().int().positive().default(60),
  softMaxElapsedMs: z.number().int().positive().default(720_000),
  projectionPressureThreshold: z.number().positive().max(1).default(0.85),
  finalizeAfterIterations: z.number().int().positive().default(4),
  finalizeAfterToolCalls: z.number().int().positive().default(8),
  finalizeAfterElapsedMs: z.number().int().positive().default(120_000),
  toolResponseMaxTokens: z.number().int().positive().default(4_096),
  finalizationMaxTokens: z.number().int().positive().default(3_072),
}).default({});

export type RuntimeToolLoopGuardrailsConfig = z.infer<typeof RuntimeToolLoopGuardrailsConfigSchema>;

export const RuntimeMemoryContextConfigSchema = z.object({
  timeoutMs: z.number().int().positive().default(8_000),
  systemMaxChars: z.number().int().positive().default(6_000),
  contextMaxChars: z.number().int().positive().default(8_000),
}).default({});

export type RuntimeMemoryContextConfig = z.infer<typeof RuntimeMemoryContextConfigSchema>;

export const RuntimeMediaConfigSchema = z.object({
  imageModel: z.object({
    /** Process-wide fallback for ImageGenerate when the current agent has no own default. */
    primary: z.string().trim().min(1).optional(),
  }).strict().default({}),
}).default({});

export type RuntimeMediaConfig = z.infer<typeof RuntimeMediaConfigSchema>;

export const RuntimeConfigSchema = z.object({
  /**
   * Observability budget for tool-loop iterations per user turn. By default
   * Avatanel follows Claude Code's model and keeps going while the model keeps
   * requesting tools; set stopOnToolBudget to make this a hard stop.
   */
  maxToolIterations: z.number().int().positive().default(50),
  /**
   * Multiplier applied to the provider context window for the optional per-turn
   * token budget. Context projection/compaction remains the normal control
   * plane; this only matters when stopOnToolBudget is enabled.
   */
  toolTokenBudgetMultiplier: z.number().positive().default(20),
  /**
   * Optional wall-clock cap for the tool loop. Omit to disable the global
   * tool-chain timeout. The value is only enforced when stopOnToolBudget is
   * enabled; progress heartbeats, gateway idle watchdogs, and per-tool timeouts
   * handle normal long-running turns.
   */
  toolLoopTimeoutMs: z.number().int().positive().optional(),
  /**
   * Compatibility escape hatch for operators who want the old behavior where
   * budget exhaustion interrupts the turn and asks the user to continue.
   */
  stopOnToolBudget: z.boolean().default(false),
  delegationPlanner: DelegationPlannerConfigSchema.optional(),
  toolSearch: RuntimeToolSearchConfigSchema.optional(),
  toolLoopGuardrails: RuntimeToolLoopGuardrailsConfigSchema.optional(),
  memoryContext: RuntimeMemoryContextConfigSchema.optional(),
  media: RuntimeMediaConfigSchema.optional(),
});

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export interface ResolvedRuntimeConfig {
  maxToolIterations: number;
  toolTokenBudgetMultiplier: number;
  toolLoopTimeoutMs?: number;
  stopOnToolBudget: boolean;
  delegationPlanner: DelegationPlannerConfig;
  toolSearch: RuntimeToolSearchConfig;
  toolLoopGuardrails: RuntimeToolLoopGuardrailsConfig;
  memoryContext: RuntimeMemoryContextConfig;
  media: RuntimeMediaConfig;
}

export function resolveRuntimeConfig(config?: RuntimeConfig): ResolvedRuntimeConfig {
  return {
    maxToolIterations: config?.maxToolIterations ?? 50,
    toolTokenBudgetMultiplier: config?.toolTokenBudgetMultiplier ?? 20,
    ...(config?.toolLoopTimeoutMs !== undefined ? { toolLoopTimeoutMs: config.toolLoopTimeoutMs } : {}),
    stopOnToolBudget: config?.stopOnToolBudget ?? false,
    delegationPlanner: DelegationPlannerConfigSchema.parse(config?.delegationPlanner ?? {}),
    toolSearch: RuntimeToolSearchConfigSchema.parse(config?.toolSearch ?? {}),
    toolLoopGuardrails: RuntimeToolLoopGuardrailsConfigSchema.parse(config?.toolLoopGuardrails ?? {}),
    memoryContext: RuntimeMemoryContextConfigSchema.parse(config?.memoryContext ?? {}),
    media: RuntimeMediaConfigSchema.parse(config?.media ?? {}),
  };
}

// ── Security Config ───────────────────────────────────────────

export const SecurityConfigSchema = z.object({
  /**
   * Business-owned outbound network lanes. Profiles authorize host boundaries
   * for runtime/capability calls; they do not bypass private-network safety.
   */
  egressProfiles: EgressProfilesSchema,
  /**
   * Explicit destinations that may resolve to local/private networks.
   * Intended for operator-owned local model providers and WebDAV endpoints.
   * User-supplied URLs do not gain this exception unless the host process
   * configured the destination here or in AVATANEL_TRUSTED_NETWORK_ALLOWLIST.
   */
  trustedNetworkAllowlist: z.array(z.string().trim().min(1)).default([]),
}).strict().default({});

export type SecurityConfig = z.infer<typeof SecurityConfigSchema>;

// ── Runtime Identity Config ───────────────────────────────────

export const RuntimeIdentityConfigSchema = z.object({
  /** Stable user workspace id used for memory, sessions, persona store, and assets. */
  userId: z.string().trim().min(1).optional(),
  /** Runtime agent name used for agent-scoped workspace, skills, sessions, and persona. */
  agentName: z.string().trim().min(1).optional(),
  /** Whether the persona prompt layer is enabled for this runtime agent. */
  personaEnabled: z.boolean().default(true),
});

export type RuntimeIdentityConfig = z.infer<typeof RuntimeIdentityConfigSchema>;

// ── Persona Config ────────────────────────────────────────────
//
// Persona is now its own module (`src/agent/persona/*`) and active runtime
// persona persists under user/<userId>/agents/<agentName>/persona/. These
// exports are for the agent-scoped persona store and prompt compiler. Runtime
// identity lives in `config.identity`; `config.persona` is no longer accepted.
export {
  PersonaStyleSchema,
  PersonaProfileSchema,
  PersonaConfigSchema,
};
export type { PersonaStyleConfig, PersonaProfile, PersonaConfig } from '../agent/persona/config';

// ── ACP Config ────────────────────────────────────────────────

/**
 * One external coding agent reachable over the Agent Client Protocol.
 *
 * `command` + `args` spawn an ACP server (e.g. `claude-code-acp`, `codex-acp`,
 * `gemini --experimental-acp`). The child is kept alive across calls so we
 * amortize JSON-RPC handshake + session create cost.
 */
export const ACPAgentSpecSchema = z.object({
  /** Executable to spawn. Resolved against a normalized subprocess PATH. */
  command: z.string().min(1),
  /** Arguments passed to the executable. */
  args: z.array(z.string()).default([]),
  /** Extra env vars explicitly forwarded to the child on top of the minimal runtime allowlist. */
  env: z.record(z.string()).optional(),
  /** Working directory. Default: caller-supplied cwd at prompt time. */
  cwd: z.string().optional(),
  /**
   * Permission policy for this agent. ACP agents may ask the client for
   * approval to run tools (e.g. file writes). Non-interactive callers
   * (Discord bots) can't prompt a human, so we pick a default up-front.
   *
   *  - `deny-all` — reject every request. Safest; breaks write-capable agents.
   *  - `allow-read-only` — allow the first "allow_once" / "allow_always"
   *                        option only for read-like tool kinds.
   *  - `allow-all`  — approve any request. Use only for fully trusted envs.
   *  - `interactive` — park the request for a human to answer through
   *                    `/api/approvals`. Only useful where a client is
   *                    actually watching; unanswered requests are rejected
   *                    after `approvalTimeoutMs`.
   */
  permissionPolicy: z
    .enum(['deny-all', 'allow-read-only', 'allow-all', 'interactive'])
    .default('allow-read-only'),
  /**
   * How long an `interactive` request waits for a human before it is
   * rejected. Bounded on purpose: an unattended run must fail closed rather
   * than block an ACP turn forever.
   */
  approvalTimeoutMs: z.number().int().positive().default(600_000),
  /** Max time to wait for the ACP handshake before killing the child. */
  handshakeTimeoutMs: z.number().int().positive().default(10_000),
});

export type ACPAgentSpec = z.infer<typeof ACPAgentSpecSchema>;

export const ACPConfigSchema = z.object({
  /** Agent id → connection spec. The id is what the LLM passes to the tool. */
  agents: z.record(ACPAgentSpecSchema).default({}),
  /**
   * Max seconds to wait for one prompt-response round-trip before bailing.
   * ACP agents can take several minutes on complex tasks; 5 min matches
   * codex review-mode budget.
   */
  promptTimeoutMs: z.number().int().positive().default(300_000),
  /**
   * Experimental (E0 Runtime integration phase 1): route every ACP
   * subprocess through the sandbox wrap chain — fresh per-run roots, explicit
   * allowlist environment, serial single-slot execution, per-run enforced
   * evidence report. Default off; when off, ACP behavior is unchanged.
   */
  e0SandboxedRuns: z.boolean().default(false),
  /**
   * Experimental (E0 Runtime phase 2A): extra domains appended to the
   * built-in model API egress allowlist (`E0_MODEL_API_BUILTIN_DOMAINS`).
   * Only consulted when `e0SandboxedRuns` is on; the all-open `*` pattern is
   * rejected at runner construction (fail-closed).
   */
  e0ModelApiExtraDomains: z.array(z.string()).default([]),
});

export type ACPConfig = z.infer<typeof ACPConfigSchema>;

// ── Bash Tool Config ──────────────────────────────────────────

export const BashConfigSchema = z.object({
  /**
   * Experimental (E0 Runtime phase 2B): route Bash tool commands — foreground
   * and background shell tasks — through the sandbox wrap chain (workspace
   * punch hole inside the denied Home tree, explicit allowlist environment,
   * serial single-slot execution, per-command enforced evidence report).
   * Default off. This switch alone does nothing: the per-session experimental
   * marker must also be set (double gate, decision B2). When off, Bash
   * behavior is unchanged and no sandbox module is loaded.
   */
  e0SandboxedCommands: z.boolean().default(false),
});

export type BashConfig = z.infer<typeof BashConfigSchema>;

// ── Plugin Config ─────────────────────────────────────────────

export const PluginConfigSchema = z.object({
  /** Master switch for same-process plugin loading. */
  enabled: z.boolean().default(true),
  /**
   * Directories scanned for plugin entries. Each entry file must remain under
   * the configured directory; plugin code still runs in-process and should be
   * trusted.
   */
  pluginDirs: z.array(z.string().min(1)).default([]),
  /**
   * Explicit plugin entry files. Each file is loaded with its own parent
   * directory as the trusted base.
   */
  entries: z.array(z.string().min(1)).default([]),
}).strict().default({});

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

// ── Skill Config ──────────────────────────────────────────────

/**
 * One source directory the SkillStore will scan.
 *
 *  - `path`     — directory to scan
 *  - `format`   — 'avatanel' (default) for flat one-file-per-skill layout;
 *                 'claude-code' for directory-packages with SKILL.md
 *  - `namespace`— optional prefix applied to skill names (e.g. 'sp' → 'sp/brainstorming')
 */
export const SkillSourceSchema = z.object({
  path: z.string().min(1),
  format: z.enum(['avatanel', 'claude-code']).default('avatanel'),
  namespace: z.string().optional(),
});

export type SkillSourceConfig = z.infer<typeof SkillSourceSchema>;

export const SkillConfigSchema = z.object({
  /**
   * Primary directory for auto-created Skill files. Also scanned at startup
   * when `skillDirs` is not provided. Runtime defaults now live under
   * ~/.avatanel/user/<userId>/agents/<agentName>/.skills/active/.
   */
  skillsDir: z.string().optional(),
  /**
   * Multiple scan sources, each with its own format. When present, this
   * replaces the single-source scan. The first source is treated as primary
   * (SkillCreator writes there).
   */
  skillDirs: z.array(SkillSourceSchema).optional(),
  /** Enable PatternTracker (auto-detect repeated intents). Default: true */
  autoCreate: z.boolean().default(true),
  /** Enable self-improvement (update skill from feedback). Default: true */
  autoImprove: z.boolean().default(true),
  /** Repetition count to trigger auto-create. Default: 3 */
  patternThreshold: z.number().int().min(1).default(3),
  /** Require approval check before executing code-type skills. Default: true */
  requireApproval: z.boolean().default(true),
  /**
   * When true, the matcher falls back to description-keyword matching for
   * skills that don't declare `triggers` (typical for Claude Code skills).
   * Default: true.
   */
  descriptionFallback: z.boolean().default(true),
  /** Per-agent skill whitelist. Only listed skills appear in manifest and tools. Omit for all. */
  skillFilter: z.array(z.string()).optional(),
});

export type SkillConfig = z.infer<typeof SkillConfigSchema>;

// ── EvoLoop / Self-Evolution Config ────────────────────────────

export const EvolutionConfigSchema = z.object({
  /** Master switch — when true, agent uses per-userId workspace + EvoLoop loop. */
  enabled: z.boolean().default(false),
  /**
   * Override default ~/.avatanel/user root. Per-userId subdirs are created
   * under here, and per-agent workspaces live at
   * <workspaceRoot>/<userId>/agents/<agentName>/.
   */
  workspaceRoot: z.string().optional(),
  /** Stable runtime agent name used for the per-agent child workspace. */
  agentName: z.string().default('default'),
  /** Cron reviewer LLM model name (defaults to provider.model when omitted). */
  reviewerModel: z.string().optional(),
  /** Whether to load skills from per-agent .skills/active/ in addition to global skillDirs. */
  perAgentSkills: z.boolean().default(true),
  /** Whether daily-info-update / daily-review cron jobs auto-register on agent start. */
  cronEnabled: z.boolean().default(false),
  /**
   * Every N turns the EvoLoop reminder appends a "deep-reflection" nudge asking
   * the agent to scan the last N turns for patterns and propose skills / rules.
   * 0 disables (default).
   */
  reflectEveryNTurns: z.number().int().min(0).default(0),
  /**
   * When true, Reflect blocks (Step 0 + current) are appended to
   * <workspaceRoot>/.reflect-log/<date>.jsonl after each turn for offline review.
   *
   * Outbound strip of 【Reflect】/【MISSION】/【Skill Candidate】 is
   * unconditional — see src/agent/evolution/outboundSanitizer.ts. This flag
   * only gates the audit-log write. Renamed from `hideReflectFromResponse`
   * on 2026-04-20 after strip became unconditional.
   */
  writeReflectLog: z.boolean().default(false),
});

export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;

// ── Quality Config ───────────────────────────────────────────────

export const QualityScheduleConfigSchema = z.object({
  /** Built-in scheduling is opt-in so external cron jobs are never duplicated silently. */
  enabled: z.boolean().default(false),
  /** Exactly one agent runtime owns deterministic quality jobs. */
  ownerAgent: z.literal('claws').default('claws'),
  timezone: z.string().trim().min(1).default('Asia/Shanghai'),
  dailyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:05'),
  /** JavaScript weekday: Sunday=0 through Saturday=6. */
  weeklyDay: z.number().int().min(0).max(6).default(0),
  weeklyTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('09:15'),
}).default({});

export type QualityScheduleConfig = z.infer<typeof QualityScheduleConfigSchema>;

export const CoderLifecycleRecorderConfigSchema = z.object({
  /** Explicit global opt-in for automatic ACP terminal S0 candidate recording. */
  enabled: z.boolean().default(false),
  /** The recorder rejects sensitive and unclassified tasks; Runtime/UI owns this value. */
  privacyClassification: z.enum(['standard', 'sensitive', 'unclassified']).default('unclassified'),
  /** Trusted Runtime/UI task-level opt-out. Model text cannot override this. */
  taskEnabled: z.boolean().default(true),
}).default({});

export type CoderLifecycleRecorderConfig = z.infer<typeof CoderLifecycleRecorderConfigSchema>;

export const QualityConfigSchema = z.object({
  /** Persist sanitized per-turn quality events for the eval feedback loop. */
  turnEventsEnabled: z.boolean().default(true),
  /** Privacy-minimized ACP terminal recorder. Disabled until explicitly opted in. */
  coderLifecycleRecorder: CoderLifecycleRecorderConfigSchema,
  /** LLM judge model for quality:benchmark. Falls back to evolution.reviewerModel. */
  evaluatorModel: z.string().optional(),
  /** Optional OpenAI-compatible base URL for the benchmark judge. */
  evaluatorBaseUrl: z.string().url().optional(),
  /** Optional API key for the benchmark judge. */
  evaluatorApiKey: z.string().optional(),
  /** Default behavior for benchmark runs. CLI can still override with --no-judge. */
  judgeEnabled: z.boolean().default(true),
  /** Deterministic daily scan / weekly digest scheduler. Disabled until explicitly activated. */
  schedule: QualityScheduleConfigSchema,
}).default({});

export type QualityConfig = z.infer<typeof QualityConfigSchema>;

// ── Root Config ───────────────────────────────────────────────

export const AvatanelConfigSchema = z.object({
  provider: ProviderConfigSchema,
  identity: RuntimeIdentityConfigSchema.optional(),
  memory: MemoryConfigSchema.optional(),
  session: SessionConfigSchema.optional(),
  skills: SkillConfigSchema.optional(),
  /** Runtime guardrails for tool-loop execution. */
  runtime: RuntimeConfigSchema.optional(),
  /** Provider-facing prompt projection controls. */
  projection: ProjectionConfigSchema.optional(),
  /** EvoLoop self-evolution layer. See docs/architecture/architecture.md. */
  evolution: EvolutionConfigSchema.optional(),
  /** Quality report / benchmark evaluator settings. */
  quality: QualityConfigSchema,
  /** Process-wide security policy knobs. Defaults deny private network URL destinations. */
  security: SecurityConfigSchema.optional(),
  /** External ACP agents reachable as tools. See docs/features/acp.md. */
  acp: ACPConfigSchema.optional(),
  /** Bash tool knobs, including the experimental E0 sandbox double gate. */
  bash: BashConfigSchema.optional(),
  /** Same-process plugins that register tools and hooks at startup. */
  plugins: PluginConfigSchema.optional(),
  /** Working directory for file tools. Defaults to process.cwd() */
  workDir: z.string().optional(),
  debug: z.boolean().default(false),
});

export type AvatanelConfig = z.infer<typeof AvatanelConfigSchema>;

/** Input type before Zod transforms (for createAgent() callers) */
export type AvatanelConfigInput = z.input<typeof AvatanelConfigSchema>;
