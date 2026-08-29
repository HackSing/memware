/**
 * Confidence thresholds + hard gates for unified memory writes.
 *
 * Calibrated by Codex consult (2026-04-18).
 *
 * P1.1 hard gate algorithm (replaces v2 sliding window):
 *   1. evidence ≥4 normalized chars
 *   2. low-entropy reject (unique / total < 0.4)
 *   3. evidence is a CONTINUOUS SUBSTRING of normalize(userMessage)
 *   4. value (if any) appears within evidence
 *
 * This blocks Codex's failure case where evidence overlaps user but
 * doesn't actually contain the value being written.
 */

import {
  checkEvidence,
  checkEvidenceOnly,
  checkQuoteInUserMessage,
  hasSubstringOverlap,
  normalizeMemoryText,
  substringCoverage,
} from './hardGateText';

export type FactCategory = 'profile_update' | 'relationship' | 'active_threads' | 'focus' | 'memory_clusters';
export type Thresholds = Record<FactCategory, number>;

export const DEFAULT_THRESHOLDS: Thresholds = {
  profile_update: 0.88,
  relationship:   0.78,
  active_threads: 0.62,
  focus:          0.48,
  memory_clusters: 0.34,
};

export function mergeThresholds(overrides?: Partial<Thresholds>): Thresholds {
  return { ...DEFAULT_THRESHOLDS, ...(overrides ?? {}) };
}

export function passesConfidenceGate(
  confidence: number,
  category: FactCategory,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): boolean {
  return confidence >= (thresholds[category] ?? 0.5);
}

// ── Hard gate ─────────────────────────────────────────────────────

export interface HardGateContext {
  userMessage: string;
  /** Optional assistant turn text. Never sufficient for durable user memory. */
  assistantMessage?: string;
}

export interface HardGateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Generic topic pattern — reject placeholder/filler topics that carry no semantic content.
 * [PR3a] Extended with Chinese placeholders commonly produced by paraphrase-prone extractors
 * (这个/那个/最近/问题/事情/想法/项目/一下/什么/哪个/怎么/为什么/其他).
 */
const GENERIC_TOPIC_PATTERN = /^(general|none|misc|n\/a|这个|那个|最近|问题|事情|想法|项目|一下|什么|哪个|怎么|为什么|其他)$/i;

// [PR4] Raw-evidence filters for profile basic_info / preferences.
// These MUST run on raw evidence (before normalize strips `：` and similar
// punctuation), otherwise META_PREFIX can never match.

// Business/team predicate: "我们" or "咱们" followed within 6 chars by a
// business verb or noun. Catches "我们公司在做X" / "咱们团队在提供Y" while
// allowing personal family/group usage like "我们家住北京", "咱们老家东北".
const PROFILE_BUSINESS_PREDICATE = /(我们|咱们).{0,6}(做|卖|提供|上线|融资|产品|方案|业务|客户|团队|公司)/;

// Explicit organizational nouns — evidence about a company/department/party,
// not the user themselves. Narrow by design.
const PROFILE_ORG_NOUN = /(我司|本公司|我们公司|部门|公司的|我方)/;

// Evidence that begins with a metadata label (document title, schema field,
// etc) is structural context, not a personal fact. Only high-precision
// prefixes — avoid generic words like "数据"/"prompt"/"任务"/"name" that
// could appear in ordinary speech.
const PROFILE_META_PREFIX = /^\s*(文档标题|标题|题目|文件名|字段|schema|section|key|field)\s*[:：]/i;
const PROFILE_PAST_OCCUPATION_ZH = /(以前|曾经|过去|之前|原来|当年|早年|原本|一度)/;
const PROFILE_PAST_OCCUPATION_EN = /\b(?:used to be|used to work as|formerly|previously|once was|i was once)\b/i;
const TEMPORARY_PROFILE_FIELDS = new Set([
  'current_activity',
  'current_location',
  'current_state',
  'food_taste',
  'investment_activity',
  'location_context',
  'occupation_status',
  'priority',
  'watching',
  'work_schedule',
]);
const TEMPORARY_OCCUPATION_VALUE_PATTERN = /^(公司|上班|要上班|在公司)$/;
const TRANSIENT_BODY_STATE_PATTERN = /^(吃饭|吃药|喝水|喝药|睡觉|睡一觉|休息|困|困了|困倦|疲惫|很累|累了|饿|饿了|饥饿|无饥饿感|头痛|胃痛|发烧|感冒|烧水)$/;
const TRANSIENT_BODY_STATE_PHRASE_PATTERN = /(正在|现在|刚才|一会儿|待会儿|马上|准备|先去|去)?(吃饭|吃药|喝水|喝药|睡觉|休息|困了|困倦|疲惫|很累|累了|饿了|头痛|胃痛|发烧|感冒|烧水)/;
const OPERATIONAL_RELATIONSHIP_VIBE_PATTERN = /亏损|减仓|加仓|防守|进攻|纪律|持仓|仓位|市场|股票|板块|财报|尾盘|午盘|早盘|风险核查/;

