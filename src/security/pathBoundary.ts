/**
 * avatanel — local path containment helpers
 *
 * Use this for untrusted path segments that later become filesystem paths.
 * It rejects slash variants, dot segments, NUL, absolute paths, and Windows
 * drives before callers join them with a trusted root.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function assertSafePathSegment(value: string, label = 'path segment'): string {
  const raw = value.trim();
  if (!raw) throw new Error(`${label} must be a non-empty path segment`);
  const candidates = decodeCandidates(raw);
  for (const candidate of candidates) {
    if (!candidate || candidate === '.' || candidate === '..') {
      throw new Error(`${label} must not be a dot segment`);
    }
    if (
      candidate.includes('\0') ||
      candidate.includes('/') ||
      candidate.includes('\\') ||
      isAbsolute(candidate) ||
      /^[A-Za-z]:/.test(candidate)
    ) {
      throw new Error(`${label} must not contain path separators or absolute paths`);
    }
  }
  return raw;
}

export function resolveContainedPath(root: string, rawPath: string, label = 'path'): string {
  if (!rawPath.trim()) throw new Error(`${label} must be non-empty`);
  const candidates = decodeCandidates(rawPath.trim());
  for (const candidate of candidates) {
    if (
      candidate.includes('\0') ||
      isAbsolute(candidate) ||
      /^[A-Za-z]:/.test(candidate)
    ) {
      throw new Error(`${label} must be relative to its root`);
    }
    for (const part of candidate.replace(/\\/g, '/').split('/')) {
      if (part === '.' || part === '..') throw new Error(`${label} must not contain dot segments`);
    }
  }

  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, rawPath);
  assertInsideRoot(resolvedRoot, resolvedPath, label);
  return resolvedPath;
}

export function safePathJoin(root: string, segment: string, label = 'path segment'): string {
  const safeSegment = assertSafePathSegment(segment, label);
  return resolveContainedPath(root, safeSegment, label);
}

export function assertInsideRoot(root: string, targetPath: string, label = 'path'): void {
  const realRoot = realPathForCheck(resolve(root));
  const realTarget = realPathForCheck(resolve(targetPath));
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realTarget !== realRoot && !realTarget.startsWith(rootWithSep)) {
    throw new Error(`${label} escapes root`);
  }
}

function decodeCandidates(value: string): string[] {
  const out = [value];
  let current = value;
  for (let i = 0; i < 3; i++) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      out.push(decoded);
      current = decoded;
    } catch {
      throw new Error('path segment contains invalid percent encoding');
    }
  }
  return out;
}

function realPathForCheck(path: string): string {
  if (existsSync(path)) return realpathSync(path);

  let ancestor = dirname(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const realAncestor = realpathSync(ancestor);
  const suffix = relative(ancestor, path);
  return suffix ? resolve(realAncestor, suffix) : realAncestor;
}
