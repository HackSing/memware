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

/**
 * Default intent-routing budget. Measured 2026-09-03 against SiliconFlow
 * DeepSeek-V3.2 (the default `model_name`): p50 ≈ 2.2 s, p90 ≈ 2.7 s,
 * max 2.8 s over 26 isolated samples, but ~20% of production turns
 * exceeded the previous 5 s budget (SDK retries / provider queueing).
 * 10 s keeps retrieval on the tail instead of silently dropping memory.
 */
const DEFAULT_INTENT_TIMEOUT_MS = 10_000;

export class IntentAnalyzer {
  private llm: MemoryLLMClient;
  private model: string;
  private timeoutMs: number;

  constructor(config: ModelConfig, llm: MemoryLLMClient, timeoutMs?: number) {
    this.model = config.model_name;
    this.llm = llm;
    this.timeoutMs = timeoutMs ?? config.intent_timeout_ms ?? DEFAULT_INTENT_TIMEOUT_MS;
  }

  async analyze(query: string): Promise<IntentAnalysis> {
    const fallback: IntentAnalysis = {
      requires_memory: false,
      search_query: query,
    };

    const controller = new AbortController();
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
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

      const raw = response.content;
      const result = safeJsonParse<Record<string, unknown>>(raw);

      return {
        requires_memory: Boolean(result.requires_memory ?? false),
        search_query: String(result.search_query ?? query),
      };
    } catch (e) {
      // Provider SDKs surface our own abort under their own error classes
      // (e.g. openai's `APIUserAbortError`, whose `name` is not "AbortError"),
      // so classify by the signal we control, not by the error's name.
      if (controller.signal.aborted) {
        console.warn(
          `Intent analysis timed out after ${Date.now() - startedAt}ms (budget ${this.timeoutMs}ms, model ${this.model}); defaulting to no memory`,
        );
      } else {
        console.warn("Intent analysis failed:", e);
      }
      return fallback;
    } finally {
      clearTimeout(timeout);
    }
  }
}
