/**
 * Canonical typed record produced by the unified memory extractor.
 *
 * Each section (event/facts/routes) is independently validatable.
 *
 * [PR2] Quote vs Label split:
 *   - active_threads.topic      -> topic_quote (gated) + topic_label? (free)
 *   - relationship.current_vibe -> current_vibe_quote (gated) + current_vibe_label? (free)
 *     (standalone evidence field dropped; quote is substring of userMessage)
 *   - profile_update.*.value    -> value_quote (gated) + value_label? (free);
 *     evidence field retained (value_quote must appear in evidence,
 *     evidence must appear in userMessage).
 *
 * [PR3a] Focus quote/label split:
 *   - focus.topic_quote is gated to a substring of userMessage; topic_label is free text.
 *     Matches active_threads pattern; fixes 0% live-pass rate caused by paraphrased topics.
 *
 * Behavioral hard gates that need turn context are enforced in router.ts.
 */
import { z } from 'zod';

const ConfidenceSchema = z.number().min(0).max(1);

const EventCategorySchema = z.enum(['memory', 'learning', 'error', 'expression', 'mission', 'none']);
export const EventSchema = z.object({
  ts: z.string().min(1),
  summary: z.string().min(1).max(500),
  attribution: z.string().optional(),
  confidence: ConfidenceSchema,
  categories: z.array(EventCategorySchema),
});

const ProfileFieldSchema = z.object({
  field: z.string().min(1),
  // [PR2] value_quote: verbatim substring that must appear inside `evidence`
  value_quote: z.string().trim().min(1),
  // [PR2] value_label: free-form normalized value (e.g. "上海" vs "Shanghai"); ungated
  value_label: z.union([z.string().trim().min(1), z.number(), z.boolean()]).optional(),
  evidence: z.string().min(4),
});

const ProfileUpdateSchema = z.object({
  basic_info: z.array(ProfileFieldSchema).optional(),
  preferences: z.array(ProfileFieldSchema).optional(),
  significant_memories: z.array(z.object({
    event: z.string().min(1),
    importance: z.number().min(0).max(1),
    date: z.string(),
    evidence: z.string().min(4),
  })).optional(),
}).strict();

const ActiveThreadSchema = z.object({
  // [PR2] topic_quote: verbatim substring of userMessage (hard-gated)
  topic_quote: z.string().trim().min(2),
  // [PR2] topic_label: free-form semantic label; ungated, used for display
  topic_label: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'waiting', 'resolved']),
  next_step: z.string().optional(),
});

const MemoryClusterSchema = z.object({
  fact: z.string().min(1),
  // Verbatim user-message grounding for the cluster. Router hard-gates this
  // against the current user turn so assistant interpretations cannot be
  // promoted into durable user memory.
  evidence: z.string().min(4),
  foresight: z.string().optional(),
  date: z.string().optional(),
  importance_score: z.number().min(0).max(1),
});

/**
 * FocusItem.
 * [PR3a] Quote vs Label split:
 *   - topic_quote: verbatim substring of userMessage (router hard-gate, min 2 chars)
 *   - topic_label: free-form semantic label; ungated, used for display
 *   - priority retained
 *
 * If label is present, quote MUST also be present (omit record rather than label-only).
 */
const FocusItemSchema = z.object({
  topic_quote: z.string().trim().min(2),
  topic_label: z.string().trim().min(1).optional(),
  priority: z.number().min(0).max(10),
}).refine(
  (v) => {
    if (typeof v.topic_label === 'string' && v.topic_label.length > 0) {
      return typeof v.topic_quote === 'string' && v.topic_quote.length >= 2;
    }
    return true;
  },
  { message: 'topic_label without topic_quote' },
);

/**
 * RelationshipUpdate.
 * [PR2] Quote vs Label split:
 *   - current_vibe_quote: verbatim substring of userMessage (router hard-gate)
 *   - current_vibe_label: free-form normalized mood word; ungated display label
 *   - standalone `evidence` field dropped (quote is the substring evidence)
 *   - intimacy_delta still clamped at schema; router re-clamps for defense-in-depth
 */
const RelationshipUpdateSchema = z.object({
  intimacy_delta: z.number().min(-0.05).max(0.05).optional(),
  current_vibe_quote: z.string().trim().min(2).optional(),
  current_vibe_label: z.string().trim().min(1).optional(),
}).refine(
  (v) => {
    // If label is present, quote MUST be present too (omit record entirely rather than label-only).
    if (typeof v.current_vibe_label === 'string' && v.current_vibe_label.length > 0) {
      return typeof v.current_vibe_quote === 'string' && v.current_vibe_quote.length >= 2;
    }
    return true;
  },
  { message: 'current_vibe_label without current_vibe_quote' },
);

export const FactsSchema = z.object({
  profile_update: ProfileUpdateSchema.optional(),
  active_threads: z.array(ActiveThreadSchema).optional(),
  memory_clusters: z.array(MemoryClusterSchema).optional(),
  focus: z.array(FocusItemSchema).optional(),
  relationship: RelationshipUpdateSchema.optional(),
}).strict();

const PendingRuleSchema = z.object({
  content: z.string().min(1),
  reason: z.string().min(1),
  target_files: z.array(z.string()).optional(),
});
const PendingExpressionSchema = z.object({
  signal: z.string().min(1),
  attribution: z.string().optional(),
  content: z.string().min(1),
});
const PendingMissionSchema = PendingExpressionSchema;

export const RoutesSchema = z.object({
  pending_rules: z.array(PendingRuleSchema).optional(),
  expression_pending: z.array(PendingExpressionSchema).optional(),
  mission_pending: z.array(PendingMissionSchema).optional(),
  errors: z.array(z.string().min(1)).optional(),
  learnings: z.array(z.string().min(1)).optional(),
}).strict();

export const UnifiedMemoryExtractionSchema = z.object({
  version: z.literal('v1'),
  event: EventSchema,
  facts: FactsSchema,
  routes: RoutesSchema,
});

export type UnifiedMemoryExtraction = z.infer<typeof UnifiedMemoryExtractionSchema>;
export type UnifiedFacts = z.infer<typeof FactsSchema>;
export type UnifiedRoutes = z.infer<typeof RoutesSchema>;
export type UnifiedEvent = z.infer<typeof EventSchema>;
export type ProfileUpdate = z.infer<typeof ProfileUpdateSchema>;
export type ProfileField = z.infer<typeof ProfileFieldSchema>;
