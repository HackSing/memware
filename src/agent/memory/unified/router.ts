/**
 * Fan a parsed UnifiedMemoryExtraction out to LTM + workspace + audit log.
 *
 * Design properties:
 * - Live fan-out only after unifiedExtraction cutover.
 * - Per-sink try/catch isolation (Codex mitigation #3).
 * - Confidence gate per category (Codex calibration).
 * - Hard gate per category (Codex structural safety; P1.1 algorithm).
 * - P2.2 intimacy_delta re-clamped at router boundary (defense-in-depth
 *   against direct router callers bypassing schema).
 * - Audit log entry written exactly once per call.
 * - Provenance attached to every LTM write.
 */

import type { UnifiedMemoryExtraction } from './schema';
import type { IMemoryService, MemoryCluster } from '../types';
import type { WorkspaceManager } from '../../evolution/workspaceManager';
import type { PendingWriter } from '../../evolution/types';
import { shaHex } from '../ids';
import { AuditLogWriter, type RouteAction, type StructuredError } from './auditLog';
import { makeProvenance } from '../provenance';
import { passesConfidenceGate, evaluateHardGate, type Thresholds, type FactCategory, type HardGateResult } from './thresholds';
import { detectUserLanguage, languageProfileEvidence, normalizeUserLanguage } from '../language';

export interface RouteContext {
  memory: IMemoryService;
  workspace: WorkspaceManager | null;
  pendingWriter?: PendingWriter | null;
  userId: string;
  sessionId: string;
  turnIndex: number;
  userMessage: string;
  assistantMessage: string;
  auditLog: AuditLogWriter;
  thresholds: Thresholds;
  extractErrors?: StructuredError[];
}

