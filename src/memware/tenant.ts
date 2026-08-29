/** Trusted tenant identity and storage binding for the standalone memware product. */

import { createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { UserStorePaths } from "./paths";
import { tenantStorePaths } from "./paths";
import {
  assertContainedPath,
  ensurePrivateDirectory,
  initializeDataRoot,
  readPrivateFile,
  tightenPrivateTree,
  writePrivateFileExclusive,
} from "./secureStorage";

declare const tenantKeyBrand: unique symbol;
export type TenantKey = string & { readonly [tenantKeyBrand]: true };

export interface TenantContext {
  /** Kernel-internal id. Never use this value as a path segment or provider field. */
  readonly internalUserId: string;
  readonly key: TenantKey;
  readonly dataRoot: string;
  readonly tenantRoot: string;
  readonly paths: UserStorePaths;
  readonly controlRoot: string;
}

export interface TrustedTenantIdentity {
  /** Stable namespace for the downstream identity issuer. */
  readonly issuer: string;
  /** Stable tenant subject within the issuer namespace. */
  readonly tenantId: string;
}

export class TenantBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantBoundaryError";
  }
}

function validateIdentityComponent(label: string, input: string): string {
  const value = input.trim();
  if (value !== input) throw new TenantBoundaryError(`${label} must not contain surrounding whitespace`);
  if (!value) throw new TenantBoundaryError(`${label} must not be empty`);
  if (Buffer.byteLength(value, "utf8") > 256) {
    throw new TenantBoundaryError(`${label} must be at most 256 UTF-8 bytes`);
  }
  if (/\u0000/.test(value)) throw new TenantBoundaryError(`${label} must not contain NUL`);
  return value;
}

function validateBoundUserId(userId: string): string {
  return validateIdentityComponent("MEMWARE_USER_ID", userId);
}

function loadOrCreateSalt(dataRoot: string): Buffer {
  const saltPath = assertContainedPath(dataRoot, resolve(dataRoot, ".instance-salt"));
  if (!existsSync(saltPath)) {
    try {
      writePrivateFileExclusive(saltPath, randomBytes(32));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }
  }
  const salt = readPrivateFile(saltPath);
  if (salt.byteLength !== 32) throw new TenantBoundaryError("invalid memware instance salt");
  return salt;
}

function initializeContext(
  dataDir: string,
  keyDomain: string,
  keyMaterial: string,
  internalUserId: string | ((key: TenantKey) => string),
): TenantContext {
  const dataRoot = initializeDataRoot(dataDir);
  const salt = loadOrCreateSalt(dataRoot);
  const digest = createHmac("sha256", salt)
    .update(keyDomain, "utf8")
    .update("\0", "utf8")
    .update(keyMaterial, "utf8")
    .digest("base64url");
  const key = `t1_${digest}` as TenantKey;
  const tenantsRoot = assertContainedPath(dataRoot, resolve(dataRoot, "tenants"));
  const tenantRoot = assertContainedPath(dataRoot, resolve(tenantsRoot, key));
  const controlRoot = assertContainedPath(dataRoot, resolve(dataRoot, ".control", key));

  return {
    internalUserId: typeof internalUserId === "function" ? internalUserId(key) : internalUserId,
    key,
    dataRoot,
    tenantRoot,
    paths: tenantStorePaths(tenantRoot),
    controlRoot,
  };
}

/** Create the one trusted tenant binding used by a standalone memware process. */
export function initializeTenantContext(dataDir: string, configuredUserId: string): TenantContext {
  const internalUserId = validateBoundUserId(configuredUserId);
  return initializeContext(dataDir, "memware-tenant-v1", internalUserId, internalUserId);
}

/**
 * Create a tenant binding from an identity already authenticated by a trusted
 * downstream host. Raw issuer and tenant ids are used only as HMAC input and
 * are never retained in the returned context, storage paths, or kernel rows.
 */
export function initializeTrustedTenantContext(
  dataDir: string,
  identity: TrustedTenantIdentity,
): TenantContext {
  const issuer = validateIdentityComponent("issuer", identity.issuer);
  const tenantId = validateIdentityComponent("tenantId", identity.tenantId);
  const keyMaterial = JSON.stringify([issuer, tenantId]);
  return initializeContext(
    dataDir,
    "memware-trusted-tenant-v1",
    keyMaterial,
    (key) => key,
  );
}

/** Create/tighten every directory required before the kernel opens files. */
export function prepareTenantStorage(tenant: TenantContext): void {
  ensurePrivateDirectory(tenant.tenantRoot);
  ensurePrivateDirectory(resolve(tenant.tenantRoot, "memory"));
  ensurePrivateDirectory(tenant.paths.auditDir);
  tightenPrivateTree(tenant.tenantRoot);
}
