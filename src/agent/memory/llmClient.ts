/**
 * avatanel Memory System — LLM Client Abstraction
 *
 * Thin interface decoupling the memory pipeline (extractor, intentAnalyzer,
 * embedder) from the OpenAI SDK. This allows swapping the underlying LLM
 * provider without touching the memory modules.
 *
 * Default implementation: OpenAIMemoryClient (wraps `openai` SDK).
 * Future: AnthropicMemoryClient, or route through providers/factory.ts.
 */

// ── Interface ────────────────────────────────────────────────

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | MemoryChatContentPart[];
}

export type MemoryChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' | 'text' };
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
}

export interface EmbeddingOptions {
  model: string;
  input: string | string[];
}

export interface EmbeddingResult {
  embeddings: number[][];
}

/**
 * Unified interface for memory-layer LLM calls (chat + embeddings).
 * Implementations wrap provider-specific SDKs.
 */
export interface MemoryLLMClient {
  chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult>;
  embed(opts: EmbeddingOptions): Promise<EmbeddingResult>;
}

// ── Default Implementation (OpenAI-compatible) ───────────────

export class OpenAIMemoryClient implements MemoryLLMClient {
  private client: import('openai').default;

  constructor(opts: { apiKey: string; baseURL: string }) {
    // Dynamic import avoidance: we import at module level but construct lazily.
    // The openai SDK is already a dependency — this just wraps it.
    const OpenAI = require('openai').default;
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    });
  }

  async chatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
    const response = await this.client.chat.completions.create(
      {
        model: opts.model,
        messages: opts.messages as any,
        temperature: opts.temperature,
        max_tokens: opts.max_tokens,
        response_format: opts.response_format,
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );
    return {
      content: response.choices[0]?.message?.content ?? '{}',
    };
  }

  async embed(opts: EmbeddingOptions): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      model: opts.model,
      input: opts.input,
    });
    return {
      embeddings: response.data.map((d) => d.embedding),
    };
  }
}
