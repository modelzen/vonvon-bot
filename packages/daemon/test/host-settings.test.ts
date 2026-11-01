import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostSettings } from '../src/admin/host-settings';
import { readServiceCodexBin, saveServiceCodexBin } from '../src/service/codex-bin';
import type { HostSettingsView } from '../src/admin/settings-types';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import { parseSettingsEdit } from '../src/admin/settings-parse';
import { fallbackWorkingDirectory, ownInstallDirectory } from '../src/platform/fallback-cwd';

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

async function fixture() {
  const appDir = await mkdtemp(join(tmpdir(), 'vonvon-host-settings-'));
  homes.push(appDir);
  const first = join(appDir, process.platform === 'win32' ? 'codex-first.cmd' : 'codex-first');
  const second = join(appDir, process.platform === 'win32' ? 'codex-second.cmd' : 'codex-second');
  await writeFile(first, '', { mode: 0o700 });
  await writeFile(second, '', { mode: 0o700 });
  const settings = createHostSettings({ appDir, runningCodexBin: first, getSecret:async()=> 'fixture-key' });
  const read = async (): Promise<HostSettingsView> => {
    const value = await settings.read({ kind: 'host' });
    if (!('runtime' in value)) throw new Error('Expected host view');
    return value;
  };
  const save = (revision: string, codexBin: string | null) => settings.save({ scope: { kind: 'host' }, section: 'execution', revision, patch: { codexBin } });
  return { appDir, first, second, settings, read, save };
}

describe('Host executable settings', () => {
  it('persists a selection without pretending the running executable changed', async () => {
    const f = await fixture();
    const initial = await f.read();
    const result = await f.save(initial.sections.execution.revision, f.second);
    expect(result.kind).toBe('saved');
    if (result.kind === 'saved') expect(result.effects.map(effect => effect.when)).toEqual(['restart']);
    expect(readServiceCodexBin(f.appDir)).toBe(f.second);
    expect((await f.read()).sections.execution.effective.codexBin).toBe(f.first);
    const reopened = createHostSettings({ appDir: f.appDir, runningCodexBin: f.second });
    const value = await reopened.read({ kind: 'host' });
    if (!('runtime' in value)) throw new Error('Expected host view');
    expect(value.sections.execution.stored.codexBin).toBe(f.second);
    expect(value.sections.execution.effective.codexBin).toBe(f.second);
  });

  it('persists an explicit reset even when no previous service selection exists', async () => {
    const f = await fixture();
    const initial = await f.read();
    expect(readServiceCodexBin(f.appDir)).toBeUndefined();
    expect((await f.save(initial.sections.execution.revision, null)).kind).toBe('saved');
    expect(readServiceCodexBin(f.appDir)).toBeNull();
    expect((await f.read()).runtime.codexBin).toBe(f.first);
  });

  it('rejects a stale competing edit and accepts an identical retry', async () => {
    const f = await fixture();
    const initial = await f.read();
    const results = await Promise.all([
      f.save(initial.sections.execution.revision, f.first),
      f.save(initial.sections.execution.revision, f.second),
    ]);
    expect(results.map(result => result.kind)).toEqual(['saved', 'conflict']);
    expect(readServiceCodexBin(f.appDir)).toBe(f.first);
    const retry = await f.save(initial.sections.execution.revision, f.first);
    expect(retry.kind).toBe('saved');
    if (retry.kind === 'saved') expect(retry.effects).toEqual([]);
  });

  it('refuses missing, relative, directory and malformed paths without overwriting selection', async () => {
    const f = await fixture();
    saveServiceCodexBin(f.first, f.appDir);
    for (const path of ['relative/codex', join(f.appDir, 'missing'), f.appDir, `${f.second}\nother`]) {
      const before = await f.read();
      expect((await f.save(before.sections.execution.revision, path)).kind).toBe('rejected');
      expect(readServiceCodexBin(f.appDir)).toBe(f.first);
    }
  });

  it('refuses preview mutations and leaves the service record absent', async () => {
    const f = await fixture();
    const preview = createHostSettings({ appDir: f.appDir, readonly: true });
    const initial = await f.read();
    expect((await preview.save({ scope: { kind: 'host' }, section: 'execution', revision: initial.sections.execution.revision, patch: { codexBin: f.first } })).kind).toBe('unavailable');
    expect(readServiceCodexBin(f.appDir)).toBeUndefined();
  });

  it('s02c1: leaves an old 咖啡一下 route file alone and shows no coffee in the view', async () => {
    const f = await fixture();
    const route = join(f.appDir, 'cli-bridge-route.json');
    await writeFile(route, '{"botId":"cli_old"}\n');
    const view = await f.read();
    expect(Object.keys(view.runtime).sort()).toEqual(['codexBin', 'fallbackCwd', 'platform']);
    expect(f.settings).not.toHaveProperty('act');
    expect(await readFile(route, 'utf8')).toBe('{"botId":"cli_old"}\n');
  });
});

