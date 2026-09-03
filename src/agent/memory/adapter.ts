/**
 * avatanel — Memory Adapter
 *
 * Thin wrapper around MemoryService that handles runtime availability.
 * - With Bun: uses full MemoryService (SQLite-backed)
 * - With Node.js (dev): uses in-memory fallback
 *
 * This allows P3 integration testing without requiring Bun.
 */

import type { IMemoryService, MemoryContext, MemoryCluster, MemoryRuntimeStatus } from './types';
import type { MemoryLLMClient } from './llmClient';

/**
 * No-op memory service for development/testing without Bun.
 *
 * Exported so test fakes / dev runtimes can construct one directly. All
 * methods either no-op or return harmless empty values; `getLLMClient()`
 * throws because there is no underlying client to share.
 */
export class NoopMemoryService implements IMemoryService {
  constructor(private readonly reason = 'memory service is not available') {}

  async init(): Promise<void> {}
  async warmup(_userId: string): Promise<void> {}

  async getContext(_userId: string, query: string): Promise<MemoryContext> {
    return {
      routing: { requires_memory: false, search_query: query },
      prompts: { system: '', context: '' },
    };
  }

  async searchMemory(): Promise<string> { return ''; }
  async archive(): Promise<void> {}
  async reset(): Promise<void> {}
  close(): void {}

  // ── Unified extraction surface (P2.1 noop versions) ──

  getLLMClient(): MemoryLLMClient {
    throw new Error('NoopMemoryService has no LLM client');
  }
  getRuntimeStatus(): MemoryRuntimeStatus {
    return { kind: 'noop', persistent: false, reason: this.reason };
  }
  async addMemoryCluster(): Promise<void> {}
  async updateProfile(): Promise<void> {}
  async updateRelationship(): Promise<void> {}
  async upsertActiveThread(): Promise<void> {}
  async upsertFocus(): Promise<void> {}
  async searchClusters(): Promise<MemoryCluster[]> { return []; }
  async deleteByProvenance(): Promise<number> { return 0; }
}

/**
 * Create a memory service appropriate for the current runtime.
 * Returns null if memory is disabled in config.
 */
export async function createMemoryService(opts: {
  dbPath: string;
  vectorDbPath: string;
  /** OpenAI-compatible API key used for chat (extractor/intent) + embedding */
  apiKey?: string;
  /** OpenAI-compatible base URL for the memory LLM endpoint */
  baseUrl?: string;
  /** Chat model name for extractor + intent analyzer */
  model?: string;
  /** Embedding model name */
  embeddingModel?: string;
  /** Embedding vector dimension (must match the model) */
  embeddingDim?: number;
  /** Optional separate base URL for embeddings only */
  embeddingBaseUrl?: string;
  /** Optional separate API key for embeddings only */
  embeddingApiKey?: string;
  /** Budget (ms) for the per-turn intent-routing call; see ModelConfig.intent_timeout_ms */
  intentTimeoutMs?: number;
  multimodal?: {
    enabled: boolean;
    maxImageBytes: number;
    maxImagesPerTurn: number;
    visionExtractorModel?: string;
    visionExtractorBaseUrl?: string;
    visionExtractorApiKey?: string;
  };
}): Promise<IMemoryService> {
  // Try to use the full MemoryService (requires bun:sqlite)
  try {
    // Dynamic import — will fail in Node.js (bun:sqlite not available)
    const { MemoryService } = await import('./service');
    const { MemorySettings } = await import('./config');

    // Layering contract:
    //   1. The adapter starts from trusted kernel defaults only. It must never
    //      discover config from process.cwd(), because callers commonly run it
    //      inside untrusted project repositories.
    //   2. updateRuntime() below deep-merges this adapter's explicit runtime
    //      overrides on top. Callers that intentionally need file config use
    //      `new MemoryService(MemorySettings.fromFile(absPath))` instead.
    //
    // IMPORTANT #1 — do NOT re-spread `...DEFAULT_CONFIG.model` here. It
    // would clobber sibling runtime fields whenever a caller supplies only a
    // subset of model overrides.
    //
    // IMPORTANT #2 — the configured `settings` instance MUST be passed to
    // `new MemoryService(settings)`. Previously MemoryService constructed
    // its own fresh MemorySettings internally, which silently dropped
    // every runtime override (api_key / base_url / models) and left the
    // extractor / intent analyzer / embedder pointing at whatever empty
    // credential was in DEFAULT_CONFIG.
    const settings = MemorySettings.fromDefaults();
    settings.updateRuntime({
      storage: {
        sqlite_path:    opts.dbPath,
        vector_db_path: opts.vectorDbPath,
      },
      model: {
        ...(opts.apiKey           !== undefined ? { api_key:            opts.apiKey           } : {}),
        ...(opts.baseUrl          !== undefined ? { base_url:           opts.baseUrl          } : {}),
        ...(opts.model            !== undefined ? { model_name:         opts.model            } : {}),
        ...(opts.embeddingModel   !== undefined ? { embedding_model:    opts.embeddingModel   } : {}),
        ...(opts.embeddingDim     !== undefined ? { embedding_dim:      opts.embeddingDim     } : {}),
        ...(opts.embeddingBaseUrl !== undefined ? { embedding_base_url: opts.embeddingBaseUrl } : {}),
        ...(opts.embeddingApiKey  !== undefined ? { embedding_api_key:  opts.embeddingApiKey  } : {}),
        ...(opts.intentTimeoutMs  !== undefined ? { intent_timeout_ms:  opts.intentTimeoutMs  } : {}),
      },
      ...(opts.multimodal ? {
        multimodal: {
          enabled: opts.multimodal.enabled,
          max_image_bytes: opts.multimodal.maxImageBytes,
          max_images_per_turn: opts.multimodal.maxImagesPerTurn,
          ...(opts.multimodal.visionExtractorModel !== undefined
            ? { vision_extractor_model: opts.multimodal.visionExtractorModel }
            : {}),
          ...(opts.multimodal.visionExtractorBaseUrl !== undefined
            ? { vision_extractor_base_url: opts.multimodal.visionExtractorBaseUrl }
            : {}),
          ...(opts.multimodal.visionExtractorApiKey !== undefined
            ? { vision_extractor_api_key: opts.multimodal.visionExtractorApiKey }
            : {}),
        },
      } : {}),
    });

    const service = new MemoryService(settings);
    await service.init();
    return service;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Gracefully fall back in Node.js dev environment
    if (msg.includes('bun:sqlite') || msg.includes("Cannot find module 'bun:")) {
      console.warn(
        '[avatanel] Memory: bun:sqlite not available (Node.js env). ' +
        'Using no-op memory. Install Bun for full persistence.'
      );
    } else {
      console.warn('[avatanel] Memory: initialization failed, using no-op:', msg);
    }
    return new NoopMemoryService(msg);
  }
}
