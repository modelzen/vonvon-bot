import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { recipeInstallRequestSchema, type RecipeAuthorization, type RecipeInstallReply, type RecipeInstallRequest, type RecipeManifest } from '@vonvon/protocol';
import type { DeviceIdentity } from '../src/remote/device';

const durability = vi.hoisted(() => ({fail: false}));
vi.mock('../src/config/bot-namespace', async original => {
  const actual = await original<typeof import('../src/config/bot-namespace')>();
  return {...actual, syncDirectory: async (directory: string) => {
    if (durability.fail && directory.endsWith('/cli_recipe_fixture')) {
      const raw = JSON.parse(await readFile(join(directory, 'projects.json'), 'utf8'));
      if (Object.values(raw.recipeInstallOperations ?? {}).some(value => (value as {status: string}).status === 'applied')) throw Object.assign(new Error('directory fsync failed'), {code: 'EIO'});
    }
    return actual.syncDirectory(directory);
  }};
});

const root = await mkdtemp(join(tmpdir(), 'vonvon-recipe-'));
vi.stubEnv('VONVON_HOME', root);
const { RecipeStore } = await import('../src/recipe/store');
const { RecipeInstaller, recipeApiOrigin } = await import('../src/recipe/installer');
const { parseManifest, sha256 } = await import('../src/recipe/manifest');
const { installProof, installTranscript } = await import('../src/recipe/proof');
const { addProject, getProjectByChatId, mutateProjectByChatId, removeProject, mutateProjectStore } = await import('../src/project/registry');
const { botPaths, useBotDir } = await import('../src/config/paths');
const { recipeInstallRpc } = await import('../src/server/rpc/recipe-install');
const { authorize } = await import('../src/server/authz');
const { createAdminService } = await import('../src/admin/service');
const { setSecret, getSecret } = await import('../src/config/keystore');
const { secretKeyForApp } = await import('../src/config/schema');
const botId = 'cli_recipe_fixture', groupId = 'oc_recipe_fixture', accountId = randomUUID();
const {publicKey, privateKey} = generateKeyPairSync('x25519');
const device: DeviceIdentity = {v: 1, deviceId: randomUUID(), name: 'Fixture', keypair: {
  publicKey: publicKey.export({format: 'jwk'}).x!, secretKey: privateKey.export({format: 'jwk'}).d!,
}};
const location = (id: string) => ({file: botPaths(id).projectsFile, dataRoot: root});
const store = () => new RecipeStore({targetPublicKey: device.keypair.publicKey, location, isInChat: async () => {}});
const manifest = (overrides: Partial<RecipeManifest> = {}): RecipeManifest => ({schema: 1, recipeId: '11111111-1111-4111-8111-111111111111',
  versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct', role: '负责整理群内问题。', ...overrides});
function encoded(value: RecipeManifest) { const bytes = Buffer.from(JSON.stringify(value)); return {manifest: bytes.toString('base64url'), manifestSha256: sha256(bytes)}; }
const prepare = (value = manifest(), extra = {}) => recipeInstallRequestSchema.parse({type: 'prepare', botId, groupId, accountId, ...encoded(value), ...extra});
async function prepared(value = manifest(), extra = {}) {
  const initial = prepare(value);
  if (initial.type !== 'prepare') throw new Error('fixture');
  const review = await store().prepare(initial);
  if (review.kind === 'prepared' && Object.keys(extra).length === 0) return review;
  if (review.kind !== 'review' && review.kind !== 'prepared') throw new Error('fixture');
  if (review.kind === 'prepared') await store().cancel(botId, review.operationId);
  const request = prepare(value, {resolution: {role: {kind: 'replace'}}, reviewToken: review.reviewToken, ...extra});
  if (request.type !== 'prepare') throw new Error('fixture');
  const result = await store().prepare(request);
  expect(result.kind).toBe('prepared');
  return result as Extract<RecipeInstallReply, {kind: 'prepared'}>;
}
const authorization = (value: Extract<RecipeInstallReply, {kind: 'prepared'}>): RecipeAuthorization => ({
  operationId: value.operationId, accountId, purpose: 'installBoundRole', generation: 1, deadline: Date.now() + 300000,
  versionId: value.versionId, manifestSha256: value.manifestSha256, targetPublicKey: value.targetPublicKey, nonceCommitment: value.nonceCommitment,
  serverPublicKey: generateKeyPairSync('x25519').publicKey.export({format: 'jwk'}).x!, ticket: Buffer.alloc(32, 2).toString('base64url'), status: 'authorized',
});
async function ready(value = manifest(), extra = {}) {
  const result = await prepared(value, extra);
  await store().authorize(botId, result.operationId, authorization(result));
  await store().redeemed(botId, result.operationId);
  return result;
}
async function row(id = botId) { return getProjectByChatId(groupId, botPaths(id).projectsFile); }
async function bind(id = botId, persona?: string) {
  await mkdir(botPaths(id).dir, {recursive: true});
  await addProject({name: 'Fixture group', chatId: groupId, cwd: '/tmp', blank: false, createdAt: 1,
    ...(persona === undefined ? {} : {profile: {persona, memory: '', inheritPersona: false, inheritMemory: false}})}, location(id));
}
beforeEach(async () => {
  durability.fail = false;
  await mkdir(root, {recursive: true});
  await rm(join(root, 'bots'), {recursive: true, force: true});
  await writeFile(join(root, 'bots.json'), JSON.stringify({version: 1, bots: [botId, 'cli_other_fixture'].map(appId => ({
    name: appId, appId, tenant: 'feishu', createdAt: 1, registrationId: randomUUID(),
  }))}));
  useBotDir(botId);
  await bind();
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(root, {recursive: true, force: true}); });

describe('durable role installation', () => {
  it('reads and ignores one exact future version on this Bot binding without changing another Bot in the same chat',async()=>{
    const current=manifest(), prepared=await ready(current);
    await store().apply(botId,prepared.operationId,async()=>{});
    await bind('cli_other_fixture');
    const get=(id:string)=>recipeInstallRequestSchema.parse({type:'source',botId:id,groupId}) as Extract<RecipeInstallRequest,{type:'source'}>;
    expect((await store().source(get('cli_other_fixture')))).toMatchObject({kind:'source',source:null});
    const versionId=randomUUID();
    const shown=await store().source(get(botId));
    if(shown.kind!=='source' || !shown.source)throw Error();
    const ignore=recipeInstallRequestSchema.parse({type:'ignoreVersion',botId,groupId,sourceToken:shown.source.sourceToken,recipeId:current.recipeId,installedVersionId:current.versionId,versionId});
    if(ignore.type!=='ignoreVersion')throw Error();
    expect(await store().source(ignore)).toMatchObject({kind:'source',source:{versionId:current.versionId,ignoredVersionId:versionId}});
    expect((await store().source(get('cli_other_fixture')))).toMatchObject({kind:'source',source:null});
    await expect(store().source({...ignore,installedVersionId:randomUUID()})).rejects.toThrow('来源已改变');
    const newer={...current,versionId:randomUUID(),revision:2};
    const p2=await ready(newer);
    await store().apply(botId,p2.operationId,async()=>{});
    const after=await store().source(get(botId));
    expect(after).toMatchObject({kind:'source',source:{versionId:newer.versionId}});
    expect(after.kind==='source' && after.source?.ignoredVersionId).toBeUndefined();
  });
  it('rejects ignoring an update shown before unbinding and reinstalling the exact same version on the same Bot',async()=>{
    const current=manifest();
    const original=await ready(current);await store().apply(botId,original.operationId,async()=>{});
    const read=recipeInstallRequestSchema.parse({type:'source',botId,groupId});
    if(read.type!=='source')throw Error();
    const shown=await store().source(read);
    if(shown.kind!=='source' || !shown.source)throw Error();
    await removeProject('Fixture group');await bind();
    const replacement=await ready(current);await store().apply(botId,replacement.operationId,async()=>{});
    const ignore=recipeInstallRequestSchema.parse({type:'ignoreVersion',botId,groupId,recipeId:current.recipeId,installedVersionId:current.versionId,
      versionId:randomUUID(),sourceToken:shown.source.sourceToken});
    if(ignore.type!=='ignoreVersion')throw Error();
    await expect(store().source(ignore)).rejects.toThrow();
    expect((await row())?.recipeInstall?.ignoredVersionId).toBeUndefined();
  });
  it('rejects a lower published revision before creating another operation', async () => {
    const current = manifest({revision: 2, role: '第二版职责'}), installed = await ready(current);
    await store().apply(botId, installed.operationId, async () => {});
    const file = botPaths(botId).projectsFile, before = await readFile(file, 'utf8');
    const request = prepare({...current, versionId: randomUUID(), revision: 1, role: '第一版职责'});
    if (request.type !== 'prepare') throw new Error('fixture');
    await expect(store().prepare(request)).rejects.toThrow('旧版本');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect((await row())?.supplement).toBe('第二版职责');
  });
  it('refuses an older prepared revision if a newer version wins before commit', async () => {
    const first = manifest({revision: 1}), second = {...first, versionId: randomUUID(), revision: 2, role: '第二版职责'};
    const old = await ready(first), fresh = await ready(second);
    await store().apply(botId, fresh.operationId, async () => {});
    expect(await store().apply(botId, old.operationId, async () => {})).toMatchObject({status: 'rejected'});
    expect((await row())?.recipeInstall?.revision).toBe(2);
  });
  it('adopts the incoming role when empty and requires a choice for a different legacy persona', async () => {
    const first = prepare();
    if (first.type !== 'prepare') throw new Error('fixture');
    expect(await store().prepare(first)).toMatchObject({kind: 'prepared', currentRole: '', roleChoiceRequired: false});
    await mutateProjectByChatId(groupId, value => { value.profile = {persona: '旧的职责', memory: '', inheritPersona: false, inheritMemory: false}; }, undefined, location(botId));
    expect(await store().prepare(first)).toMatchObject({kind: 'review', currentRole: '旧的职责'});
    const result = await ready(manifest(), {resolution: {role: {kind: 'keep'}}});
    expect(await store().apply(botId, result.operationId, async () => {})).toMatchObject({status: 'applied'});
    expect((await row())?.supplement).toBe('旧的职责');
  });
  it('commits role, base, setup and receipt together and retries after a new store instance', async () => {
    const value = manifest({setup: {steps: [{kind: 'tool', title: '工具', instructions: '自行检查工具', required: true}]}});
    const result = await ready(value), membership = vi.fn(async () => {});
    expect(await store().apply(botId, result.operationId, membership)).toMatchObject({status: 'applied'});
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(raw.projects[0]).toMatchObject({supplement: value.role, recipeInstall: {base: {role: value.role, setup: value.setup}, setup: value.setup}});
    expect(raw.recipeInstallOperations[result.operationId]).toMatchObject({status: 'applied'});
    if (process.platform !== 'win32') expect((await stat(botPaths(botId).projectsFile)).mode & 0o777).toBe(0o600);
    await store().apply(botId, result.operationId, membership);
    expect(membership).toHaveBeenCalledTimes(1);
    expect((await row())?.recipeInstall?.versionId).toBe(value.versionId);
  });
  it('rejects an edit made after preparation without overwriting it', async () => {
    const result = await ready();
    await mutateProjectByChatId(groupId, value => {value.supplement = '新编辑';}, undefined, location(botId));
    expect(await store().apply(botId, result.operationId, async () => {})).toMatchObject({status: 'rejected', reason: '群设置已改变'});
    expect((await row())?.supplement).toBe('新编辑');
    expect((await row())?.recipeInstall).toBeUndefined();
  });
  it('keeps the receipt across unbind/rebind and never applies an old operation to the new slot', async () => {
    const result = await ready(), original = (await row())!.bindingIncarnation;
    await removeProject('Fixture group');
    await bind();
    expect((await row())!.bindingIncarnation).not.toBe(original);
    expect(await store().apply(botId, result.operationId, async () => {})).toMatchObject({status: 'rejected', reason: '群绑定已改变'});
    expect((await row())?.supplement).toBeUndefined();
    expect(await store().status(botId, result.operationId)).toMatchObject({status: 'rejected'});
  });
  it('rejects a re-registered Bot incarnation', async () => {
    const result = await ready();
    const bots = JSON.parse(await readFile(join(root, 'bots.json'), 'utf8'));
    bots.bots[0].registrationId = randomUUID();
    await writeFile(join(root, 'bots.json'), JSON.stringify(bots));
    expect(await store().apply(botId, result.operationId, async () => {})).toMatchObject({status: 'rejected'});
    expect((await row())?.recipeInstall).toBeUndefined();
  });
  it('captures a legacy Bot identity without changing the running process registration', async () => {
    const bots = JSON.parse(await readFile(join(root, 'bots.json'), 'utf8'));
    delete bots.bots[0].registrationId;
    await writeFile(join(root, 'bots.json'), JSON.stringify(bots));
    const bytes = await readFile(join(root, 'bots.json'), 'utf8');
    const result = await ready();
    expect(await store().apply(botId, result.operationId, async () => {})).toMatchObject({status: 'applied'});
    expect(await readFile(join(root, 'bots.json'), 'utf8')).toBe(bytes);
  });
  it('isolates two Bots sharing the same physical group and checks actual membership at commit', async () => {
    await bind('cli_other_fixture');
    const result = await ready();
    const check = vi.fn(async (id: string, chat: string) => {expect([id, chat]).toEqual([botId, groupId]);});
    await store().apply(botId, result.operationId, check);
    expect((await row('cli_other_fixture'))?.supplement).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
    const next = await ready(manifest());
    expect(await store().apply(botId, next.operationId, async () => {throw new Error('not in chat');})).toMatchObject({status: 'rejected'});
  });
  it('retains a prepared operation after a failed rename and applies once on retry', async () => {
    const result = await ready();
    const broken = new RecipeStore({targetPublicKey: device.keypair.publicKey, location, isInChat: async () => {}, beforeCommit: () => {throw new Error('before rename');}});
    await expect(broken.apply(botId, result.operationId, async () => {})).rejects.toThrow('before rename');
    expect((await row())?.supplement).toBeUndefined();
    expect(await store().status(botId, result.operationId)).toMatchObject({status: 'in_progress'});
    expect(await store().apply(botId, result.operationId, async () => {})).toMatchObject({status: 'applied'});
  });
  it('requires three-way conflict resolution and leaves exact-version metadata untouched', async () => {
    const first = manifest(), result = await ready(first);
    await store().apply(botId, result.operationId, async () => {});
    await mutateProjectByChatId(groupId, value => {value.supplement = '本地改动';}, undefined, location(botId));
    const unchanged = prepare({...first, authorId: randomUUID(), revision: 999});
    if (unchanged.type !== 'prepare') throw new Error('fixture');
    expect(await store().prepare(unchanged)).toMatchObject({kind: 'alreadyInstalled'});
    expect((await row())?.recipeInstall?.revision).toBe(1);
    const update = prepare({...first, versionId: randomUUID(), revision: 2, role: '新版职责'});
    if (update.type !== 'prepare') throw new Error('fixture');
    expect(await store().prepare(update)).toMatchObject({kind: 'review', baseRole: first.role, currentRole: '本地改动', roleChoiceRequired: true});
    const chosen = await ready({...first, versionId: randomUUID(), revision: 2, role: '新版职责'}, {resolution: {role: {kind: 'custom', text: '合并后的职责'}}});
    await store().apply(botId, chosen.operationId, async () => {});
    expect((await row())?.supplement).toBe('合并后的职责');
    expect((await row())?.recipeInstall?.base.role).toBe('新版职责');
    const other = prepare(manifest({recipeId: randomUUID()}));
    if (other.type !== 'prepare') throw new Error('fixture');
    await expect(store().prepare(other)).rejects.toThrow('另一份配方');
  });
  it('never inherits setup completion by position when a version changes', async () => {
    const setup = {steps: [{kind: 'config' as const, title: 'A', instructions: 'A', required: true}]};
    const first = manifest({setup}), result = await ready(first);
    await store().apply(botId, result.operationId, async () => {});
    const incoming = {...first, versionId: randomUUID(), revision: 2, setup: {steps: [{...setup.steps[0]!, title: 'B', instructions: 'B'}]}};
    const update = await ready(incoming);
    await store().apply(botId, update.operationId, async () => {});
    expect((await row())?.recipeInstall?.setup).toEqual(incoming.setup);
  });
  it('binds every authorization field and refuses changed parameters on the same operation', async () => {
    const result = await prepared(), auth = authorization(result);
    for (const change of [{purpose: 'other'}, {targetPublicKey: Buffer.alloc(32).toString('base64url')},
      {nonceCommitment: Buffer.alloc(32).toString('base64url')}, {accountId: randomUUID()}, {versionId: randomUUID()}]) {
      await expect(store().authorize(botId, result.operationId, {...auth, ...change} as RecipeAuthorization)).rejects.toThrow();
    }
    await store().authorize(botId, result.operationId, auth);
    await expect(store().authorize(botId, result.operationId, {...auth, deadline: auth.deadline + 1})).rejects.toThrow('不一致');
    const bytes = Buffer.from(result.operationId.replaceAll('-', ''), 'hex');
    expect(bytes[6]! >> 4).toBe(7);
    expect(Math.abs(bytes.readUIntBE(0, 6) - Date.now())).toBeLessThan(10000);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain((await store().get(botId, result.operationId)).nonce);
  });
});

describe('bounded local preparations', () => {
  function clockStore(now: () => number) {return new RecipeStore({targetPublicKey: device.keypair.publicKey, location, now, isInChat: async () => {}});}
  it('preserves issuing across the five-minute boundary and restart so a delayed valid ticket can resume', async () => {
    const start = Date.now(); let now = start; const local = clockStore(() => now), input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
    now += 299000;
    expect(await local.issuing(botId, value.operationId)).toMatchObject({status: 'prepared', issuerState: 'issuing', stillNeedsTicket: true});
    now += 2000;
    const restarted = clockStore(() => now);
    expect(await restarted.status(botId, value.operationId)).toMatchObject({status: 'prepared', issuerState: 'issuing', stillNeedsTicket: true});
    const auth = {...authorization(value), deadline: start + 599000};
    await restarted.authorize(botId, value.operationId, auth);
    expect(await restarted.status(botId, value.operationId)).toMatchObject({status: 'in_progress', issuerState: 'authorized', stillNeedsTicket: false});
    const {ticket: _ticket, ...binding} = auth;
    const installer = new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, now: () => now, isInChat: async () => {},
      fetch: (async (url: string | URL | Request) => String(url).endsWith('/redeem')
        ? Response.json({...binding, status: 'redeemed', manifest: input.manifest})
        : Response.json({operationId: value.operationId, status: 'applied'})) as typeof fetch});
    expect(await installer.request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: value.operationId}))).toMatchObject({status: 'applied', issuerState: 'authorized', stillNeedsTicket: false});
    expect((await restarted.get(botId, value.operationId)).cloudCompletion).toBe('confirmed');
  });
  it('does not start issuing after an unissued preparation has expired', async () => {
    let now = Date.now(); const local = clockStore(() => now), input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
    const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
    now += 300001;
    expect(await local.issuing(botId, value.operationId)).toMatchObject({status: 'rejected', issuerState: 'unissued', stillNeedsTicket: false});
  });
  it('keeps issuing operations in the active budget beyond retention until trusted cloud reconciliation', async () => {
    let now = Date.now(); const local = clockStore(() => now), ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
      const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
      await local.issuing(botId, value.operationId); ids.push(value.operationId);
    }
    now += 9 * 86400000;
    const next = prepare(); if (next.type !== 'prepare') throw new Error('fixture');
    await expect(local.prepare(next)).rejects.toThrow('待完成');
    for (const id of ids) expect(await local.status(botId, id)).toMatchObject({status: 'prepared', issuerState: 'issuing', stillNeedsTicket: true});
  });
  it('treats a legacy missing issuer marker as unknown instead of assuming no authorization was dispatched', async () => {
    let now = Date.now(); const local = clockStore(() => now), input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
    const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
    const file = botPaths(botId).projectsFile, raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.recipeInstallOperations[value.operationId].issuerState; await writeFile(file, JSON.stringify(raw));
    now += 9 * 86400000;
    expect(await local.status(botId, value.operationId)).toMatchObject({status: 'prepared', issuerState: 'issuing', stillNeedsTicket: true});
  });
  it('reuses an exact unissued preparation with the same UUID and private nonce across retries', async () => {
    const local = clockStore(() => Date.now()), input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const initial = await local.prepare(input); if (initial.kind !== 'prepared') throw new Error('fixture');
    const originalNonce = (await local.get(botId, initial.operationId)).nonce;
    const replies = [initial, ...await Promise.all(Array.from({length: 3}, () => local.prepare(input)))];
    expect(replies.every(reply => reply.kind === 'prepared')).toBe(true);
    expect(new Set(replies.map(reply => reply.kind === 'prepared' ? reply.operationId : 'wrong')).size).toBe(1);
    expect(new Set(replies.map(reply => reply.kind === 'prepared' ? reply.nonceCommitment : 'wrong')).size).toBe(1);
    expect((await local.get(botId, initial.operationId)).nonce).toBe(originalNonce);
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(Object.keys(raw.recipeInstallOperations)).toHaveLength(1);
  });
  it('keeps distinct accounts and binding lifetimes out of the reuse fingerprint', async () => {
    const local = clockStore(() => Date.now()), input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const first = await local.prepare(input), second = await local.prepare({...input, accountId: randomUUID()});
    await removeProject('Fixture group'); await bind();
    const rebound = await local.prepare(input);
    expect(new Set([first, second, rebound].map(reply => reply.kind === 'prepared' ? reply.operationId : 'wrong')).size).toBe(3);
  });
  it('limits distinct active preparations to three for one account', async () => {
    const local = clockStore(() => Date.now());
    for (let index = 0; index < 3; index++) {
      const input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
      expect(await local.prepare(input)).toMatchObject({kind: 'prepared'});
    }
    const fourth = prepare(); if (fourth.type !== 'prepare') throw new Error('fixture');
    await expect(local.prepare(fourth)).rejects.toThrow('待完成');
  });
  it('shares the three-active budget across Bots and frees a slot after a safe local cancellation', async () => {
    await bind('cli_other_fixture');
    const local = clockStore(() => Date.now()), ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
      const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture'); ids.push(value.operationId);
    }
    const other = prepare(manifest(), {botId: 'cli_other_fixture'}); if (other.type !== 'prepare') throw new Error('fixture');
    await expect(local.prepare(other)).rejects.toThrow('待完成');
    await local.cancel(botId, ids[0]!);
    expect(await local.prepare(other)).toMatchObject({kind: 'prepared'});
  });
  it('expires an unissued preparation after five minutes and prunes its safe receipt after eight days', async () => {
    let now = Date.now(); const local = clockStore(() => now), input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const old = await local.prepare(input); if (old.kind !== 'prepared') throw new Error('fixture');
    now += 300001;
    const fresh = await local.prepare(input); if (fresh.kind !== 'prepared') throw new Error('fixture');
    expect(fresh.operationId).not.toBe(old.operationId);
    expect(await local.status(botId, old.operationId)).toMatchObject({status: 'rejected'});
    now += 8 * 86400000 + 600000;
    await local.prepare(input);
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(raw.recipeInstallOperations[old.operationId]).toBeUndefined();
    expect(raw.recipeInstallOperations[fresh.operationId]).toBeUndefined();
  });
  it('does not attach a late authorization after the unissued preparation expires', async () => {
    let now = Date.now(); const local = clockStore(() => now), input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
    const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
    now += 300001;
    expect(await local.authorize(botId, value.operationId, authorization(value))).toMatchObject({status: 'rejected', cloudCompletion: 'none'});
    expect((await local.get(botId, value.operationId)).authorization).toBeUndefined();
  });
  it('caps newly created entries per account and UTC day while exact retries do not consume that budget', async () => {
    const now = Date.now(), local = clockStore(() => now);
    for (let index = 0; index < 60; index++) {
      const input = prepare(); if (input.type !== 'prepare') throw new Error('fixture');
      const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
      expect(await local.prepare(input)).toMatchObject({operationId: value.operationId});
      await local.cancel(botId, value.operationId);
    }
    const next = prepare(); if (next.type !== 'prepare') throw new Error('fixture');
    await expect(local.prepare(next)).rejects.toThrow('今天');
  }, 15000);
  it.each(['entries', 'bytes'] as const)('blocks new work at the hard %s bound without discarding uncertain authorizations', async limit => {
    let now = Date.now(); const local = clockStore(() => now);
    const large = manifest({role: 'r'.repeat(5000), setup: {steps: Array.from({length: 8}, () => ({kind: 'context' as const, title: 'Text', instructions: 'i'.repeat(2048), required: true}))}});
    const input = prepare(limit === 'bytes' ? large : manifest()); if (input.type !== 'prepare') throw new Error('fixture');
    const value = await local.prepare(input); if (value.kind !== 'prepared') throw new Error('fixture');
    await local.authorize(botId, value.operationId, authorization(value));
    const prototype = await local.get(botId, value.operationId), records: Record<string, typeof prototype> = {};
    for (let index = 0; index < (limit === 'entries' ? 512 : 128); index++) {
      const id = randomUUID(), actor = randomUUID();
      records[id] = {...prototype, operationId: id, accountId: actor,
        authorization: {...prototype.authorization!, operationId: id, accountId: actor}};
    }
    const file = botPaths(botId).projectsFile, raw = JSON.parse(await readFile(file, 'utf8'));
    raw.recipeInstallOperations = records; await writeFile(file, JSON.stringify(raw));
    now += 9 * 86400000;
    const next = prepare(); if (next.type !== 'prepare') throw new Error('fixture');
    await expect(local.prepare(next)).rejects.toThrow(limit === 'entries' ? '记录已达上限' : '容量上限');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(saved.recipeInstallOperations)).toHaveLength(Object.keys(records).length);
  });
  it('preserves old uncertain authorizations and required cloud completions while reclaiming safe receipts', async () => {
    let now = Date.now(); const local = clockStore(() => now);
    const one = prepare(); if (one.type !== 'prepare') throw new Error('fixture');
    const uncertain = await local.prepare(one); if (uncertain.kind !== 'prepared') throw new Error('fixture');
    await local.authorize(botId, uncertain.operationId, authorization(uncertain));
    const two = prepare(); if (two.type !== 'prepare') throw new Error('fixture');
    const required = await local.prepare(two); if (required.kind !== 'prepared') throw new Error('fixture');
    await local.authorize(botId, required.operationId, authorization(required)); await local.redeemed(botId, required.operationId);
    await local.apply(botId, required.operationId, async () => {});
    const third = prepare(manifest({revision: 2})); if (third.type !== 'prepare') throw new Error('fixture');
    const safe = await local.prepare(third); if (safe.kind !== 'prepared') throw new Error('fixture');
    await local.authorize(botId, safe.operationId, authorization(safe)); await local.redeemed(botId, safe.operationId);
    await local.apply(botId, safe.operationId, async () => {}); await local.confirmCompletion(botId, safe.operationId);
    now += 8 * 86400000 + 600000;
    const next = prepare(manifest({revision: 3})); if (next.type !== 'prepare') throw new Error('fixture');
    await local.prepare(next);
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(raw.recipeInstallOperations[uncertain.operationId]?.authorization).toBeDefined();
    expect(raw.recipeInstallOperations[required.operationId]?.cloudCompletion).toBe('required');
    expect(raw.recipeInstallOperations[safe.operationId]).toBeUndefined();
  });
});