describe('global judge model settings', () => {
  it('has a stable legacy default and saves default-only edits without discarding profiles', async()=>{
    const f=await fixture();
    const first=await f.read();
    expect(first.sections.judge.effective.defaultProvider).toBe('codex-appserver');
    expect(first.sections.judge.stored.defaultProvider).toBeUndefined();
    const profile={typesafe:{model:'jev-latest'}};
    expect((await f.settings.save(parseSettingsEdit({scope:{kind:'host'},section:'judge',revision:first.sections.judge.revision,patch:{defaultProvider:'typesafe',byProvider:profile}}))).kind).toBe('saved');
    const selected=await f.read();
    expect(selected.sections.judge.effective.defaultProvider).toBe('typesafe');
    expect((await f.settings.save(parseSettingsEdit({scope:{kind:'host'},section:'judge',revision:selected.sections.judge.revision,patch:{defaultProvider:'claude-agent'}}))).kind).toBe('saved');
    const switched=await f.read();
    expect(switched.sections.judge.stored).toEqual({defaultProvider:'claude-agent',byProvider:profile});
    expect((await f.settings.save(parseSettingsEdit({scope:{kind:'host'},section:'judge',revision:switched.sections.judge.revision,patch:{byProvider:{}}}))).kind).toBe('saved');
    expect((await f.read()).sections.judge.stored.defaultProvider).toBe('claude-agent');
    expect(()=>parseSettingsEdit({scope:{kind:'host'},section:'judge',revision:'r',patch:{defaultProvider:'unknown'}})).toThrow();
  });
  it('refuses missing or unreadable Jev keys, including a default-only switch',async()=>{
    const f=await fixture();
    const before=await f.read();
    const edit=parseSettingsEdit({scope:{kind:'host'},section:'judge',revision:before.sections.judge.revision,patch:{defaultProvider:'typesafe'}});
    for (const getSecret of [async()=>undefined,async()=>{throw new Error('private key error');},async()=> 'bad key']) {
      const result=await createHostSettings({appDir:f.appDir,getSecret}).save(edit);
      expect(result).toMatchObject({kind:'rejected',fields:[{message:expect.stringContaining('密钥')}]});
      expect((await f.read()).sections.judge.effective.defaultProvider).toBe('codex-appserver');
    }
  });
  it('parses and preserves a newer provider choice, but rejects changing it', async () => {
    const f = await fixture();
    await writeFile(join(f.appDir, 'judge-models.json'), JSON.stringify({version:1,byProvider:{future:{model:'future-one'}}}));
    const view = await f.read();
    const edit = {scope:{kind:'host'},section:'judge',revision:view.sections.judge.revision,
      patch:{byProvider:{future:{model:'future-one'},'codex-appserver':{model:'custom-one',custom:true}}}};
    expect(parseSettingsEdit(edit)).toMatchObject(edit);
    expect((await f.settings.save(parseSettingsEdit(edit))).kind).toBe('saved');
    expect((await f.read()).sections.judge.stored.byProvider.future).toEqual({model:'future-one'});
    const changed = await f.read();
    expect((await f.settings.save(parseSettingsEdit({ ...edit, revision: changed.sections.judge.revision,
      patch:{byProvider:{future:{model:'future-two'}}} }))).kind).toBe('rejected');
  });
  it('saves while the daemon owns host and serializes competing judge writers', async () => {
    const f = await fixture();
    const other = createHostSettings({ appDir: f.appDir });
    const first = await f.read();
    const hostLock = await acquireMutex(f.appDir, 'host');
    try {
      const base = { scope: { kind: 'host' as const }, section: 'judge' as const, revision: first.sections.judge.revision };
      const results = await Promise.all([
        f.settings.save({ ...base, patch: { byProvider: { typesafe: { model: 'jev-latest' } } } }),
        other.save({ ...base, patch: { byProvider: { 'codex-appserver': { model: 'custom-one', custom: true } } } }),
      ]);
      expect(results.map(result => result.kind).sort()).toEqual(['conflict', 'saved']);
    } finally { await closeMutex(hostLock); }
  });
  it('saves overrides with CAS across host service instances and reads effective defaults', async () => {
    const f = await fixture();
    const other = createHostSettings({ appDir: f.appDir });
    const first = await f.read();
    expect(Object.keys(first.sections.judge.effective.byProvider).sort()).toEqual(['claude-agent', 'codex-appserver', 'custom', 'openrouter', 'typesafe', 'vercel']);
    expect(first.sections.judge.stored.byProvider).toEqual({});
    const edit = { scope: { kind: 'host' as const }, section: 'judge' as const, revision: first.sections.judge.revision,
      patch: { byProvider: { 'codex-appserver': { model: 'gateway/model', effort: 'high' as const, custom: true } } } };
    expect((await f.settings.save(edit)).kind).toBe('saved');
    const fresh = await other.read({ kind: 'host' });
    if (!('runtime' in fresh)) throw new Error('Expected host view');
    expect(fresh.sections.judge.effective.byProvider['codex-appserver']).toEqual(edit.patch.byProvider['codex-appserver']);
    expect((await other.save({ ...edit, patch: { byProvider: { 'codex-appserver': { model: 'other', custom: true } } } })).kind).toBe('conflict');
    expect((await other.save({ ...edit, revision: fresh.sections.judge.revision,
      patch: { byProvider: { typesafe: { model: 'jev-latest', effort: 'high' } } } })).kind).toBe('rejected');
  });
});

