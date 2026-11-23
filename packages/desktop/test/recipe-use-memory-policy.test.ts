import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createClient, type ClientConnection, type RpcError } from '../../client/dist/client.js';
import {
  agentIdSchema,
  canonicalizeRichRecipeContent,
  groupIdSchema,
  recipeRichContentSchema,
  recipeRichInstallIntentSchema,
  requestSchema,
  type RecipeInstallReply,
  type RecipeUseRequest,
} from '@vonvon/protocol';
import { richRuntimeRequests } from '../../protocol/test/fixtures/recipe-runtime-pre-memory-policy';
import { mergeRecipeItems, recipeSnapshot } from './fixtures/recipe-rich-merge-pre-memory-policy';
import type { NativeAccount } from '../src/account-session';
import { RecipeUseController } from '../src/recipe-use';
import { RecipeJournal } from '../src/recipe-use-journal';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const legacyRequest = z.object({
  type: z.literal('request'),
  id: z.string(),
  method: z.literal('recipeInstall'),
  payload: z.discriminatedUnion('type', richRuntimeRequests),
}).strict();

function fixture(restore?: 'unissued' | 'issuing' | 'authorized' | 'applied' | 'appliedPending',
  writeError?: Pick<RpcError, 'code' | 'message' | 'details'>) {
  const folder = mkdtempSync(join(tmpdir(), 'recipe-memory-compat-'));
  folders.push(folder);
  const accountId = randomUUID(), recipeId = randomUUID(), versionId = randomUUID(),
    deviceId = randomUUID(), operationId = randomUUID();
  const botId = agentIdSchema.parse('cli_memory_compat'), groupId = groupIdSchema.parse('oc_memory_compat');
  const binary = (n: number) => Buffer.alloc(32, n).toString('base64url');
  const pk = binary(1), nonce = binary(2);
  const raw = recipeRichContentSchema.parse(JSON.parse(readFileSync(
    new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json', import.meta.url), 'utf8',
  )));
  delete raw.role;
  delete raw.finalLogo;
  for (const kind of ['settings', 'rules', 'skills', 'files', 'tasks', 'setup', 'parts'] as const) raw[kind] = [];
  const memory = raw.memories[0];
  if (!memory) throw new Error('Historical fixture must contain memory');
  raw.memories = [{ ...memory, text: { kind: 'inline', value: 'HISTORICAL_MEMORY_HIDDEN_BY_NEW_UI' } }];
  const doc = canonicalizeRichRecipeContent(raw);
  const merged = mergeRecipeItems([], [], recipeSnapshot(doc.content, value => {
    if (value.kind !== 'inline') throw new Error('Unexpected object text');
    return value.value;
  }));
  expect(merged.conflicts).toEqual([]);
  expect(merged.resolved).toMatchObject([{ kind: 'memories', value: { text: 'HISTORICAL_MEMORY_HIDDEN_BY_NEW_UI' } }]);
  const hash = createHash('sha256').update(doc.canonicalUTF8).digest('hex');
  const preview = {
    accountId,
    release: { format: 'rich-v2', recipeId, versionId, authorId: accountId, revision: 1,
      access: 'direct', logicalBytes: doc.logicalBytes, contentSha256: hash },
    manifest: { objectId: randomUUID(), kind: 'manifest', sha256: hash,
      bytes: doc.canonicalUTF8.length, mediaType: 'application/json' },
  };
  const intent = recipeRichInstallIntentSchema.parse({ format: 'rich-v2', purpose: 'installRichRecipe',
    generation: 2, versionId, manifestSha256: hash, targetPublicKey: pk, nonceCommitment: nonce });
  const steps: string[] = [], sent: unknown[] = [];
  const applied = restore === 'applied' || restore === 'appliedPending';
  const state = { issuer: applied ? 'authorized' : restore ?? 'unissued',
    status: applied ? 'applied' : 'prepared', applied: applied ? merged.resolved : [] };
  const status = () => ({ kind: 'richStatus', operationId, status: state.status,
    issuerState: state.issuer, settled: state.status === 'applied' || state.status === 'rejected' });
  let receive: (data: string) => void = () => { throw new Error('Client not attached'); };
  const socket: ClientConnection = {
    isOpen: () => true,
    onMessage(listener) { receive = listener; },
    onClose() {},
    onError() {},
    close: async () => {},
    send(data, callback) {
      const frame = requestSchema.parse(JSON.parse(data));
      sent.push(frame);
      const reply = (payload: unknown) => receive(JSON.stringify({ type: 'response', id: frame.id, method: frame.method, payload }));
      callback();
      if (frame.method === 'device') {
        reply({ kind: 'deviceStatus', status: { device: { id: deviceId, publicKey: pk, name: '隔离设备' },
          remote: { port: 1234, addresses: [] }, clients: { total: 1, active: 1 } } });
        return;
      }
      if (frame.method !== 'recipeInstall') throw new Error('Unexpected method');
      if (frame.payload.type === 'source') {
        steps.push('native:source');
        reply({ kind: 'source', groupId, source: { format: 'rich-v2', recipeId, versionId,
          revision: 1, authorId: accountId, installedAt: 1, sourceToken: 'c'.repeat(64) } });
        return;
      }
      if (writeError && frame.payload.type === 'richPrepare') {
        steps.push('native:richPrepare');
        receive(JSON.stringify({ type: 'error', id: frame.id, ...writeError }));
        return;
      }
      const parsed = legacyRequest.safeParse(JSON.parse(data));
      if (!parsed.success) {
        steps.push('rejected:' + frame.payload.type);
        receive(JSON.stringify({ type: 'error', id: frame.id, code: 'invalid_request', message: '请求参数无效。' }));
        return;
      }
      const req = parsed.data.payload;
      steps.push('native:' + req.type);
      if (req.type === 'richPrepare') {
        reply(req.reviewToken
          ? { kind: 'richPrepared', operationId, intent, reviewToken: 'a'.repeat(64) }
          : { kind: 'richReview', groupId, reviewToken: 'a'.repeat(64), conflicts: merged.conflicts });
        return;
      }
      if (req.type === 'richIssuing' && state.issuer === 'unissued') state.issuer = 'issuing';
      if (req.type === 'richCommit') { state.status = 'applied'; state.issuer = 'authorized'; state.applied = merged.resolved; }
      if ((req.type === 'richCancel' && state.issuer === 'unissued') ||
          (req.type === 'richReconcile' && state.issuer === 'issuing')) state.status = 'rejected';
      reply(status());
    },
  };
  const client = createClient(socket);
  const signal = new AbortController().signal;
  const account = {
    lease: () => signal,
    request: async (_id: string, path: string) => {
      steps.push('cloud:' + path.split('/').pop());
      if (path.endsWith('/install-preview')) return Response.json(preview);
      if (path.includes('/objects/')) return new Response(doc.canonicalUTF8);
      if (path.endsWith('/authorize')) return Response.json({ ...intent, accountId, operationId,
        deadline: Date.now() + 300_000, serverPublicKey: binary(3), ticket: binary(4), status: 'authorized' });
      if (path.endsWith('/cancel')) return Response.json({ operationId, status: 'rejected' });
      throw new Error('Unexpected cloud request');
    },
  } as unknown as NativeAccount;
  const journal = new RecipeJournal(join(folder, 'journal.json'));
  const saved = { id: randomUUID(), format: 'rich-v2' as const, accountId, deviceId,
    viewId: deviceId, pk, botId, recipeId, versionId, createdAt: Date.now(), fromJoin: false,
    groupId };
  if (restore === 'applied') journal.save({ ...saved, stage: 'done', outcome: 'applied' });
  else if (restore) journal.save({ ...saved, stage: 'operation',
    operation: { id: operationId, sha: hash, commitment: nonce }, richIntent: intent, action: 'confirm' });
  const main = new RecipeUseController(account, viewId => ({ client, viewId, pairedKey: pk, check() {} }),
    new RecipeJournal(join(folder, 'journal.json')));
  return {
    state, steps, sent, client, botId, operationId,
    begin: () => main.request({ type: 'begin', format: 'rich-v2', accountId, recipeId, versionId,
      viewId: deviceId, botId, groupId }),
    run: (request: RecipeUseRequest) => main.request(request),
  };
}

