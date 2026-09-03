/**
 * avatanel Memory System — Type Definitions
 *
 * Canonical shapes for the SQLite-backed memory document, vector metadata,
 * read context, and memory service facade.
 */

import type { MemoryLLMClient } from "./llmClient";
import type { ProvenanceMeta } from "./provenance";

// ══════════════════════════════════════════════════════════════
// SQLite connection behavior
// ══════════════════════════════════════════════════════════════

/**
 * Busy timeout (ms) applied to every kernel SQLite connection at open time
 * (SQLiteStorage + VectorStore). busy_timeout is per-connection and does not
 * persist in the DB file, so it must be set on each open. Single source —
 * memware's pragma helper re-exports this value instead of defining its own.
 */
export const MEMORY_SQLITE_BUSY_TIMEOUT_MS = 5000;

// ══════════════════════════════════════════════════════════════
// Document type weights for vector search reranking
// ══════════════════════════════════════════════════════════════

export const DOC_TYPE_WEIGHTS: Record<string, number> = {
  memory_cluster: 1.0,
  image_memory_cluster: 0.95,
  image_summary: 0.85,
  image_ocr: 0.8,
  digest_index: 0.9,
  chat_log: 0.7,
  profile_fragment: 0.5,
};

// ══════════════════════════════════════════════════════════════
// User Profile Types
// ══════════════════════════════════════════════════════════════

export interface BasicInfo {
  nickname?: string;
  real_name?: string;
  age?: number;
  gender?: string;
  location?: string;
  occupation?: string;
  language?: string;
  birthday?: string;
  height?: string;
  weight?: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface WeightedItem {
  trait?: string;
  value?: string;
  weight: number;
}

export interface Psychographics {
  traits: WeightedItem[];
  core_values: WeightedItem[];
}

export interface Preferences {
  [key: string]: string[];
}

export interface SignificantMemory {
  event: string;
  importance: number;
  date: string;
}

export interface Profile {
  basic_info: BasicInfo;
  psychographics: Psychographics;
  preferences: Preferences;
  significant_memories: SignificantMemory[];
}

// ══════════════════════════════════════════════════════════════
// Digest Types
// ══════════════════════════════════════════════════════════════

export interface RelationshipStatus {
  intimacy_level: IntimacyLevel;
  /**
   * [v4 P1-C] Numeric backing for intimacy_level (0–1).
   * Optional for backward compat with rows written before unified extraction.
   * When absent, derive from intimacy_level: stranger→0.1, acquaintance→0.25,
   * friend→0.5, close→0.7, intimate→0.9.
   */
  intimacy_score?: number;
  current_vibe: string;
  last_interaction: string;
  interaction_count: number;
}

export type IntimacyLevel =
  | "Stranger"
  | "Acquaintance"
  | "Friend"
  | "Close Friend"
  | "Confidant";

export const INTIMACY_LEVELS: IntimacyLevel[] = [
  "Stranger",
  "Acquaintance",
  "Friend",
  "Close Friend",
  "Confidant",
];

export interface ActiveThread {
  topic: string;
  status: string;
  next_step?: string;
}

export interface MemoryCluster {
  fact: string;
  foresight?: string;
  date?: string;
  importance_score: number;
  created_at: string;
  /** Optional provenance trail. Set by unified extractor; legacy writes leave undefined. */
  provenance?: ProvenanceMeta;
}

export interface MemoryRuntimeStatus {
  kind: "persistent" | "noop";
  persistent: boolean;
  reason?: string;
}

export interface LongTermIndex {
  month: string;
  summary: string;
  archived_at: string;
  cluster_count: number;
}

export interface FocusItem {
  /** [PR3a] Canonical identity — populated from topic_quote (verbatim substring). */
  topic: string;
  priority: number;
  /**
   * [PR3a] Optional free-form display label (from topic_label). Rendered in digest
   * when present, falls back to `topic`. Storage-only — never used for identity.
   */
  display_topic?: string;
}

export interface Digest {
  relationship_status: RelationshipStatus;
  current_focus: FocusItem[];
  active_threads: ActiveThread[];
  memory_clusters: MemoryCluster[];
  long_term_index: LongTermIndex[];
}

// ══════════════════════════════════════════════════════════════
// Top-level User Document
// ══════════════════════════════════════════════════════════════

export interface SysCore {
  profile: Profile;
  digest: Digest;
}

export interface UserMeta {
  is_warmed_up: boolean;
}

export interface UserDocument {
  sys_core: SysCore;
  domain_data: Record<string, unknown>;
  meta: UserMeta;
}

/** Default skeleton for new users */
export function createUserSkeleton(): UserDocument {
  return {
    sys_core: {
      profile: {
        basic_info: {},
        psychographics: { traits: [], core_values: [] },
        preferences: {},
        significant_memories: [],
      },
      digest: {
        relationship_status: {
          intimacy_level: "Friend",
          current_vibe: "Neutral",
          last_interaction: "",
          interaction_count: 0,
        },
        current_focus: [],
        active_threads: [],
        memory_clusters: [],
        long_term_index: [],
      },
    },
    domain_data: {},
    meta: { is_warmed_up: true },
  };
}

// ══════════════════════════════════════════════════════════════
// Vector Store Types
// ══════════════════════════════════════════════════════════════

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: VectorMetadata;
}

