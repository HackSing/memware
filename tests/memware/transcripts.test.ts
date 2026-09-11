/**
 * Phase 3 — transcript adapters: adapter registry fallback plus the Codex
 * rollout-JSONL and inline notify-payload parsers.
 */
import { test, expect } from "bun:test";
import { getAdapter } from "../../src/memware/transcripts";
import { extractCodexLastTurn, extractCodexTurnFromPayload } from "../../src/memware/transcripts/codex";

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
});
