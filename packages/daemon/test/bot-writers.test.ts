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
      if(!Object.isFrozen(selected))throw Error('not frozen');
      try{selected.name='corrupted'}catch{};
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
    await expect(readFile(join(root, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
