import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { buildExtractorUserMessage } from "../../src/agent/memory/unified/prompts";
import { migrateLegacyTenantStorage } from "../../src/memware/migration";
import { MemoryRegistry } from "../../src/memware/memoryRegistry";
import { initializeTenantContext, prepareTenantStorage } from "../../src/memware/tenant";
import { TenantMemoryHandle } from "../../src/memware/tenantMemoryHandle";
import { buildStubMemory } from "./stubMemory";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("tenant ids are capability-bound and collision-resistant", () => {
  const root = tempRoot("memware-tenant-key-");
  try {
    const slash = initializeTenantContext(root, "a/b");
    const underscore = initializeTenantContext(root, "a_b");
    const escape = initializeTenantContext(root, "..");
    const repeat = initializeTenantContext(root, "a/b");

    expect(slash.key).not.toBe(underscore.key);
    expect(slash.tenantRoot).not.toBe(underscore.tenantRoot);
    expect(slash.key).toBe(repeat.key);
    expect(relative(escape.dataRoot, escape.tenantRoot).startsWith("..")).toBe(false);

    const { service } = buildStubMemory();
    const handle = new TenantMemoryHandle(slash, new MemoryRegistry(async () => service));
    expect(handle.assertRequestedUserId()).toBe("a/b");
    expect(handle.assertRequestedUserId("a/b")).toBe("a/b");
    expect(() => handle.assertRequestedUserId("a_b")).toThrow("tenant_selection_not_allowed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy migration is atomic for one proven tenant and blocks ambiguous aliases", () => {
  const safeRoot = tempRoot("memware-migrate-safe-");
  try {
    const tenant = initializeTenantContext(safeRoot, "alice");
    const legacyDb = join(safeRoot, "alice", "memory", "memory.db");
    mkdirSync(dirname(legacyDb), { recursive: true });
    const db = new Database(legacyDb);
    db.run("CREATE TABLE users (user_id TEXT PRIMARY KEY)");
    db.query("INSERT INTO users (user_id) VALUES (?)").run("alice");
    db.close();

    expect(migrateLegacyTenantStorage(tenant)).toEqual({ status: "migrated" });
    expect(existsSync(tenant.paths.dbPath)).toBe(true);
    expect(existsSync(join(safeRoot, "alice"))).toBe(false);
    expect((statSync(tenant.paths.dbPath).mode & 0o777)).toBe(0o600);
  } finally {
    rmSync(safeRoot, { recursive: true, force: true });
  }

  const ambiguousRoot = tempRoot("memware-migrate-ambiguous-");
  try {
    const tenant = initializeTenantContext(ambiguousRoot, "a?b");
    const legacyDb = join(ambiguousRoot, "a_b", "memory", "memory.db");
    mkdirSync(dirname(legacyDb), { recursive: true });
    const db = new Database(legacyDb);
    db.run("CREATE TABLE users (user_id TEXT PRIMARY KEY)");
    db.query("INSERT INTO users (user_id) VALUES (?)").run("a/b");
    db.close();

    const result = migrateLegacyTenantStorage(tenant);
    expect(result.status).toBe("blocked");
    expect(existsSync(join(ambiguousRoot, "a_b"))).toBe(true);
    expect(existsSync(tenant.tenantRoot)).toBe(false);
  } finally {
    rmSync(ambiguousRoot, { recursive: true, force: true });
  }
});

test("reset drains in-flight work and deletes the complete tenant tree before success", async () => {
  const root = tempRoot("memware-reset-complete-");
  try {
    const tenant = initializeTenantContext(root, "owner");
    prepareTenantStorage(tenant);
    for (const relativePath of [
      "memory/memory.db",
      "memory/memory.db-wal",
      "memory/memory.db-shm",
      "memory/vectors/vectors.db",
      "audit/turns.jsonl",
      "assets/image.bin",
      "relations/graph.jsonl",
      "cache/embedding.json",
    ]) {
      const path = join(tenant.tenantRoot, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "private");
    }

    const { service } = buildStubMemory();
    const registry = new MemoryRegistry(async () => service);
    const handle = new TenantMemoryHandle(tenant, registry);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const active = handle.run(async () => {
      entered();
      await hold;
      return "done";
    });
    await started;
    const reset = handle.reset();
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(existsSync(tenant.tenantRoot)).toBe(true);
    release();
    expect(await active).toBe("done");

    const result = await reset;
    expect(result.ok).toBe(true);
    expect(result.status).toBe("deleted");
    expect(existsSync(tenant.tenantRoot)).toBe(false);
    expect(readdirSync(join(root, ".deleting"))).toEqual([]);
    const receiptPath = join(root, "deletion-receipts", `${result.operationId}.json`);
    expect(existsSync(receiptPath)).toBe(true);
    expect((statSync(receiptPath).mode & 0o777)).toBe(0o600);
    expect(readFileSync(receiptPath, "utf8")).not.toContain("owner");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a second process handle closes its stale service after another handle resets", async () => {
  const root = tempRoot("memware-reset-generation-");
  try {
    const tenantA = initializeTenantContext(root, "owner");
    const tenantB = initializeTenantContext(root, "owner");
    prepareTenantStorage(tenantA);

    const resetRegistry = new MemoryRegistry(async () => buildStubMemory().service);
    const resetHandle = new TenantMemoryHandle(tenantA, resetRegistry);
    let factoryCalls = 0;
    let closeCalls = 0;
    const services: object[] = [];
    const peerRegistry = new MemoryRegistry(async () => {
      factoryCalls += 1;
      const service = buildStubMemory().service;
      const originalClose = service.close.bind(service);
      service.close = () => {
        closeCalls += 1;
        originalClose();
      };
      services.push(service);
      return service;
    });
    const peerHandle = new TenantMemoryHandle(tenantB, peerRegistry);

    const firstService = await peerHandle.run(async (memory) => memory);
    expect(factoryCalls).toBe(1);
    expect((await resetHandle.reset()).ok).toBe(true);
    expect(existsSync(tenantA.tenantRoot)).toBe(false);

    const secondService = await peerHandle.run(async (memory) => memory);
    expect(closeCalls).toBe(1);
    expect(factoryCalls).toBe(2);
    expect(secondService).not.toBe(firstService);
    expect(services).toEqual([firstService, secondService]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation is rechecked after the operation-marker race window", async () => {
  const root = tempRoot("memware-reset-generation-race-");
  try {
    const tenantA = initializeTenantContext(root, "owner");
    const tenantB = initializeTenantContext(root, "owner");
    prepareTenantStorage(tenantA);
    const resetHandle = new TenantMemoryHandle(
      tenantA,
      new MemoryRegistry(async () => buildStubMemory().service),
    );

    let closeCalls = 0;
    const peerRegistry = new MemoryRegistry(async () => {
      const service = buildStubMemory().service;
      const close = service.close.bind(service);
      service.close = () => { closeCalls += 1; close(); };
      return service;
    });
    const peerHandle = new TenantMemoryHandle(tenantB, peerRegistry);
    const staleService = await peerHandle.run(async (memory) => memory);

    const internals = peerHandle as unknown as {
      synchronizeGeneration: () => Promise<void>;
    };
    const synchronize = internals.synchronizeGeneration.bind(peerHandle);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const enteredSync = new Promise<void>((resolve) => { entered = resolve; });
    internals.synchronizeGeneration = async () => {
      await synchronize();
      entered();
      await blocked;
    };

    const racedOperation = peerHandle.run(async (memory) => memory);
    await enteredSync;
    const reset = await resetHandle.reset();
    expect(reset.ok).toBe(true);
    expect(existsSync(tenantA.tenantRoot)).toBe(false);
    release();

    const freshService = await racedOperation;
    expect(closeCalls).toBe(1);
    expect(freshService).not.toBe(staleService);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted reset recovery never deletes beside a live operation marker", async () => {
  const root = tempRoot("memware-reset-recovery-drain-");
  try {
    const tenant = initializeTenantContext(root, "owner");
    prepareTenantStorage(tenant);
    const operationsDir = join(tenant.controlRoot, "operations");
    mkdirSync(operationsDir, { recursive: true });
    const marker = join(operationsDir, `${process.pid}-live.op`);
    writeFileSync(marker, "{}\n");
    writeFileSync(
      join(tenant.controlRoot, "reset.lock"),
      `${JSON.stringify({ operationId: "dead-owner", pid: 999_999_999, startedAt: new Date().toISOString() })}\n`,
    );

    const handle = new TenantMemoryHandle(
      tenant,
      new MemoryRegistry(async () => buildStubMemory().service),
    );
    expect(handle.lifecycleState).toBe("partial_failure");
    expect(existsSync(tenant.tenantRoot)).toBe(true);
    expect(existsSync(join(tenant.controlRoot, "reset.lock"))).toBe(true);

    unlinkSync(marker);
    const resumed = await handle.reset();
    expect(resumed.ok).toBe(true);
    expect(existsSync(tenant.tenantRoot)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation read failure after marker acquisition always cleans the marker", async () => {
  const root = tempRoot("memware-generation-read-failure-");
  try {
    const tenant = initializeTenantContext(root, "owner");
    prepareTenantStorage(tenant);
    const handle = new TenantMemoryHandle(
      tenant,
      new MemoryRegistry(async () => buildStubMemory().service),
    );
    const internals = handle as unknown as { readGeneration: () => number };
    const readGeneration = internals.readGeneration.bind(handle);
    let reads = 0;
    internals.readGeneration = () => {
      reads += 1;
      if (reads === 2) throw new Error("simulated generation read failure");
      return readGeneration();
    };

    await expect(handle.run(async () => "never")).rejects.toThrow("simulated generation read failure");
    expect(readdirSync(join(tenant.controlRoot, "operations"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external extractor prompt omits local user and session identifiers", () => {
  const prompt = buildExtractorUserMessage({
    userId: "raw-user-secret",
    sessionId: "raw-session-secret",
    turnIndex: 9,
    userMessage: "用户正文",
    assistantResponse: "助手正文",
  });
  expect(prompt).not.toContain("raw-user-secret");
  expect(prompt).not.toContain("raw-session-secret");
  expect(prompt).toContain("turnIndex: 9");
  expect(prompt).toContain("用户正文");
});
