/**
 * memware — Antigravity transcript adapter.
 *
 * Antigravity writes a session's steps as JSONL under
 * ~/.gemini/antigravity/brain/<conversation>/.system_generated/logs/transcript.jsonl.
 * Records are flat (no `message` wrapper) and typed by `type` + `source`:
 *
 *   { "step_index": 1, "type": "USER_INPUT", "source": "USER_EXPLICIT",
 *     "content": "<USER_REQUEST>…</USER_REQUEST><ADDITIONAL_METADATA>…</…>" }
 *   { "step_index": 2, "type": "PLANNER_RESPONSE", "source": "MODEL",
 *     "content": "…" }
 *
 * Injected context is handled differently here than in Codex, and the
 * difference decides the whole parsing strategy. Codex files what it injects
 * as SEPARATE records wearing `role: "user"`, so those records must be
 * identified and dropped. Antigravity keeps one record per user turn and wraps
 * the person's own words in `<USER_REQUEST>`, putting its metadata outside
 * that tag — so the work is unwrapping, not filtering. Measured across 276
 * real USER_INPUT records: 100% carry `<USER_REQUEST>`, and
 * `<ADDITIONAL_METADATA>` sits outside it every time, never nested.
 *
 * The hook payload is camelCase (`conversationId`, `transcriptPath`) rather
 * than Claude Code's snake_case, which is why this adapter supplies both the
 * transcript path and the session id.
 */

import type { LastTurn } from "../transcript";

/** Records naming the person's own input. */
const USER_TYPE = "USER_INPUT";
const USER_SOURCE = "USER_EXPLICIT";
/**
 * The model's answer for the turn.
 *
 * Deliberately narrower than "any record whose source is MODEL": `GENERIC` /
 * `MODEL` records (tool narration and intermediate steps) outnumber real
 * replies several to one, and the last one wins. Matching on the type alone
 * keeps intermediate chatter out of the stored assistant message.
 */
const ASSISTANT_TYPE = "PLANNER_RESPONSE";

interface TranscriptEntry {
  step_index?: number;
  source?: string;
  type?: string;
  content?: string;
}

/**
 * Reduce a raw USER_INPUT record to what the person actually wrote.
 *
 * `<USER_REQUEST>` is authoritative when present: everything outside it is
 * Antigravity's own framing. Without it, known metadata blocks are stripped
 * instead, which is the best available fallback for a record shape that does
 * not mark the boundary.
 */
export function cleanAntigravityUserContent(raw: string): string {
  if (!raw) return "";
  const request = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  if (request?.[1] !== undefined) return request[1].trim();

  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, "")
    .trim();
}

/**
 * Strip host-specific wrappers from a model reply.
 *
 * These markers come from the agent persona running inside Antigravity rather
 * than from Antigravity itself, so they are cosmetic: unwrap the reply body
 * and drop reflection blocks that are not part of the answer.
 */
export function cleanAntigravityAssistantContent(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(/<AVATANEL_REPLY>([\s\S]*?)<\/AVATANEL_REPLY>/gi, "$1")
    .replace(/【Reflect Step \d】[\s\S]*?(?=\n\n|$)/gi, "")
    .replace(/【Reflect】[\s\S]*?(?=\n\n|$)/gi, "")
    .trim();
}

/**
 * Parse a transcript body into the last finished turn.
 *
 * Unlike the Claude Code and Codex adapters, a user message alone is not a
 * turn here: Antigravity's Stop fires against a step log that interleaves tool
 * steps, so a user record with no answer after it means the turn is still in
 * flight. Requiring both halves is what keeps half-turns out of memory.
 */
export function extractAntigravityLastTurn(transcriptText: string): LastTurn | null {
  let userMessage = "";
  let assistantMessage = "";
  let userTurns = 0;

  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(trimmed) as TranscriptEntry;
    } catch {
      continue;
    }

    if (entry.type === USER_TYPE || entry.source === USER_SOURCE) {
      const text = cleanAntigravityUserContent(entry.content ?? "");
      if (text) {
        userMessage = text;
        userTurns += 1;
        // A new prompt opens a new turn; any earlier answer belonged to the
        // previous one.
        assistantMessage = "";
      }
      continue;
    }

    if (entry.type === ASSISTANT_TYPE) {
      const text = cleanAntigravityAssistantContent(entry.content ?? "");
      if (text) assistantMessage = text;
    }
  }

  if (!userMessage || !assistantMessage) return null;
  return { userMessage, assistantMessage, turnIndex: Math.max(0, userTurns - 1) };
}

/** Antigravity names the transcript `transcriptPath`, not `transcript_path`. */
export function antigravityTranscriptPathFromPayload(
  hook: Record<string, unknown>,
): string | undefined {
  for (const key of ["transcriptPath", "transcript_path"]) {
    const value = hook[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * The conversation the turn belongs to, which is Antigravity's session id.
 * Returns undefined when the payload omits it, so the caller falls back rather
 * than writing every conversation under one key.
 */
export function antigravitySessionIdFromPayload(
  hook: Record<string, unknown>,
): string | undefined {
  for (const key of ["conversationId", "conversation_id"]) {
    const value = hook[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
