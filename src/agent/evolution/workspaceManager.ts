/**
 * avatanel — EvoLoop Workspace Manager
 *
 * High-level read/write API on top of getWorkspaceLayout(). Wraps the
 * file system so callers don't need to remember pending queue formats
 * (JSON object vs JSONL append) or directory layouts.
 *
 * Pending channels (must pass cron review before promotion):
 *   - appendPendingRule         → .learnings/pending/rules.json
 *   - appendPendingExpression   → .expression/pending/YYYY-MM-DD.jsonl
 *   - appendPendingMission      → .missions/pending/YYYY-MM-DD.jsonl
 *   - writePendingSkill         → .skills/pending/<name>.md
 *
 * Direct-write channels (high-confidence, no review):
 *   - appendError               → .learnings/ERRORS.md
 *   - appendLearning            → .learnings/LEARNINGS.md
 */

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  initWorkspace,
  getWorkspaceLayout,
} from './workspace';
import type {
  AgentWorkspaceLayout,
  PendingRule,
  PendingRulesFile,
  InfoSource,
  InfoSourcesFile,
  PendingExpressionEvent,
  PendingMissionEvent,
  PendingSkill,
  PendingSkillSink,
  ReviewLogEntry,
  SessionStagingEntry,
} from './types';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const todayISO = (): string => new Date().toISOString().slice(0, 10);
const nowISO = (): string => new Date().toISOString();

export type WorkspaceMutationKind =
  | 'pending-rules'
  | 'info-sources'
  | 'expression-pending'
  | 'mission-pending'
  | 'skill-pending'
  | 'errors'
  | 'learnings'
  | 'review-log';

export interface WorkspaceMutation {
  kind: WorkspaceMutationKind;
  path: string;
}

export type WorkspaceMutationListener = (mutation: WorkspaceMutation) => void;

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; }
  catch { return fallback; }
}

function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* noop */ }
    throw err;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileAtomic(path, JSON.stringify(value, null, 2) + '\n');
}

function appendJsonl(path: string, line: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n', 'utf-8');
}

