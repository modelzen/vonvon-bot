import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { agentIdSchema, groupIdSchema, PROTOCOL_VERSION, recipeAuthoringRequestSchema, type Request } from '@vonvon/protocol';
import { RpcError } from '../src/server/errors';
import { fakeService, socketClient, startFixture } from './server-fixture';

const botId = agentIdSchema.parse('cli_rich_authz'), groupId = groupIdSchema.parse('oc_rich_authz');
const session = randomUUID(), operationId = randomUUID(), draftId = randomUUID();
const digest = 'a'.repeat(64), binary = Buffer.alloc(32, 1).toString('base64url');
const options = { skills: [], includeBotMemories: false, includeTasks: false };
const payloads = [
  {type:'status',operationId:null},{type:'status',operationId},
  {type:'beginHandoff',groupId,groupName:'产品群',retryId:operationId},
  {type:'beginDraftHandoff',groupId,groupName:'产品群',retryId:operationId,identity:digest,draftId,baseRevision:1,canonical:'e30',source:{sourceIntentId:operationId,canonical:'e30'}},
  {type:'restoreHandoff',retryId:operationId,expected:{kind:'source',groupId}},
  {type:'handoffStatus',retryId:operationId},{type:'cancelHandoff',retryId:operationId},
  {type:'answerHandoff',request:{retryId:operationId,generation:1,ref:operationId,lease:digest,versions:[]},attestations:[]},
  { type: 'richSourceOptions', groupId },
  { type: 'richInventory', groupId, options },
  { type: 'richPrepare', groupId, selection: { options, selected: [], reviewToken: digest, sourceAttested: true,
    public: { name: 'fixture', summary: '', overview: '', version: '1' }, access: 'direct', setup: [] }, attestations: [] },
  { type: 'richEdit', draftId, baseRevision: 1, canonical: 'e30', selected: [] },
  { type: 'richReadMember', operationId, index: 0, reviewDigest: digest },
  { type: 'richMembers', operationId },
  { type: 'richBindMembers', operationId, reviewDigest: digest, descriptors: [] },
  { type: 'richInspect', operationId },
  { type: 'richAdvance', operationId, destinationDraftId: draftId, authorization: { format: 'rich-v2', operationId,
    accountId: randomUUID(), purpose: 'prepareDraft', targetPublicKey: binary, nonceCommitment: binary,
    status: 'registered', stage: 'dispatch', stateRevision: 1, operationDeadline: 1, payloadDigest: digest,
    serverPublicKey: binary, ticket: binary, deadline: 1 } },
].map(payload => recipeAuthoringRequestSchema.parse({ botId, session, ...payload }));
const request = (payload: typeof payloads[number]): Request => ({ type: 'request', id: randomUUID(), method: 'recipeAuthoring', payload });
const handler = vi.fn(async () => { throw new RpcError('conflict', 'authoring business handler reached'); });
let fixture: Awaited<ReturnType<typeof startFixture>>;
let owner: Awaited<ReturnType<typeof socketClient>>;

beforeAll(async () => {
  fixture = await startFixture(fakeService({ recipeAuthoring: handler }));
  owner = await socketClient(fixture.api.port, fixture.credential, PROTOCOL_VERSION, 3000, 'desktop');
  await owner.ready();
});
beforeEach(() => { handler.mockClear(); });
afterAll(async () => { await owner?.close(); await fixture?.close(); });

test.each(payloads)('owner desktop dispatches $type to the authoring business handler', async payload => {
  expect(await owner.call(request(payload))).toMatchObject({ type: 'error', code: 'conflict', message: 'authoring business handler reached' });
  expect(handler).toHaveBeenCalledExactlyOnceWith(botId, { kind: 'recipeAuthoring', peer: expect.any(Object), request: payload });
});

test('unknown rich authoring actions do not reach the business handler', async () => {
  const id = randomUUID();
  owner.socket.send(JSON.stringify({ type: 'request', id, method: 'recipeAuthoring', payload: { type: 'richUnknown', botId, session } }));
  expect(await owner.wait(frame => frame.type === 'error' && frame.id === id)).toMatchObject({ type: 'error', code: 'invalid_request' });
  expect(handler).not.toHaveBeenCalled();
});

test.each(['web', 'cli'] as const)('owner %s observer cannot dispatch rich authoring', async clientKind => {
  const observer = await socketClient(fixture.api.port, fixture.credential, PROTOCOL_VERSION, 3000, clientKind);
  try {
    await observer.ready();
    for (const payload of payloads) expect(await observer.call(request(payload))).toMatchObject({ type: 'error', code: 'permission_denied' });
    expect(handler).not.toHaveBeenCalled();
  } finally { await observer.close(); }
});

test.each(['dm', 'group', 'comment'] as const)('Bot %s session cannot dispatch rich authoring even as a desktop client', async place => {
  const credential = fixture.sessionTokens.issue({ appId: botId, chatId: groupId, place, sessionId: 'ses_0123456789abcdef' });
  const bot = await socketClient(fixture.api.port, credential, PROTOCOL_VERSION, 3000, 'desktop');
  try {
    await bot.ready();
    const scope = place === 'comment' ? { bot: botId } : { bot: botId, group: groupId };
    expect(await bot.call({ type: 'request', id: 'negotiate', method: 'admin', payload: { type: 'negotiate', capabilities: ['cli'], scope } })).toMatchObject({ type: 'response' });
    for (const payload of payloads) expect(await bot.call(request(payload))).toMatchObject({ type: 'error', code: 'permission_denied' });
    expect(handler).not.toHaveBeenCalled();
  } finally { await bot.close(); }
});


test.each(['invalid-operation',42,{},[]].map(operationId=>({operationId})))('rejects malformed status operation scope $operationId',({operationId})=>{
  expect(recipeAuthoringRequestSchema.safeParse({type:'status',botId,session,operationId}).success).toBe(false);
});