// main 必败: the folder was process.cwd() as it came, so a service got / or C:\Windows\System32 (Windows acceptance task 205)
describe('the fallback working folder', () => {
  const linux = { env: {}, home: '/home/u', platform: 'linux' as const, installDirectory: '/opt/vonvon/server', isDirectory: () => true };
  const windows = { env: { SystemRoot: 'C:\\Windows' }, home: 'C:\\Users\\u', platform: 'win32' as const, installDirectory: 'C:\\Users\\u\\AppData\\Local\\VonvonBot\\server', isDirectory: () => true };
  it('keeps FEISHU_CODEX_CWD and a folder a person started the daemon in', () => {
    expect(fallbackWorkingDirectory({ ...linux, env: { FEISHU_CODEX_CWD: '/srv/work' }, cwd: '/' })).toBe('/srv/work');
    expect(fallbackWorkingDirectory({ ...linux, cwd: '/home/u/work' })).toBe('/home/u/work');
    expect(fallbackWorkingDirectory({ ...linux, cwd: '/tmp/x' })).toBe('/tmp/x');
    expect(fallbackWorkingDirectory({ ...linux, cwd: '/opt/vonvon/server-notes' })).toBe('/opt/vonvon/server-notes');
    expect(fallbackWorkingDirectory({ ...windows, cwd: 'D:\\code\\site' })).toBe('D:\\code\\site');
    expect(fallbackWorkingDirectory({ ...windows, cwd: 'C:\\WindowsApps' })).toBe('C:\\WindowsApps');
  });
  it('takes the home folder for a filesystem root, the Windows system folder or its own install folder', () => {
    expect(fallbackWorkingDirectory({ ...linux, cwd: '/' })).toBe('/home/u');
    expect(fallbackWorkingDirectory({ ...linux, cwd: '/opt/vonvon/server' })).toBe('/home/u');
    expect(fallbackWorkingDirectory({ ...linux, cwd: '/opt/vonvon/server/releases/0.9.0/app' })).toBe('/home/u');
    expect(fallbackWorkingDirectory({ ...windows, cwd: 'C:\\' })).toBe('C:\\Users\\u');
    expect(fallbackWorkingDirectory({ ...windows, cwd: 'D:\\' })).toBe('C:\\Users\\u');
    expect(fallbackWorkingDirectory({ ...windows, cwd: 'c:\\windows\\System32' })).toBe('C:\\Users\\u');
    expect(fallbackWorkingDirectory({ ...windows, env: {}, cwd: 'C:\\Windows\\SysWOW64' })).toBe('C:\\Users\\u');
    expect(fallbackWorkingDirectory({ ...windows, cwd: 'C:\\Users\\u\\AppData\\Local\\VonvonBot\\server\\releases\\0.9.0' })).toBe('C:\\Users\\u');
  });
  // main 必败 (task 210): Node caches the working folder, so a deleted one still came back as the fallback
  it('takes the home folder when the working folder is gone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'vonvon-fallback-'));
    try {
      const gone = join(parent, 'gone');
      await mkdir(gone);
      expect(fallbackWorkingDirectory({ env: {}, cwd: gone, home: '/elsewhere', installDirectory: '/opt/none' })).toBe(gone);
      await rmdir(gone);
      expect(fallbackWorkingDirectory({ env: {}, cwd: gone, home: '/elsewhere', installDirectory: '/opt/none' })).toBe('/elsewhere');
    } finally { await rm(parent, { recursive: true, force: true }); }
  });
  it('knows this checkout as its own install folder, and the view shows the folder', async () => {
    const daemonRoot = join(import.meta.dirname, '..');
    expect(ownInstallDirectory()).toBe(await realpath(daemonRoot));
    expect(fallbackWorkingDirectory({ env: {}, cwd: join(daemonRoot, 'src'), home: '/elsewhere' })).toBe('/elsewhere');
    const f = await fixture();
    expect((await f.read()).runtime.fallbackCwd).toBe(fallbackWorkingDirectory());
  });
});
