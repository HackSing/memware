/**
 * avatanel Memory System — Unified Service Facade
 *
 * Single entry point combining all memory modules.
 * Implements IMemoryService interface.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SQLiteStorage } from "./storage";
import { VectorStore } from "./vectorStore";
import { MemoryCache } from "./cache";
import { Embedder } from "./embedder";
import { IntentAnalyzer } from "./intentAnalyzer";
import { MemoryEngine } from "./memoryEngine";
import { MemorySearch } from "./search";
import { buildSystemPrompt, buildContextPrompt } from "./promptBuilder";
import { MemorySettings } from "./config";
import { OpenAIMemoryClient } from "./llmClient";
import type { MemoryLLMClient } from "./llmClient";
import {
  appendMemoryClusterToDigest,
  applyRelationshipUpdate,
  mergeProfileSections,
  upsertActiveThreadInDigest,
  upsertFocusInDigest,
  type ActiveThreadUpdateInput,
  type FocusUpdateInput,
  type ProfileUpdateSections,
  type RelationshipUpdateInput,
} from "./documentMutations";
import {
  MemoryAssetStore,
  metadataSourceForAsset,
  memoryIdForImageCluster,
  type CaptureTurnAssetsInput,
  type CaptureTurnAssetsResult,
  type MemoryAsset,
  type MemoryAssetDetail,
  type MultimodalAssetExtraction,
  type StoreGeneratedImageAssetInput,
  type StoredGeneratedImageAsset,
} from "./assets";
import { MultimodalMemoryExtractor } from "./multimodalExtractor";
import { detectUserLanguage, normalizeUserLanguage } from "./language";
import { memoryTimestampSeconds } from "./time";
import {
  provenanceMatches,
  vectorMetadataSubstringForProvenanceFilter,
  type ProvenanceDeleteFilter,
} from "./provenance";
import {
  extractTextMemoryEntityCandidates,
  memoryIdForTextCluster,
  metadataSourceForTextCluster,
  TEXT_MEMORY_RELATION_EXTRACTOR_VERSION,
} from "./relationProjection";
import type {
  IMemoryService,
  MemoryContext,
  MemoryCluster,
  MemoryRuntimeStatus,
} from "./types";

export type MultimodalAssetRetryErrorKind =
  | "asset_not_found"
  | "extractor_failed"
  | "extractor_not_configured"
  | "extraction_rejected"
  | "storage_failed";

export type MultimodalAssetRetryResult =
  | { status: "updated" }
  | { status: "failed"; errorKind: MultimodalAssetRetryErrorKind };

export class MemoryService implements IMemoryService {
  private storage!: SQLiteStorage;
  private vectorStore!: VectorStore;
  private cache!: MemoryCache;
  private embedder!: Embedder;
  private intentAnalyzer!: IntentAnalyzer;
  private engine!: MemoryEngine;
  private memorySearch!: MemorySearch;
  private assetStore!: MemoryAssetStore;
  private chatClient!: MemoryLLMClient;
  private settings: MemorySettings;

  /**
   * Construct a MemoryService.
   *
   * @param configOrPath  - Either a string path to a memory config JSON file,
   *                        or a pre-built MemorySettings instance. The latter
   *                        lets callers (e.g. `createMemoryService` in the
   *                        avatanel adapter) configure the memory layer at
   *                        runtime with API keys / endpoints that aren't in
   *                        an on-disk config file.
   */
  constructor(configOrPath?: string | MemorySettings) {
    this.settings =
      configOrPath instanceof MemorySettings
        ? configOrPath
        : new MemorySettings(configOrPath);
  }

  async init(): Promise<void> {
    const cfg = this.settings.config;

    // Storage
    this.storage = new SQLiteStorage(cfg.storage.sqlite_path);
    this.vectorStore = new VectorStore(cfg.storage.vector_db_path);
    this.assetStore = new MemoryAssetStore(
      this.storage.getDatabaseForExtensions(),
      join(dirname(cfg.storage.sqlite_path), "assets"),
    );

    // Cache
    this.cache = new MemoryCache({
      profileTtl: cfg.cache.profile_ttl,
      embeddingTtl: cfg.cache.embedding_ttl,
      highFrequencyThreshold: cfg.cache.high_frequency_threshold,
      highFrequencyTtl: cfg.cache.high_frequency_ttl,
    });

    // LLM Client — single instance shared by extractor, intent analyzer, and embedder.
    // Chat and embedding endpoints may differ (e.g. SiliconFlow chat + different embedding URL),
    // so we create two clients if embeddingBaseUrl/embeddingApiKey are set separately.
    this.chatClient = new OpenAIMemoryClient({
      apiKey: cfg.model.api_key,
      baseURL: cfg.model.base_url,
    });
    const embeddingBaseUrl = cfg.model.embedding_base_url ?? cfg.model.base_url;
    const embeddingApiKey = cfg.model.embedding_api_key ?? cfg.model.api_key;
    const embeddingClient: MemoryLLMClient =
      embeddingBaseUrl === cfg.model.base_url && embeddingApiKey === cfg.model.api_key
        ? this.chatClient
        : new OpenAIMemoryClient({ apiKey: embeddingApiKey, baseURL: embeddingBaseUrl });

    // Embedder
    this.embedder = new Embedder(cfg.model, this.cache, embeddingClient);

    // Intent Analyzer
    this.intentAnalyzer = new IntentAnalyzer(cfg.model, this.chatClient);

    // Engine & Search
    this.engine = new MemoryEngine(
      this.storage,
      this.vectorStore,
      this.cache,
      this.embedder,
    );

    this.memorySearch = new MemorySearch(
      this.vectorStore,
      this.embedder,
      cfg.read,
    );
  }

  getRuntimeStatus(): MemoryRuntimeStatus {
    return { kind: "persistent", persistent: true };
  }

  async warmup(
    userId: string,
    initialData?: Record<string, unknown>,
  ): Promise<void> {
    this.engine.warmupUser(userId, initialData);
  }

  async getContext(
    userId: string,
    query: string,
    scene?: string,
  ): Promise<MemoryContext> {
    const doc = this.engine.getUserCached(userId);
    if (!doc) {
      return {
        routing: { requires_memory: false, search_query: query },
        prompts: { system: "", context: "" },
      };
    }

    const sysCore = doc.sys_core;
    const domainData = doc.domain_data;
    const promptConfig = this.storage.getConfig("prompt_config");

    // Path B: Intent routing → conditional vector search
    let routing = { requires_memory: false, search_query: query };
    let retrievedMemories = null;

    if (query) {
      routing = await this.intentAnalyzer.analyze(query);
      if (routing.requires_memory) {
        retrievedMemories = await this.memorySearch.searchAndRerank(
          userId,
          routing.search_query,
        );
      }
    }

    // Path A: Direct read from SQLite/Cache → build prompts
    const systemPrompt = buildSystemPrompt(
      sysCore,
      domainData,
      scene,
      promptConfig,
    );
    const contextPrompt = buildContextPrompt(
      sysCore,
      retrievedMemories,
      this.settings.config.read.top_k,
    );

    // Increment access count for dynamic TTL
    this.cache.incrementAccess(userId);

    return {
      routing,
      prompts: {
        system: systemPrompt,
        context: contextPrompt,
      },
    };
  }

  async searchMemory(
    userId: string,
    query: string,
    topK?: number,
  ): Promise<string> {
    const results = await this.memorySearch.searchAndRerank(userId, query, topK);
    return this.memorySearch.formatResults(results);
  }

  async archive(userId?: string): Promise<void> {
    const daysToKeep = this.settings.config.archive.days_to_keep;

    if (userId) {
      const result = await this.engine.archiveOldClusters(userId, daysToKeep);
      if (result.removedCount > 0) {
        console.log(
          `[MemoryService] archived ${result.removedCount} cluster(s) for user=${userId} ` +
          `into months: ${result.archivedMonths.join(', ')}`,
        );
      }
      return;
    }

    // Archive all users
    const users = this.storage.listUsers();
    let totalArchived = 0;
    for (const uid of users) {
      const result = await this.engine.archiveOldClusters(uid, daysToKeep);
      totalArchived += result.removedCount;
    }
    if (totalArchived > 0) {
      console.log(`[MemoryService] archived ${totalArchived} total cluster(s) across ${users.length} user(s).`);
    }
  }

  async reset(userId: string, mode: "full" | "memory" = "full"): Promise<void> {
    this.engine.resetUser(userId, mode);
  }

  close(): void {
    this.storage.close();
    this.vectorStore.close();
  }

  // ══════════════════════════════════════════════════════════════
  // Multimodal memory V1: local image assets + low-risk summaries.
  // ══════════════════════════════════════════════════════════════

  captureTurnAssets(input: CaptureTurnAssetsInput): Promise<CaptureTurnAssetsResult> {
    const mm = this.settings.config.multimodal;
    if (!mm?.enabled) {
      return Promise.resolve({ captured: [], skipped: [] });
    }
    return Promise.resolve(this.assetStore.captureTurnAssets(input));
  }

  storeGeneratedImageAsset(input: StoreGeneratedImageAssetInput): Promise<StoredGeneratedImageAsset> {
    return Promise.resolve(this.assetStore.storeGeneratedImageAsset(input));
  }

  async processMultimodalAssets(input: {
    userId: string;
    sessionId: string;
    turnIndex: number;
    userMessage: string;
    assistantMessage: string;
    assets: CaptureTurnAssetsResult["captured"];
  }): Promise<void> {
    const mm = this.settings.config.multimodal;
    if (!mm?.enabled || !mm.vision_extractor_model || input.assets.length === 0) return;

    const apiKey = mm.vision_extractor_api_key ?? this.settings.config.model.api_key;
    const baseURL = mm.vision_extractor_base_url ?? this.settings.config.model.base_url;
    if (!apiKey || !baseURL) return;

    const extractor = new MultimodalMemoryExtractor(
      new OpenAIMemoryClient({ apiKey, baseURL }),
      mm.vision_extractor_model,
    );
    const outputLanguage =
      normalizeUserLanguage(this.getUserProfileLanguage(input.userId)) ??
      detectUserLanguage(input.userMessage) ??
      "zh";

    for (const captured of input.assets) {
      try {
        const extracted = await extractor.extract({
          asset: captured.asset,
          userMessage: input.userMessage,
          assistantMessage: input.assistantMessage,
          outputLanguage,
        });
        if (!extracted) continue;
        this.assetStore.applyExtraction({
          userId: input.userId,
          assetId: captured.asset.asset_id,
          sessionId: input.sessionId,
          turnIndex: input.turnIndex,
          extraction: extracted,
        });
        await this.indexMultimodalExtraction({
          userId: input.userId,
          sessionId: input.sessionId,
          turnIndex: input.turnIndex,
          assetId: captured.asset.asset_id,
          extraction: extracted,
        });
      } catch (e) {
        console.warn("[MemoryService] processMultimodalAssets: extraction failed:", e);
      }
    }
  }

  async retryMultimodalAssetExtraction(input: {
    userId: string;
    assetId: string;
    sessionId: string;
    turnIndex: number;
    userMessage: string;
    assistantMessage: "";
    repairSource: "memory-hygiene";
  }): Promise<MultimodalAssetRetryResult> {
    const asset = this.assetStore.getAsset(input.userId, input.assetId);
    if (!asset || !existsSync(asset.file_path)) return { status: "failed", errorKind: "asset_not_found" };

    const mm = this.settings.config.multimodal;
    const apiKey = mm?.vision_extractor_api_key ?? this.settings.config.model.api_key;
    const baseURL = mm?.vision_extractor_base_url ?? this.settings.config.model.base_url;
    if (!mm?.enabled || !mm.vision_extractor_model || !apiKey || !baseURL) {
      return { status: "failed", errorKind: "extractor_not_configured" };
    }

    try {
      this.assetStore.recordHygieneRetryAudit({
        userId: input.userId,
        assetId: input.assetId,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        outcome: "started",
      });
    } catch {
      return { status: "failed", errorKind: "storage_failed" };
    }

    const extractor = new MultimodalMemoryExtractor(
      new OpenAIMemoryClient({ apiKey, baseURL }),
      mm.vision_extractor_model,
    );
    const outputLanguage =
      normalizeUserLanguage(this.getUserProfileLanguage(input.userId)) ??
      detectUserLanguage(input.userMessage) ??
      "zh";
    let extracted: MultimodalAssetExtraction | null;
    try {
      extracted = await extractor.extract({
        asset,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        outputLanguage,
      });
    } catch {
      this.recordHygieneRetryOutcome(input, "failed", "extractor_failed");
      return { status: "failed", errorKind: "extractor_failed" };
    }
    if (!extracted) {
      this.recordHygieneRetryOutcome(input, "failed", "extraction_rejected");
      return { status: "failed", errorKind: "extraction_rejected" };
    }

    try {
      this.assetStore.applyExtraction({
        userId: input.userId,
        assetId: input.assetId,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        extraction: extracted,
      });
      await this.indexMultimodalExtraction({
        userId: input.userId,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        assetId: input.assetId,
        extraction: extracted,
      });
      this.recordHygieneRetryOutcome(input, "updated");
      return { status: "updated" };
    } catch {
      this.recordHygieneRetryOutcome(input, "failed", "storage_failed");
      return { status: "failed", errorKind: "storage_failed" };
    }
  }

  private recordHygieneRetryOutcome(
    input: {
      userId: string;
      assetId: string;
      sessionId: string;
      turnIndex: number;
    },
    outcome: "updated" | "failed",
    errorKind?: MultimodalAssetRetryErrorKind,
  ): void {
    try {
      this.assetStore.recordHygieneRetryAudit({ ...input, outcome, errorKind });
    } catch {
      // The started audit already records the repair source. Outcome audit is
      // diagnostic and must not turn a preserved asset into a destructive path.
    }
  }

  listMemoryAssets(opts: { userId?: string; limit?: number; includeDeleted?: boolean } = {}): MemoryAsset[] {
    return this.assetStore.listAssets(opts);
  }

  getMemoryAsset(userId: string, assetId: string, opts: { includeDeleted?: boolean } = {}): MemoryAssetDetail | null {
    return this.assetStore.getAssetDetail(userId, assetId, opts);
  }

  deleteMemoryAsset(userId: string, assetId: string): boolean {
    const deleted = this.assetStore.deleteAsset(userId, assetId);
    if (!deleted) return false;
    for (const docType of ["image_summary", "image_ocr", "image_memory_cluster"]) {
      this.vectorStore.deleteByMetadataSubstring(userId, docType, `asset_id=${assetId}`);
    }
    this.cache.deleteProfile(userId);
    return true;
  }

  private async indexMultimodalExtraction(input: {
    userId: string;
    sessionId: string;
    turnIndex: number;
    assetId: string;
    extraction: MultimodalAssetExtraction;
  }): Promise<void> {
    const meta = metadataSourceForAsset(input.assetId, input.sessionId, input.turnIndex);
    const ts = Math.floor(Date.now() / 1000);

    const insertText = async (docType: string, text: string, docId: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      const emb = await this.embedder.embedText(trimmed.slice(0, 1000));
      this.vectorStore.insert(input.userId, docType, trimmed.slice(0, 4000), emb, meta, ts, docId);
    };

    try {
      await insertText("image_summary", input.extraction.summary, `image_summary_${input.assetId}`);
      if (input.extraction.visible_text) {
        await insertText("image_ocr", input.extraction.visible_text, `image_ocr_${input.assetId}`);
      }
      for (const cluster of input.extraction.memory_clusters ?? []) {
        const text = cluster.fact + (cluster.foresight ? ` | ${cluster.foresight}` : "");
        await insertText(
          "image_memory_cluster",
          text,
          memoryIdForImageCluster(input.userId, input.assetId, cluster.fact),
        );
      }
    } catch (e) {
      console.warn("[MemoryService] indexMultimodalExtraction: vector insert failed:", e);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Unified extraction surface (P2.1)
  //
  // Used by the unified router (Phase 2) and the search_history tool
  // (Phase 3 task 11). All methods are idempotent at row level —
  // duplicates are deduplicated by canonical key (field name / topic /
  // event string).
  // ══════════════════════════════════════════════════════════════

  getLLMClient(): MemoryLLMClient {
    return this.chatClient;
  }

  getUserProfileLanguage(userId: string): string | undefined {
    const doc = this.engine.getUserCached(userId);
    const language = doc?.sys_core.profile.basic_info.language;
    return typeof language === "string" ? language : undefined;
  }

  /** Append a memory cluster to user's digest + vector store. */
  async addMemoryCluster(userId: string, cluster: MemoryCluster): Promise<void> {
    const doc = this.engine.getUserCached(userId);
    if (!doc) return;

    const enriched = appendMemoryClusterToDigest(
      doc,
      cluster,
      this.settings.config.write.memory_clusters_limit,
    );

    this.storage.updateUserDoc(userId, doc);

    const text = enriched.fact + (enriched.foresight ? ` | ${enriched.foresight}` : "");
    const memoryId = memoryIdForTextCluster(userId, enriched);
    const metaSrc = metadataSourceForTextCluster(enriched);

    try {
      const entities = extractTextMemoryEntityCandidates(text);
      if (entities.length > 0) {
        this.assetStore.projectMemoryRelations({
          userId,
          memoryId,
          recordType: "text_memory_cluster",
          text,
          entities,
          source: TEXT_MEMORY_RELATION_EXTRACTOR_VERSION,
          extractorVersion: TEXT_MEMORY_RELATION_EXTRACTOR_VERSION,
          sessionId: enriched.provenance?.session_id,
          turnIndex: enriched.provenance?.turn_index,
        });
      }
    } catch (e) {
      console.warn("[MemoryService] addMemoryCluster: relation projection failed:", e);
    }

    // Embed for vector search.
    // [v4 P1-D] Encode provenance into `metadata_source` so deleteByProvenance
    // can locate and delete vector rows by session id via LIKE substring match.
    // Convention: "<source>:session_id=<sid>:turn=<n>" (e.g.
    // "unified-extraction-v1:session_id=abc:turn=7"). Legacy clusters with no
    // provenance keep `metadata_source=""`.
    try {
      const emb = await this.embedder.embedText(text);
      this.vectorStore.insert(
        userId,
        "memory_cluster",
        text.slice(0, 4000),
        emb,
        metaSrc,
        memoryTimestampSeconds(enriched.created_at),
        memoryId,
      );
    } catch (e) {
      console.warn("[MemoryService] addMemoryCluster: vector insert failed:", e);
    }

    // Rebuild cache so subsequent reads see the new cluster
    this.cache.deleteProfile(userId);
  }

  /**
   * Deep-merge profile sections into user's profile. [v4 P1-B]
   * Section-keyed updates from unified router; preserves untouched fields.
   */
  async updateProfile(
    userId: string,
    sections: ProfileUpdateSections,
  ): Promise<void> {
    let doc = this.engine.getUserCached(userId);
    if (!doc) {
      // Lazily create user doc so the router doesn't need to warm up first
      this.engine.warmupUser(userId);
      doc = this.engine.getUserCached(userId);
      if (!doc) return;
    }

    mergeProfileSections(doc, sections);
    this.storage.updateUserDoc(userId, doc);
    this.cache.deleteProfile(userId);
  }

  /**
   * Update relationship status using intimacy_score backing field. [v4 P1-C]
   * Score-driven; level is re-derived from score after each delta.
   */
  async updateRelationship(
    userId: string,
    partial: RelationshipUpdateInput,
  ): Promise<void> {
    let doc = this.engine.getUserCached(userId);
    if (!doc) {
      this.engine.warmupUser(userId);
      doc = this.engine.getUserCached(userId);
      if (!doc) return;
    }

    applyRelationshipUpdate(doc, partial);
    this.storage.updateUserDoc(userId, doc);
    this.cache.deleteProfile(userId);
  }

  async upsertActiveThread(
    userId: string,
    thread: ActiveThreadUpdateInput,
  ): Promise<void> {
    let doc = this.engine.getUserCached(userId);
    if (!doc) {
      this.engine.warmupUser(userId);
      doc = this.engine.getUserCached(userId);
      if (!doc) return;
    }
    upsertActiveThreadInDigest(doc, thread, this.settings.config.write.active_threads_limit);
    this.storage.updateUserDoc(userId, doc);
    this.cache.deleteProfile(userId);
  }

  async upsertFocus(
    userId: string,
    focus: FocusUpdateInput,
  ): Promise<void> {
    let doc = this.engine.getUserCached(userId);
    if (!doc) {
      this.engine.warmupUser(userId);
      doc = this.engine.getUserCached(userId);
      if (!doc) return;
    }
    upsertFocusInDigest(doc, focus, this.settings.config.write.current_focus_limit);
    this.storage.updateUserDoc(userId, doc);
    this.cache.deleteProfile(userId);
  }

  async searchClusters(
    userId: string,
    query: string,
    opts?: { limit?: number },
  ): Promise<MemoryCluster[]> {
    // Reuse existing memory search but restrict to memory_cluster doc type.
    try {
      const queryEmb = await this.embedder.embedText(query);
      const limit = opts?.limit ?? 10;
      const results = this.vectorStore.search(queryEmb, userId, limit, ["memory_cluster"]);
      // Re-hydrate as MemoryCluster shape from the user doc when possible
      const doc = this.engine.getUserCached(userId);
      const clusters = doc?.sys_core.digest.memory_clusters ?? [];
      const byId = new Map(clusters.map((c) => [memoryIdForTextCluster(userId, c), c] as const));
      const byFact = new Map(clusters.map((c) => [c.fact, c] as const));
      return results
        .map((r) => byId.get(r.id) ?? byFact.get(r.content) ?? {
          fact: r.content,
          importance_score: 0.5,
          created_at: String(r.metadata.timestamp ?? Math.floor(Date.now() / 1000)),
        })
        .slice(0, limit);
    } catch (e) {
      console.warn("[MemoryService] searchClusters failed:", e);
      return [];
    }
  }

  async deleteByProvenance(filter: ProvenanceDeleteFilter): Promise<number> {
    let totalDeleted = 0;
    const userIds = this.storage.listUsers();
    for (const userId of userIds) {
      const doc = this.engine.getUserCached(userId);
      if (!doc) continue;
      const deletedClusters: MemoryCluster[] = [];
      const before = doc.sys_core.digest.memory_clusters.length;
      doc.sys_core.digest.memory_clusters = doc.sys_core.digest.memory_clusters.filter((c) => {
        const shouldDelete = provenanceMatches(c.provenance, filter);
        if (shouldDelete) deletedClusters.push(c);
        return !shouldDelete;
      });
      const deletedNow = before - doc.sys_core.digest.memory_clusters.length;
      if (deletedNow > 0) {
        this.storage.updateUserDoc(userId, doc);
        this.cache.deleteProfile(userId);
        totalDeleted += deletedNow;
      }

      try {
        for (const cluster of deletedClusters) {
          this.vectorStore.deleteById(memoryIdForTextCluster(userId, cluster));
        }
        const fallbackSubstring = vectorMetadataSubstringForProvenanceFilter(filter);
        if (fallbackSubstring) {
          this.vectorStore.deleteByMetadataSubstring(
            userId,
            "memory_cluster",
            fallbackSubstring,
          );
        }
      } catch (e) {
        console.warn("[MemoryService] deleteByProvenance: vector delete failed:", e);
      }

      try {
        if (filter.sessionId !== undefined || filter.turnIndex !== undefined) {
          this.assetStore.tombstoneTextMemoryRelations({
            userId,
            sessionId: filter.sessionId,
            turnIndex: filter.turnIndex,
          });
        }
      } catch (e) {
        console.warn("[MemoryService] deleteByProvenance: relation projection delete failed:", e);
      }
    }
    return totalDeleted;
  }

}
