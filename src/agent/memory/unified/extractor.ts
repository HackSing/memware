/**
 * UnifiedExtractor — calls the memory LLM with the unified system prompt
 * and returns either:
 *   - extract():        a fully-validated UnifiedMemoryExtraction
 *                       (strict first; if that fails, transparently falls back
 *                        to per-section salvage via extractPartial(). event
 *                        must be recoverable; facts/routes default to {} if
 *                        a single section is malformed. payload.salvaged=true
 *                        marks the salvage path — diagnostic only, router
 *                        does not use it for routing decisions.)
 *   - extractPartial(): the lower-level per-section salvage primitive.
 *
 * Errors never throw from public methods — they are surfaced via the
 * result envelope so the router can degrade gracefully.
 *
 * [batch-1 fix]
 *   - `extract()` now falls back to salvage when strict schema validation
 *     fails but at least `event` can be parsed. This keeps the audit log
 *     populated when a single section drifts.
 *   - `stripNulls` deep-removes `null`-valued keys from the LLM payload
 *     before validation (the prompt is already updated to not emit null,
 *     but defense-in-depth against legacy or drift).
 *   - `timeoutMs` default is 30s for provider tail latency.
 */

import { z } from 'zod';
import type { MemoryLLMClient } from '../llmClient';
import {
  UnifiedMemoryExtractionSchema, EventSchema, FactsSchema, RoutesSchema,
  type UnifiedMemoryExtraction, type UnifiedEvent, type UnifiedFacts, type UnifiedRoutes,
} from './schema';
import type { StructuredError } from './auditLog';
import { UNIFIED_EXTRACTOR_SYSTEM_PROMPT, buildExtractorUserMessage } from './prompts';
import { normalizeExtractorOutput } from './extractorNormalization';

export interface ExtractInput {
  userId: string;
  userMessage: string;
  assistantResponse: string;
  turnIndex: number;
  sessionId: string;
}

export interface ExtractResult {
  ok: boolean;
  /**
   * Validated payload. When `ok === true` this is always present. May carry
   * a non-standard `salvaged: true` marker when produced via the partial-
   * salvage fallback path (diagnostic; router ignores).
   */
  payload?: UnifiedMemoryExtraction & { salvaged?: boolean };
  error?: string;
  errors?: StructuredError[];
  rawLLMOutput?: string;
}

export interface PartialExtractResult {
  event: UnifiedEvent | null;
  facts: UnifiedFacts | null;
  routes: UnifiedRoutes | null;
  errors: StructuredError[];
  rawLLMOutput?: string;
}

export interface UnifiedExtractorOpts {
  client: MemoryLLMClient;
  model: string;
  timeoutMs?: number;
}

