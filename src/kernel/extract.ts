/**
 * memware kernel — POST /extract.
 *
 * One chat call per request, no state. The model is asked for the contract
 * shape directly (extractPrompt.ts); everything the kernel can enforce
 * structurally is enforced here, after the call:
 *
 *   • sourceRefs may only point at messages the caller actually sent;
 *   • confidence must clear the per-category gate;
 *   • fingerprints on the caller's suppression list (memories the user deleted)
 *     are dropped, as are duplicates inside one response;
 *   • entity names are canonicalised against the caller's known entities.
 *
 * "Only facts about the user themselves" is a prompt-level rule (rule 1/2 of
 * kernelExtractSystemPrompt) — the kernel cannot re-derive a fact's subject, so
 * it is asserted as a prompt contract, not filtered here.
 */

import { shaHex } from "../agent/memory/ids";
import type { MemoryLLMClient } from "../agent/memory/llmClient";
import { normalizeMemoryText } from "../agent/memory/unified/hardGateText";
import { normalizeExtractorOutput } from "../agent/memory/unified/extractorNormalization";
import { passesConfidenceGate } from "../agent/memory/unified/thresholds";
import { buildKernelExtractUserMessage, kernelExtractSystemPrompt } from "./extractPrompt";
import {
  DEFAULT_ENTITY_TYPE,
  ExtractorOutputSchema,
  MEMORY_MENTIONS_ENTITY,
  type ExtractorOutput,
  type ExtractRequest,
  type ExtractResponse,
  type KernelEdge,
  type KernelEntity,
  type KernelFact,
  type KernelFactCategory,
  type KnownEntity,
} from "./extractSchema";
import { extractorVersion } from "./version";

// ── Errors ───────────────────────────────────────────────────

/** Model returned something the contract cannot represent → HTTP 422. */
export class ExtractOutputInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractOutputInvalidError";
  }
}

/** Upstream model exceeded the configured budget → HTTP 504. */
export class UpstreamTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`upstream ${operation} timed out after ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

/** Upstream model call failed → HTTP 502. */
export class UpstreamFailedError extends Error {
  constructor(operation: string, detail: string) {
    super(`upstream ${operation} failed: ${detail}`);
    this.name = "UpstreamFailedError";
  }
}

// ── Tunables (single source of truth) ────────────────────────

/**
 * Confidence floor per contract category. Preferences are the most expensive
 * to get wrong (they steer future answers), conclusions are the softest claim.
 * Deliberately separate from the local pipeline's DEFAULT_THRESHOLDS: that map
 * is keyed by memware's own document categories, not the contract's three.
 */
export const KERNEL_CONFIDENCE_THRESHOLDS: Readonly<Record<KernelFactCategory, number>> = {
  preference: 0.65,
  fact: 0.6,
  conclusion: 0.55,
};

const EXTRACT_TEMPERATURE = 0.2;
const EXTRACT_MAX_TOKENS = 1500;
/** Upstream error details are echoed to the caller; keep them bounded. */
const UPSTREAM_DETAIL_MAX = 200;

// ── Upstream helper (shared with embed.ts) ───────────────────

function detailOf(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > UPSTREAM_DETAIL_MAX
    ? `${message.slice(0, UPSTREAM_DETAIL_MAX)}…`
    : message;
}

/**
 * Run one upstream model call under a deadline, normalising every failure into
 * {@link UpstreamTimeoutError} / {@link UpstreamFailedError}.
 *
 * The signal is passed to callers that support cancellation (chat); the race
 * covers the ones that do not (embeddings), so the budget always holds.
 */
export async function callUpstream<T>(
  operation: string,
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new UpstreamTimeoutError(operation, timeoutMs));
      }, timeoutMs);
      call(controller.signal)
        .then(resolve, reject)
        .finally(() => clearTimeout(timer));
    });
  } catch (err) {
    if (err instanceof UpstreamTimeoutError) throw err;
    if (timedOut) throw new UpstreamTimeoutError(operation, timeoutMs);
    throw new UpstreamFailedError(operation, detailOf(err));
  }
}

// ── Model output parsing ─────────────────────────────────────

function stripCodeFence(value: string): string {
  const fenced = value.trim().match(/^```(?:json)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1]! : value.trim();
}

