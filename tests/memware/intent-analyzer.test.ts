/**
 * IntentAnalyzer — timeout classification and budget plumbing.
 */
import { test, expect, afterEach } from "bun:test";
import { IntentAnalyzer } from "../../src/agent/memory/intentAnalyzer";
import type { ChatCompletionOptions, MemoryLLMClient } from "../../src/agent/memory/llmClient";
import { DEFAULT_CONFIG } from "../../src/agent/memory/config";

const originalWarn = console.warn;
let warnings: unknown[][] = [];
function captureWarn(): void {
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
}
afterEach(() => { console.warn = originalWarn; });

/** Mimics the openai SDK: the abort surfaces as APIUserAbortError, not AbortError. */
class APIUserAbortError extends Error {
  constructor() { super("Request was aborted."); this.name = "APIUserAbortError"; }
}

function hangingClient(): MemoryLLMClient & { seen: ChatCompletionOptions[] } {
  const seen: ChatCompletionOptions[] = [];
  return {
    seen,
    async chatCompletion(opts) {
      seen.push(opts);
      return await new Promise((_, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
      });
    },
    async embed() { throw new Error("not used"); },
  };
}

test("a provider-wrapped abort is reported as a timeout, once, without a stack dump", async () => {
  captureWarn();
  const client = hangingClient();
  const analyzer = new IntentAnalyzer({ ...DEFAULT_CONFIG.model, intent_timeout_ms: 20 }, client);

  const result = await analyzer.analyze("记得我喜欢什么咖啡吗");

  expect(result).toEqual({ requires_memory: false, search_query: "记得我喜欢什么咖啡吗" });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toHaveLength(1);
  expect(String(warnings[0]![0])).toMatch(/^Intent analysis timed out after \d+ms \(budget 20ms, model /);
  expect(client.seen[0]?.signal?.aborted).toBe(true);
});

test("constructor argument beats config budget, config beats the default", () => {
  const client = hangingClient();
  const fromConfig = new IntentAnalyzer({ ...DEFAULT_CONFIG.model, intent_timeout_ms: 1234 }, client);
  const fromArg = new IntentAnalyzer({ ...DEFAULT_CONFIG.model, intent_timeout_ms: 1234 }, client, 42);
  const fromDefault = new IntentAnalyzer(DEFAULT_CONFIG.model, client);
  expect((fromConfig as unknown as { timeoutMs: number }).timeoutMs).toBe(1234);
  expect((fromArg as unknown as { timeoutMs: number }).timeoutMs).toBe(42);
  expect((fromDefault as unknown as { timeoutMs: number }).timeoutMs).toBe(10_000);
});

test("a genuine provider failure is still reported as a failure", async () => {
  captureWarn();
  const client: MemoryLLMClient = {
    async chatCompletion() { throw new Error("boom"); },
    async embed() { throw new Error("not used"); },
  };
  const result = await new IntentAnalyzer(DEFAULT_CONFIG.model, client).analyze("hi");
  expect(result.requires_memory).toBe(false);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]![0]).toBe("Intent analysis failed:");
});

test("a fast successful response is parsed and the budget timer is cleared", async () => {
  const client: MemoryLLMClient = {
    async chatCompletion() { return { content: '{"requires_memory": true, "search_query": "coffee"}' }; },
    async embed() { throw new Error("not used"); },
  };
  const result = await new IntentAnalyzer({ ...DEFAULT_CONFIG.model, intent_timeout_ms: 5 }, client).analyze("x");
  expect(result).toEqual({ requires_memory: true, search_query: "coffee" });
  await new Promise((r) => setTimeout(r, 15)); // budget elapsed after success must not warn or throw
});
