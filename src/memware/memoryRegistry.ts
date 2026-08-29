/**
 * memware — per-user memory service registry.
 *
 * serve mode binds one trusted tenant for the lifetime of the process. Opening
 * a fresh SQLite-backed service per call is wasteful, so the service is created
 * lazily and cached. The construction step is injected so tests can supply
 * stub services (with a fake LLM client) instead of hitting bun:sqlite / a real
 * API.
 */

import type { IMemoryService } from "../agent/memory/types";
import { createMemoryService } from "../agent/memory/adapter";
import { resolveModelRuntimeConfig, type MemwareEnv } from "./env";
import { ensureSqlitePragmas } from "./sqlitePragmas";
import type { TenantContext } from "./tenant";
import { prepareTenantStorage } from "./tenant";
import { tightenPrivateTree } from "./secureStorage";

/** Builds a memory service for a user id. */
export type MemoryServiceFactory = (userId: string) => Promise<IMemoryService>;

/**
 * Default production factory: apply concurrency PRAGMAs to the user's DB, then
 * create the real SQLite-backed service. Only env vars that are actually set
 * are forwarded, so unset ones fall back to DEFAULT_CONFIG inside the kernel.
 */
export function createDefaultServiceFactory(env: MemwareEnv, tenant: TenantContext): MemoryServiceFactory {
  const model = resolveModelRuntimeConfig(env);
  return async (userId: string): Promise<IMemoryService> => {
    if (userId !== tenant.internalUserId) {
      throw new Error("memory factory cannot create an unbound tenant");
    }
    prepareTenantStorage(tenant);
    ensureSqlitePragmas(tenant.paths.dbPath);
    const service = await createMemoryService({
      dbPath: tenant.paths.dbPath,
      vectorDbPath: tenant.paths.vectorDbPath,
      apiKey: model.apiKey,
      baseUrl: model.baseUrl,
      ...(model.model !== undefined ? { model: model.model } : {}),
      ...(model.embeddingModel !== undefined ? { embeddingModel: model.embeddingModel } : {}),
      ...(model.embeddingDim !== undefined ? { embeddingDim: model.embeddingDim } : {}),
      embeddingBaseUrl: model.embeddingBaseUrl,
      embeddingApiKey: model.embeddingApiKey,
    });
    tightenPrivateTree(tenant.tenantRoot);
    return service;
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

  /** Close and remove one cached service before destructive tenant lifecycle work. */
  async evict(userId: string): Promise<void> {
    const pending = this.cache.get(userId);
    this.cache.delete(userId);
    if (!pending) return;
    (await pending).close();
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