it('blocks zero-conflict historical memory on an old target before Main can expose confirmation', async () => {
  const f = fixture();
  await expect(f.begin()).rejects.toThrow('目标设备未接受本次排除配方记忆的安装请求，请先更新该设备，再重新打开配方。');
  expect(f.steps).toContain('rejected:richPrepare');
  expect(f.steps).not.toContain('native:richPrepare');
  expect(f.state.applied).toEqual([]);
  expect(f.sent.filter(frame => legacyRequest.safeParse(frame).success)).toEqual([]);
  await f.client.close();
});

it.each([
  { code: 'invalid_request', message: '配方审阅已过期。' },
  { code: 'invalid_request', message: '请求参数无效。', details: { reason: 'stale_review' } },
  { code: 'invalid_request', message: '请求参数无效。', details: {} },
  { code: 'operation_failed', message: '请求参数无效。' },
])('preserves an admitted write error $code / $message / $details without retrying', async writeError => {
  const f = fixture(undefined, writeError);
  await expect(f.begin()).rejects.toMatchObject({ name: 'RpcError', ...writeError });
  expect(f.steps).toContain('native:richPrepare');
  expect(f.sent.filter(frame => requestSchema.parse(frame).method === 'recipeInstall')).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ type: 'richPrepare', memoryPolicy: 'exclude' }) }),
  ]);
  expect(f.state.applied).toEqual([]);
  await f.client.close();
});

