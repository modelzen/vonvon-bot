import { z } from 'zod';

const httpsUrlSchema = z.string().trim().max(2048).refine(value => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}, '必须是以 https:// 开头的有效网址');

export const TEMPLATE_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,62}(?:\/[a-z0-9][a-z0-9-]{0,62})?$/;

const hhmmSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, '时间格式需为 HH:mm（例如 09:00）');

export const templateScheduleWhenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('daily'), time: hhmmSchema }).strict(),
  z.object({ kind: z.literal('weekly'), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), time: hhmmSchema }).strict(),
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(5).max(1440) }).strict(),
  z.object({ kind: z.literal('cron'), expr: z.string().trim().min(5).max(120) }).strict(),
]);

export const templateScheduleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  when: templateScheduleWhenSchema,
  prompt: z.string().trim().min(1).max(4000),
  enabledByDefault: z.boolean().optional(),
});

export const templateCreditSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: httpsUrlSchema.optional(),
  license: z.string().trim().min(1).max(120).optional(),
});

export const templateAuthorSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: httpsUrlSchema.optional(),
  contact: z.string().trim().min(1).max(120).optional(),
  publicKey: z.string().trim().min(32).max(128).nullable().optional(),
});

export const templatePricingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('free') }).strict(),
  z.object({
    kind: z.literal('external'),
    displayPrice: z.string().trim().min(1).max(40).optional(),
    url: httpsUrlSchema,
  }).strict(),
]);

export const templateSkillSummarySchema = z.object({
  name: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().min(1).max(300).optional(),
});

export const templatePermissionSchema = z.enum(['qa', 'write', 'full']);

export const templateGroupSchema = z.object({
  defaultName: z.string().trim().min(1).max(100).optional(),
  role: z.string().trim().min(1).max(5000).optional(),
  recommendedPermission: templatePermissionSchema.optional(),
  permissionNote: z.string().trim().min(1).max(500).optional(),
  firstMessage: z.string().trim().min(1).max(500).optional(),
  schedules: z.array(templateScheduleSchema).max(20).optional(),
});

/** Backward-compatible read of `vonvon-assistant`'s early `defaults` block (conversation/response are ignored). */
const legacyDefaultsSchema = z.object({
  groupName: z.string().trim().min(1).max(100).optional(),
  permission: templatePermissionSchema.optional(),
  permissionNote: z.string().trim().min(1).max(500).optional(),
  firstMessage: z.string().trim().min(1).max(500).optional(),
}).passthrough();

export const templateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().trim().regex(TEMPLATE_ID_REGEX, 'id 仅允许小写字母、数字、连字符，支持单段或 author/slug 两段格式'),
  version: z.string().trim().min(1).max(40),
  public: z.boolean().optional(),
  name: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(32)).max(12).optional(),
  docUrl: httpsUrlSchema.optional(),
  homepage: httpsUrlSchema.optional(),
  installHint: z.string().trim().min(1).max(300).optional(),
  license: z.string().trim().min(1).max(120).optional(),
  credits: z.array(templateCreditSchema).max(30).optional(),
  author: templateAuthorSchema,
  repository: httpsUrlSchema.optional(),
  acquisition: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  pricing: templatePricingSchema.optional(),
  compatibility: z.object({
    vonvonMinVersion: z.string().trim().min(1).max(40).optional(),
    providers: z.array(z.string().trim().min(1).max(40)).max(16).optional(),
    platforms: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  }).passthrough().optional(),
  prerequisites: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
  group: templateGroupSchema.optional(),
  defaults: legacyDefaultsSchema.optional(),
  skills: z.array(templateSkillSummarySchema).max(50).optional(),
  promoSignature: z.string().trim().min(32).max(256).optional(),
}).passthrough();

export type TemplateManifest = z.infer<typeof templateManifestSchema>;
export type TemplateSchedule = z.infer<typeof templateScheduleSchema>;
export type TemplateGroupSpec = z.infer<typeof templateGroupSchema>;
export type TemplatePricing = z.infer<typeof templatePricingSchema>;

/** Missing `public` strictly defaults to `false` so private/internal templates never leak. */
export function isPublicTemplate(manifest: Pick<TemplateManifest, 'public'>): boolean {
  return manifest.public === true;
}

export function effectiveDocUrl(manifest: Pick<TemplateManifest, 'docUrl' | 'homepage' | 'repository'>): string | undefined {
  return manifest.docUrl ?? manifest.homepage ?? manifest.repository;
}

