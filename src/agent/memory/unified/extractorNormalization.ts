/**
 * Normalizes common extractor model drift before strict schema validation.
 *
 * This is intentionally separate from `schema.ts`: schema defines the accepted
 * contract, while this module contains narrow compatibility cleanup for LLM
 * output quirks such as null optional sections and legacy topic candidates.
 */

export function normalizeExtractorOutput(value: unknown): unknown {
  const cleaned = stripNulls(value);
  if (typeof cleaned !== 'object' || cleaned === null) return cleaned;

  const obj = cleaned as Record<string, unknown>;
  const event = obj.event;
  if (typeof event === 'object' && event !== null) {
    const eventObj = event as Record<string, unknown>;
    eventObj.categories = normalizeEventCategories(eventObj.categories);
  }

  const facts = obj.facts;
  if (typeof facts === 'object' && facts !== null) {
    normalizeTopicCandidateArrays(facts as Record<string, unknown>);
  }

  return obj;
}

function stripNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map(stripNulls)
      .filter((v) => v !== undefined);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripNulls(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

const ACTIVE_THREAD_STATUSES = new Set(['active', 'waiting', 'resolved']);

function normalizeTopicCandidateArrays(factsObj: Record<string, unknown>): void {
  pruneCandidateArray(factsObj, 'active_threads', (item) => {
    return hasUsableTopicQuote(item) &&
      typeof item.status === 'string' &&
      ACTIVE_THREAD_STATUSES.has(item.status);
  });
  pruneCandidateArray(factsObj, 'focus', (item) => {
    return hasUsableTopicQuote(item) &&
      typeof item.priority === 'number' &&
      Number.isFinite(item.priority) &&
      item.priority >= 0 &&
      item.priority <= 10;
  });
}

function pruneCandidateArray(
  obj: Record<string, unknown>,
  key: string,
  isValid: (item: Record<string, unknown>) => boolean,
): void {
  const raw = obj[key];
  if (!Array.isArray(raw)) return;
  const kept: Array<Record<string, unknown>> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const candidate = item as Record<string, unknown>;
    pruneBlankStringField(candidate, 'topic_label');
    if (isValid(candidate)) kept.push(candidate);
  }
  if (kept.length > 0) obj[key] = kept;
  else delete obj[key];
}

function hasUsableTopicQuote(item: Record<string, unknown>): boolean {
  return typeof item.topic_quote === 'string' && item.topic_quote.trim().length >= 2;
}

function pruneBlankStringField(item: Record<string, unknown>, key: string): void {
  if (typeof item[key] === 'string' && item[key].trim().length === 0) {
    delete item[key];
  }
}

const CANONICAL_EVENT_CATEGORIES = new Set([
  'memory',
  'learning',
  'error',
  'expression',
  'mission',
  'none',
]);

const EVENT_CATEGORY_ALIASES = new Set([
  'profile',
  'profile_update',
  'active_thread',
  'active_threads',
  'memory_cluster',
  'memory_clusters',
  'focus',
  'relationship',
]);

function normalizeEventCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return ['none'];
  const normalized = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    if (CANONICAL_EVENT_CATEGORIES.has(raw)) {
      normalized.add(raw);
      continue;
    }
    if (EVENT_CATEGORY_ALIASES.has(raw)) {
      normalized.add('memory');
    }
  }
  return normalized.size > 0 ? [...normalized] : ['none'];
}