it.each(['unissued', 'issuing', 'authorized'] as const)(
  'blocks a persisted %s plan after Main restart while keeping cancellation available', async issuer => {
    const f = fixture(issuer), pending = await f.begin();
    expect(pending.kind).toBe('pending');
    if (!('handle' in pending)) throw new Error('Expected restorable handle');
    await expect(f.run({ type: 'resume', handle: pending.handle })).rejects.toThrow('更新');
    expect(f.steps).not.toContain('cloud:authorize');
    expect(f.steps).not.toContain('native:richIssuing');
    expect(f.steps).not.toContain('native:richCommit');
    expect(f.steps).toContain(issuer === 'authorized' ? 'rejected:richCommit' : 'rejected:richIssuing');
    expect(f.state.applied).toEqual([]);
    const cancelled = await f.run({ type: 'cancel', handle: pending.handle });
    if (issuer === 'authorized') expect(cancelled).toMatchObject({ kind: 'pending', phase: 'cancelling' });
    else expect(cancelled.kind).toBe('rejected');
    expect(f.steps).toContain('native:richStatus');
    expect(f.steps).toContain(issuer === 'unissued' ? 'native:richCancel' : 'native:richReconcile');
    await f.client.close();
  },
);

it('keeps old applied receipts and status readable without replaying a mutation', async () => {
  const f = fixture('applied');
  expect((await f.begin()).kind).toBe('applied');
  expect(await f.client.recipeInstall?.({ type: 'richStatus', botId: f.botId, operationId: f.operationId }))
    .toMatchObject({ kind: 'richStatus', status: 'applied', settled: true } satisfies Partial<RecipeInstallReply>);
  expect(f.steps).toEqual(['native:source', 'native:richStatus']);
  await f.client.close();
});

it('settles an applied old operation from its status after a Main restart without reissuing or committing', async () => {
  const f = fixture('appliedPending'), pending = await f.begin();
  if (pending.kind !== 'pending') throw new Error('Expected an operation awaiting its receipt');
  expect((await f.run({ type: 'resume', handle: pending.handle })).kind).toBe('applied');
  expect(f.steps).toEqual(['native:richStatus']);
  await f.client.close();
});
