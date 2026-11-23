import {z} from 'zod';
import {recipeRichContentSchema} from './recipe-rich.js';

const id = z.string().uuid();
export const acquisitionKeySchema = z.string().regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|a2\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
export function newRichMetadataRequestId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let n = 5; n >= 0; n--) {bytes[n] = time % 256; time = Math.floor(time / 256);}
  bytes[6] = 0x70 | (bytes[6]! & 15); bytes[8] = 0x80 | (bytes[8]! & 63);
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function newAcquisitionKey(now = Date.now()): string {return 'a2.' + newRichMetadataRequestId(now);}
const revision = z.number().int().positive().max(2147483647);
const wellFormed = (value: string) => !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
const text = (max: number) => z.string().max(max * 2).refine(value => wellFormed(value) && Array.from(value).length <= max);
const bytes = (max: number) => z.string().max(max).refine(value => wellFormed(value) && new TextEncoder().encode(value).byteLength <= max);
export const recipePublicSchema = z.object({name: text(60), summary: text(240), overview: bytes(32768), version: text(40), access: z.enum(['direct', 'coded'])}).strict();
export const recipeConfigSchema = z.object({role: bytes(16384), setup: z.object({steps: z.array(z.object({kind: z.enum(['config','tool','context']), title: text(80), instructions: bytes(2048), required: z.boolean(), check: bytes(512).optional()}).strict()).min(1).max(8)}).strict().optional()}).strict();
export type RecipeConfig = z.infer<typeof recipeConfigSchema>;
export type RecipePublic = z.infer<typeof recipePublicSchema>;
const creator = z.object({authorId:id,displayName:text(60).refine(value=>Boolean(value.trim())&&!/@/.test(value))}).strict();
const richView = z.object({content: recipeRichContentSchema, texts: z.record(id, bytes(131072)), canonical: z.string().max(1401000)}).strict();
const display = {format: z.enum(['role-v1','rich-v2']).optional(), creator: creator.optional(), hasDisplayLogo: z.boolean().optional(), logo: z.string().max(180000).regex(/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/).optional()};
const summary = z.object({recipeId: id, versionId: id, revision, public: recipePublicSchema.partial({summary: true, overview: true}), ...display}).strict();
export const recipeSummarySchema = summary;
export type RecipeSummary = z.infer<typeof summary>;
export const recipeDetailSchema = summary.extend({public: recipePublicSchema, owned: z.boolean(), acquired: z.boolean(), config: recipeConfigSchema.optional(), rich: richView.optional()}).strict().superRefine((value, ctx) => {
  const permitted = value.owned || value.acquired || value.public.access === 'direct';
  if(value.format==='rich-v2'&&(Boolean(value.rich)!==permitted||Boolean(value.config)))ctx.addIssue({code:'custom',message:'Invalid rich configuration visibility'});
  if(value.rich&&value.format!=='rich-v2')ctx.addIssue({code:'custom',message:'Missing rich format'});
  if (Boolean(value.config || value.rich) !== permitted) ctx.addIssue({code: 'custom', message: 'Invalid configuration visibility'});
});
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;
const draftIdentity={draftId:id,recipeId:id.nullable(),revision,public:recipePublicSchema};
export const recipeRoleDraftSchema=z.object({...draftIdentity,format:z.literal('role-v1').optional(),config:recipeConfigSchema,rich:z.undefined().optional(),logo:z.undefined().optional(),sourceIntentId:z.undefined().optional()}).strict();
export const recipeRichDraftSchema=z.object({...draftIdentity,format:z.literal('rich-v2'),rich:richView,config:z.undefined().optional(),logo:display.logo,sourceIntentId:id}).strict();
export const recipeDraftSchema=z.discriminatedUnion('format',[recipeRoleDraftSchema,recipeRichDraftSchema]);
export type RecipeDraft=z.infer<typeof recipeDraftSchema>;
export type RecipeRoleDraft=z.infer<typeof recipeRoleDraftSchema>;
export type RecipeRichDraft=z.infer<typeof recipeRichDraftSchema>;

