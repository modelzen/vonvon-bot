import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let scratch: string;
let entry: string;
const children = new Set<ChildProcess>();
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'bot-namespace-')));
  entry = join(scratch, 'entry.cjs');
  await build({ stdin: { contents: `export * from './src/config/bots';export * from './src/bot/register-bot';export * from './src/config/store';`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: entry,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', external: ['@larksuiteoapi/node-sdk'] });
});
afterAll(async () => {
  const live = [...children].filter(child => child.exitCode === null && child.signalCode === null);
  const pending = live.map(child => once(child, 'exit'));
  for (const child of live) child.kill('SIGKILL');
  await Promise.all(pending);
  await rm(scratch, { recursive: true, force: true });
});
async function home(): Promise<string> { return mkdtemp(join(scratch, 'data-')); }
function run(root: string, code: string, setup = '') {
  const child = spawn(process.execPath, ['-e', `${setup};const m=require(${JSON.stringify(entry)});(async()=>{${code}})().catch(e=>{console.error(e);process.exitCode=1})`],
    { env: { ...process.env, VONVON_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => { children.delete(child); resolve({ code, stdout, stderr }); });
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', () => { if (stdout.includes('BARRIER')) resolve(); });
    child.once('exit', () => { if (!stdout.includes('BARRIER')) reject(new Error(stderr || 'Exited before barrier')); });
  });
  void ready.catch(() => undefined);
  return { child, done, ready };
}
async function successful(root: string, code: string, setup?: string) {
  const result = await run(root, code, setup).done;
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return result.stdout;
}
async function registry(root: string) { return JSON.parse(await readFile(join(root, 'bots.json'), 'utf8')); }
const input = (appId: string, extra = {}) => JSON.stringify({ appId, tenant: 'feishu', desiredName: 'shared', ...extra });
const register = (appId: string, extra = {}, callback = 'async()=>{}') => `await m.registerBotEntry(${input(appId, extra)},${callback});`;
const credentials = (appId: string, preferences = {}) => `const result=await m.registerBotFromCredentials(${JSON.stringify({ appId, appSecret: 'fake-only', tenant: 'feishu', ownerOpenId: 'fixture', initialPreferences: preferences })},async()=>({ok:true,botName:'Shared'}));if(!result.ok)throw Error(result.reason);`;
const pause = `process.stdout.write('BARRIER');await new Promise(()=>setInterval(()=>{},1000));`;

function intercept(stage: string): string {
  return `const fs=require('node:fs/promises');const oldRename=fs.rename,oldMkdir=fs.mkdir;
    fs.rename=async(a,b)=>{if(b.endsWith('/bots.json')){const doc=JSON.parse(await fs.readFile(a,'utf8'));const state=doc.allocations?.crash?.state;
      if(${JSON.stringify(stage)}==='before-intent'&&state==='reserved'){${pause}}
      await oldRename(a,b);
      if((${JSON.stringify(stage)}==='reserved'&&state==='reserved')||(${JSON.stringify(stage)}==='ready'&&state==='ready')){${pause}}return;
    }return oldRename(a,b)};
    fs.mkdir=async(p,o)=>{const result=await oldMkdir(p,o);if(${JSON.stringify(stage)}==='mkdir'&&p.endsWith('/projects/shared')){${pause}}return result};`;
}

describe('stable bot directory evidence', () => {
  it('creates a default empty workspace through shared credential registration', async () => {
    const root = await home();
    await successful(root, credentials('cli_default123'));
    const saved = await registry(root);
    const allocation = saved.allocations.cli_default123;
    const config = JSON.parse(await readFile(join(root, 'bots/cli_default123/config.json'), 'utf8'));
    expect(allocation.state).toBe('ready');
    expect(config.preferences.directories.workspaces).toEqual({ primary: allocation.namespaceRoot, additional: [] });
    expect(config.preferences.directories).not.toHaveProperty('repositories');
    expect(await readdir(allocation.namespaceRoot)).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain('fake-only');
  });

  it('preserves explicit workspaces, repositories and unknown complete preferences', async () => {
    const root = await home();
    const workspace = await realpath(await mkdtemp(join(scratch, 'explicit-')));
    await mkdir(join(root, 'bots/cli_explicit123'), { recursive: true });
    const preferences = { projectsRootDir: join(scratch, 'custom-parent'), directories: { workspaces: { primary: workspace, additional: [] }, repositories: [] }, future: { keep: true } };
    await writeFile(join(root, 'bots/cli_explicit123/config.json'), JSON.stringify({ accounts: { app: { id: 'cli_explicit123', secret: 'fixture', tenant: 'feishu' } }, preferences }));
    await successful(root, credentials('cli_explicit123', { projectsRootDir: '/ignored' }));
    const config = JSON.parse(await readFile(join(root, 'bots/cli_explicit123/config.json'), 'utf8'));
    expect(config.preferences.directories).toEqual(preferences.directories);
    expect(config.preferences.future).toEqual({ keep: true });
    expect((await registry(root)).allocations.cli_explicit123.parent).toBe(preferences.projectsRootDir);
  });

  it('keeps pending handles through account failure, activation and deletion, then reuses the proven namespace', async () => {
    const root = await home();
    expect((await run(root, register('pending', {}, `async()=>{throw Error('account-failure')}`)).done).code).toBe(1);
    let saved = await registry(root);
    const allocation = saved.allocations.pending;
    await successful(root, register('other'));
    saved = await registry(root);
    expect(saved.bots[0].name).toBe('shared-2');
    await successful(root, register('pending') + `await m.setBotActivation('pending',false);const row=(await m.loadBots()).bots.find(b=>b.appId==='pending');await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}});`);
    expect((await registry(root)).allocations.pending).toEqual(allocation);
    await writeFile(join(allocation.namespaceRoot, 'keep'), 'contents');
    await successful(root, register('pending', { desiredName: 'renamed', initialPreferences: { projectsRootDir: '/ignored-new-parent' } }));
    saved = await registry(root);
    expect(saved.allocations.pending).toEqual(allocation);
    expect(saved.bots.find((bot: { appId: string }) => bot.appId === 'pending').name).toBe('shared');
    expect(await readFile(join(allocation.namespaceRoot, 'keep'), 'utf8')).toBe('contents');
  });

  it('re-registers after account-state cleanup with a new incarnation and the same workspace', async () => {
    const root = await home();
    await successful(root, credentials('cli_repeat123'));
    const before = await registry(root);
    const allocation = before.allocations.cli_repeat123;
    await writeFile(join(allocation.namespaceRoot, 'keep'), 'survives');
    await successful(root, `await m.setBotActivation('cli_repeat123',false);const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{await require('node:fs/promises').rm(${JSON.stringify(root)}+'/bots/cli_repeat123',{recursive:true})}});`);
    await successful(root, credentials('cli_repeat123', { projectsRootDir: '/unused-new-root' }));
    const after = await registry(root);
    const config = JSON.parse(await readFile(join(root, 'bots/cli_repeat123/config.json'), 'utf8'));
    expect(after.bots[0].registrationId).not.toBe(before.bots[0].registrationId);
    expect(after.allocations.cli_repeat123).toEqual(allocation);
    expect(config.preferences.directories.workspaces.primary).toBe(allocation.namespaceRoot);
    expect(await readFile(join(allocation.namespaceRoot, 'keep'), 'utf8')).toBe('survives');
  });

  it('avoids existing case and Unicode names without touching their contents', async () => {
    const root = await home();
    await mkdir(join(root, 'projects/SHARED'), { recursive: true });
    await writeFile(join(root, 'projects/SHARED/keep'), 'old');
    await successful(root, register('first') + register('second'));
    const saved = await registry(root);
    expect(saved.allocations.first.namespaceRoot).not.toBe(join(root, 'projects/shared'));
    expect(saved.allocations.first.namespaceRoot).not.toBe(saved.allocations.second.namespaceRoot);
    expect(await readFile(join(root, 'projects/SHARED/keep'), 'utf8')).toBe('old');
  });

  it('rejects protected and dangling aliases before creating a candidate', async () => {
    for (const dangling of [false, true]) {
      const root = await home();
      await mkdir(join(root, 'bots'));
      await symlink(join(root, dangling ? 'missing' : 'bots'), join(root, 'projects'));
      const result = await run(root, register('unsafe')).done;
      expect(result.code).toBe(1);
      expect(await readdir(join(root, 'bots'))).toEqual([]);
      await expect(readFile(join(root, 'bots.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refuses ready target and parent replacement while the old inode still exists', async () => {
    for (const parent of [false, true]) {
      const root = await home();
      await run(root, register('replace', {}, `async()=>{throw Error('account-failure')}`)).done;
      const allocation = (await registry(root)).allocations.replace;
      const selected = parent ? allocation.parent : allocation.namespaceRoot;
      await rename(selected, `${selected}-old`);
      await mkdir(selected);
      const result = await run(root, register('replace')).done;
      expect(result.code).toBe(1);
      expect(await readdir(selected)).toEqual([]);
      expect((await registry(root)).bots).toEqual([]);
    }
  });

  it('refuses tenant changes, unsafe IDs and malformed/symlink/oversized evidence', async () => {
    const root = await home();
    await run(root, register('pending', {}, `async()=>{throw Error('account-failure')}`)).done;
    expect((await run(root, register('pending', { tenant: 'lark' })).done).code).toBe(1);
    expect((await run(root, register('../escape')).done).code).toBe(1);
    const saved = await registry(root);
    saved.allocations.pending.unexpected = true;
    await writeFile(join(root, 'bots.json'), JSON.stringify(saved));
    expect((await run(root, `await m.loadBots()`).done).code).toBe(1);
    await writeFile(join(root, 'bots.json'), ' '.repeat(4 * 1024 * 1024 + 1));
    expect((await run(root, `await m.loadBots()`).done).code).toBe(1);
    await rename(join(root, 'bots.json'), join(root, 'other.json'));
    await symlink(join(root, 'other.json'), join(root, 'bots.json'));
    expect((await run(root, `await m.loadBots()`).done).code).toBe(1);
  });

  for (const stage of ['before-intent', 'reserved', 'mkdir', 'ready', 'account']) {
    it(`replays a SIGKILL at ${stage} conservatively in a fresh process`, async () => {
      const root = await home();
      const held = run(root, register('crash', {}, stage === 'account' ? `async ctx=>{await m.saveConfig({accounts:{app:{id:'crash',secret:'fixture',tenant:'feishu'}}},${JSON.stringify(root)}+'/bots/crash/config.json',ctx.snapshot);${pause}}` : 'async()=>{}'), intercept(stage));
      await held.ready;
      const exited = once(held.child, 'exit');
      held.child.kill('SIGKILL');
      await exited;
      const result = await run(root, register('crash')).done;
      expect(result.code).toBe(stage === 'mkdir' ? 1 : 0);
      if (stage === 'mkdir') {
        const saved = await registry(root);
        expect(saved.allocations.crash.state).toBe('reserved');
        expect(saved.bots).toEqual([]);
        expect(await readdir(saved.allocations.crash.namespaceRoot)).toEqual([]);
      } else expect((await registry(root)).bots).toHaveLength(1);
    });
  }

  for (const operation of ['file-sync', 'directory-sync', 'rename']) {
    it(`reports ${operation} failure and permits conservative fresh-process recovery`, async () => {
      const root = await home();
      const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open,oldRename=fs.rename;
        fs.open=async(...args)=>{const file=await oldOpen(...args);if(${JSON.stringify(operation)}==='file-sync'&&String(args[0]).includes('/bots.json.tmp-'))file.sync=async()=>{throw Error('injected-file-sync')};
        if(${JSON.stringify(operation)}==='directory-sync'&&String(args[0]).endsWith('/projects/shared'))file.sync=async()=>{throw Error('injected-directory-sync')};return file};
        fs.rename=async(a,b)=>{if(${JSON.stringify(operation)}==='rename'&&b.endsWith('/bots.json'))throw Error('injected-rename');return oldRename(a,b)};`;
      const failed = await run(root, register('failure'), setup).done;
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain('injected-');
      const retry = await run(root, register('failure')).done;
      expect(retry.code).toBe(operation === 'directory-sync' ? 1 : 0);
      if (operation === 'directory-sync') expect((await registry(root)).allocations.failure.state).toBe('reserved');
    });
  }

  it('does not allocate on legacy reads, refresh, activation or duplicate registration', async () => {
    const root = await home();
    const legacy = { appId: 'legacy', tenant: 'feishu', name: 'legacy', createdAt: 1 };
    await writeFile(join(root, 'bots.json'), JSON.stringify({ version: 1, bots: [legacy], current: 'legacy' }));
    await successful(root, `const reg=await m.ensureRegistry();await m.commitBotCredentialRefresh(m.botIdentity(reg.bots[0]),async()=>{});await m.setBotActivation('legacy',true);${register('legacy')}`);
    expect((await registry(root)).allocations).toBeUndefined();
    await expect(readdir(join(root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses missing ready directories and malformed allocation deletion before cleanup', async () => {
    const root = await home();
    await successful(root, register('saved') + `await m.setBotActivation('saved',false)`);
    const before = await registry(root);
    const originalId = before.bots[0].registrationId;
    const allocation = before.allocations.saved;
    allocation.tenant = 'lark';
    await writeFile(join(root, 'bots.json'), JSON.stringify(before));
    const refused = await run(root, `const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{throw Error('cleanup-must-not-run')}})`).done;
    expect(refused.stderr).toContain('Bot allocation account conflict');
    expect(refused.stderr).not.toContain('cleanup-must-not-run');
    allocation.tenant = 'feishu';
    await writeFile(join(root, 'bots.json'), JSON.stringify(before));
    await successful(root, `const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}})`);
    await successful(root, register('saved'));
    expect((await registry(root)).bots[0].registrationId).not.toBe(originalId);
    await successful(root, `await m.setBotActivation('saved',false);const row=(await m.loadBots()).bots[0];await m.removeBot(m.botIdentity(row),{isRunning:async()=>false,cleanup:async()=>{}})`);
    await rm(allocation.namespaceRoot, { recursive: true });
    expect((await run(root, register('saved')).done).code).toBe(1);
    await expect(readdir(allocation.namespaceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects dangling registry links and hard-linked evidence', async () => {
    const root = await home();
    await symlink(join(root, 'absent'), join(root, 'bots.json'));
    expect((await run(root, register('link')).done).code).toBe(1);
    await rm(join(root, 'bots.json'));
    await writeFile(join(root, 'evidence'), JSON.stringify({ version: 1, bots: [] }));
    const { link } = await import('node:fs/promises');
    await link(join(root, 'evidence'), join(root, 'bots.json'));
    expect((await run(root, register('link')).done).code).toBe(1);
  });

  it('reports a final registry sync failure even when the registered row is visible', async () => {
    const root = await home();
    const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open;fs.open=async(...args)=>{
      const file=await oldOpen(...args);if(String(args[0])===process.env.VONVON_HOME){const sync=file.sync.bind(file);file.sync=async()=>{
        let doc;try{doc=JSON.parse(await fs.readFile(process.env.VONVON_HOME+'/bots.json','utf8'))}catch{};
        if(doc?.bots?.length)throw Error('final-sync-failure');return sync();};}return file;};`;
    const failed = await run(root, register('visible'), setup).done;
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('final-sync-failure');
    expect((await registry(root)).bots).toHaveLength(1);
    await successful(root, `const result=await m.registerBotEntry(${input('visible')},async()=>{throw Error('must-not-write-account')});if(result.kind!=='already-registered')throw Error('not duplicate');`);
  });

  it('keeps the primary file-sync error when cleanup and close also fail', async () => {
    const root = await home();
    const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open,oldUnlink=fs.unlink;fs.open=async(...args)=>{
      const file=await oldOpen(...args);if(String(args[0]).includes('/bots.json.tmp-')){const close=file.close.bind(file);file.sync=async()=>{throw Error('primary-sync-failure')};file.close=async()=>{await close();throw Error('secondary-close-failure')};}return file;};
      fs.unlink=async p=>{if(String(p).includes('/bots.json.tmp-'))throw Error('secondary-cleanup-failure');return oldUnlink(p)};`;
    const result = await run(root, register('errors'), setup).done;
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('primary-sync-failure');
    expect(result.stderr).not.toContain('secondary-close-failure');
    expect(result.stderr).not.toContain('secondary-cleanup-failure');
    await successful(root, register('errors'));
  });

  it('does not create suffixes under a file parent or reuse Unicode-folded entries', async () => {
    const root = await home();
    const parent = join(scratch, `parent-file-${Date.now()}`);
    await writeFile(parent, 'unchanged');
    expect((await run(root, register('file', { initialPreferences: { projectsRootDir: join(parent, 'child') } })).done).code).toBe(1);
    expect(await readFile(parent, 'utf8')).toBe('unchanged');
    await mkdir(join(root, 'projects/ＳＨＡＲＥＤ'), { recursive: true });
    await successful(root, register('unicode'));
    expect((await registry(root)).allocations.unicode.namespaceRoot).not.toBe(join(root, 'projects/shared'));
    expect(await readdir(join(root, 'projects/ＳＨＡＲＥＤ'))).toEqual([]);
  });

  it('resynchronizes parent chains left visible by an earlier failed attempt', async () => {
    const root = await home();
    const parent = join(root, 'projects/nested/final');
    const failedNode = join(root, 'projects/nested');
    const setup = `const fs=require('node:fs/promises');const oldOpen=fs.open;fs.open=async(...args)=>{
      const file=await oldOpen(...args);if(String(args[0])===${JSON.stringify(failedNode)})file.sync=async()=>{throw Error('ancestor-sync-failure')};return file;};`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run(root, register('ancestor', { initialPreferences: { projectsRootDir: parent } }), setup).done;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ancestor-sync-failure');
      expect(await readdir(failedNode)).toEqual([]);
      await expect(readFile(join(root, 'bots.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await successful(root, register('ancestor', { initialPreferences: { projectsRootDir: parent } }));
    expect((await registry(root)).allocations.ancestor.parent).toBe(parent);
  });

  it('captures caller input before queueing and detaches callback preferences from evidence', async () => {
    const root = await home();
    await successful(root, `const input=${input('detached', { initialPreferences: { projectsRootDir: join(root, 'projects/chosen') } })};
      const promise=m.registerBotEntry(input,async ctx=>{ctx.snapshot.preferences={future:'callback'};ctx.preferences.projectsRootDir='/mutated-in-callback';});
      input.initialPreferences.projectsRootDir='/mutated-before-owner';await promise;`);
    expect((await registry(root)).allocations.detached.parent).toBe(join(root, 'projects/chosen'));
  });

  it('passes one detached config snapshot and refuses a concurrent edit at account save', async () => {
    const root = await home();
    const refused = await run(root, register('snapshot', {}, `async ctx=>{
      const fs=require('node:fs/promises'),p=${JSON.stringify(root)}+'/bots/snapshot/config.json';
      await fs.mkdir(require('node:path').dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify({preferences:{future:'concurrent'}}));
      await m.saveConfig({accounts:{app:{id:'snapshot',secret:'fixture',tenant:'feishu'}}},p,ctx.snapshot);
    }`)).done;
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('配置已被其他进程修改');
    expect((await registry(root)).bots).toEqual([]);
    expect((await registry(root)).allocations.snapshot.state).toBe('ready');
    expect(JSON.parse(await readFile(join(root, 'bots/snapshot/config.json'), 'utf8')).preferences.future).toBe('concurrent');
  });

  it('snapshots expected config at save entry despite caller mutation', async () => {
    const root = await home();
    await successful(root, `const fs=require('node:fs/promises');const p=${JSON.stringify(root)}+'/config.json';await fs.writeFile(p,'{}');
      const expected={};const promise=m.saveConfig({accounts:{app:{id:'save',secret:'fixture',tenant:'feishu'}}},p,expected);expected.preferences={future:'mutation'};await promise;`);
    expect(JSON.parse(await readFile(join(root, 'config.json'), 'utf8')).accounts.app.id).toBe('save');
  });
});
