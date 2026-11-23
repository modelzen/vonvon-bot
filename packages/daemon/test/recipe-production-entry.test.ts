import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { agentIdSchema, groupIdSchema, canonicalizeRichRecipeContent, type RecipeRichContent, type RecipeInstallRequest } from '@vonvon/protocol';
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
test('a configured daemon rejects obsolete installer operations without changing the group or creating installation files', async () => {
  vi.stubGlobal('__VONVON_ACCOUNT_API_ORIGIN__', 'https://recipes.example.test');
  vi.stubEnv('VONVON_ACCOUNT_API_ORIGIN', 'https://ignored.example.test');
  const dir = botPaths(botId);
  await mkdir(dir.dir, {recursive: true});
  await writeFile(join(root, 'bots.json'), JSON.stringify({version: 1, bots: [{appId: botId, name: 'fixture', tenant: 'feishu', createdAt: 1, registrationId: randomUUID()}]}));
  await addProject({chatId: groupId, name: 'fixture', cwd: root, blank: false, createdAt: 1}, {file: dir.projectsFile, dataRoot: root});
  const before = await readFile(dir.projectsFile);
  const membership = vi.fn();
  const sessionTokens = createSessionTokens();
  const api = await startApi({sessionTokens, service: fakeService({assertGroupMembership: membership}), port: 0,
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
    } finally { await observer.close(); }
    const encoded = canonicalizeRichRecipeContent(content), sha = createHash('sha256').update(encoded.canonicalUTF8).digest('hex');
    const payload = {type: 'richPrepare' as const, botId, groupId, canonical: encoded.canonical, parts: {},
      preview: {accountId: randomUUID(), release: {format: 'rich-v2' as const, recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct' as const, contentSha256: sha, logicalBytes: encoded.logicalBytes},
        manifest: {objectId: randomUUID(), kind: 'manifest' as const, sha256: sha, bytes: encoded.canonicalUTF8.length, mediaType: 'application/json' as const}}};
    const filenames = await readdir(dir.dir);
    const operationId = randomUUID();
    const requests: RecipeInstallRequest[] = [
      payload,
      {...payload, reviewToken: 'f'.repeat(64)},
      {type: 'richCommit', botId, operationId},
      {type: 'richSetup', botId, groupId, action: {kind: 'read'}},
      {type: 'prepare', botId, groupId, accountId: randomUUID(), manifest: 'e30', manifestSha256: sha},
      {type: 'commit', botId, operationId},
      {type: 'source', botId, groupId},
    ];
    for (const request of requests) {
      expect(await owner.call({type: 'request', id: randomUUID(), method: 'recipeInstall', payload: request}))
        .toMatchObject({type: 'error', code: 'unsupported', message: expect.stringContaining('安装已停用')});
    }
    expect(await readFile(dir.projectsFile)).toEqual(before);
    expect(await readdir(dir.dir)).toEqual(filenames);
    expect(membership).not.toHaveBeenCalled();
  } finally { await owner.close(); await api.close(); }
});
