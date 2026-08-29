/**
 * memware — per-user storage layout.
 *
 * Single source of truth for where a user's SQLite DB, vector store, and
 * unified-extraction audit log live under the memware data root. Raw user ids
 * never become path segments. Production derives an opaque, instance-scoped
 * tenant key and keeps every tenant artifact below that root.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export interface UserStorePaths {
  /** SQLite database file for this user. */
  dbPath: string;
  /** Vector store directory for this user. */
  vectorDbPath: string;
  /** Unified-extraction audit log directory for this user. */
  auditDir: string;
}

/**
 * Derive a collision-resistant, path-safe storage key. This compatibility
 * helper is intentionally injective only up to SHA-256 collision resistance;
 * memware production uses a salted TenantKey from tenant.ts.
 */
export function sanitizeUserId(userId: string): string {
  return `u1_${createHash("sha256").update(userId, "utf8").digest("base64url")}`;
}

/** Resolve compatibility storage paths without interpreting the user id as path syntax. */
export function userStorePaths(dataDir: string, userId: string): UserStorePaths {
  const base = resolve(dataDir, "tenants", sanitizeUserId(userId));
  return tenantStorePaths(base);
}

/** Resolve all per-tenant storage locations from an already trusted tenant root. */
export function tenantStorePaths(base: string): UserStorePaths {
  return {
    dbPath: join(base, "memory", "memory.db"),
    vectorDbPath: join(base, "memory", "vectors"),
    auditDir: join(base, "audit"),
  };
}
