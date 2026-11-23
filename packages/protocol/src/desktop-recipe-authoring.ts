import {recipeRichDraftChangeSchema} from './recipe-rich.js';
import {richFreezeInputSchema,richPreparationSchema,richSourceOptionsSchema,richInventoryOptionsSchema,richLocalInventorySchema} from './recipe-rich-authoring.js';
import { z } from 'zod';
import { agentIdSchema, groupIdSchema } from './domain.js';
import { viewIdSchema } from './desktop-devices.js';
import { recipePublicSchema, recipeConfigSchema } from './desktop-community.js';
import { authoringChangeSchema, authoringOperationSchema, authoringHandoffSchema, handoffUnavailableSchema } from './recipe-authoring.js';
import { recipeSetupSchema } from './recipe-setup.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.number().int().positive().max(2147483647);
const handle = { handle: uuid };
const operation = { ...handle, operationId: uuid };
const link = { ...handle, challengeId: uuid };
export const desktopAuthoringRequestSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('restoreHandoff'),accountId:uuid,viewId:viewIdSchema,retryId:uuid,handle:uuid.optional(),target:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('source'),botId:agentIdSchema,groupId:groupIdSchema,parent:z.object({recipeId:uuid,versionId:uuid}).strict().optional()}).strict(),
    z.object({kind:z.literal('draft'),draftId:uuid,baseRevision:revision}).strict(),
  ])}).strict(),
  z.object({type:z.literal('openDraftSource'),accountId:uuid,viewId:viewIdSchema,draftId:uuid,baseRevision:revision}).strict(),
  z.object({type:z.literal('beginHandoff'),...handle,retryId:uuid,groupId:groupIdSchema,source:z.object({recipeId:uuid,versionId:uuid}).strict().optional()}).strict(),
  z.object({type:z.literal('beginDraftHandoff'),...handle,retryId:uuid,draftId:uuid,baseRevision:revision}).strict(),
  z.object({type:z.literal('handoffStatus'),...handle,retryId:uuid}).strict(),
  z.object({type:z.literal('cancelHandoff'),...handle,retryId:uuid}).strict(),
  z.object({type:z.literal('richInspectCandidate'),...operation}).strict(),
  z.object({type:z.literal('richSourceOptions'),...handle,groupId:groupIdSchema}).strict(),
  z.object({type:z.literal('richInventory'),...handle,groupId:groupIdSchema,options:richInventoryOptionsSchema}).strict(),
  z.object({type:z.literal('richPrepare'),...handle,groupId:groupIdSchema,selection:richPreparationSchema}).strict(),
  z.object({type:z.literal('richEdit'),...handle,draftId:uuid,baseRevision:revision,selected:uuid.array().max(32),logo:richPreparationSchema.shape.logo,access:z.enum(['direct','coded']).optional(),changes:recipeRichDraftChangeSchema.array().min(1).max(16).optional()}).strict(),
  z.object({ type: z.literal('open'), accountId: uuid, viewId: viewIdSchema, botId: agentIdSchema, groupId: groupIdSchema.optional() }).strict(),
  z.object({ type: z.literal('close'), ...handle }).strict(),
  z.object({ type: z.literal('detach'), ...handle }).strict(),
  z.object({ type: z.literal('sourceHistory'), ...handle, groupId: groupIdSchema, cursor: uuid.optional() }).strict(),
  z.object({ type: z.literal('status'), ...handle }).strict(),
  z.object({ type: z.literal('beginLink'), ...handle }).strict(),
  z.object({ type: z.literal('inspectLink'), ...link }).strict(),
  z.object({ type: z.literal('confirmLink'), ...link, evidence: digest }).strict(),
  z.object({ type: z.literal('reviewSource'), ...handle, groupId: groupIdSchema }).strict(),
  z
    .object({
      type: z.literal('prepare'),
      ...handle,
      groupId: groupIdSchema,
      reviewToken: digest,
      sourceAttested: z.literal(true),
      setup: recipeSetupSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('edit'), ...handle, draftId: uuid, baseRevision: revision }).strict(),
  z.object({ type: z.literal('inspectCandidate'), ...operation }).strict(),
  z.object({ type: z.literal('accept'), ...operation, payloadDigest: digest }).strict(),
  z.object({ type: z.literal('resume'), ...operation }).strict(),
  z.object({ type: z.literal('resend'), ...operation }).strict(),
  z.object({ type: z.literal('cancel'), ...operation }).strict(),
]);
const name = z.string().min(1).max(512);
export const authoringTargetSchema = z
  .object({
    accountId: uuid,
    accountName: name,
    viewId: viewIdSchema,
    botId: agentIdSchema,
    botName: name,
  })
  .strict();
