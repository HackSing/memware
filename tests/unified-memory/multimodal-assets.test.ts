import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { MemoryService } from '../../src/agent/memory/service';
import { MemorySettings } from '../../src/agent/memory/config';
import {
  MemoryAssetStore,
  scrubImagesForSessionPersistence,
  slimCapturedImagesInContent,
} from '../../src/agent/memory/assets';
import { MultimodalMemoryExtractor, parseMultimodalExtractionForTest } from '../../src/agent/memory/multimodalExtractor';
import type { ChatCompletionOptions, MemoryLLMClient } from '../../src/agent/memory/llmClient';
import { extractTextMemoryEntityCandidates, memoryIdForTextCluster } from '../../src/agent/memory/relationProjection';
import type { ContentBlock } from '../../src/agent/memory/contentBlocks';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  OK ${label}`);
    passed++;
  } else {
    console.log(`  FAIL ${label}`);
    failed++;
  }
}

function makeService(): { svc: MemoryService; dbPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'avatanel-mm-assets-'));
  const dbPath = join(root, 'memory.db');
  const configPath = join(root, 'memory-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      storage: {
        sqlite_path: dbPath,
        vector_db_path: join(root, 'vectors.db'),
      },
      multimodal: {
        enabled: true,
        max_image_bytes: 8 * 1024 * 1024,
        max_images_per_turn: 4,
      },
    }),
    'utf8',
  );
  return { svc: new MemoryService(new MemorySettings(configPath)), dbPath, root };
}

function pngBlock(seed: string): ContentBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/png',
      data: Buffer.from(`image-${seed}`).toString('base64'),
    },
  };
}

function remoteImageBlock(seed: string): ContentBlock {
  return {
    type: 'image',
    source: {
      type: 'url',
      url: `https://example.invalid/${seed}.png`,
    },
  };
}

