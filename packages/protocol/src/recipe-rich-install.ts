import {z} from 'zod';
import {recipeBinary32Schema} from './recipe-binary.js';
import {recipeRichReleaseSchema} from './recipe-rich.js';
const uuid=z.string().uuid().regex(/^[0-9a-f-]+$/), digest=z.string().regex(/^[0-9a-f]{64}$/);
export const recipeRichManifestObjectSchema=z.object({objectId:uuid,kind:z.literal('manifest'),sha256:digest,
  bytes:z.number().int().positive().max(1048576),mediaType:z.literal('application/json')}).strict();
export const recipeRichInstallPreviewSchema=z.object({accountId:uuid,release:recipeRichReleaseSchema,manifest:recipeRichManifestObjectSchema}).strict();
const fields={format:z.literal('rich-v2'),generation:z.literal(2),versionId:uuid,manifestSha256:digest,
  targetPublicKey:recipeBinary32Schema,nonceCommitment:recipeBinary32Schema};
export const recipeRichInstallIntentSchema=z.discriminatedUnion('purpose',[
  z.object({...fields,purpose:z.literal('installRichRecipe')}).strict(),
  z.object({...fields,purpose:z.literal('updateDirectRichRecipe'),fromVersionId:uuid,localPlanSha256:digest}).strict(),
]);
const reply={operationId:uuid,accountId:uuid,deadline:z.number().int().positive().safe(),serverPublicKey:recipeBinary32Schema};
const status=z.enum(['authorized','redeemed','applied','rejected']);
export const recipeRichInstallAuthorizationSchema=z.discriminatedUnion('purpose',[
  recipeRichInstallIntentSchema.options[0].extend({...reply,ticket:recipeBinary32Schema,status}),
  recipeRichInstallIntentSchema.options[1].extend({...reply,ticket:recipeBinary32Schema,status}),
]);
const extra={...reply,status:z.enum(['redeemed','applied','rejected']),release:recipeRichReleaseSchema,manifest:recipeRichManifestObjectSchema};
export const recipeRichInstallRedemptionSchema=z.discriminatedUnion('purpose',[
  recipeRichInstallIntentSchema.options[0].extend(extra),recipeRichInstallIntentSchema.options[1].extend(extra),
]);
export type RecipeRichInstallAuthorization=z.infer<typeof recipeRichInstallAuthorizationSchema>;
