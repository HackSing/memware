/**
 * Phase 3 — transcript adapters: adapter registry fallback plus the Codex
 * rollout-JSONL and inline notify-payload parsers.
 */
import { test, expect } from "bun:test";
import { getAdapter } from "../../src/memware/transcripts";
import {
  codexSessionIdFromPayload,
  extractCodexLastTurn,
  extractCodexSessionId,
  extractCodexTurnFromPayload,
} from "../../src/memware/transcripts/codex";

function rolloutLine(type: string, payload: unknown): string {
  return JSON.stringify({ timestamp: "2026-09-11T12:00:00.000Z", type, payload });
}

test("unknown agent ids fall back to the Claude Code transcript parser", () => {
  expect(getAdapter("unknown").id).toBe("claude-code");
  expect(getAdapter("cursor").id).toBe("claude-code");
  expect(getAdapter("codex").id).toBe("codex");
  expect(getAdapter("claude-code").id).toBe("claude-code");
});

test("codex adapter parses rollout JSONL response_items", () => {
  const text = [
    rolloutLine("session_meta", { id: "s-1" }),
    rolloutLine("turn_context", { cwd: "/tmp" }),
    rolloutLine("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "帮我看看构建失败的原因" }],
    }),
    rolloutLine("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "是缺依赖导致的" }],
    }),
    rolloutLine("response_item", { type: "function_call", name: "shell" }),
  ].join("\n");

  const turn = extractCodexLastTurn(text);
  expect(turn).not.toBeNull();
  expect(turn!.userMessage).toBe("帮我看看构建失败的原因");
  expect(turn!.assistantMessage).toBe("是缺依赖导致的");
  expect(turn!.turnIndex).toBe(0);
});

test("codex adapter takes the LAST user/assistant pair and skips malformed lines", () => {
  const text = [
    rolloutLine("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "第一轮" }],
    }),
    rolloutLine("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "第一答" }],
    }),
    "{ broken json",
    rolloutLine("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "第二轮" }],
    }),
    rolloutLine("response_item", {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "第二答" }],
    }),
  ].join("\n");

  const turn = extractCodexLastTurn(text);
  expect(turn).not.toBeNull();
  expect(turn!.userMessage).toBe("第二轮");
  expect(turn!.assistantMessage).toBe("第二答");
  expect(turn!.turnIndex).toBe(1);
});

test("codex adapter returns null when no user message exists", () => {
  const text = rolloutLine("response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "orphan" }],
  });
  expect(extractCodexLastTurn(text)).toBeNull();
  expect(extractCodexLastTurn("")).toBeNull();
});

test("codex inline notify payload yields a turn (kebab and snake case)", () => {
  const kebab = extractCodexTurnFromPayload({
    type: "agent-turn-complete",
    "turn-id": "t-1",
    "input-messages": ["修复 Windows 构建"],
    "last-assistant-message": "已完成,产物在 dist/。",
  });
  expect(kebab).not.toBeNull();
  expect(kebab!.userMessage).toBe("修复 Windows 构建");
  expect(kebab!.assistantMessage).toBe("已完成,产物在 dist/。");

  const snake = extractCodexTurnFromPayload({
    input_messages: [" snake_case 输入"],
    last_assistant_message: "ok",
  });
  expect(snake).not.toBeNull();
  expect(snake!.userMessage).toBe("snake_case 输入");
});

test("codex inline payload without user input yields null", () => {
  expect(extractCodexTurnFromPayload({ "last-assistant-message": "only assistant" })).toBeNull();
  expect(extractCodexTurnFromPayload({})).toBeNull();
});

test("codex adapter supports both entry points", () => {
  const adapter = getAdapter("codex");
  expect(typeof adapter.extractLastTurn).toBe("function");
  expect(typeof adapter.extractFromHookPayload).toBe("function");
  expect(typeof adapter.sessionIdFromTranscript).toBe("function");
  expect(typeof adapter.sessionIdFromHookPayload).toBe("function");
});

test("codex rollout session id comes from the session_meta header", () => {
  const text = [
    rolloutLine("session_meta", {
      session_id: "019d37df-359b-7c10-8e60-847cb230dca7",
      id: "019d37df-359b-7c10-8e60-847cb230dca7",
      cwd: "/tmp",
    }),
    rolloutLine("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "第一轮" }],
    }),
  ].join("\n");

  expect(extractCodexSessionId(text)).toBe("019d37df-359b-7c10-8e60-847cb230dca7");
  // `id` alone is accepted for rollouts written before session_id existed.
  expect(extractCodexSessionId(rolloutLine("session_meta", { id: "only-id" }))).toBe("only-id");
});

test("a rollout without usable session_meta yields no id instead of a bad one", () => {
  expect(extractCodexSessionId("")).toBeUndefined();
  expect(extractCodexSessionId("{ broken json")).toBeUndefined();
  expect(extractCodexSessionId(rolloutLine("session_meta", { cwd: "/tmp" }))).toBeUndefined();
  expect(extractCodexSessionId(rolloutLine("session_meta", { session_id: "   " }))).toBeUndefined();
});

test("notify payloads are scoped per turn, not collapsed onto one id", () => {
  const first = codexSessionIdFromPayload({
    type: "agent-turn-complete",
    "turn-id": "t-1",
    "input-messages": ["第一轮"],
    "last-assistant-message": "第一答",
  });
  const second = codexSessionIdFromPayload({
    type: "agent-turn-complete",
    turn_id: "t-2",
    input_messages: ["第二轮"],
    last_assistant_message: "第二答",
  });

  expect(first).toBe("codex-turn-t-1");
  expect(second).toBe("codex-turn-t-2");
  expect(first).not.toBe(second);
});

test("a notify payload without turn-id falls back to a content hash, not a constant", () => {
  const payload = {
    "input-messages": ["没有 turn-id 的一轮"],
    "last-assistant-message": "好的",
  };
  const other = { "input-messages": ["另一轮"], "last-assistant-message": "好的" };

  const id = codexSessionIdFromPayload(payload);
  expect(id).toMatch(/^codex-turn-h[0-9a-f]{16}$/);
  // Stable across a replayed notify: a retry re-stamps the same provenance.
  expect(codexSessionIdFromPayload({ ...payload })).toBe(id);
  // Still distinct per turn, which is the whole point of not using a constant.
  expect(codexSessionIdFromPayload(other)).not.toBe(id);
});

test("a payload with no turn to scope yields no session id", () => {
  expect(codexSessionIdFromPayload({})).toBeUndefined();
  expect(codexSessionIdFromPayload({ "last-assistant-message": "orphan" })).toBeUndefined();
});
