/**
 * memware — transcript adapter entry point (`memware/adapters`).
 *
 * Everything an embedder needs to turn an agent's Stop-hook payload into the
 * last finished turn, with no memware runtime attached: no storage, no MCP, no
 * model client, no environment. Only `node:fs` is touched, and only through the
 * injectable `readFile` parameter of {@link resolveHookTurn}.
 *
 * Exists so other repos (and memware's own hook mode) consume ONE definition of
 * the capture path instead of re-deriving it per host.
 */

import { readFileSync } from "node:fs";
import { extractLastTurn, type LastTurn } from "./transcript";
import { extractCodexLastTurn, extractCodexTurnFromPayload } from "./transcripts/codex";
import { getAdapter, type TranscriptAdapter } from "./transcripts";

export type { LastTurn, TranscriptAdapter };
export { extractLastTurn, extractCodexLastTurn, extractCodexTurnFromPayload, getAdapter };
/** Claude Code's transcript parser under an agent-explicit name. */
export { extractLastTurn as extractClaudeCodeLastTurn };

/** Minimal shape of a Stop-hook payload: extra fields are passed through. */
export type HookPayload = { session_id?: string; transcript_path?: string } & Record<string, unknown>;

export type ResolvedHookTurn =
  | { turn: LastTurn; sessionId: string }
  | { turn: null; reason: string; detail?: unknown };

/**
 * Resolve the last turn for one hook invocation using the agent's adapter:
 * prefer a transcript file when the payload carries one, otherwise let the
 * adapter pull the turn inline from the payload (e.g. Codex notify).
 * Returns `turn: null` with a reason when nothing usable is found.
 *
 * @param readFile injected file reader — defaults to `readFileSync`, so hosts
 *   with a virtual transcript source (or tests) never touch the real disk.
 */
export function resolveHookTurn(
  agentId: string,
  hook: HookPayload,
  readFile: (path: string, encoding: "utf8") => string = readFileSync,
): ResolvedHookTurn {
  const adapter = getAdapter(agentId);
  const sessionId = hook.session_id ?? `memware-hook-${agentId}`;

  if (hook.transcript_path) {
    let transcriptText: string;
    try {
      transcriptText = readFile(hook.transcript_path, "utf8");
    } catch (err) {
      return { turn: null, reason: "transcript-unreadable", detail: err };
    }
    if (!adapter.extractLastTurn) {
      return { turn: null, reason: `adapter-without-transcript-support:${adapter.id}` };
    }
    const turn = adapter.extractLastTurn(transcriptText);
    return turn ? { turn, sessionId } : { turn: null, reason: "no-user-turn" };
  }

  if (adapter.extractFromHookPayload) {
    const turn = adapter.extractFromHookPayload(hook);
    return turn ? { turn, sessionId } : { turn: null, reason: "no-user-turn" };
  }
  return { turn: null, reason: "no-transcript-path" };
}
