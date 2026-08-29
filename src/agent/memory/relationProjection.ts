import type { MemoryCluster } from "./types";
import { stableId } from "./ids";

export const TEXT_MEMORY_RELATION_EXTRACTOR_VERSION = "text-memory-graph-v1";

export interface MemoryRelationEntityCandidate {
  name: string;
  type?: string;
  aliases?: string[];
  confidence?: number;
}

const STOPWORDS = new Set([
  "user",
  "assistant",
  "memory",
  "profile",
  "relationship",
  "session",
  "turn",
  "image",
  "screenshot",
  "fact",
  "none",
  "null",
  "true",
  "false",
  "http",
  "https",
  "api",
  "id",
  "v1",
  "v2",
]);

const KNOWN_TERMS: Array<{ name: string; type: string; confidence: number }> = [
  { name: "微信", type: "platform", confidence: 0.84 },
  { name: "企业微信", type: "platform", confidence: 0.84 },
  { name: "图数据库", type: "concept", confidence: 0.78 },
  { name: "多模态记忆", type: "feature", confidence: 0.78 },
  { name: "统一记忆", type: "feature", confidence: 0.78 },
  { name: "长期记忆", type: "feature", confidence: 0.74 },
];

export function memoryIdForTextCluster(userId: string, cluster: Pick<MemoryCluster, "fact" | "created_at" | "provenance">): string {
  const provenanceKey = cluster.provenance
    ? `${cluster.provenance.source}:session_id=${cluster.provenance.session_id}:turn=${cluster.provenance.turn_index}`
    : `legacy:${cluster.created_at ?? ""}`;
  return stableId("text_memory", userId, provenanceKey, cluster.fact);
}

export function metadataSourceForTextCluster(cluster: Pick<MemoryCluster, "provenance">): string {
  return cluster.provenance
    ? `${cluster.provenance.source}:session_id=${cluster.provenance.session_id}:turn=${cluster.provenance.turn_index}`
    : "";
}

export function extractTextMemoryEntityCandidates(text: string): MemoryRelationEntityCandidate[] {
  const source = text.slice(0, 2400);
  const byKey = new Map<string, MemoryRelationEntityCandidate>();

  const add = (name: string, type: string, confidence: number, aliases: string[] = []) => {
    const cleaned = cleanEntityName(name);
    if (!isValidEntityName(cleaned)) return;
    const key = `${type}:${cleaned.toLocaleLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing || (existing.confidence ?? 0) < confidence) {
      byKey.set(key, { name: cleaned, type, aliases, confidence });
    }
  };

  for (const term of KNOWN_TERMS) {
    if (source.includes(term.name)) add(term.name, term.type, term.confidence);
  }

  for (const match of source.matchAll(/`([^`]{2,80})`/g)) {
    add(match[1] ?? "", inferEntityType(match[1] ?? "", "quoted"), 0.86);
  }

  for (const match of source.matchAll(/[《「『“"]([^《》「」『』“”"]{2,80})[》」』”"]/g)) {
    add(match[1] ?? "", inferEntityType(match[1] ?? "", "quoted"), 0.8);
  }

  for (const match of source.matchAll(/\b[A-Za-z][A-Za-z0-9._/-]{1,79}\b/g)) {
    const token = match[0];
    if (!isLikelyAsciiEntity(token)) continue;
    add(token, inferEntityType(token, "token"), 0.72);
  }

  return [...byKey.values()]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 12);
}

function inferEntityType(value: string, source: "quoted" | "token"): string {
  if (/\.(md|ts|tsx|js|jsx|json|sqlite|db|png|jpg|jpeg|webp|gif)$/i.test(value) || value.includes("/")) return "file";
  if (/(qwen|glm|gpt|deepseek|claude|gemini|llama|mistral)/i.test(value)) return "model";
  if (/(neo4j|sqlite|kuzu|postgres|mysql|redis|fts5|json1)/i.test(value)) return "database";
  if (/(discord|weixin|wechat|微信|browser|chrome)/i.test(value)) return "platform";
  if (/(avatanel|openclaw|codex|smartclaw)/i.test(value)) return "project";
  if (source === "quoted") return "topic";
  return "entity";
}

function isLikelyAsciiEntity(value: string): boolean {
  const lower = value.toLowerCase();
  if (STOPWORDS.has(lower)) return false;
  if (/^\d+(\.\d+)*$/.test(value)) return false;
  if (value.length < 3) return false;
  return /[A-Z]/.test(value) || /\d/.test(value) || /[-_.\/]/.test(value);
}

function isValidEntityName(value: string): boolean {
  if (value.length < 2 || value.length > 80) return false;
  const lower = value.toLowerCase();
  if (STOPWORDS.has(lower)) return false;
  if (!/[\p{L}\p{N}]/u.test(value)) return false;
  return true;
}

function cleanEntityName(value: string): string {
  return value
    .trim()
    .replace(/^[:：,，.;；。!?！？\s]+|[:：,，.;；。!?！？\s]+$/g, "")
    .slice(0, 80);
}
