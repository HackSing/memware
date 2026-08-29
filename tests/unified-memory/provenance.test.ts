// tests/unified-memory/provenance.test.ts
import { makeProvenance, type ProvenanceMeta } from '../../src/agent/memory/provenance';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

console.log('--- Test 1: provenance carries source/session/turn/confidence/ts ---');
{
  const p: ProvenanceMeta = makeProvenance({ sessionId: 's-42', turnIndex: 3, confidence: 0.85 });
  assert(p.source === 'unified-extraction-v1', 'source label fixed');
  assert(p.session_id === 's-42', 'session_id propagated');
  assert(p.turn_index === 3, 'turn_index propagated');
  assert(p.confidence === 0.85, 'confidence carried');
  assert(typeof p.extracted_at === 'string', 'extracted_at is string');
  assert(p.extracted_at.endsWith('Z'), 'extracted_at is UTC ISO');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
