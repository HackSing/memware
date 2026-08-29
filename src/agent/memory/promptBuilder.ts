/**
 * avatanel Memory System — Prompt Builder
 *
 * Builds system_prompt (profile + domain) and context_prompt (threads + events + retrieved).
 *
 * Reading method:
 * - system_prompt: ALL from SQLite/Cache direct read (Path A)
 * - context_prompt: threads + recent clusters from SQLite (Path A)
 *                   + retrieved memories from vector search (Path B, optional)
 */

import type { SysCore, RankedResult, WeightedItem, FocusItem } from "./types";
import { memorySortTimeMs } from "./time";

export function buildSystemPrompt(
  sysCore: SysCore,
  domainData?: Record<string, unknown> | null,
  scene?: string | null,
  promptConfig?: Record<string, unknown> | null,
): string {
  const parts: string[] = ["User profile and state."];
  const profile = sysCore.profile;

  // Basic info
  const basic = profile.basic_info;
  for (const [key, val] of Object.entries(basic)) {
    if (val && key !== "created_at") {
      parts.push(`${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${val}`);
    }
  }

  // Relationship status
  const rel = sysCore.digest.relationship_status;
  if (rel.intimacy_level || rel.current_vibe) {
    parts.push(
      `Relationship: ${rel.intimacy_level} (Vibe: ${rel.current_vibe})`,
    );
  }

  // Psychographics
  const psycho = profile.psychographics;
  if (psycho.traits.length > 0) {
    const traitStrs = psycho.traits.map((t: WeightedItem) =>
      t.trait ? `${t.trait}(w:${t.weight ?? 1})` : String(t),
    );
    parts.push(`Personality Traits: ${traitStrs.join(", ")}`);
  }
  if (psycho.core_values.length > 0) {
    const valStrs = psycho.core_values.map((v: WeightedItem) =>
      v.value ? `${v.value}(w:${v.weight ?? 1})` : String(v),
    );
    parts.push(`Core Values: ${valStrs.join(", ")}`);
  }

  // Preferences
  for (const [key, val] of Object.entries(profile.preferences)) {
    if (val && Array.isArray(val) && val.length > 0) {
      parts.push(
        `${key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}: ${val.join(", ")}`,
      );
    }
  }

  // Current focus
  const focus = sysCore.digest.current_focus;
  if (Array.isArray(focus)) {
    for (const f of focus as FocusItem[]) {
      // [PR3a] Prefer display_topic (human-readable label) when available.
      const shown = f.display_topic ?? f.topic;
      parts.push(
        `Current Focus: ${shown} (priority: ${f.priority})`,
      );
    }
  }

  // Domain data (scene-filtered)
  if (domainData && Object.keys(domainData).length > 0) {
    const filtered = filterDomainData(domainData, scene, promptConfig);
    if (Object.keys(filtered).length > 0) {
      parts.push("", "Business data.");
      parts.push(...flattenDict(filtered));
    }
  }

  return parts.join("\n");
}

export function buildContextPrompt(
  sysCore: SysCore,
  retrievedMemories?: RankedResult[] | null,
  recentLimit = 10,
): string {
  const parts: string[] = [];
  const digest = sysCore.digest;

  // Active threads (Path A: direct read)
  if (digest.active_threads.length > 0) {
    parts.push("Active threads.");
    for (const t of digest.active_threads) {
      let line = `${t.status ?? "active"}: ${t.topic}`;
      if (t.next_step) line += ` → Next: ${t.next_step}`;
      parts.push(line);
    }
  }

  // Recent memory clusters (Path A: direct read, bounded top-N by created_at desc)
  if (digest.memory_clusters.length > 0) {
    const sorted = boundedRecentClusters(digest.memory_clusters, recentLimit);

    parts.push("", "Recent life events.");
    for (const c of sorted) {
      let line = `${c.date ?? ""}: ${c.fact}`;
      if (c.foresight) line += ` (Note: ${c.foresight})`;
      parts.push(line);
    }
  }

  // Retrieved long-term memories (Path B: vector search results, optional)
  if (retrievedMemories && retrievedMemories.length > 0) {
    parts.push("", "Relevant memories.");
    for (const m of retrievedMemories) {
      const docType = m.metadata.doc_type;
      const ts = m.metadata.timestamp;
      let dateStr = "";
      if (ts) {
        try {
          dateStr = new Date(ts * 1000).toISOString().split("T")[0];
        } catch {
          // ignore
        }
      }
      const prefix = dateStr ? `${dateStr} (${docType})` : `(${docType})`;
      parts.push(`${prefix} ${m.content}`);
    }
  }

  return parts.join("\n");
}

// ── Helpers ─────────────────────────────────────────────────

function boundedRecentClusters<T extends { created_at?: unknown; date?: unknown }>(clusters: T[], limit: number): T[] {
  if (limit <= 0) return [];
  const top: T[] = [];
  for (const cluster of clusters) {
    const key = memorySortTimeMs(cluster);
    let insertAt = top.length;
    while (insertAt > 0 && key > memorySortTimeMs(top[insertAt - 1]!)) {
      insertAt--;
    }
    if (insertAt < limit) {
      top.splice(insertAt, 0, cluster);
      if (top.length > limit) top.pop();
    }
  }
  return top;
}

function filterDomainData(
  domainData: Record<string, unknown>,
  scene?: string | null,
  promptConfig?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!promptConfig || !scene) {
    const rule = promptConfig?.default ?? "*";
    if (rule === "*") return domainData;
  }

  const rule =
    (promptConfig as Record<string, unknown>)?.[scene!] ??
    (promptConfig as Record<string, unknown>)?.default ??
    "*";

  if (rule === "*") return domainData;

  if (typeof rule === "object" && rule !== null) {
    const filtered: Record<string, unknown> = {};
    for (const [field, subRule] of Object.entries(
      rule as Record<string, unknown>,
    )) {
      if (!(field in domainData)) continue;
      if (subRule === "*") {
        filtered[field] = domainData[field];
      } else if (
        Array.isArray(subRule) &&
        typeof domainData[field] === "object" &&
        domainData[field] !== null
      ) {
        const sub = domainData[field] as Record<string, unknown>;
        filtered[field] = Object.fromEntries(
          Object.entries(sub).filter(([k]) => (subRule as string[]).includes(k)),
        );
      }
    }
    return filtered;
  }

  return domainData;
}

function flattenDict(
  d: Record<string, unknown>,
  prefix = "",
): string[] {
  const lines: string[] = [];
  for (const [key, val] of Object.entries(d)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      lines.push(...flattenDict(val as Record<string, unknown>, label));
    } else if (Array.isArray(val) && val.length > 0) {
      lines.push(`${label}: ${val.join(", ")}`);
    } else if (val !== null && val !== "" && val !== undefined) {
      lines.push(`${label}: ${val}`);
    }
  }
  return lines;
}
