/**
 * memware — per-user memory service registry.
 *
 * serve mode is a single long-lived process that may touch several user ids
 * (each tool call carries an optional userId). Opening a fresh SQLite-backed
 * service per call is wasteful, so services are created lazily and cached per
 * user id. The construction step is injected as a factory so tests can supply
 * stub services (with a fake LLM client) instead of hitting bun:sqlite / a real
 * API.
 */

import type { IMemoryService } from "../agent/memory/types";
import { createMemoryService } from "../agent/memory/adapter";
import type { MemwareEnv } from "./env";
import { userStorePaths } from "./paths";
import { ensureSqlitePragmas } from "./sqlitePragmas";

/** Builds a memory service for a user id. */
export type MemoryServiceFactory = (userId: string) => Promise<IMemoryService>;

/**
 * Default production factory: apply concurrency PRAGMAs to the user's DB, then
 * create the real SQLite-backed service. Only env vars that are actually set
 * are forwarded, so unset ones fall back to DEFAULT_CONFIG inside the kernel.
 */
export function createDefaultServiceFactory(env: MemwareEnv): MemoryServiceFactory {
  return async (userId: string): Promise<IMemoryService> => {
    const paths = userStorePaths(env.dataDir, userId);
    ensureSqlitePragmas(paths.dbPath);
    return createMemoryService({
      dbPath: paths.dbPath,
      vectorDbPath: paths.vectorDbPath,
      ...(env.apiKey !== undefined ? { apiKey: env.apiKey } : {}),
      ...(env.baseUrl !== undefined ? { baseUrl: env.baseUrl } : {}),
      ...(env.model !== undefined ? { model: env.model } : {}),
      ...(env.embeddingModel !== undefined ? { embeddingModel: env.embeddingModel } : {}),
      ...(env.embeddingDim !== undefined ? { embeddingDim: env.embeddingDim } : {}),
    });
  };
}

export class MemoryRegistry {
  private readonly cache = new Map<string, Promise<IMemoryService>>();

  constructor(private readonly factory: MemoryServiceFactory) {}

  /** Get (creating + caching on first use) the service for a user id. */
  get(userId: string): Promise<IMemoryService> {
    let existing = this.cache.get(userId);
    if (!existing) {
      existing = this.factory(userId);
      this.cache.set(userId, existing);
    }
    return existing;
  }

  /** Close every constructed service. Best-effort; never throws. */
  async closeAll(): Promise<void> {
    const services = [...this.cache.values()];
    this.cache.clear();
    for (const pending of services) {
      try {
        (await pending).close();
      } catch {
        // A service that failed to construct or close cannot block shutdown.
      }
    }
  }
}
