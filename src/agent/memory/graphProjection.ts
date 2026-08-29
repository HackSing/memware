import type { Database } from "bun:sqlite";
import { stableId } from "./ids";

export interface MemoryEntity {
  entity_id: string;
  user_id: string;
  entity_type: string;
  canonical_name: string;
  aliases: string[];
  confidence: number;
  source: string;
  extractor_version: string;
  metadata: Record<string, unknown>;
  first_seen_at: string;
  last_seen_at: string;
}

export type MemoryEdgeType =
  | "asset_mentions_entity"
  | "memory_mentions_entity"
  | "memory_derived_from_asset"
  | "asset_seen_in_session";

export interface MemoryRelationEntityInput {
  name: string;
  type?: string;
  aliases?: string[];
  confidence?: number;
}

interface EntityRow {
  entity_id: string;
  user_id: string;
  entity_type: string;
  canonical_name: string;
  aliases: string;
  confidence: number;
  source: string;
  extractor_version: string;
  metadata: string;
  first_seen_at: string;
  last_seen_at: string;
}

export class MemoryGraphProjectionStore {
  constructor(private readonly db: Database) {}

  listAssetEntities(userId: string, assetId: string): MemoryEntity[] {
    return this.db
      .query<EntityRow, [string, string]>(
        `SELECT e.* FROM memory_edges edge
         JOIN memory_entities e ON e.entity_id = edge.to_id
         WHERE edge.user_id = ? AND edge.asset_id = ? AND edge.edge_type = 'asset_mentions_entity' AND edge.deleted_at IS NULL
         ORDER BY e.last_seen_at DESC`,
      )
      .all(userId, assetId)
      .map(entityFromRow);
  }

  listAssetDerivedMemories(
    userId: string,
    assetId: string,
  ): Array<{ memory_id: string; edge_type: string; created_at: string }> {
    return this.db
      .query<{ memory_id: string; edge_type: string; created_at: string }, [string, string]>(
        `SELECT memory_id, edge_type, created_at FROM memory_edges
         WHERE user_id = ? AND asset_id = ? AND edge_type = 'memory_derived_from_asset' AND deleted_at IS NULL
         ORDER BY created_at DESC`,
      )
      .all(userId, assetId);
  }

  tombstoneAssetRelations(userId: string, assetId: string, deletedAt: string): void {
    this.db
      .query("UPDATE memory_edges SET deleted_at = ?1, updated_at = ?1 WHERE user_id = ?2 AND asset_id = ?3")
      .run(deletedAt, userId, assetId);
    this.db
      .query("UPDATE memory_record_entities SET deleted_at = ?1 WHERE user_id = ?2 AND asset_id = ?3")
      .run(deletedAt, userId, assetId);
  }

  tombstoneTextMemoryRelations(input: {
    userId: string;
    sessionId?: string;
    turnIndex?: number;
    source: string;
  }): void {
    if (input.sessionId === undefined && input.turnIndex === undefined) return;
    const now = new Date().toISOString();

    const edgeWhere = [
      "user_id = ?",
      "edge_type = 'memory_mentions_entity'",
      "asset_id IS NULL",
      "source = ?",
    ];
    const edgeParams: Array<string | number | null> = [input.userId, input.source];
    const recordWhere = [
      "user_id = ?",
      "record_type = 'text_memory_cluster'",
      "asset_id IS NULL",
      "source = ?",
    ];
    const recordParams: Array<string | number | null> = [input.userId, input.source];

    if (input.sessionId !== undefined) {
      edgeWhere.push("session_id = ?");
      edgeParams.push(input.sessionId);
      recordWhere.push("session_id = ?");
      recordParams.push(input.sessionId);
    }
    if (input.turnIndex !== undefined) {
      edgeWhere.push("turn_index = ?");
      edgeParams.push(input.turnIndex);
      recordWhere.push("turn_index = ?");
      recordParams.push(input.turnIndex);
    }

    this.db
      .query(`UPDATE memory_edges SET deleted_at = ?, updated_at = ? WHERE ${edgeWhere.join(" AND ")}`)
      .run(now, now, ...edgeParams);
    this.db
      .query(`UPDATE memory_record_entities SET deleted_at = ? WHERE ${recordWhere.join(" AND ")}`)
      .run(now, ...recordParams);
  }

