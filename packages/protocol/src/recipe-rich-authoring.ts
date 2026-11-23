import {z} from 'zod';
import {recipeBinary32Schema} from './recipe-install.js';
import {recipeRichAuthoringPayloadSchema,recipeRichContentSchema,recipeRichOriginEdgeSchema,recipeRichPartDescriptorSchema,type RecipeRichContent,type RecipeRichAuthoringPayload,type RecipeRichPartDescriptor,type RecipeRichOriginEdge} from './recipe-rich.js';

const uuid=z.string().uuid(),sha=z.string().regex(/^[0-9a-f]{64}$/),encoded=z.string().min(1).max(1401000).regex(/^[A-Za-z0-9_-]+$/);
const access=z.enum(['direct','coded']);
export const richSourceAttestationSchema=z.object({versionId:uuid,authorId:uuid,access,items:z.array(z.object({
  itemId:uuid,kind:z.enum(['publicText','role','finalLogo','setting','rule','skill','file','task','memory','setup','cardBlock']),baselineSha256:sha,
}).strict()).max(512)}).strict();
export const richAuthoringAuthorizationSchema=z.object({format:z.literal('rich-v2'),operationId:uuid,accountId:uuid,
  purpose:z.enum(['prepareDraft','editDraft']),targetPublicKey:recipeBinary32Schema,nonceCommitment:recipeBinary32Schema,draftId:uuid.optional(),baseRevision:z.number().int().positive().optional(),
  status:z.enum(['registered','dispatched']),stage:z.enum(['dispatch','accept']),stateRevision:z.number().int().positive(),operationDeadline:z.number().int().safe(),
  payloadDigest:sha,serverPublicKey:recipeBinary32Schema,ticket:recipeBinary32Schema,deadline:z.number().int().safe(),sourceReviewSha256:sha.optional()}).strict();
export const richFrozenResponseSchema=z.object({format:z.literal('rich-v2'),destinationDraftId:uuid,canonical:encoded,contentSha256:sha,
  logicalBytes:z.number().int().min(1).max(1048576),payload:encoded,payloadDigest:sha,sourceReviewSha256:sha}).strict();
const logoUpload=z.object({packageId:uuid,inputSha256:sha}).strict().optional();
export type RichFreezeInput = ({format:'rich-v2';content:RecipeRichContent;access:'direct'|'coded';sourceVersionId?:string|undefined;
  origins:{itemId:string;source:{kind:'accountClaim'}|({kind:'releaseItem'}&RecipeRichOriginEdge)|{kind:'releaseItems';parents:RecipeRichOriginEdge[]}}[]} |
  {format:'rich-v2';baseCanonical:string;payload:Extract<RecipeRichAuthoringPayload,{purpose:'editDraft'}>;access?:'direct'|'coded'|undefined;newParts?:RecipeRichPartDescriptor[]|undefined;candidates?:{sourceIntentId:string;canonical:string}[]|undefined}) & {logoUpload?:{packageId:string;inputSha256:string}|undefined};
export const richFreezeInputSchema:z.ZodType<RichFreezeInput>=z.union([
  z.object({format:z.literal('rich-v2'),content:recipeRichContentSchema,access,logoUpload,sourceVersionId:uuid.optional(),origins:z.array(z.object({
    itemId:uuid,source:z.discriminatedUnion('kind',[
      z.object({kind:z.literal('accountClaim')}).strict(),recipeRichOriginEdgeSchema.extend({kind:z.literal('releaseItem')}),
      z.object({kind:z.literal('releaseItems'),parents:z.array(recipeRichOriginEdgeSchema).min(1).max(64)}).strict(),
    ]),
  }).strict()).max(512)}).strict(),
  z.object({format:z.literal('rich-v2'),baseCanonical:encoded,logoUpload,payload:recipeRichAuthoringPayloadSchema.options[1],
    access:access.optional(),newParts:recipeRichPartDescriptorSchema.array().max(65).optional(),
    candidates:z.array(z.object({sourceIntentId:uuid,canonical:encoded}).strict()).max(16).optional()}).strict(),
]);
export type RichFrozenResponse=z.infer<typeof richFrozenResponseSchema>;

export const richSourceOptionsSchema=z.object({kind:z.literal('richSourceOptions'),skills:z.array(z.object({name:z.string().min(1).max(80),files:z.array(z.string().min(1).max(240)).max(64)}).strict()).max(128)}).strict();
export const richInventoryOptionsSchema=z.object({skills:z.array(z.object({skill:z.string().min(1).max(80),files:z.array(z.string().min(1).max(240)).min(1).max(64)}).strict()).max(16),
  includeBotMemories:z.boolean(),includeTasks:z.boolean()}).strict();
export const richPreparationSchema=z.object({options:richInventoryOptionsSchema,selected:z.array(uuid).max(512),reviewToken:sha,sourceAttested:z.literal(true),logo:z.string().min(1).max(2796203).regex(/^[A-Za-z0-9_-]+$/).optional(),
  public:z.object({name:z.string().max(60),summary:z.string().max(240),overview:z.string().max(32768),version:z.string().max(40)}).strict(),
  access,sourceVersionId:uuid.optional(),setup:z.array(recipeRichContentSchema.shape.setup.element.omit({itemId:true,originId:true})).max(8)}).strict();
export type RichLocalInventory={content:RecipeRichContent;reviewToken:string;unavailable:string[];versions:string[]};
export const richLocalInventorySchema:z.ZodType<RichLocalInventory>=z.object({content:recipeRichContentSchema,reviewToken:sha,unavailable:z.array(uuid).max(512),versions:z.array(uuid).max(64)}).strict();
