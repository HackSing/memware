/**
 * avatanel Memory System — Intent Analyzer
 *
 * Determines if a query needs long-term memory retrieval.
 */

import type { MemoryLLMClient } from "./llmClient";
import type { IntentAnalysis, ModelConfig } from "./types";
import { safeJsonParse } from "./config";

const INTENT_SYSTEM_PROMPT = `You are a memory retrieval router. Given a user's message, determine:
1. Whether this query requires retrieving long-term memories about the user (requires_memory: true/false)
2. If yes, rewrite the query into optimal search keywords for semantic vector search (search_query)

Rules:
- Generic questions (coding help, math, general knowledge) do NOT need memory
- Questions about the user's past, preferences, relationships, events DO need memory
- Questions referencing "before", "last time", "remember", personal context need memory

Respond in JSON: {"requires_memory": bool, "search_query": "..."}`;

const DEFAULT_INTENT_TIMEOUT_MS = 5000;

export class IntentAnalyzer {
  private llm: MemoryLLMClient;
  private model: string;
  private timeoutMs: number;

  constructor(config: ModelConfig, llm: MemoryLLMClient, timeoutMs?: number) {
    this.model = config.model_name;
    this.llm = llm;
    this.timeoutMs = timeoutMs ?? DEFAULT_INTENT_TIMEOUT_MS;
  }

  async analyze(query: string): Promise<IntentAnalysis> {
    const fallback: IntentAnalysis = {
      requires_memory: false,
      search_query: query,
    };

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.timeoutMs,
      );

      const response = await this.llm.chatCompletion({
        model: this.model,
        messages: [
          { role: "system", content: INTENT_SYSTEM_PROMPT },
          { role: "user", content: query },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: 150,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const raw = response.content;
      const result = safeJsonParse<Record<string, unknown>>(raw);

      return {
        requires_memory: Boolean(result.requires_memory ?? false),
        search_query: String(result.search_query ?? query),
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        console.warn("Intent analysis timed out, defaulting to no memory");
      } else {
        console.warn("Intent analysis failed:", e);
      }
      return fallback;
    }
  }
}
