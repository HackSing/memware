/**
 * Kernel POST /search — ranking, cuts, dimension guard and text queries.
 * Covers acceptance c2 (search half).
 */

import { test, expect } from "bun:test";
import {
  createSearchService,
  rankCandidates,
  DimensionMismatchError,
  KERNEL_DEFAULT_MIN_SIMILARITY,
} from "../../src/kernel/search";
import { createEmbedService, PayloadTooLargeError } from "../../src/kernel/embed";
import { StubLLMClient } from "./stubLlm";

const QUERY = [1, 0, 0];
const CANDIDATES = [
  { id: "exact", vector: [1, 0, 0] },
  { id: "close", vector: [0.9, 0.4, 0] },
  { id: "far", vector: [0, 1, 0] },
];

test("ranks by score descending and reports the raw similarity", () => {
  const results = rankCandidates(QUERY, CANDIDATES, { minSimilarity: 0, nowMs: 0 });

  expect(results.map((r) => r.id)).toEqual(["exact", "close", "far"]);
  expect(results[0].similarity).toBeCloseTo(1, 6);
  expect(results[2].similarity).toBeCloseTo(0, 6);
  expect(results[0].score).toBeGreaterThan(results[1].score);
});

test("topK truncates after sorting", () => {
  const results = rankCandidates(QUERY, CANDIDATES, { minSimilarity: 0, topK: 2, nowMs: 0 });

  expect(results.map((r) => r.id)).toEqual(["exact", "close"]);
});

test("minSimilarity drops weak candidates, and its default matches the read config", () => {
  const results = rankCandidates(QUERY, CANDIDATES, { minSimilarity: 0.95 });

  expect(results.map((r) => r.id)).toEqual(["exact"]);
  expect(KERNEL_DEFAULT_MIN_SIMILARITY).toBe(0.55);
  expect(rankCandidates(QUERY, CANDIDATES, {}).map((r) => r.id)).toEqual(["exact", "close"]);
});

test("recency and doc type break ties between equally similar candidates", () => {
  const now = 1_700_000_000_000;
  const day = 86_400_000;
  const byRecency = rankCandidates(
    QUERY,
    [
      { id: "old", vector: [1, 0, 0], createdAt: now - 200 * day },
      { id: "fresh", vector: [1, 0, 0], createdAt: now },
    ],
    { minSimilarity: 0, nowMs: now },
  );
  expect(byRecency.map((r) => r.id)).toEqual(["fresh", "old"]);

  const byType = rankCandidates(
    QUERY,
    [
      { id: "fragment", vector: [1, 0, 0], docType: "profile_fragment" },
      { id: "cluster", vector: [1, 0, 0], docType: "memory_cluster" },
    ],
    { minSimilarity: 0, nowMs: now },
  );
  expect(byType.map((r) => r.id)).toEqual(["cluster", "fragment"]);
});

test("a candidate of another dimension fails loudly (422)", () => {
  expect(() =>
    rankCandidates(QUERY, [{ id: "wrong", vector: [1, 0] }], { minSimilarity: 0 }),
  ).toThrow(DimensionMismatchError);
});

test("a text query is embedded with the embedding model before ranking", async () => {
  const llm = new StubLLMClient({ embed: () => [1, 0, 0] });
  const embed = createEmbedService({ llm, model: "test-embedding", maxTexts: 4, timeoutMs: 1000 });
  const search = createSearchService({ embed, maxCandidates: 10 });

  const { results } = await search.search({
    query: { text: "我的偏好是什么" },
    candidates: CANDIDATES,
    minSimilarity: 0,
  });

  expect(llm.embedCalls).toHaveLength(1);
  expect(results.map((r) => r.id)).toEqual(["exact", "close", "far"]);
});

test("a vector query never touches the model", async () => {
  const llm = new StubLLMClient();
  const embed = createEmbedService({ llm, model: "test-embedding", maxTexts: 4, timeoutMs: 1000 });
  const search = createSearchService({ embed, maxCandidates: 10 });

  const { results } = await search.search({
    query: { vector: QUERY },
    candidates: CANDIDATES,
    topK: 1,
    minSimilarity: 0,
  });

  expect(llm.embedCalls).toHaveLength(0);
  expect(results).toHaveLength(1);
});

test("a candidate set over the ceiling is rejected before any ranking (413)", async () => {
  const llm = new StubLLMClient({ embed: () => [1, 0, 0] });
  const embed = createEmbedService({ llm, model: "test-embedding", maxTexts: 4, timeoutMs: 1000 });
  const search = createSearchService({ embed, maxCandidates: 2 });

  await expect(
    search.search({ query: { text: "查询" }, candidates: CANDIDATES }),
  ).rejects.toBeInstanceOf(PayloadTooLargeError);
  // The ceiling is enforced before the query is embedded.
  expect(llm.embedCalls).toHaveLength(0);
});
