/**
 * memware transcript parsing — extract the final user/assistant turn from a
 * Claude Code JSONL transcript, skipping tool and malformed records.
 */
import { test, expect } from "bun:test";
import { extractLastTurn } from "../../src/memware/transcript";

function jsonl(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("extracts the last user/assistant turn from a mixed transcript", () => {
  const transcript = jsonl([
    { type: "summary", summary: "conv" },
    { type: "user", message: { role: "user", content: "第一轮问题" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一轮回答" }] } },
    // tool_use assistant record — no text blocks, must be ignored
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] } },
    // tool_result user record — must be ignored
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    { type: "user", message: { role: "user", content: "我最喜欢的颜色是蓝色" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "记住了" }] } },
  ]);
  const turn = extractLastTurn(transcript);
  expect(turn).not.toBeNull();
  expect(turn!.userMessage).toBe("我最喜欢的颜色是蓝色");
  expect(turn!.assistantMessage).toBe("记住了");
  // two real user turns → 0-based index of the last is 1
  expect(turn!.turnIndex).toBe(1);
});

test("tolerates plain-string content and top-level role", () => {
  const transcript = jsonl([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
  ]);
  const turn = extractLastTurn(transcript);
  expect(turn!.userMessage).toBe("hello");
  expect(turn!.assistantMessage).toBe("hi there");
  expect(turn!.turnIndex).toBe(0);
});

test("skips malformed JSON lines without throwing", () => {
  const transcript =
    "not json\n" +
    JSON.stringify({ type: "user", message: { role: "user", content: "valid" } }) +
    "\n{ broken";
  const turn = extractLastTurn(transcript);
  expect(turn!.userMessage).toBe("valid");
});

test("returns null when there is no user text", () => {
  const transcript = jsonl([
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "只有助手" }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
  ]);
  expect(extractLastTurn(transcript)).toBeNull();
  expect(extractLastTurn("")).toBeNull();
});
