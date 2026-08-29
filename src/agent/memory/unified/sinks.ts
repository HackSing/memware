/**
 * memware — narrow sink interfaces for the unified router's workspace fan-out.
 *
 * The kernel never constructs these sinks; the host runtime injects them
 * (avatanel's WorkspaceManager / PendingWriter satisfy them structurally —
 * method bivariance plus shared field shapes — so host call sites pass their
 * real objects unchanged). memware itself always passes null for both.
 *
 * Declared locally so the kernel has zero imports into host subsystems
 * (avatanel src/agent/evolution/*). Only the members the kernel actually
 * calls are listed; anything else on the host objects is invisible here.
 */

/** Fields the router writes when queueing a pending rule. */
export interface UnifiedPendingRuleInput {
  source: string;
  source_detail: string;
  content: string;
  reason: string;
  target_files: string[];
  id?: string;
}

/** Fields the router writes when queueing a pending expression/mission. */
export interface UnifiedPendingEventInput {
  signal: string;
  attribution: string;
  content: string;
  source: string;
}

/** Pending-write queue surface used by the unified router. */
export interface UnifiedPendingWriter {
  appendPendingRule(rule: UnifiedPendingRuleInput): string;
  appendPendingExpression(event: UnifiedPendingEventInput): void;
  appendPendingMission(event: UnifiedPendingEventInput): void;
}

/**
 * Workspace surface used by the unified pipeline: the runner reads
 * `layout.root` for the audit-log fallback dir; the router appends
 * errors/learnings and may double as the pending writer (hosts route the
 * appendPending* calls to the same object).
 */
export interface UnifiedWorkspaceSink extends UnifiedPendingWriter {
  readonly layout: { readonly root: string };
  appendError(entry: string): void;
  appendLearning(entry: string): void;
}
