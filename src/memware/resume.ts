/**
 * memware — cross-agent resume briefing.
 *
 * Pure assembly logic for the memory_resume tool: given a tenant's active
 * threads (newest-first) and per-thread related memory clusters, produce a
 * structured payload plus a plain-text briefing an agent can hand to the user.
 *
 * Kept side-effect-free and storage-agnostic so it is unit-testable without a
 * memory service, mirroring transcript.ts.
 */

import type { ActiveThread, MemoryCluster } from "../agent/memory/types";

export interface ResumeThreadEntry {
  topic: string;
  status: string;
  next_step?: string;
  last_agent_id?: string;
  updated_at?: string;
  /** Related memory cluster facts pulled by vector search at read time. */
  related: string[];
}

export interface ResumeResult {
  threads: ResumeThreadEntry[];
  brief: string;
}

/** Threads considered for the briefing when no explicit limit is given. */
export const DEFAULT_RESUME_THREAD_LIMIT = 5;
/** Related cluster facts fetched per thread. */
export const RELATED_PER_THREAD = 3;

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return "unknown time";
  // Briefing is human/LLM-facing; the date part is enough to anchor recency.
  return iso.slice(0, 10);
}

export function buildResumeBrief(
  threads: ActiveThread[],
  relatedByThread: MemoryCluster[][],
  opts: { asOf?: Date } = {},
): ResumeResult {
  const entries: ResumeThreadEntry[] = threads.map((t, i) => ({
    topic: t.topic,
    status: t.status,
    ...(t.next_step !== undefined ? { next_step: t.next_step } : {}),
    ...(t.last_agent_id !== undefined ? { last_agent_id: t.last_agent_id } : {}),
    ...(t.updated_at !== undefined ? { updated_at: t.updated_at } : {}),
    related: (relatedByThread[i] ?? [])
      .map((c) => c.fact)
      .slice(0, RELATED_PER_THREAD),
  }));

  if (entries.length === 0) {
    return {
      threads: [],
      brief:
        "No active task threads found. This user has no unfinished work to resume; " +
        "start fresh and memory_process will record the new thread.",
    };
  }

  const asOf = (opts.asOf ?? new Date()).toISOString().slice(0, 10);
  const lines: string[] = [`Cross-agent handoff briefing (as of ${asOf}):`];
  entries.forEach((t, i) => {
    const meta: string[] = [t.status];
    if (t.last_agent_id) meta.push(`last agent: ${t.last_agent_id}`);
    if (t.updated_at) meta.push(`updated: ${formatTimestamp(t.updated_at)}`);
    lines.push(`${i + 1}. [${t.topic}] (${meta.join(", ")})`);
    if (t.next_step) lines.push(`   Next step: ${t.next_step}`);
    if (t.related.length > 0) {
      lines.push("   Related memory:");
      for (const fact of t.related) lines.push(`   - ${fact}`);
    }
  });

  return { threads: entries, brief: lines.join("\n") };
}
