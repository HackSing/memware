/**
 * avatanel Memory System — Vector Store
 *
 * SQLite-based vector storage with brute-force cosine similarity.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { VectorSearchResult } from "./types";
import { MEMORY_SQLITE_BUSY_TIMEOUT_MS } from "./types";

const INIT_VECTOR_SQL = `
CREATE TABLE IF NOT EXISTS vectors (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB NOT NULL,
    metadata_source TEXT DEFAULT '',
    timestamp INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_vectors_user ON vectors(user_id);
CREATE INDEX IF NOT EXISTS idx_vectors_user_type ON vectors(user_id, doc_type);
`;

function float32ToBlob(arr: number[]): Uint8Array {
  // Bun's sqlite BLOB column binding accepts Uint8Array directly; building a
  // Float32Array and aliasing its underlying buffer is the fastest way to
  // serialise without touching Node's Buffer API.
  const f32 = new Float32Array(arr);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

function blobToFloat32(buf: Uint8Array): number[] {
  // BLOBs come back from `bun:sqlite` as plain `Uint8Array`, not Node
  // `Buffer`, so `buf.readFloatLE` is undefined (this was an actual runtime
  // crash during cross-session retrieval).
  //
  // Use a DataView so we don't require the underlying buffer to be 4-byte
  // aligned (it isn't — SQLite BLOB reads often share a pooled ArrayBuffer
  // at a non-aligned byteOffset, which makes `new Float32Array(buf.buffer,
  // buf.byteOffset, ...)` throw "start offset must be a multiple of 4").
  if (buf.byteLength % 4 !== 0) {
    throw new Error(
      `[VectorStore] blobToFloat32: corrupt embedding — byteLength ${buf.byteLength} is not a multiple of 4. ` +
      `Expected a valid Float32 vector (byteLength must be 4×dim).`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = buf.byteLength / 4;
  const arr: number[] = new Array(count);
  for (let i = 0; i < count; i++) {
    arr[i] = view.getFloat32(i * 4, /* littleEndian */ true);
  }
  return arr;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface VectorRow {
  id: string;
  user_id: string;
  doc_type: string;
  content: string;
  embedding: Buffer;
  metadata_source: string;
  timestamp: number;
}

export class VectorStore {
  private db: Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`PRAGMA busy_timeout=${MEMORY_SQLITE_BUSY_TIMEOUT_MS}`);
    this.db.exec(INIT_VECTOR_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ── Insert ────────────────────────────────────────────────

  insert(
    userId: string,
    docType: string,
    content: string,
    embedding: number[],
    metadataSource = "",
    timestamp = 0,
    docId?: string,
  ): string {
    const id = docId ?? randomUUID();
    const ts = timestamp || Math.floor(Date.now() / 1000);
    const blob = float32ToBlob(embedding);

    this.db
      .query(
        `INSERT OR REPLACE INTO vectors (id, user_id, doc_type, content, embedding, metadata_source, timestamp)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .run(id, userId, docType, content, blob, metadataSource, ts);

    return id;
  }

  // ── Search (brute-force cosine similarity) ────────────────

  search(
    queryEmbedding: number[],
    userId: string,
    topK = 5,
    docTypes?: string[],
  ): VectorSearchResult[] {
    let sql = "SELECT id, user_id, doc_type, content, embedding, metadata_source, timestamp FROM vectors WHERE user_id = ?";
    const params: unknown[] = [userId];

    if (docTypes && docTypes.length > 0) {
      const placeholders = docTypes.map(() => "?").join(", ");
      sql += ` AND doc_type IN (${placeholders})`;
      params.push(...docTypes);
    }

    const rows = this.db.query<VectorRow, string[]>(sql).all(...(params as string[]));

    const scored: Array<VectorSearchResult & { sim: number }> = [];
    for (const row of rows) {
      const emb = blobToFloat32(row.embedding);
      const sim = cosineSimilarity(queryEmbedding, emb);
      // distance = 1 - similarity (cosine distance)
      const distance = 1 - sim;
      scored.push({
        id: row.id,
        content: row.content,
        distance,
        metadata: {
          user_id: row.user_id,
          doc_type: row.doc_type,
          metadata_source: row.metadata_source,
          timestamp: row.timestamp,
        },
        sim,
      });
    }

    // Sort by similarity descending (lowest distance first)
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, topK).map(({ sim: _, ...rest }) => rest);
  }

  // ── Delete ────────────────────────────────────────────────

  deleteByUser(userId: string): void {
    this.db.query("DELETE FROM vectors WHERE user_id = ?").run(userId);
  }

  deleteByFilter(userId: string, docType: string, metadataSource?: string): void {
    if (metadataSource) {
      this.db
        .query("DELETE FROM vectors WHERE user_id = ? AND doc_type = ? AND metadata_source = ?")
        .run(userId, docType, metadataSource);
    } else {
      this.db
        .query("DELETE FROM vectors WHERE user_id = ? AND doc_type = ?")
        .run(userId, docType);
    }
  }

  /**
   * Delete vector rows whose `metadata_source` column contains the given
   * substring, scoped to (userId, docType). Used by `deleteByProvenance`
   * to drop vector rows attributed to a specific session by encoding the
   * session id into `metadata_source` as `session_id={sid}` (v4 P1-D).
   *
   * Uses SQL LIKE with `%substring%`. The caller is responsible for
   * passing a substring that will not collide with unrelated rows; the
   * convention is `session_id=<exact-id>` which is unique per session.
   *
   * @returns number of rows deleted
   */
  deleteByMetadataSubstring(userId: string, docType: string, substring: string): number {
    const result = this.db
      .query("DELETE FROM vectors WHERE user_id = ? AND doc_type = ? AND metadata_source LIKE ?")
      .run(userId, docType, `%${substring}%`);
    return Number(result.changes ?? 0);
  }

  deleteById(id: string): void {
    this.db.query("DELETE FROM vectors WHERE id = ?").run(id);
  }

  // ── Utility ───────────────────────────────────────────────

  count(userId?: string): number {
    if (userId) {
      const row = this.db
        .query<{ cnt: number }, [string]>("SELECT COUNT(*) as cnt FROM vectors WHERE user_id = ?")
        .get(userId);
      return row?.cnt ?? 0;
    }
    const row = this.db
      .query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM vectors")
      .get();
    return row?.cnt ?? 0;
  }
}
