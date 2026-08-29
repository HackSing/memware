// tests/unified-memory/router.test.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routeUnifiedExtraction } from '../../src/agent/memory/unified/router';
import { AuditLogWriter } from '../../src/agent/memory/unified/auditLog';
import type { UnifiedMemoryExtraction } from '../../src/agent/memory/unified/schema';
import { DEFAULT_THRESHOLDS } from '../../src/agent/memory/unified/thresholds';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

interface FakeMemoryState {
  addClusterCalls: Array<{ userId: string; cluster: unknown }>;
  updateProfileCalls: Array<{ userId: string; profile: unknown }>;
  updateRelationshipCalls: Array<{ userId: string; rel: unknown }>;
  upsertActiveThreadCalls: Array<{ userId: string; thread: unknown }>;
  upsertFocusCalls: Array<{ userId: string; focus: unknown }>;
}

function makeFakeMemory(existingLanguage: string | null = 'zh') {
  const s: FakeMemoryState = { addClusterCalls: [], updateProfileCalls: [], updateRelationshipCalls: [], upsertActiveThreadCalls: [], upsertFocusCalls: [] };
  return Object.assign(s, {
    getUserProfileLanguage() { return existingLanguage ?? undefined; },
    async addMemoryCluster(userId: string, cluster: unknown) { s.addClusterCalls.push({ userId, cluster }); },
    async updateProfile(userId: string, profile: unknown)    { s.updateProfileCalls.push({ userId, profile }); },
    async updateRelationship(userId: string, rel: unknown)   { s.updateRelationshipCalls.push({ userId, rel }); },
    async upsertActiveThread(userId: string, thread: unknown){ s.upsertActiveThreadCalls.push({ userId, thread }); },
    async upsertFocus(userId: string, focus: unknown)        { s.upsertFocusCalls.push({ userId, focus }); },
  });
}

function makeFakeWorkspace() {
  const s = { pendingRules: [] as unknown[], errors: [] as string[], learnings: [] as string[], expressions: [] as unknown[], missions: [] as unknown[] };
  return Object.assign(s, {
    appendPendingRule(r: unknown) { s.pendingRules.push(r); return 'r-id'; },
    appendError(c: string) { s.errors.push(c); },
    appendLearning(c: string) { s.learnings.push(c); },
    appendPendingExpression(e: unknown) { s.expressions.push(e); },
    appendPendingMission(m: unknown) { s.missions.push(m); },
  });
}

