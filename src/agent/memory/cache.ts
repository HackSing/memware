/**
 * avatanel Memory System — In-Memory TTL Cache
 *
 * Three cache domains: profile (per-entry TTL), embedding (fixed TTL), access counter.
 */

import type { UserDocument } from "./types";

interface CacheEntry<T> {
  data: T;
  expireAt: number; // performance.now() milliseconds
}

export class MemoryCache {
  private profileTtl: number;
  private highFreqThreshold: number;
  private highFreqTtl: number;
  private embeddingTtl: number;

  private profiles = new Map<string, CacheEntry<UserDocument>>();
  private embeddings = new Map<string, CacheEntry<number[]>>();
  private accessCounts = new Map<string, CacheEntry<number>>();

  private readonly maxEmbeddings = 65536;
  private readonly accessCountTtl: number;

  constructor(options?: {
    profileTtl?: number;
    embeddingTtl?: number;
    accessCountTtl?: number;
    highFrequencyThreshold?: number;
    highFrequencyTtl?: number;
  }) {
    this.profileTtl = (options?.profileTtl ?? 900) * 1000;
    this.embeddingTtl = (options?.embeddingTtl ?? 86400) * 1000;
    this.accessCountTtl = (options?.accessCountTtl ?? 3600) * 1000;
    this.highFreqThreshold = options?.highFrequencyThreshold ?? 10;
    this.highFreqTtl = (options?.highFrequencyTtl ?? 1800) * 1000;
  }

  // ── Profile cache (per-entry TTL) ─────────────────────────

  getProfile(userId: string): UserDocument | null {
    const entry = this.profiles.get(userId);
    if (!entry) return null;
    if (performance.now() > entry.expireAt) {
      this.profiles.delete(userId);
      return null;
    }
    return entry.data;
  }

  setProfile(userId: string, data: UserDocument, ttlMs?: number): void {
    const effectiveTtl = ttlMs ?? this.profileTtl;
    this.profiles.set(userId, {
      data,
      expireAt: performance.now() + effectiveTtl,
    });
  }

  deleteProfile(userId: string): void {
    this.profiles.delete(userId);
  }

  // ── Embedding cache (fixed TTL with size cap) ─────────────

  getEmbedding(textHash: string): number[] | null {
    const entry = this.embeddings.get(textHash);
    if (!entry) return null;
    if (performance.now() > entry.expireAt) {
      this.embeddings.delete(textHash);
      return null;
    }
    return entry.data;
  }

  setEmbedding(textHash: string, vector: number[]): void {
    // Evict oldest if at capacity
    if (this.embeddings.size >= this.maxEmbeddings) {
      const firstKey = this.embeddings.keys().next().value;
      if (firstKey !== undefined) this.embeddings.delete(firstKey);
    }
    this.embeddings.set(textHash, {
      data: vector,
      expireAt: performance.now() + this.embeddingTtl,
    });
  }

  // ── Access counter (for dynamic TTL) ──────────────────────

  incrementAccess(userId: string): number {
    const entry = this.accessCounts.get(userId);
    const now = performance.now();
    if (entry && now <= entry.expireAt) {
      const newCount = entry.data + 1;
      entry.data = newCount;
      return newCount;
    }
    this.accessCounts.set(userId, {
      data: 1,
      expireAt: now + this.accessCountTtl,
    });
    return 1;
  }

  getDynamicTtl(userId: string): number {
    const entry = this.accessCounts.get(userId);
    const count = entry && performance.now() <= entry.expireAt ? entry.data : 0;
    return count >= this.highFreqThreshold ? this.highFreqTtl : this.profileTtl;
  }

  // ── Utility ───────────────────────────────────────────────

  clearAll(): void {
    this.profiles.clear();
    this.embeddings.clear();
    this.accessCounts.clear();
  }

  stats(): { profiles: number; embeddings: number; accessCounts: number } {
    const now = performance.now();
    let activeProfiles = 0;
    for (const [, entry] of this.profiles) {
      if (entry.expireAt > now) activeProfiles++;
    }
    return {
      profiles: activeProfiles,
      embeddings: this.embeddings.size,
      accessCounts: this.accessCounts.size,
    };
  }
}