export async function routeUnifiedExtraction(
  ext: UnifiedMemoryExtraction,
  ctx: RouteContext,
): Promise<RouteAction[]> {
  const startMs = Date.now();
  const actions: RouteAction[] = [];
  const errors: StructuredError[] = [...(ctx.extractErrors ?? [])];
  const prov = makeProvenance({
    sessionId: ctx.sessionId,
    turnIndex: ctx.turnIndex,
    confidence: ext.event.confidence,
  });

  // ── per-sink dispatcher ──
  const sinkLTM = async (
    label: string,
    action: RouteAction,
    failedKind: RouteAction['kind'],
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
      actions.push(action);
    } catch (err) {
      errors.push({ stage: 'route', message: `${label}: ${msg(err)}` });
      actions.push({ kind: failedKind, detail: `${label}: ${msg(err)}` });
    }
  };
  const sinkWS = (
    label: string,
    action: RouteAction,
    failedKind: RouteAction['kind'],
    run: () => void,
  ): void => {
    try {
      run();
      actions.push(action);
    } catch (err) {
      errors.push({ stage: 'route', message: `${label}: ${msg(err)}` });
      actions.push({ kind: failedKind, detail: `${label}: ${msg(err)}` });
    }
  };

  // ── memory_clusters ──
  if (ext.facts.memory_clusters) {
    for (const c of ext.facts.memory_clusters) {
      if (!gate('memory_clusters', ext, c as unknown as Record<string, unknown>, ctx, actions)) continue;
      const cluster: MemoryCluster = {
        fact: c.fact,
        foresight: c.foresight,
        date: c.date,
        importance_score: c.importance_score,
        // [v4-rev] prov.extracted_at IS a `new Date().toISOString()` string
        // (set by makeProvenance — see Task 3). Safe to use as MemoryCluster.created_at.
        created_at: prov.extracted_at,
        provenance: prov,
      };
      await sinkLTM(
        'cluster',
        { kind: 'memory_cluster', detail: c.fact.slice(0, 40) },
        'cluster_failed',
        () => ctx.memory.addMemoryCluster(ctx.userId, cluster),
      );
    }
  }

  // ── profile_update ──
  //
  // [PR3b] Two orthogonal policy changes vs PR2:
  //   1. significant_memories uses an evidence-only hard gate (no value_quote
  //      required) — the old path routed through checkEvidence with empty
  //      value_quote and silently blocked every sig_memory. thresholds.ts
  //      detects the shape by `item.event` presence.
  //   2. basic_info / preferences use a three-bucket confidence policy:
  //      - Verbatim bucket: value_label absent OR label === value_quote
  //        → bypass confidence gate (hard gate still required).
  //        Rationale: model self-confidence ceiling (DS-V3.2 stuck at 0.85)
  //        blocked 80% of otherwise-valid profile writes; verbatim items
  //        don't need confidence theater because they're substring-verified.
  //      - Normalized bucket: label differs from quote → keep confidence gate.
  //        Paraphrase is where model uncertainty actually matters.
  //      - (Future: inferred bucket → verifier pass.)
  if (ext.facts.profile_update) {
    const sections: Array<['basic_info' | 'preferences' | 'significant_memories', unknown[] | undefined]> = [
      ['basic_info', ext.facts.profile_update.basic_info],
      ['preferences', ext.facts.profile_update.preferences],
      ['significant_memories', ext.facts.profile_update.significant_memories],
    ];
    for (const [sec, items] of sections) {
      if (!items) continue;
      const accepted: unknown[] = [];
      const bucketCounts: Record<string, number> = {};
      for (const item of items) {
        const record = item as Record<string, unknown>;
        const bucket = classifyProfileBucket(sec, record);
        const gateRes = gateProfileItem(sec, bucket, ext, record, ctx, actions);
        if (!gateRes) continue;
        bucketCounts[bucket] = (bucketCounts[bucket] ?? 0) + 1;
        accepted.push(item);
      }
      if (accepted.length > 0) {
        const bucketSummary = Object.entries(bucketCounts)
          .map(([b, n]) => `${b}:${n}`)
          .join(',');
        await sinkLTM(
          `profile.${sec}`,
          { kind: 'profile_update', detail: `${sec}:${accepted.length}[${bucketSummary}]` },
          'profile_failed',
          async () => {
            await ctx.memory.updateProfile(
              ctx.userId,
              { [sec]: accepted, _provenance: prov } as never,
            );
            // High-visibility stdout warning — profile writes are highest blast radius
            console.warn(
              `[unified-extract] ⚠ PROFILE WRITE userId=${ctx.userId} section=${sec} ` +
              `count=${accepted.length} buckets=[${bucketSummary}] ` +
              `confidence=${ext.event.confidence.toFixed(2)} mode=live`,
            );
          },
        );
      }
    }
  }

  const detectedLanguage = detectUserLanguage(ctx.userMessage);
  const storedLanguage = normalizeUserLanguage(ctx.memory.getUserProfileLanguage?.(ctx.userId));
  const languageEvidence = languageProfileEvidence(ctx.userMessage);
  if (detectedLanguage && !storedLanguage && languageEvidence) {
    await sinkLTM(
      'profile.language',
      { kind: 'language_update', detail: detectedLanguage },
      'profile_failed',
      () => ctx.memory.updateProfile(ctx.userId, {
        basic_info: [{
          field: 'language',
          value_quote: languageEvidence,
          value_label: detectedLanguage,
          evidence: languageEvidence,
        }],
        _provenance: prov,
      }),
    );
  }

  // ── active_threads ──
  if (ext.facts.active_threads) {
    for (const t of ext.facts.active_threads) {
      if (!gate('active_threads', ext, t as unknown as Record<string, unknown>, ctx, actions)) continue;
      // [PR2] detail: prefer label for display; fall back to quote
      const detail = (t.topic_label ?? t.topic_quote) as string;
      await sinkLTM(
        'active_thread',
        { kind: 'active_thread', detail },
        'active_thread_failed',
        () => ctx.memory.upsertActiveThread(ctx.userId, t),
      );
    }
  }

  // ── focus ──
  if (ext.facts.focus) {
    for (const f of ext.facts.focus) {
      if (!gate('focus', ext, f as unknown as Record<string, unknown>, ctx, actions)) continue;
      // [PR3a] detail: prefer label for display; fall back to quote (mirrors active_thread)
      const detail = f.topic_label ?? f.topic_quote;
      await sinkLTM(
        'focus',
        { kind: 'focus_update', detail },
        'focus_failed',
        () => ctx.memory.upsertFocus(ctx.userId, f),
      );
    }
  }

  // ── relationship (P2.2 — re-clamp intimacy_delta at router boundary) ──
  if (ext.facts.relationship) {
    const rel = ext.facts.relationship as Record<string, unknown>;
    if (gate('relationship', ext, rel, ctx, actions)) {
      // Defense-in-depth: re-clamp even though schema also clamps
      const rawDelta = typeof rel.intimacy_delta === 'number' ? rel.intimacy_delta : 0;
      const safeDelta = Math.max(-0.05, Math.min(0.05, rawDelta));
      const safeRel = { ...rel, intimacy_delta: safeDelta, _provenance: prov };
      // [PR2] detail: prefer label for display; fall back to quote; else 'delta-only'
      const label = rel.current_vibe_label as string | undefined;
      const quote = rel.current_vibe_quote as string | undefined;
      const detail = label ?? quote ?? 'delta-only';
      await sinkLTM(
        'relationship',
        { kind: 'relationship_update', detail },
        'relationship_failed',
        () => ctx.memory.updateRelationship(ctx.userId, safeRel),
      );
    }
  }

  // ── routes.* (workspace) ──
  const pendingWriter = ctx.pendingWriter ?? (ctx.workspace as PendingWriter | null);
  if (pendingWriter) {
    if (ext.routes.pending_rules) {
      for (const r of ext.routes.pending_rules) {
        sinkWS(
          'pending_rule',
          { kind: 'pending_rule', detail: 'queued' },
          'workspace_failed',
          () => {
            pendingWriter.appendPendingRule({
              // [P3] RuleSource now includes 'unified-extraction'. No more
              // reflection-source mislabeling.
              source: 'unified-extraction',
              source_detail: `session=${ctx.sessionId} turn=${ctx.turnIndex} confidence=${ext.event.confidence}`,
              content: r.content,
              reason: r.reason,
              target_files: r.target_files ?? [],
            });
          },
        );
      }
    }
    if (ext.routes.expression_pending) {
      for (const e of ext.routes.expression_pending) {
        sinkWS(
          'expression',
          { kind: 'expression_pending', detail: 'appended' },
          'workspace_failed',
          () => {
            pendingWriter.appendPendingExpression({
              signal: e.signal,
              attribution: e.attribution ?? '',
              content: e.content,
              source: `session=${ctx.sessionId} turn=${ctx.turnIndex}`,
            } as never);
          },
        );
      }
    }
    if (ext.routes.mission_pending) {
      for (const m of ext.routes.mission_pending) {
        sinkWS(
          'mission',
          { kind: 'mission_pending', detail: 'appended' },
          'workspace_failed',
          () => {
            pendingWriter.appendPendingMission({
              signal: m.signal,
              attribution: m.attribution ?? '',
              content: m.content,
              source: `session=${ctx.sessionId} turn=${ctx.turnIndex}`,
            } as never);
          },
        );
      }
    }
  }
  if (ctx.workspace) {
    const ws = ctx.workspace;
    if (ext.routes.errors) {
      for (const e of ext.routes.errors) {
        sinkWS(
          'error',
          { kind: 'error_logged', detail: e.slice(0, 60) },
          'workspace_failed',
          () => {
            ws.appendError(`${e}\n_session=${ctx.sessionId} turn=${ctx.turnIndex}_`);
          },
        );
      }
    }
    if (ext.routes.learnings) {
      for (const l of ext.routes.learnings) {
        sinkWS(
          'learning',
          { kind: 'learning_logged', detail: l.slice(0, 60) },
          'workspace_failed',
          () => {
            ws.appendLearning(`${l}\n_session=${ctx.sessionId} turn=${ctx.turnIndex}_`);
          },
        );
      }
    }
  }

  // ── stdout summary ──
  console.log(
    `[unified-extract] mode=live turn=${ctx.turnIndex} session=${ctx.sessionId} ` +
    `categories=[${ext.event.categories.join(',')}] confidence=${ext.event.confidence.toFixed(2)} ` +
    `actions=${actions.map(a => a.kind).join(',')}` +
    (errors.length ? ` errors=${errors.length}` : ''),
  );

  // ── audit log ──
  ctx.auditLog.append({
    ts: ext.event.ts,
    sessionId: ctx.sessionId,
    turnIndex: ctx.turnIndex,
    userId: ctx.userId,
    userMessageDigest: 'sha256:' + shaHex(ctx.userMessage).slice(0, 16),
    payload: ext,
    actions,
    errors,
    durationMs: Date.now() - startMs,
    mode: 'live',
  });

  return actions;
}

