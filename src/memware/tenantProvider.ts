/**
 * Deployment-selectable tenant capability providers.
 *
 * A request payload may assert a user id for protocol compatibility, but only
 * a trusted host security context is allowed to select a tenant.
 */

import type { MemwareEnv } from "./env";
import { migrateLegacyTenantStorage } from "./migration";
import { createDefaultServiceFactory, MemoryRegistry } from "./memoryRegistry";
import {
  initializeTenantContext,
  initializeTrustedTenantContext,
  prepareTenantStorage,
  TenantBoundaryError,
  type TenantContext,
} from "./tenant";
import { TenantMemoryHandle } from "./tenantMemoryHandle";

export type TenantBoundary = "single-process-v1" | "trusted-host-v1";
export type TenantAction =
  | "status"
  | "warmup"
  | "read"
  | "write"
  | "search"
  | "archive"
  | "reset";

export interface RequestSecurityContext {
  /** Stable downstream identity issuer; for example an application id. */
  readonly issuer: string;
  /** Authenticated actor. It is authorization input, never a storage key. */
  readonly principalId: string;
  /** Final data-owner identity established by the downstream host. */
  readonly tenantId: string;
  /** Correlation id supplied by the trusted transport or host. */
  readonly requestId: string;
  /** Authentication method used by the downstream host. */
  readonly authMethod: string;
  readonly scopes?: readonly string[];
}

export interface TenantAcquireRequest {
  readonly action: TenantAction;
  /** Compatibility assertion only. It never selects the tenant. */
  readonly requestedUserId?: string;
  readonly securityContext?: RequestSecurityContext;
}

export interface TenantLease {
  readonly handle: TenantMemoryHandle;
  /** Kernel identity. Opaque in trusted-host mode. */
  readonly userId: string;
  /** Safe reference for protocol responses and diagnostics. */
  readonly tenantRef: string;
  release(): Promise<void>;
}

export interface TenantProviderStatus {
  readonly tenantBoundary: TenantBoundary;
  readonly activeTenants?: number;
  readonly maxActiveTenants?: number;
}

export interface TenantProvider {
  readonly boundary: TenantBoundary;
  acquire(request: TenantAcquireRequest): Promise<TenantLease>;
  status(): TenantProviderStatus;
  close(): Promise<void>;
}

export class TenantAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAuthorizationError";
  }
}

export class TenantCapacityError extends Error {
  constructor(message = "tenant_capacity_exhausted") {
    super(message);
    this.name = "TenantCapacityError";
  }
}

export type TenantAuthorizer = (
  context: RequestSecurityContext,
  action: TenantAction,
) => boolean | Promise<boolean>;

export type TenantHandleFactory = (
  tenant: TenantContext,
) => TenantMemoryHandle | Promise<TenantMemoryHandle>;

function validateSecurityField(label: string, value: string): void {
  if (value !== value.trim() || value.length === 0) {
    throw new TenantAuthorizationError(`invalid_${label}`);
  }
  if (Buffer.byteLength(value, "utf8") > 256 || /\u0000/.test(value)) {
    throw new TenantAuthorizationError(`invalid_${label}`);
  }
}

function snapshotSecurityContext(context?: RequestSecurityContext): RequestSecurityContext {
  if (!context) throw new TenantAuthorizationError("trusted_security_context_required");
  validateSecurityField("issuer", context.issuer);
  validateSecurityField("principal", context.principalId);
  validateSecurityField("tenant", context.tenantId);
  validateSecurityField("request", context.requestId);
  validateSecurityField("auth_method", context.authMethod);
  if (context.scopes && context.scopes.length > 128) {
    throw new TenantAuthorizationError("invalid_scopes");
  }
  const scopes = context.scopes?.map((scope) => {
    validateSecurityField("scope", scope);
    return scope;
  });
  return Object.freeze({
    issuer: context.issuer,
    principalId: context.principalId,
    tenantId: context.tenantId,
    requestId: context.requestId,
    authMethod: context.authMethod,
    ...(scopes ? { scopes: Object.freeze(scopes) } : {}),
  });
}

export class SingleTenantProvider implements TenantProvider {
  readonly boundary = "single-process-v1" as const;
  private closed = false;

  constructor(readonly handle: TenantMemoryHandle) {}

  async acquire(request: TenantAcquireRequest): Promise<TenantLease> {
    if (this.closed) throw new TenantBoundaryError("tenant_provider_closed");
    const userId = this.handle.assertRequestedUserId(request.requestedUserId);
    return {
      handle: this.handle,
      userId,
      tenantRef: this.handle.tenant.key,
      async release() {},
    };
  }

  status(): TenantProviderStatus {
    return { tenantBoundary: this.boundary };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.handle.close();
  }
}

interface PoolEntry {
  readonly handle: TenantMemoryHandle;
  leases: number;
  lastUsedAt: number;
}

export interface TrustedMultiTenantProviderOptions {
  readonly dataDir: string;
  readonly authorize: TenantAuthorizer;
  readonly createHandle: TenantHandleFactory;
  readonly maxActiveTenants?: number;
  readonly idleTtlMs?: number;
  readonly now?: () => number;
}

