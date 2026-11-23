import { z } from 'zod';

export const draftPreviewLocatorSchema = z.object({
  draftId: z.string().uuid(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type DraftPreviewLocator = z.infer<typeof draftPreviewLocatorSchema>;
export const draftPreviewNavigationIdSchema = z.string().uuid();
export const draftPreviewNavigationSchema = draftPreviewLocatorSchema.extend({
  navigationId: draftPreviewNavigationIdSchema,
}).strict();
export type DraftPreviewNavigation = z.infer<typeof draftPreviewNavigationSchema>;
export interface RecipePreviewShell {
  pending(): Promise<DraftPreviewNavigation[]>;
  onOpen(listener: (navigation: DraftPreviewNavigation) => void): () => void;
  acknowledge(navigationId: string): Promise<void>;
}