const version = {recipeId: id, versionId: id};
const request = {requestId: id};
const privateRequest = {accountId: id};
const page={cursor:id.optional()};
const catalogPage={cursor:z.string().min(1).max(1600).optional()};
const manifestSha = z.string().regex(/^[a-f0-9]{64}$/);
const metadataRequestId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const richMetadataRequestSchema = z.object({
  type:z.literal('saveRichDraftMetadata'), ...privateRequest, requestId:metadataRequestId, draftId:id, revision,
  baseManifestSha256:manifestSha, public:recipePublicSchema, logo:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('keep')}).strict(), z.object({kind:z.literal('remove')}).strict(),
    z.object({kind:z.literal('replace'),base64:z.string().min(4).max(2796204).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict(),
  ]),
}).strict();
export type RichMetadataRequest = z.infer<typeof richMetadataRequestSchema>;
export const richMetadataReceiptSchema = z.object({requestId:metadataRequestId,draftId:id,revision,manifestSha256:manifestSha}).strict();
const changes = {public: recipePublicSchema, config: recipeConfigSchema};
export const communityRequestSchema = z.discriminatedUnion('type', [
  richMetadataRequestSchema,
  z.object({type:z.literal('recoverRichDraftMetadata'),...privateRequest,draftId:id}).strict(),
  z.object({type: z.literal('shareLink'), ...version}).strict(),
  z.object({type: z.literal('catalog'), accountId: id.optional(), query: text(120).optional(), ...catalogPage}).strict(),
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
  z.object({type:z.literal('publishDraft'),...privateRequest,...request,draftId:id,revision,format:z.literal('rich-v2').optional(),canonical:z.string().min(1).max(1401000).regex(/^[A-Za-z0-9_-]+$/).optional()}).strict(),
  z.object({type: z.literal('acquire'), ...privateRequest, requestId: acquisitionKeySchema, versionId: id, code: z.string().regex(/^[a-z0-9-]{1,128}$/i).optional()}).strict(),
  z.object({type: z.literal('codes'), ...privateRequest, versionId: id, ...page}).strict(),
  z.object({type: z.literal('issueCodes'), ...privateRequest, ...request, versionId: id, count: z.number().int().min(1).max(100)}).strict(),
  z.object({type: z.literal('disableCode'), ...privateRequest, ...request, codeId: id}).strict(),
  z.object({type: z.literal('revealCode'), ...privateRequest, ...request, codeId: id}).strict(),
]);
export type CommunityRequest = z.infer<typeof communityRequestSchema>;
const nextCursor=id.nullable();
const catalogNextCursor=z.string().min(1).max(1600).nullable();
const codeState = z.enum(['available', 'redeemed', 'disabled']);
const fullCode = z.object({codeId: id, status: z.literal('available'), code: z.string().regex(/^[A-F0-9-]{32,40}$/i)}).strict();
const richMetadataOutcomeSchema = z.discriminatedUnion('status',[
    z.object({status:z.literal('committed'),receipt:richMetadataReceiptSchema,draft:recipeRichDraftSchema.optional()}).strict(),
    z.object({status:z.literal('rejected'),code:z.enum(['conflict','operation_expired','operation_clock_skew','session_changed','auth_required','account_disabled','forbidden','quota_exceeded','credential_detected','invalid_input','not_found','rate_limited','source_unavailable','object_capacity','invalid_logo'])}).strict(),
    z.object({status:z.literal('uncertain')}).strict(),
  ]);
export const communityResponseSchemas = {
  saveRichDraftMetadata:richMetadataOutcomeSchema,
  recoverRichDraftMetadata:z.union([z.object({status:z.literal('current'),draft:recipeRichDraftSchema}).strict(),richMetadataOutcomeSchema]),
  shareLink: z.object({url: z.string().url().max(2048)}).strict(),
  catalog: z.object({heroKind:z.enum(['featured','latest']).nullable().optional(),hero: summary.nullable(), items: z.array(summary).max(8), nextCursor:catalogNextCursor}).strict(),
  detail: recipeDetailSchema,
  library: z.object({items: z.array(summary).max(50), nextCursor}).strict(),
  drafts: z.object({items: z.array(z.union([recipeDraftSchema,z.object({format:z.literal('rich-v2'),draftId:id,recipeId:id.nullable(),revision,public:recipePublicSchema}).strict()])).max(1000)}).strict(),
  publications: z.object({items: z.array(summary).max(1000)}).strict(),
  draft: recipeDraftSchema,
  saveDraft: recipeRoleDraftSchema,
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
export const acquisitionFailureSchema = z.object({
  code: z.enum(['operation_expired', 'operation_clock_skew', 'request_upgrade_required', 'acquire_rate_limited', 'rate_limited', 'invalid_code', 'conflict', 'auth_required', 'account_disabled', 'session_changed', 'unavailable']),
  retryAfter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type AcquisitionFailure = z.infer<typeof acquisitionFailureSchema>;
export type AcquisitionOutcome = {ok: true; value: CommunityResponses['acquire']} | {ok: false; error: AcquisitionFailure};
export interface CommunityShell {
  request<T extends CommunityRequest['type']>(request: Extract<CommunityRequest, {type: T}>): Promise<T extends 'acquire' ? AcquisitionOutcome : CommunityResponses[T]>;
}

export const communityFailureMessages = {
  invalid_logo: '图片未通过校验，请选择其他图片。', source_unavailable: '这项内容的来源已不可用。', object_capacity: '临时上传空间已满，请稍后重试。',
  conflict: '内容已在其他地方变更。请重新读取后再确认，你的输入仍保留。',
  operation_expired: '本次领取操作已过期。请先确认获取结果，再重新提交。',
  operation_clock_skew: '设备时间与服务端不一致，请校准设备时间后重试。',
  request_upgrade_required: '请更新应用后重新确认获取结果。',
  acquire_rate_limited: '今天的领取操作已达上限，请保留输入，稍后重试。',
  session_changed: '账号已切换，请重新打开社区。',
  unavailable: '获取结果暂未确认，请重试同一操作。',
  invalid_code: '分享码不可用，请核对后重试。', forbidden: '当前账号不能进行这项操作。',
  account_disabled: '当前账号已停用，请联系管理员。',
  auth_required: '请重新登录。', quota_exceeded: '已达到账号或版本限额，请检查内容后重试。',
  incomplete_setup: '请补全使用前准备步骤的名称和说明。', credential_detected: '内容中可能含有密钥或令牌，请移除后重试。',
  invalid_input: '请检查输入内容、长度和获取方式。',
  not_found: '没有找到这份配方或草稿。', rate_limited: '操作过于频繁，请稍后再试。',
} as const;