export interface VectorMetadata {
  user_id: string;
  doc_type: string;
  metadata_source?: string;
  timestamp: number;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  distance: number;
  metadata: VectorMetadata;
}

export interface RankedResult extends VectorSearchResult {
  score: number;
}

// ══════════════════════════════════════════════════════════════
// Intent Analyzer Types
// ══════════════════════════════════════════════════════════════

export interface IntentAnalysis {
  requires_memory: boolean;
  search_query: string;
}

// ══════════════════════════════════════════════════════════════
// Memory Context (returned to caller for prompt injection)
// ══════════════════════════════════════════════════════════════

export interface MemoryContext {
  routing: IntentAnalysis;
  prompts: {
    system: string;
    context: string;
  };
}

// ══════════════════════════════════════════════════════════════
// Service Interface (unified facade)
// ══════════════════════════════════════════════════════════════

export interface IMemoryService {
  init(): Promise<void>;
  warmup(userId: string, initialData?: Record<string, unknown>): Promise<void>;
  getContext(
    userId: string,
    query: string,
    scene?: string,
  ): Promise<MemoryContext>;
  searchMemory(userId: string, query: string, topK?: number): Promise<string>;
  archive(userId?: string): Promise<void>;
  reset(userId: string, mode?: "full" | "memory"): Promise<void>;
  close(): void;

  // ── Unified extraction surface (P2.1, used by router in Phase 2) ──

  /** Get the underlying LLM client so other extractors can reuse the same connection. */
  getLLMClient(): MemoryLLMClient;

  /** Runtime capability status for diagnostics and prompt honesty. */
  getRuntimeStatus?(): MemoryRuntimeStatus;

  /** Optional profile read used by language-aware extractors. */
  getUserProfileLanguage?(userId: string): string | undefined;

  /** Append a memory cluster to user's digest. Provenance attached if present on cluster. */
  addMemoryCluster(userId: string, cluster: MemoryCluster): Promise<void>;

  /**
   * Merge profile section updates into user's profile. [v4 P1-B]
   *
   * The router passes section-keyed objects matching schema shape:
   *   { basic_info?: ProfileField[], preferences?: ProfileField[], significant_memories?: ... }
   * MemoryService must deep-merge each section into sys_core.profile, deduplicating
   * by field name (basic_info / preferences) or event string (significant_memories).
   * Do NOT replace whole arrays — additive merge only.
   *
   * `_provenance` key (if present) is stripped before storage.
   */
  updateProfile(
    userId: string,
    sections: {
      // [PR2] value_quote = verbatim substring of evidence (hard-gated);
      //       value_label = free-form normalized display value (ungated); stored via label ?? quote
      basic_info?: Array<{ field: string; value_quote: string; value_label?: unknown; evidence: string }>;
      preferences?: Array<{ field: string; value_quote: string; value_label?: unknown; evidence: string }>;
      significant_memories?: Array<{ event: string; importance: number; date: string; evidence: string }>;
      _provenance?: unknown;
    },
  ): Promise<void>;