// NOTE: Plan v4 line 597-598 specifies MIN_CLUSTER_FACT_LEN=10 / MIN_CLUSTER_OVERLAP_LEN=5
// but its own test 13 uses a 7-char fact ('助手确认了很好') which only shares 4-char
// substrings with the assistant message ('助手确认很好的结论'). Tests-as-spec wins:
// lowered to satisfy both the "pass" and "blocked" cases the plan asserts. Flagged
// in the Phase 0 hand-off so the spec author can reconcile the constant in v5.
const MIN_CLUSTER_FACT_LEN = 4;
const MIN_CLUSTER_OVERLAP_LEN = 4;
const MIN_CLUSTER_EVIDENCE_COVERAGE = 0.55;

function hasPastOccupationSignal(
  evidence: string,
  value: string | undefined,
  userMessage: string,
): boolean {
  const rawUser = userMessage.toLowerCase();
  const rawAnchors = [
    typeof value === 'string' ? value.trim().toLowerCase() : '',
    evidence.trim().toLowerCase(),
  ].filter(Boolean);

  for (const anchor of rawAnchors) {
    const idx = rawUser.indexOf(anchor);
    if (idx === -1) continue;
    const prefix = rawUser.slice(Math.max(0, idx - 24), idx);
    if (PROFILE_PAST_OCCUPATION_EN.test(prefix) || PROFILE_PAST_OCCUPATION_ZH.test(prefix)) {
      return true;
    }
  }

  const normUser = normalizeMemoryText(userMessage);
  const anchors = [
    typeof value === 'string' ? normalizeMemoryText(value) : '',
    normalizeMemoryText(evidence),
  ].filter(Boolean);

  for (const anchor of anchors) {
    const idx = normUser.indexOf(anchor);
    if (idx === -1) continue;
    const prefix = normUser.slice(Math.max(0, idx - 12), idx);
    if (PROFILE_PAST_OCCUPATION_ZH.test(prefix)) return true;
  }

  return false;
}

/**
 * [PR4] Profile basic_info / preferences gate — runs raw-evidence filters
 * before delegating shape/substring checks to checkEvidence.
 *
 * The three filters MUST run on raw evidence (before normalize strips `：` and
 * similar punctuation) — META_PREFIX matches `文档标题：...`, which normalize
 * would flatten to `文档标题...` and no longer match.
 *
 * Filter order is reject-first for high-confidence structural rejections,
 * then business/org predicates. All three use distinct `reason` codes so
 * the downstream logger can attribute rejections per filter.
 */
function checkProfileEvidence(
  field: string | undefined,
  evidence: string,
  value: string | undefined,
  userMessage: string,
): HardGateResult {
  if (PROFILE_META_PREFIX.test(evidence)) return { ok: false, reason: 'profile-meta-prefix' };
  if (PROFILE_ORG_NOUN.test(evidence)) return { ok: false, reason: 'profile-org-noun' };
  if (PROFILE_BUSINESS_PREDICATE.test(evidence)) return { ok: false, reason: 'profile-business-predicate' };
  if (field === 'occupation' && hasPastOccupationSignal(evidence, value, userMessage)) {
    return { ok: false, reason: 'profile-past-occupation' };
  }
  if (isTemporaryProfileFact(field, evidence, value)) return { ok: false, reason: 'profile-temporary-state' };
  return checkEvidence(evidence, value, userMessage);
}

function isTransientBodyState(...values: Array<string | undefined>): boolean {
  return values.some((value) => {
    if (typeof value !== 'string') return false;
    const raw = value.trim();
    if (!raw) return false;
    const compact = normalizeMemoryText(raw);
    return TRANSIENT_BODY_STATE_PATTERN.test(compact) || TRANSIENT_BODY_STATE_PHRASE_PATTERN.test(raw);
  });
}

function isTemporaryProfileFact(field: string | undefined, evidence: string, value: string | undefined): boolean {
  const normalizedField = (field ?? '').trim();
  if (TEMPORARY_PROFILE_FIELDS.has(normalizedField) || normalizedField.startsWith('current_')) {
    return true;
  }
  if (normalizedField === 'occupation') {
    return [evidence, value]
      .filter((item): item is string => typeof item === 'string')
      .some((item) => TEMPORARY_OCCUPATION_VALUE_PATTERN.test(normalizeMemoryText(item)));
  }
  return false;
}

function isOperationalRelationshipVibe(...values: Array<string | undefined>): boolean {
  return values.some((value) => typeof value === 'string' && OPERATIONAL_RELATIONSHIP_VIBE_PATTERN.test(value));
}

function normalizeClusterFactForCoverage(fact: string): string {
  return normalizeMemoryText(fact)
    .replace(/^用户(?:的)?/, '')
    .replace(/^(?:提到|表示|说|称|认为|觉得|感觉|判断|识别出|承认|意识到)/, '');
}

