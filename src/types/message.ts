/**
 * avatanel — Message Types
 *
 * Core message types for LLM conversation turns.
 * Ported from free-code's message types, extended for multi-provider support.
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

// ── Messages ──────────────────────────────────────────────────

export interface SystemMessage {
  role: 'system';
  content: string;
  cache_control?: { type: 'ephemeral' };
  /** Unix epoch milliseconds when the message was created, when known. */
  createdAt?: number;
}

export interface UserMessage {
  role: 'user';
  content: string | ContentBlock[];
  /** Stable runtime turn id when the message came from a turn-aware surface. */
  turnId?: string;
  /** Unix epoch milliseconds when the message was created, when known. */
  createdAt?: number;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | ContentBlock[];
  /** Stable runtime turn id when the message came from a turn-aware surface. */
  turnId?: string;
  /** Unix epoch milliseconds when the message was created, when known. */
  createdAt?: number;
  /** Private assistant-only continuity state extracted from EvoLoop Reflect. */
  privateReflect?: AssistantPrivateReflect;
}

export type Message = SystemMessage | UserMessage | AssistantMessage;

// ── Private Assistant State ───────────────────────────────────

export interface AssistantPrivateReflectBlock {
  /** Capture / 信号 text, compacted for private continuity. */
  signal?: string;
  /** Route / 写入 classification hint. */
  route?: string;
  /** Legacy Attribute / 归因, retained only for old transcripts. */
  attribution?: string;
}

export interface AssistantPrivateReflect {
  step0?: AssistantPrivateReflectBlock;
  current?: AssistantPrivateReflectBlock;
}

// ── Standalone Tool Result ────────────────────────────────────

export type ToolErrorKind =
  | 'blocked'
  | 'unknown_tool'
  | 'permission_denied'
  | 'scope_guard'
  | 'workflow_gate'
  | 'command_safety'
  | 'lifecycle_hook'
  | 'invalid_input'
  | 'transport'
  | 'rate_limit'
  | 'service_unavailable'
  | 'auth'
  | 'timeout'
  | 'aborted'
  | 'execution_error';

/**
 * Standalone tool result appended to conversation after tool execution.
 * Distinct from ToolResultContent (embedded in user message).
 */
export interface ToolCallResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  errorKind?: ToolErrorKind;
  progressText?: string;
}

// ── Type guards ───────────────────────────────────────────────

export function isUserMessage(m: Message): m is UserMessage {
  return m.role === 'user';
}

export function isAssistantMessage(m: Message): m is AssistantMessage {
  return m.role === 'assistant';
}

export function isSystemMessage(m: Message): m is SystemMessage {
  return m.role === 'system';
}

export function isToolUseContent(b: ContentBlock): b is ToolUseContent {
  return b.type === 'tool_use';
}

export function isToolResultContent(b: ContentBlock): b is ToolResultContent {
  return b.type === 'tool_result';
}

// I1 fix: add missing ThinkingContent type guard (needed by AgentCore in P1
// when processing thinking_delta stream events into AssistantMessage content)
export function isThinkingContent(b: ContentBlock): b is ThinkingContent {
  return b.type === 'thinking';
}