export function effectiveGroupSpec(manifest: TemplateManifest): TemplateGroupSpec {
  const g = manifest.group;
  const legacy = manifest.defaults;
  return {
    ...(g?.defaultName ?? legacy?.groupName ? { defaultName: g?.defaultName ?? legacy?.groupName } : {}),
    ...(g?.role ? { role: g.role } : {}),
    ...(g?.recommendedPermission ?? legacy?.permission ? { recommendedPermission: g?.recommendedPermission ?? legacy?.permission } : {}),
    ...(g?.permissionNote ?? legacy?.permissionNote ? { permissionNote: g?.permissionNote ?? legacy?.permissionNote } : {}),
    ...(g?.firstMessage ?? legacy?.firstMessage ? { firstMessage: g?.firstMessage ?? legacy?.firstMessage } : {}),
    ...(g?.schedules?.length ? { schedules: g.schedules } : {}),
  };
}

export function effectivePricing(manifest: Pick<TemplateManifest, 'pricing'>): TemplatePricing {
  return manifest.pricing ?? { kind: 'free' };
}

export function effectiveAcquisition(manifest: Pick<TemplateManifest, 'acquisition'>): string[] {
  const deduped = [...new Set((manifest.acquisition ?? []).map(v => v.trim()).filter(Boolean))].slice(0, 10);
  return deduped.length ? deduped : ['local'];
}

export interface PublicPromoPayload {
  schemaVersion: 1;
  /** Explicit signed publication grant — private templates (`public: false`) never carry a publication signature. */
  public: true;
  id: string;
  version: string;
  name: string;
  summary: string;
  tags: string[];
  skillNames: string[];
  docUrl?: string;
  installHint?: string;
  repository?: string;
  author: {
    name: string;
    url?: string;
    contact?: string;
    publicKey: string;
  };
  pricing: TemplatePricing;
  acquisition: string[];
}

/**
 * Deterministic canonical JSON payload of ONLY public promotional metadata (zero skill bodies,
 * zero prompts, zero workspace files). Used for both Ed25519 signing and verification.
 */
export function buildPublicPromoPayload(
  manifest: TemplateManifest,
  discoveredSkillNames: readonly string[],
  publicKeyOverride?: string,
): PublicPromoPayload {
  const publicKey = (publicKeyOverride ?? manifest.author.publicKey ?? '').trim();
  const skillNames = [...new Set([
    ...discoveredSkillNames,
    ...(manifest.skills?.map(s => s.name) ?? []),
  ].map(s => s.trim()).filter(s => s.length > 0 && s.length <= 64))].sort().slice(0, 50);
  const tags = [...new Set((manifest.tags ?? []).map(t => t.trim()).filter(t => t.length > 0 && t.length <= 32))]
    .sort()
    .slice(0, 12);
  const docUrl = effectiveDocUrl(manifest);
  return {
    schemaVersion: 1,
    public: true,
    id: manifest.id.trim(),
    version: manifest.version.trim(),
    name: manifest.name.trim(),
    summary: manifest.summary.trim(),
    tags,
    skillNames,
    ...(docUrl ? { docUrl: docUrl.trim() } : {}),
    ...(manifest.installHint ? { installHint: manifest.installHint.trim() } : {}),
    ...(manifest.repository ? { repository: manifest.repository.trim() } : {}),
    author: {
      name: manifest.author.name.trim(),
      ...(manifest.author.url ? { url: manifest.author.url.trim() } : {}),
      ...(manifest.author.contact ? { contact: manifest.author.contact.trim() } : {}),
      publicKey,
    },
    pricing: effectivePricing(manifest),
    acquisition: effectiveAcquisition(manifest),
  };
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const next = (value as Record<string, unknown>)[key];
      if (next !== undefined) out[key] = sortDeep(next);
    }
    return out;
  }
  return value;
}

export function canonicalPromoBytes(payload: PublicPromoPayload): Buffer {
  return Buffer.from(`vonvon-template-promo/1\n${JSON.stringify(sortDeep(payload))}`, 'utf8');
}

export const installedTemplateRecordSchema = z.object({
  id: z.string().min(1),
  authorPublicKey: z.string().optional(),
  version: z.string().min(1),
  sourceUrl: z.string().optional(),
  docUrl: z.string().optional(),
  skills: z.array(z.string()),
  installedAt: z.string().min(1),
});

export const installedTemplatesFileSchema = z.object({
  schemaVersion: z.literal(1),
  templates: z.array(installedTemplateRecordSchema),
});

export type InstalledTemplateRecord = z.infer<typeof installedTemplateRecordSchema>;
export type InstalledTemplatesFile = z.infer<typeof installedTemplatesFileSchema>;