  projectAssetEntities(input: {
    userId: string;
    assetId: string;
    sessionId: string;
    turnIndex: number;
    entities: MemoryRelationEntityInput[];
    source: string;
    extractorVersion: string;
  }): MemoryEntity[] {
    const stored: MemoryEntity[] = [];
    for (const entity of normalizedEntities(input.entities)) {
      const row = this.upsertEntity({
        userId: input.userId,
        entityType: normalizeEntityType(entity.type),
        canonicalName: entity.name.trim().slice(0, 200),
        aliases: normalizeStringArray(entity.aliases).slice(0, 12),
        confidence: clamp01(entity.confidence ?? 0.5),
        source: input.source,
        extractorVersion: input.extractorVersion,
      });
      stored.push(row);
      this.upsertEdge({
        userId: input.userId,
        edgeType: "asset_mentions_entity",
        fromKind: "asset",
        fromId: input.assetId,
        toKind: "entity",
        toId: row.entity_id,
        confidence: row.confidence,
        source: input.source,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        assetId: input.assetId,
        extractorVersion: input.extractorVersion,
      });
    }
    return stored;
  }

  projectImageMemoryCluster(input: {
    userId: string;
    assetId: string;
    memoryId: string;
    fact: string;
    importanceScore?: number;
    sessionId: string;
    turnIndex: number;
    entities: MemoryRelationEntityInput[];
    source: string;
    extractorVersion: string;
  }): void {
    this.upsertEdge({
      userId: input.userId,
      edgeType: "memory_derived_from_asset",
      fromKind: "memory",
      fromId: input.memoryId,
      toKind: "asset",
      toId: input.assetId,
      confidence: clamp01(input.importanceScore ?? 0.5),
      source: input.source,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      assetId: input.assetId,
      memoryId: input.memoryId,
      extractorVersion: input.extractorVersion,
      metadata: { fact: input.fact.slice(0, 1000) },
    });

    for (const entity of normalizedEntities(input.entities)) {
      const stored = this.upsertEntity({
        userId: input.userId,
        entityType: normalizeEntityType(entity.type),
        canonicalName: entity.name.trim().slice(0, 200),
        aliases: normalizeStringArray(entity.aliases).slice(0, 12),
        confidence: clamp01(entity.confidence ?? 0.5),
        source: input.source,
        extractorVersion: input.extractorVersion,
      });
      this.upsertRecordEntity({
        userId: input.userId,
        memoryId: input.memoryId,
        entityId: stored.entity_id,
        recordType: "image_memory_cluster",
        confidence: stored.confidence,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        assetId: input.assetId,
        source: input.source,
        extractorVersion: input.extractorVersion,
      });
      this.upsertEdge({
        userId: input.userId,
        edgeType: "memory_mentions_entity",
        fromKind: "memory",
        fromId: input.memoryId,
        toKind: "entity",
        toId: stored.entity_id,
        confidence: stored.confidence,
        source: input.source,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        assetId: input.assetId,
        memoryId: input.memoryId,
        extractorVersion: input.extractorVersion,
      });
    }
  }

  projectMemoryRelations(input: {
    userId: string;
    memoryId: string;
    recordType: string;
    text: string;
    entities: MemoryRelationEntityInput[];
    source: string;
    extractorVersion: string;
    sessionId?: string;
    turnIndex?: number;
    assetId?: string;
  }): void {
    for (const entity of normalizedEntities(input.entities)) {
      const stored = this.upsertEntity({
        userId: input.userId,
        entityType: normalizeEntityType(entity.type),
        canonicalName: entity.name.trim().slice(0, 200),
        aliases: normalizeStringArray(entity.aliases).slice(0, 12),
        confidence: clamp01(entity.confidence ?? 0.5),
        source: input.source,
        extractorVersion: input.extractorVersion,
      });
      this.upsertRecordEntity({
        userId: input.userId,
        memoryId: input.memoryId,
        entityId: stored.entity_id,
        recordType: input.recordType,
        confidence: stored.confidence,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        assetId: input.assetId,
        source: input.source,
        extractorVersion: input.extractorVersion,
      });
      this.upsertEdge({
        userId: input.userId,
        edgeType: "memory_mentions_entity",
        fromKind: "memory",
        fromId: input.memoryId,
        toKind: "entity",
        toId: stored.entity_id,
        confidence: stored.confidence,
        source: input.source,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        assetId: input.assetId,
        memoryId: input.memoryId,
        extractorVersion: input.extractorVersion,
        metadata: {
          record_type: input.recordType,
          text: input.text.slice(0, 1000),
        },
      });
    }
  }

  upsertSessionAssetEdge(input: {
    userId: string;
    assetId: string;
    sessionId: string;
    turnIndex: number;
    source: string;
    metadata?: Record<string, unknown>;
  }): void {
    this.upsertEdge({
      userId: input.userId,
      edgeType: "asset_seen_in_session",
      fromKind: "asset",
      fromId: input.assetId,
      toKind: "session",
      toId: input.sessionId,
      confidence: 1,
      source: input.source,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      assetId: input.assetId,
      metadata: input.metadata,
    });
  }

