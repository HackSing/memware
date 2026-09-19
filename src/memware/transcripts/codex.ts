/**
 * memware — Codex transcript adapter.
 *
 * Codex (`codex-rs`) persists sessions as rollout JSONL under
 * ~/.codex/sessions/<date>/rollout-*.jsonl. Three record shapes matter:
 *
 *   { "type": "session_meta", "payload": { "session_id": "019d37df-...", ... } }
 *
 *   { "type": "response_item", "payload": { "type": "message",
 *       "role": "user"|"assistant",
 *       "content": [{ "type": "input_text"|"output_text", "text": "..." }] } }
 *
 * and its `notify` hook payload (no transcript file), which inlines the turn:
 *
 *   { "type": "agent-turn-complete", "turn-id": "...",
 *     "input-messages": ["..."], "last-assistant-message": "..." }
 *
 * Session identity differs between the two sources, and the difference is
 * load-bearing for provenance:
 *
 *   • A rollout file names the real `session_id` in its `session_meta` header,
 *     so every turn of that session shares one id and turn indexes are ordinal.
 *   • A notify payload carries NO session id — only a per-turn `turn-id`. The
 *     turn is therefore its own provenance scope (`codex-turn-<id>`, index 0).
 *     Stitching consecutive notify calls into a session would fabricate a
 *     boundary Codex never reported; a per-turn scope is the largest unit the
 *     payload actually supports.
 *
 * Without a derived id both sources fall back to one constant, which collapses
 * every Codex write onto a single `(session_id, turn_index)` pair — the exact
 * scope `deleteByProvenance` deletes by.
 *
 * The format has no frozen spec, so everything here is defensive: unknown
 * shapes are skipped, both kebab-case and snake_case hook keys are accepted,
 * and no code path throws. As with transcript.ts, only the last non-empty
 * user/assistant pair is returned.
 */

import { createHash } from "node:crypto";
import type { LastTurn } from "../transcript";

interface CodexContentBlock {
  type?: string;
  text?: string;
}

function textFromBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is CodexContentBlock =>
        !!b && typeof b === "object" && typeof (b as CodexContentBlock).text === "string",
    )
    .map((b) => (b as CodexContentBlock).text ?? "")
    .join("")
    .trim();
}

function roleAndText(entry: unknown): { role: string; text: string } | null {
  if (!entry || typeof entry !== "object") return null;
  // response_item wrapper → payload.message; also accept a bare message object.
  const payload = (entry as { payload?: unknown }).payload ?? entry;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as { type?: unknown; role?: unknown; content?: unknown };
  if (record.type !== undefined && record.type !== "message") return null;
  if (typeof record.role !== "string") return null;
  if (record.role !== "user" && record.role !== "assistant") return null;
  return { role: record.role, text: textFromBlocks(record.content) };
}

/** Parse a rollout JSONL body into the final user/assistant turn. */
export function extractCodexLastTurn(rolloutText: string): LastTurn | null {
  let userMessage = "";
  let assistantMessage = "";
  let userTurns = 0;

  for (const line of rolloutText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = roleAndText(entry);
    if (!parsed || !parsed.text) continue;
    if (parsed.role === "user") {
      userMessage = parsed.text;
      userTurns += 1;
    } else {
      assistantMessage = parsed.text;
    }
  }

  if (!userMessage) return null;
  return { userMessage, assistantMessage, turnIndex: Math.max(0, userTurns - 1) };
}

/**
 * Read the rollout's own session id from its `session_meta` header record.
 * Returns undefined for a body without one (older rollouts, truncated files),
 * leaving the caller to fall back.
 */
export function extractCodexSessionId(rolloutText: string): string | undefined {
  for (const line of rolloutText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { type?: unknown }).type !== "session_meta") continue;
    const payload = (entry as { payload?: unknown }).payload;
    if (!payload || typeof payload !== "object") continue;
    const meta = payload as { session_id?: unknown; id?: unknown };
    for (const candidate of [meta.session_id, meta.id]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  }
  return undefined;
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textFromBlocks(item);
      if (text) return text;
    }
  }
  return "";
}

function keyOf(hook: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (hook[name] !== undefined) return hook[name];
  }
  return undefined;
}

/**
 * Build a turn straight from a Codex `notify` hook payload
 * (agent-turn-complete). Returns null when the payload carries no usable
 * user input — a lone assistant message is not attributable to a turn.
 *
 * `turnIndex` is 0 because the id this turn gets scoped under
 * ({@link codexSessionIdFromPayload}) identifies the turn itself: inside that
 * scope, this is the only turn there is.
 */
export function extractCodexTurnFromPayload(hook: Record<string, unknown>): LastTurn | null {
  const userMessage = firstString(keyOf(hook, "input-messages", "input_messages"));
  const assistantMessage = firstString(
    keyOf(hook, "last-assistant-message", "last_assistant_message"),
  );
  if (!userMessage) return null;
  return { userMessage, assistantMessage, turnIndex: 0 };
}

/**
 * Derive the provenance scope for one Codex `notify` payload.
 *
 * Prefers the payload's `turn-id`. When that is absent, hashes the turn's own
 * text rather than giving up: a content-derived id is still unique per turn,
 * and it is stable across a replayed notify, so a retry re-stamps the same
 * provenance instead of piling up rows nothing can tell apart. Returns
 * undefined only when there is no turn to scope.
 */
export function codexSessionIdFromPayload(hook: Record<string, unknown>): string | undefined {
  const turnId = firstString(keyOf(hook, "turn-id", "turn_id"));
  if (turnId) return `codex-turn-${turnId}`;

  const turn = extractCodexTurnFromPayload(hook);
  if (!turn) return undefined;
  const digest = createHash("sha256")
    .update(`${turn.userMessage}\u0000${turn.assistantMessage}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `codex-turn-h${digest}`;
}
