// Frozen from f1997d47c16f533f784aab5abe99cda0479c652f:packages/protocol/src/recipe-runtime.ts; only relative imports adjusted.
import { z } from 'zod';
import {scheduleSpecSchema} from '../../src/schedule.js';
import { agentIdSchema, groupIdSchema } from '../../src/domain.js';
import {
  recipeRichInstallAuthorizationSchema,
  recipeRichInstallIntentSchema,
  recipeRichInstallPreviewSchema,
} from '../../src/recipe-rich-install.js';
import { recipeRichContentSchema } from '../../src/recipe-rich.js';
const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/),
  target = { botId: agentIdSchema, groupId: groupIdSchema };
const parts = z.record(uuid, z.string().max(174764));
export const richRuntimeRequests = [
  z
    .object({
      type: z.literal('richPrepare'),
      authority:z.enum(['exactVersion','directUpdate']).optional(),
      ...target,
      preview: recipeRichInstallPreviewSchema,
      canonical: z.string().max(1048576),
      parts,
      choices: z.record(uuid, z.enum(['local', 'incoming'])).optional(),
      reviewToken: digest.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('richCommit'),
      botId: agentIdSchema,
      operationId: uuid,
      authorization: recipeRichInstallAuthorizationSchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('richIssuing'), botId: agentIdSchema, operationId: uuid }).strict(),
  z.object({ type: z.literal('richCancel'), botId: agentIdSchema, operationId: uuid }).strict(),
  z.object({ type: z.literal('richReconcile'), botId: agentIdSchema, operationId: uuid }).strict(),

  z.object({ type: z.literal('richStatus'), botId: agentIdSchema, operationId: uuid }).strict(),
  z
    .object({
      type: z.literal('richSetup'),
      ...target,
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('read') }).strict(),
        z.object({ kind: z.literal('acknowledge'), stepId: uuid, token: digest }).strict(),
        z.object({ kind: z.literal('openSettings'), stepId: uuid, token: digest }).strict(),
        z.object({ kind: z.literal('check'), stepId: uuid, token: digest }).strict(),
        z
          .object({
            kind: z.literal('enableTask'),
            taskId: z.string(),
            taskToken:digest,
            token: digest,
            timeZone: z.string().max(100),
          })
          .strict(),
      ]),
    })
    .strict(),
] as const;
const conflict = z
  .object({
    itemId: uuid,
    kind: z.string(),
    base: z.string().nullable(),
    local: z.string().nullable(),
    incoming: z.string().nullable(),
  })
  .strict();
export const richRuntimeReplies = [
  z
    .object({ kind: z.literal('richReview'), groupId: groupIdSchema, reviewToken: digest, conflicts: z.array(conflict) })
    .strict(),
  z
    .object({
      kind: z.literal('richPrepared'),
      operationId: uuid,
      intent: recipeRichInstallIntentSchema,
      reviewToken: digest,
    })
    .strict(),
  z
    .object({
      kind: z.literal('richStatus'),
      operationId: uuid,
      status: z.enum(['prepared', 'redeemed', 'applied', 'rejected']),
      issuerState: z.enum(['unissued', 'issuing', 'authorized']),
      settled: z.boolean(),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('richSetup'),
      groupId: groupIdSchema,
      token: digest,
      steps: z.array(
        recipeRichContentSchema.shape.setup.element.extend({ readiness: z.enum(['pending', 'acknowledged', 'observed']) }),
      ),
      tasks: z.array(z.object({id:z.string(),name:z.string(),state:z.enum(['active','paused','finished']),token:digest,instruction:z.string().max(4000),schedule:z.string().max(500),spec:scheduleSpecSchema.optional(),timeZone:z.string().max(100),placement:z.enum(['follow','newTopic'])}).strict()),
      open: z
        .enum([
          'model',
          'modelAccess',
          'permission',
          'response',
          'conversation',
          'run',
          'smartRules',
          'presentation',
          'judge',
          'speed',
        ])
        .optional(),
    })
    .strict(),
] as const;
