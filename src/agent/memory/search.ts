/**
 * avatanel Memory System — Search & Rerank
 *
 * Vector search with a semantic quality gate plus weighted reranking.
 */

import type { Embedder } from "./embedder";
import type { VectorStore } from "./vectorStore";
import type { ReadConfig, RankedResult, VectorSearchResult } from "./types";
import { DOC_TYPE_WEIGHTS } from "./types";

const OPERATIONAL_QUERY_RE =
  /技能|skill|tool|工具|命令|command|bash|grep|glob|file|文件|路径|path|目录|directory|配置|config|代码|code|repo|仓库|prompt|人设|persona|system prompt|系统提示|memory context|session|数据库|db/i;

function isOperationalQuery(query: string): boolean {
  return OPERATIONAL_QUERY_RE.test(query);
}

function normalizedCandidateContent(content: string): string {
  return content.toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "");
}

function isLikelyOperationalNoise(content: string): boolean {
  if (content.includes("[Memory Context]")) return true;
  if (content.includes("BBC News - Breaking news")) return true;
  if (content.includes("## 完整技能列表")) return true;
  if (content.includes("## 我的技能清单")) return true;
  if (content.includes("### 一、内置工具")) return true;
  if (content.includes("102 个技能")) return true;
  if (content.includes("social-writer") || content.includes("seo-content-writer")) return true;

  const pathHits = content.match(/(?:^|[\s"`])(src\/|docs\/|tests\/|refs\/|examples\/|apps\/)/gm)?.length ?? 0;
  if (pathHits >= 5) return true;

  const fileHits = content.match(/\.(md|ts|js|json|yaml|yml|py)\b/g)?.length ?? 0;
  if (fileHits >= 10) return true;

  const tableMarkers = content.match(/\|/g)?.length ?? 0;
  if (tableMarkers >= 20 && content.includes("技能")) return true;

  return false;
}

export function shouldSuppressChatLogCandidate(query: string, candidate: VectorSearchResult): boolean {
  return candidate.metadata.doc_type === "chat_log" &&
    !isOperationalQuery(query) &&
    isLikelyOperationalNoise(candidate.content);
}

// ── Rerank scoring (pure, shared) ─────────────────────────────
//
// The weighted score below is the only part of reranking that is free of the
// local store's shape (content dedup, VectorSearchResult), so it is the part
// the stateless kernel service (src/kernel/search.ts) reuses. Keeping it here
// means a weight or decay change lands in both rankers at once.

/** Type weight applied to candidates whose doc_type is not in DOC_TYPE_WEIGHTS. */
export const UNKNOWN_DOC_TYPE_WEIGHT = 0.5;
/** Exponential recency decay per day of age. */
export const RECENCY_DECAY_PER_DAY = 0.02;
/** Age assumed for candidates that carry no usable timestamp. */
export const UNKNOWN_AGE_DAYS = 365;

/** Ranking inputs of one candidate, independent of where it is stored. */
export interface RerankSignals {
  /** Cosine similarity in [0, 1]. */
  similarity: number;
  /** Unix seconds the candidate was created; omit/0 when unknown. */
  timestampSec?: number;
  /** doc_type used for the type weight; unknown types fall back to the constant. */
  docType?: string;
}

/** Weights and reference point for {@link rerankScore}. */
export interface RerankScoreConfig {
  weights: ReadConfig["rerank_weights"];
  /** Similarity floor used to normalise relevance (callers filter separately). */
  minSimilarity: number;
  /** Unix seconds treated as "now" — injected so scoring stays pure. */
  nowSec: number;
}

/** Weighted rerank score: relevance + recency + doc-type weight. */
export function rerankScore(signals: RerankSignals, cfg: RerankScoreConfig): number {
  const { minSimilarity, weights } = cfg;
  const relevance =
    minSimilarity < 1 ? (signals.similarity - minSimilarity) / (1.0 - minSimilarity) : 1.0;

  const ts = signals.timestampSec || 0;
  const daysOld = ts ? Math.max((cfg.nowSec - ts) / 86400, 0) : UNKNOWN_AGE_DAYS;
  const recency = 1.0 / (1.0 + daysOld * RECENCY_DECAY_PER_DAY);

  const typeWeight =
    (signals.docType !== undefined ? DOC_TYPE_WEIGHTS[signals.docType] : undefined) ??
    UNKNOWN_DOC_TYPE_WEIGHT;

  return weights.relevance * relevance + weights.recency * recency + weights.type_weight * typeWeight;
}

export class MemorySearch {
  constructor(
    private vectorStore: VectorStore,
    private embedder: Embedder,
    private readConfig: ReadConfig,
  ) {}

  async searchAndRerank(
    userId: string,
    query: string,
    limit?: number,
  ): Promise<RankedResult[]> {
    const cfg = this.readConfig;
    const topK = limit ?? cfg.top_k;
    const multiplier = cfg.vector_search_multiplier;

    const queryEmbedding = await this.embedder.embedText(query);
    const candidates = this.vectorStore.search(
      queryEmbedding,
      userId,
      topK * multiplier,
      [
        "memory_cluster",
        "image_memory_cluster",
        "image_summary",
        "image_ocr",
        "digest_index",
        "chat_log",
        "profile_fragment",
      ],
    );

    const filtered = candidates.filter((c) => !shouldSuppressChatLogCandidate(query, c));
    if (filtered.length === 0) return [];

    return this.rerank(filtered, topK, cfg);
  }

  private rerank(
    candidates: VectorSearchResult[],
    limit: number,
    cfg: ReadConfig,
  ): RankedResult[] {
    const threshold = cfg.rerank_threshold;
    const minSimilarity = cfg.min_similarity;
    const scoreConfig: RerankScoreConfig = {
      weights: cfg.rerank_weights,
      minSimilarity,
      nowSec: Date.now() / 1000,
    };

    const bestByContent = new Map<string, RankedResult>();

    for (const c of candidates) {
      const similarity = 1.0 - c.distance;
      if (similarity < minSimilarity) continue;

      const score = rerankScore(
        { similarity, timestampSec: c.metadata.timestamp, docType: c.metadata.doc_type },
        scoreConfig,
      );

      if (score >= threshold) {
        const ranked = { ...c, score };
        const contentKey = normalizedCandidateContent(c.content);
        const existing = bestByContent.get(contentKey);
        if (
          !existing ||
          existing.score < ranked.score ||
          (existing.score === ranked.score && existing.metadata.timestamp < ranked.metadata.timestamp)
        ) {
          bestByContent.set(contentKey, ranked);
        }
      }
    }

    const scored = [...bestByContent.values()];
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  formatResults(results: RankedResult[]): string {
    if (results.length === 0) return "No relevant memories found.";

    const lines = ["Retrieved relevant memories:"];
    for (const r of results) {
      const docType = r.metadata.doc_type;
      const ts = r.metadata.timestamp;
      let dateStr = "";
      if (ts) {
        try {
          dateStr = new Date(ts * 1000).toISOString().split("T")[0];
        } catch {
          // ignore
        }
      }
      const prefix = dateStr ? `[${dateStr}] (${docType})` : `(${docType})`;
      lines.push(`- ${prefix} ${r.content}`);
    }
    return lines.join("\n");
  }
}
