import { mkdtempSync, readFileSync, existsSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogWriter, type AuditLogEntry, auditLogDir } from '../../src/agent/memory/unified/auditLog';

let passed = 0, failed = 0;
function assert(c: boolean, l: string): void { if (c) { console.log(`  ✅ ${l}`); passed++; } else { console.log(`  ❌ ${l}`); failed++; } }

const fixture: AuditLogEntry = {
  ts: '2026-04-18T12:00:00.000Z',
  sessionId: 's-1',
  turnIndex: 7,
  userId: 'u-1',
  userMessageDigest: 'sha256:abc',
  payload: {
    version: 'v1',
    event: { ts: 't', summary: 's', confidence: 0.85, categories: ['memory'] },
    facts: {},
    routes: {},
  },
  actions: [
    { kind: 'memory_cluster', detail: 'wrote 1' },
    { kind: 'profile_suppressed', detail: 'gate failed' },
  ],
  errors: [{ stage: 'extract', path: 'facts.profile_update.basic_info.0.evidence', message: 'String must contain at least 4 character(s)' }],
  durationMs: 480,
  mode: 'live',
};

console.log('--- Test 1: append() writes one JSONL line per call ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));
  const w = new AuditLogWriter(dir, { privateMode: true });
  w.append(fixture);
  w.append({ ...fixture, turnIndex: 8 });
  w.flush();
  const today = new Date().toISOString().slice(0, 10);
  const path = join(dir, `${today}.jsonl`);
  assert(existsSync(path), 'file created');
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  assert(lines.length === 2, '2 lines');
  assert((JSON.parse(lines[0]) as AuditLogEntry).turnIndex === 7, 'first turn 7');
  assert((JSON.parse(lines[1]) as AuditLogEntry).turnIndex === 8, 'second turn 8');
  assert((statSync(dir).mode & 0o777) === 0o700, 'private audit directory is 0700');
  assert((statSync(path).mode & 0o777) === 0o600, 'private audit file is 0600');
}

console.log('--- Test 2: untrusted event timestamps cannot select an audit path ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'audit-rotate-'));
  const w = new AuditLogWriter(dir, { privateMode: true });
  w.append({ ...fixture, ts: '2026-04-18T23:59:59.000Z' });
  w.append({ ...fixture, ts: '../../outside' });
  w.flush();
  const today = new Date().toISOString().slice(0, 10);
  assert(existsSync(join(dir, `${today}.jsonl`)), 'trusted local-date file exists');
  assert(!existsSync(join(dir, '2026-04-18.jsonl')), 'event timestamp is not used as a filename');
  assert(!existsSync(join(dir, '..', 'outside.jsonl')), 'path traversal did not create an outside file');
}

console.log('--- Test 2b: private permissions are the default ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'audit-default-private-'));
  const w = new AuditLogWriter(dir);
  w.append(fixture);
  const path = join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  assert((statSync(dir).mode & 0o777) === 0o700, 'default audit directory is 0700');
  assert((statSync(path).mode & 0o777) === 0o600, 'default audit file is 0600');
}

console.log('--- Test 3: append() never throws on disk error ---');
{
  const w = new AuditLogWriter('/etc/avatanel-audit-test-cannot-write');
  let threw = false;
  try { w.append(fixture); w.flush(); } catch { threw = true; }
  assert(!threw, 'append swallows write errors');
}

console.log('--- Test 3b: private append refuses a symlinked date file ---');
{
  const dir = mkdtempSync(join(tmpdir(), 'audit-symlink-'));
  const outside = join(dir, '..', `audit-outside-${Date.now()}.txt`);
  writeFileSync(outside, 'untouched');
  const today = new Date().toISOString().slice(0, 10);
  symlinkSync(outside, join(dir, `${today}.jsonl`));
  const w = new AuditLogWriter(dir, { privateMode: true });
  let threw = false;
  try { w.append(fixture); } catch { threw = true; }
  assert(!threw, 'symlink refusal preserves best-effort API');
  assert(readFileSync(outside, 'utf8') === 'untouched', 'outside symlink target was not modified');
}

console.log('--- Test 4: auditLogDir helper ---');
{
  const d = auditLogDir('/some/workspace');
  assert(d === join('/some/workspace', '.unified-extraction-log'), 'audit dir under workspace');
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
