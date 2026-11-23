import {resourceReadTaskSchema,resourceAcquireTaskSchema,verifiedResourceSnapshotSchema,resourceLatestSchema,acquisitionOutcomeSchema,exactResourceVersionSchema} from './recipe-resource-context.js';
import {recipeBrowseDetailSchema} from './recipe-browse.js';
import {z} from 'zod';
import {agentIdSchema, groupIdSchema} from './domain.js';
import {recipePublicSchema} from './desktop-community.js';
import {recipeRichContentSchema, recipeRichPartDescriptorSchema, recipeRichOriginEdgeSchema} from './recipe-rich.js';
import {richPreparationSchema} from './recipe-rich-authoring.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(2147483647);
const ordinal = z.number().int().min(0).max(8191);
const cursor = uuid.nullable();
const canonical = z.string().min(1).max(1401000).regex(/^[A-Za-z0-9_-]+$/);
const recipient = z.object({openId:z.string().regex(/^ou_[\w-]{1,200}$/),chatId:groupIdSchema,tenantKey:z.string().min(1).max(200)}).strict();
export const inheritedPublicationSchema = z.object({accountId:uuid,versionId:uuid,public:z.object({name:recipeRichContentSchema.shape.public.shape.name.shape.value,summary:recipeRichContentSchema.shape.public.shape.summary.shape.value,overview:recipeRichContentSchema.shape.public.shape.overview.shape.value,version:z.literal('')}).strict(),access:z.enum(['direct','coded']),logo:richPreparationSchema.shape.logo}).strict();
export type InheritedPublication = z.infer<typeof inheritedPublicationSchema>;
export const creatorWorkSchema = z.object({
  draftId:uuid, source:z.object({preparationId:uuid, groupId:groupIdSchema, identity:digest}).strict().nullable(),
}).strict();
export type CreatorWork = z.infer<typeof creatorWorkSchema>;
const version = z.object({recipeId:uuid, versionId:uuid}).strict();
export type CreatorVersion = z.infer<typeof version>;
const label = {name:recipePublicSchema.shape.name,version:recipePublicSchema.shape.version};
const selection = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('draft'), work:creatorWorkSchema, ...label}).strict(),
  z.object({kind:z.literal('version'), target:version, ...label}).strict(),
]);
export type CreatorSelection = z.infer<typeof selection>;
export const creatorSnapshotSchema = z.object({
  work:creatorWorkSchema, format:z.enum(['role-v1','rich-v2']), recipeId:uuid.nullable(), parent:version.nullable(),
  revision:positive, public:recipePublicSchema, contentSha256:digest, parts:recipeRichPartDescriptorSchema.array().max(194),
  sections:z.array(z.object({title:z.string().min(1).max(128), pageHashes:digest.array().min(1).max(2048)}).strict()).min(1).max(16),
  appPreviewUrl:z.string().url().max(2048).refine(value=>{
    const url=new URL(value);
    return !url.username&&!url.password&&!url.search&&
      (url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))&&
      url.pathname==='/open/draft'&&/^#[0-9a-f-]{36}\?revision=[1-9][0-9]*$/.test(url.hash);
  }).optional(),
}).strict().refine(s => s.format === 'role-v1' || s.work.source !== null);
export type CreatorSnapshot = z.infer<typeof creatorSnapshotSchema>;
const read = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('works'),offset:ordinal,draftsOnly:z.literal(true).optional()}).strict(),
  z.object({kind:z.literal('draft'),work:creatorWorkSchema}).strict(),
  z.object({kind:z.literal('openPreview'),work:creatorWorkSchema,snapshotDigest:digest}).strict(),
  z.object({kind:z.literal('page'),work:creatorWorkSchema,snapshotDigest:digest,section:ordinal,page:ordinal}).strict(),
  z.object({kind:z.literal('codes'),target:version,cursor}).strict(),
  z.object({kind:z.literal('parent'),target:version}).strict(),
  z.object({kind:z.literal('edit'),work:creatorWorkSchema,revision:positive}).strict(),
]);
export type CreatorRead = z.infer<typeof read>;
const change = z.union([
  z.object({field:z.literal('name'),value:recipePublicSchema.shape.name}).strict(),
  z.object({field:z.literal('version'),value:recipePublicSchema.shape.version}).strict(),
  z.object({field:z.literal('summary'),value:recipePublicSchema.shape.summary}).strict(),
  z.object({field:z.literal('overview'),value:recipePublicSchema.shape.overview}).strict(),
  z.object({field:z.literal('access'),value:recipePublicSchema.shape.access}).strict(),
  z.object({field:z.literal('logo'),value:z.literal('remove')}).strict(),
  z.object({field:z.literal('logo'),value:z.literal('attachment'),sha256:digest}).strict(),
]);
export const creatorCommandSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('publish'),snapshotDigest:digest,snapshot:creatorSnapshotSchema}).strict(),
  z.object({kind:z.literal('metadata'),work:creatorWorkSchema,revision:positive,baseSha256:digest,change}).strict(),
  z.object({kind:z.literal('discard'),work:creatorWorkSchema,revision:positive}).strict(),
  z.object({kind:z.literal('withdraw'),target:version}).strict(),
  z.object({kind:z.literal('issue'),target:version,count:z.number().int().min(1).max(100)}).strict(),
  z.object({kind:z.literal('disable'),target:version,codeId:uuid}).strict(),
  z.object({kind:z.literal('reveal'),target:version,codeId:uuid}).strict(),
]);
export type CreatorCommand = z.infer<typeof creatorCommandSchema>;
const codeIds = uuid.array().min(1).max(100).refine(ids => new Set(ids).size === ids.length);
export const creatorConfirmationSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('feishu-card')}).strict(),
  z.object({kind:z.literal('app'),confirmationId:uuid}).strict(),
]);
export const DRAFT_SCOPE_EDIT_CAPABILITY='recipe.draft-scope.v1';
export const RESOURCE_CONTEXT_CAPABILITY = 'recipe.resource-context.v2';
export const resourceDeliverySchema=z.enum(['sent','pending','unknown','unavailable']);
export const draftScopeItemSchema=z.object({id:uuid,kind:z.enum(['role','setting','rule','skill','task','file']),label:z.string().min(1).max(360),parent:uuid.optional()}).strict();
export const draftScopeHeadSchema=z.object({revision:positive,baseSha256:digest,items:draftScopeItemSchema.array().max(512)}).strict();
export type DraftScopeHead=z.infer<typeof draftScopeHeadSchema>;
const evidence=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('native')}).strict(),
  z.object({kind:z.literal('managed'),parents:recipeRichOriginEdgeSchema.array().min(1).max(64)}).strict(),
]);
const draftScopeApply=z.object({kind:z.literal('draftScopeApply'),work:creatorWorkSchema,revision:positive,baseSha256:digest,
  lease:digest,addIds:uuid.array().max(512),removeIds:uuid.array().max(512),donor:recipeRichContentSchema,evidence:z.record(uuid,evidence)}).strict();
