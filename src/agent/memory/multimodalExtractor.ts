import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MemoryLLMClient } from "./llmClient";
import type { MemoryAsset, MultimodalAssetExtraction } from "./assets";
import { languageDisplayName, normalizeUserLanguage, type UserLanguage } from "./language";

const EntitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(40).optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(12).optional(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

const ImageClusterSchema = z.object({
  fact: z.string().trim().min(4).max(1000),
  importance_score: z.number().min(0).max(1).optional(),
  foresight: z.string().trim().max(1000).optional(),
}).strict();

const MultimodalExtractionSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  visible_text: z.string().trim().max(8000).optional(),
  topics: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  entities: z.array(EntitySchema).max(20).optional(),
  memory_clusters: z.array(ImageClusterSchema).max(5).optional(),
}).strict();

export class MultimodalMemoryExtractor {
  constructor(
    private readonly client: MemoryLLMClient,
    private readonly model: string,
  ) {}

  async extract(input: {
    asset: Pick<MemoryAsset, "asset_id" | "mime_type" | "file_path">;
    userMessage: string;
    assistantMessage: string;
    outputLanguage?: UserLanguage | string;
    signal?: AbortSignal;
  }): Promise<MultimodalAssetExtraction | null> {
    const imageBytes = readFileSync(input.asset.file_path);
    const imageUrl = `data:${input.asset.mime_type};base64,${imageBytes.toString("base64")}`;
    const outputLanguage = languageDisplayName(normalizeUserLanguage(input.outputLanguage) ?? "zh");
    const result = await this.client.chatCompletion({
      model: this.model,
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 1200,
      signal: input.signal,
      messages: [
        {
          role: "system",
          content: [
            "You are Avatanel's multimodal memory extractor.",
            "Extract only low-risk image memory from the screenshot/photo.",
            "Return strict JSON with keys: summary, visible_text, topics, entities, memory_clusters.",
            `Write summary, topics, entities, and memory_clusters in ${outputLanguage}.`,
            "Preserve visible_text/OCR exactly as it appears in the image; do not translate OCR text.",
            "Never output profile, relationship, identity, intimacy, or mood updates from the image alone.",
            "Entities must be concrete visible or explicitly mentioned objects such as people, projects, products, companies, places, files, pages, tools, or topics.",
            "memory_clusters must be facts about the image or visible external context, not claims about the user's private traits unless the user's text explicitly confirms them.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                `asset_id: ${input.asset.asset_id}`,
                `user_message: ${input.userMessage.slice(0, 2000)}`,
                `assistant_reply: ${input.assistantMessage.slice(0, 2000)}`,
                "Extract a concise durable memory view of this image.",
              ].join("\n"),
            },
            { type: "image_url", image_url: { url: imageUrl } },
          ],
        },
      ],
    });

    try {
      return parseMultimodalExtraction(result.content);
    } catch {
      return null;
    }
  }
}

export function parseMultimodalExtractionForTest(raw: unknown): MultimodalAssetExtraction {
  return parseMultimodalExtraction(raw);
}

function parseMultimodalExtraction(raw: unknown): MultimodalAssetExtraction {
  const parsed = typeof raw === "string" ? parseJsonObjectFromText(raw) : raw;
  return MultimodalExtractionSchema.parse(normalizeMultimodalExtraction(parsed));
}

function parseJsonObjectFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some OpenAI-compatible vision models ignore response_format and wrap JSON
    // in a fenced block or short prose. Keep parsing strict after isolating the
    // object; the schema below still rejects unsupported keys.
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // Fall through to object slicing.
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return JSON.parse(text.slice(start, end + 1));
  }
  return JSON.parse(text);
}

function normalizeMultimodalExtraction(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const normalized: Record<string, unknown> = { ...raw };

  if (Array.isArray(normalized.visible_text)) {
    normalized.visible_text = normalized.visible_text
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join("\n");
    if (normalized.visible_text === "") delete normalized.visible_text;
  }

  if (Array.isArray(normalized.entities)) {
    normalized.entities = normalized.entities
      .map((entity) => {
        if (typeof entity === "string") return { name: entity };
        return entity;
      })
      .filter((entity) => isRecord(entity) || typeof entity === "string");
  }

  if (Array.isArray(normalized.memory_clusters)) {
    normalized.memory_clusters = normalized.memory_clusters
      .map((cluster) => {
        if (typeof cluster === "string") return { fact: cluster };
        return cluster;
      })
      .filter((cluster) => isRecord(cluster) || typeof cluster === "string");
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