export const desktopAuthoringOperationSchema = authoringOperationSchema
  .omit({ targetPublicKey: true, nonceCommitment: true, cardUpdate: true })
  .extend({ target: authoringTargetSchema, contextPaused:z.boolean().optional(), groupName: name.optional(), syncMessage: z.string().max(180).optional() });
export const authoringCandidateContentSchema = z.union([
  z.object({ public: recipePublicSchema, config: recipeConfigSchema }).strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      draftId: uuid,
      baseRevision: revision,
      changes: z.array(authoringChangeSchema).min(1).max(16),
    })
    .strict(),
]);
const group = { groupId: groupIdSchema, groupName: name };
const historyMetadata = {
  operationId: uuid, draftId: uuid, recipeId: uuid, name: recipePublicSchema.shape.name,
  version: recipePublicSchema.shape.version, revision,
};
export const sourceHistoryEntrySchema = z.discriminatedUnion('state', [
  z.object({state: z.literal('draft'), ...historyMetadata, versionId: z.null()}).strict(),
  z.object({state: z.literal('published'), ...historyMetadata, versionId: uuid}).strict(),
  z.object({state: z.literal('unknown'), operationId: uuid, draftId: z.null(), recipeId: z.null(), versionId: z.null()}).strict(),
]);
export type SourceHistoryEntry = z.infer<typeof sourceHistoryEntrySchema>;
const desktopAuthoringSessionSchema = z
    .object({
      kind: z.literal('session'),
      ...handle,
      target: authoringTargetSchema,
      linked: z.boolean(),
      sourceGroup:z.object(group).strict().optional(),
      operations: z.array(desktopAuthoringOperationSchema).max(540),
    })
    .strict();
export const desktopAuthoringReplySchema = z.discriminatedUnion('kind', [
  handoffUnavailableSchema,
  z.object({kind:z.literal('handoffRestored'),session:desktopAuthoringSessionSchema,handoff:authoringHandoffSchema}).strict(),
  z.object({kind:z.literal('handoffLinkRequired'),session:desktopAuthoringSessionSchema}).strict(),
  z.object({kind:z.literal('handoff'),handoff:authoringHandoffSchema}).strict(),
  z.object({kind:z.literal('richCandidate'),operation:desktopAuthoringOperationSchema,reviewDigest:digest,request:richFreezeInputSchema}).strict(),
  richSourceOptionsSchema,
  z.object({kind:z.literal('richInventory'),groupId:groupIdSchema,inventory:richLocalInventorySchema}).strict(),
  desktopAuthoringSessionSchema,
  z.object({kind: z.literal('sourceHistory'), entries: z.array(sourceHistoryEntrySchema).max(32), nextCursor: uuid.nullable()}).strict(),
  z.object({ kind: z.literal('closed') }).strict(),
  z
    .object({
      kind: z.literal('challenge'),
      challengeId: uuid,
      code: z.string().max(32),
      expiresAt: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('link'),
      linked: z.boolean(),
      recipient: z
        .object({
          openId: z.string().max(210),
          chatId: groupIdSchema,
          tenantKey: z.string().max(200),
        })
        .strict()
        .optional(),
      evidence: digest.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('source'),
      target: authoringTargetSchema,
      ...group,
      role: z.string().max(16384),
      reviewToken: digest,
      untracked: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('operation'), operation: desktopAuthoringOperationSchema }).strict(),
  z
    .object({
      kind: z.literal('candidate'),
      operation: desktopAuthoringOperationSchema,
      payloadDigest: digest,
      content: authoringCandidateContentSchema,
    })
    .strict(),
]);
export type DesktopAuthoringRequest = z.infer<typeof desktopAuthoringRequestSchema>;
export type DesktopAuthoringReply = z.infer<typeof desktopAuthoringReplySchema>;
export type DesktopAuthoringOperation = z.infer<typeof desktopAuthoringOperationSchema>;
export const authoringSavedSchema = z.object({accountId:uuid,draftId:uuid,revision}).strict();
export type AuthoringSaved = z.infer<typeof authoringSavedSchema>;
export interface RecipeAuthoringShell {
  onSaved?(listener: (receipt:AuthoringSaved) => void): () => void;
  request(input: DesktopAuthoringRequest): Promise<DesktopAuthoringReply>;
}
