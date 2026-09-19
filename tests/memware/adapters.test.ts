/**
 * memware/adapters — the zero-runtime capture entry point (acceptance c5).
 *
 * Asserts the exported surface and that resolveHookTurn takes its file reader
 * by injection (no disk access in embedders or tests).
 */

import { test, expect } from "bun:test";
import {
  codexSessionIdFromPayload,
  extractClaudeCodeLastTurn,
  extractCodexLastTurn,
  extractCodexSessionId,
  extractCodexTurnFromPayload,
  extractLastTurn,
  fallbackSessionId,
  getAdapter,
  resolveHookTurn,
} from "../../src/memware/adapters";

/** Session id of a resolution that produced a turn; null when it did not. */
function sessionIdOf(resolved: ReturnType<typeof resolveHookTurn>): string | null {
  return resolved.turn ? resolved.sessionId : null;
}

const TRANSCRIPT = [
  JSON.stringify({ message: { role: "user", content: "记住我喜欢简洁输出" } }),
  JSON.stringify({ message: { role: "assistant", content: "好的" } }),
].join("\n");

test("the entry point exposes the whole capture surface", () => {
  expect(typeof extractLastTurn).toBe("function");
  expect(extractClaudeCodeLastTurn).toBe(extractLastTurn);
  expect(typeof extractCodexLastTurn).toBe("function");
  expect(typeof extractCodexTurnFromPayload).toBe("function");
  expect(typeof extractCodexSessionId).toBe("function");
  expect(typeof codexSessionIdFromPayload).toBe("function");
  expect(typeof fallbackSessionId).toBe("function");
  expect(getAdapter("claude-code").id).toBe("claude-code");
  expect(getAdapter("codex").id).toBe("codex");
  expect(getAdapter("nobody").id).toBe("claude-code");
});

test("resolveHookTurn reads the transcript through the injected reader", () => {
  const reads: string[] = [];
  const resolved = resolveHookTurn(
    "claude-code",
    { session_id: "s-1", transcript_path: "/virtual/transcript.jsonl" },
    (path) => {
      reads.push(path);
      return TRANSCRIPT;
    },
  );

  expect(reads).toEqual(["/virtual/transcript.jsonl"]);
  expect(resolved.turn?.userMessage).toBe("记住我喜欢简洁输出");
  expect(resolved.turn && "sessionId" in resolved ? resolved.sessionId : null).toBe("s-1");
});

test("an unreadable transcript is reported, never thrown", () => {
  const resolved = resolveHookTurn("claude-code", { transcript_path: "/virtual/missing.jsonl" }, () => {
    throw new Error("ENOENT");
  });

  expect(resolved.turn).toBeNull();
  expect(resolved.turn === null ? resolved.reason : "").toBe("transcript-unreadable");
});

test("inline-payload agents resolve without a transcript file", () => {
  const resolved = resolveHookTurn("codex", {
    "input-messages": ["帮我总结一下"],
    "last-assistant-message": "好的，总结如下",
  });

  expect(resolved.turn?.userMessage).toBe("帮我总结一下");
});

test("two Codex notify turns never share a session id", () => {
  // Regression: both once resolved to the constant `memware-hook-codex` with
  // turnIndex 0, collapsing every Codex write onto one provenance key — the
  // scope deleteByProvenance deletes by.
  const first = resolveHookTurn("codex", {
    type: "agent-turn-complete",
    "turn-id": "t-1",
    "input-messages": ["第一轮"],
    "last-assistant-message": "第一答",
  });
  const second = resolveHookTurn("codex", {
    type: "agent-turn-complete",
    "turn-id": "t-2",
    "input-messages": ["第二轮"],
    "last-assistant-message": "第二答",
  });

  expect(sessionIdOf(first)).toBe("codex-turn-t-1");
  expect(sessionIdOf(second)).toBe("codex-turn-t-2");
  expect(sessionIdOf(first)).not.toBe(sessionIdOf(second));
  expect(sessionIdOf(first)).not.toBe(fallbackSessionId("codex"));
});

test("a Codex rollout resolves to the session id in its own header", () => {
  const rollout = [
    JSON.stringify({ type: "session_meta", payload: { session_id: "sess-abc" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "继续" }] },
    }),
  ].join("\n");

  const resolved = resolveHookTurn("codex", { transcript_path: "/virtual/rollout.jsonl" }, () => rollout);

  expect(resolved.turn?.userMessage).toBe("继续");
  expect(sessionIdOf(resolved)).toBe("sess-abc");
});

test("an explicit hook session_id outranks anything the adapter derives", () => {
  const resolved = resolveHookTurn("codex", {
    session_id: "host-supplied",
    "turn-id": "t-1",
    "input-messages": ["帮我总结一下"],
  });

  expect(sessionIdOf(resolved)).toBe("host-supplied");
});

test("agents with nothing to derive from still get the per-agent fallback", () => {
  const resolved = resolveHookTurn(
    "claude-code",
    { transcript_path: "/virtual/transcript.jsonl" },
    () => TRANSCRIPT,
  );

  expect(sessionIdOf(resolved)).toBe(fallbackSessionId("claude-code"));
  expect(sessionIdOf(resolved)).toBe("memware-hook-claude-code");
});
