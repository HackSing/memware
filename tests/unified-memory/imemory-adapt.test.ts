/**
 * Verify IMemoryService exposes the methods the unified router will call.
 * These are interface-level contract tests; integration with real LTM is
 * tested in Phase 3.
 */
import type { IMemoryService } from '../../src/agent/memory/types';
import type { MemoryLLMClient } from '../../src/agent/memory/llmClient';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

// Type-level smoke test: build a MINIMAL IMemoryService and verify the new
// methods exist. This will fail to compile if the interface is missing them.
console.log('--- Test 1: IMemoryService surface includes new methods ---');
{
  const stub: Pick<IMemoryService, 'getLLMClient' | 'addMemoryCluster' | 'updateProfile' | 'updateRelationship' | 'upsertActiveThread' | 'upsertFocus' | 'searchClusters' | 'deleteByProvenance'> = {
    getLLMClient: () => ({} as MemoryLLMClient),
    addMemoryCluster: async () => {},
    updateProfile: async () => {},
    updateRelationship: async () => {},
    upsertActiveThread: async () => {},
    upsertFocus: async () => {},
    searchClusters: async () => [],
    deleteByProvenance: async () => 0,
  };
  assert(typeof stub.getLLMClient === 'function', 'getLLMClient on interface');
  assert(typeof stub.addMemoryCluster === 'function', 'addMemoryCluster on interface');
  assert(typeof stub.updateProfile === 'function', 'updateProfile on interface');
  assert(typeof stub.updateRelationship === 'function', 'updateRelationship on interface');
  assert(typeof stub.upsertActiveThread === 'function', 'upsertActiveThread on interface');
  assert(typeof stub.upsertFocus === 'function', 'upsertFocus on interface');
  assert(typeof stub.searchClusters === 'function', 'searchClusters on interface');
  assert(typeof stub.deleteByProvenance === 'function', 'deleteByProvenance on interface');
}

// Smoke test the real MemoryService class supports the methods at runtime.
// MemoryService transitively imports `bun:sqlite`, so under Node this import
// raises ERR_UNSUPPORTED_ESM_URL_SCHEME — we skip Test 2 in that case and rely
// on the type-level Test 1 + the NoopMemoryService runtime check (Test 3).
console.log('--- Test 2: MemoryService class instance has new methods ---');
try {
  const { MemoryService } = await import('../../src/agent/memory/service');
  const proto = MemoryService.prototype as Record<string, unknown>;
  for (const name of ['getLLMClient', 'addMemoryCluster', 'updateProfile', 'updateRelationship',
                       'upsertActiveThread', 'upsertFocus', 'searchClusters', 'deleteByProvenance']) {
    assert(typeof proto[name] === 'function', `MemoryService.${name} exists`);
  }
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('bun:') || msg.includes('ERR_UNSUPPORTED_ESM_URL_SCHEME')) {
    console.log('  (skipped — bun:sqlite not available under Node; covered by Test 1 type-check)');
  } else {
    console.log(`  ❌ unexpected error: ${msg}`);
    failed++;
  }
}

// Same for NoopMemoryService
console.log('--- Test 3: NoopMemoryService implements the new methods ---');
{
  const { NoopMemoryService } = await import('../../src/agent/memory/adapter');
  const inst = new NoopMemoryService();
  for (const name of ['getLLMClient', 'addMemoryCluster', 'updateProfile', 'updateRelationship',
                       'upsertActiveThread', 'upsertFocus', 'searchClusters', 'deleteByProvenance']) {
    assert(typeof (inst as unknown as Record<string, unknown>)[name] === 'function', `NoopMemoryService.${name} exists`);
  }
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
