/**
 * Shared test double for kernel tests: a scripted MemoryLLMClient.
 *
 * Chat responses are queued as raw strings (what a model would return), an
 * Error (upstream failure), or { delayMs } (a call slower than the budget —
 * it honours the abort signal, like the OpenAI SDK does).
 */

import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  EmbeddingOptions,
  EmbeddingResult,
  MemoryLLMClient,
} from "../../src/agent/memory/llmClient";

export type ScriptedChatResponse = string | Error | { delayMs: number };

export interface StubLLMOptions {
  chatResponses?: ScriptedChatResponse[];
  /** Deterministic embedding of one text; defaults to a 3-dim signature. */
  embed?: (text: string) => number[];
  /** Simulate an embedding call slower than the budget. */
  embedDelayMs?: number;
}

function defaultEmbedding(text: string): number[] {
  let sum = 0;
  for (const ch of text) sum += ch.codePointAt(0) ?? 0;
  return [text.length, sum % 97, 1];
}

export class StubLLMClient implements MemoryLLMClient {
  readonly chatCalls: ChatCompletionOptions[] = [];
  readonly embedCalls: EmbeddingOptions[] = [];
  private readonly chatResponses: ScriptedChatResponse[];

  constructor(private readonly options: StubLLMOptions = {}) {
    this.chatResponses = [...(options.chatResponses ?? [])];
  }

  async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    this.chatCalls.push(opts);
    const next = this.chatResponses.shift();
    if (next === undefined) throw new Error("stub: no scripted chat response left");
    if (next instanceof Error) throw next;
    if (typeof next === "object") {
      return new Promise<ChatCompletionResult>((resolve, reject) => {
        const timer = setTimeout(() => resolve({ content: "{}" }), next.delayMs);
        opts.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("stub: request aborted"));
        });
      });
    }
    return { content: next };
  }

  async embed(opts: EmbeddingOptions): Promise<EmbeddingResult> {
    this.embedCalls.push(opts);
    const inputs = Array.isArray(opts.input) ? opts.input : [opts.input];
    if (this.options.embedDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.options.embedDelayMs));
    }
    const embedOne = this.options.embed ?? defaultEmbedding;
    return { embeddings: inputs.map(embedOne) };
  }
}
