/**
 * Antigravity transcript adapter: unwrapping the person's own words, keeping
 * intermediate model steps out of the answer, and the camelCase hook payload.
 */
import { test, expect } from "bun:test";
import {
  antigravitySessionIdFromPayload,
  antigravityTranscriptPathFromPayload,
  cleanAntigravityUserContent,
  extractAntigravityLastTurn,
} from "../../src/memware/transcripts/antigravity";
import { getAdapter } from "../../src/memware/transcripts";
import { fallbackSessionId, resolveHookTurn } from "../../src/memware/adapters";

function line(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

function userInput(step: number, content: string): string {
  return line({ step_index: step, source: "USER_EXPLICIT", type: "USER_INPUT", content });
}

function plannerResponse(step: number, content: string): string {
  return line({ step_index: step, source: "MODEL", type: "PLANNER_RESPONSE", content });
}

test("the last completed turn is unwrapped from its framing", () => {
  const transcript = [
    userInput(1, "<USER_REQUEST>\n你好，测试一下\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>"),
    plannerResponse(2, "你好！很高兴为你提供帮助。"),
    userInput(3, "<USER_REQUEST>\n我特别喜欢看科幻小说，尤其是关于时间的题材\n</USER_REQUEST>"),
    line({ step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "some_tool" }] }),
    line({ step_index: 5, source: "MODEL", type: "GENERIC", content: "Tool output" }),
    plannerResponse(6, "<AVATANEL_REPLY>推荐特德·姜的《商人和炼金术士之门》。</AVATANEL_REPLY>\n\n【Reflect】\n- 信号: positive"),
  ].join("\n");

  const turn = extractAntigravityLastTurn(transcript);
  expect(turn).not.toBeNull();
  expect(turn!.userMessage).toBe("我特别喜欢看科幻小说，尤其是关于时间的题材");
  expect(turn!.assistantMessage).toBe("推荐特德·姜的《商人和炼金术士之门》。");
  expect(turn!.turnIndex).toBe(1);
});

test("intermediate model steps never become the assistant message", () => {
  // GENERIC/MODEL records outnumber real replies several to one. Matching on
  // source alone would store this tool narration as the answer.
  const transcript = [
    userInput(1, "<USER_REQUEST>问题</USER_REQUEST>"),
    plannerResponse(2, "真正的回答"),
    line({ step_index: 3, source: "MODEL", type: "GENERIC", content: "Ran tool: read_file" }),
    line({ step_index: 4, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: "system note" }),
  ].join("\n");

  expect(extractAntigravityLastTurn(transcript)!.assistantMessage).toBe("真正的回答");
});

test("metadata outside <USER_REQUEST> never reaches the stored message", () => {
  const raw =
    "<USER_REQUEST>\n真实输入\n</USER_REQUEST>\n" +
    "<ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>\n" +
    "<USER_SETTINGS_CHANGE>more noise</USER_SETTINGS_CHANGE>";
  expect(cleanAntigravityUserContent(raw)).toBe("真实输入");
});

test("without <USER_REQUEST>, known metadata blocks are stripped instead", () => {
  const raw = "<ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>\n裸输入\n<SYSTEM_MESSAGE>x</SYSTEM_MESSAGE>";
  expect(cleanAntigravityUserContent(raw)).toBe("裸输入");
  expect(cleanAntigravityUserContent("")).toBe("");
});

test("a turn still in flight is not a turn", () => {
  expect(extractAntigravityLastTurn("")).toBeNull();
  // A prompt with no answer after it: Stop can fire mid-stream.
  expect(extractAntigravityLastTurn(userInput(1, "<USER_REQUEST>Hello</USER_REQUEST>"))).toBeNull();
  // An answer with no prompt is not attributable to a turn.
  expect(extractAntigravityLastTurn(plannerResponse(1, "orphan"))).toBeNull();
});

test("a new prompt drops the previous turn's answer", () => {
  const transcript = [
    userInput(1, "<USER_REQUEST>第一问</USER_REQUEST>"),
    plannerResponse(2, "第一答"),
    userInput(3, "<USER_REQUEST>第二问</USER_REQUEST>"),
  ].join("\n");

  // The second prompt has no answer yet, so no completed turn — the first
  // turn's answer must not be paired with the second prompt.
  expect(extractAntigravityLastTurn(transcript)).toBeNull();
});

test("the camelCase hook payload is understood", () => {
  expect(antigravityTranscriptPathFromPayload({ transcriptPath: "/x/t.jsonl" })).toBe("/x/t.jsonl");
  expect(antigravityTranscriptPathFromPayload({ transcript_path: "/x/t.jsonl" })).toBe("/x/t.jsonl");
  expect(antigravityTranscriptPathFromPayload({})).toBeUndefined();

  expect(antigravitySessionIdFromPayload({ conversationId: "conv-1" })).toBe("conv-1");
  expect(antigravitySessionIdFromPayload({ conversation_id: "conv-1" })).toBe("conv-1");
  expect(antigravitySessionIdFromPayload({ conversationId: "  " })).toBeUndefined();
  expect(antigravitySessionIdFromPayload({})).toBeUndefined();
});

test("resolveHookTurn reads an Antigravity payload end to end", () => {
  const transcript = [
    userInput(1, "<USER_REQUEST>记住我喜欢简洁输出</USER_REQUEST>"),
    plannerResponse(2, "好的"),
  ].join("\n");
  const reads: string[] = [];

  const resolved = resolveHookTurn(
    "antigravity",
    { conversationId: "conv-42", transcriptPath: "/virtual/transcript.jsonl" },
    (path) => {
      reads.push(path);
      return transcript;
    },
  );

  expect(reads).toEqual(["/virtual/transcript.jsonl"]);
  expect(resolved.turn?.userMessage).toBe("记住我喜欢简洁输出");
  expect(resolved.turn ? resolved.sessionId : null).toBe("conv-42");
});

test("two conversations never share a session id", () => {
  const transcript = [userInput(1, "<USER_REQUEST>问</USER_REQUEST>"), plannerResponse(2, "答")].join("\n");
  const read = () => transcript;
  const first = resolveHookTurn("antigravity", { conversationId: "conv-a", transcriptPath: "/t" }, read);
  const second = resolveHookTurn("antigravity", { conversationId: "conv-b", transcriptPath: "/t" }, read);

  expect(first.turn ? first.sessionId : null).toBe("conv-a");
  expect(second.turn ? second.sessionId : null).toBe("conv-b");
  expect(first.turn ? first.sessionId : null).not.toBe(fallbackSessionId("antigravity"));
});

test("the adapter declares what the host needs back", () => {
  const adapter = getAdapter("antigravity");
  expect(adapter.id).toBe("antigravity");
  // Antigravity parses a decision object; an empty stdout stalls its loop.
  expect(adapter.hookResponse).toBe('{"decision":""}');
  expect(adapter.dedupeTurns).toBe(true);
  // The hosts that emit exactly one stop per turn opt into neither.
  expect(getAdapter("claude-code").hookResponse).toBeUndefined();
  expect(getAdapter("claude-code").dedupeTurns).toBeUndefined();
  expect(getAdapter("codex").dedupeTurns).toBeUndefined();
});
