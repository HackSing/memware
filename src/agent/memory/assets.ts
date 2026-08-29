import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ContentBlock, ImageContent } from "./contentBlocks";
import { TEXT_MEMORY_RELATION_EXTRACTOR_VERSION } from "./relationProjection";
import { shaHex, stableId } from "./ids";
import {
  MemoryGraphProjectionStore,
  type MemoryEntity,
  type MemoryRelationEntityInput,
} from "./graphProjection";

export type { MemoryEntity, MemoryEdgeType, MemoryRelationEntityInput } from "./graphProjection";

export const MULTIMODAL_EXTRACTOR_VERSION = "multimodal-memory-v1";

export type MemoryAssetStatus = "active" | "tombstoned";

export interface MemoryAsset {
  asset_id: string;
  user_id: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  file_path: string;
  status: MemoryAssetStatus;
  summary: string;
  ocr_text: string;
  topics: string[];
  metadata: Record<string, unknown>;
  extractor_version: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

export interface MemoryAssetSource {
  source_id: string;
  user_id: string;
  asset_id: string;
  session_id: string;
  turn_index: number;
  source: string;
  message_text: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MemoryAssetDetail extends MemoryAsset {
  sources: MemoryAssetSource[];
  entities: MemoryEntity[];
  derived_memories: Array<{ memory_id: string; edge_type: string; created_at: string }>;
}

export interface CapturedMemoryAsset {
  originalIndex: number;
  asset: MemoryAsset;
  source: MemoryAssetSource;
}

export interface SkippedMemoryAsset {
  originalIndex: number;
  reason: string;
  detail?: string;
}

export interface CaptureTurnAssetsInput {
  userId: string;
  sessionId: string;
  turnIndex: number;
  source: string;
  userMessage: string;
  content?: ContentBlock[];
  maxImageBytes: number;
  maxImagesPerTurn: number;
}

export interface CaptureTurnAssetsResult {
  captured: CapturedMemoryAsset[];
  skipped: SkippedMemoryAsset[];
}

export interface StoreGeneratedImageAssetInput {
  userId: string;
  sessionId: string;
  turnIndex: number;
  source: string;
  prompt: string;
  model?: string;
  provider?: string;
  bytes: Uint8Array;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

export interface StoredGeneratedImageAsset {
  asset: MemoryAsset;
  source: MemoryAssetSource;
  marker: string;
}

export interface MultimodalAssetExtraction {
  summary: string;
  visible_text?: string;
  topics?: string[];
  entities?: Array<{
    name: string;
    type?: string;
    aliases?: string[];
    confidence?: number;
  }>;
  memory_clusters?: Array<{
    fact: string;
    importance_score?: number;
    foresight?: string;
  }>;
}

interface AssetRow {
  asset_id: string;
  user_id: string;
  sha256: string;
  mime_type: string;
  byte_size: number;
  file_path: string;
  status: MemoryAssetStatus;
  summary: string | null;
  ocr_text: string | null;
  topics: string;
  metadata: string;
  extractor_version: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface SourceRow {
  source_id: string;
  user_id: string;
  asset_id: string;
  session_id: string;
  turn_index: number;
  source: string;
  message_text: string | null;
  metadata: string;
  created_at: string;
}

export class MemoryAssetStore {
  private readonly graph: MemoryGraphProjectionStore;

  constructor(
    private readonly db: Database,
    private readonly assetsRoot: string,
  ) {
    this.graph = new MemoryGraphProjectionStore(db);
  }

