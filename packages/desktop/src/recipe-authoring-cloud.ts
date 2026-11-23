import { z } from 'zod';
import {
  authoringAuthorizationSchema,
  authoringReceiptSchema,
  recipeBinary32Schema,
  recipeDraftSchema,
  sourceHistoryEntrySchema,
  type AuthoringOperation,
  type AuthoringReceipt,
  type AuthoringReconciliation,
} from '@vonvon/protocol';
import type { NativeAccount } from './account-session.js';
import { AccountFault } from './account-auth.js';

export class AuthoringError extends Error {}
export class AuthoringServiceUnavailable extends AuthoringError {}
class OperationExpired extends AuthoringError {}
const unredeemable = z.object({operationId:z.string().uuid(), accountId:z.string().uuid(), unredeemable:z.literal(true)}).strict();
export const invalidAuthoring = () => new AuthoringError('配方操作与原记录不一致，请重新核对。');
export const dispatchDigest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const uuid = z.string().uuid();
const positive = z.number().int().positive().max(2147483647);
const binding = {
  operationId: uuid,
  accountId: uuid,
  purpose: z.enum(['prepareDraft', 'editDraft']),
  targetPublicKey: recipeBinary32Schema,
  nonceCommitment: recipeBinary32Schema,
  draftId: uuid.optional(),
  baseRevision: positive.optional(),
};
const cloudState = z
  .object({
    ...binding,
    status: z.enum(['registered', 'dispatched', 'cancelled', 'expired']),
    stateRevision: positive,
    operationDeadline: z.number().int().nonnegative().safe(),
  })
  .strict();
const tombstone = z
  .object({
    operationId: uuid,
    accountId: uuid,
    status: z.literal('cancelled'),
    stateRevision: z.literal(1),
    operationDeadline: z.number().int().nonnegative().safe(),
  })
  .strict();
