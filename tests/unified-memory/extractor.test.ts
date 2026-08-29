import { UnifiedExtractor } from '../../src/agent/memory/unified/extractor';
import type { MemoryLLMClient } from '../../src/agent/memory/llmClient';
import { UNIFIED_EXTRACTOR_SYSTEM_PROMPT } from '../../src/agent/memory/unified/prompts';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

function makeClient(response: string): MemoryLLMClient {
  return {
    async chatCompletion() { return { content: response }; },
    async embed() { return new Float32Array(); },
  } as unknown as MemoryLLMClient;
}

const goodPayload = {
  version: 'v1',
  event: { ts: '2026-04-18T00:00:00.000Z', summary: '用户问了王阳明', attribution: 'Generate', confidence: 0.9, categories: ['memory'] },
  facts: { memory_clusters: [{ fact: '用户对哲学感兴趣', evidence: '对哲学感兴趣', importance_score: 0.6 }] },
  routes: {},
};

async function main() {
  console.log('--- Test 1: extract() returns parsed payload on valid LLM JSON ---');
  {
    const ex = new UnifiedExtractor({ client: makeClient(JSON.stringify(goodPayload)), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: 'q', assistantResponse: 'a', turnIndex: 1, sessionId: 's' });
    assert(r.ok === true, 'valid → ok');
    assert(r.payload?.event.summary === '用户问了王阳明', 'event passed through');
  }

  console.log('--- Test 1b: extractor prompt names expression/mission route responsibilities ---');
  {
    assert(UNIFIED_EXTRACTOR_SYSTEM_PROMPT.includes('expression feedback'), 'prompt names expression feedback route');
    assert(UNIFIED_EXTRACTOR_SYSTEM_PROMPT.includes('mission patterns'), 'prompt names mission patterns route');
    assert(UNIFIED_EXTRACTOR_SYSTEM_PROMPT.includes('expression_pending'), 'prompt includes expression_pending key');
    assert(UNIFIED_EXTRACTOR_SYSTEM_PROMPT.includes('mission_pending'), 'prompt includes mission_pending key');
    assert(UNIFIED_EXTRACTOR_SYSTEM_PROMPT.includes('不要把提示词规避/安全措辞模板写入 routes'), 'prompt blocks safety wording templates from routes');
  }

  console.log('--- Test 2: extract() surfaces parse error without throwing ---');
  {
    const ex = new UnifiedExtractor({ client: makeClient('not json'), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: 'q', assistantResponse: 'a', turnIndex: 1, sessionId: 's' });
    assert(r.ok === false, 'bad json → !ok');
    assert(r.error?.includes('parse') === true, 'mentions parse');
  }

  console.log('--- Test 3: extract() surfaces schema error without throwing ---');
  {
    const wrong = JSON.stringify({ version: 'v1', event: {}, facts: {}, routes: {} });
    const ex = new UnifiedExtractor({ client: makeClient(wrong), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: 'q', assistantResponse: 'a', turnIndex: 1, sessionId: 's' });
    assert(r.ok === false, 'wrong shape → !ok');
    assert(r.error?.includes('schema') === true, 'mentions schema');
    assert((r.errors?.length ?? 0) > 0, 'structured errors returned');
  }

  console.log('--- Test 4: extract() strips JSON code-fence ---');
  {
    const fenced = '```json\n' + JSON.stringify(goodPayload) + '\n```';
    const ex = new UnifiedExtractor({ client: makeClient(fenced), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: 'q', assistantResponse: 'a', turnIndex: 1, sessionId: 's' });
    assert(r.ok === true, 'fenced JSON parses');
  }

  console.log('--- Test 5: extractPartial() — bad facts, good event salvaged ---');
  {
    const partial = JSON.stringify({
      version: 'v1',
      event: { ts: 't', summary: 'good event', confidence: 0.7, categories: ['memory'] },
      facts: { memory_clusters: [{ fact: 'x', importance_score: 99 }] },
      routes: {},
    });
    const ex = new UnifiedExtractor({ client: makeClient(partial), model: 'test' });
    const r = await ex.extractPartial({ userId: 'u', userMessage: 'q', assistantResponse: 'a', turnIndex: 1, sessionId: 's' });
    assert(r.event !== null, 'event salvaged');
    assert(r.event?.summary === 'good event', 'event content preserved');
    assert(r.facts === null, 'bad facts → null section');
    assert(r.routes !== null, 'empty routes still parsed');
    assert(r.errors.length > 0, 'partial errors recorded');
  }

  console.log('--- Test 6: extract() salvage returns structured issue paths ---');
  {
    const partial = JSON.stringify({
      version: 'v1',
      event: { ts: '2026-04-18T00:00:00.000Z', summary: '用户自报姓名', confidence: 0.85, categories: ['profile'] },
      facts: {
        profile_update: {
          // evidence < 4 chars → structured error on evidence path
          basic_info: [{ field: 'nickname', value_quote: '小林', value_label: '小林', evidence: '小林' }],
        },
      },
      routes: {},
    });
    const ex = new UnifiedExtractor({ client: makeClient(partial), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: '我叫小林', assistantResponse: '你好呀', turnIndex: 1, sessionId: 's' });
    assert(r.ok === true, 'salvage still returns ok');
    assert((r.payload as { salvaged?: boolean } | undefined)?.salvaged === true, 'salvaged flag set');
    assert(r.errors?.some((e) => e.path === 'facts.profile_update.basic_info.0.evidence') === true, 'structured path preserved');
  }

  console.log('--- Test 6b [PR3a]: normalizeExtractorOutput — legacy focus.topic is dropped ---');
  {
    const legacy = JSON.stringify({
      version: 'v1',
      event: { ts: '2026-04-18T00:00:00.000Z', summary: '用户说要投稿', confidence: 0.9, categories: ['memory'] },
      facts: {
        focus: [{ topic: '投稿材料', priority: 9 }],
      },
      routes: {},
    });
    const ex = new UnifiedExtractor({ client: makeClient(legacy), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: '投稿材料要搞完', assistantResponse: 'ok', turnIndex: 1, sessionId: 's' });
    assert(r.ok === true, 'payload still parses after invalid optional focus candidate is dropped');
    assert((r.payload as { salvaged?: boolean } | undefined)?.salvaged !== true, 'no compatibility salvage path used');
    assert((r.errors?.length ?? 0) === 0, 'dropped optional legacy candidate does not become extract error');
    assert(r.payload?.facts.focus === undefined, 'legacy focus shape is not mapped into memory');
  }

  console.log('--- Test 6c [PR3a]: new-shape focus passes through unchanged ---');
  {
    const modern = JSON.stringify({
      version: 'v1',
      event: { ts: '2026-04-18T00:00:00.000Z', summary: '用户说要投稿', confidence: 0.9, categories: ['memory'] },
      facts: {
        focus: [{ topic_quote: '投稿材料', topic_label: '论文投稿准备', priority: 9 }],
      },
      routes: {},
    });
    const ex = new UnifiedExtractor({ client: makeClient(modern), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: '投稿材料要搞完', assistantResponse: 'ok', turnIndex: 1, sessionId: 's' });
    assert(r.ok === true, 'modern focus shape parses strict');
    assert(r.payload?.facts.focus?.[0]?.topic_quote === '投稿材料', 'topic_quote passes through');
    assert(r.payload?.facts.focus?.[0]?.topic_label === '论文投稿准备', 'topic_label passes through');
  }

  console.log('--- Test 6d: invalid optional topic candidates are pruned before strict schema parse ---');
  {
    const noisy = JSON.stringify({
      version: 'v1',
      event: { ts: '2026-05-07T00:00:00.000Z', summary: '用户准备继续主帖', confidence: 0.9, categories: ['memory'] },
      facts: {
        active_threads: [
          { topic_quote: '发', status: 'active' },
          { topic_quote: 'Day2 主帖', topic_label: '   ', status: 'active', next_step: '继续发布' },
        ],
      },
      routes: {},
    });
    const ex = new UnifiedExtractor({ client: makeClient(noisy), model: 'test' });
    const r = await ex.extract({ userId: 'u', userMessage: 'Day2 主帖继续', assistantResponse: 'ok', turnIndex: 1, sessionId: 's' });
    assert(r.ok === true, 'noisy optional candidate payload parses');
    assert((r.payload as { salvaged?: boolean } | undefined)?.salvaged !== true, 'strict path preserved');
    assert((r.errors?.length ?? 0) === 0, 'pruned optional candidate does not become extract error');
    assert(r.payload?.facts.active_threads?.length === 1, 'valid active_thread preserved');
    assert(r.payload?.facts.active_threads?.[0]?.topic_quote === 'Day2 主帖', 'short quote candidate dropped');
    assert(r.payload?.facts.active_threads?.[0]?.topic_label === undefined, 'blank optional label dropped');
  }

  console.log('--- Test 7: extractPartial() — all good ---');
  {
    const ex = new UnifiedExtractor({ client: makeClient(JSON.stringify(goodPayload)), model: 'test' });
    const r = await ex.extractPartial({ userId: 'u', userMessage: 'q', assistantResponse: 'a', turnIndex: 1, sessionId: 's' });
    assert(r.event !== null && r.facts !== null && r.routes !== null, 'all sections parsed');
    assert(r.errors.length === 0, 'no errors');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
