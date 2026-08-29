export interface TextGateResult {
  ok: boolean;
  reason?: string;
}

const MIN_EVIDENCE_LEN = 4;
const MIN_ENTROPY_RATIO = 0.4;

export function normalizeMemoryText(value: string): string {
  return value.replace(/[\s，。！？、,.!?:：;；]/g, '');
}

export function checkEvidenceOnly(evidence: string, userMessage: string): TextGateResult {
  const ev = normalizeMemoryText(evidence);
  if (ev.length < MIN_EVIDENCE_LEN) return { ok: false, reason: 'evidence-too-short' };
  if (new Set(ev).size / ev.length < MIN_ENTROPY_RATIO) return { ok: false, reason: 'low-entropy' };
  if (!normalizeMemoryText(userMessage).includes(ev)) return { ok: false, reason: 'non-substring' };
  return { ok: true };
}

export function checkEvidence(
  evidence: string,
  value: string | undefined,
  userMessage: string,
): TextGateResult {
  const ev = normalizeMemoryText(evidence);
  if (ev.length < MIN_EVIDENCE_LEN) return { ok: false, reason: 'evidence-too-short' };
  if (new Set(ev).size / ev.length < MIN_ENTROPY_RATIO) return { ok: false, reason: 'low-entropy' };
  if (!normalizeMemoryText(userMessage).includes(ev)) return { ok: false, reason: 'non-substring' };
  if (typeof value === 'string') {
    const normValue = normalizeMemoryText(value);
    if (normValue.length < 1) return { ok: false, reason: 'quote-too-short' };
    if (!ev.includes(normValue)) return { ok: false, reason: 'value-not-in-evidence' };
  }
  return { ok: true };
}

export function checkQuoteInUserMessage(
  quote: string,
  userMessage: string,
  minLen: number,
): TextGateResult {
  const q = normalizeMemoryText(quote);
  if (q.length < minLen) return { ok: false, reason: 'quote-too-short' };
  if (new Set(q).size / q.length < MIN_ENTROPY_RATIO) return { ok: false, reason: 'low-entropy' };
  if (!normalizeMemoryText(userMessage).includes(q)) return { ok: false, reason: 'non-substring' };
  return { ok: true };
}

export function hasSubstringOverlap(a: string, b: string, minLen: number): boolean {
  if (b.length < minLen || a.length < minLen) return false;
  for (let i = 0; i <= b.length - minLen; i++) {
    if (a.includes(b.slice(i, i + minLen))) return true;
  }
  return false;
}

export function substringCoverage(source: string, claim: string, minLen: number): number {
  if (claim.length === 0 || source.length === 0) return 0;
  const covered = new Array<boolean>(claim.length).fill(false);
  const maxLen = Math.min(source.length, claim.length, 32);
  for (let len = maxLen; len >= minLen; len--) {
    for (let i = 0; i <= claim.length - len; i++) {
      const slice = claim.slice(i, i + len);
      if (!source.includes(slice)) continue;
      for (let j = i; j < i + len; j++) covered[j] = true;
    }
  }
  return covered.filter(Boolean).length / claim.length;
}
