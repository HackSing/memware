import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveUnifiedAuditDir } from '../../src/agent/memory/unified/runTurnExtraction';

describe('resolveUnifiedAuditDir', () => {
  test('trusted host audit directory takes precedence over workspace routing', () => {
    const tenantAuditDir = join(tmpdir(), 'tenant-root', 'audit');
    const workspaceRoot = join(tmpdir(), 'legacy-workspace');

    expect(resolveUnifiedAuditDir({
      auditDir: tenantAuditDir,
      workspace: { layout: { root: workspaceRoot } } as never,
      userId: 'opaque-tenant',
    })).toBe(tenantAuditDir);
  });

  test('workspace routing remains backward compatible when no override is supplied', () => {
    const workspaceRoot = join(tmpdir(), 'legacy-workspace');

    expect(resolveUnifiedAuditDir({
      workspace: { layout: { root: workspaceRoot } } as never,
      userId: 'legacy-user',
    })).toBe(join(workspaceRoot, '.unified-extraction-log'));
  });
});
