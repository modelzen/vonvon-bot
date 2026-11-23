import { z } from 'zod';

export const NATIVE_RECIPE_PREVIEW_CAPABILITY = 'recipe.native-preview';
export const draftPreviewLocatorSchema = z.object({
  draftId: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type DraftPreviewLocator = z.infer<typeof draftPreviewLocatorSchema>;
export const draftPreviewNavigationIdSchema = z.string().uuid();
export const draftPreviewNavigationSchema = draftPreviewLocatorSchema.extend({
  navigationId: draftPreviewNavigationIdSchema,
  accountId: z.string().uuid().optional(),
}).strict();
export type DraftPreviewNavigation = z.infer<typeof draftPreviewNavigationSchema>;
export const recipeCreateNavigationSchema = z.object({
  kind: z.literal('create'), navigationId: draftPreviewNavigationIdSchema,
}).strict();
export const recipeHandoffNavigationSchema = z.object({
  kind: z.literal('handoff'), navigationId: draftPreviewNavigationIdSchema,
  recipeId: z.string().uuid(), versionId: z.string().uuid(),
}).strict();
export const recipeDraftsNavigationSchema = z.object({
  kind: z.literal('drafts'), navigationId: draftPreviewNavigationIdSchema,
}).strict();
export const recipePreviewNavigationSchema = z.union([draftPreviewNavigationSchema, recipeCreateNavigationSchema, recipeHandoffNavigationSchema, recipeDraftsNavigationSchema]);
export type RecipePreviewNavigationPayload = z.infer<typeof recipePreviewNavigationSchema>;
export interface RecipePreviewShell {
  pending(): Promise<RecipePreviewNavigationPayload[]>;
  onOpen(listener: (navigation: RecipePreviewNavigationPayload) => void): () => void;
  acknowledge(navigationId: string): Promise<void>;
}
