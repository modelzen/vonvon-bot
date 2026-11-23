import {richRuntimeReplies} from './recipe-runtime.js';
import { z } from 'zod';
import { agentIdSchema, groupIdSchema, bindGroupCommandSchema } from './domain.js';
import { createProjectRequestSchema } from './collaboration.js';
import { viewIdSchema } from './desktop-devices.js';
import { recipeResolutionSchema, recipeSetupSchema } from './recipe-install.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recipeJoinInputSchema = z.union([
  createProjectRequestSchema.omit({ requestId: true }),
  bindGroupCommandSchema,
]);
export type RecipeJoinInput = z.infer<typeof recipeJoinInputSchema>;
export const recipeUseRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('begin'),
      format: z.literal('rich-v2').optional(),
      accountId: uuid,
      viewId: viewIdSchema,
      recipeId: uuid,
      versionId: uuid,
      botId: agentIdSchema,
      groupId: groupIdSchema.optional(),
    })
    .strict(),
  z.object({type:z.literal('richResolve'),handle:uuid,reviewToken:digest,choices:z.record(uuid,z.enum(['local','incoming']))}).strict(),
  z.object({ type: z.literal('join'), handle: uuid, input: recipeJoinInputSchema }).strict(),
  z.object({
    type: z.literal('repairJoin'),
    handle: uuid,
    input: z.discriminatedUnion('type', [
      bindGroupCommandSchema,
      z.object({ type: z.literal('existingBinding'), agentId: agentIdSchema, groupId: groupIdSchema }).strict(),
    ]),
  }).strict(),
  z.object({ type: z.literal('dismissJoin'), handle: uuid }).strict(),
  z
    .object({ type: z.literal('resolve'), handle: uuid, reviewToken: digest, resolution: recipeResolutionSchema })
    .strict(),
  z.object({ type: z.literal('confirm'), handle: uuid }).strict(),
  z.object({ type: z.literal('cancel'), handle: uuid }).strict(),
  z.object({ type: z.literal('resume'), handle: uuid }).strict(),
  z.object({ type: z.literal('retry'), handle: uuid }).strict(),
  z.object({ type: z.literal('finish'), handle: uuid }).strict(),
]);
const handle = { handle: uuid };
export const desktopRecipeReviewSchema = z
  .object({
    reviewToken: digest,
    currentRole: z.string(),
    incomingRole: z.string(),
    baseRole: z.string().optional(),
    currentSetup: recipeSetupSchema.optional(),
    incomingSetup: recipeSetupSchema.optional(),
    baseSetup: recipeSetupSchema.optional(),
    roleChoiceRequired: z.boolean(),
    setupChoiceRequired: z.boolean(),
  })
  .strict();
export const recipeUseReplySchema = z.discriminatedUnion('kind', [
  richRuntimeReplies[0].extend({...handle}),
  z.object({kind:z.literal('richPrepared'),...handle,groupId:groupIdSchema,reviewToken:digest}).strict(),
  z.object({ kind: z.literal('choose'), ...handle }).strict(),
  z
    .object({ kind: z.literal('review'), ...handle, groupId: groupIdSchema, review: desktopRecipeReviewSchema })
    .strict(),
  z
    .object({ kind: z.literal('prepared'), ...handle, groupId: groupIdSchema, review: desktopRecipeReviewSchema })
    .strict(),
  z
    .object({
      kind: z.literal('pending'),
      ...handle,
      groupId: groupIdSchema.optional(),
      phase: z.enum(['joining', 'installing', 'cancelling']),
      recovery: z.object({
        state: z.enum(['unknown', 'createdUnsaved']),
        groupId: groupIdSchema.optional(),
        name: z.string().max(1000).optional(),
      }).strict().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('applied'), ...handle, groupId: groupIdSchema }).strict(),
  z
    .object({
      kind: z.literal('rejected'),
      ...handle,
      groupId: groupIdSchema.optional(),
      reason: z.string().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('closed') }).strict(),
]);
export type RecipeUseRequest = z.infer<typeof recipeUseRequestSchema>;
export type RecipeUseReply = z.infer<typeof recipeUseReplySchema>;
export type DesktopRecipeReview = z.infer<typeof desktopRecipeReviewSchema>;
export interface RecipeUseShell {
  request(request: RecipeUseRequest): Promise<RecipeUseReply>;
}