async function main(): Promise<void> {
  const { svc, dbPath, root } = makeService();
  const userId = 'u-mm';
  await svc.init();
  await svc.warmup(userId);

  console.log('--- asset capture enforces per-turn limit and stores files ---');
  const content: ContentBlock[] = [
    { type: 'text', text: 'screenshots' },
    pngBlock('1'),
    pngBlock('2'),
    pngBlock('3'),
    pngBlock('4'),
    pngBlock('5'),
  ];
  const captured = await svc.captureTurnAssets({
    userId,
    sessionId: 's-1',
    turnIndex: 1,
    source: 'test',
    userMessage: 'screenshots',
    content,
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerTurn: 4,
  });
  assert(captured.captured.length === 4, 'captures first 4 images in one turn');
  assert(captured.skipped.length === 1 && captured.skipped[0]?.reason === 'max_images_per_turn_exceeded', 'skips images over per-turn limit');
  assert(captured.captured.every((item) => existsSync(item.asset.file_path)), 'captured images are written to disk');
  assert(svc.listMemoryAssets({ userId }).length === 4, 'four unique assets are visible');

  console.log('--- size limit writes audit only ---');
  const tooLarge = await svc.captureTurnAssets({
    userId,
    sessionId: 's-1',
    turnIndex: 2,
    source: 'test',
    userMessage: 'large screenshot',
    content: [pngBlock('large')],
    maxImageBytes: 4,
    maxImagesPerTurn: 4,
  });
  assert(tooLarge.captured.length === 0, 'oversized image is not captured');
  assert(tooLarge.skipped[0]?.reason === 'max_image_bytes_exceeded', 'oversized image reports audit reason');

  console.log('--- per-turn limit counts every image block, including rejected ones ---');
  const rejectedFirst = await svc.captureTurnAssets({
    userId,
    sessionId: 's-1',
    turnIndex: 3,
    source: 'test',
    userMessage: 'mixed screenshots',
    content: [
      remoteImageBlock('1'),
      remoteImageBlock('2'),
      remoteImageBlock('3'),
      remoteImageBlock('4'),
      pngBlock('valid-after-limit'),
    ],
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerTurn: 4,
  });
  assert(rejectedFirst.captured.length === 0, 'valid fifth image is not captured after four earlier image blocks');
  assert(rejectedFirst.skipped.at(-1)?.reason === 'max_images_per_turn_exceeded', 'fifth image is skipped as over per-turn limit');

  console.log('--- session slimming replaces raw images with asset refs ---');
  const slimmed = slimCapturedImagesInContent(content, captured);
  assert(Array.isArray(slimmed), 'slimmed content remains block array');
  assert(!slimmed?.some((block) => block.type === 'image'), 'slimmed content contains no raw image blocks');
  assert(slimmed?.some((block) => block.type === 'text' && block.text.includes('[Image asset:')), 'slimmed content includes asset refs');

  const fallbackSlimmed = scrubImagesForSessionPersistence([{ type: 'text', text: 'fallback' }, pngBlock('fallback')]);
  assert(!fallbackSlimmed?.some((block) => block.type === 'image'), 'fallback session scrub removes raw image blocks');
  assert(
    fallbackSlimmed?.some((block) => block.type === 'text' && block.text.includes('[Image skipped from memory: not_captured]')),
    'fallback session scrub records omitted image without base64',
  );

  console.log('--- extraction schema rejects high-impact fields ---');
  let rejected = false;
  try {
    parseMultimodalExtractionForTest({
      summary: 'A screenshot of Avatanel.',
      profile_update: { basic_info: [] },
    });
  } catch {
    rejected = true;
  }
  assert(rejected, 'multimodal extraction schema rejects profile_update');

  const flexible = parseMultimodalExtractionForTest({
    summary: 'A tabby cat under a blanket.',
    visible_text: [],
    topics: ['cat'],
    entities: ['tabby cat'],
    memory_clusters: ['The cat has green eyes.'],
  });
  assert(flexible.visible_text === undefined, 'empty OCR arrays are normalized away');
  assert(flexible.entities?.[0]?.name === 'tabby cat', 'string entity arrays are normalized');
  assert(flexible.memory_clusters?.[0]?.fact === 'The cat has green eyes.', 'string memory clusters are normalized');

  console.log('--- extractor prompt follows output language profile ---');
  const promptCalls: ChatCompletionOptions[] = [];
  const mockClient: MemoryLLMClient = {
    async chatCompletion(opts) {
      promptCalls.push(opts);
      return {
        content: JSON.stringify({
          summary: '截图显示记忆页面。',
          topics: ['记忆页面'],
          entities: ['Avatanel'],
          memory_clusters: ['截图显示 Avatanel 的记忆页面。'],
        }),
      };
    },
    async embed() {
      return { embeddings: [] };
    },
  };
  const extractor = new MultimodalMemoryExtractor(mockClient, 'vision-test');
  await extractor.extract({
    asset: captured.captured[0]!.asset,
    userMessage: '按我的语言习惯记录',
    assistantMessage: '',
    outputLanguage: 'zh',
  });
  const zhSystemPrompt = String(promptCalls.at(-1)?.messages[0]?.content ?? '');
  assert(zhSystemPrompt.includes('Simplified Chinese'), 'extractor asks for Chinese summaries from profile language');
  assert(zhSystemPrompt.includes('Preserve visible_text/OCR exactly'), 'extractor preserves OCR without translation');
  await extractor.extract({
    asset: captured.captured[0]!.asset,
    userMessage: 'please remember this image',
    assistantMessage: '',
    outputLanguage: 'en',
  });
  const enSystemPrompt = String(promptCalls.at(-1)?.messages[0]?.content ?? '');
  assert(enSystemPrompt.includes('English'), 'extractor can ask for English summaries from profile language');

  console.log('--- relation projection is idempotent and tombstone delete works ---');
  const store = (svc as unknown as { assetStore: MemoryAssetStore }).assetStore;
  const first = captured.captured[0]!;
  const extraction = {
    summary: 'Screenshot showing the Avatanel Memory page.',
    visible_text: 'Memory Assets',
    topics: ['Avatanel Memory'],
    entities: [{ name: 'Avatanel', type: 'project', confidence: 0.9 }],
    memory_clusters: [{ fact: '截图显示 Avatanel Memory 页面', importance_score: 0.6 }],
  };
  store.applyExtraction({ userId, assetId: first.asset.asset_id, sessionId: 's-1', turnIndex: 1, extraction });
  store.applyExtraction({ userId, assetId: first.asset.asset_id, sessionId: 's-1', turnIndex: 1, extraction });
  const detail = svc.getMemoryAsset(userId, first.asset.asset_id);
  assert(detail?.entities.length === 1, 'asset_mentions_entity edge is idempotent');
  assert(detail?.derived_memories.length === 1, 'memory_derived_from_asset edge is idempotent');

  console.log('--- text memory clusters project lightweight graph relations ---');
  const textEntities = extractTextMemoryEntityCandidates('用户正在给 Avatanel 的微信多模态记忆 V1.1 补图关系，并评估 Neo4j。');
  assert(textEntities.some((entity) => entity.name === 'Avatanel'), 'text entity extractor keeps project names');
  assert(textEntities.some((entity) => entity.name === '微信'), 'text entity extractor keeps known Chinese platform terms');
  assert(textEntities.some((entity) => entity.name === 'Neo4j'), 'text entity extractor keeps database names');

  (svc as unknown as { embedder: { embedText: (text: string) => Promise<number[]> } }).embedder = {
    async embedText() { return [0.1, 0.2, 0.3]; },
  };
  const serviceCluster = {
    fact: '用户在 Avatanel 里测试微信和 Neo4j 图关系',
    importance_score: 0.7,
    created_at: '2026-05-02T12:00:00.000Z',
    provenance: {
      source: 'unified-extraction-v1' as const,
      session_id: 's-1',
      turn_index: 8,
      confidence: 0.9,
      extracted_at: '2026-05-02T12:00:00.000Z',
    },
  };
  await svc.addMemoryCluster(userId, serviceCluster);
  const serviceMemoryId = memoryIdForTextCluster(userId, serviceCluster);

  const textMemoryId = 'text_memory_test_v11';
  store.projectMemoryRelations({
    userId,
    memoryId: textMemoryId,
    recordType: 'text_memory_cluster',
    text: '用户正在给 Avatanel 的微信多模态记忆 V1.1 补图关系，并评估 Neo4j。',
    entities: textEntities,
    source: 'text-memory-graph-v1',
    extractorVersion: 'text-memory-graph-v1',
    sessionId: 's-1',
    turnIndex: 9,
  });
  store.projectMemoryRelations({
    userId,
    memoryId: textMemoryId,
    recordType: 'text_memory_cluster',
    text: '用户正在给 Avatanel 的微信多模态记忆 V1.1 补图关系，并评估 Neo4j。',
    entities: textEntities,
    source: 'text-memory-graph-v1',
    extractorVersion: 'text-memory-graph-v1',
    sessionId: 's-1',
    turnIndex: 9,
  });
  store.tombstoneTextMemoryRelations({ userId, sessionId: 's-1', turnIndex: 9 });

  assert(svc.deleteMemoryAsset(userId, first.asset.asset_id) === true, 'asset delete returns true');
  assert(!existsSync(first.asset.file_path), 'asset file is removed on delete');
  assert(svc.getMemoryAsset(userId, first.asset.asset_id) === null, 'deleted asset is hidden by default');
  assert(svc.getMemoryAsset(userId, first.asset.asset_id, { includeDeleted: true })?.status === 'tombstoned', 'deleted asset is tombstoned for audit');
  const reuploadDeleted = await svc.captureTurnAssets({
    userId,
    sessionId: 's-1',
    turnIndex: 4,
    source: 'test',
    userMessage: 'same screenshot again',
    content: [content[first.originalIndex]!],
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerTurn: 4,
  });
  assert(reuploadDeleted.captured.length === 0, 'same sha is not re-captured after tombstone delete');
  assert(reuploadDeleted.skipped[0]?.reason === 'asset_tombstoned', 'same sha reupload is audit-only after tombstone delete');
  assert(svc.getMemoryAsset(userId, first.asset.asset_id, { includeDeleted: true })?.status === 'tombstoned', 'same sha reupload does not revive tombstoned asset');

  const db = new Database(dbPath, { readonly: true });
  try {
    const audit = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM memory_asset_audit WHERE reason = 'max_image_bytes_exceeded'")
      .get();
    assert((audit?.cnt ?? 0) >= 1, 'oversized skip is recorded in audit table');
    const tombstoneAudit = db
      .query<{ cnt: number }, []>("SELECT COUNT(*) AS cnt FROM memory_asset_audit WHERE reason = 'asset_tombstoned'")
      .get();
    assert((tombstoneAudit?.cnt ?? 0) >= 1, 'same sha reupload after delete is recorded in audit table');
    const textEdges = db
      .query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) AS cnt FROM memory_edges WHERE user_id = ? AND memory_id = 'text_memory_test_v11' AND edge_type = 'memory_mentions_entity'",
      )
      .get(userId);
    assert((textEdges?.cnt ?? 0) === textEntities.length, 'text memory graph edges are idempotent');
    const serviceTextEdges = db
      .query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) AS cnt FROM memory_edges WHERE user_id = ? AND memory_id = ? AND edge_type = 'memory_mentions_entity' AND deleted_at IS NULL",
      )
      .get(userId, serviceMemoryId);
    assert((serviceTextEdges?.cnt ?? 0) >= 3, 'MemoryService.addMemoryCluster projects text cluster relations');
    const textRecordLinks = db
      .query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) AS cnt FROM memory_record_entities WHERE user_id = ? AND memory_id = 'text_memory_test_v11'",
      )
      .get(userId);
    assert((textRecordLinks?.cnt ?? 0) === textEntities.length, 'text memory record-entity links are idempotent');
    const tombstonedTextEdges = db
      .query<{ cnt: number }, [string]>(
        "SELECT COUNT(*) AS cnt FROM memory_edges WHERE user_id = ? AND memory_id = 'text_memory_test_v11' AND deleted_at IS NOT NULL",
      )
      .get(userId);
    assert((tombstonedTextEdges?.cnt ?? 0) === textEntities.length, 'text memory graph links can be tombstoned by session turn');
  } finally {
    db.close();
    svc.close();
    rmSync(root, { recursive: true, force: true });
  }

  if (failed > 0) {
    console.error(`\n${failed} multimodal asset test(s) failed`);
    process.exit(1);
  }
  console.log(`\n${passed} multimodal asset tests passed`);
}

await main();
