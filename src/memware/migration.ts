/** Conservative migration from the legacy <dataDir>/<sanitized-userId> layout. */

import { Database } from "bun:sqlite";
import { existsSync, lstatSync, renameSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import type { TenantContext } from "./tenant";
import { ensurePrivateDirectory, tightenPrivateTree, writePrivateFileExclusive } from "./secureStorage";

export type TenantMigrationResult =
  | { status: "not_needed" | "migrated" | "unsafe_legacy_ignored" }
  | { status: "blocked"; reason: string };

function legacySegment(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isStrictChild(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function distinctStoredUsers(dbPath: string): Set<string> {
  const users = new Set<string>();
  if (!existsSync(dbPath)) return users;
  const db = new Database(dbPath, { readonly: true });
  try {
    const tableRows = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tables = new Set(tableRows.map((row) => row.name));
    for (const table of [
      "users",
      "vectors",
      "memory_assets",
      "memory_asset_sources",
      "memory_asset_audit",
      "memory_entities",
      "memory_edges",
      "memory_record_entities",
    ]) {
      if (!tables.has(table)) continue;
      const rows = db.query<{ user_id: string }, []>(`SELECT DISTINCT user_id FROM ${table}`).all();
      for (const row of rows) users.add(row.user_id);
    }
  } finally {
    db.close();
  }
  return users;
}

/**
 * Migrate only the one legacy directory attributable to the bound tenant.
 * Ambiguous or escaping legacy state is never reinterpreted automatically.
 */
export function migrateLegacyTenantStorage(tenant: TenantContext): TenantMigrationResult {
  const segment = legacySegment(tenant.internalUserId);
  const legacyRoot = resolve(tenant.dataRoot, segment);
  if (!isStrictChild(tenant.dataRoot, legacyRoot) || segment === "." || segment === "..") {
    return { status: "unsafe_legacy_ignored" };
  }

  const legacyExists = existsSync(legacyRoot);
  const currentExists = existsSync(tenant.tenantRoot);
  if (!legacyExists) return { status: "not_needed" };
  if (currentExists) return { status: "blocked", reason: "both legacy and tenant-v1 storage exist" };

  const stat = lstatSync(legacyRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { status: "blocked", reason: "legacy storage is not a private directory" };
  }

  try {
    const dbPath = resolve(legacyRoot, "memory", "memory.db");
    const vectorDbPath = resolve(legacyRoot, "memory", "vectors");
    const storedUsers = new Set([
      ...distinctStoredUsers(dbPath),
      ...distinctStoredUsers(vectorDbPath),
    ]);
    if (storedUsers.size === 0) {
      return { status: "blocked", reason: "legacy storage ownership cannot be proven" };
    }
    if ([...storedUsers].some((userId) => userId !== tenant.internalUserId)) {
      return { status: "blocked", reason: "legacy storage contains more than the bound tenant" };
    }

    ensurePrivateDirectory(resolve(tenant.dataRoot, "tenants"));
    renameSync(legacyRoot, tenant.tenantRoot);
    tightenPrivateTree(tenant.tenantRoot);
    const receiptPath = resolve(tenant.controlRoot, "migration-v1.json");
    if (!existsSync(receiptPath)) {
      writePrivateFileExclusive(
        receiptPath,
        `${JSON.stringify({ version: "tenant-layout-v1", migratedAt: new Date().toISOString() })}\n`,
      );
    }
    return { status: "migrated" };
  } catch (err) {
    return { status: "blocked", reason: err instanceof Error ? err.message : String(err) };
  }
}
