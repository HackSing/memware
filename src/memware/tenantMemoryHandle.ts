/**
 * A single-tenant capability with a cross-process operation gate and complete
 * memware reset lifecycle.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import type { IMemoryService } from "../agent/memory/types";
import type { MemoryRegistry } from "./memoryRegistry";
import {
  assertContainedPath,
  ensurePrivateDirectory,
  readPrivateFile,
  tightenPrivateTree,
  writePrivateFileExclusive,
} from "./secureStorage";
import type { TenantContext } from "./tenant";
import { prepareTenantStorage, TenantBoundaryError } from "./tenant";

type TenantLifecycleState = "active" | "resetting" | "deleted" | "partial_failure";

export interface TenantResetResult {
  ok: boolean;
  status: "deleted" | "partial_failure";
  operationId: string;
  error?: string;
}

interface ResetLockRecord {
  operationId: string;
  pid: number;
  startedAt: string;
}

export class TenantOperationBlockedError extends Error {
  constructor(message = "tenant reset is in progress") {
    super(message);
    this.name = "TenantOperationBlockedError";
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readResetLock(path: string): ResetLockRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ResetLockRecord>;
    if (
      typeof parsed.operationId === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as ResetLockRecord;
    }
  } catch {
    // A malformed lock is still authoritative and blocks normal operations.
  }
  return null;
}

export class TenantMemoryHandle {
  private state: TenantLifecycleState = "active";
  private readonly operationsDir: string;
  private readonly resetLockPath: string;
  private readonly deletingRoot: string;
  private readonly receiptsRoot: string;
  private readonly generationPath: string;
  private generation: number;

  constructor(
    readonly tenant: TenantContext,
    private readonly registry: MemoryRegistry,
  ) {
    this.operationsDir = assertContainedPath(
      tenant.dataRoot,
      resolve(tenant.controlRoot, "operations"),
    );
    this.resetLockPath = assertContainedPath(
      tenant.dataRoot,
      resolve(tenant.controlRoot, "reset.lock"),
    );
    this.deletingRoot = assertContainedPath(tenant.dataRoot, resolve(tenant.dataRoot, ".deleting"));
    this.receiptsRoot = assertContainedPath(
      tenant.dataRoot,
      resolve(tenant.dataRoot, "deletion-receipts"),
    );
    this.generationPath = assertContainedPath(
      tenant.dataRoot,
      resolve(tenant.controlRoot, "generation"),
    );
    ensurePrivateDirectory(this.operationsDir);
    ensurePrivateDirectory(this.deletingRoot);
    ensurePrivateDirectory(this.receiptsRoot);
    this.generation = this.loadOrCreateGeneration();
    this.recoverInterruptedReset();
  }

  get lifecycleState(): TenantLifecycleState {
    return this.state;
  }

  /** Release this tenant's cached kernel resources. */
  async close(): Promise<void> {
    await this.registry.closeAll();
  }

  /** Reject any caller attempt to select a tenant other than the bound one. */
  assertRequestedUserId(requested?: string): string {
    if (requested === undefined || requested === this.tenant.internalUserId) {
      return this.tenant.internalUserId;
    }
    throw new TenantBoundaryError("tenant_selection_not_allowed");
  }

  /** Execute one ordinary operation under a cross-process marker. */
  async run<T>(operation: (memory: IMemoryService, userId: string) => Promise<T>): Promise<T> {
    while (true) {
      await this.synchronizeGeneration();
      if (this.state === "resetting" || this.state === "partial_failure") {
        throw new TenantOperationBlockedError();
      }

      const marker = this.beginOperation();
      let retry = false;
      try {
        const fencedGeneration = this.readGeneration();
        if (fencedGeneration !== this.generation) {
          // Reset completed after our first generation read but before the
          // operation marker handshake. Never reuse that stale SQLite handle.
          await this.registry.evict(this.tenant.internalUserId);
          this.generation = fencedGeneration;
          this.state = "deleted";
          retry = true;
        } else {
          // Storage may be recreated only while a marker is held. A concurrent
          // reset must therefore wait and can never report success beside a new
          // tenant root created by this operation.
          if (this.state === "deleted") {
            prepareTenantStorage(this.tenant);
            this.state = "active";
          }
          const memory = await this.registry.get(this.tenant.internalUserId);
          return await operation(memory, this.tenant.internalUserId);
        }
      } finally {
        try {
          unlinkSync(marker);
        } catch {
          // The reset gate also checks process liveness; a missing marker is safe.
        }
      }
      if (retry) continue;
    }
  }

  /** Delete every memware-owned tenant artifact and return success only after verification. */
  async reset(): Promise<TenantResetResult> {
    let lock = readResetLock(this.resetLockPath);
    const resumingFailure =
      this.state === "partial_failure" &&
      lock !== null &&
      (lock.pid === process.pid || !processAlive(lock.pid));
    if (!resumingFailure) {
      const operationId = randomUUID();
      lock = { operationId, pid: process.pid, startedAt: new Date().toISOString() };
      try {
        writePrivateFileExclusive(this.resetLockPath, `${JSON.stringify(lock)}\n`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new TenantOperationBlockedError();
        }
        throw err;
      }
    }

    this.state = "resetting";
    const operationId = lock!.operationId;
    const stagingRoot = assertContainedPath(
      this.tenant.dataRoot,
      resolve(this.deletingRoot, `${this.tenant.key}-${operationId}`),
    );

    try {
      await this.waitForOperationsToDrain(10_000);
      await this.registry.evict(this.tenant.internalUserId);

      if (existsSync(this.tenant.tenantRoot) && !existsSync(stagingRoot)) {
        renameSync(this.tenant.tenantRoot, stagingRoot);
      }
      if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: false });
      if (existsSync(this.tenant.tenantRoot) || existsSync(stagingRoot)) {
        throw new Error("tenant storage remains after deletion");
      }

      const receiptPath = assertContainedPath(
        this.tenant.dataRoot,
        resolve(this.receiptsRoot, `${operationId}.json`),
      );
      if (!existsSync(receiptPath)) {
        writePrivateFileExclusive(
          receiptPath,
          `${JSON.stringify({
            version: "memware-reset-v1",
            operationId,
            tenantKey: this.tenant.key,
            startedAt: lock!.startedAt,
            completedAt: new Date().toISOString(),
            scopes: ["database", "vectors", "audit", "assets", "relations", "cache", "sidecars"],
          })}\n`,
        );
      }
      this.bumpGeneration();
      unlinkSync(this.resetLockPath);
      this.state = "deleted";
      return { ok: true, status: "deleted", operationId };
    } catch (err) {
      this.state = "partial_failure";
      return {
        ok: false,
        status: "partial_failure",
        operationId,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private beginOperation(): string {
    this.removeStaleOperationMarkers();
    if (existsSync(this.resetLockPath)) throw new TenantOperationBlockedError();
    const marker = assertContainedPath(
      this.tenant.dataRoot,
      resolve(this.operationsDir, `${process.pid}-${randomUUID()}.op`),
    );
    writePrivateFileExclusive(
      marker,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    if (existsSync(this.resetLockPath)) {
      unlinkSync(marker);
      throw new TenantOperationBlockedError();
    }
    return marker;
  }

  private removeStaleOperationMarkers(): void {
    for (const name of readdirSync(this.operationsDir)) {
      if (!name.endsWith(".op")) continue;
      const pid = Number(name.split("-", 1)[0]);
      if (processAlive(pid)) continue;
      const marker = assertContainedPath(this.tenant.dataRoot, resolve(this.operationsDir, name));
      try {
        unlinkSync(marker);
      } catch {
        // A concurrent cleanup can win.
      }
    }
  }

  private async waitForOperationsToDrain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      this.removeStaleOperationMarkers();
      const active = readdirSync(this.operationsDir).filter((name) => name.endsWith(".op"));
      if (active.length === 0) return;
      if (Date.now() >= deadline) throw new Error("timed out waiting for tenant operations to drain");
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
    }
  }

  /**
   * An idle process can still hold an open SQLite handle after another process
   * resets the tenant. The generation fence forces that stale handle closed
   * before any later operation can observe pre-reset memory.
   */
  private async synchronizeGeneration(): Promise<void> {
    const diskGeneration = this.readGeneration();
    if (diskGeneration === this.generation) return;
    await this.registry.evict(this.tenant.internalUserId);
    this.generation = diskGeneration;
    this.state = "deleted";
  }

  private loadOrCreateGeneration(): number {
    if (!existsSync(this.generationPath)) {
      try {
        writePrivateFileExclusive(this.generationPath, "0\n");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    return this.readGeneration();
  }

  private readGeneration(): number {
    const value = readPrivateFile(this.generationPath).toString("utf8").trim();
    if (!/^\d+$/.test(value)) throw new TenantBoundaryError("invalid tenant generation fence");
    const generation = Number(value);
    if (!Number.isSafeInteger(generation)) {
      throw new TenantBoundaryError("invalid tenant generation fence");
    }
    return generation;
  }

  private bumpGeneration(): void {
    const next = this.readGeneration() + 1;
    const tempPath = assertContainedPath(
      this.tenant.dataRoot,
      resolve(this.tenant.controlRoot, `.generation-${randomUUID()}.tmp`),
    );
    writePrivateFileExclusive(tempPath, `${next}\n`);
    renameSync(tempPath, this.generationPath);
    this.generation = next;
  }

  /** Finish a reset whose owner process died before removing the reset lock. */
  private recoverInterruptedReset(): void {
    if (!existsSync(this.resetLockPath)) return;
    const lock = readResetLock(this.resetLockPath);
    if (!lock || processAlive(lock.pid)) {
      this.state = "resetting";
      return;
    }

    const stagingRoot = assertContainedPath(
      this.tenant.dataRoot,
      resolve(this.deletingRoot, `${this.tenant.key}-${lock.operationId}`),
    );
    try {
      this.removeStaleOperationMarkers();
      const active = readdirSync(this.operationsDir).filter((name) => name.endsWith(".op"));
      if (active.length > 0) {
        // A constructor cannot asynchronously drain another process. Keep the
        // dead-owner lock authoritative and require reset() to resume only
        // after those operations finish.
        this.state = "partial_failure";
        return;
      }
      if (existsSync(this.tenant.tenantRoot) && !existsSync(stagingRoot)) {
        renameSync(this.tenant.tenantRoot, stagingRoot);
      }
      if (existsSync(stagingRoot)) rmSync(stagingRoot, { recursive: true, force: false });
      const receiptPath = assertContainedPath(
        this.tenant.dataRoot,
        resolve(this.receiptsRoot, `${lock.operationId}.json`),
      );
      if (!existsSync(receiptPath)) {
        writePrivateFileExclusive(
          receiptPath,
          `${JSON.stringify({
            version: "memware-reset-v1",
            operationId: lock.operationId,
            tenantKey: this.tenant.key,
            startedAt: lock.startedAt,
            completedAt: new Date().toISOString(),
            recovered: true,
            scopes: ["database", "vectors", "audit", "assets", "relations", "cache", "sidecars"],
          })}\n`,
        );
      }
      this.bumpGeneration();
      unlinkSync(this.resetLockPath);
      this.state = "deleted";
      tightenPrivateTree(this.tenant.controlRoot);
    } catch {
      this.state = "partial_failure";
    }
  }
}
