/**
 * avatanel — EvoLoop Workspace Bootstrap
 *
 * Workspace management. Each user gets a top-level workspace at
 * ~/.avatanel/user/<userId>/, and each runtime agent gets a child workspace
 * at ~/.avatanel/user/<userId>/agents/<agentName>/ that follows the
 * current EvoLoop workspace model: Operations / Knowledge / Context /
 * Learning. Persona identity lives in the agent child workspace under
 * persona/settings.json; long-term memory has separate canonical stores.
 *
 * Avatanel-native EvoLoop implementation:
 *   - per-userId scoping (vs single workspace in original)
 *   - persona integration now lives in agent-scoped PersonaStore + runtime prompt assembly
 *   - SkillStore wiring (.skills/active/ replaces global ~/.avatanel/skills/)
 *
 * See docs/architecture/architecture.md and docs/architecture/message-flow.md.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentWorkspaceLayout, PendingRulesFile, InfoSourcesFile } from './types';
import { assertSafePathSegment } from '../../security/pathBoundary';

// ─── Path resolution ─────────────────────────────────────────────────────────

/** Sanitize a workspace path segment so it's safe to use as a directory name. */
function sanitizeWorkspaceSegment(value: string): string {
  assertSafePathSegment(value, 'workspace segment');
  // Allow alphanumeric, dash, underscore, dot. Replace anything else with `_`.
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Sanitize a userId so it's safe to use as a directory name. */
export function sanitizeUserId(userId: string): string {
  return sanitizeWorkspaceSegment(userId);
}

/** Sanitize an agentName so it's safe to use as a directory name. */
export function sanitizeAgentName(agentName: string): string {
  const safe = sanitizeWorkspaceSegment(agentName.trim());
  return safe || 'default';
}

/** Default root for all per-user workspaces. Override via env or config. */
export function defaultUsersRoot(): string {
  return process.env.AVATANEL_USERS_ROOT ?? join(homedir(), '.avatanel', 'user');
}

/** Build the user-level workspace root without creating dirs. */
export function getUserWorkspaceRoot(userId: string, usersRoot = defaultUsersRoot()): string {
  return join(usersRoot, sanitizeUserId(userId));
}

/** Build an agent child workspace root without creating dirs. */
export function getAgentWorkspaceRoot(
  userId: string,
  agentName: string,
  usersRoot = defaultUsersRoot(),
): string {
  return join(getUserWorkspaceRoot(userId, usersRoot), 'agents', sanitizeAgentName(agentName));
}

/** User-scoped memory root. Shared by all agents under the same user. */
export function getUserMemoryRoot(userId: string, usersRoot = defaultUsersRoot()): string {
  return join(getUserWorkspaceRoot(userId, usersRoot), 'memory');
}

/** User-scoped MemLocal SQLite path. */
export function getUserMemoryDbPath(userId: string, usersRoot = defaultUsersRoot()): string {
  return join(getUserMemoryRoot(userId, usersRoot), 'memory.db');
}

/** User-scoped MemLocal vector SQLite path. */
export function getUserMemoryVectorPath(userId: string, usersRoot = defaultUsersRoot()): string {
  return join(getUserMemoryRoot(userId, usersRoot), 'vectors');
}

/** Build the AgentWorkspaceLayout for a given userId (without creating dirs). */
export function getWorkspaceLayout(userId: string, rootOverride?: string): AgentWorkspaceLayout {
  const root = rootOverride ?? getUserWorkspaceRoot(userId);
  return {
    root,
    soulMd:        join(root, 'SOUL.md'),      // legacy, indexed if present
    identityMd:    join(root, 'IDENTITY.md'),  // legacy, indexed if present
    userMd:        join(root, 'USER.md'),      // legacy, indexed if present
    claudeMd:      join(root, 'CLAUDE.md'),    // legacy operations stub, not created
    expressionMd:  join(root, 'EXPRESSION.md'),
    missionMd:     join(root, 'MISSION.md'),
    reflectionMd:  join(root, 'REFLECTION.md'),
    sanitizeRulesMd: join(root, '.learnings', 'SANITIZE_RULES.md'),
    memoryMd:      join(root, 'MEMORY.md'),    // legacy, indexed if present
    memoryDir:     join(root, 'memory'),
    sessionsDir:   join(root, 'sessions'),
    learningsDir:  join(root, '.learnings'),
    errorsMd:      join(root, '.learnings', 'ERRORS.md'),
    learningsMd:   join(root, '.learnings', 'LEARNINGS.md'),
    pendingRulesPath: join(root, '.learnings', 'pending', 'rules.json'),
    infoSourcesPath:  join(root, '.learnings', 'pending', 'info-sources.json'),
    expressionDir: join(root, '.expression'),
    expressionRulesMd:    join(root, '.expression', 'rules.md'),
    expressionExamplesMd: join(root, '.expression', 'examples.md'),
    expressionPendingDir: join(root, '.expression', 'pending'),
    missionsDir:   join(root, '.missions'),
    executionPatternsMd:     join(root, '.missions', 'execution-patterns.md'),
    executionAntipatternsMd: join(root, '.missions', 'execution-antipatterns.md'),
    missionsPendingDir:      join(root, '.missions', 'pending'),
    skillsDir:        join(root, '.skills'),
    skillsActiveDir:  join(root, '.skills', 'active'),
    skillsPendingDir: join(root, '.skills', 'pending'),
    skillsArchiveDir: join(root, '.skills', 'archive'),
    reviewsDir:    join(root, 'reviews'),
    contextDir:    join(root, 'context'),
  };
}

// ─── Template resolution ─────────────────────────────────────────────────────

/** Locate the bundled EvoLoop templates directory. */
function templatesDir(): string {
  // Resolve relative to this source file (works for both Bun and Node + tsx)
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'templates');
}