export type DraftScopeApply=z.infer<typeof draftScopeApply>;
const task = z.discriminatedUnion('kind', [
  ...resourceReadTaskSchema.options, resourceAcquireTaskSchema,
  z.object({kind:z.literal('draftScopeRead'),work:creatorWorkSchema}).strict(), draftScopeApply,
  z.object({kind:z.literal('read'),read}).strict(),
  z.object({kind:z.literal('command'),command:creatorCommandSchema,expiresAt:z.number().int().safe().nonnegative(),approval:digest,confirmation:creatorConfirmationSchema.optional()}).strict(),
  z.object({kind:z.literal('deliverCodes'),target:version,codeIds}).strict(),
]);
const job = z.object({id:uuid,binding:uuid,scope:digest,task}).strict();
export type CreatorJob = z.infer<typeof job>;
const states = z.enum(['available','redeemed','disabled']);
export const creatorAnswerSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('resourcePreview'),preview:recipeBrowseDetailSchema}).strict(),
  z.object({kind:z.literal('resourceSnapshot'),snapshot:verifiedResourceSnapshotSchema}).strict(),
  z.object({kind:z.literal('resourceLatest'),latest:resourceLatestSchema}).strict(),
  z.object({kind:z.literal('resourceAcquired'),outcome:acquisitionOutcomeSchema}).strict(),
  z.object({kind:z.literal('draftScopeHead'),work:creatorWorkSchema,head:draftScopeHeadSchema}).strict(),
  z.object({kind:z.literal('works'),items:selection.array().max(16),nextOffset:ordinal.nullable()}).strict(),
  z.object({kind:z.literal('snapshot'),snapshot:creatorSnapshotSchema}).strict(),
  z.object({kind:z.literal('previewOpened'),work:creatorWorkSchema,snapshotDigest:digest,revision:positive}).strict(),
  z.object({kind:z.literal('page'),snapshotDigest:digest,section:ordinal,page:ordinal,text:z.string().max(4096)}).strict(),
  z.object({kind:z.literal('codes'),target:version,items:z.array(z.object({codeId:uuid,suffix:z.string().max(8),status:states}).strict()).max(50),nextCursor:cursor}).strict(),
  z.object({kind:z.literal('parent'),target:version,inherited:inheritedPublicationSchema}).strict(),
  z.object({kind:z.literal('edit'),work:creatorWorkSchema,revision:positive,canonical,sourceCanonical:canonical}).strict(),
  z.object({kind:z.literal('published'),target:version,draftId:uuid,draftRevision:positive,revision:positive,firstCodeId:uuid.nullable(),url:z.string().url().max(2048)}).strict(),
  z.object({kind:z.literal('issued'),target:version,codeIds}).strict(),
  z.object({kind:z.literal('withdrawn'),target:version}).strict(),
  z.object({kind:z.literal('disabled'),target:version,codeId:uuid}).strict(),
  z.object({kind:z.literal('reveal'),target:version,codeId:uuid}).strict(),
  z.object({kind:z.literal('saved'),work:creatorWorkSchema,revision:positive}).strict(),
  z.object({kind:z.literal('discarded'),work:creatorWorkSchema,revision:positive}).strict(),
  z.object({kind:z.literal('unknown')}).strict(),
  z.object({kind:z.literal('rejected'),reason:z.enum(['changed','unavailable','forbidden','invalid'])}).strict(),
]);
const answer=creatorAnswerSchema;
export type CreatorAnswer = z.infer<typeof answer>;
const secretItem = z.discriminatedUnion('status', [
  z.object({codeId:uuid,status:z.literal('available'),code:z.string().regex(/^[A-F0-9-]{32,40}$/i)}).strict(),
  z.object({codeId:uuid,status:z.literal('redeemed')}).strict(),
  z.object({codeId:uuid,status:z.literal('disabled')}).strict(),
]);
const bot = {botId:agentIdSchema};
const session = {...bot,session:uuid};
export const creatorRequests = [
  z.object({type:z.literal('creatorDiscover'),...bot,accountId:uuid}).strict(),
  z.object({type:z.literal('creatorOpen'),...bot,accountId:uuid,binding:uuid,scope:digest,wakeId:uuid.nullable(),nativePreview:z.literal(true).optional(),resourceContext:z.literal(true).optional(),draftScope:z.literal(true).optional()}).strict(),
  z.object({type:z.literal('creatorContinue'),...session,selection,conversationRevision:positive.optional(),conversationRetryId:uuid.optional()}).strict(),
  z.object({type:z.literal('creatorPoll'),...session}).strict(),
  z.object({type:z.literal('creatorCheck'),...session,id:uuid}).strict(),
  z.object({type:z.literal('creatorAnswer'),...session,id:uuid,answer}).strict(),
  z.object({type:z.literal('creatorLogo'),...session,id:uuid}).strict(),
  z.object({type:z.literal('creatorDeliver'),...session,id:uuid,items:secretItem.array().min(1).max(100)}).strict(),
  z.object({type:z.literal('creatorPreview'),...session,work:creatorWorkSchema,revision:positive}).strict(),
  z.object({type:z.literal('creatorAppConfirm'),...session,id:uuid,snapshotDigest:digest,confirmationId:uuid}).strict(),
  z.object({type:z.literal('resourceHandoff'),...session,target:exactResourceVersionSchema,requestId:uuid}).strict(),
] as const;
export type CreatorRequest = z.infer<(typeof creatorRequests)[number]>;
export const creatorReplies = [
  z.object({kind:z.literal('creatorBinding'),association:z.object({binding:uuid,scope:digest,recipient}).strict().nullable(),wakeId:uuid.nullable()}).strict(),
  z.object({kind:z.literal('creatorSession'),session:uuid,binding:uuid,scope:digest,leaseMs:positive,resourceContext:z.literal(true).optional()}).strict(),
  z.object({kind:z.literal('creatorJobs'),jobs:job.array().max(16)}).strict(),
  z.object({kind:z.literal('creatorChecked'),job,mode:z.enum(['read','preview','execute','receipt','delivery'])}).strict(),
  z.object({kind:z.literal('creatorLogoBytes'),base64:z.string().min(4).max(2796204).regex(/^[A-Za-z0-9+/]+={0,2}$/),sha256:digest}).strict(),
  z.object({kind:z.literal('creatorAck')}).strict(),
  z.object({kind:z.literal('creatorPreview'),job,state:z.enum(['preparing','offer','active','unknown','finished']),result:answer.optional()}).strict(),
  z.object({kind:z.literal('resourceHandoff'),target:exactResourceVersionSchema,requestId:uuid,delivery:resourceDeliverySchema}).strict(),
] as const;
export type CreatorReply = z.infer<(typeof creatorReplies)[number]>;
