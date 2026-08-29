// tests/unified-memory/schema.test.ts
import {
  UnifiedMemoryExtractionSchema, EventSchema, FactsSchema, RoutesSchema,
} from '../../src/agent/memory/unified/schema';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

console.log('--- Test 1: minimal valid payload parses ---');
{
  const m = {
    version: 'v1',
    event: { ts: '2026-04-18T12:00:00.000Z', summary: 'user opened topic', confidence: 0.9, categories: ['memory'] },
    facts: {},
    routes: {},
  };
  assert(UnifiedMemoryExtractionSchema.safeParse(m).success, 'minimal payload');
}

console.log('--- Test 2: confidence bounded [0,1] ---');
{
  const bad = { version: 'v1', event: { ts: 't', summary: 's', confidence: 1.5, categories: [] }, facts: {}, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(bad).success, 'confidence > 1 rejected');
}

console.log('--- Test 3: profile_update field requires value_quote + evidence ---');
{
  const noEv = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
    facts: { profile_update: { basic_info: [{ field: 'nickname', value_quote: 'Ada' }] } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(noEv).success, 'no evidence rejected');

  const noQuote = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
    facts: { profile_update: { basic_info: [{ field: 'nickname', evidence: '我叫 Ada' }] } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(noQuote).success, 'no value_quote rejected');

  const ok = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
    facts: { profile_update: { basic_info: [{ field: 'nickname', value_quote: 'Ada', value_label: 'Ada', evidence: '我叫 Ada' }] } }, routes: {} };
  assert(UnifiedMemoryExtractionSchema.safeParse(ok).success, 'with value_quote + evidence accepted');

  const quoteNoLabel = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
    facts: { profile_update: { basic_info: [{ field: 'nickname', value_quote: 'Ada', evidence: '我叫 Ada' }] } }, routes: {} };
  assert(UnifiedMemoryExtractionSchema.safeParse(quoteNoLabel).success, 'quote without label accepted');

  const spaceQuote = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
    facts: { profile_update: { basic_info: [{ field: 'nickname', value_quote: '   ', value_label: 'Ada', evidence: '我叫 Ada' }] } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(spaceQuote).success, 'whitespace value_quote rejected');

  const spaceLabel = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
    facts: { profile_update: { basic_info: [{ field: 'nickname', value_quote: 'Ada', value_label: '   ', evidence: '我叫 Ada' }] } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(spaceLabel).success, 'whitespace value_label rejected');
}

console.log('--- Test 4: intimacy_delta clamped to ±0.05 at schema ---');
{
  const tooBig = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { intimacy_delta: 0.5 } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(tooBig).success, '> 0.05 rejected');
}

console.log('--- Test 5: active_threads.status enum + topic_quote required ---');
{
  const bad = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { active_threads: [{ topic_quote: 'xy', status: 'pending' }] }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(bad).success, 'unknown status rejected');

  const noQuote = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { active_threads: [{ topic_label: '阅读', status: 'active' }] }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(noQuote).success, 'active_thread without topic_quote rejected');

  const ok = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { active_threads: [{ topic_quote: '看《三体》', topic_label: '阅读《三体》', status: 'active' }] }, routes: {} };
  assert(UnifiedMemoryExtractionSchema.safeParse(ok).success, 'topic_quote + label accepted');

  const spaceQuote = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { active_threads: [{ topic_quote: '   ', topic_label: '阅读《三体》', status: 'active' }] }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(spaceQuote).success, 'whitespace topic_quote rejected');

  const spaceLabel = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { active_threads: [{ topic_quote: '看《三体》', topic_label: '   ', status: 'active' }] }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(spaceLabel).success, 'whitespace topic_label rejected');
}