function readTemplate(name: string): string {
  const path = join(templatesDir(), name);
  return readFileSync(path, 'utf-8');
}

// ─── Directory + file creation ───────────────────────────────────────────────

const BOOTSTRAP_DIRS = (l: AgentWorkspaceLayout): string[] => [
  l.root,
];

const TODAY_ISO = (): string => new Date().toISOString().slice(0, 10);

/**
 * Initialize a per-userId workspace if not already present.
 *
 * Idempotent: re-running on an existing workspace creates only missing
 * pieces and never overwrites existing user-edited files.
 *
 * Returns the layout regardless of whether init was needed.
 */
export interface InitWorkspaceOptions {
  userId: string;
  /** Override the concrete workspace root. */
  rootOverride?: string;
}

export function initWorkspace(opts: InitWorkspaceOptions): AgentWorkspaceLayout {
  const layout = getWorkspaceLayout(opts.userId, opts.rootOverride);

  // 1. Create only the root. Feature directories are created by the files or
  // first write that need them, so bootstrap does not leave empty runtime
  // scaffolding such as context/, reviews/, sessions/, or pending queues.
  for (const dir of BOOTSTRAP_DIRS(layout)) {
    mkdirSync(dir, { recursive: true });
  }

  // 2. Write phase template files (EXPRESSION/MISSION/REFLECTION/SANITIZE)
  //    These are static and bundled; users may edit them post-init.
  writeIfMissing(layout.expressionMd, readTemplate('EXPRESSION.md'));
  writeIfMissing(layout.missionMd, readTemplate('MISSION.md'));
  writeIfMissing(layout.reflectionMd, readTemplate('REFLECTION.md'));
  writeIfMissing(layout.sanitizeRulesMd, readTemplate('SANITIZE_RULES.md'));

  // 3. Write formal knowledge skeleton files that still participate in the
  // current review pipeline. Do not create legacy identity/operations files,
  // an empty MEMORY.md, or memory/: persona lives in PersonaStore/runtime prompt
  // assembly, workspace operations guidance lives in repo docs, and long-term
  // memory lives in SQLite + vectors. Existing legacy memory files are still
  // indexed by HistoryIndex for compatibility.
  writeIfMissing(layout.errorsMd, '# ERRORS\n\nReal errors observed during agent operation. Direct-write channel.\n');
  writeIfMissing(layout.learningsMd, '# LEARNINGS\n\nVerified, reusable behavior experience. Direct-write channel.\n');
  writeIfMissing(layout.expressionRulesMd, '# .expression/rules.md\n\nApproved expression rules. Cron-promoted from `pending/`.\n');
  writeIfMissing(layout.expressionExamplesMd, '# .expression/examples.md\n\nApproved expression examples. Cron-promoted from `pending/`.\n');
  writeIfMissing(layout.executionPatternsMd, '# execution-patterns.md\n\nVerified solution patterns. Cron-promoted from `pending/`.\n');
  writeIfMissing(layout.executionAntipatternsMd, '# execution-antipatterns.md\n\nKnown anti-patterns. Cron-promoted from `pending/`.\n');

  // 4. Initialize JSON pending stores
  writeIfMissing(layout.pendingRulesPath, JSON.stringify({
    version: TODAY_ISO(),
    rules: [],
  } satisfies PendingRulesFile, null, 2) + '\n');

  writeIfMissing(layout.infoSourcesPath, JSON.stringify({
    version: TODAY_ISO(),
    sources: [],
  } satisfies InfoSourcesFile, null, 2) + '\n');

  // 5. Drop an info-sources example file as inspiration (NOT loaded automatically)
  writeIfMissing(
    join(layout.learningsDir, 'pending', 'info-sources.example.json'),
    INFO_SOURCES_EXAMPLE,
  );

  return layout;
}

function writeIfMissing(path: string, content: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

// ─── Default content ─────────────────────────────────────────────────────────

const INFO_SOURCES_EXAMPLE = `{
  "version": "${TODAY_ISO()}",
  "sources": [
    {
      "name": "Anthropic Engineering Blog",
      "instructions": "https://www.anthropic.com/engineering/rss",
      "kind": "rss",
      "enabled": false,
      "focus": "agent design patterns, prompt engineering tips, model behavior changes",
      "added_at": "${new Date().toISOString()}"
    },
    {
      "name": "OpenAI Cookbook",
      "instructions": "https://github.com/openai/openai-cookbook",
      "kind": "github",
      "enabled": false,
      "focus": "new tool-use recipes, evaluation patterns",
      "added_at": "${new Date().toISOString()}"
    }
  ]
}
`;
