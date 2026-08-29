/**
 * memware — Claude Code transcript parsing (pure).
 *
 * A Stop hook receives a `transcript_path` pointing at the conversation JSONL.
 * Each line is a record; the ones we care about carry `message.role` of
 * "user" / "assistant". Message content is either a plain string or an array of
 * content blocks (text / tool_use / tool_result / thinking). We keep only text
 * blocks, so tool-call and tool-result records collapse to empty and are
 * skipped. The final turn is the last non-empty user text paired with the last
 * non-empty assistant text.
 *
 * Kept side-effect-free so it can be unit-tested against synthetic transcripts.
 */

export interface LastTurn {
  userMessage: string;
  assistantMessage: string;
  /** 0-based index of the final user turn (count of user turns − 1). */
  turnIndex: number;
}

interface ContentBlock {
  type?: string;
  text?: string;
}

/** Extract plain text from a message `content` field (string or block array). */
function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is ContentBlock =>
          !!b && typeof b === "object" && (b as ContentBlock).type === "text",
      )
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function roleOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const message = (entry as { message?: unknown }).message;
  if (message && typeof message === "object") {
    const role = (message as { role?: unknown }).role;
    if (typeof role === "string") return role;
  }
  const topRole = (entry as { role?: unknown }).role;
  return typeof topRole === "string" ? topRole : undefined;
}

function contentOf(entry: unknown): unknown {
  const message = (entry as { message?: { content?: unknown } }).message;
  if (message && typeof message === "object" && "content" in message) {
    return message.content;
  }
  return (entry as { content?: unknown }).content;
}

/**
 * Parse a transcript's JSONL text and return the final user/assistant turn.
 * Returns `null` when no non-empty user message exists (nothing to write).
 * Malformed lines are skipped, never thrown.
 */
export function extractLastTurn(transcriptText: string): LastTurn | null {
  let userMessage = "";
  let assistantMessage = "";
  let userTurns = 0;

  for (const line of transcriptText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const role = roleOf(entry);
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(contentOf(entry));
    if (!text) continue;
    if (role === "user") {
      userMessage = text;
      userTurns += 1;
    } else {
      assistantMessage = text;
    }
  }

  if (!userMessage) return null;
  return { userMessage, assistantMessage, turnIndex: Math.max(0, userTurns - 1) };
}
