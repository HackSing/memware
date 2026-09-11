/**
 * memware — Codex transcript adapter.
 *
 * Codex (`codex-rs`) persists sessions as rollout JSONL under
 * ~/.codex/sessions/<date>/rollout-*.jsonl. Two record shapes matter:
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
 * The format has no frozen spec, so everything here is defensive: unknown
 * shapes are skipped, both kebab-case and snake_case hook keys are accepted,
 * and no code path throws. As with transcript.ts, only the last non-empty
 * user/assistant pair is returned.
 */

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
 */
export function extractCodexTurnFromPayload(hook: Record<string, unknown>): LastTurn | null {
  const userMessage = firstString(keyOf(hook, "input-messages", "input_messages"));
  const assistantMessage = firstString(
    keyOf(hook, "last-assistant-message", "last_assistant_message"),
  );
  if (!userMessage) return null;
  return { userMessage, assistantMessage, turnIndex: 0 };
}
