/**
 * avatanel — Egress profile policy
 *
 * Egress profiles describe business-owned outbound read/delivery lanes. They
 * authorize host boundaries, not a blanket bypass of URL destination safety.
 */

import { z } from 'zod';

export const FAKE_IP_RANGE_198_18 = '198.18.0.0/15' as const;

export const BuiltinEgressProfileIdSchema = z.enum([
  'social_public_read',
  'public_web_read',
  'wechat_public_read',
  'publisher_draft_delivery',
  'local_provider',
]);

export type BuiltinEgressProfileId = z.infer<typeof BuiltinEgressProfileIdSchema>;
export type EgressProfileId = BuiltinEgressProfileId | (string & {});

const UrlSchemeSchema = z.enum(['http:', 'https:']);
const ReservedIpExceptionSchema = z.literal(FAKE_IP_RANGE_198_18);

export const EgressProfileSchema = z.object({
  enabled: z.boolean().optional(),
  description: z.string().trim().optional(),
  hosts: z.array(z.string().trim().min(1)).optional(),
  allowedSchemes: z.array(UrlSchemeSchema).optional(),
  allowedReservedIpRanges: z.array(ReservedIpExceptionSchema).optional(),
}).strict();

export const EgressProfilesSchema = z.record(EgressProfileSchema).default({});

export interface EgressProfilePolicy {
  enabled: boolean;
  description?: string;
  hosts: string[];
  allowedSchemes: Array<'http:' | 'https:'>;
  allowedReservedIpRanges: Array<typeof FAKE_IP_RANGE_198_18>;
}
export type EgressProfilesConfig = z.infer<typeof EgressProfilesSchema>;

export const BUILTIN_EGRESS_PROFILES: Record<BuiltinEgressProfileId, EgressProfilePolicy> = {
  social_public_read: {
    enabled: true,
    description: 'Public social source reads for X/Twitter and fixed reader endpoints.',
    hosts: [
      'x.com',
      'twitter.com',
      'fxtwitter.com',
      'api.fxtwitter.com',
      'vxtwitter.com',
      'api.vxtwitter.com',
      'publish.twitter.com',
      'cdn.syndication.twimg.com',
      'r.jina.ai',
    ],
    allowedSchemes: ['https:'],
    allowedReservedIpRanges: [FAKE_IP_RANGE_198_18],
  },
  public_web_read: {
    enabled: true,
    description: 'Generic public web page reads.',
    hosts: ['*'],
    allowedSchemes: ['http:', 'https:'],
    allowedReservedIpRanges: [],
  },
  wechat_public_read: {
    enabled: true,
    description: 'WeChat Official Account public articles and public media CDN reads.',
    hosts: [
      'mp.weixin.qq.com',
      'weixin.qq.com',
      'res.wx.qq.com',
      'mmbiz.qpic.cn',
      'mmbiz.qlogo.cn',
      '*.mmbiz.qpic.cn',
      '*.mmbiz.qlogo.cn',
    ],
    allowedSchemes: ['https:'],
    allowedReservedIpRanges: [FAKE_IP_RANGE_198_18],
  },
  publisher_draft_delivery: {
    enabled: false,
    description: 'Publisher draft delivery endpoints. Must be enabled explicitly by the host.',
    hosts: [
      'api.weixin.qq.com',
      'mp.weixin.qq.com',
    ],
    allowedSchemes: ['https:'],
    allowedReservedIpRanges: [],
  },
  local_provider: {
    enabled: false,
    description: 'Operator-owned local provider destinations. Prefer trustedNetworkAllowlist for legacy compatibility.',
    hosts: [],
    allowedSchemes: ['http:', 'https:'],
    allowedReservedIpRanges: [],
  },
};

export function resolveEgressProfiles(config: EgressProfilesConfig | undefined): Record<string, EgressProfilePolicy> {
  const overrides = EgressProfilesSchema.parse(config ?? {});
  const merged: Record<string, EgressProfilePolicy> = {};

  for (const [id, profile] of Object.entries(BUILTIN_EGRESS_PROFILES)) {
    merged[id] = { ...profile, hosts: [...profile.hosts], allowedSchemes: [...profile.allowedSchemes], allowedReservedIpRanges: [...profile.allowedReservedIpRanges] };
  }

  for (const [id, override] of Object.entries(overrides)) {
    const base = merged[id];
    merged[id] = base
      ? {
          ...base,
          ...(override.enabled !== undefined ? { enabled: override.enabled } : {}),
          ...(override.description !== undefined ? { description: override.description } : {}),
          hosts: override.hosts !== undefined ? [...override.hosts] : [...base.hosts],
          allowedSchemes: override.allowedSchemes !== undefined ? [...override.allowedSchemes] : [...base.allowedSchemes],
          allowedReservedIpRanges: override.allowedReservedIpRanges !== undefined
            ? [...override.allowedReservedIpRanges]
            : [...base.allowedReservedIpRanges],
        }
      : {
          enabled: override.enabled ?? true,
          ...(override.description !== undefined ? { description: override.description } : {}),
          hosts: [...(override.hosts ?? [])],
          allowedSchemes: [...(override.allowedSchemes ?? ['https:'])],
          allowedReservedIpRanges: [...(override.allowedReservedIpRanges ?? [])],
        };
  }

  return merged;
}
