import { z } from 'zod';
import { agentIdSchema, groupIdSchema } from './domain.js';
import { viewIdSchema } from './desktop-devices.js';
import { recipeSetupSchema } from './recipe-setup.js';

const uuid = z.string().uuid();
export const recipeSourceSchema = z
  .object({
    recipeId: uuid,
    versionId: uuid,
    revision: z.number().int().positive(),
    authorId: uuid,
    installedAt: z.number().int(),
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
  })
  .strict();
const location = { viewId: viewIdSchema, botId: agentIdSchema, groupId: groupIdSchema };
export const desktopRecipeSourceRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('read'), ...location }).strict(),
  z.object({ type: z.literal('check'), ...location, accountId: uuid }).strict(),
  z
    .object({ type: z.literal('ignore'), ...location, accountId: uuid, installedVersionId: uuid, versionId: uuid })
    .strict(),
]);
export const desktopRecipeSourceReplySchema = z
  .object({ source: recipeSourceSchema.nullable(), latest: recipeLatestSchema.optional() })
  .strict();
export type DesktopRecipeSourceRequest = z.infer<typeof desktopRecipeSourceRequestSchema>;
export type DesktopRecipeSourceReply = z.infer<typeof desktopRecipeSourceReplySchema>;
export interface RecipeSourceShell {
  request(request: DesktopRecipeSourceRequest): Promise<DesktopRecipeSourceReply>;
}
