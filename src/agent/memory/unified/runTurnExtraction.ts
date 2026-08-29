/**
 * Unified per-turn memory extraction runner.
 *
 * This is the production post-turn writer for unified memory.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AvatanelConfig } from '../../../types/config';
import type { IMemoryService } from '../types';
import type { WorkspaceManager } from '../../evolution/workspaceManager';
import type { PendingWriter } from '../../evolution/types';
import { OpenAIMemoryClient } from '../llmClient';
import { AuditLogWriter, auditLogDir } from './auditLog';
import { UnifiedExtractor } from './extractor';
import { routeUnifiedExtraction } from './router';
import { mergeThresholds } from './thresholds';

/**
 * Narrow view of {@link AvatanelConfig} that {@link runUnifiedTurnExtraction}
 * actually consumes: the memory-layer LLM endpoint / model overrides plus the
 * unified extraction thresholds (`config.memory.*`) and the global `debug`
 * flag. Field types and optionality are derived from AvatanelConfig so they
 * stay in lockstep (single source of truth) and any full AvatanelConfig
 * remains structurally assignable — existing callers pass the whole config
 * unchanged. Lets external embedders (memware) construct the input without
 * building an entire AvatanelConfig.
 */
export interface UnifiedTurnExtractionConfig {
  memory?: Pick<
    NonNullable<AvatanelConfig['memory']>,
    | 'apiKey'
    | 'baseUrl'
    | 'unifiedExtractorApiKey'
    | 'unifiedExtractorBaseUrl'
    | 'unifiedExtractorModel'
    | 'chatModel'
    | 'unifiedThresholds'
  >;
  debug: AvatanelConfig['debug'];
}

export interface UnifiedTurnExtractionInput {
  config: UnifiedTurnExtractionConfig;
  memory: IMemoryService;
  workspace: WorkspaceManager | null;
  pendingWriter: PendingWriter | null;
  userId: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
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

  const auditDir = input.workspace
    ? auditLogDir(input.workspace.layout.root)
    : join(
        homedir(),
        '.avatanel',
        '.unified-extraction-log',
        input.userId.replace(/[^a-zA-Z0-9._-]/g, '_'),
      );

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
