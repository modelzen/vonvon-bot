import { z } from 'zod';
import { agentIdSchema, groupIdSchema } from './domain.js';
import { recipeBinary32Schema, recipeSetupSchema } from './recipe-install.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(2147483647);
const millis = z.number().int().nonnegative().safe();
const purpose = z.enum(['prepareDraft', 'editDraft']);
const publicField = z.enum(['name', 'summary', 'overview', 'version']);
const target = {botId: agentIdSchema};
const session = {...target, session: uuid};
const operation = {...session, operationId: uuid};

export const authoringChangeSchema = z.discriminatedUnion('op', [
  z.object({op: z.literal('setPublicText'), field: publicField, value: z.string().max(32768)}).strict(),
  z.object({op: z.literal('setDraftRole'), value: z.string().max(16384)}).strict(),
  z.object({op: z.literal('setSetup'), value: recipeSetupSchema.nullable()}).strict(),
]);
export type AuthoringChange = z.infer<typeof authoringChangeSchema>;
const registration = {
  purpose, targetPublicKey: recipeBinary32Schema, nonceCommitment: recipeBinary32Schema,
  draftId: uuid.optional(), baseRevision: positive.optional(),
};
export const authoringAuthorizationSchema = z.object({
  ...registration, operationId: uuid, accountId: uuid, status: z.enum(['registered', 'dispatched']),
  stage: z.enum(['dispatch', 'accept']), stateRevision: positive, operationDeadline: millis,
  payloadDigest: digest, serverPublicKey: recipeBinary32Schema, ticket: recipeBinary32Schema, deadline: millis,
}).strict();
export type AuthoringAuthorization = z.infer<typeof authoringAuthorizationSchema>;
export const authoringReceiptSchema = z.union([
  z.object({operationId: uuid, status: z.literal('accepted'), stateRevision: z.literal(3), draftId: uuid, revision: positive}).strict(),
  z.object({operationId: uuid, status: z.literal('cancelled'), stateRevision: positive}).strict(),
  z.object({operationId: uuid, status: z.literal('expired'), stateRevision: positive}).strict(),
  // The registration window is closed and no receipt remains; a past save is still possible.
  z.object({operationId: uuid, status: z.literal('expired'), outcome: z.literal('unknown')}).strict(),
]);
export type AuthoringReceipt = z.infer<typeof authoringReceiptSchema>;
export const authoringOperationSchema = z.object({
  operationId: uuid, ...registration,
  state: z.enum(['pendingMain', 'sending', 'waiting', 'candidate', 'pendingCloud', 'completed', 'cancelPending', 'cancelled', 'expired', 'needsReview']),
  deliveryUnknown: z.boolean(), cardUpdate: z.enum(['pending','backoff','unavailable']).optional(), payloadDigest: digest.optional(), receipt: authoringReceiptSchema.optional(),
  groupId: groupIdSchema.optional(), createdAt: millis,
}).strict();
export type AuthoringOperation = z.infer<typeof authoringOperationSchema>;
// Old links can reconcile cloud registration and its terminal receipt, never source, candidate or delivery.
const reconciliation = z.object({
  operationId: uuid, ...registration, createdAt: millis, receipt: authoringReceiptSchema.optional(),
}).strict();
export type AuthoringReconciliation = z.infer<typeof reconciliation>;
const recipient = z.object({openId: z.string().max(210), chatId: groupIdSchema, tenantKey: z.string().max(200)}).strict();
export const recipeAuthoringRequestSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('open'), ...target, accountId: uuid}).strict(),
  z.object({type: z.literal('close'), ...session}).strict(),
  z.object({type: z.literal('status'), ...session}).strict(),
  z.object({type: z.literal('beginLink'), ...session}).strict(),
  z.object({type: z.literal('inspectLink'), ...session, challengeId: uuid}).strict(),
  z.object({type: z.literal('confirmLink'), ...session, challengeId: uuid, evidence: digest}).strict(),
  z.object({type: z.literal('reviewSource'), ...session, groupId: groupIdSchema}).strict(),
  z.object({type: z.literal('prepare'), ...session, groupId: groupIdSchema, reviewToken: digest,
    sourceAttested: z.literal(true), setup: recipeSetupSchema.optional()}).strict(),
  z.object({type: z.literal('edit'), ...session, draftId: uuid, baseRevision: positive}).strict(),
  z.object({type: z.literal('inspectCandidate'), ...operation}).strict(),
  z.object({type: z.literal('advance'), ...operation, authorization: authoringAuthorizationSchema}).strict(),
  z.object({type: z.literal('updateCard'), ...operation}).strict(),
  z.object({type: z.literal('deliver'), ...operation}).strict(),
  z.object({type: z.literal('resend'), ...operation}).strict(),
  z.object({type: z.literal('cancel'), ...operation}).strict(),
  z.object({type: z.literal('reconcile'), ...operation, receipt: authoringReceiptSchema}).strict(),
  z.object({type: z.literal('settle'), ...operation, receipt: authoringReceiptSchema}).strict(),
]);
export type RecipeAuthoringRequest = z.infer<typeof recipeAuthoringRequestSchema>;
export const recipeAuthoringReplySchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('session'), session: uuid, linked: z.boolean(), leaseMs: positive}).strict(),
  z.object({kind: z.literal('closed')}).strict(),
  z.object({kind: z.literal('challenge'), challengeId: uuid, code: z.string().max(32), expiresAt: millis}).strict(),
  z.object({kind: z.literal('link'), linked: z.boolean(), recipient: recipient.optional(), evidence: digest.optional()}).strict(),
  z.object({kind: z.literal('source'), groupId: groupIdSchema, reviewToken: digest, role: z.string().max(16384), untracked: z.boolean()}).strict(),
  z.object({kind: z.literal('candidate'), operationId: uuid, payloadDigest: digest, payload: z.string().max(180000)}).strict(),
  z.object({kind: z.literal('operation'), operation: authoringOperationSchema}).strict(),
  z.object({kind: z.literal('reconciled'), receipt: authoringReceiptSchema}).strict(),
  z.object({kind: z.literal('status'), linked: z.boolean(), operations: z.array(authoringOperationSchema).max(540),
    reconciliation: z.array(reconciliation).max(540)}).strict(),
]);
export type RecipeAuthoringReply = z.infer<typeof recipeAuthoringReplySchema>;
