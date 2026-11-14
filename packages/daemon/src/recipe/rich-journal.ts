import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  type RecipeInstallReply,
  type RecipeInstallRequest,
  type RecipeRichInstallAuthorization,
  recipeRichInstallIntentSchema,
  recipeRichInstallAuthorizationSchema,
  recipeRichInstallPreviewSchema,
  recipeBinary32Schema,
} from '@vonvon/protocol';
const uuid = z.string().uuid(),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z
  .object({
    id: uuid,
    bot: z
      .object({
        appId: z.string(),
        tenant: z.enum(['feishu', 'lark']),
        createdAt: z.number(),
        registrationId: uuid.optional(),
      })
      .strict(),
    group: z.string(),
    account: uuid,
    rowDigest: digest,
    reviewToken: digest,
    nonce: z.custom<string>((v) => recipeBinary32Schema.safeParse(v).success),
    intent: z.custom<Extract<RecipeInstallReply, { kind: 'richPrepared' }>['intent']>(
      (v) => recipeRichInstallIntentSchema.safeParse(v).success,
    ),
    preview: z.custom<Extract<RecipeInstallRequest, { type: 'richPrepare' }>['preview']>(
      (v) => recipeRichInstallPreviewSchema.safeParse(v).success,
    ),
    choices: z.record(uuid, z.enum(['local', 'incoming'])),
    install: uuid,
    generation: uuid,
    staging: uuid,
    status: z.enum(['prepared', 'redeemed', 'applied', 'rejected']),
    issuerState: z.enum(['unissued', 'issuing', 'authorized']),
    settled: z.boolean(),
    authorization: z
      .custom<RecipeRichInstallAuthorization>((v) => recipeRichInstallAuthorizationSchema.safeParse(v).success)
      .optional(),
    reason: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type RichJournal = z.infer<typeof journalSchema>;
export function richLedger(stored: Record<string, unknown>): Record<string, RichJournal> {
  const raw = (stored.richInstallJournal ??= {});
  const entries = z.record(uuid, journalSchema).parse(raw);
  for (const [id, op] of Object.entries(entries)) {
    if (
      id !== op.id ||
      op.account !== op.preview.accountId ||
      op.intent.versionId !== op.preview.release.versionId ||
      op.intent.manifestSha256 !== op.preview.release.contentSha256 ||
      Boolean(op.authorization) !== (op.issuerState === 'authorized') ||
      (['applied', 'redeemed'].includes(op.status) && !op.authorization) ||
      (op.settled && !['applied', 'rejected'].includes(op.status))
    )
      throw new Error('完整配方安装记录损坏');
    if (op.authorization) {
      const {
        operationId,
        accountId,
        deadline: _d,
        ticket: _t,
        serverPublicKey: _k,
        status: _s,
        ...intent
      } = op.authorization;
      if (operationId !== id || accountId !== op.account || !isDeepStrictEqual(intent, op.intent))
        throw new Error('完整配方授权记录不符');
    }
  }
  return raw as Record<string, RichJournal>;
}
export function unissuedExpired(op: RichJournal, now: number) {
  return op.status === 'prepared' && op.issuerState === 'unissued' && !op.authorization && now - op.createdAt >= 300000;
}
export function pendingRich(stored: Record<string, unknown>, now: number, account?: string) {
  if (stored.richInstallJournal === undefined) return 0;
  return Object.values(richLedger(stored)).filter(
    (o) => (!account || o.account === account) && !o.settled && !unissuedExpired(o, now),
  ).length;
}
