/**
 * memware kernel — POST /embed.
 *
 * Thin stateless wrapper over the memory kernel's {@link Embedder}: same
 * batching and same in-process hash cache, no storage. The cache is per
 * process and keyed by text hash, so it is safe under concurrent requests and
 * disappears with the container.
 */

import { MemoryCache } from "../agent/memory/cache";
import { DEFAULT_CONFIG } from "../agent/memory/config";
import { Embedder } from "../agent/memory/embedder";
import type { MemoryLLMClient } from "../agent/memory/llmClient";
import { z } from "zod";
import { callUpstream } from "./extract";

/**
 * A request collection exceeds its configured ceiling → HTTP 413.
 * Shared by POST /embed (texts) and POST /search (candidates).
 */
export class PayloadTooLargeError extends Error {
  constructor(field: string, count: number, max: number) {
    super(`${field}: ${count} exceeds the per-request maximum of ${max}`);
    this.name = "PayloadTooLargeError";
  }
}

export const EmbedRequestSchema = z.object({
  texts: z.array(z.string()),
});

export type EmbedRequest = z.infer<typeof EmbedRequestSchema>;

export interface EmbedResult {
  model: string;
  dim: number;
  vectors: number[][];
}

export interface EmbedService {
  embed(texts: string[]): Promise<EmbedResult>;
}

export interface EmbedServiceDeps {
  llm: MemoryLLMClient;
  model: string;
  /** Declared dimension (MEMWARE_EMBEDDING_DIM); derived from output when unset. */
  dim?: number;
  maxTexts: number;
  timeoutMs: number;
}

export function createEmbedService(deps: EmbedServiceDeps): EmbedService {
  // Only `embedding_model` is read by Embedder; the rest of the config object
  // is inert here (no key is taken from it — the client already holds one).
  const embedder = new Embedder(
    { ...DEFAULT_CONFIG.model, api_key: "", embedding_model: deps.model },
    new MemoryCache(),
    deps.llm,
  );

  return {
    async embed(texts: string[]): Promise<EmbedResult> {
      if (texts.length > deps.maxTexts) {
        throw new PayloadTooLargeError("texts", texts.length, deps.maxTexts);
      }
      if (texts.length === 0) {
        return { model: deps.model, dim: deps.dim ?? 0, vectors: [] };
      }
      const vectors = await callUpstream("embed", deps.timeoutMs, () => embedder.embedBatch(texts));
      return {
        model: deps.model,
        dim: deps.dim ?? vectors[0]?.length ?? 0,
        vectors,
      };
    },
  };
}
