/**
 * memware kernel — /extract request, model-output and response schemas.
 *
 * Contract source of truth: contracts/kernel.v1.json (handoff N7 / §5 of the
 * ZBuddy cross-device sync requirements). These zod schemas are the executable
 * mirror: requests are validated at the HTTP boundary, and the model's raw JSON
 * is validated before anything downstream trusts its shape.
 *
 * Changing any semantics here means bumping `extractorVersion`.
 */

import { z } from "zod";

/** The three first-version fact categories (handoff §5.1). Open set server-side. */
export const FactCategories = ["preference", "fact", "conclusion"] as const;
export type KernelFactCategory = (typeof FactCategories)[number];

/** Entity type used when the model does not name one. */
export const DEFAULT_ENTITY_TYPE = "unknown";
/** The only edge type the kernel emits (handoff §5.1 MemoryEdge). */
export const MEMORY_MENTIONS_ENTITY = "memory_mentions_entity";

// ── Request ──────────────────────────────────────────────────

const MessageSchema = z.object({
  messageId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  sentAt: z.number().optional(),
});

const ConversationSchema = z.object({
  conversationId: z.string().min(1),
  messages: z.array(MessageSchema).min(1),
});

const KnownEntitySchema = z.object({
  entityId: z.string().min(1),
  canonicalName: z.string().min(1),
  entityType: z.string().min(1),
  aliases: z.array(z.string()).optional(),
});

export const ExtractRequestSchema = z.object({
  /** Tenant isolation id. Used for logging only — never sent to the model. */
  userId: z.string().min(1),
  conversations: z.array(ConversationSchema).min(1),
  knownEntities: z.array(KnownEntitySchema).optional(),
  /** sha256 fingerprints of memories the user deleted; matches are dropped. */
  suppressedFingerprints: z.array(z.string()).optional(),
});

export type ExtractRequest = z.infer<typeof ExtractRequestSchema>;
export type KernelMessage = z.infer<typeof MessageSchema>;
export type KnownEntity = z.infer<typeof KnownEntitySchema>;

// ── Raw model output ─────────────────────────────────────────

/** Exactly what extractPrompt.ts asks the model to return. */
export const ExtractorOutputSchema = z.object({
  facts: z
    .array(
      z.object({
        content: z.string().min(1),
        category: z.enum(FactCategories),
        confidence: z.number().min(0).max(1),
        messageIds: z.array(z.string().min(1)).min(1),
        entities: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  entities: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.string().optional(),
        aliases: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export type ExtractorOutput = z.infer<typeof ExtractorOutputSchema>;

// ── Response ─────────────────────────────────────────────────

const SourceRefSchema = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});

const KernelFactSchema = z.object({
  content: z.string().min(1),
  category: z.enum(FactCategories),
  confidence: z.number().min(0).max(1),
  sourceRefs: z.array(SourceRefSchema).min(1),
  /** sha256 of the normalised content — the backend's dedup/suppression key. */
  fingerprint: z.string().min(1),
  entityNames: z.array(z.string()),
});

const KernelEntitySchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  aliases: z.array(z.string()),
});

const KernelEdgeSchema = z.object({
  /** Index into the response's own `facts` array. */
  factIndex: z.number().int().min(0),
  entityName: z.string().min(1),
  edgeType: z.literal(MEMORY_MENTIONS_ENTITY),
});

export const ExtractResponseSchema = z.object({
  extractorVersion: z.string().min(1),
  facts: z.array(KernelFactSchema),
  entities: z.array(KernelEntitySchema),
  edges: z.array(KernelEdgeSchema),
});

export type KernelFact = z.infer<typeof KernelFactSchema>;
export type KernelEntity = z.infer<typeof KernelEntitySchema>;
export type KernelEdge = z.infer<typeof KernelEdgeSchema>;
export type ExtractResponse = z.infer<typeof ExtractResponseSchema>;
