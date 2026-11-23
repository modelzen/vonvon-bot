import {creatorRequests, creatorReplies, inheritedPublicationSchema} from './recipe-creator.js';
import {richSourceOptionsSchema,richInventoryOptionsSchema,richLocalInventorySchema,richSourceAttestationSchema,richPreparationSchema,richFreezeInputSchema,
  richFrozenResponseSchema,richAuthoringAuthorizationSchema} from './recipe-rich-authoring.js';
import {recipeRichContentSchema,recipeRichPartDescriptorSchema,recipeRichDraftChangeSchema} from './recipe-rich.js';
import { z } from 'zod';
import { agentIdSchema, groupIdSchema } from './domain.js';
import { recipeBinary32Schema, recipeSetupSchema } from './recipe-install.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(2147483647);
const millis = z.number().int().nonnegative().safe();
const purpose = z.enum(['prepareDraft', 'editDraft']);
const publicField = z.enum(['name', 'summary', 'overview', 'version']);
const fieldRequest = z.object({requestId: uuid, operationId: uuid, draftId: uuid, revision: positive, field: publicField}).strict();
export type AuthoringFieldRequest = z.infer<typeof fieldRequest>;
const target = {botId: agentIdSchema};
const session = {...target, session: uuid};
const operation = {...session, operationId: uuid};