export function evaluateHardGate(
  category: FactCategory,
  item: Record<string, unknown>,
  ctx: HardGateContext,
): HardGateResult {
  switch (category) {
    case 'profile_update': {
      // [PR3b] profile_update contains three heterogeneous sub-shapes.
      //   basic_info / preferences: { field, value_quote, value_label?, evidence }
      //   significant_memories:     { event, importance, date, evidence }  — no value_quote
      //
      // Shape-detect by presence of `event` (sig_memories-only). Previously the
      // single-shape gate applied checkEvidence with value=value_quote, which was
      // always empty for sig_memories → silently blocked every sig_memory record.
      if (typeof item.event === 'string') {
        // significant_memories: evidence-only gate (no value_quote).
        const ev = typeof item.evidence === 'string' ? item.evidence : '';
        return checkEvidenceOnly(ev, ctx.userMessage);
      }
      // basic_info / preferences: PR4 raw-evidence filters + PR2 evidence+value gate.
      const field = typeof item.field === 'string' ? item.field : '';
      const ev = typeof item.evidence === 'string' ? item.evidence : '';
      const quote = typeof item.value_quote === 'string' ? item.value_quote : '';
      return checkProfileEvidence(field, ev, quote, ctx.userMessage);
    }
    case 'relationship': {
      // [PR2] current_vibe_quote replaces current_vibe + evidence.
      // Gate: quote must be a continuous substring of userMessage.
      if (typeof item.current_vibe_quote === 'string' && item.current_vibe_quote.length > 0) {
        const label = typeof item.current_vibe_label === 'string' ? item.current_vibe_label : undefined;
        if (isTransientBodyState(item.current_vibe_quote, label)) return { ok: false, reason: 'transient-body-state' };
        if (isOperationalRelationshipVibe(item.current_vibe_quote, label)) return { ok: false, reason: 'operational-state' };
        return checkQuoteInUserMessage(item.current_vibe_quote, ctx.userMessage, 2);
      }
      return { ok: true };
    }
    case 'active_threads': {
      // [PR2] topic_quote replaces topic. generic-topic pattern still rejected via label/quote.
      const quote = typeof item.topic_quote === 'string' ? item.topic_quote : '';
      const label = typeof item.topic_label === 'string' ? item.topic_label : '';
      if (isTransientBodyState(quote, label)) return { ok: false, reason: 'transient-body-state' };
      if (GENERIC_TOPIC_PATTERN.test(quote.trim())) return { ok: false, reason: 'generic-topic' };
      return checkQuoteInUserMessage(quote, ctx.userMessage, 2);
    }
    case 'focus': {
      // [PR3a] focus topic_quote replaces topic. Reuses checkQuoteInUserMessage which
      // also rejects low-entropy quotes (e.g. '一直一直一直'). Generic placeholder
      // (e.g. '这个', '问题') rejected separately via GENERIC_TOPIC_PATTERN against
      // both quote and label — catches both gated and ungated display strings.
      const quote = typeof item.topic_quote === 'string' ? item.topic_quote : '';
      const label = typeof item.topic_label === 'string' ? item.topic_label : '';
      if (isTransientBodyState(quote, label)) return { ok: false, reason: 'transient-body-state' };
      if (GENERIC_TOPIC_PATTERN.test(quote.trim())) return { ok: false, reason: 'generic-topic' };
      if (label && GENERIC_TOPIC_PATTERN.test(label.trim())) return { ok: false, reason: 'generic-topic' };
      return checkQuoteInUserMessage(quote, ctx.userMessage, 2);
    }
    case 'memory_clusters': {
      // Durable user memory must be grounded in the user's own words. Assistant
      // replies can contain useful analysis, but they are not evidence that the
      // user said or believes that analysis.
      const fact = typeof item.fact === 'string' ? item.fact : '';
      const evidence = typeof item.evidence === 'string' ? item.evidence : '';
      const evidenceGate = checkEvidenceOnly(evidence, ctx.userMessage);
      if (!evidenceGate.ok) return { ok: false, reason: `evidence-${evidenceGate.reason ?? 'invalid'}` };

      const normFact = normalizeClusterFactForCoverage(fact);
      const normEvidence = normalizeMemoryText(evidence);
      if (normFact.length < MIN_CLUSTER_FACT_LEN) return { ok: false, reason: 'fact-too-short' };
      if (!hasSubstringOverlap(normEvidence, normFact, MIN_CLUSTER_OVERLAP_LEN)) {
        return { ok: false, reason: 'fact-no-evidence-overlap' };
      }
      if (substringCoverage(normEvidence, normFact, 2) < MIN_CLUSTER_EVIDENCE_COVERAGE) {
        return { ok: false, reason: 'fact-not-supported-by-evidence' };
      }
      return { ok: true };
    }
  }
}

export function passesHardGate(
  category: FactCategory,
  item: Record<string, unknown>,
  ctx: HardGateContext,
): boolean {
  return evaluateHardGate(category, item, ctx).ok;
}
