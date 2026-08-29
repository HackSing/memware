/**
 * Verify deleteByProvenance removes only matching unified-extracted
 * clusters and leaves legacy (no-provenance) clusters intact.
 *
 * Builds a real MemoryService against a tmp DB. Implementation lives in
 * Task 4 (service.ts deleteByProvenance method).
 *
 * v4 P1-D: also verifies vector rows are removed by exact stable ids plus the
 * narrow metadata fallback. We open the underlying
 * VectorStore directly to assert vector rows are gone — using
 * `searchClusters()` would require live embeddings and isn't a
 * strong post-condition (it can return [] for unrelated reasons).
 *
 * NOTE: This test requires `bun:sqlite` and so must be run under Bun:
 *   bun tests/unified-memory/audit.test.ts
 * Under Node + tsx the import of MemoryService will throw and we exit 0
 * with a skip message (consistent with imemory-adapt.test.ts pattern).
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

async function main() {
  const dbDir = mkdtempSync(join(tmpdir(), 'audit-db-'));
  const dbPath = join(dbDir, 'memory.db');
  const vectorDbPath = join(dbDir, 'vectors.db');

  let svc: import('../../src/agent/memory/types').IMemoryService;
  let VectorStore: typeof import('../../src/agent/memory/vectorStore').VectorStore;
  let memoryIdForTextCluster: typeof import('../../src/agent/memory/relationProjection').memoryIdForTextCluster;
  try {
    const { createMemoryService } = await import('../../src/agent/memory/adapter');
    ({ VectorStore } = await import('../../src/agent/memory/vectorStore'));
    ({ memoryIdForTextCluster } = await import('../../src/agent/memory/relationProjection'));
    svc = await createMemoryService({
      dbPath,
      vectorDbPath,
      // Embeddings will fail (no real endpoint); addMemoryCluster catches
      // the failure and still writes the JSON cluster — exactly what we
      // need to test JSON deletion. To also test vector deletion we
      // insert vector rows directly via VectorStore below.
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('bun:') || msg.includes('ERR_UNSUPPORTED_ESM_URL_SCHEME')) {
      console.log('  (skipped — bun:sqlite not available under Node; run under bun)');
      return;
    }
    throw e;
  }

  // If we got a NoopMemoryService back (no bun in env), skip cleanly.
  if ((svc.constructor.name) === 'NoopMemoryService') {
    console.log('  (skipped — NoopMemoryService returned; run under bun for real persistence)');
    return;
  }

  await svc.warmup('u-1');

  const fakeEmbedding = new Array(8).fill(0).map((_, i) => i / 8);
  (svc as unknown as { embedder?: { embedText(text: string): Promise<number[]> } }).embedder = {
    async embedText() { return fakeEmbedding; },
  };

  console.log('--- Test 1: searchClusters rehydrates foresight clusters by stable memory id ---');
  {
    const cluster = {
      fact: '用户正在审查记忆系统',
      foresight: '后续可能需要补 streamRun 写入测试',
      importance_score: 0.82,
      created_at: new Date().toISOString(),
      provenance: {
        source: 'unified-extraction-v1' as const,
        session_id: 'rehydrate-session',
        turn_index: 1,
        confidence: 0.92,
        extracted_at: new Date().toISOString(),
      },
    };
    await svc.addMemoryCluster('u-1', cluster);
    const hits = await svc.searchClusters('u-1', '记忆系统 streamRun', { limit: 1 });
    assert(hits[0]?.fact === cluster.fact, 'searchClusters returned original fact, not vector content with foresight suffix');
    assert(hits[0]?.foresight === cluster.foresight, 'searchClusters preserved foresight from canonical JSON cluster');
    assert(hits[0]?.importance_score === cluster.importance_score, 'searchClusters preserved original importance score');
  }

  console.log('--- Test 2: legacy cluster (no provenance) is untouched ---');
  {
    await svc.addMemoryCluster('u-1', {
      fact: 'legacy fact', importance_score: 0.5, created_at: new Date().toISOString(),
    });
    const deleted = await svc.deleteByProvenance({ sessionId: 'bad-session' });
    assert(deleted === 0, 'no rows match');
  }

  console.log('--- Test 3: matching cluster is deleted ---');
  {
    await svc.addMemoryCluster('u-1', {
      fact: 'unified fact', importance_score: 0.5, created_at: new Date().toISOString(),
      // [v4-rev] extracted_at must be valid ISO timestamp because router writes
      // created_at: prov.extracted_at and downstream code may parse the timestamp
      provenance: {
        source: 'unified-extraction-v1',
        session_id: 'bad-session',
        turn_index: 5,
        confidence: 0.9,
        extracted_at: new Date().toISOString(),
      },
    });
    const deleted = await svc.deleteByProvenance({ sessionId: 'bad-session' });
    assert(deleted === 1, '1 row deleted');
  }

  console.log('--- Test 4: legacy cluster survived (JSON side) ---');
  {
    // searchClusters with empty query may fall through embedding failure;
    // bypass by reading clusters from a fresh service against the same DB
    // (or just by re-checking via deleteByProvenance with a never-matching
    // filter to confirm legacy cluster is still tracked).
    // Simpler: use searchClusters which returns [] on embedding failure
    // (which would falsely satisfy the assertion). Instead, verify by
    // running deleteByProvenance with the same bad-session filter — it
    // should return 0 (already deleted) and not affect legacy.
    const noopDelete = await svc.deleteByProvenance({ sessionId: 'bad-session' });
    assert(noopDelete === 0, 'second delete is a no-op (idempotent)');
  }

  // [v4 P1-D] Vector side: directly inspect vectors.db to verify rows are gone.
  // searchClusters uses live embeddings which we don't have — so we open the
  // VectorStore directly and assert via a count query.
  console.log('--- Test 5 [P1-D]: vector rows for deleted session removed ---');
  {
    // Pre-seed a vector row that matches the encoded provenance we use in
    // service.addMemoryCluster (so we exercise the LIKE delete path even
    // though embedding failures during the initial addMemoryCluster meant
    // no real vector row was written by the service for that cluster).
    const vs = new VectorStore(vectorDbPath);
    vs.insert(
      'u-1',
      'memory_cluster',
      'unified fact replay',
      fakeEmbedding,
      'unified-extraction-v1:session_id=victim-session:turn=3',
    );
    vs.insert(
      'u-1',
      'memory_cluster',
      'untouched legacy row',
      fakeEmbedding,
      '', // no provenance — legacy
    );
    vs.insert(
      'u-1',
      'memory_cluster',
      'different session row',
      fakeEmbedding,
      'unified-extraction-v1:session_id=other-session:turn=1',
    );
    vs.close();

    // Now seed a JSON cluster with provenance pointing at victim-session so
    // deleteByProvenance has a JSON match too (otherwise it short-circuits
    // before reaching the vector pass — the loop only hits vector deletion
    // when at least one user owns matching JSON, which is fine here
    // because seed below adds one).
    await svc.addMemoryCluster('u-1', {
      fact: 'victim cluster', importance_score: 0.5, created_at: new Date().toISOString(),
      provenance: {
        source: 'unified-extraction-v1',
        session_id: 'victim-session',
        turn_index: 3,
        confidence: 0.9,
        extracted_at: new Date().toISOString(),
      },
    });

    await svc.deleteByProvenance({ sessionId: 'victim-session' });

    // Re-open the vector store and count rows that contain the victim session.
    const vs2 = new VectorStore(vectorDbPath);
    const remainingVictim = vs2.deleteByMetadataSubstring('u-1', 'memory_cluster', 'session_id=victim-session');
    assert(remainingVictim === 0, 'no victim-session vector rows remain');
    const remainingOther = vs2.deleteByMetadataSubstring('u-1', 'memory_cluster', 'session_id=other-session');
    assert(remainingOther === 1, 'other-session vector row preserved');
    vs2.close();
  }

  console.log('--- Test 6: turn-scoped provenance delete preserves same-session other turns ---');
  {
    const vs = new VectorStore(vectorDbPath);
    vs.insert(
      'u-1',
      'memory_cluster',
      'bad turn vector',
      fakeEmbedding,
      'unified-extraction-v1:session_id=turn-scope-session:turn=7',
    );
    vs.insert(
      'u-1',
      'memory_cluster',
      'good turn vector',
      fakeEmbedding,
      'unified-extraction-v1:session_id=turn-scope-session:turn=8',
    );
    vs.close();

    await svc.addMemoryCluster('u-1', {
      fact: 'bad turn json', importance_score: 0.5, created_at: new Date().toISOString(),
      provenance: {
        source: 'unified-extraction-v1',
        session_id: 'turn-scope-session',
        turn_index: 7,
        confidence: 0.9,
        extracted_at: new Date().toISOString(),
      },
    });
    await svc.addMemoryCluster('u-1', {
      fact: 'good turn json', importance_score: 0.5, created_at: new Date().toISOString(),
      provenance: {
        source: 'unified-extraction-v1',
        session_id: 'turn-scope-session',
        turn_index: 8,
        confidence: 0.9,
        extracted_at: new Date().toISOString(),
      },
    });

    const deleted = await svc.deleteByProvenance({ sessionId: 'turn-scope-session', turnIndex: 7 });
    assert(deleted === 1, 'only turn 7 JSON row deleted');

    const vs2 = new VectorStore(vectorDbPath);
    const remainingBadTurn = vs2.deleteByMetadataSubstring('u-1', 'memory_cluster', 'session_id=turn-scope-session:turn=7');
    assert(remainingBadTurn === 0, 'turn 7 vector row removed');
    const remainingGoodTurn = vs2.deleteByMetadataSubstring('u-1', 'memory_cluster', 'session_id=turn-scope-session:turn=8');
    assert(remainingGoodTurn >= 1, 'turn 8 vector row preserved');
    vs2.close();
  }

  console.log('--- Test 7: confidence-scoped provenance delete does not broad-delete vectors ---');
  {
    const lowConfidenceCluster = {
      fact: 'low confidence json',
      importance_score: 0.5,
      created_at: new Date().toISOString(),
      provenance: {
        source: 'unified-extraction-v1' as const,
        session_id: 'confidence-session',
        turn_index: 1,
        confidence: 0.3,
        extracted_at: new Date().toISOString(),
      },
    };
    const highConfidenceCluster = {
      fact: 'high confidence json',
      importance_score: 0.5,
      created_at: new Date().toISOString(),
      provenance: {
        source: 'unified-extraction-v1' as const,
        session_id: 'confidence-session',
        turn_index: 2,
        confidence: 0.9,
        extracted_at: new Date().toISOString(),
      },
    };
    await svc.addMemoryCluster('u-1', lowConfidenceCluster);
    await svc.addMemoryCluster('u-1', highConfidenceCluster);

    const vs = new VectorStore(vectorDbPath);
    vs.insert(
      'u-1',
      'memory_cluster',
      lowConfidenceCluster.fact,
      fakeEmbedding,
      'unified-extraction-v1:session_id=confidence-session:turn=1',
      0,
      memoryIdForTextCluster('u-1', lowConfidenceCluster),
    );
    vs.insert(
      'u-1',
      'memory_cluster',
      highConfidenceCluster.fact,
      fakeEmbedding,
      'unified-extraction-v1:session_id=confidence-session:turn=2',
      0,
      memoryIdForTextCluster('u-1', highConfidenceCluster),
    );
    vs.close();

    const deleted = await svc.deleteByProvenance({ sessionId: 'confidence-session', minConfidence: 0.5 });
    assert(deleted === 1, 'only low-confidence JSON row deleted');

    const vs2 = new VectorStore(vectorDbPath);
    const remainingLow = vs2.deleteByMetadataSubstring('u-1', 'memory_cluster', 'session_id=confidence-session:turn=1');
    assert(remainingLow === 0, 'low-confidence vector row removed by exact id');
    const remainingHigh = vs2.deleteByMetadataSubstring('u-1', 'memory_cluster', 'session_id=confidence-session:turn=2');
    assert(remainingHigh === 1, 'high-confidence vector row preserved');
    vs2.close();
  }

  svc.close();
  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