export class UnifiedExtractor {
  private readonly client: MemoryLLMClient;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(opts: UnifiedExtractorOpts) {
    this.client = opts.client;
    this.model = opts.model;
    // [batch-1] raised from 15_000 → 30_000: SiliconFlow Qwen2.5-72B
    // under real load sometimes returns 20-25s; 15s false-times.
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  async extract(input: ExtractInput): Promise<ExtractResult> {
    const raw = await this._callLLM(input);
    if (!raw.ok) return { ok: false, error: raw.error };
    const parsed = this._parseJson(raw.text);
    if (!parsed.ok) return { ok: false, error: parsed.error, rawLLMOutput: raw.text };

    // Normalize nulls + tolerate common model drift before validation.
    const normalized = normalizeExtractorOutput(parsed.value);

    // ── Strict path ──
    const strict = UnifiedMemoryExtractionSchema.safeParse(normalized);
    if (strict.success) {
      return { ok: true, payload: strict.data, rawLLMOutput: raw.text };
    }
    const strictErrors = mapZodIssues(strict.error.issues);
    const strictErr = strict.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');

    // ── Salvage fallback ──
    //
    // Strict failed. Try per-section parse; if `event` is recoverable, build
    // a payload with defaulted (empty) sections for the failed ones and
    // return ok=true with salvaged=true marker.
    //
    // Design rationale: prompt drift or single-field bugs should NOT zero out
    // the audit log. Router will filter by gate +
    // confidence anyway; any partially-bogus section just produces no writes.
    const partial = this._parseSections(normalized);
    if (partial.event) {
      const salvagedPayload = {
        version: 'v1' as const,
        event: partial.event,
        facts: partial.facts ?? {},
        routes: partial.routes ?? {},
        salvaged: true,
      } as UnifiedMemoryExtraction & { salvaged: true };
      return {
        ok: true,
        payload: salvagedPayload,
        rawLLMOutput: raw.text,
        errors: strictErrors,
        // Expose the diagnostic but keep ok=true.
        error: `schema validation failed (salvaged): ${strictErr}; section errors: ${partial.errors.map(formatStructuredError).join(' | ')}`,
      };
    }

    // Even event couldn't be salvaged — fail.
    return {
      ok: false,
      error: `schema validation failed (unsalvageable — event missing/malformed): ${strictErr}`,
      errors: strictErrors,
      rawLLMOutput: raw.text,
    };
  }

  async extractPartial(input: ExtractInput): Promise<PartialExtractResult> {
    const result: PartialExtractResult = { event: null, facts: null, routes: null, errors: [] };
    const raw = await this._callLLM(input);
    if (!raw.ok) {
      result.errors.push({ stage: 'extract', message: raw.error ?? 'llm call failed' });
      return result;
    }
    result.rawLLMOutput = raw.text;
    const parsed = this._parseJson(raw.text);
    if (!parsed.ok) {
      result.errors.push({ stage: 'extract', message: parsed.error ?? 'json parse failed' });
      return result;
    }

    const normalized = normalizeExtractorOutput(parsed.value);
    const sections = this._parseSections(normalized);
    result.event  = sections.event;
    result.facts  = sections.facts;
    result.routes = sections.routes;
    result.errors = sections.errors;
    return result;
  }

  /**
   * Per-section safeParse. Shared by extractPartial() and the salvage path
   * inside extract() — keeps a single source of truth for partial parsing.
   */
  private _parseSections(normalized: unknown): {
    event: UnifiedEvent | null;
    facts: UnifiedFacts | null;
    routes: UnifiedRoutes | null;
    errors: StructuredError[];
  } {
    const errors: StructuredError[] = [];
    const obj = (normalized as Record<string, unknown>) ?? {};
    const tryParse = <T>(label: string, schema: z.ZodType<T>, value: unknown): T | null => {
      const r = schema.safeParse(value);
      if (r.success) return r.data;
      for (const issue of r.error.issues) {
        const structured = mapZodIssue(issue);
        errors.push({
          ...structured,
          path: structured.path ? `${label}.${structured.path}` : label,
        });
      }
      return null;
    };
    return {
      event:  tryParse('event',  EventSchema,  obj.event),
      facts:  tryParse('facts',  FactsSchema,  obj.facts ?? {}),
      routes: tryParse('routes', RoutesSchema, obj.routes ?? {}),
      errors,
    };
  }

  private async _callLLM(input: ExtractInput): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const resp = await this.client.chatCompletion({
        model: this.model,
        messages: [
          { role: 'system', content: UNIFIED_EXTRACTOR_SYSTEM_PROMPT },
          { role: 'user',   content: buildExtractorUserMessage(input) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 1500,
        signal: controller.signal,
      });
      return { ok: true, text: resp.content };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `llm call failed: ${m}` };
    } finally {
      clearTimeout(timer);
    }
  }

  private _parseJson(s: string): { ok: true; value: unknown } | { ok: false; error: string } {
    try { return { ok: true, value: JSON.parse(stripCodeFence(s)) }; }
    catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `json parse failed: ${m}` };
    }
  }
}

function stripCodeFence(s: string): string {
  const m = s.trim().match(/^```(?:json)?\n([\s\S]*?)\n```$/);
  return m ? m[1]! : s.trim();
}

function mapZodIssues(issues: z.ZodIssue[]): StructuredError[] {
  return issues.map(mapZodIssue);
}

function mapZodIssue(issue: z.ZodIssue): StructuredError {
  const maybe = issue as z.ZodIssue & { received?: unknown; input?: unknown };
  const received = 'received' in maybe ? maybe.received : ('input' in maybe ? maybe.input : undefined);
  return {
    stage: 'extract',
    ...(issue.path.length > 0 ? { path: issue.path.join('.') } : {}),
    message: issue.message,
    ...(received !== undefined ? { received } : {}),
  };
}

function formatStructuredError(err: StructuredError): string {
  return err.path ? `${err.path}: ${err.message}` : err.message;
}