describe('normal Bot deletion preserves installation recovery', () => {
  async function stoppedService() {
    const bots = JSON.parse(await readFile(join(root, 'bots.json'), 'utf8'));
    bots.bots[0].active = false;
    await writeFile(join(root, 'bots.json'), JSON.stringify(bots));
    return createAdminService({liveStatus: async () => ({running: false})});
  }
  it.each(['issuing', 'authorized', 'completion'] as const)('blocks the actual deleteBot path for %s state without deleting credentials or receipts', async phase => {
    const value = await prepared();
    await setSecret(secretKeyForApp(botId), 'recipe-fixture-secret');
    if (phase === 'issuing') await store().issuing(botId, value.operationId);
    else await store().authorize(botId, value.operationId, authorization(value));
    if (phase === 'completion') {await store().redeemed(botId, value.operationId); await store().apply(botId, value.operationId, async () => {});}
    const service = await stoppedService(), registry = await readFile(join(root, 'bots.json'), 'utf8'), receipt = await readFile(botPaths(botId).projectsFile, 'utf8');
    expect(await service.deleteBot(botId)).toMatchObject({ok: false, reason: expect.stringContaining('恢复')});
    expect(await readFile(join(root, 'bots.json'), 'utf8')).toBe(registry);
    expect(await readFile(botPaths(botId).projectsFile, 'utf8')).toBe(receipt);
    expect(await getSecret(secretKeyForApp(botId))).toBe('recipe-fixture-secret');
  });
  it('still permits normal deletion after the cloud completion obligation is confirmed', async () => {
    const value = await ready(); await store().apply(botId, value.operationId, async () => {}); await store().confirmCompletion(botId, value.operationId);
    await setSecret(secretKeyForApp(botId), 'recipe-fixture-secret');
    expect(await (await stoppedService()).deleteBot(botId)).toMatchObject({ok: true});
    await expect(readFile(botPaths(botId).projectsFile, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(await getSecret(secretKeyForApp(botId))).toBeUndefined();
  });
});

describe('wire and security boundaries', () => {
  it('keeps an uncertain issuing operation until the daemon verifies a matching negative cloud response', async () => {
    const value = await prepared(); let unredeemable = false;
    const transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(String(url)).toBe(`https://recipes.example/v1/operations/${value.operationId}/unredeemable`);
      expect(JSON.parse(options!.body as string)).toEqual({accountId});
      expect(options?.headers).toEqual({'Content-Type': 'application/json'});
      expect(options?.redirect).toBe('error');
      return Response.json({operationId: value.operationId, unredeemable});
    });
    const installer = () => new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {}, fetch: transport as typeof fetch});
    await installer().request(recipeInstallRequestSchema.parse({type: 'issuing', botId, operationId: value.operationId}));
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'cancel', botId, operationId: value.operationId}))).toMatchObject({status: 'prepared', issuerState: 'issuing'});
    const request = recipeInstallRequestSchema.parse({type: 'reconcile', botId, operationId: value.operationId});
    expect(await installer().request(request)).toMatchObject({status: 'prepared', issuerState: 'issuing', stillNeedsTicket: true});
    unredeemable = true;
    expect(await installer().request(request)).toMatchObject({status: 'rejected', stillNeedsTicket: false});
    expect((await store().get(botId, value.operationId)).cloudCompletion).toBe('none');
    expect(await installer().request(request)).toMatchObject({status: 'rejected'});
    expect(transport).toHaveBeenCalledTimes(2);
    expect(recipeInstallRequestSchema.safeParse({type: 'reconcile', botId, operationId: value.operationId, unredeemable: true}).success).toBe(false);
  });
  it('does not close issuing from a mismatched cloud-negative response', async () => {
    const value = await prepared(); await store().issuing(botId, value.operationId);
    const installer = new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {},
      fetch: (async () => Response.json({operationId: randomUUID(), unredeemable: true})) as typeof fetch});
    await expect(installer.request(recipeInstallRequestSchema.parse({type: 'reconcile', botId, operationId: value.operationId}))).rejects.toThrow('不一致');
    expect(await store().status(botId, value.operationId)).toMatchObject({status: 'prepared', issuerState: 'issuing'});
  });
  it('does not report or complete a visible terminal receipt while its post-rename durability fence fails', async () => {
    const value = manifest(), preparation = await prepared(value), auth = authorization(preparation);
    const {ticket: _ticket, ...binding} = auth;
    const transport = vi.fn(async (url: string | URL | Request) => String(url).endsWith('/redeem')
      ? Response.json({...binding, status: 'redeemed', manifest: encoded(value).manifest})
      : Response.json({operationId: auth.operationId, status: 'applied'}));
    const member = vi.fn(async () => {});
    const installer = () => new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: member, fetch: transport as typeof fetch});
    durability.fail = true;
    await expect(installer().request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth}))).rejects.toMatchObject({code: 'EIO'});
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/complete'))).toHaveLength(0);
    expect((await row())?.supplement).toBe(value.role);
    await expect(store().status(botId, preparation.operationId)).rejects.toMatchObject({code: 'EIO'});
    const sameVersion = prepare(value);
    if (sameVersion.type !== 'prepare') throw new Error('fixture');
    await expect(store().prepare(sameVersion)).rejects.toMatchObject({code: 'EIO'});
    durability.fail = false;
    expect(await store().prepare(sameVersion)).toMatchObject({kind: 'alreadyInstalled', versionId: value.versionId});
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId}))).toMatchObject({status: 'applied'});
    expect(member).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.filter(([url]) => String(url).endsWith('/complete'))).toHaveLength(1);
  });
  it('returns a fresh review if the role changes before the owner sends the reviewed choice', async () => {
    await mutateProjectByChatId(groupId, value => {value.supplement = '正在审阅的职责';}, undefined, location(botId));
    const input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const review = await store().prepare(input);
    await mutateProjectByChatId(groupId, value => {value.supplement = '后来的职责';}, undefined, location(botId));
    const result = await store().prepare({...input, resolution: {role: {kind: 'replace'}}, reviewToken: (review as {reviewToken?: string}).reviewToken} as typeof input);
    expect(result).toMatchObject({kind: 'review', currentRole: '后来的职责'});
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(Object.keys(raw.recipeInstallOperations ?? {})).toHaveLength(0);
  });
  it.each(['binding', 'registration', 'manifest'] as const)('does not reuse a reviewed choice after %s changes', async change => {
    await mutateProjectByChatId(groupId, value => {value.supplement = '正在审阅的职责';}, undefined, location(botId));
    const input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const review = await store().prepare(input);
    if (review.kind !== 'review') throw new Error('fixture');
    if (change === 'binding') {await removeProject('Fixture group'); await bind();}
    if (change === 'registration') {
      const bots = JSON.parse(await readFile(join(root, 'bots.json'), 'utf8'));
      bots.bots[0].registrationId = randomUUID();
      await writeFile(join(root, 'bots.json'), JSON.stringify(bots));
    }
    const updated = change === 'manifest' ? {...input, ...encoded(manifest())} : input;
    const result = await store().prepare({...updated, reviewToken: review.reviewToken, resolution: {role: {kind: 'replace'}}});
    expect(result.kind).toBe('review');
    expect('reviewToken' in result && result.reviewToken).not.toBe(review.reviewToken);
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(Object.keys(raw.recipeInstallOperations ?? {})).toHaveLength(0);
  });
  it('durably names a legacy binding before its first review without creating an operation or nonce', async () => {
    const file = botPaths(botId).projectsFile, raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.projects[0].bindingIncarnation; delete raw.projects[0].projectSettingsRevision;
    raw.projects[0].supplement = '历史职责';
    await writeFile(file, JSON.stringify(raw));
    const input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    const review = await store().prepare(input);
    if (review.kind !== 'review') throw new Error('fixture');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    expect(saved.projects[0].bindingIncarnation).toMatch(/^[a-f0-9-]{36}$/);
    expect(saved.projects[0].projectSettingsRevision).toBe(0);
    expect(Object.keys(saved.recipeInstallOperations ?? {})).toHaveLength(0);
    await removeProject('Fixture group'); await bind();
    expect((await row())?.bindingIncarnation).not.toBe(saved.projects[0].bindingIncarnation);
    expect(await store().prepare({...input, reviewToken: review.reviewToken, resolution: {role: {kind: 'replace'}}})).toMatchObject({kind: 'review'});
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(after.recipeInstallOperations ?? {})).toHaveLength(0);
  });
  it('refuses preparation when the live Bot is not in the group without creating a nonce or operation', async () => {
    const memberStore = new RecipeStore({targetPublicKey: device.keypair.publicKey, location,
      isInChat: async () => {throw new Error('not in chat');}} as ConstructorParameters<typeof RecipeStore>[0]);
    const input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    await expect(memberStore.prepare(input)).rejects.toThrow('not in chat');
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(Object.keys(raw.recipeInstallOperations ?? {})).toHaveLength(0);
  });
  it('bounds a stalled membership check and releases the project lock without creating an operation', async () => {
    const memberStore = new RecipeStore({targetPublicKey: device.keypair.publicKey, location, membershipTimeoutMs: 10,
      isInChat: () => new Promise<void>(() => {})});
    const input = prepare();
    if (input.type !== 'prepare') throw new Error('fixture');
    await expect(memberStore.prepare(input)).rejects.toThrow('核验超时');
    await mutateProjectByChatId(groupId, value => {value.supplement = '锁已释放';}, undefined, location(botId));
    expect((await row())?.supplement).toBe('锁已释放');
    const raw = JSON.parse(await readFile(botPaths(botId).projectsFile, 'utf8'));
    expect(Object.keys(raw.recipeInstallOperations ?? {})).toHaveLength(0);
  });
  it('cancels an unissued operation and never dispatches a late authorization for it', async () => {
    const preparation = await prepared(), auth = authorization(preparation), transport = vi.fn();
    const installer = () => new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {}, fetch: transport as typeof fetch});
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'cancel', botId, operationId: preparation.operationId}))).toMatchObject({status: 'rejected'});
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth}))).toMatchObject({status: 'rejected'});
    expect((await store().get(botId, preparation.operationId)).cloudCompletion).toBe('none');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['authorized', 'redeemed'] as const)('reports in progress on cancel after %s, including after restart', async phase => {
    const preparation = await prepared();
    await store().authorize(botId, preparation.operationId, authorization(preparation));
    if (phase === 'redeemed') await store().redeemed(botId, preparation.operationId);
    const installer = () => new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {}});
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'cancel', botId, operationId: preparation.operationId}))).toMatchObject({status: 'in_progress'});
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'status', botId, operationId: preparation.operationId}))).toMatchObject({status: 'in_progress'});
    expect((await store().get(botId, preparation.operationId)).status).toBe(phase === 'authorized' ? 'prepared' : 'in_progress');
  });
  it('does not promise cancellation while an authorized redeem response is still outstanding', async () => {
    const value = manifest(), preparation = await prepared(value), auth = authorization(preparation);
    const {ticket: _ticket, ...binding} = auth;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => {release = resolve;}), started = new Promise<void>(resolve => {entered = resolve;});
    const installer = new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {},
      fetch: (async (url: string | URL | Request) => {
        if (String(url).endsWith('/redeem')) {entered(); await waiting; return Response.json({...binding, status: 'redeemed', manifest: encoded(value).manifest});}
        return Response.json({operationId: auth.operationId, status: 'applied'});
      }) as typeof fetch});
    const commit = installer.request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth}));
    await started;
    try {expect(await installer.request(recipeInstallRequestSchema.parse({type: 'cancel', botId, operationId: preparation.operationId}))).toMatchObject({status: 'in_progress'});}
    finally {release(); await commit.catch(() => undefined);}
    expect((await row())?.supplement).toBe(value.role);
  });
  it.each([{code: 'operation_cancelled', status: 409}, {code: 'operation_expired', status: 410}])('settles definitive pre-redeem $code without attempting a completion', async error => {
    const preparation = await prepared(), auth = authorization(preparation);
    const transport = vi.fn(async () => Response.json({error: {code: error.code}}, {status: error.status}));
    const installer = new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {}, fetch: transport as typeof fetch});
    expect(await installer.request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth}))).toMatchObject({status: 'rejected'});
    expect(await installer.request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId}))).toMatchObject({status: 'rejected'});
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await row())?.supplement).toBeUndefined();
  });
  it('does not turn an already redeemed operation into an unredeemed cloud rejection', async () => {
    const preparation = await ready();
    const installer = new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {},
      fetch: (async () => Response.json({error: {code: 'operation_expired'}}, {status: 410})) as typeof fetch});
    await expect(installer.request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId}))).rejects.toThrow('(410)');
    expect(await store().status(botId, preparation.operationId)).toMatchObject({status: 'in_progress'});
    expect((await store().get(botId, preparation.operationId)).cloudCompletion).toBe('required');
  });
  it('reports a local CAS rejection to cloud after redemption and retains that completion obligation on retry', async () => {
    const value = manifest(), preparation = await prepared(value), auth = authorization(preparation);
    const {ticket: _ticket, ...binding} = auth;
    await mutateProjectByChatId(groupId, value => {value.supplement = '并发修改';}, undefined, location(botId));
    const outcomes: string[] = [];
    let failComplete = true;
    const transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      if (String(url).endsWith('/redeem')) return Response.json({...binding, status: 'redeemed', manifest: encoded(value).manifest});
      const body = JSON.parse(options!.body as string); outcomes.push(body.outcome);
      if (failComplete) {failComplete = false; throw new Error('lost rejected receipt');}
      return Response.json({operationId: auth.operationId, status: body.outcome});
    });
    const installer = () => new RecipeInstaller({apiOrigin: 'https://recipes.example', device, location, isInChat: async () => {}, fetch: transport as typeof fetch});
    await expect(installer().request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth}))).rejects.toThrow('lost rejected receipt');
    expect((await store().get(botId, preparation.operationId)).cloudCompletion).toBe('required');
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId}))).toMatchObject({status: 'rejected'});
    expect(outcomes).toEqual(['rejected', 'rejected']);
    expect((await store().get(botId, preparation.operationId)).cloudCompletion).toBe('confirmed');
    expect((await row())?.supplement).toBe('并发修改');
  });
  it('accepts 5000 Unicode code points and rejects 5001', () => {
    const max = encoded(manifest({role: '😀'.repeat(5000)}));
    expect(parseManifest(max.manifest, max.manifestSha256).role).toHaveLength(10000);
    const tooLong = encoded(manifest({role: '😀'.repeat(5001)}));
    expect(() => parseManifest(tooLong.manifest, tooLong.manifestSha256)).toThrow();
    expect(() => parseManifest(max.manifest + '=', max.manifestSha256)).toThrow();
  });
  it('matches the API golden X25519/HKDF transcript and proof', async () => {
    const fixture = JSON.parse(await readFile(new URL('./fixtures/recipe-install-proof.json', import.meta.url), 'utf8'));
    const secret = Buffer.from(fixture.rawPrivateHex, 'hex').toString('base64url');
    const key = createPrivateKey({key: {kty: 'OKP', crv: 'X25519', d: secret, x: fixture.binding.targetPublicKey}, format: 'jwk'});
    expect(createPublicKey(key).export({format: 'jwk'}).x).toBe(fixture.binding.targetPublicKey);
    const auth = {...fixture.binding, status: 'authorized', ticket: Buffer.alloc(32).toString('base64url')};
    expect(installTranscript(auth).toString('hex')).toBe(fixture.transcriptHex);
    expect(installProof({...device, keypair: {publicKey: fixture.binding.targetPublicKey, secretKey: secret}}, auth)).toBe(fixture.proof);
  });
  it('allows a fixed HTTPS origin and explicit loopback tests only', () => {
    expect(recipeApiOrigin('https://recipes.example')).toBe('https://recipes.example');
    for (const value of ['http://recipes.example', 'https://recipes.example/path', 'https://user@recipes.example', 'https://recipes.example?x=1', 'http://127.0.0.1:8080']) expect(() => recipeApiOrigin(value)).toThrow();
    expect(recipeApiOrigin('http://127.0.0.1:8080', true)).toBe('http://127.0.0.1:8080');
  });
  it('denies every Bot session and a principal bypass at the RPC boundary', async () => {
    const request = {type: 'request' as const, id: '1', method: 'recipeInstall' as const, payload: prepare()};
    for (const place of ['dm', 'group', 'comment'] as const) {
      const principal = {kind: 'bot-session' as const, sessionId: 's', appId: botId, place, chatId: groupId};
      expect(await authorize({principal, protocolVersion: 2, negotiated: true, scope: null}, request, {})).toMatchObject({ok: false});
      await expect(recipeInstallRpc(undefined, principal, request.payload)).rejects.toThrow('主人');
    }
    const owner = {principal: {kind: 'owner' as const, via: 'local' as const}, protocolVersion: 2, negotiated: true};
    expect(await authorize({...owner, scope: {bot: 'cli_other_fixture'}}, request, {})).toMatchObject({ok: false});
    expect(await authorize({...owner, scope: {bot: botId, group: 'Fixture group'}}, request, {groupsOf: async () => [{name: 'Fixture group', chatId: groupId}]})).toMatchObject({ok: false});
  });
  it('retries a lost completion response using the local receipt without applying twice', async () => {
    const value = manifest(), preparation = await prepared(value), auth = authorization(preparation);
    let failComplete = true;
    const membership = vi.fn(async () => {}), transport = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe('error'); expect(options?.headers).toEqual({'Content-Type': 'application/json'});
      const body = JSON.parse(options!.body as string);
      expect(Object.keys(body).sort()).toEqual(String(url).endsWith('/complete') ? ['nonce', 'outcome', 'proof', 'ticket'] : ['nonce', 'proof', 'ticket']);
      if (String(url).endsWith('/complete')) {
        if (failComplete) {failComplete = false; throw new Error('lost response');}
        return Response.json({operationId: auth.operationId, status: body.outcome});
      }
      const {ticket: _ticket, ...binding} = auth;
      return Response.json({...binding, status: 'redeemed', manifest: encoded(value).manifest});
    });
    const installer = () => new RecipeInstaller({apiOrigin: 'https://recipes.example', device, isInChat: membership, fetch: transport as typeof fetch, location});
    const request = recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth});
    await expect(installer().request(request)).rejects.toThrow('lost response');
    expect(await store().status(botId, preparation.operationId)).toMatchObject({status: 'applied'});
    expect(await installer().request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId}))).toMatchObject({status: 'applied'});
    expect(membership).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it('never applies a mismatched redeemed manifest', async () => {
    const value = manifest(), preparation = await prepared(value), auth = authorization(preparation);
    const {ticket: _ticket, ...binding} = auth;
    const installer = new RecipeInstaller({apiOrigin: 'https://recipes.example', device, isInChat: async () => {}, location,
      fetch: (async () => Response.json({...binding, status: 'redeemed', manifest: encoded(manifest()).manifest})) as typeof fetch});
    await expect(installer.request(recipeInstallRequestSchema.parse({type: 'commit', botId, operationId: preparation.operationId, authorization: auth}))).rejects.toThrow('不一致');
    expect((await row())?.supplement).toBeUndefined();
  });
  it('rejects private-chat rows even if their synthetic group id passes transport syntax', async () => {
    await mutateProjectStore(location(botId), async (_stored, rows) => {rows[0]!.dm = {people: {}}; return {changed: true, value: undefined};});
    const request = prepare();
    if (request.type !== 'prepare') throw new Error('fixture');
    await expect(store().prepare(request)).rejects.toThrow('现有群');
  });
});