async function main() {
  const baseCtx = (overrides: Record<string, unknown> = {}) => ({
    userId: 'u', sessionId: 's', turnIndex: 7,
    userMessage: '我叫 Ada，今年 32 岁，喜欢哲学',
    assistantMessage: '好的，我记住了。',
    auditLog: new AuditLogWriter(mkdtempSync(join(tmpdir(), 'audit-route-'))),
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  });

  console.log('--- Test 1: live mode — high-conf cluster written + provenance attached ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.9, categories: ['memory'] },
      facts: { memory_clusters: [{ fact: '用户喜欢哲学', evidence: '喜欢哲学', importance_score: 0.7 }] },
      routes: {},
    };
    await routeUnifiedExtraction(ext, { ...baseCtx(), memory: mem as never, workspace: ws as never });
    assert(mem.addClusterCalls.length === 1, 'cluster written in live mode');
    const c = mem.addClusterCalls[0].cluster as { provenance?: { source: string; confidence: number } };
    assert(c.provenance?.source === 'unified-extraction-v1', 'provenance attached');
  }

  console.log('--- Test 3: low-conf cluster suppressed ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.2, categories: ['memory'] },
      facts: { memory_clusters: [{ fact: 'x', evidence: '喜欢哲学', importance_score: 0.5 }] },
      routes: {},
    };
    await routeUnifiedExtraction(ext, { ...baseCtx(), memory: mem as never, workspace: ws as never });
    assert(mem.addClusterCalls.length === 0, 'cluster suppressed by confidence gate');
  }

  console.log('--- Test 4 [P1.1]: profile with fabricated value blocked by hard gate ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    // userMessage is "我叫 Ada，今年 32 岁，喜欢哲学" — does NOT contain "Tokyo"
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
      facts: { profile_update: { basic_info: [{ field: 'location', value_quote: 'Tokyo', value_label: 'Tokyo', evidence: '我叫 Ada' }] } },
    routes: {} };
    await routeUnifiedExtraction(ext, { ...baseCtx(), memory: mem as never, workspace: ws as never });
    assert(mem.updateProfileCalls.length === 0, 'fabricated profile blocked (value not in evidence)');
  }

  console.log('--- Test 5: active_thread topic="general" blocked ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.9, categories: [] },
      facts: { active_threads: [{ topic_quote: 'general', status: 'active' }] },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, { ...baseCtx(), memory: mem as never, workspace: ws as never });
    assert(mem.upsertActiveThreadCalls.length === 0, 'generic topic blocked');
    assert(actions.some((a) => a.kind === 'active_thread_blocked' && a.detail.includes('generic-topic')), 'blocked reason surfaced');
  }

  console.log('--- Test 6: ONE failing sink does not block others ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    (mem as unknown as { addMemoryCluster: () => Promise<void> }).addMemoryCluster = async () => { throw new Error('storage offline'); };
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.9, categories: ['memory', 'error'] },
      facts: { memory_clusters: [{ fact: '用户喜欢哲学', evidence: '喜欢哲学', importance_score: 0.5 }] },
      routes: { errors: ['something happened'] },
    };
    await routeUnifiedExtraction(ext, { ...baseCtx(), memory: mem as never, workspace: ws as never });
    assert(ws.errors.length === 1, 'error sink still wrote despite cluster sink failing');
  }

  console.log('--- Test 7 [P2.2]: router clamps intimacy_delta defense-in-depth ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    // Build payload via cast so schema clamp is bypassed (simulating direct router call)
    const ext = {
      version: 'v1' as const,
      event: { ts: 't', summary: 's', confidence: 0.95, categories: [] as Array<'memory'|'learning'|'error'|'expression'|'mission'|'none'> },
      facts: { relationship: { intimacy_delta: 0.5 } },  // out of range
      routes: {},
    } as UnifiedMemoryExtraction;
    await routeUnifiedExtraction(ext, { ...baseCtx(), memory: mem as never, workspace: ws as never });
    if (mem.updateRelationshipCalls.length > 0) {
      const rel = mem.updateRelationshipCalls[0].rel as { intimacy_delta: number };
      assert(rel.intimacy_delta <= 0.05 && rel.intimacy_delta >= -0.05, 'router re-clamped intimacy_delta');
    } else {
      assert(true, 'router rejected before reaching memory');
    }
  }

  console.log('--- Test 8: audit log line written for every call ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const auditDir = mkdtempSync(join(tmpdir(), 'audit-route-'));
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: '2026-04-18T12:00:00.000Z', summary: 's', confidence: 0.9, categories: [] },
      facts: {}, routes: {},
    };
    await routeUnifiedExtraction(ext, { ...baseCtx({ auditLog: new AuditLogWriter(auditDir) }), memory: mem as never, workspace: ws as never });
    const path = join(auditDir, '2026-04-18.jsonl');
    const content = readFileSync(path, 'utf8').trim();
    assert(content.length > 0, 'audit log line written');
    assert(JSON.parse(content).payload.event.summary === 's', 'audit captures payload');
  }

  console.log('--- Test 9: extract errors are persisted as structured audit errors ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const auditDir = mkdtempSync(join(tmpdir(), 'audit-route-'));
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: '2026-04-18T12:00:00.000Z', summary: 's', confidence: 0.9, categories: [] },
      facts: {}, routes: {},
    };
    await routeUnifiedExtraction(ext, {
      ...baseCtx({ auditLog: new AuditLogWriter(auditDir), extractErrors: [{ stage: 'extract', path: 'facts.profile_update.basic_info.0.evidence', message: 'too short' }] }),
      memory: mem as never,
      workspace: ws as never,
    });
    const path = join(auditDir, '2026-04-18.jsonl');
    const content = readFileSync(path, 'utf8').trim();
    const entry = JSON.parse(content) as { errors: Array<{ path?: string }> };
    assert(entry.errors[0]?.path === 'facts.profile_update.basic_info.0.evidence', 'structured extract errors written to audit');
  }

  console.log('--- Test 10b [PR3a]: focus action detail prefers topic_label, audit keeps topic_quote ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const auditDir = mkdtempSync(join(tmpdir(), 'audit-route-'));
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: '2026-04-18T12:00:00.000Z', summary: 's', confidence: 0.95, categories: ['memory'] },
      facts: {
        focus: [{ topic_quote: '投稿材料', topic_label: '论文投稿准备', priority: 9 }],
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({
        auditLog: new AuditLogWriter(auditDir),
        userMessage: '这周必须把投稿材料搞完，否则赶不上 ddl',
      }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(actions.some((a) => a.kind === 'focus_update' && a.detail === '论文投稿准备'), 'focus action detail uses label');
    assert(mem.upsertFocusCalls.length === 1, 'focus upsert called once');
    const focusArg = mem.upsertFocusCalls[0].focus as { topic_quote: string; topic_label?: string; priority: number };
    assert(focusArg.topic_quote === '投稿材料', 'upsert received topic_quote');
    assert(focusArg.topic_label === '论文投稿准备', 'upsert received topic_label');

    // focus without label → detail falls back to quote
    const mem2 = makeFakeMemory();
    const ext2: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: '2026-04-18T12:00:00.000Z', summary: 's', confidence: 0.95, categories: ['memory'] },
      facts: { focus: [{ topic_quote: '投稿材料', priority: 9 }] },
      routes: {},
    };
    const actions2 = await routeUnifiedExtraction(ext2, {
      ...baseCtx({
        auditLog: new AuditLogWriter(mkdtempSync(join(tmpdir(), 'audit-route-'))),
        userMessage: '这周必须把投稿材料搞完，否则赶不上 ddl',
      }),
      memory: mem2 as never,
      workspace: ws as never,
    });
    assert(actions2.some((a) => a.kind === 'focus_update' && a.detail === '投稿材料'), 'focus detail falls back to quote when no label');

    // focus with generic-topic label → blocked by hard gate
    const mem3 = makeFakeMemory();
    const ext3: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: '2026-04-18T12:00:00.000Z', summary: 's', confidence: 0.95, categories: ['memory'] },
      facts: { focus: [{ topic_quote: '投稿材料', topic_label: '这个', priority: 9 }] },
      routes: {},
    };
    const actions3 = await routeUnifiedExtraction(ext3, {
      ...baseCtx({
        auditLog: new AuditLogWriter(mkdtempSync(join(tmpdir(), 'audit-route-'))),
        userMessage: '这周必须把投稿材料搞完，否则赶不上 ddl',
      }),
      memory: mem3 as never,
      workspace: ws as never,
    });
    assert(mem3.upsertFocusCalls.length === 0, 'focus with generic label blocked');
    assert(actions3.some((a) => a.kind === 'focus_blocked'), 'focus_blocked action emitted');
  }

  console.log('--- Test 10 [PR2]: action detail prefers label, audit payload keeps quote ---');
  {
    const mem = makeFakeMemory(); const ws = makeFakeWorkspace();
    const auditDir = mkdtempSync(join(tmpdir(), 'audit-route-'));
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: '2026-04-18T12:00:00.000Z', summary: 's', confidence: 0.95, categories: ['memory'] },
      facts: {
        active_threads: [{ topic_quote: '看《三体》', topic_label: '阅读《三体》', status: 'active' }],
        relationship: { current_vibe_quote: '心里暖暖的', current_vibe_label: '温暖' },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({
        auditLog: new AuditLogWriter(auditDir),
        userMessage: '我最近沉迷看《三体》，谢谢你陪我聊，心里暖暖的',
      }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(actions.some((a) => a.kind === 'active_thread' && a.detail === '阅读《三体》'), 'thread action detail uses label');
    assert(actions.some((a) => a.kind === 'relationship_update' && a.detail === '温暖'), 'relationship action detail uses label');
    const path = join(auditDir, '2026-04-18.jsonl');
    const entry = JSON.parse(readFileSync(path, 'utf8').trim()) as {
      payload: {
        facts: {
          active_threads: Array<{ topic_quote: string }>;
          relationship: { current_vibe_quote: string };
        };
      };
    };
    assert(entry.payload.facts.active_threads[0]?.topic_quote === '看《三体》', 'audit payload keeps topic_quote');
    assert(entry.payload.facts.relationship.current_vibe_quote === '心里暖暖的', 'audit payload keeps current_vibe_quote');
  }

  console.log('--- Test 11 [PR3b]: three-bucket profile policy + sig_memories gate isolation ---');
  {
    // Verbatim bucket: label absent → bypass confidence even at 0.85 (< 0.88 default)
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.85, categories: ['memory'] },
      facts: {
        profile_update: {
          basic_info: [
            { field: 'occupation', value_quote: '对外产品型智能体', evidence: '我现在具体是负责对外产品型智能体' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '我现在具体是负责对外产品型智能体' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 1, 'verbatim bucket bypasses confidence 0.85 < 0.88');
    const detail = actions.find((a) => a.kind === 'profile_update')?.detail ?? '';
    assert(detail.includes('verbatim'), `action detail surfaces bucket name (got: ${detail})`);
  }

  console.log('--- Test 12 [PR3b]: normalized bucket still honors confidence gate ---');
  {
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.85, categories: ['memory'] },
      facts: {
        profile_update: {
          basic_info: [
            { field: 'occupation', value_quote: '对外产品型智能体', value_label: '对外产品型智能体业务负责人', evidence: '我现在具体是负责对外产品型智能体' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '我现在具体是负责对外产品型智能体' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 0, 'normalized bucket suppressed at confidence 0.85');
    const blocked = actions.find((a) => a.kind === 'profile_suppressed');
    assert(!!blocked, 'profile_suppressed action emitted');
    assert(blocked?.detail.includes('bucket=normalized') ?? false, 'detail names bucket=normalized');
  }

  console.log('--- Test 13 [PR3b]: normalized bucket passes when confidence high enough ---');
  {
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.92, categories: ['memory'] },
      facts: {
        profile_update: {
          preferences: [
            { field: 'reading', value_quote: '《三体》', value_label: '三体小说', evidence: '最近在看《三体》' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '最近在看《三体》，真好看' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 1, 'normalized bucket writes when confidence clears');
    const detail = actions.find((a) => a.kind === 'profile_update')?.detail ?? '';
    assert(detail.includes('normalized'), 'detail shows bucket=normalized');
  }

  console.log('--- Test 14 [PR3b]: sig_memories use evidence-only gate + bypass confidence ---');
  {
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.7, categories: ['memory'] },
      facts: {
        profile_update: {
          significant_memories: [
            { event: '用户在 2024 年拿到 YC 录取', importance: 0.9, date: '2024-04-01', evidence: '我 2024 年拿到 YC 录取通知' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '我 2024 年拿到 YC 录取通知' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 1, 'sig_memory passes confidence 0.7 (bypass)');
    const detail = actions.find((a) => a.kind === 'profile_update')?.detail ?? '';
    assert(detail.includes('sig-memory'), 'detail shows bucket=sig-memory');
  }

  console.log('--- Test 15 [PR3b]: sig_memories blocked when evidence fabricated ---');
  {
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: 's', confidence: 0.95, categories: ['memory'] },
      facts: {
        profile_update: {
          significant_memories: [
            { event: '用户 2023 年获得诺贝尔奖', importance: 0.99, date: '2023-10-01', evidence: '用户 2023 年获得诺贝尔奖' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '今天天气不错' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 0, 'sig_memory with fabricated evidence blocked');
    const suppressed = actions.find((a) => a.kind === 'profile_suppressed');
    assert(!!suppressed, 'profile_suppressed action emitted');
    assert(suppressed?.detail.includes('non-substring') ?? false, 'detail reports non-substring hard-gate reason');
  }

  console.log('--- Test 16 [PR3b]: turn 36 regression — verbatim occupation bypasses confidence ceiling ---');
  {
    // Reproduces the real turn 36 case that drove PR3b.
    // DS-V3.2 extractor emitted confidence=0.85 (below default 0.88 threshold) for two
    // basic_info entries. One was verbatim (quote only), one was paraphrase (label
    // differs). After PR3b: verbatim passes, paraphrase suppressed.
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: '用户自报职业', confidence: 0.85, categories: ['memory'] },
      facts: {
        profile_update: {
          basic_info: [
            { field: 'occupation', value_quote: '对外产品型智能体', value_label: '对外产品型智能体', evidence: '我现在具体是负责对外产品型智能体' },
            { field: 'role', value_quote: '业务owenr', value_label: '业务负责人', evidence: '我算是个业务owenr' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '我现在具体是负责对外产品型智能体，我算是个业务owenr' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 1, 'verbatim entry writes (was suppressed pre-PR3b)');
    const written = mem.updateProfileCalls[0].profile as { basic_info: unknown[] };
    assert(written.basic_info.length === 1, 'only the verbatim entry accepted');
    const firstField = (written.basic_info[0] as { field: string }).field;
    assert(firstField === 'occupation', 'verbatim occupation made it through');
    const suppressed = actions.find((a) => a.kind === 'profile_suppressed');
    assert(!!suppressed, 'normalized entry reported as suppressed');
  }

  console.log('--- Test 17 [P2-001]: past-tense occupation is suppressed even in verbatim bucket ---');
  {
    const mem = makeFakeMemory();
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: '用户提到过去职业', confidence: 0.85, categories: ['memory'] },
      facts: {
        profile_update: {
          basic_info: [
            { field: 'occupation', value_quote: '工程师', value_label: '工程师', evidence: '我以前是工程师' },
          ],
        },
      },
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '我以前是工程师，后来转产品了' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 0, 'past occupation does not write into current profile');
    const suppressed = actions.find((a) => a.kind === 'profile_suppressed');
    assert(!!suppressed, 'profile_suppressed action emitted');
    assert(suppressed?.detail.includes('profile-past-occupation') ?? false, 'detail exposes past-occupation reason');
  }

  console.log('--- Test 18: language profile initializes from user message habit when absent ---');
  {
    const mem = makeFakeMemory(null);
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: '用户继续中文对话', confidence: 0.2, categories: ['none'] },
      facts: {},
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '这个默认语言应该跟着用户语言习惯走' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 1, 'language profile written when absent');
    const written = mem.updateProfileCalls[0].profile as { basic_info: Array<{ field: string; value_label?: unknown }> };
    assert(written.basic_info[0]?.field === 'language', 'writes basic_info.language');
    assert(written.basic_info[0]?.value_label === 'zh', 'normalizes Chinese habit to zh');
    assert(actions.some((a) => a.kind === 'language_update' && a.detail === 'zh'), 'language_update action emitted');
  }

  console.log('--- Test 19: language profile does not churn when already set ---');
  {
    const mem = makeFakeMemory('zh');
    const ws = makeFakeWorkspace();
    const ext: UnifiedMemoryExtraction = {
      version: 'v1',
      event: { ts: 't', summary: '用户继续中文对话', confidence: 0.2, categories: ['none'] },
      facts: {},
      routes: {},
    };
    const actions = await routeUnifiedExtraction(ext, {
      ...baseCtx({ userMessage: '继续用中文聊这个问题' }),
      memory: mem as never,
      workspace: ws as never,
    });
    assert(mem.updateProfileCalls.length === 0, 'existing language profile prevents repeated writes');
    assert(!actions.some((a) => a.kind === 'language_update'), 'no language_update action emitted');
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
