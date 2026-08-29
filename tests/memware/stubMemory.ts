/**
 * Shared test double for memware tests: a stub IMemoryService backed by a fake
 * MemoryLLMClient. The fake LLM returns a canned UnifiedMemoryExtraction so the
 * real UnifiedExtractor + router run end-to-end without touching a live API.
 *
 * Mirrors the stub pattern in tests/unified-memory/integration.test.ts.
 */

import type {
  IMemoryService,
  MemoryCluster,
  MemoryContext,
  MemoryRuntimeStatus,
} from "../../src/agent/memory/types";
import type { MemoryLLMClient } from "../../src/agent/memory/llmClient";
import type { UnifiedMemoryExtraction } from "../../src/agent/memory/unified/schema";

export interface StubState {
  warmupCalls: string[];
  addClusterCalls: Array<{ userId: string; cluster: MemoryCluster }>;
  updateProfileCalls: number;
  archiveCalls: string[];
  resetCalls: string[];
  getContextCalls: Array<{ userId: string; query: string }>;
  searchCalls: Array<{ userId: string; query: string; limit?: number }>;
  chatCompletionCalls: number;
  /** Models passed to each chatCompletion call, in order. */
  chatCompletionModels: string[];
}

export interface StubMemory {
  service: IMemoryService;
  state: StubState;
}

/** A minimal valid extraction: one memory cluster whose evidence is a substring
 *  of {@link DEFAULT_EVIDENCE} so it passes the router's hard gate. */
export const DEFAULT_EVIDENCE = "最喜欢的颜色是蓝色";

export function defaultPayload(): UnifiedMemoryExtraction {
  return {
    version: "v1",
    event: {
      ts: "2026-04-18T12:00:00.000Z",
      summary: "user shared favorite color",
      confidence: 0.9,
      categories: ["memory"],
    },
    facts: {
      memory_clusters: [
        { fact: "用户最喜欢的颜色是蓝色", evidence: DEFAULT_EVIDENCE, importance_score: 0.7 },
      ],
    },
    routes: {},
  };
}

export function buildStubMemory(payload: UnifiedMemoryExtraction = defaultPayload()): StubMemory {
  const state: StubState = {
    warmupCalls: [],
    addClusterCalls: [],
    updateProfileCalls: 0,
    archiveCalls: [],
    resetCalls: [],
    getContextCalls: [],
    searchCalls: [],
    chatCompletionCalls: 0,
    chatCompletionModels: [],
  };

  const llm: MemoryLLMClient = {
    async chatCompletion(opts) {
      state.chatCompletionCalls += 1;
      state.chatCompletionModels.push(opts.model);
      return { content: JSON.stringify(payload) };
    },
    async embed() {
      return { embeddings: [new Array(8).fill(0)] };
    },
  };

  const service: IMemoryService = {
    async init() {},
    async warmup(userId) {
      state.warmupCalls.push(userId);
    },
    async getContext(userId, query): Promise<MemoryContext> {
      state.getContextCalls.push({ userId, query });
      return {
        routing: { requires_memory: true, search_query: query },
        prompts: { system: "SYS", context: `CTX for ${query}` },
      };
    },
    async searchMemory(userId, query, topK) {
      state.searchCalls.push({ userId, query, limit: topK });
      return `results for ${query}`;
    },
    async archive(userId) {
      state.archiveCalls.push(userId ?? "");
    },
    async reset(userId) {
      state.resetCalls.push(userId);
    },
    close() {},
    getLLMClient() {
      return llm;
    },
    getRuntimeStatus(): MemoryRuntimeStatus {
      return { kind: "persistent", persistent: true };
    },
    getUserProfileLanguage() {
      return undefined;
    },
    async addMemoryCluster(userId, cluster) {
      state.addClusterCalls.push({ userId, cluster });
    },
    async updateProfile() {
      state.updateProfileCalls += 1;
    },
    async updateRelationship() {},
    async upsertActiveThread() {},
    async upsertFocus() {},
    async searchClusters(): Promise<MemoryCluster[]> {
      return [
        { fact: "canned cluster", importance_score: 0.5, created_at: "2026-04-18T12:00:00.000Z" },
      ];
    },
    async deleteByProvenance() {
      return 0;
    },
  };

  return { service, state };
}