function appendMarkdown(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const prefix = existsSync(path) ? '' : '# ' + path.split('/').pop() + '\n\n';
  appendFileSync(path, prefix + body + (body.endsWith('\n') ? '' : '\n'), 'utf-8');
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class WorkspaceManager implements PendingSkillSink {
  readonly userId: string;
  readonly layout: AgentWorkspaceLayout;
  private readonly onMutation: WorkspaceMutationListener | null;

  constructor(userId: string, opts?: {
    rootOverride?: string;
    autoInit?: boolean;
    onMutation?: WorkspaceMutationListener;
  }) {
    this.userId = userId;
    this.layout = getWorkspaceLayout(userId, opts?.rootOverride);
    this.onMutation = opts?.onMutation ?? null;
    if (opts?.autoInit !== false) {
      this.ensureInit();
    }
  }

  /** Idempotent init. Safe to call multiple times. */
  ensureInit(): void {
    initWorkspace({ userId: this.userId, rootOverride: this.layout.root });
  }

  // ── Pending: behavior rules ────────────────────────────────────────────────

  loadPendingRules(): PendingRulesFile {
    return readJson<PendingRulesFile>(this.layout.pendingRulesPath, {
      version: todayISO(),
      rules: [],
    });
  }

  savePendingRules(file: PendingRulesFile): void {
    writeJson(this.layout.pendingRulesPath, file);
    this.emitMutation('pending-rules', this.layout.pendingRulesPath);
  }

  /** Append a rule. Auto-generates `id` if not provided. Returns the assigned id. */
  appendPendingRule(rule: Omit<PendingRule, 'id' | 'created_at' | 'status' | 'reviewed_at' | 'review_note'> & {
    id?: string;
  }): string {
    const file = this.loadPendingRules();
    const id = rule.id ?? this.nextRuleId(file);
    const full: PendingRule = {
      id,
      source: rule.source,
      source_detail: rule.source_detail,
      created_at: nowISO(),
      content: rule.content,
      reason: rule.reason,
      target_files: rule.target_files,
      status: 'pending',
      reviewed_at: '',
      review_note: '',
    };
    file.rules.push(full);
    this.savePendingRules(file);
    return id;
  }

  private nextRuleId(file: PendingRulesFile): string {
    const today = todayISO().replace(/-/g, '');
    const todays = file.rules.filter((r) => r.id.includes(today));
    const seq = String(todays.length + 1).padStart(3, '0');
    return `pending_${today}_${seq}`;
  }

  // ── Info sources ───────────────────────────────────────────────────────────

  loadInfoSources(): InfoSourcesFile {
    return readJson<InfoSourcesFile>(this.layout.infoSourcesPath, {
      version: todayISO(),
      sources: [],
    });
  }

  saveInfoSources(file: InfoSourcesFile): void {
    writeJson(this.layout.infoSourcesPath, file);
    this.emitMutation('info-sources', this.layout.infoSourcesPath);
  }

  addInfoSource(source: Omit<InfoSource, 'added_at'> & { added_at?: string }): void {
    const file = this.loadInfoSources();
    file.sources.push({ ...source, added_at: source.added_at ?? nowISO() });
    this.saveInfoSources(file);
  }

  // ── Pending: expression / mission events ───────────────────────────────────

  appendPendingExpression(event: Omit<PendingExpressionEvent, 'ts' | 'type'>): void {
    const path = eventFilePath(this.layout.expressionPendingDir, nowISO());
    appendJsonl(path, { ts: nowISO(), type: 'expression', ...event });
    this.emitMutation('expression-pending', path);
  }

  appendPendingMission(event: Omit<PendingMissionEvent, 'ts' | 'type'>): void {
    const path = eventFilePath(this.layout.missionsPendingDir, nowISO());
    appendJsonl(path, { ts: nowISO(), type: 'mission', ...event });
    this.emitMutation('mission-pending', path);
  }

  mergePendingExpression(event: PendingExpressionEvent): boolean {
    const path = eventFilePath(this.layout.expressionPendingDir, event.ts);
    if (pendingEventExists(path, event)) return false;
    appendJsonl(path, event);
    this.emitMutation('expression-pending', path);
    return true;
  }

  mergePendingMission(event: PendingMissionEvent): boolean {
    const path = eventFilePath(this.layout.missionsPendingDir, event.ts);
    if (pendingEventExists(path, event)) return false;
    appendJsonl(path, event);
    this.emitMutation('mission-pending', path);
    return true;
  }

  /** List pending event files (jsonl) by date filter. */
  listPendingExpressionFiles(): string[] {
    return safeReaddir(this.layout.expressionPendingDir).filter((f) => f.endsWith('.jsonl'));
  }
  listPendingMissionFiles(): string[] {
    return safeReaddir(this.layout.missionsPendingDir).filter((f) => f.endsWith('.jsonl'));
  }

  // ── Pending: skills ────────────────────────────────────────────────────────

  /** Write a candidate skill to .skills/pending/<name>.md. Returns the path. */
  writePendingSkill(skill: PendingSkill): string {
    const safeName = skill.frontmatter.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(this.layout.skillsPendingDir, `${safeName}.md`);
    const fm = skill.frontmatter;
    const yaml = [
      '---',
      `name: ${fm.name}`,
      `description: ${JSON.stringify(fm.description)}`,
      fm.category ? `category: ${fm.category}` : null,
      `status: ${fm.status}`,
      `source: ${fm.source}`,
      `source_detail: ${JSON.stringify(fm.source_detail)}`,
      `created_at: ${fm.created_at}`,
      fm.reviewed_at ? `reviewed_at: ${fm.reviewed_at}` : null,
      fm.review_note ? `review_note: ${JSON.stringify(fm.review_note)}` : null,
      '---',
      '',
    ].filter(Boolean).join('\n');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, yaml + skill.body, 'utf-8');
    this.emitMutation('skill-pending', path);
    return path;
  }

  mergePendingSkill(skill: PendingSkill): string | null {
    const safeName = skill.frontmatter.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${safeName}.md`;
    if (this.listPendingSkills().includes(fileName) || this.listActiveSkills().includes(fileName)) {
      return null;
    }
    return this.writePendingSkill({
      ...skill,
      frontmatter: {
        ...skill.frontmatter,
        name: safeName,
      },
    });
  }

  /** List pending skill markdown filenames (basenames). */
  listPendingSkills(): string[] {
    return safeReaddir(this.layout.skillsPendingDir).filter((f) => f.endsWith('.md'));
  }

  /** List active (approved) skill markdown filenames (basenames). */
  listActiveSkills(): string[] {
    return safeReaddir(this.layout.skillsActiveDir).filter((f) => f.endsWith('.md'));
  }

  mergePendingRule(rule: PendingRule): { id: string; merged: boolean } {
    const file = this.loadPendingRules();
    if (file.rules.some((existing) => existing.id === rule.id)) {
      return { id: rule.id, merged: false };
    }
    file.rules.push({ ...rule });
    this.savePendingRules(file);
    return { id: rule.id, merged: true };
  }

  listSessionStagingEntries(): SessionStagingEntry[] {
    if (!existsSync(this.layout.sessionsDir)) return [];
    const entries: SessionStagingEntry[] = [];
    try {
      for (const dirent of readdirSync(this.layout.sessionsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const sessionId = dirent.name;
        const sessionDir = join(this.layout.sessionsDir, sessionId);
        for (const child of safeReaddir(sessionDir)) {
          if (child !== 'staging' && !child.startsWith('staging.sweep.')) continue;
          const root = join(sessionDir, child);
          if (!existsSync(root)) continue;
          entries.push({
            sessionId,
            root,
            state: child === 'staging' ? 'live' : 'snapshot',
          });
        }
      }
    } catch {
      return [];
    }
    return entries;
  }

  // ── Direct-write channels ──────────────────────────────────────────────────

  /** Append a real error event to .learnings/ERRORS.md. */
  appendError(content: string): void {
    appendMarkdown(this.layout.errorsMd, `## ${nowISO()}\n\n${content}\n`);
    this.emitMutation('errors', this.layout.errorsMd);
  }

  /** Append a verified, reusable behavior to .learnings/LEARNINGS.md. */
  appendLearning(content: string): void {
    appendMarkdown(this.layout.learningsMd, `## ${nowISO()}\n\n${content}\n`);
    this.emitMutation('learnings', this.layout.learningsMd);
  }

  // ── Review log ─────────────────────────────────────────────────────────────

  appendReviewLog(entry: ReviewLogEntry): void {
    const date = entry.ts.slice(0, 10);
    const path = join(this.layout.reviewsDir, `${date}.md`);
    const line = [
      `## ${entry.ts} — ${entry.queue}/${entry.itemId}`,
      `- decision: **${entry.decision}**`,
      `- reviewer: ${entry.reviewer}`,
      `- note: ${entry.note}`,
      entry.promotedTo ? `- promoted to: \`${entry.promotedTo}\`` : null,
      '',
    ].filter(Boolean).join('\n') + '\n';
    appendMarkdown(path, line);
    this.emitMutation('review-log', path);
  }

  private emitMutation(kind: WorkspaceMutationKind, path: string): void {
    try { this.onMutation?.({ kind, path }); } catch { /* noop */ }
  }
}

function safeReaddir(dir: string): string[] {
  try { return existsSync(dir) ? readdirSync(dir) : []; }
  catch { return []; }
}

function eventFilePath(dir: string, isoTs: string): string {
  const day = isoTs.slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/) ? isoTs.slice(0, 10) : todayISO();
  return join(dir, `${day}.jsonl`);
}

function pendingEventExists<T extends PendingExpressionEvent | PendingMissionEvent>(path: string, event: T): boolean {
  if (!existsSync(path)) return false;
  try {
    const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
    const serialized = JSON.stringify(event);
    return lines.some((line) => line === serialized);
  } catch {
    return false;
  }
}