function gate(
  category: FactCategory,
  ext: UnifiedMemoryExtraction,
  item: Record<string, unknown>,
  ctx: RouteContext,
  actions: RouteAction[],
): boolean {
  if (!passesConfidenceGate(ext.event.confidence, category, ctx.thresholds)) {
    actions.push({
      kind: blockedKind(category),
      detail: `confidence ${ext.event.confidence} below ${ctx.thresholds[category]}`,
    });
    return false;
  }
  const hardGate = evaluateHardGate(category, item, {
    userMessage: ctx.userMessage,
    assistantMessage: ctx.assistantMessage,
  });
  if (!hardGate.ok) {
    actions.push({
      kind: blockedKind(category),
      detail: `hard gate failed: ${hardGate.reason ?? 'other'}`,
    });
    return false;
  }
  return true;
}

/**
 * [PR3b] Profile sub-bucket classifier. Shapes the conditional confidence bypass.
 *
 *   'sig-memory' — significant_memories (shape-detected via `event` field).
 *                  Always bypasses confidence; evidence-only hard gate is authoritative.
 *   'verbatim'   — basic_info/preferences where value_label is absent OR
 *                  normalize(value_label) === normalize(value_quote). The LLM is just
 *                  echoing the user's own string; confidence self-report adds no signal.
 *   'normalized' — basic_info/preferences where label differs from quote (paraphrase,
 *                  translation, canonicalization). Confidence gate still applies — paraphrase
 *                  is exactly where model uncertainty matters.
 *   'malformed'  — everything else (missing value_quote etc). Hard gate will reject;
 *                  bucket is just for audit telemetry.
 */
