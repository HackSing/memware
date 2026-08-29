import type {
  CaptureTurnAssetsInput,
  CaptureTurnAssetsResult,
} from "../assets";
import type { ContentBlock } from "../contentBlocks";

/**
 * Narrow config view for multimodal turn extraction — the kernel only reads
 * `config.memory.multimodal.{enabled,maxImageBytes,maxImagesPerTurn}`.
 * Field shapes mirror the host's config schema (avatanel MemoryConfigSchema's
 * multimodal block, whose defaults make all three required), so a full host
 * config remains structurally assignable and host call sites pass it
 * unchanged. Declared locally to keep the kernel free of host-level imports.
 */
export interface MultimodalTurnExtractionConfig {
  memory?: {
    multimodal?: {
      enabled?: boolean;
      maxImageBytes: number;
      maxImagesPerTurn: number;
    };
  };
}

export interface MultimodalMemoryService {
  captureTurnAssets(input: CaptureTurnAssetsInput): Promise<CaptureTurnAssetsResult>;
  processMultimodalAssets(input: {
    userId: string;
    sessionId: string;
    turnIndex: number;
    userMessage: string;
    assistantMessage: string;
    assets: CaptureTurnAssetsResult["captured"];
  }): Promise<void>;
}

export interface MultimodalTurnExtractionResult extends CaptureTurnAssetsResult {
  enabled: boolean;
}

export function hasMultimodalMemoryService(value: unknown): value is MultimodalMemoryService {
  return !!value &&
    typeof value === "object" &&
    typeof (value as { captureTurnAssets?: unknown }).captureTurnAssets === "function" &&
    typeof (value as { processMultimodalAssets?: unknown }).processMultimodalAssets === "function";
}

export async function runMultimodalTurnExtraction(input: {
  config: MultimodalTurnExtractionConfig;
  memory: unknown;
  userId: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
  userContent?: ContentBlock[];
  capturedAssets?: CaptureTurnAssetsResult;
  source?: string;
}): Promise<MultimodalTurnExtractionResult> {
  const mm = input.config.memory?.multimodal;
  if (!mm?.enabled || !hasMultimodalMemoryService(input.memory)) {
    return { enabled: false, captured: [], skipped: [] };
  }

  const captured = input.capturedAssets ?? await input.memory.captureTurnAssets({
    userId: input.userId,
    sessionId: input.sessionId,
    turnIndex: input.turnIndex,
    source: input.source ?? "agent-turn",
    userMessage: input.userMessage,
    content: input.userContent,
    maxImageBytes: mm.maxImageBytes,
    maxImagesPerTurn: mm.maxImagesPerTurn,
  });

  if (captured.captured.length > 0) {
    await input.memory.processMultimodalAssets({
      userId: input.userId,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      assets: captured.captured,
    });
  }

  return { enabled: true, ...captured };
}
