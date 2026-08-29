import type { IntimacyLevel, MemoryCluster, UserDocument } from "./types";

export interface ProfileUpdateSections {
  basic_info?: Array<{ field: string; value_quote: string; value_label?: unknown; evidence: string }>;
  preferences?: Array<{ field: string; value_quote: string; value_label?: unknown; evidence: string }>;
  significant_memories?: Array<{ event: string; importance: number; date: string; evidence: string }>;
  _provenance?: unknown;
}

export interface RelationshipUpdateInput {
  intimacy_delta?: number;
  current_vibe_quote?: string;
  current_vibe_label?: string;
  _provenance?: unknown;
}

export interface ActiveThreadUpdateInput {
  topic_quote: string;
  topic_label?: string;
  status: string;
  next_step?: string;
}

export interface FocusUpdateInput {
  topic_quote: string;
  topic_label?: string;
  priority: number;
}

export function appendMemoryClusterToDigest(
  doc: UserDocument,
  cluster: MemoryCluster,
  limit: number,
): MemoryCluster {
  const enriched: MemoryCluster = {
    fact: cluster.fact,
    foresight: cluster.foresight,
    date: cluster.date ?? new Date().toISOString().split("T")[0],
    importance_score: cluster.importance_score,
    created_at: cluster.created_at ?? new Date().toISOString(),
    ...(cluster.provenance ? { provenance: cluster.provenance } : {}),
  };

  doc.sys_core.digest.memory_clusters.push(enriched);
  if (doc.sys_core.digest.memory_clusters.length > limit) {
    doc.sys_core.digest.memory_clusters.sort(
      (a, b) => (b.importance_score ?? 0) - (a.importance_score ?? 0),
    );
    doc.sys_core.digest.memory_clusters = doc.sys_core.digest.memory_clusters.slice(0, limit);
  }
  return enriched;
}

export function mergeProfileSections(doc: UserDocument, sections: ProfileUpdateSections): void {
  const { _provenance: _ignored, ...sectionMap } = sections;
  void _ignored;

  const profile = doc.sys_core.profile;
  const displayValue = (item: { value_quote: string; value_label?: unknown }): unknown =>
    item.value_label !== undefined ? item.value_label : item.value_quote;

  if (sectionMap.basic_info && sectionMap.basic_info.length > 0) {
    const dest = profile.basic_info as Record<string, unknown>;
    for (const item of sectionMap.basic_info) {
      if (typeof item.field === "string" && item.field.length > 0) {
        dest[item.field] = displayValue(item);
      }
    }
  }

  if (sectionMap.preferences && sectionMap.preferences.length > 0) {
    for (const item of sectionMap.preferences) {
      if (typeof item.field !== "string" || item.field.length === 0) continue;
      const raw = displayValue(item);
      const stringVal = raw === null || raw === undefined ? "" : String(raw);
      const existing = profile.preferences[item.field];
      if (Array.isArray(existing)) {
        if (!existing.includes(stringVal)) existing.push(stringVal);
      } else {
        profile.preferences[item.field] = [stringVal];
      }
    }
  }

  if (sectionMap.significant_memories && sectionMap.significant_memories.length > 0) {
    const existingEvents = new Set(profile.significant_memories.map((m) => m.event));
    for (const item of sectionMap.significant_memories) {
      if (typeof item.event !== "string" || item.event.length === 0) continue;
      if (existingEvents.has(item.event)) continue;
      profile.significant_memories.push({
        event: item.event,
        importance: item.importance,
        date: item.date,
      });
      existingEvents.add(item.event);
    }
  }
}

export function applyRelationshipUpdate(doc: UserDocument, partial: RelationshipUpdateInput): void {
  const { _provenance: _ignored, intimacy_delta, current_vibe_quote, current_vibe_label } = partial;
  void _ignored;
  const currentVibe = current_vibe_label ?? current_vibe_quote;
  const rel = doc.sys_core.digest.relationship_status;

  let score = typeof rel.intimacy_score === "number"
    ? rel.intimacy_score
    : LEVEL_TO_SCORE[rel.intimacy_level] ?? 0.5;

  if (typeof intimacy_delta === "number" && Number.isFinite(intimacy_delta)) {
    const clampedDelta = Math.max(-0.05, Math.min(0.05, intimacy_delta));
    score = Math.max(0, Math.min(1, score + clampedDelta));
  }

  rel.intimacy_score = score;
  rel.intimacy_level = scoreToLevel(score);

  if (typeof currentVibe === "string" && currentVibe.length > 0) {
    rel.current_vibe = currentVibe;
  }
}

export function upsertActiveThreadInDigest(
  doc: UserDocument,
  thread: ActiveThreadUpdateInput,
  limit: number,
): void {
  const topic = thread.topic_label ?? thread.topic_quote;
  const threads = doc.sys_core.digest.active_threads;
  const identity = topicIdentityKey(topic);
  const idx = threads.findIndex((t) => topicIdentityKey(t.topic) === identity);
  const status = thread.status.toLowerCase();
  if (idx >= 0) threads.splice(idx, 1);

  if (status !== "resolved" && status !== "completed") {
    threads.unshift({ topic, status: thread.status, next_step: thread.next_step });
  }
  if (threads.length > limit) {
    doc.sys_core.digest.active_threads = threads.slice(0, limit);
  }
}

export function upsertFocusInDigest(
  doc: UserDocument,
  focus: FocusUpdateInput,
  limit: number,
): void {
  const canonical = focus.topic_quote;
  const display = focus.topic_label;
  const focusList = doc.sys_core.digest.current_focus;
  const identity = topicIdentityKey(canonical);
  const idx = focusList.findIndex((f) => topicIdentityKey(f.topic) === identity);
  const nextFocus = {
    topic: canonical,
    priority: focus.priority,
    ...(display ? { display_topic: display } : {}),
  };
  if (idx >= 0) {
    const prevDisplay = focusList[idx].display_topic;
    const nextDisplay = display ?? prevDisplay;
    focusList.splice(idx, 1);
    focusList.unshift({
      topic: canonical,
      priority: focus.priority,
      ...(nextDisplay ? { display_topic: nextDisplay } : {}),
    });
  } else {
    focusList.unshift(nextFocus);
  }
  focusList.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  if (focusList.length > limit) {
    doc.sys_core.digest.current_focus = focusList.slice(0, limit);
  }
}

const LEVEL_TO_SCORE: Record<IntimacyLevel, number> = {
  Stranger:        0.10,
  Acquaintance:    0.25,
  Friend:          0.50,
  "Close Friend":  0.70,
  Confidant:       0.90,
};

function scoreToLevel(score: number): IntimacyLevel {
  if (score < 0.15) return "Stranger";
  if (score < 0.35) return "Acquaintance";
  if (score < 0.60) return "Friend";
  if (score < 0.80) return "Close Friend";
  return "Confidant";
}

function topicIdentityKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s，。！？、,.!?:：;；"'`《》「」『』（）()【】\[\]-]+/g, "");
}
