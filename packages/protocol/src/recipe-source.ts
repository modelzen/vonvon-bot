import { z } from 'zod';
import {richRuntimeRequests,richRuntimeReplies} from './recipe-runtime.js';
import { agentIdSchema, groupIdSchema } from './domain.js';
import { viewIdSchema } from './desktop-devices.js';
import { recipeSetupSchema } from './recipe-setup.js';

const uuid = z.string().uuid();
export const recipeSourceTokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const recipeSourceSchema = z
  .object({
    format:z.literal('rich-v2').optional(),
    recipeId: uuid,
    versionId: uuid,
    revision: z.number().int().positive(),
    authorId: uuid,
    installedAt: z.number().int(),
    sourceToken: recipeSourceTokenSchema,
    setup: recipeSetupSchema.optional(),
    ignoredVersionId: uuid.optional(),
  })
  .strict();
export const recipeLatestSchema = z
  .object({
    recipeId: uuid,
    versionId: uuid,
    revision: z.number().int().positive(),
    version: z.string().max(80),
    entitled: z.boolean(),
    format:z.enum(['rich-v2','role-v1']).optional(),
    access:z.enum(['direct','coded']).optional(),
  })
  .strict();
const location = { viewId: viewIdSchema, botId: agentIdSchema, groupId: groupIdSchema };
export const desktopRecipeSourceRequestSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('setup'),...location,sourceToken:recipeSourceTokenSchema,action:richRuntimeRequests[6].shape.action}).strict(),
  z.object({ type: z.literal('read'), ...location }).strict(),
  z.object({ type: z.literal('check'), ...location, accountId: uuid }).strict(),
  z
    .object({ type: z.literal('ignore'), ...location, sourceToken: recipeSourceTokenSchema, accountId: uuid, installedVersionId: uuid, versionId: uuid })
    .strict(),
]);
export const desktopRecipeSourceReplySchema = z
  .object({source:recipeSourceSchema.nullable(),latest:recipeLatestSchema.optional(),setup:richRuntimeReplies[3].optional()})
  .strict();
export type DesktopRecipeSourceRequest = z.infer<typeof desktopRecipeSourceRequestSchema>;
export type DesktopRecipeSourceReply = z.infer<typeof desktopRecipeSourceReplySchema>;
export interface RecipeSourceShell {
  request(request: DesktopRecipeSourceRequest): Promise<DesktopRecipeSourceReply>;
}
