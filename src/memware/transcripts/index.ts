/**
 * memware — per-agent transcript adapters.
 *
 * Each agent client surfaces its "last finished turn" differently:
 *   • Claude Code Stop hook  → `transcript_path` pointing at a JSONL file.
 *   • Codex Stop hook        → the same, plus `session_id` (its `notify` hook
 *     instead inlines the turn as `input-messages` / `last-assistant-message`
 *     with no transcript file).
 *   • Antigravity Stop hook  → camelCase `transcriptPath` / `conversationId`,
 *     and it wants a decision object written back on stdout.
 *
 * An adapter may implement either entry point (or both). Unknown agent ids
 * fall back to the Claude Code transcript parser, which is the most common
 * on-disk shape ({message:{role,content}} JSONL). Parsers stay defensive:
 * malformed lines are skipped, never thrown — hook mode must never block.
 *
 * Session identity is a second, optional axis. Claude Code hands its
 * `session_id` to the hook directly, so its adapter needs nothing; agents that
 * do not (Codex notify) can derive one from the source instead of letting the
 * caller fall back to a per-agent constant. See `resolveHookTurn` for the
 * resolution order and codex.ts for why a constant is not survivable.
 */

import { extractLastTurn, type LastTurn } from "../transcript";
import {
  antigravitySessionIdFromPayload,
  antigravityTranscriptPathFromPayload,
  extractAntigravityLastTurn,
} from "./antigravity";
import {
  codexSessionIdFromPayload,
  extractCodexLastTurn,
  extractCodexSessionId,
  extractCodexTurnFromPayload,
} from "./codex";

export interface TranscriptAdapter {
  /** Matches a MEMWARE_AGENT_ID value (e.g. "claude-code", "codex"). */
  readonly id: string;
  /** Parse a transcript file body into the last turn. */
  extractLastTurn?(transcriptText: string): LastTurn | null;
  /** Parse the hook payload itself into a turn (inline-payload agents). */
  extractFromHookPayload?(hook: Record<string, unknown>): LastTurn | null;
  /** Session id carried by the transcript body itself, when it has one. */
  sessionIdFromTranscript?(transcriptText: string): string | undefined;
  /** Session id derivable from the hook payload, when the hook omits one. */
  sessionIdFromHookPayload?(hook: Record<string, unknown>): string | undefined;
  /** Transcript location for hosts that do not use `transcript_path`. */
  transcriptPathFromHookPayload?(hook: Record<string, unknown>): string | undefined;
  /**
   * Exact stdout the host requires on success. Claude Code and Codex accept an
   * empty stdout with exit 0; hosts that parse a response declare it here.
   */
  readonly hookResponse?: string;
  /**
   * Skip a turn already written under the same session. Only for hosts whose
   * stop event can fire more than once for one finished turn.
   */
  readonly dedupeTurns?: boolean;
}

const claudeCode: TranscriptAdapter = { id: "claude-code", extractLastTurn };
const codex: TranscriptAdapter = {
  id: "codex",
  extractLastTurn: extractCodexLastTurn,
  extractFromHookPayload: extractCodexTurnFromPayload,
  sessionIdFromTranscript: extractCodexSessionId,
  sessionIdFromHookPayload: codexSessionIdFromPayload,
};
const antigravity: TranscriptAdapter = {
  id: "antigravity",
  extractLastTurn: extractAntigravityLastTurn,
  sessionIdFromHookPayload: antigravitySessionIdFromPayload,
  transcriptPathFromHookPayload: antigravityTranscriptPathFromPayload,
  // Antigravity's lifecycle engine wants a decision object back, and it can
  // re-fire Stop for one finished turn — hence both opt-ins.
  hookResponse: JSON.stringify({ decision: "" }),
  dedupeTurns: true,
};

const ADAPTERS: ReadonlyMap<string, TranscriptAdapter> = new Map([
  [claudeCode.id, claudeCode],
  [codex.id, codex],
  [antigravity.id, antigravity],
]);

/**
 * Resolve the adapter for an agent id. Unregistered ids (including "unknown")
 * get the Claude Code transcript parser — the generic JSONL shape.
 */
export function getAdapter(agentId: string): TranscriptAdapter {
  return ADAPTERS.get(agentId) ?? claudeCode;
}
