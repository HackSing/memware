/**
 * memware kernel — POST /search.
 *
 * Pure ranking over caller-supplied candidate vectors: the kernel stores
 * nothing, so the backend passes both the query and the candidate set. The
 * similarity function and the weighted score are the same ones the local vector
 * store uses (vectorMath.cosineSimilarity, search.rerankScore), so a tuning
 * change lands in both rankers at once.
 */

import { DEFAULT_CONFIG } from "../agent/memory/config";
import { rerankScore, type RerankScoreConfig } from "../agent/memory/search";
import { cosineSimilarity } from "../agent/memory/vectorMath";
import { z } from "zod";
import { PayloadTooLargeError, type EmbedService } from "./embed";
import { UpstreamFailedError } from "./extract";

/** A candidate vector's dimension differs from the query's → HTTP 422. */
export class DimensionMismatchError extends Error {
  constructor(expected: number, actual: number, candidateId: string) {
    super(`candidate "${candidateId}" has dimension ${actual}, expected ${expected}`);
    this.name = "DimensionMismatchError";
  }
}

/** Defaults mirror the local read config so both rankers cut at the same place. */
export const KERNEL_DEFAULT_TOP_K = DEFAULT_CONFIG.read.top_k;
export const KERNEL_DEFAULT_MIN_SIMILARITY = DEFAULT_CONFIG.read.min_similarity;

export interface SearchCandidate {
  id: string;
  vector: number[];
  /** Milliseconds epoch (N1 timestamps); drives the recency term. */
  createdAt?: number;
  /** Document type; drives the type weight (unknown types share one weight). */
  docType?: string;
}

export interface SearchResult {
  id: string;
  similarity: number;
  score: number;
}

export interface RankOptions {
  topK?: number;
  minSimilarity?: number;
  /** Reference "now" in milliseconds; injected so ranking stays pure. */
  nowMs?: number;
}

const CandidateSchema = z.object({
  id: z.string().min(1),
  vector: z.array(z.number()).min(1),
  createdAt: z.number().optional(),
  docType: z.string().optional(),
});

export const SearchRequestSchema = z.object({
  query: z.union([
    z.object({ vector: z.array(z.number()).min(1) }),
    z.object({ text: z.string().min(1) }),
  ]),
  candidates: z.array(CandidateSchema),
  topK: z.number().int().positive().optional(),
  minSimilarity: z.number().min(-1).max(1).optional(),
});

export type SearchRequest = z.infer<typeof SearchRequestSchema>;

/**
 * Rank candidates against a query vector.
 *
 * @throws {DimensionMismatchError} when a candidate's dimension differs from
 *   the query's — mixing embedding models silently would make every score
 *   meaningless, so it fails loudly instead.
 */
export function rankCandidates(
  queryVector: number[],
  candidates: SearchCandidate[],
  options: RankOptions = {},
): SearchResult[] {
  const minSimilarity = options.minSimilarity ?? KERNEL_DEFAULT_MIN_SIMILARITY;
  const topK = options.topK ?? KERNEL_DEFAULT_TOP_K;
  const scoreConfig: RerankScoreConfig = {
    weights: DEFAULT_CONFIG.read.rerank_weights,
    minSimilarity,
    nowSec: (options.nowMs ?? Date.now()) / 1000,
  };

  const ranked: SearchResult[] = [];
  for (const candidate of candidates) {
    if (candidate.vector.length !== queryVector.length) {
      throw new DimensionMismatchError(queryVector.length, candidate.vector.length, candidate.id);
    }
    const similarity = cosineSimilarity(queryVector, candidate.vector);
    if (similarity < minSimilarity) continue;
    const score = rerankScore(
      {
        similarity,
        ...(candidate.createdAt !== undefined ? { timestampSec: candidate.createdAt / 1000 } : {}),
        ...(candidate.docType !== undefined ? { docType: candidate.docType } : {}),
      },
      scoreConfig,
    );
    ranked.push({ id: candidate.id, similarity, score });
  }

  ranked.sort((a, b) => b.score - a.score || b.similarity - a.similarity);
  return ranked.slice(0, topK);
}

export interface SearchService {
  search(request: SearchRequest): Promise<{ results: SearchResult[] }>;
}

export interface SearchServiceDeps {
  embed: EmbedService;
  /** Candidate-set ceiling; ranking is O(candidates x dim) and must stay bounded. */
  maxCandidates: number;
}

/** Search service; `{ text }` queries are embedded with the same model as /embed. */
export function createSearchService(deps: SearchServiceDeps): SearchService {
  return {
    async search(request: SearchRequest): Promise<{ results: SearchResult[] }> {
      if (request.candidates.length > deps.maxCandidates) {
        throw new PayloadTooLargeError("candidates", request.candidates.length, deps.maxCandidates);
      }

      let queryVector: number[];
      if ("vector" in request.query) {
        queryVector = request.query.vector;
      } else {
        const embedded = await deps.embed.embed([request.query.text]);
        const vector = embedded.vectors[0];
        if (vector === undefined || vector.length === 0) {
          throw new UpstreamFailedError("embed", "no vector returned for the query text");
        }
        queryVector = vector;
      }

      return {
        results: rankCandidates(queryVector, request.candidates, {
          ...(request.topK !== undefined ? { topK: request.topK } : {}),
          ...(request.minSimilarity !== undefined ? { minSimilarity: request.minSimilarity } : {}),
        }),
      };
    },
  };
}
