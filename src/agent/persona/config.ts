import { z } from 'zod';

export const PersonaStyleSchema = z.object({
  language: z.enum(['auto', 'zh', 'en']).optional(),
  tone: z.string().optional(),
  verbosity: z.enum(['concise', 'balanced', 'detailed']).optional(),
});

export const PersonaProfileSchema = z.object({
  /** Display name the assistant should answer as. */
  name: z.string().optional(),
  /** Free-form visible identity, e.g. "technical partner" or "desktop companion". */
  identity: z.string().optional(),
  /** What this persona is responsible for in the relationship with the user. */
  role: z.string().optional(),
  /** Personality traits. When provided, replaces the generated trait list. */
  traits: z.array(z.string()).optional(),
  /** Response style preferences for the persona layer. */
  style: PersonaStyleSchema.optional(),
  /** Hard persona-specific behavioral rules. */
  rules: z.array(z.string()).optional(),
});

export const PersonaConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Active agent name used for agent-scoped persona selection. */
  agentName: z.string().optional(),
  /** Runtime user id copied into the agent-scoped persona store for diagnostics. */
  userId: z.string().optional(),
  /** Current persona profile override for this user + agent scope. */
  profile: PersonaProfileSchema.optional(),
  /** Optional advanced template rendered by buildPersonaPrompt(). */
  template: z.string().optional(),
});

export type PersonaStyleConfig = z.infer<typeof PersonaStyleSchema>;
export type PersonaProfile = z.infer<typeof PersonaProfileSchema>;
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;
