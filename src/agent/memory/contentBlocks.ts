/**
 * memware — message content block types.
 *
 * Structural mirror of the host project's conversation content blocks
 * (avatanel src/types/message.ts). The memory kernel only manipulates these as
 * data shapes (filtering image blocks, scrubbing payloads), so they are
 * declared locally to keep the kernel free of host-level imports. Keep the
 * shapes field-identical with the host's: assignability is structural, and
 * drift is caught by the host's typecheck when it consumes the kernel.
 */

// ── Content Blocks ────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
  /** Cache control for Anthropic prompt caching */
  cache_control?: { type: 'ephemeral' };
}

export interface ImageContent {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type ContentBlock =
  | TextContent
  | ImageContent
  | ToolUseContent
  | ToolResultContent
  | ThinkingContent;
