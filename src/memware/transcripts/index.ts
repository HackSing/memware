/**
 * memware — per-agent transcript adapters.
 *
 * Each agent client surfaces its "last finished turn" differently:
 *   • Claude Code Stop hook  → `transcript_path` pointing at a JSONL file.
 *   • Codex `notify`         → turn payload inline in the hook JSON itself
 *     (`input-messages` / `last-assistant-message`, no transcript file).
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
}

const claudeCode: TranscriptAdapter = { id: "claude-code", extractLastTurn };
const codex: TranscriptAdapter = {
  id: "codex",
  extractLastTurn: extractCodexLastTurn,
  extractFromHookPayload: extractCodexTurnFromPayload,
  sessionIdFromTranscript: extractCodexSessionId,
  sessionIdFromHookPayload: codexSessionIdFromPayload,
};

const ADAPTERS: ReadonlyMap<string, TranscriptAdapter> = new Map([
  [claudeCode.id, claudeCode],
  [codex.id, codex],
]);

/**
 * Resolve the adapter for an agent id. Unregistered ids (including "unknown")
 * get the Claude Code transcript parser — the generic JSONL shape.
 */
export function getAdapter(agentId: string): TranscriptAdapter {
  return ADAPTERS.get(agentId) ?? claudeCode;
}
