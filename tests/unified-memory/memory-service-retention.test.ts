import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { MemoryService } from '../../src/agent/memory/service';
import { MemorySettings } from '../../src/agent/memory/config';
import type { SysCore } from '../../src/agent/memory/types';

let passed = 0;
let failed = 0;

// Keep retention tests deterministic and prevent conversation-derived test
// strings from ever reaching a real provider endpoint.
const modelServer = Bun.serve({
  port: 0,
  async fetch(request) {
    const body = await request.json() as { input?: string | string[] };
    const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ''];
    return Response.json({
      object: 'list',
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [0, 0, 0, 0] })),
      model: 'test-embedding',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  },
});

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  OK ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

function makeService(): { svc: MemoryService; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'avatanel-memory-retention-'));
  const dbPath = join(root, 'memory.db');
  const configPath = join(root, 'memory-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      storage: {
        sqlite_path: dbPath,
        vector_db_path: join(root, 'vectors.db'),
      },
      write: {
        active_threads_limit: 3,
        current_focus_limit: 3,
      },
      model: {
        api_key: 'test-only',
        base_url: `${modelServer.url}v1`,
        embedding_model: 'test-embedding',
        embedding_dim: 4,
      },
    }),
    'utf8',
  );
  return { svc: new MemoryService(new MemorySettings(configPath)), dbPath };
}

function readSysCore(dbPath: string, userId: string): SysCore {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ sys_core: string }, [string]>('SELECT sys_core FROM users WHERE user_id = ?')
      .get(userId);
    if (!row) throw new Error(`missing user ${userId}`);
    return JSON.parse(row.sys_core) as SysCore;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const userId = 'u-retention';
  const { svc, dbPath } = makeService();
  await svc.init();
  await svc.warmup(userId);

  console.log('--- active threads keep newest writes inside the limit ---');
  await svc.upsertActiveThread(userId, { topic_quote: 'old thread one', status: 'waiting' });
  await svc.upsertActiveThread(userId, { topic_quote: 'old thread two', status: 'waiting' });
  await svc.upsertActiveThread(userId, { topic_quote: 'old thread three', status: 'waiting' });
  await svc.upsertActiveThread(userId, { topic_quote: 'new thread', topic_label: '最新线程', status: 'active' });
  let threads = readSysCore(dbPath, userId).digest.active_threads;
  assert(threads.map((t) => t.topic).join('|') === '最新线程|old thread three|old thread two', 'new active thread is retained and oldest is trimmed');

  console.log('--- active thread updates move the topic to the front ---');
  await svc.upsertActiveThread(userId, { topic_quote: 'old thread two', status: 'active', next_step: 'continue' });
  threads = readSysCore(dbPath, userId).digest.active_threads;
  assert(threads[0]?.topic === 'old thread two', 'updated thread becomes most recent');
  assert(threads[0]?.next_step === 'continue', 'updated thread next_step is persisted');

  console.log('--- resolved active threads are removed ---');
  await svc.upsertActiveThread(userId, { topic_quote: 'old thread two', status: 'resolved' });
  threads = readSysCore(dbPath, userId).digest.active_threads;
  assert(!threads.some((t) => t.topic === 'old thread two'), 'resolved thread is not kept in active_threads');

  console.log('--- current focus treats higher priority as more urgent ---');
  await svc.upsertFocus(userId, { topic_quote: 'low focus', priority: 1 });
  await svc.upsertFocus(userId, { topic_quote: 'medium focus', priority: 5 });
  await svc.upsertFocus(userId, { topic_quote: 'existing priority six', priority: 6 });
  await svc.upsertFocus(userId, { topic_quote: 'urgent focus', topic_label: '高优先级焦点', priority: 8 });
  let focus = readSysCore(dbPath, userId).digest.current_focus;
  assert(focus.map((f) => f.display_topic ?? f.topic).join('|') === '高优先级焦点|existing priority six|medium focus', 'high priority focus displaces stale low priority focus');

  console.log('--- current focus uses recency as tie-breaker ---');
  await svc.upsertFocus(userId, { topic_quote: 'new priority six', priority: 6 });
  focus = readSysCore(dbPath, userId).digest.current_focus;
  assert(focus.map((f) => f.topic).join('|') === 'urgent focus|new priority six|existing priority six', 'new equal-priority focus is retained ahead of older equal-priority focus');

  console.log('--- topic identity normalizes punctuation and spacing ---');
  await svc.upsertActiveThread(userId, { topic_quote: '投稿 材料', status: 'waiting' });
  await svc.upsertActiveThread(userId, { topic_quote: '投稿材料', status: 'active', next_step: '整理' });
  threads = readSysCore(dbPath, userId).digest.active_threads;
  assert(threads.filter((t) => t.topic.includes('投稿')).length === 1, 'active thread does not fork on spacing');
  assert(threads.find((t) => t.topic.includes('投稿'))?.next_step === '整理', 'active thread normalized update is persisted');

  await svc.upsertFocus(userId, { topic_quote: '记忆 系统', priority: 4 });
  await svc.upsertFocus(userId, { topic_quote: '记忆系统', priority: 7 });
  focus = readSysCore(dbPath, userId).digest.current_focus;
  assert(focus.filter((f) => f.topic.includes('记忆')).length === 1, 'focus does not fork on spacing');
  assert(focus.find((f) => f.topic.includes('记忆'))?.priority === 7, 'focus normalized update is persisted');

  console.log('--- archive handles ISO created_at timestamps ---');
  await svc.addMemoryCluster(userId, {
    fact: 'old ISO memory',
    importance_score: 0.9,
    created_at: '2000-01-15T00:00:00.000Z',
    date: '2000-01-15',
  });
  await svc.addMemoryCluster(userId, {
    fact: 'recent ISO memory',
    importance_score: 0.9,
    created_at: new Date().toISOString(),
    date: new Date().toISOString().slice(0, 10),
  });
  await svc.archive(userId);
  const archived = readSysCore(dbPath, userId).digest;
  assert(!archived.memory_clusters.some((cluster) => cluster.fact === 'old ISO memory'), 'old ISO cluster is archived out of live digest');
  assert(archived.memory_clusters.some((cluster) => cluster.fact === 'recent ISO memory'), 'recent ISO cluster remains live');
  assert(archived.long_term_index.some((entry) => entry.month === '2000-01'), 'archive month is derived from ISO/date fields');

  svc.close();
  if (failed > 0) {
    throw new Error(`${failed} assertion(s) failed`);
  }
  console.log(`\n${passed} assertions passed.`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
} finally {
  modelServer.stop(true);
}
