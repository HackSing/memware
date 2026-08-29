/**
 * Unified per-turn memory extraction runner.
 *
 * This is the production post-turn writer for unified memory.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IMemoryService } from '../types';
import { OpenAIMemoryClient } from '../llmClient';
import { AuditLogWriter, auditLogDir } from './auditLog';
import { UnifiedExtractor } from './extractor';
import { routeUnifiedExtraction } from './router';
import { mergeThresholds, type Thresholds } from './thresholds';
import type { UnifiedPendingWriter, UnifiedWorkspaceSink } from './sinks';

/**
 * The memory-kernel-owned extraction config that {@link runUnifiedTurnExtraction}
 * actually consumes: the memory-layer LLM endpoint / model overrides plus the
 * unified extraction thresholds (`config.memory.*`) and the global `debug`
 * flag. Field shapes mirror the host's config schema (avatanel
 * MemoryConfigSchema: all endpoint/model fields optional strings,
 * `unifiedThresholds` a partial per-category map, `debug` required boolean),
 * so any full host config remains structurally assignable — existing callers
 * pass the whole config unchanged, while external embedders (memware) can
 * construct the input without building an entire host config.
 */
export interface UnifiedTurnExtractionConfig {
  memory?: {
    apiKey?: string;
    baseUrl?: string;
    unifiedExtractorApiKey?: string;
    unifiedExtractorBaseUrl?: string;
    unifiedExtractorModel?: string;
    chatModel?: string;
    unifiedThresholds?: Partial<Thresholds>;
  };
  debug: boolean;
}

export interface UnifiedTurnExtractionInput {
  config: UnifiedTurnExtractionConfig;
  memory: IMemoryService;
  workspace: UnifiedWorkspaceSink | null;
  pendingWriter: UnifiedPendingWriter | null;
  userId: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
  /**
   * Host-owned audit destination. Trusted tenant hosts should pass the audit
   * directory from their tenant capability so reset owns the complete data
   * lifecycle. Omitted for backward-compatible Avatanel workspace routing.
   */
  auditDir?: string;
}

export function resolveUnifiedAuditDir(
  input: Pick<UnifiedTurnExtractionInput, 'auditDir' | 'workspace' | 'userId'>,
): string {
  if (input.auditDir) return input.auditDir;
  return input.workspace
    ? auditLogDir(input.workspace.layout.root)
    : join(
        homedir(),
        '.avatanel',
        '.unified-extraction-log',
        input.userId.replace(/[^a-zA-Z0-9._-]/g, '_'),
      );
}

export async function runUnifiedTurnExtraction(input: UnifiedTurnExtractionInput): Promise<void> {
  const memCfg = input.config.memory;
  const dedicatedExtractorApiKey = memCfg?.unifiedExtractorApiKey ?? memCfg?.apiKey;
  const dedicatedExtractorBaseUrl = memCfg?.unifiedExtractorBaseUrl ?? memCfg?.baseUrl;
  const useDedicatedExtractorClient =
    !!(memCfg?.unifiedExtractorApiKey || memCfg?.unifiedExtractorBaseUrl) &&
    !!(dedicatedExtractorApiKey && dedicatedExtractorBaseUrl);

  const extractor = new UnifiedExtractor({
    client: useDedicatedExtractorClient
      ? new OpenAIMemoryClient({
          apiKey: dedicatedExtractorApiKey!,
          baseURL: dedicatedExtractorBaseUrl!,
        })
      : input.memory.getLLMClient(),
    model: memCfg?.unifiedExtractorModel ?? memCfg?.chatModel ?? 'unknown',
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
      console.warn('[unified-extract] failed:', result.error);
    }
    return;
  }

  const auditDir = resolveUnifiedAuditDir(input);

  await routeUnifiedExtraction(result.payload, {
    memory: input.memory,
    workspace: input.workspace,
    pendingWriter: input.pendingWriter,
    userId: input.userId,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    userMessage: input.userMessage,
    assistantMessage: input.assistantMessage,
    auditLog: new AuditLogWriter(auditDir),
    extractErrors: result.errors,
    thresholds: mergeThresholds(memCfg?.unifiedThresholds),
  });
}
