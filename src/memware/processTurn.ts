/**
 * memware — the single post-turn write path shared by serve (memory_process)
 * and hook mode.
 *
 * This mirrors the body of the kernel's `runUnifiedTurnExtraction`
 * (src/agent/memory/unified/runTurnExtraction.ts) but is a purpose-built
 * composition rather than a call to it, for two reasons the runner cannot
 * satisfy under memware's constraints:
 *
 *   1. Audit location. The runner hard-codes the workspace=null audit dir to
 *      ~/.avatanel/.unified-extraction-log/<userId>. memware must keep its
 *      data self-contained under the memware root (isolated from ~/.avatanel),
 *      so we pass our own AuditLogWriter pointed at the memware audit dir.
 *
 *   2. Dedicated extractor client. The runner branches to a separate LLM client
 *      when memory.unifiedExtractor{ApiKey,BaseUrl} are set. memware injects a
 *      single endpoint via createMemoryService and never sets those, so we
 *      always reuse memory.getLLMClient() — the runner's branch would be dead
 *      code here.
 *
 * All the heavy logic (schema extraction, gating, provenance, routing, audit
 * append, threshold defaults) is reused verbatim from unified/*.
 */

import type { IMemoryService } from "../agent/memory/types";
import { DEFAULT_CONFIG } from "../agent/memory/config";
import type { UnifiedTurnExtractionConfig } from "../agent/memory/unified/runTurnExtraction";
import { UnifiedExtractor } from "../agent/memory/unified/extractor";
import { routeUnifiedExtraction } from "../agent/memory/unified/router";
import { AuditLogWriter } from "../agent/memory/unified/auditLog";
import { mergeThresholds } from "../agent/memory/unified/thresholds";
import type { MemwareEnv } from "./env";

export interface ProcessTurnInput {
  memory: IMemoryService;
  config: UnifiedTurnExtractionConfig;
  /** Directory for this user's unified-extraction audit log. */
  auditDir: string;
  userId: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
}

export interface ProcessTurnResult {
  ok: boolean;
  /** Number of route actions applied (0 when extraction failed or no-op). */
  actions: number;
  /** Present when extraction failed (result.ok === false). */
  error?: string;
}

/**
 * Build the narrow extraction config from the memware environment. Maps the
 * single MEMWARE_MODEL to `chatModel` (the extractor model resolves via
 * `unifiedExtractorModel ?? chatModel ?? 'unknown'`, matching the kernel). No
 * business defaults are copied — omitted fields fall through to DEFAULT_CONFIG.
 */
export function buildExtractionConfig(env: MemwareEnv): UnifiedTurnExtractionConfig {
  return {
    memory: {
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      chatModel: env.model,
      // memware never sets a dedicated extractor endpoint or custom thresholds;
      // left undefined so the kernel falls back to its own defaults.
      unifiedExtractorModel: undefined,
      unifiedExtractorApiKey: undefined,
      unifiedExtractorBaseUrl: undefined,
      unifiedThresholds: undefined,
    },
    debug: env.debug,
  };
}

/** Run unified extraction for one turn and fan the result out to LTM. */
export async function processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
  const memCfg = input.config.memory;
  const extractor = new UnifiedExtractor({
    client: input.memory.getLLMClient(),
    // Unlike the kernel runner (whose config always carries chatModel via
    // avatanel's DEFAULT_CONFIG merge), memware injects a single endpoint and
    // leaves MEMWARE_MODEL optional — so the last resort here must be the
    // kernel's default model name, never the kernel's "unknown" placeholder
    // (an "unknown" model makes the provider reject the call with HTTP 400).
    model: memCfg?.unifiedExtractorModel ?? memCfg?.chatModel ?? DEFAULT_CONFIG.model.model_name,
  });

  const result = await extractor.extract({
    userId: input.userId,
    userMessage: input.userMessage,
    assistantResponse: input.assistantMessage,
    turnIndex: input.turnIndex,
    sessionId: input.sessionId,
  });
  if (!result.ok || !result.payload) {
    if (input.config.debug) {
      console.warn("[memware] unified extraction failed:", result.error);
    }
    return { ok: false, actions: 0, error: result.error };
  }

  const actions = await routeUnifiedExtraction(result.payload, {
    memory: input.memory,
    workspace: null,
    pendingWriter: null,
    userId: input.userId,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    userMessage: input.userMessage,
    assistantMessage: input.assistantMessage,
    auditLog: new AuditLogWriter(input.auditDir),
    extractErrors: result.errors,
    thresholds: mergeThresholds(memCfg?.unifiedThresholds),
  });
  return { ok: true, actions: actions.length };
}
