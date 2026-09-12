/**
 * Kernel POST /embed — batching, dimension reporting, ceiling and timeout.
 * Covers acceptance c2 (embed half).
 */

import { test, expect } from "bun:test";
import { createEmbedService, PayloadTooLargeError } from "../../src/kernel/embed";
import { UpstreamTimeoutError } from "../../src/kernel/extract";
import { StubLLMClient } from "./stubLlm";

function service(overrides: { dim?: number; maxTexts?: number; timeoutMs?: number } = {}) {
  const llm = new StubLLMClient();
  return {
    llm,
    embed: createEmbedService({
      llm,
      model: "test-embedding",
      ...(overrides.dim !== undefined ? { dim: overrides.dim } : {}),
      maxTexts: overrides.maxTexts ?? 4,
      timeoutMs: overrides.timeoutMs ?? 1000,
    }),
  };
}

test("returns one vector per text and derives the dimension from the output", async () => {
  const { llm, embed } = service();

  const result = await embed.embed(["第一段", "第二段"]);

  expect(result.model).toBe("test-embedding");
  expect(result.vectors).toHaveLength(2);
  expect(result.dim).toBe(3);
  expect(llm.embedCalls).toHaveLength(1);
  expect(llm.embedCalls[0].model).toBe("test-embedding");
});

test("an empty batch never calls the model", async () => {
  const { llm, embed } = service({ dim: 1024 });

  const result = await embed.embed([]);

  expect(result).toEqual({ model: "test-embedding", dim: 1024, vectors: [] });
  expect(llm.embedCalls).toHaveLength(0);
});

test("the configured dimension wins over the observed one", async () => {
  const { embed } = service({ dim: 4096 });

  const result = await embed.embed(["文本"]);

  expect(result.dim).toBe(4096);
});

test("repeated texts are served from the in-process cache", async () => {
  const { llm, embed } = service();

  await embed.embed(["重复文本"]);
  const second = await embed.embed(["重复文本"]);

  expect(second.vectors).toHaveLength(1);
  expect(llm.embedCalls).toHaveLength(1);
});

test("a batch over the ceiling is rejected (413)", async () => {
  const { llm, embed } = service({ maxTexts: 2 });

  await expect(embed.embed(["a", "b", "c"])).rejects.toBeInstanceOf(PayloadTooLargeError);
  expect(llm.embedCalls).toHaveLength(0);
});

test("an embedding call slower than the budget becomes UpstreamTimeoutError (504)", async () => {
  const llm = new StubLLMClient({ embedDelayMs: 500 });
  const embed = createEmbedService({ llm, model: "test-embedding", maxTexts: 4, timeoutMs: 10 });

  await expect(embed.embed(["慢"])).rejects.toBeInstanceOf(UpstreamTimeoutError);
});
