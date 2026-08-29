/**
 * memware — environment configuration.
 *
 * memware is configured *only* through environment variables (never a config
 * file, never avatanel's own config). This module reads MEMWARE_* vars into a
 * typed {@link MemwareEnv} and validates the one required key.
 *
 * Single-source-of-truth discipline: memware does NOT re-declare any of the
 * memory kernel's business defaults (model names, thresholds, embedding dims).
 * Unset env vars are left `undefined` and simply not forwarded to
 * `createMemoryService`, so they fall back to DEFAULT_CONFIG inside the kernel.
 * The only defaults defined here are memware-owned identity/layout values that
 * the memory kernel knows nothing about (data root + user id).
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** memware-owned default data root. Independent of avatanel's ~/.avatanel. */
export function defaultDataDir(): string {
  return join(homedir(), ".memware");
}

/** memware-owned default user id when MEMWARE_USER_ID is unset. */
export const DEFAULT_USER_ID = "default";

/** Thrown when the environment is missing something memware needs to start. */
export class MemwareConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemwareConfigError";
  }
}

/**
 * Resolved memware environment. Optional fields left `undefined` when the
 * corresponding env var is unset — callers must NOT substitute kernel defaults
 * here; they forward only defined fields and let DEFAULT_CONFIG win.
 */
export interface MemwareEnv {
  /** MEMWARE_API_KEY — required. OpenAI-compatible key for chat + embeddings. */
  apiKey: string;
  /** MEMWARE_BASE_URL — optional OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** MEMWARE_MODEL — optional chat/extractor model name. */
  model?: string;
  /** MEMWARE_EMBEDDING_MODEL — optional embedding model name. */
  embeddingModel?: string;
  /** MEMWARE_EMBEDDING_DIM — optional embedding vector dimension. */
  embeddingDim?: number;
  /** MEMWARE_DATA_DIR — storage root (default ~/.memware). */
  dataDir: string;
  /** MEMWARE_USER_ID — default user id (default "default"). */
  defaultUserId: string;
  /** MEMWARE_DEBUG — verbose extraction diagnostics to stderr. */
  debug: boolean;
}

function readOptional(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = source[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readDim(source: NodeJS.ProcessEnv): number | undefined {
  const raw = readOptional(source, "MEMWARE_EMBEDDING_DIM");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new MemwareConfigError(
      `MEMWARE_EMBEDDING_DIM must be a positive integer, got "${raw}"`,
    );
  }
  return n;
}

/**
 * Parse the process environment into {@link MemwareEnv}.
 *
 * @throws {MemwareConfigError} when MEMWARE_API_KEY is missing/empty or a
 *   provided numeric var is malformed. Callers decide how to react: serve mode
 *   exits non-zero; hook mode swallows and exits 0 (never blocks the host).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): MemwareEnv {
  const apiKey = readOptional(source, "MEMWARE_API_KEY");
  if (!apiKey) {
    throw new MemwareConfigError(
      "MEMWARE_API_KEY is required. Set it to an OpenAI-compatible API key, e.g.\n" +
        "  claude mcp add memware -e MEMWARE_API_KEY=sk-... -- npx -y memware serve",
    );
  }
  return {
    apiKey,
    baseUrl: readOptional(source, "MEMWARE_BASE_URL"),
    model: readOptional(source, "MEMWARE_MODEL"),
    embeddingModel: readOptional(source, "MEMWARE_EMBEDDING_MODEL"),
    embeddingDim: readDim(source),
    dataDir: readOptional(source, "MEMWARE_DATA_DIR") ?? defaultDataDir(),
    defaultUserId: readOptional(source, "MEMWARE_USER_ID") ?? DEFAULT_USER_ID,
    debug: source.MEMWARE_DEBUG === "1" || source.MEMWARE_DEBUG === "true",
  };
}
