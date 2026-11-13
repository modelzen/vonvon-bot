import { z } from 'zod';
import { authoringReceiptSchema, type AuthoringAuthorization } from '@vonvon/protocol';
import type { LocalOperation } from './authoring-journal';
import { makeAuthoringProof, digest, dispatchDigest } from './authoring-wire';
import { recipeApiOrigin } from './installer';

export function checkAuthorization(op: LocalOperation, a: AuthoringAuthorization, now: number) {
  const dispatch = a.stage === 'dispatch';
  const v = op.view;
  if (a.operationId !== v.operationId || a.accountId !== op.accountId || a.purpose !== v.purpose ||
      a.targetPublicKey !== v.targetPublicKey || a.nonceCommitment !== v.nonceCommitment || a.draftId !== v.draftId ||
      a.baseRevision !== v.baseRevision || a.status !== (dispatch ? 'registered' : 'dispatched') ||
      a.stateRevision !== (dispatch ? 1 : 2) || a.deadline > now + 305000 || a.deadline <= now ||
      a.deadline > a.operationDeadline || a.payloadDigest !== (dispatch ? dispatchDigest : v.payloadDigest) ||
      (dispatch ? v.state !== 'pendingMain' : (!op.payload || digest(Buffer.from(op.payload, 'base64url')) !== a.payloadDigest || v.state !== 'pendingCloud'))) {
    throw new Error('云授权与当前草稿操作不符或已过期。');
  }
}
export async function postAuthoring(url: string, op: LocalOperation, a: AuthoringAuthorization, http = fetch, loopback = false) {
  if (!op.secret || !op.nonce) throw new Error('缺少本机操作凭据。');
  const origin = recipeApiOrigin(url, loopback);
  const res = await http(origin + '/v1/authoring/' + op.view.operationId + '/' + a.stage, {
    method: 'POST', headers: {'content-type': 'application/json'}, credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(12000), body: JSON.stringify({ticket: a.ticket, nonce: op.nonce, proof: makeAuthoringProof(op.secret, a),
      ...(a.stage === 'accept' ? {payload: op.payload} : {})}),
  });
  if (!res.ok || !res.body) { await res.body?.cancel(); throw new Error('云端尚未确认草稿操作，请通过 App 核对。'); }
  const reader = res.body.getReader(), chunks: Uint8Array[] = [];
  try {
    let length = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2048) throw new Error('云回执超限。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (a.stage === 'accept') {
    const result = authoringReceiptSchema.parse(body);
    if (result.operationId !== op.view.operationId || result.status !== 'accepted' ||
      (op.view.purpose === 'editDraft' && (result.draftId !== op.view.draftId || result.revision !== op.view.baseRevision! + 1))) throw new Error('草稿回执不匹配。');
    return result;
  }
  return z.object({operationId: z.literal(op.view.operationId), status: z.literal('dispatched'), stateRevision: z.literal(2)}).strict().parse(body);
}
