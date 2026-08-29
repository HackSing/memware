/**
 * memware SQLite PRAGMA setup — WAL journaling + busy timeout.
 *
 * WAL is persisted in the DB header (verified across a fresh connection).
 * busy_timeout is per-connection and does not persist — we can only verify it
 * took effect on the connection ensureSqlitePragmas used (via the readback it
 * returns), which is the documented limitation.
 */
import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSqlitePragmas, SQLITE_BUSY_TIMEOUT_MS } from "../../src/memware/sqlitePragmas";

const tmp = mkdtempSync(join(tmpdir(), "memware-pragma-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test("ensureSqlitePragmas creates missing parent dirs and the db file", () => {
  const dbPath = join(tmp, "nested", "deep", "memory.db");
  expect(existsSync(dbPath)).toBe(false);
  ensureSqlitePragmas(dbPath);
  expect(existsSync(dbPath)).toBe(true);
});

test("ensureSqlitePragmas applies WAL + busy_timeout on its connection", () => {
  const dbPath = join(tmp, "applied", "memory.db");
  const applied = ensureSqlitePragmas(dbPath);
  expect(applied.journalMode.toLowerCase()).toBe("wal");
  expect(applied.busyTimeoutMs).toBe(SQLITE_BUSY_TIMEOUT_MS);
});

test("WAL journal mode persists to a later connection", () => {
  const dbPath = join(tmp, "persist", "memory.db");
  ensureSqlitePragmas(dbPath);
  const db = new Database(dbPath);
  try {
    const row = db.query("PRAGMA journal_mode").get() as Record<string, unknown>;
    expect(String(Object.values(row)[0]).toLowerCase()).toBe("wal");
  } finally {
    db.close();
  }
});

test("ensureSqlitePragmas is idempotent", () => {
  const dbPath = join(tmp, "idem", "memory.db");
  ensureSqlitePragmas(dbPath);
  const second = ensureSqlitePragmas(dbPath);
  expect(second.journalMode.toLowerCase()).toBe("wal");
  expect(second.busyTimeoutMs).toBe(SQLITE_BUSY_TIMEOUT_MS);
});
