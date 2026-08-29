/**
 * avatanel Memory System — User document lifecycle helpers
 *
 * Owns warmup/reset/archive/cache behavior for the SQLite-backed memory doc.
 * Live turn writes are handled by the unified extractor/router through
 * MemoryService sink methods.
 */

import type { SQLiteStorage } from "./storage";
import type { VectorStore } from "./vectorStore";
import type { MemoryCache } from "./cache";
import type { Embedder } from "./embedder";
import type { UserDocument } from "./types";
import { createUserSkeleton } from "./types";
import { memoryMonth, memoryTimestampSeconds, parseMemoryTimestampMs } from "./time";

export class MemoryEngine {
  constructor(
    private storage: SQLiteStorage,
    private vectorStore: VectorStore,
    private cache: MemoryCache,
    private embedder: Embedder,
  ) {}

  // ══════════════════════════════════════════════════════════
  // Public: Warmup user
  // ══════════════════════════════════════════════════════════

  warmupUser(
    userId: string,
    initialBizData?: Record<string, unknown>,
  ): { status: string; userId: string } {
    const exists = this.storage.userExists(userId);
    if (exists) {
      this.getUserCached(userId);
      return { status: "cached", userId };
    }

    const doc = createUserSkeleton();
    const now = new Date().toISOString();
    doc.sys_core.profile.basic_info.created_at = now;

    if (initialBizData) {
      const profileFields = new Set([
        "nickname", "real_name", "age", "gender", "location",
        "occupation", "language", "birthday", "height", "weight",
      ]);
      for (const [key, val] of Object.entries(initialBizData)) {
        if (profileFields.has(key)) {
          (doc.sys_core.profile.basic_info as Record<string, unknown>)[key] = val;
        } else {
          doc.domain_data[key] = val;
        }
      }
    }

    this.storage.setUser(userId, doc);
    this.cache.setProfile(userId, doc);
    return { status: "created", userId };
  }

  // ══════════════════════════════════════════════════════════
  // Public: Reset user
  // ══════════════════════════════════════════════════════════

  resetUser(userId: string, mode: "full" | "memory" = "full"): void {
    if (mode === "memory") {
      const doc = this.storage.getUser(userId);
      if (doc) {
        const skeleton = createUserSkeleton();
        doc.sys_core.digest = skeleton.sys_core.digest;
        this.storage.updateUserDoc(userId, doc);
        this.vectorStore.deleteByUser(userId);
      }
    } else {
      this.storage.deleteUser(userId);
      this.vectorStore.deleteByUser(userId);
    }
    this.cache.deleteProfile(userId);
  }

  // ══════════════════════════════════════════════════════════
  // Public: Archive old memory clusters into long_term_index
  // ══════════════════════════════════════════════════════════

  async archiveOldClusters(userId: string, daysToKeep: number): Promise<{ archivedMonths: string[]; removedCount: number }> {
    const doc = this.getUserCached(userId);
    if (!doc) return { archivedMonths: [], removedCount: 0 };

    const clusters = doc.sys_core.digest.memory_clusters;
    if (clusters.length === 0) return { archivedMonths: [], removedCount: 0 };

    const cutoffMs = Date.now() - daysToKeep * 86400 * 1000;

    // Partition: old (to archive) vs recent (to keep)
    const toArchive: typeof clusters = [];
    const toKeep: typeof clusters = [];

    for (const c of clusters) {
      const createdAt = parseMemoryTimestampMs(c.created_at);
      if (createdAt !== null && createdAt < cutoffMs) {
        toArchive.push(c);
      } else {
        toKeep.push(c);
      }
    }

    if (toArchive.length === 0) return { archivedMonths: [], removedCount: 0 };

    // Group by month (YYYY-MM)
    const byMonth = new Map<string, typeof clusters>();
    for (const c of toArchive) {
      const month = memoryMonth(c);
      const group = byMonth.get(month) ?? [];
      group.push(c);
      byMonth.set(month, group);
    }

    // Create long_term_index entries
    const ltIndex = doc.sys_core.digest.long_term_index;
    const archivedMonths: string[] = [];

    for (const [month, monthClusters] of byMonth) {
      // Summarize: take top facts by importance
      const sorted = [...monthClusters].sort(
        (a, b) => (b.importance_score ?? 5) - (a.importance_score ?? 5),
      );
      const topFacts = sorted.slice(0, 10).map((c) => c.fact);
      const summary = topFacts.join('; ');

      // Check if this month already has an entry — merge
      const existing = ltIndex.find((e) => e.month === month);
      if (existing) {
        existing.summary += '; ' + summary;
        existing.cluster_count += monthClusters.length;
        existing.archived_at = new Date().toISOString();
      } else {
        ltIndex.push({
          month,
          summary,
          archived_at: new Date().toISOString(),
          cluster_count: monthClusters.length,
        });
      }
      archivedMonths.push(month);
    }

    // Replace clusters with only the recent ones
    doc.sys_core.digest.memory_clusters = toKeep;
    this.storage.updateUserDoc(userId, doc);

    // Sync vector store: remove archived clusters, keep recent, add digest_index entries.
    try {
      // Delete all memory_cluster vectors and re-insert only the kept ones
      this.vectorStore.deleteByFilter(userId, 'memory_cluster');
      for (const c of toKeep) {
        const text = c.fact + (c.foresight ? ` | ${c.foresight}` : '');
        const emb = await this.embedder.embedText(text);
        this.vectorStore.insert(
          userId,
          'memory_cluster',
          text.slice(0, 4000),
          emb,
          '',
          memoryTimestampSeconds(c.created_at),
        );
      }

      // Write digest_index vectors for archived months so they remain searchable.
      // search.ts queries doc_type IN ('memory_cluster','digest_index','chat_log','profile_fragment').
      for (const [month, monthClusters] of byMonth) {
        const sorted = [...monthClusters].sort(
          (a, b) => (b.importance_score ?? 5) - (a.importance_score ?? 5),
        );
        const summary = sorted.slice(0, 10).map((c) => c.fact).join('; ');
        const emb = await this.embedder.embedText(summary);
        // Upsert: delete old digest_index for this month, then insert fresh
        this.vectorStore.deleteByFilter(userId, 'digest_index', month);
        this.vectorStore.insert(
          userId,
          'digest_index',
          summary.slice(0, 4000),
          emb,
          month,
          Math.floor(Date.now() / 1000),
        );
      }
    } catch (e) {
      console.warn('[MemoryEngine] archive: vector store sync failed:', e);
    }

    this.rebuildCache(userId);

    return { archivedMonths, removedCount: toArchive.length };
  }

  // ══════════════════════════════════════════════════════════
  // Cache Helpers
  // ══════════════════════════════════════════════════════════

  getUserCached(userId: string): UserDocument | null {
    const cached = this.cache.getProfile(userId);
    if (cached) return cached;
    const doc = this.storage.getUser(userId);
    if (doc) this.cache.setProfile(userId, doc);
    return doc;
  }

  private rebuildCache(userId: string): void {
    try {
      const doc = this.storage.getUser(userId);
      if (doc) {
        const ttl = this.cache.getDynamicTtl(userId);
        this.cache.setProfile(userId, doc, ttl);
      }
    } catch (e) {
      console.warn("Cache rebuild failed:", e);
    }
  }
}