export class TrustedMultiTenantProvider implements TenantProvider {
  readonly boundary = "trusted-host-v1" as const;
  private readonly entries = new Map<string, PoolEntry>();
  private readonly maxActiveTenants: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;
  private poolGate: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: TrustedMultiTenantProviderOptions) {
    this.maxActiveTenants = options.maxActiveTenants ?? 64;
    this.idleTtlMs = options.idleTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(this.maxActiveTenants) || this.maxActiveTenants < 1) {
      throw new TenantCapacityError("maxActiveTenants must be a positive integer");
    }
    if (!Number.isFinite(this.idleTtlMs) || this.idleTtlMs < 0) {
      throw new TenantCapacityError("idleTtlMs must be non-negative");
    }
  }

  async acquire(request: TenantAcquireRequest): Promise<TenantLease> {
    if (this.closed) throw new TenantBoundaryError("tenant_provider_closed");
    // Snapshot before the async authorization decision so a mutable host
    // object cannot change tenant identity between validation and use.
    const context = snapshotSecurityContext(request.securityContext);
    if (
      request.requestedUserId !== undefined &&
      request.requestedUserId !== context.tenantId
    ) {
      throw new TenantAuthorizationError("tenant_assertion_mismatch");
    }
    if (!(await this.options.authorize(context, request.action))) {
      throw new TenantAuthorizationError("tenant_action_not_authorized");
    }
    if (this.closed) throw new TenantBoundaryError("tenant_provider_closed");

    // Authorization must complete before identity material can create storage.
    const tenant = initializeTrustedTenantContext(this.options.dataDir, {
      issuer: context.issuer,
      tenantId: context.tenantId,
    });
    const entry = await this.checkout(tenant);
    let released = false;
    return {
      handle: entry.handle,
      userId: tenant.internalUserId,
      tenantRef: tenant.key,
      release: async () => {
        if (released) return;
        released = true;
        entry.leases = Math.max(0, entry.leases - 1);
        entry.lastUsedAt = this.now();
      },
    };
  }

  status(): TenantProviderStatus {
    return {
      tenantBoundary: this.boundary,
      activeTenants: this.entries.size,
      maxActiveTenants: this.maxActiveTenants,
    };
  }

  async sweepIdle(): Promise<number> {
    return this.withPoolGate(() => this.sweepIdleUnlocked());
  }

  private async sweepIdleUnlocked(): Promise<number> {
    const cutoff = this.now() - this.idleTtlMs;
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => entry.leases === 0 && entry.lastUsedAt <= cutoff)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    let removed = 0;
    for (const [key, entry] of candidates) {
      if (!this.entries.delete(key)) continue;
      await entry.handle.close();
      removed += 1;
    }
    return removed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.withPoolGate(async () => {
      const entries = [...this.entries.values()];
      this.entries.clear();
      for (const entry of entries) await entry.handle.close();
    });
  }

  private async checkout(tenant: TenantContext): Promise<PoolEntry> {
    return this.withPoolGate(async () => {
      if (this.closed) throw new TenantBoundaryError("tenant_provider_closed");
      await this.sweepIdleUnlocked();
      let entry = this.entries.get(tenant.key);
      if (!entry) {
        await this.makeCapacity();
        prepareTenantStorage(tenant);
        const handle = await this.options.createHandle(tenant);
        entry = { handle, leases: 0, lastUsedAt: this.now() };
        this.entries.set(tenant.key, entry);
      }
      entry.leases += 1;
      entry.lastUsedAt = this.now();
      return entry;
    });
  }

  private async makeCapacity(): Promise<void> {
    while (this.entries.size >= this.maxActiveTenants) {
      const candidate = [...this.entries.entries()]
        .filter(([, entry]) => entry.leases === 0)
        .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
      if (!candidate) throw new TenantCapacityError();
      const [key, entry] = candidate;
      this.entries.delete(key);
      await entry.handle.close();
    }
  }

  private async withPoolGate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.poolGate;
    let release!: () => void;
    this.poolGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function createHandle(env: MemwareEnv, tenant: TenantContext): TenantMemoryHandle {
  const registry = new MemoryRegistry(createDefaultServiceFactory(env, tenant));
  return new TenantMemoryHandle(tenant, registry);
}

/** Build the backward-compatible, process-bound standalone provider. */
export function createSingleTenantProvider(env: MemwareEnv): SingleTenantProvider {
  const tenant = initializeTenantContext(env.dataDir, env.defaultUserId);
  const migration = migrateLegacyTenantStorage(tenant);
  if (migration.status === "blocked") throw new TenantBoundaryError(migration.reason);
  prepareTenantStorage(tenant);
  return new SingleTenantProvider(createHandle(env, tenant));
}

/** Build an in-process trusted multi-tenant provider for an authenticated host. */
export function createTrustedMultiTenantProvider(
  env: MemwareEnv,
  options: Omit<TrustedMultiTenantProviderOptions, "dataDir" | "createHandle">,
): TrustedMultiTenantProvider {
  return new TrustedMultiTenantProvider({
    ...options,
    dataDir: env.dataDir,
    createHandle: (tenant) => createHandle(env, tenant),
  });
}