type Pending = { status: 'registered' | 'dispatched'; stateRevision: number };
function registration(op: AuthoringOperation) {
  return {
    purpose: op.purpose,
    targetPublicKey: op.targetPublicKey,
    nonceCommitment: op.nonceCommitment,
    ...(op.purpose === 'editDraft' && { draftId: op.draftId, baseRevision: op.baseRevision }),
  };
}
type Registration = Omit<AuthoringReconciliation, 'receipt' | 'createdAt'>;
function match(actual: z.infer<typeof cloudState>, accountId: string, op: Registration) {
  if (
    actual.operationId !== op.operationId ||
    actual.accountId !== accountId ||
    actual.purpose !== op.purpose ||
    actual.targetPublicKey !== op.targetPublicKey ||
    actual.nonceCommitment !== op.nonceCommitment ||
    actual.draftId !== op.draftId ||
    actual.baseRevision !== op.baseRevision
  )
    throw invalidAuthoring();
}
function state(raw: unknown, accountId: string, op: Registration): AuthoringReceipt | Pending {
  const accepted = authoringReceiptSchema.options[0].safeParse(raw);
  if (accepted.success) {
    const r = accepted.data;
    if (
      r.operationId !== op.operationId ||
      (op.purpose === 'editDraft' && (r.draftId !== op.draftId || r.revision !== op.baseRevision! + 1)) ||
      (op.purpose === 'prepareDraft' && r.revision !== 1)
    )
      throw invalidAuthoring();
    return r;
  }
  const cancelled = tombstone.safeParse(raw);
  if (cancelled.success) {
    if (cancelled.data.accountId !== accountId || cancelled.data.operationId !== op.operationId)
      throw invalidAuthoring();
    return { operationId: op.operationId, status: 'cancelled', stateRevision: 1 };
  }
  const v = cloudState.parse(raw);
  match(v, accountId, op);
  if (v.status === 'cancelled' || v.status === 'expired')
    return { operationId: v.operationId, status: v.status, stateRevision: v.stateRevision };
  if (v.stateRevision !== (v.status === 'registered' ? 1 : 2)) throw invalidAuthoring();
  return { status: v.status, stateRevision: v.stateRevision };
}
export function authoringCloud(account: NativeAccount, accountId: string, signal: AbortSignal, check: () => void) {
  async function read(path: string, body?: object, missingAllowed = false) {
    check();
    const response = await account.request(
      accountId,
      path,
      {
        signal,
        ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      },
      check,
    );
    check();
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      void response.body?.cancel().catch(() => {});
      throw new AuthoringServiceUnavailable(response.status === 429
        ? '配方操作已达限额，请稍后重试。' : '账号服务未确认本次操作，请稍后恢复。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw invalidAuthoring();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        check();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 448 * 1024) throw invalidAuthoring();
        chunks.push(next.value);
      }
    } finally {
      void reader.cancel().catch(() => {});
    }
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (response.ok) return raw;
    const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(raw);
    if (missingAllowed && response.status === 404 && code.success && code.data.error.code === 'not_found')
      return undefined;
    if (response.status === 409) throw new AuthoringError('草稿修订或操作状态已改变，请核对原操作。');
    if (response.status === 410 && code.success && code.data.error.code === 'operation_expired')
      throw new OperationExpired('这次操作已到期，请查看原操作。');
    if (response.status === 410) throw new AuthoringError('这次操作已到期，请查看原操作。');
    if (response.status === 404 || response.status === 403) throw new AuthoringError('当前账号找不到这份草稿或操作。');
    throw new AuthoringError('账号服务未确认本次操作，请稍后恢复。');
  }
  const path = (op: Registration) => '/v1/authoring/' + op.operationId;
  async function getState(op: Registration, cancel = false) {
    let raw: unknown;
    try {
      raw = await read(path(op) + (cancel ? '/cancel' : ''), cancel ? {} : undefined, !cancel);
    } catch (error) {
      if (!(error instanceof OperationExpired)) throw error;
      raw = await read(path(op) + '/recovery');
      const proof = unredeemable.safeParse(raw);
      if (proof.success) {
        if (proof.data.accountId !== accountId || proof.data.operationId !== op.operationId) throw invalidAuthoring();
        return {operationId:op.operationId, status:'expired', outcome:'unknown'} as const;
      }
    }
    return raw === undefined ? undefined : state(raw, accountId, op);
  }
  return {
    async presence() {
      let raw: unknown;
      try {
        raw = await read('/v1/me');
      } catch (error) {
        check();
        if (error instanceof TypeError ||
          error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError') ||
          error instanceof AccountFault && error.reason === 'offline')
          throw new AuthoringServiceUnavailable('账号服务未确认本次操作，请稍后恢复。');
        throw error;
      }
      const actor = z
        .object({ accountId: uuid })
        .strict()
        .parse(raw);
      if (actor.accountId !== accountId) throw invalidAuthoring();
    },
    async sourceHistory(ids: string[]) {
      if (!ids.length) return [];
      const {entries} = z.object({entries:z.array(sourceHistoryEntrySchema).max(32)}).strict().parse(
        await read('/v1/authoring/source-history', {operationIds:ids}),
      );
      if (entries.length !== ids.length || entries.some((entry,i) => entry.operationId !== ids[i])) throw invalidAuthoring();
      return entries;
    },
    async draft(draftId: string, revision: number) {
      const draft = recipeDraftSchema.parse(await read('/v1/drafts/' + draftId));
      if (draft.draftId !== draftId || draft.revision !== revision)
        throw new AuthoringError('草稿修订已改变，请重新打开草稿。');
      return draft;
    },
    get: (op: Registration) => getState(op),
    async register(op: AuthoringOperation) {
      return state(await read(path(op) + '/register', registration(op)), accountId, op);
    },
    async cancel(op: Registration) {
      const result = await getState(op, true);
      if (!result || !('operationId' in result)) throw invalidAuthoring();
      return result;
    },
    async authorize(op: AuthoringOperation, stage: 'dispatch' | 'accept', payloadDigest: string) {
      const stateRevision = stage === 'dispatch' ? 1 : 2;
      const body = { stage, stateRevision, payloadDigest };
      const auth = authoringAuthorizationSchema.parse(await read(path(op) + '/authorize', body));
      match(auth, accountId, op);
      if (
        auth.status !== (stage === 'dispatch' ? 'registered' : 'dispatched') ||
        auth.stage !== stage ||
        auth.stateRevision !== stateRevision ||
        auth.payloadDigest !== payloadDigest ||
        auth.deadline > auth.operationDeadline ||
        auth.deadline <= Date.now()
      )
        throw invalidAuthoring();
      return auth;
    },
  };
}