export const authoringHandoffSchema = z.object({
  retryId:uuid, groupId:groupIdSchema, draftId:uuid.optional(),
  state:z.enum(['selecting','awaitingAttestations','prepared','cancelled','expired','needsReview','deliveryUnknown']),
  operationId:uuid.optional(),
}).strict();
export const handoffUnavailableSchema = z.object({kind:z.literal('handoffUnavailable'),retryId:uuid,reason:z.literal('notFound')}).strict();
export type AuthoringHandoff = z.infer<typeof authoringHandoffSchema>;
const handoffAttestation = z.object({retryId:uuid,ref:uuid,generation:positive,lease:digest,versions:uuid.array().max(64),items:z.array(z.object({versionId:uuid,itemIds:uuid.array().min(1).max(512)}).strict()).max(64).optional()}).strict();
export type HandoffAttestation = z.infer<typeof handoffAttestation>;
const editSource = z.object({sourceIntentId:uuid,canonical:z.string().min(1).max(1401000)}).strict();
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
  operationId: uuid, ...registration, format:z.literal('rich-v2').optional(), storage:z.literal('local').optional(),
  state: z.enum(['pendingMain', 'sending', 'waiting', 'candidate', 'pendingCloud', 'completed', 'cancelPending', 'cancelled', 'expired', 'needsReview']),
  deliveryUnknown: z.boolean(), cardUpdate: z.enum(['pending','backoff','unavailable']).optional(), payloadDigest: digest.optional(), receipt: authoringReceiptSchema.optional(),
  groupId: groupIdSchema.optional(), createdAt: millis,
}).strict();
export type AuthoringOperation = z.infer<typeof authoringOperationSchema>;
// Old links can reconcile cloud registration and its terminal receipt, never source, candidate or delivery.
const reconciliation = z.object({
  operationId: uuid, ...registration, format:z.literal('rich-v2').optional(), storage:z.literal('local').optional(), createdAt: millis, receipt: authoringReceiptSchema.optional(),
}).strict();
export type AuthoringReconciliation = z.infer<typeof reconciliation>;
const recipient = z.object({openId: z.string().max(210), chatId: groupIdSchema, tenantKey: z.string().max(200)}).strict();
export const localDraftAdvanceSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('dispatch'),draftId:uuid}).strict(),
  z.object({kind:z.literal('richAccept'),draftId:uuid,reviewDigest:digest,frozen:richFrozenResponseSchema}).strict(),
  z.object({kind:z.literal('roleAccept'),draftId:uuid,reviewDigest:digest,revision:positive}).strict(),
  z.object({kind:z.literal('cancel')}).strict(),
]);
export type LocalDraftAdvance=z.infer<typeof localDraftAdvanceSchema>;
export const recipeAuthoringRequestSchema = z.discriminatedUnion('type', [
  ...creatorRequests,
  z.object({type:z.literal('beginHandoff'),...session,retryId:uuid,groupId:groupIdSchema,groupName:z.string().min(1).max(512),conversation:z.literal(true).optional(),sourceVersionId:uuid.optional(),inherited:inheritedPublicationSchema.optional()}).strict(),
  z.object({type:z.literal('beginDraftHandoff'),...session,retryId:uuid,groupId:groupIdSchema,groupName:z.string().min(1).max(512),identity:digest,
    draftId:uuid,baseRevision:positive,canonical:z.string().min(1).max(1401000),source:editSource}).strict(),
  z.object({type:z.literal('restoreHandoff'),...session,retryId:uuid,expected:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('source'),groupId:groupIdSchema,sourceVersionId:uuid.optional(),inherited:inheritedPublicationSchema.optional()}).strict(),
    z.object({kind:z.literal('draft'),groupId:groupIdSchema,draftId:uuid,baseRevision:positive}).strict(),
  ])}).strict(),
  z.object({type:z.literal('handoffStatus'),...session,retryId:uuid}).strict(),
  z.object({type:z.literal('cancelHandoff'),...session,retryId:uuid}).strict(),
  z.object({type:z.literal('answerHandoff'),...session,request:handoffAttestation,unavailable:z.literal(true).optional(),attestations:richSourceAttestationSchema.array().max(64)}).strict(),
  z.object({type:z.literal('richSourceOptions'),...session,groupId:groupIdSchema}).strict(),
  z.object({type:z.literal('richInventory'),...session,groupId:groupIdSchema,options:richInventoryOptionsSchema}).strict(),
  z.object({type:z.literal('richPrepare'),...session,groupId:groupIdSchema,selection:richPreparationSchema,attestations:richSourceAttestationSchema.array().max(64)}).strict(),
  z.object({type:z.literal('richEdit'),...session,draftId:uuid,baseRevision:positive,canonical:z.string().max(1401000),selected:uuid.array().max(32),logo:richPreparationSchema.shape.logo,access:z.enum(['direct','coded']).optional(),changes:recipeRichDraftChangeSchema.array().min(1).max(16).optional(),
    source:z.object({sourceIntentId:uuid,canonical:z.string().max(1401000)}).strict().optional()}).strict(),
  z.object({type:z.literal('richReadMember'),...operation,index:z.number().int().min(0).max(64),reviewDigest:digest}).strict(),
  z.object({type:z.literal('richMembers'),...operation}).strict(),
  z.object({type:z.literal('richBindMembers'),...operation,reviewDigest:digest,descriptors:recipeRichPartDescriptorSchema.array().max(65)}).strict(),
  z.object({type:z.literal('richInspect'),...operation,preview:z.literal(true).optional()}).strict(),
  z.object({type:z.literal('richAdvance'),...operation,destinationDraftId:uuid,authorization:richAuthoringAuthorizationSchema,
    accepted:z.object({frozen:richFrozenResponseSchema,manifestId:uuid,packageId:uuid}).strict().optional()}).strict(),
  z.object({type:z.literal('localDraftAdvance'),...operation,advance:localDraftAdvanceSchema}).strict(),
  z.object({type:z.literal('localDraftAcknowledged'),...operation,receipt:authoringReceiptSchema}).strict(),
  z.object({type: z.literal('open'), ...target, accountId: uuid}).strict(),
  z.object({type: z.literal('close'), ...session}).strict(),
  z.object({type: z.literal('status'), ...session, operationId:uuid.nullable().optional()}).strict(),
  z.object({type: z.literal('workflow'), ...session}).strict(),
  z.object({type: z.literal('answerField'), ...session, request:fieldRequest, value:z.string().max(4000).nullable()}).strict(),
  z.object({type: z.literal('resumeContext'), ...operation}).strict(),
  z.object({type: z.literal('beginLink'), ...session}).strict(),
  z.object({type: z.literal('inspectLink'), ...session, challengeId: uuid}).strict(),
  z.object({type: z.literal('confirmLink'), ...session, challengeId: uuid, evidence: digest}).strict(),
  z.object({type: z.literal('groupSourceIdentity'), ...session, groupId: groupIdSchema}).strict(),
  z.object({type: z.literal('operationSourceIdentity'), ...operation}).strict(),
  z.object({type: z.literal('reviewSource'), ...session, groupId: groupIdSchema}).strict(),
  z.object({type: z.literal('prepare'), ...session, groupId: groupIdSchema, reviewToken: digest,
    sourceAttested: z.literal(true), setup: recipeSetupSchema.optional()}).strict(),
  z.object({type: z.literal('edit'), ...session, draftId: uuid, baseRevision: positive}).strict(),
  z.object({type: z.literal('inspectCandidate'), ...operation, requireEditApproval:z.literal(true).optional()}).strict(),
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
  ...creatorReplies,
  handoffUnavailableSchema,
  z.object({kind:z.literal('handoff'),handoff:authoringHandoffSchema}).strict(),
  richSourceOptionsSchema,
  z.object({kind:z.literal('richInventory'),groupId:groupIdSchema,inventory:richLocalInventorySchema}).strict(),
  z.object({kind:z.literal('richMember'),operationId:uuid,index:z.number().int().min(0).max(64),reviewDigest:digest,bytes:z.string().max(2796203)}).strict(),
  z.object({kind:z.literal('richMembers'),operationId:uuid,reviewDigest:digest,cap:positive,members:z.array(z.object({
    kind:z.enum(['text','finalLogo']),sha256:digest}).strict()).max(65)}).strict(),
  z.object({kind:z.literal('richCandidate'),operationId:uuid,reviewDigest:digest,request:richFreezeInputSchema}).strict(),
  z.object({kind: z.literal('session'), session: uuid, linked: z.boolean(), leaseMs: positive}).strict(),
  z.object({kind: z.literal('closed')}).strict(),
  z.object({kind: z.literal('workflow'), activity:millis, ageMs:millis, field:fieldRequest.optional(),handoff:handoffAttestation.optional(),
    pausedContexts:z.array(uuid).max(540)}).strict(),
  z.object({kind: z.literal('fieldAnswered')}).strict(),
  z.object({kind: z.literal('challenge'), challengeId: uuid, code: z.string().max(32), expiresAt: millis}).strict(),
  z.object({kind: z.literal('link'), linked: z.boolean(), recipient: recipient.optional(), evidence: digest.optional()}).strict(),
  z.object({kind: z.literal('groupSourceIdentity'), groupId: groupIdSchema, identity: digest}).strict(),
  z.object({kind: z.literal('operationSourceIdentity'), operationId: uuid, groupId: groupIdSchema, identity: digest.nullable()}).strict(),
  z.object({kind: z.literal('source'), groupId: groupIdSchema, reviewToken: digest, role: z.string().max(16384), untracked: z.boolean()}).strict(),
  z.object({kind: z.literal('candidate'), operationId: uuid, payloadDigest: digest, reviewedDigest:digest.optional(), payload: z.string().max(180000)}).strict(),
  z.object({kind: z.literal('operation'), operation: authoringOperationSchema}).strict(),
  z.object({kind:z.literal('localDraftAcknowledged'),operationId:uuid}).strict(),
  z.object({kind: z.literal('reconciled'), receipt: authoringReceiptSchema}).strict(),
  z.object({kind: z.literal('status'), linked: z.boolean(), operations: z.array(authoringOperationSchema).max(540),
    reconciliation: z.array(reconciliation).max(540)}).strict(),
]);
export type RecipeAuthoringReply = z.infer<typeof recipeAuthoringReplySchema>;
