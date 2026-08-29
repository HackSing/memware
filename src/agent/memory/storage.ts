/**
 * avatanel Memory System — SQLite Storage
 *
 * Uses bun:sqlite (synchronous, single-process, zero-install).
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { UserDocument } from "./types";
import { MEMORY_SQLITE_BUSY_TIMEOUT_MS } from "./types";

const INIT_SQL = `
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    sys_core TEXT NOT NULL DEFAULT '{}',
    domain_data TEXT NOT NULL DEFAULT '{}',
    meta TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_assets (
    asset_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    file_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    summary TEXT DEFAULT '',
    ocr_text TEXT DEFAULT '',
    topics TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    extractor_version TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_assets_user_sha ON memory_assets(user_id, sha256);
CREATE INDEX IF NOT EXISTS idx_memory_assets_user_status ON memory_assets(user_id, status);

CREATE TABLE IF NOT EXISTS memory_asset_sources (
    source_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    source TEXT NOT NULL,
    message_text TEXT DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY(asset_id) REFERENCES memory_assets(asset_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_asset_sources_asset ON memory_asset_sources(asset_id);
CREATE INDEX IF NOT EXISTS idx_memory_asset_sources_session ON memory_asset_sources(user_id, session_id, turn_index);

CREATE TABLE IF NOT EXISTS memory_entities (
    entity_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    aliases TEXT NOT NULL DEFAULT '[]',
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT '',
    extractor_version TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    first_seen_at TEXT DEFAULT (datetime('now')),
    last_seen_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_entities_user_name ON memory_entities(user_id, entity_type, canonical_name);

CREATE TABLE IF NOT EXISTS memory_edges (
    edge_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    to_id TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    turn_index INTEGER,
    asset_id TEXT,
    memory_id TEXT,
    extractor_version TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_user_type ON memory_edges(user_id, edge_type);
CREATE INDEX IF NOT EXISTS idx_memory_edges_asset ON memory_edges(user_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_memory ON memory_edges(user_id, memory_id);

CREATE TABLE IF NOT EXISTS memory_record_entities (
    record_entity_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    record_type TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'mentions',
    confidence REAL NOT NULL DEFAULT 0.5,
    source TEXT NOT NULL DEFAULT '',
    session_id TEXT,
    turn_index INTEGER,
    asset_id TEXT,
    extractor_version TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_record_entities_memory ON memory_record_entities(user_id, memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_record_entities_entity ON memory_record_entities(user_id, entity_id);

CREATE TABLE IF NOT EXISTS memory_asset_audit (
    audit_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    session_id TEXT,
    turn_index INTEGER,
    source TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now'))
);
`;

export class SQLiteStorage {
  private db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`PRAGMA busy_timeout=${MEMORY_SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(INIT_SQL);
  }

  close(): void {
    this.db.close();
  }

  getDatabaseForExtensions(): Database {
    return this.db;
  }

  // ── User CRUD ─────────────────────────────────────────────

  getUser(userId: string): UserDocument | null {
    const row = this.db
      .query<{ sys_core: string; domain_data: string; meta: string }, [string]>(
        "SELECT sys_core, domain_data, meta FROM users WHERE user_id = ?",
      )
      .get(userId);

    if (!row) return null;
    return {
      sys_core: JSON.parse(row.sys_core),
      domain_data: JSON.parse(row.domain_data),
      meta: JSON.parse(row.meta),
    } as UserDocument;
  }

  setUser(userId: string, data: UserDocument): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO users (user_id, sys_core, domain_data, meta, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(user_id) DO UPDATE SET
           sys_core=excluded.sys_core,
           domain_data=excluded.domain_data,
           meta=excluded.meta,
           updated_at=excluded.updated_at`,
      )
      .run(
        userId,
        JSON.stringify(data.sys_core),
        JSON.stringify(data.domain_data),
        JSON.stringify(data.meta),
        now,
        now,
      );
  }

  updateUserDoc(userId: string, doc: UserDocument): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `UPDATE users SET sys_core=?1, domain_data=?2, meta=?3, updated_at=?4
         WHERE user_id=?5`,
      )
      .run(
        JSON.stringify(doc.sys_core),
        JSON.stringify(doc.domain_data),
        JSON.stringify(doc.meta),
        now,
        userId,
      );
  }

  deleteUser(userId: string): void {
    this.db.query("DELETE FROM users WHERE user_id = ?").run(userId);
  }

  userExists(userId: string): boolean {
    const row = this.db
      .query<{ x: number }, [string]>("SELECT 1 as x FROM users WHERE user_id = ? LIMIT 1")
      .get(userId);
    return row !== null;
  }

  listUsers(): string[] {
    const rows = this.db
      .query<{ user_id: string }, []>("SELECT user_id FROM users")
      .all();
    return rows.map((r) => r.user_id);
  }

  // ── Config CRUD ───────────────────────────────────────────

  getConfig(key: string): Record<string, unknown> | null {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM config WHERE key = ?")
      .get(key);
    return row ? JSON.parse(row.value) : null;
  }
}
