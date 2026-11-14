import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { agentIdSchema, groupIdSchema, canonicalizeRichRecipeContent, type RecipeRichContent } from '@vonvon/protocol';
import { createHash } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'recipe-production-entry-'));
vi.stubEnv('VONVON_HOME', root);
vi.stubEnv('VONVON_RICH_RECIPE_TEST_RUNTIME', '');
vi.stubEnv('VONVON_RECIPE_BROKER_ORIGIN', 'https://untrusted.example.test');
const { fakeService, socketClient } = await import('./server-fixture');
vi.doUnmock('../src/config/paths');
const { createSessionTokens } = await import('../src/host/session-tokens');
const { startApi } = await import('../src/server/http');
const { addProject } = await import('../src/project/registry');
const { botPaths } = await import('../src/config/paths');
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const botId = agentIdSchema.parse('cli_production_fixture'), groupId = groupIdSchema.parse('oc_production_fixture');
const identity = () => ({itemId: randomUUID(), originId: randomUUID()});
const value = (value: string) => ({...identity(), value});
const content: RecipeRichContent = {
  format: 'rich-v2', schemaVersion: 2,
  public: {name: value('fixture'), summary: value('fixture'), overview: value('fixture'), version: value('1')},
  role: {...identity(), text: {kind: 'inline', value: 'Fixture role'}},
  settings: [], rules: [], tasks: [], memories: [], skills: [], files: [], setup: [], parts: [],
};
test('normal configured startup prepares rich installs and dispatches native setup only for the owner', async () => {
  vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', 'https://recipes.example.test');
  vi.stubEnv('VONVON_ACCOUNT_API_ORIGIN', 'https://ignored.example.test');
  const dir = botPaths(botId);
  await mkdir(dir.dir, {recursive: true});
  await writeFile(join(root, 'bots.json'), JSON.stringify({version: 1, bots: [{appId: botId, name: 'fixture', tenant: 'feishu', createdAt: 1, registrationId: randomUUID()}]}));
  await addProject({chatId: groupId, name: 'fixture', cwd: root, blank: false, createdAt: 1}, {file: dir.projectsFile, dataRoot: root});
  const native = vi.fn(async () => ({kind: 'richSetup' as const, groupId, token: 'a'.repeat(64), steps: [], tasks: []}));
  const membership = vi.fn(async () => {});
  const sessionTokens = createSessionTokens();
  const api = await startApi({sessionTokens, service: fakeService({richRecipe: native, assertGroupMembership: membership}), port: 0,
    serviceActions: {platform: 'linux', readService: async () => ({supported: false, installed: false, running: false})}, distribution: async () => ({kind: 'unknown'})});
  const credential = (await readFile(join(root, 'local-credential'), 'utf8')).trim();
  const owner = await socketClient(api.port, credential);
  try {
    await owner.ready();
    const observer = await socketClient(api.port, sessionTokens.issue({appId: botId, chatId: groupId, place: 'group', sessionId: 'ses_0123456789abcdef'}));
    try {
      await observer.ready();
      expect(await observer.call({type: 'request', id: 'scope', method: 'admin', payload: {type: 'negotiate', capabilities: ['cli'], scope: {bot: botId, group: groupId}}})).toMatchObject({type: 'response'});
      expect(await observer.call({type: 'request', id: 'observer', method: 'recipeInstall', payload: {type: 'richSetup', botId, groupId, action: {kind: 'read'}}})).toMatchObject({type: 'error', code: 'permission_denied'});
      expect(native).not.toHaveBeenCalled();
    } finally { await observer.close(); }
    const encoded = canonicalizeRichRecipeContent(content), sha = createHash('sha256').update(encoded.canonicalUTF8).digest('hex');
    const payload = {type: 'richPrepare' as const, botId, groupId, canonical: encoded.canonical, parts: {},
      preview: {accountId: randomUUID(), release: {format: 'rich-v2' as const, recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct' as const, contentSha256: sha, logicalBytes: encoded.logicalBytes},
        manifest: {objectId: randomUUID(), kind: 'manifest' as const, sha256: sha, bytes: encoded.canonicalUTF8.length, mediaType: 'application/json' as const}}};
    const prepared = await owner.call({type: 'request', id: 'prepare', method: 'recipeInstall', payload});
    expect(prepared.type, JSON.stringify(prepared)).toBe('response');
    expect(prepared).toMatchObject({payload: {kind: 'richReview'}});
    expect(membership).toHaveBeenCalledWith(botId, groupId, expect.objectContaining({appId: botId}));
    if (prepared.type !== 'response' || prepared.method !== 'recipeInstall' || prepared.payload.kind !== 'richReview') throw Error('missing review');
    const plan = await owner.call({type: 'request', id: 'plan', method: 'recipeInstall', payload: {...payload, reviewToken: prepared.payload.reviewToken}});
    if (plan.type !== 'response' || plan.method !== 'recipeInstall' || plan.payload.kind !== 'richPrepared') throw Error(JSON.stringify(plan));
    const operationId = plan.payload.operationId;
    expect(await owner.call({type: 'request', id: 'issuing', method: 'recipeInstall', payload: {type: 'richIssuing', botId, operationId}})).toMatchObject({type: 'response'});
    const authorization = {...plan.payload.intent, operationId, accountId: payload.preview.accountId,
      deadline: Date.now() + 60000, ticket: Buffer.alloc(32, 1).toString('base64url'),
      serverPublicKey: generateKeyPairSync('x25519').publicKey.export({format: 'jwk'}).x!, status: 'authorized' as const};
    const network = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://recipes.example.test');
      if (url.pathname.endsWith('/redeem')) {
        const {ticket: _ticket, ...binding} = authorization;
        return Response.json({...binding, ...payload.preview, status: 'redeemed'});
      }
      expect(url.pathname).toBe(`/v2/operations/${operationId}/objects/${payload.preview.manifest.objectId}`);
      throw Error('fixture stops before object staging');
    });
    vi.stubGlobal('fetch', network);
    expect(await owner.call({type: 'request', id: 'wrong-account', method: 'recipeInstall', payload: {type: 'richCommit', botId, operationId, authorization: {...authorization, accountId: randomUUID()}}})).toMatchObject({type: 'error', message: '授权与本机准备不符'});
    expect(network).not.toHaveBeenCalled();
    expect(await owner.call({type: 'request', id: 'commit', method: 'recipeInstall', payload: {type: 'richCommit', botId, operationId, authorization}})).toMatchObject({type: 'error', message: 'fixture stops before object staging'});
    expect(network).toHaveBeenCalledTimes(2);

    expect(await owner.call({type: 'request', id: 'setup', method: 'recipeInstall', payload: {type: 'richSetup', botId, groupId, action: {kind: 'read'}}})).toMatchObject({type: 'response', payload: {kind: 'richSetup'}});
    expect(native).toHaveBeenCalledWith(botId, {kind: 'richSetup', request: {type: 'richSetup', botId, groupId, action: {kind: 'read'}}});
  } finally { await owner.close(); await api.close(); }
});

test.each(['', 'http://127.0.0.1:4317', 'https://recipes.example.test/api', 'https://user:password@recipes.example.test'])('normal startup rejects an unconfigured or invalid pinned service %s', async origin => {
  vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', origin);
  vi.stubEnv('VONVON_ACCOUNT_API_ORIGIN', 'https://ambient.example.test');
  const native = vi.fn();
  const api = await startApi({service: fakeService({richRecipe: native}), port: 0,
    serviceActions: {platform: 'linux', readService: async () => ({supported: false, installed: false, running: false})}, distribution: async () => ({kind: 'unknown'})});
  const owner = await socketClient(api.port, (await readFile(join(root, 'local-credential'), 'utf8')).trim());
  try {
    await owner.ready();
    expect(await owner.call({type: 'request', id: 'unsupported', method: 'recipeInstall', payload: {type: 'richSetup', botId, groupId, action: {kind: 'read'}}})).toMatchObject({type: 'error', code: 'unsupported', message: '此设备尚未配置配方服务'});
    expect(native).not.toHaveBeenCalled();
  } finally { await owner.close(); await api.close(); }
});
