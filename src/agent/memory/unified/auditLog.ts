/**
 * JSONL audit log for the unified memory extractor.
 *
 * One line per turn at:
 *   - workspace: <root>/.unified-extraction-log/<YYYY-MM-DD>.jsonl
 *   - no workspace fallback: ~/.avatanel/.unified-extraction-log/<userId>/<YYYY-MM-DD>.jsonl
 *
 * Best-effort append; failure never throws to caller.
 *
 * RouteAction types live HERE (not in router.ts) — router imports from
 * here so the audit-log entry can reference RouteAction[] without a
 * circular import (P3.1 clarification).
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { UnifiedMemoryExtraction } from './schema';

export interface StructuredError {
  stage: 'extract' | 'route';
  message: string;
  path?: string;
  received?: unknown;
}

export type RouteAction =
  | { kind: 'memory_cluster';        detail: string }
  | { kind: 'profile_update';        detail: string }
  | { kind: 'language_update';       detail: string }
  | { kind: 'profile_suppressed';    detail: string }
  | { kind: 'profile_failed';        detail: string }
  | { kind: 'active_thread';         detail: string }
  | { kind: 'active_thread_blocked'; detail: string }
  | { kind: 'active_thread_failed';  detail: string }
  | { kind: 'focus_update';          detail: string }
  | { kind: 'focus_failed';          detail: string }
  | { kind: 'relationship_update';   detail: string }
  | { kind: 'relationship_blocked';  detail: string }
  | { kind: 'relationship_failed';   detail: string }
  | { kind: 'pending_rule';          detail: string }
  | { kind: 'expression_pending';    detail: string }
  | { kind: 'mission_pending';       detail: string }
  | { kind: 'error_logged';          detail: string }
  | { kind: 'learning_logged';       detail: string }
  | { kind: 'cluster_failed';        detail: string }
  | { kind: 'workspace_failed';      detail: string }
  // [P3] dedicated "blocked by gate" markers for memory_clusters and focus.
  // Distinct from *_failed kinds (which signal real sink exceptions).
  | { kind: 'cluster_blocked';       detail: string }
  | { kind: 'focus_blocked';         detail: string };

export interface AuditLogEntry {
  ts: string;
  sessionId: string;
  turnIndex: number;
  userId: string;
  userMessageDigest: string;
  payload: UnifiedMemoryExtraction;
  actions: RouteAction[];
  errors: StructuredError[];
  durationMs: number;
  mode: 'live';
}

export class AuditLogWriter {
  private readonly baseDir: string;
  private dirEnsured = false;

  constructor(
    baseDir: string,
    private readonly options: { privateMode?: boolean } = {},
  ) {
    this.baseDir = baseDir;
  }

  append(entry: AuditLogEntry): void {
    try {
      if (!this.dirEnsured) {
        mkdirSync(this.baseDir, {
          recursive: true,
          ...(this.options.privateMode ? { mode: 0o700 } : {}),
        });
        if (this.options.privateMode) chmodSync(this.baseDir, 0o700);
        this.dirEnsured = true;
      }
      // File routing must use a local trusted clock, never model-controlled
      // event.ts. The event timestamp remains inside the JSON payload for audit.
      const date = new Date().toISOString().slice(0, 10);
      const path = join(this.baseDir, `${date}.jsonl`);
      if (this.options.privateMode) {
        const dir = lstatSync(this.baseDir);
        if (dir.isSymbolicLink() || !dir.isDirectory()) throw new Error('unsafe private audit directory');
        const fd = openSync(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fchmodSync(fd, 0o600);
          writeSync(fd, JSON.stringify(entry) + '\n', undefined, 'utf8');
        } finally {
          closeSync(fd);
        }
      } else {
        appendFileSync(path, JSON.stringify(entry) + '\n', 'utf8');
      }
    } catch {
      // Audit log failures must NEVER break a turn.
    }
  }

  flush(): void {}
}

/** Workspace-relative audit log dir. */
export function auditLogDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.unified-extraction-log');
}