  captureTurnAssets(input: CaptureTurnAssetsInput): CaptureTurnAssetsResult {
    const blocks = Array.isArray(input.content) ? input.content : [];
    const images = blocks
      .map((block, index) => ({ block, index }))
      .filter((item): item is { block: ImageContent; index: number } => item.block.type === "image");

    const captured: CapturedMemoryAsset[] = [];
    const skipped: SkippedMemoryAsset[] = [];
    let seen = 0;

    for (const { block, index } of images) {
      if (seen >= input.maxImagesPerTurn) {
        const reason = "max_images_per_turn_exceeded";
        skipped.push({ originalIndex: index, reason });
        this.insertAudit(input, reason, { originalIndex: index, maxImagesPerTurn: input.maxImagesPerTurn });
        continue;
      }
      seen++;

      const decoded = decodeImage(block);
      if (!decoded) {
        const reason = "unsupported_image_source";
        skipped.push({ originalIndex: index, reason });
        this.insertAudit(input, reason, { originalIndex: index, sourceType: block.source.type });
        continue;
      }

      if (decoded.bytes.byteLength > input.maxImageBytes) {
        const reason = "max_image_bytes_exceeded";
        skipped.push({
          originalIndex: index,
          reason,
          detail: `${decoded.bytes.byteLength} > ${input.maxImageBytes}`,
        });
        this.insertAudit(input, reason, {
          originalIndex: index,
          byteSize: decoded.bytes.byteLength,
          maxImageBytes: input.maxImageBytes,
        });
        continue;
      }

      const sha256 = shaHex(decoded.bytes);
      const assetId = stableId("asset", input.userId, sha256);
      const existing = this.getAsset(input.userId, assetId, { includeDeleted: true });
      if (existing?.status === "tombstoned") {
        const reason = "asset_tombstoned";
        skipped.push({ originalIndex: index, reason, detail: assetId });
        this.insertAudit(input, reason, { originalIndex: index, assetId, sha256 });
        continue;
      }

      const filePath = this.assetFilePath(input.userId, sha256, decoded.mediaType);
      if (!existsSync(filePath)) {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, decoded.bytes);
      }

      const now = new Date().toISOString();
      const metadata = {
        original_index: index,
        extension: extensionForMime(decoded.mediaType),
      };
      this.db
        .query(
          `INSERT INTO memory_assets
            (asset_id, user_id, sha256, mime_type, byte_size, file_path, status, metadata, created_at, updated_at, deleted_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8, NULL)
           ON CONFLICT(user_id, sha256) DO UPDATE SET
             mime_type=excluded.mime_type,
             byte_size=excluded.byte_size,
             file_path=excluded.file_path,
             status=CASE
               WHEN memory_assets.status = 'tombstoned' THEN memory_assets.status
               ELSE 'active'
             END,
             metadata=excluded.metadata,
             updated_at=excluded.updated_at,
             deleted_at=CASE
               WHEN memory_assets.status = 'tombstoned' THEN memory_assets.deleted_at
               ELSE NULL
             END`,
        )
        .run(assetId, input.userId, sha256, decoded.mediaType, decoded.bytes.byteLength, filePath, JSON.stringify(metadata), now);

      const sourceId = stableId("asset_source", input.userId, assetId, input.sessionId, String(input.turnIndex), String(index));
      this.db
        .query(
          `INSERT OR IGNORE INTO memory_asset_sources
            (source_id, user_id, asset_id, session_id, turn_index, source, message_text, metadata, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          sourceId,
          input.userId,
          assetId,
          input.sessionId,
          input.turnIndex,
          input.source,
          input.userMessage.slice(0, 4000),
          JSON.stringify({ original_index: index }),
          now,
        );

      this.graph.upsertSessionAssetEdge({
        userId: input.userId,
        assetId,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        source: input.source,
        metadata: { source_id: sourceId },
      });

      const asset = this.getAsset(input.userId, assetId, { includeDeleted: true });
      const source = this.getSource(sourceId);
      if (asset && source) captured.push({ originalIndex: index, asset, source });
    }

    return { captured, skipped };
  }

  storeGeneratedImageAsset(input: StoreGeneratedImageAssetInput): StoredGeneratedImageAsset {
    const mimeType = input.mimeType.trim().toLowerCase();
    if (!mimeType.startsWith("image/")) {
      throw new Error(`generated asset must be an image, got ${input.mimeType}`);
    }

    const bytes = Buffer.from(input.bytes);
    const sha256 = shaHex(bytes);
    const assetId = stableId("asset", input.userId, sha256);
    const existing = this.getAsset(input.userId, assetId, { includeDeleted: true });
    if (existing?.status === "tombstoned") {
      throw new Error(`generated image asset is tombstoned: ${assetId}`);
    }

    const filePath = this.assetFilePath(input.userId, sha256, mimeType);
    if (!existsSync(filePath)) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, bytes);
    }

    const now = new Date().toISOString();
    const metadata = {
      generated: true,
      prompt: input.prompt.slice(0, 4000),
      ...(input.model ? { model: input.model } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.metadata ?? {}),
      extension: extensionForMime(mimeType),
    };
    this.db
      .query(
        `INSERT INTO memory_assets
          (asset_id, user_id, sha256, mime_type, byte_size, file_path, status, metadata, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, ?8, NULL)
         ON CONFLICT(user_id, sha256) DO UPDATE SET
           mime_type=excluded.mime_type,
           byte_size=excluded.byte_size,
           file_path=excluded.file_path,
           status=CASE
             WHEN memory_assets.status = 'tombstoned' THEN memory_assets.status
             ELSE 'active'
           END,
           metadata=excluded.metadata,
           updated_at=excluded.updated_at,
           deleted_at=CASE
             WHEN memory_assets.status = 'tombstoned' THEN memory_assets.deleted_at
             ELSE NULL
           END`,
      )
      .run(assetId, input.userId, sha256, mimeType, bytes.byteLength, filePath, JSON.stringify(metadata), now);

    const sourceId = stableId(
      "asset_source",
      input.userId,
      assetId,
      input.sessionId,
      String(input.turnIndex),
      input.source,
      "generated",
    );
    this.db
      .query(
        `INSERT OR IGNORE INTO memory_asset_sources
          (source_id, user_id, asset_id, session_id, turn_index, source, message_text, metadata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
      .run(
        sourceId,
        input.userId,
        assetId,
        input.sessionId,
        input.turnIndex,
        input.source,
        input.prompt.slice(0, 4000),
        JSON.stringify({ generated: true, model: input.model, provider: input.provider }),
        now,
      );

    this.graph.upsertSessionAssetEdge({
      userId: input.userId,
      assetId,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      source: input.source,
      metadata: { source_id: sourceId, generated: true },
    });

    const asset = this.getAsset(input.userId, assetId, { includeDeleted: true });
    const source = this.getSource(sourceId);
    if (!asset || !source) throw new Error(`generated image asset write failed: ${assetId}`);
    return { asset, source, marker: formatImageAssetMarker(asset) };
  }

  listAssets(opts: { userId?: string; limit?: number; includeDeleted?: boolean } = {}): MemoryAsset[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const params: unknown[] = [];
    let sql = "SELECT * FROM memory_assets";
    const where: string[] = [];
    if (opts.userId) {
      where.push("user_id = ?");
      params.push(opts.userId);
    }
    if (!opts.includeDeleted) {
      where.push("status != 'tombstoned'");
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(limit);
    return this.db.query<AssetRow, string[]>(sql).all(...(params as string[])).map(assetFromRow);
  }

  getAsset(userId: string, assetId: string, opts: { includeDeleted?: boolean } = {}): MemoryAsset | null {
    const row = this.db
      .query<AssetRow, [string, string]>("SELECT * FROM memory_assets WHERE user_id = ? AND asset_id = ?")
      .get(userId, assetId);
    if (!row) return null;
    if (!opts.includeDeleted && row.status === "tombstoned") return null;
    return assetFromRow(row);
  }

  getAssetDetail(userId: string, assetId: string, opts: { includeDeleted?: boolean } = {}): MemoryAssetDetail | null {
    const asset = this.getAsset(userId, assetId, opts);
    if (!asset) return null;
    const sources = this.db
      .query<SourceRow, [string, string]>("SELECT * FROM memory_asset_sources WHERE user_id = ? AND asset_id = ? ORDER BY created_at DESC")
      .all(userId, assetId)
      .map(sourceFromRow);
    const entities = this.graph.listAssetEntities(userId, assetId);
    const derived = this.graph.listAssetDerivedMemories(userId, assetId);
    return { ...asset, sources, entities, derived_memories: derived };
  }

  deleteAsset(userId: string, assetId: string): boolean {
    const asset = this.getAsset(userId, assetId, { includeDeleted: true });
    if (!asset || asset.status === "tombstoned") return false;
    const now = new Date().toISOString();
    this.db
      .query("UPDATE memory_assets SET status = 'tombstoned', deleted_at = ?1, updated_at = ?1 WHERE user_id = ?2 AND asset_id = ?3")
      .run(now, userId, assetId);
    this.graph.tombstoneAssetRelations(userId, assetId, now);
    try {
      if (existsSync(asset.file_path)) unlinkSync(asset.file_path);
    } catch {
      // Metadata tombstone is authoritative even if the file was already gone.
    }
    return true;
  }

  tombstoneTextMemoryRelations(input: {
    userId: string;
    sessionId?: string;
    turnIndex?: number;
  }): void {
    if (input.sessionId === undefined && input.turnIndex === undefined) return;
    this.graph.tombstoneTextMemoryRelations({
      userId: input.userId,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      source: TEXT_MEMORY_RELATION_EXTRACTOR_VERSION,
    });
  }

  applyExtraction(input: {
    userId: string;
    assetId: string;
    sessionId: string;
    turnIndex: number;
    extraction: MultimodalAssetExtraction;
  }): void {
    const asset = this.getAsset(input.userId, input.assetId);
    if (!asset) return;

    const topics = normalizeStringArray(input.extraction.topics).slice(0, 12);
    this.db
      .query(
        `UPDATE memory_assets
         SET summary = ?1, ocr_text = ?2, topics = ?3, extractor_version = ?4, updated_at = ?5
         WHERE user_id = ?6 AND asset_id = ?7`,
      )
      .run(
        input.extraction.summary.slice(0, 4000),
        (input.extraction.visible_text ?? "").slice(0, 8000),
        JSON.stringify(topics),
        MULTIMODAL_EXTRACTOR_VERSION,
        new Date().toISOString(),
        input.userId,
        input.assetId,
      );

    const entities = (input.extraction.entities ?? [])
      .filter((entity) => entity.name.trim().length > 0)
      .slice(0, 20);
    this.graph.projectAssetEntities({
      userId: input.userId,
      assetId: input.assetId,
      sessionId: input.sessionId,
      turnIndex: input.turnIndex,
      entities,
      source: MULTIMODAL_EXTRACTOR_VERSION,
      extractorVersion: MULTIMODAL_EXTRACTOR_VERSION,
    });

    const clusters = (input.extraction.memory_clusters ?? [])
      .filter((cluster) => cluster.fact.trim().length >= 4)
      .slice(0, 5);
    for (let i = 0; i < clusters.length; i++) {
      const memoryId = stableId("image_memory", input.userId, input.assetId, clusters[i]!.fact);
      this.graph.projectImageMemoryCluster({
        userId: input.userId,
        assetId: input.assetId,
        memoryId,
        fact: clusters[i]!.fact,
        importanceScore: clusters[i]!.importance_score,
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
        entities,
        source: MULTIMODAL_EXTRACTOR_VERSION,
        extractorVersion: MULTIMODAL_EXTRACTOR_VERSION,
      });
    }
  }

  recordHygieneRetryAudit(input: {
    userId: string;
    assetId: string;
    sessionId: string;
    turnIndex: number;
    outcome: "started" | "updated" | "failed";
    errorKind?: string;
  }): void {
    const createdAt = new Date().toISOString();
    const reason = `memory_hygiene_image_retry_${input.outcome}`;
    this.db
      .query(
        `INSERT INTO memory_asset_audit
          (audit_id, user_id, reason, session_id, turn_index, source, metadata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'memory-hygiene', ?6, ?7)`,
      )
      .run(
        stableId(
          "asset_audit",
          input.userId,
          input.assetId,
          input.sessionId,
          String(input.turnIndex),
          reason,
          createdAt,
        ),
        input.userId,
        reason,
        input.sessionId,
        input.turnIndex,
        JSON.stringify({
          asset_id: input.assetId,
          outcome: input.outcome,
          ...(input.errorKind ? { error_kind: input.errorKind } : {}),
        }),
        createdAt,
      );
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
    this.graph.projectMemoryRelations(input);
  }

  private insertAudit(input: CaptureTurnAssetsInput, reason: string, metadata: Record<string, unknown>): void {
    this.db
      .query(
        `INSERT INTO memory_asset_audit
          (audit_id, user_id, reason, session_id, turn_index, source, metadata, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        stableId("asset_audit", input.userId, input.sessionId, String(input.turnIndex), reason, JSON.stringify(metadata), String(Date.now())),
        input.userId,
        reason,
        input.sessionId,
        input.turnIndex,
        input.source,
        JSON.stringify(metadata),
        new Date().toISOString(),
      );
  }

  private assetFilePath(userId: string, sha256: string, mediaType: string): string {
    const ext = extensionForMime(mediaType);
    const day = new Date().toISOString().slice(0, 10);
    return join(this.assetsRoot, "images", sanitizePathSegment(userId), day.slice(0, 7), `${sha256}.${ext}`);
  }

  private getSource(sourceId: string): MemoryAssetSource | null {
    const row = this.db
      .query<SourceRow, [string]>("SELECT * FROM memory_asset_sources WHERE source_id = ?")
      .get(sourceId);
    return row ? sourceFromRow(row) : null;
  }
}

export function slimCapturedImagesInContent(
  content: ContentBlock[] | undefined,
  result: CaptureTurnAssetsResult,
): ContentBlock[] | undefined {
  if (!Array.isArray(content)) return content;
  const capturedByIndex = new Map(result.captured.map((item) => [item.originalIndex, item] as const));
  const skippedByIndex = new Map(result.skipped.map((item) => [item.originalIndex, item] as const));
  return content.map((block, index) => {
    if (block.type !== "image") return block;
    const captured = capturedByIndex.get(index);
    if (captured) {
      return {
        type: "text",
        text: formatImageAssetMarker(captured.asset),
      };
    }
    const skipped = skippedByIndex.get(index);
    return {
      type: "text",
      text: `[Image skipped from memory: ${skipped?.reason ?? "not_captured"}]`,
    };
  });
}

export function formatImageAssetMarker(asset: MemoryAsset): string {
  return `[Image asset: ${asset.asset_id}; mime=${asset.mime_type}; bytes=${asset.byte_size}; sha256=${asset.sha256}]`;
}

export function scrubImagesForSessionPersistence(content: ContentBlock[] | undefined): ContentBlock[] | undefined {
  if (!Array.isArray(content) || !content.some((block) => block.type === "image")) return content;
  return slimCapturedImagesInContent(content, { captured: [], skipped: [] });
}

export function memoryIdForImageCluster(userId: string, assetId: string, fact: string): string {
  return stableId("image_memory", userId, assetId, fact);
}

export function metadataSourceForAsset(assetId: string, sessionId: string, turnIndex: number): string {
  return `${MULTIMODAL_EXTRACTOR_VERSION}:asset_id=${assetId}:session_id=${sessionId}:turn=${turnIndex}`;
}

function decodeImage(block: ImageContent): { mediaType: string; bytes: Uint8Array } | null {
  if (block.source.type === "base64") {
    if (!block.source.media_type.startsWith("image/")) return null;
    return { mediaType: block.source.media_type.toLowerCase(), bytes: Buffer.from(block.source.data, "base64") };
  }
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(block.source.url);
  if (!match) return null;
  const mediaType = match[1]?.trim().toLowerCase();
  const data = match[2]?.trim();
  if (!mediaType?.startsWith("image/") || !data) return null;
  return { mediaType, bytes: Buffer.from(data, "base64") };
}

function assetFromRow(row: AssetRow): MemoryAsset {
  return {
    ...row,
    summary: row.summary ?? "",
    ocr_text: row.ocr_text ?? "",
    topics: parseJsonArray(row.topics),
    metadata: parseJsonObject(row.metadata),
    extractor_version: row.extractor_version ?? "",
  };
}

function sourceFromRow(row: SourceRow): MemoryAssetSource {
  return {
    ...row,
    message_text: row.message_text ?? "",
    metadata: parseJsonObject(row.metadata),
  };
}

function extensionForMime(mediaType: string): string {
  const lower = mediaType.toLowerCase();
  if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
  if (lower === "image/png") return "png";
  if (lower === "image/webp") return "webp";
  if (lower === "image/gif") return "gif";
  const ext = extname(lower.split("/")[1] ?? "").replace(/^\./, "");
  return ext || "img";
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "default";
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
