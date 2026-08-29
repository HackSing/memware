/**
 * avatanel Memory System — Embedding Service
 *
 * Uses OpenAI-compatible API for embeddings with in-memory hash cache.
 */

import type { MemoryLLMClient } from "./llmClient";
import type { MemoryCache } from "./cache";
import type { ModelConfig } from "./types";
import { shaHex } from "./ids";

export class Embedder {
  private llm: MemoryLLMClient;
  private model: string;
  private cache: MemoryCache;

  constructor(config: ModelConfig, cache: MemoryCache, llm: MemoryLLMClient) {
    this.cache = cache;
    this.model = config.embedding_model;
    this.llm = llm;
  }

  private hashText(text: string): string {
    return shaHex(text).slice(0, 32);
  }

  async embedText(text: string): Promise<number[]> {
    const textHash = this.hashText(text);
    const cached = this.cache.getEmbedding(textHash);
    if (cached) return cached;

    const response = await this.llm.embed({
      model: this.model,
      input: text,
    });

    const vector = response.embeddings[0];
    this.cache.setEmbedding(textHash, vector);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (let i = 0; i < texts.length; i++) {
      const textHash = this.hashText(texts[i]);
      const cached = this.cache.getEmbedding(textHash);
      if (cached) {
        results[i] = cached;
      } else {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const response = await this.llm.embed({
        model: this.model,
        input: uncachedTexts,
      });

      for (let j = 0; j < response.embeddings.length; j++) {
        const idx = uncachedIndices[j];
        const vector = response.embeddings[j];
        results[idx] = vector;
        const textHash = this.hashText(uncachedTexts[j]);
        this.cache.setEmbedding(textHash, vector);
      }
    }

    return results as number[][];
  }
}
