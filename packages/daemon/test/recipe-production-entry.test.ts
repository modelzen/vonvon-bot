import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { canonicalizeRichRecipeContent, type RecipeRichContent } from '@vonvon/protocol';
import { createHash } from 'node:crypto';
const root = await mkdtemp(join(tmpdir(), 'recipe-production-entry-'));
vi.stubEnv('VONVON_HOME', root);
vi.stubEnv('VONVON_RICH_RECIPE_TEST_RUNTIME', '');
vi.stubEnv('VONVON_RECIPE_BROKER_ORIGIN', 'https://untrusted.example.test');
const { fakeService, socketClient } = await import('./server-fixture');
vi.doUnmock('../src/config/paths');
const { startApi } = await import('../src/server/http');
const { addProject } = await import('../src/project/registry');
const { botPaths } = await import('../src/config/paths');
afterAll(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
const botId = 'cli_production_fixture', groupId = 'oc_production_fixture';
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
  const native = vi.fn(async () => ({kind: 'richSetup' as const, steps: [], tasks: []}));
  const membership = vi.fn(async () => {});
  const api = await startApi({service: fakeService({richRecipe: native, assertGroupMembership: membership}), port: 0,
    serviceActions: {platform: 'linux', readService: async () => ({supported: false, installed: false, running: false})}, distribution: async () => ({kind: 'unknown'})});
  const credential = (await readFile(join(root, 'local-credential'), 'utf8')).trim();
  const owner = await socketClient(api.port, credential);
  try {
    await owner.ready();
    const encoded = canonicalizeRichRecipeContent(content), sha = createHash('sha256').update(encoded.canonicalUTF8).digest('hex');
    const payload = {type: 'richPrepare' as const, botId, groupId, canonical: encoded.canonical, parts: {},
      preview: {accountId: randomUUID(), release: {format: 'rich-v2' as const, recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct' as const, contentSha256: sha, logicalBytes: encoded.logicalBytes},
        manifest: {objectId: randomUUID(), kind: 'manifest' as const, sha256: sha, bytes: encoded.canonicalUTF8.length, mediaType: 'application/json' as const}}};
    const prepared = await owner.call({type: 'request', id: 'prepare', method: 'recipeInstall', payload});
    expect(prepared.type, JSON.stringify(prepared)).toBe('response');
    expect(prepared).toMatchObject({payload: {kind: 'richReview'}});
    expect(membership).toHaveBeenCalledWith(botId, groupId, expect.objectContaining({appId: botId}));
    expect(await owner.call({type: 'request', id: 'setup', method: 'recipeInstall', payload: {type: 'richSetup', botId, groupId, action: {kind: 'read'}}})).toMatchObject({type: 'response', payload: {kind: 'richSetup'}});
    expect(native).toHaveBeenCalledWith(botId, {kind: 'richSetup', request: {type: 'richSetup', botId, groupId, action: {kind: 'read'}}});
  } finally { await owner.close(); await api.close(); }
});