type ProfileBucket = 'sig-memory' | 'verbatim' | 'normalized' | 'malformed';

function classifyProfileBucket(
  sec: 'basic_info' | 'preferences' | 'significant_memories',
  item: Record<string, unknown>,
): ProfileBucket {
  if (sec === 'significant_memories') return 'sig-memory';
  const q = typeof item.value_quote === 'string' ? item.value_quote.replace(/\s+/g, '').trim() : '';
  const l = typeof item.value_label === 'string' ? item.value_label.replace(/\s+/g, '').trim() : '';
  if (!q) return 'malformed';
  if (!l) return 'verbatim';
  return q === l ? 'verbatim' : 'normalized';
}

/**
 * [PR3b] Conditional confidence + hard gate for profile_update sections.
 * Verbatim / sig-memory buckets bypass the confidence gate (model self-report
 * ceiling is not a real safety signal when the string is substring-verified).
 * Normalized bucket keeps the confidence gate.
 */
function gateProfileItem(
  sec: 'basic_info' | 'preferences' | 'significant_memories',
  bucket: ProfileBucket,
  ext: UnifiedMemoryExtraction,
  item: Record<string, unknown>,
  ctx: RouteContext,
  actions: RouteAction[],
): boolean {
  const bypassConfidence = bucket === 'verbatim' || bucket === 'sig-memory';
  if (!bypassConfidence) {
    if (!passesConfidenceGate(ext.event.confidence, 'profile_update', ctx.thresholds)) {
      actions.push({
        kind: 'profile_suppressed',
        detail: `${sec} bucket=${bucket} confidence ${ext.event.confidence} below ${ctx.thresholds.profile_update}`,
      });
      return false;
    }
  }
  let hardGate: HardGateResult;
  try {
    hardGate = evaluateHardGate('profile_update', item, {
      userMessage: ctx.userMessage,
      assistantMessage: ctx.assistantMessage,
    });
  } catch (err) {
    actions.push({
      kind: 'profile_suppressed',
      detail: `${sec} bucket=${bucket} gate-exception: ${err instanceof Error ? err.message : String(err)}`,
    });
    return false;
  }
  if (!hardGate.ok) {
    actions.push({
      kind: 'profile_suppressed',
      detail: `${sec} bucket=${bucket} hard gate failed: ${hardGate.reason ?? 'other'}`,
    });
    return false;
  }
  return true;
}

/**
 * Map a FactCategory to its dedicated "blocked" RouteAction kind.
 *
 * [P3] auditLog.ts now exposes dedicated `cluster_blocked` and `focus_blocked`
 * variants — distinct from `*_failed` kinds (those signal real sink exceptions).
 */
function blockedKind(c: FactCategory): RouteAction['kind'] {
  switch (c) {
    case 'profile_update':  return 'profile_suppressed';
    case 'relationship':    return 'relationship_blocked';
    case 'active_threads':  return 'active_thread_blocked';
    case 'memory_clusters': return 'cluster_blocked';
    case 'focus':           return 'focus_blocked';
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
