/**
 * memware/adapters — the zero-runtime capture entry point (acceptance c5).
 *
 * Asserts the exported surface and that resolveHookTurn takes its file reader
 * by injection (no disk access in embedders or tests).
 */

import { test, expect } from "bun:test";
import {
  extractClaudeCodeLastTurn,
  extractCodexLastTurn,
  extractCodexTurnFromPayload,
  extractLastTurn,
  getAdapter,
  resolveHookTurn,
} from "../../src/memware/adapters";

const TRANSCRIPT = [
  JSON.stringify({ message: { role: "user", content: "记住我喜欢简洁输出" } }),
  JSON.stringify({ message: { role: "assistant", content: "好的" } }),
].join("\n");

test("the entry point exposes the whole capture surface", () => {
  expect(typeof extractLastTurn).toBe("function");
  expect(extractClaudeCodeLastTurn).toBe(extractLastTurn);
  expect(typeof extractCodexLastTurn).toBe("function");
  expect(typeof extractCodexTurnFromPayload).toBe("function");
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