  /**
   * Merge a relationship update into digest.relationship_status. [v4 P1-C]
   *
   * `intimacy_delta` is applied to a numeric `intimacy_score` backing field (0–1).
   * `intimacy_level` (enum) is re-derived from score after each delta:
   *   score < 0.15 → 'stranger', < 0.35 → 'acquaintance', < 0.60 → 'friend',
   *   < 0.80 → 'close', else → 'intimate'.
   *
   * Backward compat: if stored row has no `intimacy_score`, derive initial score
   * from existing `intimacy_level`: stranger→0.1, acquaintance→0.25, friend→0.5,
   * close→0.7, intimate→0.9. Then apply delta.
   *
   * `current_vibe_label ?? current_vibe_quote` overwrites the stored `current_vibe`.
   * `_provenance` key is stripped before storage.
   */
  updateRelationship(
    userId: string,
    partial: {
      intimacy_delta?: number;
      // [PR2] current_vibe_quote = verbatim substring of userMessage (hard-gated);
      //       current_vibe_label = free-form normalized mood label (ungated); stored via label ?? quote
      current_vibe_quote?: string;
      current_vibe_label?: string;
      _provenance?: unknown;
    },
  ): Promise<void>;

  /** Upsert an active thread by topic (stored via topic_label ?? topic_quote). */
  upsertActiveThread(
    userId: string,
    thread: {
      // [PR2] topic_quote = verbatim substring of userMessage (hard-gated);
      //       topic_label = free-form semantic label (ungated); stored via label ?? quote
      topic_quote: string;
      topic_label?: string;
      status: string;
      next_step?: string;
    },
  ): Promise<void>;

  /**
   * [PR3a] Upsert a focus item using canonical quote as identity.
   *   - topic_quote: verbatim substring of userMessage; stored as canonical topic.
   *   - topic_label: optional free-form label; stored as display_topic when present.
   *   - priority: 0-10 urgency score.
   */
  upsertFocus(userId: string, focus: { topic_quote: string; topic_label?: string; priority: number }): Promise<void>;

  /** Vector-search memory clusters for a user. Used by search_history tool (Task 11). */
  searchClusters(userId: string, query: string, opts?: { limit?: number }): Promise<MemoryCluster[]>;

  /** Delete text memory clusters whose provenance matches the filter. Returns count deleted from JSON clusters. */
  deleteByProvenance(filter: {
    sessionId?: string;
    turnIndex?: number;
    minConfidence?: number;
    source?: string;
  }): Promise<number>;
}

// ══════════════════════════════════════════════════════════════
// Config Types
// ══════════════════════════════════════════════════════════════

export interface MemoryConfig {
  model: ModelConfig;
  storage: StorageConfig;
  read: ReadConfig;
  write: WriteConfig;
  archive: ArchiveConfig;
  cache: CacheConfig;
  multimodal?: MultimodalConfig;
}

export interface ModelConfig {
  api_key: string;
  base_url: string;
  model_name: string;
  embedding_model: string;
  embedding_dim: number;
  embedding_base_url?: string;
  embedding_api_key?: string;
  /**
   * Budget (ms) for the per-turn intent-routing call. When it elapses the
   * turn proceeds without long-term memory retrieval. Default lives in
   * `intentAnalyzer.ts` (`DEFAULT_INTENT_TIMEOUT_MS`).
   */
  intent_timeout_ms?: number;
}

export interface StorageConfig {
  sqlite_path: string;
  vector_db_path: string;
}

export interface ReadConfig {
  vector_search_multiplier: number;
  rerank_weights: {
    relevance: number;
    recency: number;
    type_weight: number;
  };
  min_similarity: number;
  rerank_threshold: number;
  top_k: number;
}

export interface WriteConfig {
  memory_clusters_limit: number;
  importance_decay_rate: number;
  semantic_dedup_threshold: number;
  active_threads_limit: number;
  current_focus_limit: number;
  significant_memories_limit: number;
}

export interface ArchiveConfig {
  days_to_keep: number;
  cron_schedule?: string;
}

export interface CacheConfig {
  profile_ttl: number;
  embedding_ttl: number;
  high_frequency_threshold: number;
  high_frequency_ttl: number;
}

export interface MultimodalConfig {
  enabled: boolean;
  max_image_bytes: number;
  max_images_per_turn: number;
  vision_extractor_model?: string;
  vision_extractor_base_url?: string;
  vision_extractor_api_key?: string;
}
