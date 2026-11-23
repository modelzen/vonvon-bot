import {z} from 'zod';

const id = z.string().uuid();
const revision = z.number().int().positive().max(2147483647);
const wellFormed = (value: string) => !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const text = (max: number) => z.string().max(max * 2).refine(value => wellFormed(value) && Array.from(value).length <= max);
const bytes = (max: number) => z.string().max(max).refine(value => wellFormed(value) && new TextEncoder().encode(value).byteLength <= max);
export const recipePublicSchema = z.object({name: text(60), summary: text(240), overview: bytes(32768), version: text(40), access: z.enum(['direct', 'coded'])}).strict();
export const recipeConfigSchema = z.object({role: bytes(16384), setup: z.object({steps: z.array(z.object({kind: z.enum(['config','tool','context']), title: text(80), instructions: bytes(2048), required: z.boolean(), check: bytes(512).optional()}).strict()).min(1).max(8)}).strict().optional()}).strict();
export type RecipeConfig = z.infer<typeof recipeConfigSchema>;
export type RecipePublic = z.infer<typeof recipePublicSchema>;
const summary = z.object({recipeId: id, versionId: id, revision, public: recipePublicSchema.partial({summary: true, overview: true})}).strict();
export const recipeSummarySchema = summary;
export type RecipeSummary = z.infer<typeof summary>;
export const recipeDetailSchema = summary.extend({public: recipePublicSchema, owned: z.boolean(), acquired: z.boolean(), config: recipeConfigSchema.optional()}).strict().superRefine((value, ctx) => {
  const permitted = value.owned || value.acquired || value.public.access === 'direct';
  if (Boolean(value.config) !== permitted) ctx.addIssue({code: 'custom', message: 'Invalid configuration visibility'});
});
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;
export const recipeDraftSchema = z.object({draftId: id, recipeId: id.nullable(), revision, public: recipePublicSchema, config: recipeConfigSchema}).strict();
export type RecipeDraft = z.infer<typeof recipeDraftSchema>;
const version = {recipeId: id, versionId: id};
const request = {requestId: id};
const privateRequest = {accountId: id};
const page = {cursor: id.optional()};
const changes = {public: recipePublicSchema, config: recipeConfigSchema};
export const communityRequestSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('shareLink'), ...version}).strict(),
  z.object({type: z.literal('catalog'), accountId: id.optional(), query: text(120).optional(), ...page}).strict(),
  z.object({type: z.literal('detail'), accountId: id.optional(), ...version}).strict(),
  z.object({type: z.literal('library'), ...privateRequest, ...page}).strict(),
  z.object({type: z.literal('drafts'), ...privateRequest}).strict(),
  z.object({type: z.literal('publications'), ...privateRequest}).strict(),
  z.object({type: z.literal('draft'), ...privateRequest, draftId: id}).strict(),
  z.object({type: z.literal('saveDraft'), ...privateRequest, ...request, ...changes, target: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('new'), source: z.object(version).strict().optional()}).strict(),
    z.object({kind: z.literal('existing'), draftId: id, revision}).strict(),
  ])}).strict(),
  z.object({type: z.literal('deleteDraft'), ...privateRequest, ...request, draftId: id, revision}).strict(),
  z.object({type: z.literal('publishDraft'), ...privateRequest, ...request, draftId: id, revision}).strict(),
  z.object({type: z.literal('acquire'), ...privateRequest, ...request, versionId: id, code: z.string().regex(/^[a-z0-9-]{1,128}$/i).optional()}).strict(),
  z.object({type: z.literal('codes'), ...privateRequest, versionId: id, ...page}).strict(),
  z.object({type: z.literal('issueCodes'), ...privateRequest, ...request, versionId: id, count: z.number().int().min(1).max(100)}).strict(),
  z.object({type: z.literal('disableCode'), ...privateRequest, ...request, codeId: id}).strict(),
  z.object({type: z.literal('revealCode'), ...privateRequest, ...request, codeId: id}).strict(),
]);
export type CommunityRequest = z.infer<typeof communityRequestSchema>;
const nextCursor = id.nullable();
const codeState = z.enum(['available', 'redeemed', 'disabled']);
const fullCode = z.object({codeId: id, status: z.literal('available'), code: z.string().regex(/^[A-F0-9-]{32,40}$/i)}).strict();
export const communityResponseSchemas = {
  shareLink: z.object({url: z.string().url().max(2048)}).strict(),
  catalog: z.object({hero: summary.nullable(), items: z.array(summary).max(8), nextCursor}).strict(),
  detail: recipeDetailSchema,
  library: z.object({items: z.array(summary).max(50), nextCursor}).strict(),
  drafts: z.object({items: z.array(recipeDraftSchema).max(1000)}).strict(),
  publications: z.object({items: z.array(summary).max(1000)}).strict(),
  draft: recipeDraftSchema,
  saveDraft: recipeDraftSchema,
  deleteDraft: z.object({draftId: id, deleted: z.literal(true)}).strict(),
  publishDraft: summary.extend({public: recipePublicSchema, firstCode: z.string().regex(/^[A-F0-9-]{32,40}$/i).optional()}).strict(),
  acquire: z.object({...version, owned: z.boolean(), acquired: z.boolean()}).strict(),
  codes: z.object({items: z.array(z.object({codeId: id, suffix: text(8), status: codeState, redeemedAt: z.string().datetime({offset: true}).nullable()}).strict()).max(50), nextCursor}).strict(),
  issueCodes: z.object({items: z.array(z.discriminatedUnion('status', [fullCode,
    z.object({codeId: id, status: z.literal('redeemed')}).strict(),
    z.object({codeId: id, status: z.literal('disabled')}).strict(),
  ])).max(100)}).strict(),
  disableCode: z.object({codeId: id, status: z.literal('disabled')}).strict(),
  revealCode: fullCode,
};
export type CommunityResponses = {[K in keyof typeof communityResponseSchemas]: z.infer<(typeof communityResponseSchemas)[K]>};
export interface CommunityShell {
  request<T extends CommunityRequest['type']>(request: Extract<CommunityRequest, {type: T}>): Promise<CommunityResponses[T]>;
}

export const communityFailureMessages = {
  conflict: '内容已在其他地方变更。请重新读取后再确认，你的输入仍保留。',
  invalid_code: '分享码不可用，请核对后重试。', forbidden: '当前账号不能进行这项操作。',
  auth_required: '请重新登录。', quota_exceeded: '已达到账号或版本限额，请检查内容后重试。',
  incomplete_setup: '请补全使用前准备步骤的名称和说明。', credential_detected: '内容中可能含有密钥或令牌，请移除后重试。',
  invalid_input: '请检查输入内容、长度和获取方式。',
  not_found: '没有找到这份配方或草稿。', rate_limited: '操作过于频繁，请稍后再试。',
} as const;