  private upsertEdge(input: {
    userId: string;
    edgeType: MemoryEdgeType;
    fromKind: string;
    fromId: string;
    toKind: string;
    toId: string;
    confidence: number;
    source: string;
    sessionId?: string;
    turnIndex?: number;
    assetId?: string;
    memoryId?: string;
    extractorVersion?: string;
    metadata?: Record<string, unknown>;
  }): string {
    const edgeId = stableId("edge", input.userId, input.edgeType, input.fromKind, input.fromId, input.toKind, input.toId);
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO memory_edges
          (edge_id, user_id, edge_type, from_kind, from_id, to_kind, to_id, confidence, source,
           session_id, turn_index, asset_id, memory_id, extractor_version, metadata, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16, NULL)
         ON CONFLICT(edge_id) DO UPDATE SET
           confidence=max(memory_edges.confidence, excluded.confidence),
           source=excluded.source,
           session_id=excluded.session_id,
           turn_index=excluded.turn_index,
           asset_id=excluded.asset_id,
           memory_id=excluded.memory_id,
           extractor_version=excluded.extractor_version,
           metadata=excluded.metadata,
           updated_at=excluded.updated_at,
           deleted_at=NULL`,
      )
      .run(
        edgeId,
        input.userId,
        input.edgeType,
        input.fromKind,
        input.fromId,
        input.toKind,
        input.toId,
        clamp01(input.confidence),
        input.source,
        input.sessionId ?? null,
        input.turnIndex ?? null,
        input.assetId ?? null,
        input.memoryId ?? null,
        input.extractorVersion ?? input.source,
        JSON.stringify(input.metadata ?? {}),
        now,
      );
    return edgeId;
  }

  private upsertEntity(input: {
    userId: string;
    entityType: string;
    canonicalName: string;
    aliases: string[];
    confidence: number;
    source: string;
    extractorVersion: string;
  }): MemoryEntity {
    const entityId = stableId("entity", input.userId, input.entityType, normalizeEntityName(input.canonicalName));
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO memory_entities
          (entity_id, user_id, entity_type, canonical_name, aliases, confidence, source, extractor_version, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
         ON CONFLICT(entity_id) DO UPDATE SET
           aliases=excluded.aliases,
           confidence=max(memory_entities.confidence, excluded.confidence),
           source=excluded.source,
           extractor_version=excluded.extractor_version,
           last_seen_at=excluded.last_seen_at,
           deleted_at=NULL`,
      )
      .run(
        entityId,
        input.userId,
        input.entityType,
        input.canonicalName,
        JSON.stringify(input.aliases),
        clamp01(input.confidence),
        input.source,
        input.extractorVersion,
        now,
      );
    const row = this.db
      .query<EntityRow, [string]>("SELECT * FROM memory_entities WHERE entity_id = ?")
      .get(entityId);
    return entityFromRow(row!);
  }

  private upsertRecordEntity(input: {
    userId: string;
    memoryId: string;
    entityId: string;
    recordType: string;
    confidence: number;
    sessionId?: string;
    turnIndex?: number;
    assetId?: string;
    source: string;
    extractorVersion: string;
  }): void {
    const id = stableId("record_entity", input.userId, input.memoryId, input.entityId, input.recordType);
    this.db
      .query(
        `INSERT INTO memory_record_entities
          (record_entity_id, user_id, memory_id, entity_id, record_type, confidence, source,
           session_id, turn_index, asset_id, extractor_version, metadata, created_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '{}', ?12, NULL)
         ON CONFLICT(record_entity_id) DO UPDATE SET
           confidence=max(memory_record_entities.confidence, excluded.confidence),
           deleted_at=NULL`,
      )
      .run(
        id,
        input.userId,
        input.memoryId,
        input.entityId,
        input.recordType,
        clamp01(input.confidence),
        input.source,
        input.sessionId ?? null,
        input.turnIndex ?? null,
        input.assetId ?? null,
        input.extractorVersion,
        new Date().toISOString(),
      );
  }
}

function normalizedEntities(entities: MemoryRelationEntityInput[]): MemoryRelationEntityInput[] {
  return entities
    .filter((entity) => entity.name.trim().length > 0)
    .slice(0, 20);
}

function entityFromRow(row: EntityRow): MemoryEntity {
  return {
    ...row,
    aliases: parseJsonArray(row.aliases),
    metadata: parseJsonObject(row.metadata),
  };
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter((value) => value.length > 0);
}

function normalizeEntityType(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^(person|project|product|company|organization|org|place|location|file|page|topic|tool)$/.test(raw)) {
    return raw === "org" ? "organization" : raw;
  }
  return "topic";
}

function normalizeEntityName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.5;
}
