/**
 * memware secure local storage primitives.
 *
 * These helpers are intentionally owned by memware rather than the shared
 * memory kernel: the standalone product promises private per-tenant storage,
 * while external kernel consumers may have different directory policies.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class SecureStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureStorageError";
  }
}

/** Resolve and create the configured root. A configured root symlink is pinned to its real target. */
export function initializeDataRoot(dataDir: string): string {
  const absolute = isAbsolute(dataDir) ? resolve(dataDir) : resolve(process.cwd(), dataDir);
  mkdirSync(absolute, { recursive: true, mode: PRIVATE_DIR_MODE });
  const root = realpathSync(absolute);
  const stat = lstatSync(root);
  if (!stat.isDirectory()) throw new SecureStorageError("MEMWARE_DATA_DIR must resolve to a directory");
  chmodSync(root, PRIVATE_DIR_MODE);
  return root;
}

/** Prove a candidate is a strict child of the canonical data root. */
export function assertContainedPath(root: string, candidate: string): string {
  const canonicalRoot = resolve(root);
  const resolved = resolve(candidate);
  const rel = relative(canonicalRoot, resolved);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SecureStorageError("storage path must remain below MEMWARE_DATA_DIR");
  }
  return resolved;
}

/** Ensure a private directory exists and is not a symlink. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new SecureStorageError(`private storage directory is unsafe: ${path}`);
  }
  chmodSync(path, PRIVATE_DIR_MODE);
}

/** Read a private regular file, rejecting symlinks and tightening its mode. */
export function readPrivateFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new SecureStorageError(`private storage file is unsafe: ${path}`);
  }
  chmodSync(path, PRIVATE_FILE_MODE);
  return readFileSync(path);
}

/** Create a private file without following an existing path. */
export function writePrivateFileExclusive(path: string, data: string | Uint8Array): void {
  ensurePrivateDirectory(dirname(path));
  writeFileSync(path, data, { flag: "wx", mode: PRIVATE_FILE_MODE });
  chmodSync(path, PRIVATE_FILE_MODE);
}

/** Tighten an existing tenant tree and reject any child symlink. */
export function tightenPrivateTree(root: string): void {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw new SecureStorageError(`private storage contains a symlink: ${root}`);
  if (stat.isDirectory()) {
    chmodSync(root, PRIVATE_DIR_MODE);
    for (const entry of readdirSync(root)) tightenPrivateTree(resolve(root, entry));
    return;
  }
  if (!stat.isFile()) throw new SecureStorageError(`private storage contains an unsupported entry: ${root}`);
  chmodSync(root, PRIVATE_FILE_MODE);
}
