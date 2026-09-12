/**
 * Kernel POST /extract — contract behaviour with a scripted model.
 *
 * Covers acceptance c1: user-only facts, other people as entity candidates,
 * confidence gate, suppression list, source validation, 422 / 504 mapping and
 * extractorVersion stamping.
 */

import { test, expect } from "bun:test";
import {
  createExtractor,
  fingerprintOf,
  ExtractOutputInvalidError,
  UpstreamFailedError,
  UpstreamTimeoutError,
  KERNEL_CONFIDENCE_THRESHOLDS,
} from "../../src/kernel/extract";
import { ExtractRequestSchema, ExtractResponseSchema } from "../../src/kernel/extractSchema";
import { kernelExtractSystemPrompt } from "../../src/kernel/extractPrompt";
import { extractorVersion } from "../../src/kernel/version";
import { StubLLMClient, type ScriptedChatResponse } from "./stubLlm";

import requestFixture from "./fixtures/extractRequest.json";
import mixedOutput from "./fixtures/modelOutput.mixed.json";
import unknownMessageIdOutput from "./fixtures/modelOutput.unknownMessageId.json";
import badCategoryOutput from "./fixtures/modelOutput.badCategory.json";

const SUPPRESSED_CONTENT = "用户喜欢详细的输出格式";

function request(overrides: Record<string, unknown> = {}) {
  return ExtractRequestSchema.parse({ ...requestFixture, ...overrides });
}

function extractorWith(responses: ScriptedChatResponse[], timeoutMs = 1000) {
  const llm = new StubLLMClient({ chatResponses: responses });
  return { llm, extractor: createExtractor({ llm, model: "test-model", timeoutMs }) };
}

test("keeps the user's own facts, gates confidence, honours the suppression list", async () => {
  const { llm, extractor } = extractorWith([JSON.stringify(mixedOutput)]);

  const response = await extractor.extract(
    request({ suppressedFingerprints: [fingerprintOf(SUPPRESSED_CONTENT)] }),
  );

  expect(ExtractResponseSchema.safeParse(response).success).toBe(true);
  expect(response.extractorVersion).toBe(extractorVersion);
  expect(response.facts.map((f) => f.content)).toEqual([
    "用户喜欢简洁的输出格式",
    "用户和张三一起负责供应商评审",
  ]);
  // 0.30 conclusion is below the gate; the suppressed preference is dropped
  // even though its confidence (0.90) clears it.
  expect(KERNEL_CONFIDENCE_THRESHOLDS.conclusion).toBeGreaterThan(0.3);
  expect(response.facts.some((f) => f.content === SUPPRESSED_CONTENT)).toBe(false);

  // Repeated messageIds collapse into one source ref.
  expect(response.facts[1].sourceRefs).toEqual([{ conversationId: "conv-1", messageId: "msg-1" }]);
  expect(response.facts[0].fingerprint).toBe(fingerprintOf("用户喜欢简洁的输出格式"));

  // userId never reaches the model.
  const userMessage = llm.chatCalls[0].messages[1].content as string;
  expect(userMessage).not.toContain("tenant-42");
  expect(userMessage).toContain("[conv-1/msg-1] user:");
});

test("other people are entity candidates only, and known aliases canonicalise names", async () => {
  const { extractor } = extractorWith([JSON.stringify(mixedOutput)]);

  const response = await extractor.extract(request());

  // Prompt-level rule (the kernel cannot re-derive a fact's subject).
  expect(kernelExtractSystemPrompt).toContain("只提炼以用户本人为主语");
  expect(kernelExtractSystemPrompt).toContain("他人（同事、客户、家人、公众人物等）不得成为事实的主语");

  const zhangsan = response.entities.find((e) => e.name === "张三");
  expect(zhangsan?.type).toBe("person");
  expect(zhangsan?.aliases).toContain("老张");
  // No fact is about 张三 himself; he is only referenced by a user-subject fact.
  expect(response.facts.every((f) => f.content.startsWith("用户"))).toBe(true);

  // "星河项目" is a known alias of "星河": one node, merged aliases.
  expect(response.entities.filter((e) => e.name === "星河")).toHaveLength(1);
  const project = response.entities.find((e) => e.name === "星河");
  expect(project?.type).toBe("project");
  expect(project?.aliases).toEqual(expect.arrayContaining(["星河计划", "星河项目", "Galaxy"]));
  expect(response.facts[0].entityNames).toEqual(["星河"]);
});

test("edges point at the surviving facts by index", async () => {
  const { extractor } = extractorWith([JSON.stringify(mixedOutput)]);

  const response = await extractor.extract(
    request({ suppressedFingerprints: [fingerprintOf(SUPPRESSED_CONTENT)] }),
  );

  expect(response.edges).toEqual([
    { factIndex: 0, entityName: "星河", edgeType: "memory_mentions_entity" },
    { factIndex: 1, entityName: "张三", edgeType: "memory_mentions_entity" },
    { factIndex: 1, entityName: "星河", edgeType: "memory_mentions_entity" },
  ]);
  for (const edge of response.edges) {
    expect(response.facts[edge.factIndex]).toBeDefined();
  }
});

test("duplicate fingerprints inside one response collapse", async () => {
  const duplicated = {
    facts: [
      { content: "用户住在杭州", category: "fact", confidence: 0.9, messageIds: ["msg-1"] },
      { content: "用户住在杭州。", category: "fact", confidence: 0.88, messageIds: ["msg-2"] },
    ],
    entities: [],
  };
  const { extractor } = extractorWith([JSON.stringify(duplicated)]);

  const response = await extractor.extract(request());

  expect(response.facts).toHaveLength(1);
  expect(response.facts[0].confidence).toBe(0.9);
});

test("a hallucinated messageId invalidates the whole response (422)", async () => {
  const { extractor } = extractorWith([JSON.stringify(unknownMessageIdOutput)]);

  await expect(extractor.extract(request())).rejects.toBeInstanceOf(ExtractOutputInvalidError);
});

test("an off-contract category invalidates the response (422)", async () => {
  const { extractor } = extractorWith([JSON.stringify(badCategoryOutput)]);

  await expect(extractor.extract(request())).rejects.toBeInstanceOf(ExtractOutputInvalidError);
});

test("non-JSON model output is reported as invalid, not thrown raw (422)", async () => {
  const { extractor } = extractorWith(["抱歉，我无法完成这个任务。"]);

  await expect(extractor.extract(request())).rejects.toBeInstanceOf(ExtractOutputInvalidError);
});

test("a fenced JSON block is still accepted", async () => {
  const fenced = "```json\n" + JSON.stringify({ facts: [], entities: [] }) + "\n```";
  const { extractor } = extractorWith([fenced]);

  const response = await extractor.extract(request());

  expect(response.facts).toEqual([]);
  expect(response.entities).toEqual([]);
});

test("an upstream call slower than the budget becomes UpstreamTimeoutError (504)", async () => {
  const { extractor } = extractorWith([{ delayMs: 500 }], 10);

  await expect(extractor.extract(request())).rejects.toBeInstanceOf(UpstreamTimeoutError);
});

test("an upstream failure becomes UpstreamFailedError (502)", async () => {
  const { extractor } = extractorWith([new Error("connection reset")]);

  await expect(extractor.extract(request())).rejects.toBeInstanceOf(UpstreamFailedError);
});
