import {z} from 'zod';
import {recipePublicSchema, publicDisplayNameSchema} from './desktop-community.js';

const id = z.string().uuid();
export const recipeLibraryScopeSchema = z.enum(['all', 'acquired', 'published']);
export const recipeLibraryCursorSchema = z.string().min(1).max(1600).regex(/^[a-f0-9]+\.[a-f0-9]{64}$/);
export const recipeLibraryVersionSchema = z.object({
  recipeId: id, versionId: id, revision: z.number().int().positive().max(2147483647),
  public: z.lazy(() => recipePublicSchema.omit({overview: true}).partial({summary: true})),
  format: z.enum(['role-v1', 'rich-v2']),
  creator: z.object({authorId: id, displayName: z.lazy(() => publicDisplayNameSchema)}).strict(),
  hasDisplayLogo: z.boolean(), state: z.enum(['listed', 'withdrawn', 'deleted']), owned: z.boolean(), acquired: z.boolean(),
}).strict();
export const recipeLibraryGroupSchema = recipeLibraryVersionSchema.extend({versionCount: z.number().int().positive().max(2147483647)});
export const recipeLibraryGroupsSchema = z.object({items: recipeLibraryGroupSchema.array().max(50), nextCursor: recipeLibraryCursorSchema.nullable()}).strict();
export const recipeLibraryVersionsSchema = z.object({items: recipeLibraryVersionSchema.array().max(50), nextCursor: recipeLibraryCursorSchema.nullable()}).strict();
export type RecipeLibraryScope = z.infer<typeof recipeLibraryScopeSchema>;
export type RecipeLibraryGroup = z.infer<typeof recipeLibraryGroupSchema>;
export type RecipeLibraryVersion = z.infer<typeof recipeLibraryVersionSchema>;
