/**
 * memware — SQLite concurrency PRAGMAs.
 *
 * serve mode (long-lived MCP server) and hook mode (short-lived per-turn
 * process) can write the same user DB concurrently. To make that safe we want
 * WAL journaling (concurrent reader + single writer) and a busy timeout so a
 * blocked writer waits instead of erroring with SQLITE_BUSY.
 *
 * We open the file with bun:sqlite BEFORE createMemoryService and apply the
 * PRAGMAs, rather than editing the shared storage.ts. Two important caveats,
 * documented here because they bound what this can guarantee:
 *
 *   • `journal_mode=WAL` is persisted in the DB header, so setting it on any
 *     connection makes the file WAL for every later connection (including the
 *     kernel's). The kernel's storage.ts already sets WAL, so this is
 *     belt-and-suspenders — harmless and idempotent.
 *
 *   • `busy_timeout` is PER-CONNECTION and does NOT persist. Applying it here
 *     only affects this throwaway connection, which we immediately close. The
 *     kernel's own connection therefore does not inherit it. Giving the live
 *     writer a busy timeout would require changing storage.ts, which is out of
 *     scope for this batch. This is a known residual concurrency risk.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MEMORY_SQLITE_BUSY_TIMEOUT_MS } from "../agent/memory/types";

// Re-export the kernel-owned value (single source of truth). The kernel now
// sets busy_timeout on its own live connections (storage.ts/vectorStore.ts);
// applying it here on our throwaway connection is kept for the readback
// diagnostics and for DBs created before that fix.
export const SQLITE_BUSY_TIMEOUT_MS = MEMORY_SQLITE_BUSY_TIMEOUT_MS;

export interface AppliedPragmas {
  journalMode: string;
  busyTimeoutMs: number;
}

function firstValue(row: unknown): unknown {
  if (row && typeof row === "object") {
    const values = Object.values(row as Record<string, unknown>);
    return values.length > 0 ? values[0] : undefined;
  }
  return row;
}

/**
 * Ensure the SQLite file at `dbPath` uses WAL journaling, and set a busy
 * timeout on the (throwaway) connection used here. Creates the parent
 * directory if absent. Returns the effective values read back from the DB so
 * callers can surface them for diagnostics (see memory_status).
 */
export function ensureSqlitePragmas(dbPath: string): AppliedPragmas {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(`PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`);
    const journalMode = String(firstValue(db.query("PRAGMA journal_mode").get()) ?? "");
    const busyTimeoutMs = Number(firstValue(db.query("PRAGMA busy_timeout").get()) ?? 0);
    return { journalMode, busyTimeoutMs };
  } finally {
    db.close();
  }
}
