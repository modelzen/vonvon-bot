import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let scratch: string;
let entry: string;
const children = new Set<ChildProcess>();
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'bot-writers-')));
  entry = join(scratch, 'bots.cjs');
  await build({ entryPoints: [fileURLToPath(new URL('../src/config/bots.ts', import.meta.url))], outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
});
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => once(child, 'exit')));
  await rm(scratch, { recursive: true, force: true });
});
async function home(): Promise<string> { return mkdtemp(join(scratch, 'data-')); }
function run(root: string, code: string) {
  const child = spawn(process.execPath, ['-e', `const m=require(${JSON.stringify(entry)});(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
    { env: { ...process.env, VONVON_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { children.delete(child); resolve({ code, stdout, stderr }); });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', () => { if (stdout.includes('ready')) resolve(); });
    child.once('exit', () => { if (!stdout.includes('ready')) reject(new Error(stderr || 'child exited before ready')); });
  });
  // Most callers only await done; don't create an unhandled readiness rejection.
  void ready.catch(() => undefined);
  return { child, done, ready };
}
async function registry(root: string) { return JSON.parse(await readFile(join(root, 'bots.json'), 'utf8')); }
const identity = (appId: string, desiredName = 'shared') => JSON.stringify({ appId, tenant: 'feishu', desiredName });
const register = (id: string) => `await m.registerBotEntry(${identity(id)},async()=>{});`;
async function successful(root: string, code: string) {
  const result = await run(root, code).done;
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return result.stdout;
}

describe('real bot writer ownership', () => {
  it('draws 50 unique short numbers, then issues consecutive badges across processes without recycling retired numbers', async () => {
    const root = await home();
    const bots = Array.from({length: 50}, (_, i) => ({appId: 'legacy' + i, name: 'legacy' + i, tenant: 'feishu', createdAt: 1}));
    const manual = {appId: 'manual', name: 'manual', tenant: 'feishu', createdAt: 1, badgeNumber: '10001'};
    await writeFile(join(root, 'bots.json'), JSON.stringify({version: 1, bots: [...bots, manual]}));
    await successful(root, 'await m.ensureRegistry()');
    const migrated = await registry(root);
    const pool: string[] = migrated.bots.slice(0, 50).map((bot: {badgeNumber: string}) => bot.badgeNumber);
    expect(new Set(pool).size).toBe(50);
    expect(pool.every(number => /^\d{3,4}$/.test(number))).toBe(true);
    expect(pool).toEqual(expect.arrayContaining(['007', '404', '1024', '2048', '2333', '3141', '4242', '9527']));
    expect(migrated.bots[50]).toEqual(manual);
    // Simulate rows assigned by the old build that had not yet saved issuance history.
    delete migrated.badgeIssuance;
    await writeFile(join(root, 'bots.json'), JSON.stringify(migrated));
    await successful(root, `await m.setBotBadgeNumber('legacy0','0000001');
      const row=(await m.loadBots()).bots.find(b=>b.appId==='legacy1');
      await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}});`);
    await Promise.all(['alpha', 'beta'].map(id => successful(root, register(id))));
    let saved = await registry(root);
    const automatic: string[] = saved.bots.filter((bot: {appId: string}) => ['alpha', 'beta'].includes(bot.appId)).map((bot: {badgeNumber: string}) => bot.badgeNumber);
    expect(automatic.sort()).toEqual(['10000', '10002']);
    expect(saved.badgeIssuance).toEqual({usedFavorites: expect.arrayContaining(pool), nextSequential: 10003});
    // Manually reclaim a retired favorite, while a duplicate of a currently worn number is refused.
    const changes = JSON.parse(await successful(root, `console.log(JSON.stringify([
      await m.setBotBadgeNumber('alpha', ${JSON.stringify(pool[0])}),
      await m.setBotBadgeNumber('beta', ${JSON.stringify(pool[0])}),
    ]))`));
    expect(changes).toEqual([{ok: true}, {ok: false, reason: '这个工号已有 Bot 使用。'}]);
    await successful(root, register('gamma'));
    saved = await registry(root);
    expect(saved.bots.find((bot: {appId: string}) => bot.appId === 'gamma').badgeNumber).toBe('10003');
    expect(saved.bots.find((bot: {appId: string}) => bot.appId === 'legacy0').badgeNumber).toBe('0000001');
  });

  it('commits the last sequential number only with its registration and refuses exhaustion before provisioning another bot', async () => {
    const root = await home();
    const bots = Array.from({length: 50}, (_, i) => ({appId: 'bot' + i, name: 'bot' + i, tenant: 'feishu', createdAt: 1}));
    await writeFile(join(root, 'bots.json'), JSON.stringify({version: 1, bots}));
    await successful(root, 'await m.ensureRegistry()');
    const seeded = await registry(root);
    seeded.badgeIssuance.nextSequential = 9_999_999;
    await writeFile(join(root, 'bots.json'), JSON.stringify(seeded));
    const interrupted = await run(root, `await m.registerBotEntry(${identity('last')},async()=>{throw Error('account failure')});`).done;
    expect(interrupted.stderr).toContain('account failure');
    expect((await registry(root)).badgeIssuance.nextSequential).toBe(9_999_999);
    await successful(root, register('last'));
    const final = await registry(root);
    expect(final.bots.at(-1).badgeNumber).toBe('9999999');
    const refused = await run(root, register('after')).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('自动工号已发完');
    expect(await registry(root)).toEqual(final);
  });

  it('does not retain prior entries in a later missing registry in the same loaded module', async () => {
    const root = await home();
    const output = await successful(root, register('temporary') + `require('node:fs').unlinkSync(${JSON.stringify(join(root, 'bots.json'))});process.stdout.write(JSON.stringify(await m.loadBots()));`);
    expect(JSON.parse(output)).toEqual({ version: 1, bots: [] });
  });
  it('retains different concurrent apps, chooses unique names, and preserves unknown metadata', async () => {
    const root = await home();
    await writeFile(join(root, 'bots.json'), JSON.stringify({ version: 1, future: { keep: true }, bots: [
      { appId: 'old', name: 'old', tenant: 'feishu', createdAt: 1, extra: 'keep' },
    ] }));
    await Promise.all(['alpha', 'beta', 'gamma'].map(id => successful(root, register(id))));
    const saved = await registry(root);
    expect(saved.future).toEqual({ keep: true });
    expect(saved.bots.map((bot: { appId: string }) => bot.appId).sort()).toEqual(['alpha', 'beta', 'gamma', 'old']);
    expect(new Set(saved.bots.map((bot: { name: string }) => bot.name)).size).toBe(4);
    expect(saved.bots.find((bot: { appId: string }) => bot.appId === 'old')).toEqual({ appId: 'old', name: 'old', tenant: 'feishu', createdAt: 1, extra: 'keep' });
    expect(saved.bots.filter((bot: { appId: string }) => bot.appId !== 'old').every((bot: { registrationId: string }) => /^[\da-f-]{36}$/.test(bot.registrationId))).toBe(true);
  });

  it('invokes the account callback once for a concurrent app and cannot mutate the selected row', async () => {
    const root = await home();
    const marker = join(root, 'accounts');
    const code = `await m.registerBotEntry(${identity('same')},async selected=>{
      require('node:fs').appendFileSync(${JSON.stringify(marker)},'once');
      if(!Object.isFrozen(selected.entry))throw Error('not frozen');
      try{selected.entry.name='corrupted'}catch{};
    });`;
    await Promise.all([successful(root, code), successful(root, code)]);
    expect(await readFile(marker, 'utf8')).toBe('once');
    expect((await registry(root)).bots).toHaveLength(1);
    expect((await registry(root)).bots[0].name).toBe('shared');
  });

  it('applies concurrent activation deltas without losing either, retaining legacy fallback', async () => {
    const root = await home();
    await successful(root, register('alpha') + register('beta') + register('gamma'));
    await Promise.all(['beta', 'gamma'].map(id => successful(root, `await m.setBotActivation('${id}',true)`)));
    let saved = await registry(root);
    expect(saved.bots.map((bot: { active: boolean }) => bot.active)).toEqual([true, true, true]);
    await Promise.all(['alpha', 'beta'].map(id => successful(root, `await m.setBotActivation('${id}',false)`)));
    saved = await registry(root);
    expect(saved.bots.map((bot: { active: boolean }) => bot.active)).toEqual([false, false, true]);
    expect(saved.current).toBe('gamma');
  });

  it('releases owned registration after SIGKILL and coordinates canonical aliases', async () => {
    const root = await home();
    // Data roots reject a final-component symlink; an ancestor alias still canonicalizes.
    const alias = join(scratch, 'parent-alias');
    await symlink(scratch, alias);
    const held = run(root, `await m.registerBotEntry(${identity('killed')},async()=>{process.stdout.write('ready');await new Promise(()=>{setInterval(()=>{},1000)})});`);
    await held.ready;
    const next = run(join(alias, basename(root)), register('after'));
    const exited = once(held.child, 'exit');
    held.child.kill('SIGKILL');
    await exited;
    const result = await next.done;
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect((await registry(root)).bots.map((bot: { appId: string }) => bot.appId)).toEqual(['after']);
  });

  it('does not publish a failed callback and releases ownership for later writers', async () => {
    const root = await home();
    const failed = await run(root, `await m.registerBotEntry(${identity('failed')},async()=>{throw Error('account failed')});`).done;
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('account failed');
    await successful(root, register('later'));
    expect((await registry(root)).bots.map((bot: { appId: string }) => bot.appId)).toEqual(['later']);
  });

  it('migrates a legacy flat bot before registration is the first registry mutation', async () => {
    const root = await home();
    const flat = { accounts: { app: { id: 'legacy', secret: 'fixture', tenant: 'feishu' } }, preferences: { extra: true } };
    await writeFile(join(root, 'config.json'), JSON.stringify(flat));
    await writeFile(join(root, 'projects.json'), JSON.stringify({ version: 1, projects: [{ cwd: '/legacy-unmoved' }] }));
    await successful(root, register('new'));
    expect((await registry(root)).bots.map((bot: { appId: string }) => bot.appId)).toEqual(['legacy', 'new']);
    expect(JSON.parse(await readFile(join(root, 'bots', 'legacy', 'config.json'), 'utf8'))).toEqual(flat);
    expect(JSON.parse(await readFile(join(root, 'bots', 'legacy', 'projects.json'), 'utf8')).projects[0].cwd).toBe('/legacy-unmoved');
    expect(Object.keys((await registry(root)).allocations)).toEqual(['new']);
  });
});

it('reserves import app IDs before normal registration and preserves foreign incarnations during rollback', async () => {
  const root = await home(), txId = '11111111-1111-4111-8111-111111111111';
  const journalFile = join(root, 'import/bridge/journal.json');
  await mkdir(join(root, 'import/bridge'), {recursive: true});
  const journal = {version: 1, txId, hostPid: process.pid, startedAt: 1, uid: 501, bridgeDir: join(root, 'old'), plistFile: join(root, 'old.plist'),
    reservedAppIds: ['migrating'], acquiredLocks: [], before: {plist: {present: false}, serviceLoaded: false, holders: [{appId: 'migrating', pid: null, startedAt: null}]},
    stageDir: join(root, 'import/bridge', txId), stageIdentity: null, intents: [], step: 'staging', cleanupPending: false, outcome: null};
  await successful(root, `await m.reserveImportedBots(['migrating'],async()=>require('node:fs').writeFileSync(${JSON.stringify(journalFile)},${JSON.stringify(JSON.stringify(journal))}));`);
  const blocked = await run(root, `await m.registerBotEntry(${identity('migrating')},async()=>{throw Error('credential callback must not run')});`).done;
  expect(blocked.code).toBe(1); expect(blocked.stderr).toContain('正在从 bridge 导入');
  const registered = await successful(root, `await m.registerBotEntry(${identity('migrating')},async()=>{},{txId:${JSON.stringify(txId)},registrationId:'owned-import',onBeforePublish:async handle=>process.stdout.write(handle)});`);
  expect(registered).toBe('shared');
  for (const code of [
    `const entry=(await m.loadBots()).bots[0];await m.commitBotCredentialRefresh(m.botIdentity(entry),async()=>{throw Error('must not write')});`,
    `const entry=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(entry),{isRunning:async()=>false,cleanup:async()=>{throw Error('must not delete')}});`,
  ]) {const result = await run(root, code).done; expect(result.code).toBe(1); expect(result.stderr).toContain('正在从 bridge 导入');}
  const foreign = await run(root, `await m.unregisterImportedBots([{appId:'migrating',registrationId:'different',handle:'shared'}]);`).done;
  expect(foreign.code).toBe(1); expect((await registry(root)).bots).toHaveLength(1);
  await successful(root, `await m.unregisterImportedBots([{appId:'migrating',registrationId:'owned-import',handle:'shared'}]);`);
  expect((await registry(root)).bots).toHaveLength(0);
  await writeFile(journalFile, JSON.stringify({...journal, outcome: 'rolled-back', step: 'rolled-back'}));
  await successful(root, register('migrating'));
  expect((await registry(root)).bots).toHaveLength(1);
});
