import { z } from 'zod';
import { agentIdSchema, groupIdSchema } from './domain.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recipeBinary32Schema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const text = (limit: number) => z.string().refine(value => [...value].length <= limit);
export const recipeSetupSchema = z.object({ steps: z.array(z.object({
  kind: z.enum(['config', 'tool', 'context']), title: text(80), instructions: z.string().max(2048),
  check: z.string().max(512).optional(), required: z.boolean(),
}).strict()).min(1).max(8) }).strict();
export type RecipeSetup = z.infer<typeof recipeSetupSchema>;
export const recipeManifestSchema = z.object({
  schema: z.literal(1), recipeId: uuid, versionId: uuid, authorId: uuid,
  revision: z.number().int().positive(), access: z.enum(['direct', 'coded']),
  role: text(5000), setup: recipeSetupSchema.optional(),
}).strict();
export type RecipeManifest = z.infer<typeof recipeManifestSchema>;
export const recipeAuthorizationSchema = z.object({
  operationId: uuid, accountId: uuid, purpose: z.literal('installBoundRole'), generation: z.literal(1),
  deadline: z.number().int().nonnegative().safe(), versionId: uuid, manifestSha256: digest,
  targetPublicKey: recipeBinary32Schema, nonceCommitment: recipeBinary32Schema,
  serverPublicKey: recipeBinary32Schema, ticket: recipeBinary32Schema, status: z.enum(['authorized', 'redeemed', 'applied', 'rejected']),
}).strict();
export type RecipeAuthorization = z.infer<typeof recipeAuthorizationSchema>;
export const recipeRedemptionSchema = recipeAuthorizationSchema.omit({status: true, ticket: true}).extend({
  status: z.enum(['redeemed', 'applied', 'rejected']), manifest: z.string().max(80000),
}).strict();
export const recipeResolutionSchema = z.object({
  role: z.discriminatedUnion('kind', [
    z.object({kind: z.literal('keep')}).strict(), z.object({kind: z.literal('replace')}).strict(),
    z.object({kind: z.literal('custom'), text: text(5000)}).strict(),
  ]).optional(),
  setup: z.enum(['keep', 'replace']).optional(),
}).strict();
const target = {botId: agentIdSchema};
export const recipeInstallRequestSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('prepare'), ...target, groupId: groupIdSchema, accountId: uuid,
    manifest: z.string().min(1).max(80000), manifestSha256: digest, reviewToken: digest.optional(), resolution: recipeResolutionSchema.optional()}).strict(),
  z.object({type: z.literal('commit'), ...target, operationId: uuid, authorization: recipeAuthorizationSchema.optional()}).strict(),
  z.object({type: z.literal('status'), ...target, operationId: uuid}).strict(),
  z.object({type: z.literal('issuing'), ...target, operationId: uuid}).strict(),
  z.object({type: z.literal('reconcile'), ...target, operationId: uuid}).strict(),
  z.object({type: z.literal('cancel'), ...target, operationId: uuid}).strict(),
]);
export type RecipeInstallRequest = z.infer<typeof recipeInstallRequestSchema>;
const review = {
  reviewToken: digest,
  groupId: groupIdSchema, currentRole: z.string(), incomingRole: z.string(), baseRole: z.string().optional(),
  currentSetup: recipeSetupSchema.optional(), incomingSetup: recipeSetupSchema.optional(), baseSetup: recipeSetupSchema.optional(),
  roleChoiceRequired: z.boolean(), setupChoiceRequired: z.boolean(),
};
export const recipeInstallReplySchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('review'), ...review}).strict(),
  z.object({kind: z.literal('prepared'), operationId: uuid, targetPublicKey: recipeBinary32Schema,
    nonceCommitment: recipeBinary32Schema, versionId: uuid, manifestSha256: digest, ...review}).strict(),
  z.object({kind: z.literal('alreadyInstalled'), groupId: groupIdSchema, recipeId: uuid, versionId: uuid}).strict(),
  z.object({kind: z.literal('status'), operationId: uuid, status: z.enum(['prepared', 'in_progress', 'applied', 'rejected']),
    issuerState: z.enum(['unissued', 'issuing', 'authorized']), stillNeedsTicket: z.boolean(),
    reason: z.string().optional(), groupId: groupIdSchema}).strict(),
]);
export type RecipeInstallReply = z.infer<typeof recipeInstallReplySchema>;
