/**
 * memware — per-user storage layout.
 *
 * Single source of truth for where a user's SQLite DB, vector store, and
 * unified-extraction audit log live under the memware data root. The layout
 * mirrors avatanel's `<root>/<userId>/memory/{memory.db,vectors}` convention so
 * the memory kernel sees a familiar shape, but the audit log is redirected into
 * the memware root (NOT ~/.avatanel) to keep memware self-contained.
 */

import { join } from "node:path";

export interface UserStorePaths {
  /** SQLite database file for this user. */
  dbPath: string;
  /** Vector store directory for this user. */
  vectorDbPath: string;
  /** Unified-extraction audit log directory for this user. */
  auditDir: string;
}

/**
 * Sanitize a user id into a single path-safe segment. Mirrors the sanitization
 * used by the memory kernel's audit fallback (runTurnExtraction.ts) so ids like
 * "a/b" cannot escape the data root.
 */
export function sanitizeUserId(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

/** Resolve the storage paths for a user under the memware data root. */
export function userStorePaths(dataDir: string, userId: string): UserStorePaths {
  const base = join(dataDir, sanitizeUserId(userId));
  return {
    dbPath: join(base, "memory", "memory.db"),
    vectorDbPath: join(base, "memory", "vectors"),
    auditDir: join(base, "audit"),
  };
}