function parseModelOutput(raw: string): ExtractorOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(raw));
  } catch (err) {
    throw new ExtractOutputInvalidError(
      `model output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = ExtractorOutputSchema.safeParse(normalizeExtractorOutput(parsed));
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new ExtractOutputInvalidError(`model output does not match the extract schema: ${issues}`);
  }
  return result.data;
}

// ── Entity canonicalisation ──────────────────────────────────

interface Canonicalizer {
  /** Map a model-supplied name onto the caller's canonical name when known. */
  nameOf(raw: string): string;
  /** Known entity type for a canonical name, if the caller supplied one. */
  typeOf(canonicalName: string): string | undefined;
  /** Known aliases for a canonical name. */
  aliasesOf(canonicalName: string): string[];
}

function buildCanonicalizer(knownEntities: KnownEntity[]): Canonicalizer {
  const byNormalized = new Map<string, KnownEntity>();
  for (const entity of knownEntities) {
    for (const name of [entity.canonicalName, ...(entity.aliases ?? [])]) {
      const key = normalizeMemoryText(name);
      if (key.length > 0 && !byNormalized.has(key)) byNormalized.set(key, entity);
    }
  }
  const lookup = (name: string): KnownEntity | undefined =>
    byNormalized.get(normalizeMemoryText(name));
  return {
    nameOf: (raw) => lookup(raw)?.canonicalName ?? raw.trim(),
    typeOf: (canonicalName) => lookup(canonicalName)?.entityType,
    aliasesOf: (canonicalName) => lookup(canonicalName)?.aliases ?? [],
  };
}

/** Accumulates entity candidates, deduplicated by normalised name. */
class EntityCollector {
  private readonly byKey = new Map<string, KernelEntity>();

  constructor(private readonly canonicalizer: Canonicalizer) {}

  /** Add one candidate and return the canonical name to reference it by. */
  add(rawName: string, type?: string, aliases: string[] = []): string | null {
    const name = this.canonicalizer.nameOf(rawName);
    const key = normalizeMemoryText(name);
    if (key.length === 0) return null;

    const existing = this.byKey.get(key);
    const merged = existing ?? {
      name,
      type: this.canonicalizer.typeOf(name) ?? type?.trim() ?? DEFAULT_ENTITY_TYPE,
      aliases: [],
    };
    const aliasKeys = new Set(merged.aliases.map(normalizeMemoryText));
    for (const alias of [...aliases, ...this.canonicalizer.aliasesOf(name)]) {
      const trimmed = alias.trim();
      const aliasKey = normalizeMemoryText(trimmed);
      if (trimmed.length === 0 || aliasKey === key || aliasKeys.has(aliasKey)) continue;
      aliasKeys.add(aliasKey);
      merged.aliases.push(trimmed);
    }
    this.byKey.set(key, merged);
    return name;
  }

  list(): KernelEntity[] {
    return [...this.byKey.values()];
  }
}

// ── Service ──────────────────────────────────────────────────

export interface ExtractorDeps {
  llm: MemoryLLMClient;
  model: string;
  timeoutMs: number;
  /** Overrides for {@link KERNEL_CONFIDENCE_THRESHOLDS}. */
  thresholds?: Partial<Record<KernelFactCategory, number>>;
}

export interface Extractor {
  extract(request: ExtractRequest): Promise<ExtractResponse>;
}

/** sha256 of the normalised content — the backend's dedup/suppression key. */
export function fingerprintOf(content: string): string {
  return shaHex(normalizeMemoryText(content));
}

function buildMessageIndex(request: ExtractRequest): Map<string, string> {
  const index = new Map<string, string>();
  for (const conversation of request.conversations) {
    for (const message of conversation.messages) {
      if (!index.has(message.messageId)) index.set(message.messageId, conversation.conversationId);
    }
  }
  return index;
}

function sourceRefsOf(messageIds: string[], index: Map<string, string>): KernelFact["sourceRefs"] {
  const refs: KernelFact["sourceRefs"] = [];
  const seen = new Set<string>();
  for (const messageId of messageIds) {
    const conversationId = index.get(messageId);
    if (conversationId === undefined) {
      throw new ExtractOutputInvalidError(
        `model referenced messageId "${messageId}", which is not in the request`,
      );
    }
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    refs.push({ conversationId, messageId });
  }
  return refs;
}

export function createExtractor(deps: ExtractorDeps): Extractor {
  const thresholds = { ...KERNEL_CONFIDENCE_THRESHOLDS, ...(deps.thresholds ?? {}) };

  return {
    async extract(request: ExtractRequest): Promise<ExtractResponse> {
      const completion = await callUpstream("extract", deps.timeoutMs, (signal) =>
        deps.llm.chatCompletion({
          model: deps.model,
          messages: [
            { role: "system", content: kernelExtractSystemPrompt },
            { role: "user", content: buildKernelExtractUserMessage(request) },
          ],
          response_format: { type: "json_object" },
          temperature: EXTRACT_TEMPERATURE,
          max_tokens: EXTRACT_MAX_TOKENS,
          signal,
        }),
      );

      const output = parseModelOutput(completion.content);

      const messageIndex = buildMessageIndex(request);
      const canonicalizer = buildCanonicalizer(request.knownEntities ?? []);
      const collector = new EntityCollector(canonicalizer);
      for (const entity of output.entities ?? []) {
        collector.add(entity.name, entity.type, entity.aliases ?? []);
      }

      const suppressed = new Set(request.suppressedFingerprints ?? []);
      const facts: KernelFact[] = [];
      const edges: KernelEdge[] = [];
      const seenFingerprints = new Set<string>();

      for (const candidate of output.facts ?? []) {
        // Source validation runs before any filter: a hallucinated message id
        // invalidates the whole response, it is not a droppable candidate.
        const sourceRefs = sourceRefsOf(candidate.messageIds, messageIndex);
        if (!passesConfidenceGate(candidate.confidence, candidate.category, thresholds)) continue;

        const fingerprint = fingerprintOf(candidate.content);
        if (suppressed.has(fingerprint) || seenFingerprints.has(fingerprint)) continue;
        seenFingerprints.add(fingerprint);

        const entityNames: string[] = [];
        for (const rawName of candidate.entities ?? []) {
          const name = collector.add(rawName);
          if (name !== null && !entityNames.includes(name)) entityNames.push(name);
        }

        const factIndex = facts.length;
        facts.push({
          content: candidate.content,
          category: candidate.category,
          confidence: candidate.confidence,
          sourceRefs,
          fingerprint,
          entityNames,
        });
        for (const entityName of entityNames) {
          edges.push({ factIndex, entityName, edgeType: MEMORY_MENTIONS_ENTITY });
        }
      }

      return { extractorVersion, facts, entities: collector.list(), edges };
    },
  };
}