console.log('--- Test 6: relationship.current_vibe_quote rejects <2 chars ---');
{
  const empty = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_quote: '' } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(empty).success, 'empty vibe_quote rejected');

  const ws = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_quote: '   ' } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(ws).success, 'whitespace vibe_quote rejected');

  const oneChar = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_quote: '累' } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(oneChar).success, '1-char vibe_quote rejected');
}

console.log('--- Test 7: relationship.current_vibe_label REQUIRES current_vibe_quote [PR2 iron rule] ---');
{
  const labelNoQuote = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_label: '疲惫' } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(labelNoQuote).success, 'label without quote rejected');

  const quoteOnly = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_quote: '心里暖暖的' } }, routes: {} };
  assert(UnifiedMemoryExtractionSchema.safeParse(quoteOnly).success, 'quote without label accepted');

  const both = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_quote: '心里暖暖的', current_vibe_label: '温暖' } }, routes: {} };
  assert(UnifiedMemoryExtractionSchema.safeParse(both).success, 'quote + label accepted');

  const spaceLabel = { version: 'v1', event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
    facts: { relationship: { current_vibe_quote: '心里暖暖的', current_vibe_label: '   ' } }, routes: {} };
  assert(!UnifiedMemoryExtractionSchema.safeParse(spaceLabel).success, 'whitespace label rejected');
}

console.log('--- Test 8: section schemas exported for partial parse ---');
{
  assert(EventSchema.safeParse({ ts: 't', summary: 's', confidence: 0.5, categories: [] }).success, 'EventSchema works alone');
  assert(FactsSchema.safeParse({}).success, 'FactsSchema accepts empty');
  assert(RoutesSchema.safeParse({}).success, 'RoutesSchema accepts empty');
}

console.log('--- Test 9 [PR3a]: focus requires topic_quote; topic_label without topic_quote rejected ---');
{
  const base = { version: 'v1' as const, event: { ts: 't', summary: 's', confidence: 0.9, categories: [] as string[] }, routes: {} as Record<string, never> };

  const legacyShape = { ...base, facts: { focus: [{ topic: '投稿材料', priority: 9 }] } };
  assert(!UnifiedMemoryExtractionSchema.safeParse(legacyShape).success, 'legacy {topic, priority} rejected (shim runs in extractor, not schema)');

  const ok = { ...base, facts: { focus: [{ topic_quote: '投稿材料', topic_label: '论文投稿准备', priority: 9 }] } };
  assert(UnifiedMemoryExtractionSchema.safeParse(ok).success, 'topic_quote + label + priority accepted');

  const quoteOnly = { ...base, facts: { focus: [{ topic_quote: '投稿材料', priority: 9 }] } };
  assert(UnifiedMemoryExtractionSchema.safeParse(quoteOnly).success, 'topic_quote without label accepted');

  const labelNoQuote = { ...base, facts: { focus: [{ topic_label: '论文投稿准备', priority: 9 }] } };
  assert(!UnifiedMemoryExtractionSchema.safeParse(labelNoQuote).success, 'topic_label without topic_quote rejected');

  const oneChar = { ...base, facts: { focus: [{ topic_quote: '投', priority: 9 }] } };
  assert(!UnifiedMemoryExtractionSchema.safeParse(oneChar).success, '1-char topic_quote rejected');

  const wsQuote = { ...base, facts: { focus: [{ topic_quote: '   ', topic_label: '论文投稿准备', priority: 9 }] } };
  assert(!UnifiedMemoryExtractionSchema.safeParse(wsQuote).success, 'whitespace topic_quote rejected');

  const wsLabel = { ...base, facts: { focus: [{ topic_quote: '投稿材料', topic_label: '   ', priority: 9 }] } };
  assert(!UnifiedMemoryExtractionSchema.safeParse(wsLabel).success, 'whitespace topic_label rejected');

  const badPriority = { ...base, facts: { focus: [{ topic_quote: '投稿材料', priority: 99 }] } };
  assert(!UnifiedMemoryExtractionSchema.safeParse(badPriority).success, 'priority > 10 rejected');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
