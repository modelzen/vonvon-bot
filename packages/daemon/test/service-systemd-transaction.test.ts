import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createSystemdService } from '../src/service/systemd';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, SYSTEMD_UNIT_NAME } from '../src/service/identity';
import { readRegistration } from '../src/service/registration';
import type { PidLockInfo } from '../src/server/pid-lock';

type Overrides = NonNullable<Parameters<typeof createSystemdService>[1]>;
type Command = { ok: boolean; stdout: string; stderr: string; status: number | null };
const ok = (stdout = ''): Command => ({ ok: true, stdout, stderr: '', status: 0 });
const failed = (stderr = 'injected command failure'): Command => ({ ok: false, stdout: '', stderr, status: 1 });
const roots: string[] = [];
const commandTraces: string[][] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const calls of commandTraces.splice(0)) expect(calls.filter(command => /^(stop|restart|kill) /.test(command) || /^disable .*--now/.test(command))).toEqual([]);
});

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'vonvon-systemd-'));
  roots.push(folder);
  const root = await resolveServiceRoot(folder);
  const unitPath = join(root, '.config/systemd/user', SYSTEMD_UNIT_NAME);
  const target = { platform: 'linux' as const, unitPath };
  const calls: string[] = [];
  commandTraces.push(calls);
  const state = {
    loaded: false, enabled: false, fragment: unitPath, pid: 0,
    owner: null as PidLockInfo | null, clock: 0,
    manager: ok('running'), enabledReply: null as Command | null,
    showReply: null as Command | null, pidReply: null as Command | null,
    fail: '' as string, stopError: false, autoStart: true,
    onCommand: async (_command: string): Promise<void> => {},
    onPause: async (): Promise<void> => {},
  };
  const definition = { root, port: 32123, distribution: { kind: 'npm' as const, executable: process.execPath, entry: '/installed/bin/vonvon.mjs' }, capturedPath: '/captured/tools:/usr/bin' };
  const rendered = renderDefinition({ target, ...definition });
  if (rendered.platform !== 'linux') throw new Error('Expected Linux unit');
  const desired = Buffer.from(rendered.unit);
  async function seed(content: Uint8Array = desired) { await mkdir(join(root, '.config/systemd/user'), { recursive: true }); await writeFile(unitPath, content); state.loaded = true; state.enabled = true; }
  const dependencies: Overrides = {
    home: root, xdgConfigHome: undefined, executable: process.execPath, capturedPath: definition.capturedPath,
    distribution: async () => ({ kind: 'global-npm', cliPath: definition.distribution.entry }),
    freePort: async () => 32123, now: () => state.clock,
    pause: async ms => { state.clock += ms; await state.onPause(); if (state.clock > 900_000) throw new Error('Fixture exceeded virtual drain budget'); },
    readOwner: async () => state.owner,
    verifyOwner: async () => {},
    stopOwner: async (_root, owner) => { calls.push(`stop:${owner.pid}`); if (state.stopError) throw new Error('stop reply lost'); state.owner = null; if (state.pid === owner.pid) state.pid = 0; },
    run: async args => {
      const command = args.join(' '); calls.push(command); await state.onCommand(command);
      if (command === state.fail) return failed();
      if (command === 'is-system-running') return state.manager;
      if (command.startsWith('is-enabled')) return state.enabledReply ?? (state.enabled ? ok('enabled') : { ...failed(''), stdout: 'disabled' });
      if (command.startsWith('show -p MainPID --value')) return state.pidReply ?? ok(String(state.pid));
      if (command.startsWith('show ')) return state.showReply ?? ok(`LoadState=${state.loaded ? 'loaded' : 'not-found'}\nFragmentPath=${state.loaded ? state.fragment : ''}\nMainPID=${state.pid}\n`);
      if (command.startsWith('disable ')) { state.enabled = false; return ok(); }
      if (command === 'daemon-reload') { state.loaded = (await readRegistration({ target, requestedRoot: root })).kind !== 'absent' || state.pid !== 0; return ok(); }
      if (command.startsWith('reset-failed')) return ok();
      if (command.startsWith('enable ') || command.startsWith('start ')) {
        state.enabled = true;
        if (state.autoStart && (command.includes('--now') || command.startsWith('start ')) && !state.owner) {
          state.pid = 41001; state.owner = { pid: state.pid, startedAt: '2026-10-11T00:00:00Z', listen: '127.0.0.1:32123' };
        }
        return ok();
      }
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  const service = (extra: Overrides = {}) => createSystemdService({ root }, { ...dependencies, ...extra });
  const registration = () => readRegistration({ target, requestedRoot: root });
  const bytes = () => readFile(unitPath);
  const mutations = () => calls.filter(c => !/^(show |is-)/.test(c));
  return { root, target, unitPath, state, calls, definition, desired, seed, service, registration, bytes, mutations, dependencies };
}

it.each(['offline', 'starting', '', 'running\ndegraded', 'garbage'])('refuses unusable manager %j without writes', async value => {
  const f = await fixture(); f.state.manager = ok(value);
  expect((await f.service().install()).kind).toBe('install_refused');
  expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual([]);
});
it('accepts nonzero degraded manager and writes the fixed definition', async () => {
  const f = await fixture(); f.state.manager = { ...failed(''), stdout: 'degraded' };
  expect((await f.service().install()).kind).toBe('installed');
  expect(await f.bytes()).toEqual(f.desired);
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`]);
});
it('identical enabled stopped unit stays stopped', async () => {
  const f = await fixture(); await f.seed();
  expect((await f.service().install()).kind).toBe('already-installed');
  expect(f.state.owner).toBeNull(); expect(f.mutations()).toEqual([]);
});
it.each(['disabled', 'enabled-runtime', 'fragment'])('does not accept false idempotency: %s', async condition => {
  const f = await fixture(); await f.seed();
  if (condition === 'fragment') f.state.fragment = '/elsewhere/vonvon-bot.service';
  else f.state.enabledReply = condition === 'enabled-runtime' ? ok(condition) : { ...failed(''), stdout: condition };
  f.state.onCommand = async command => { if (command === 'daemon-reload') { f.state.fragment = f.unitPath; f.state.enabledReply = null; } };
  expect((await f.service().install()).kind).toBe('installed');
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`]);
});
it.each(['error', 'masked'])('reloads an identical enabled unit with LoadState=%s', async loadState => {
  const f = await fixture(); await f.seed();
  f.state.showReply = ok(`LoadState=${loadState}\nFragmentPath=${f.unitPath}\nMainPID=0\n`);
  f.state.onCommand = async command => { if (command === 'daemon-reload') f.state.showReply = null; };
  expect((await f.service().install()).kind).toBe('installed');
  expect(await f.bytes()).toEqual(f.desired);
  expect(f.state.enabled).toBe(true);
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`]);
});
it.each([
  { loadState: 'error', previous: false }, { loadState: 'masked', previous: false },
  { loadState: 'error', previous: true }, { loadState: 'masked', previous: true },
])('rolls back LoadState=$loadState after load with a ready self-hosted owner and previous=$previous', async ({ loadState, previous }) => {
  const f = await fixture();
  if (previous) await f.seed();
  f.state.loaded = false;
  const owner = { pid: 42001, startedAt: 'self-hosted-birth', listen: '127.0.0.1:32123' };
  f.state.owner = owner;
  f.state.onCommand = async command => {
    if (command === `enable --now ${SYSTEMD_UNIT_NAME}`) {
      expect(await f.bytes()).toEqual(f.desired);
      f.state.showReply = ok(`LoadState=${loadState}\nFragmentPath=${f.unitPath}\nMainPID=0\n`);
    }
    if (command === 'daemon-reload') f.state.showReply = null;
  };
  const result = await f.service().install();
  expect(result.kind).toBe('install_rolled_back');
  expect(result.detail).toContain('Manager did not confirm installed unit');
  expect(result.retained).toEqual({ pid: owner.pid, startedAt: owner.startedAt });
  expect(f.state.owner).toEqual(owner);
  expect(f.state.pid).toBe(0);
  expect(f.state.loaded).toBe(false);
  if (previous) { expect(await f.bytes()).toEqual(f.desired); expect(f.state.enabled).toBe(true); }
  else { expect((await f.registration()).kind).toBe('absent'); expect(f.state.enabled).toBe(false); }
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, ...(previous ? [`enable ${SYSTEMD_UNIT_NAME}`] : [])]);
});
it('withdraws before owner stop and unloads once', async () => {
  const f = await fixture(); await f.seed(); f.state.pid = 41001;
  f.state.owner = { pid: 41001, startedAt: 'birth', listen: '127.0.0.1:32123' };
  const result = await f.service({ stopOwner: async () => { expect((await f.registration()).kind).toBe('absent'); expect(f.state.enabled).toBe(false); f.calls.push('verified-stop'); f.state.owner = null; f.state.pid = 0; } }).uninstall();
  expect(result.kind).toBe('uninstalled'); expect(result.retained).toBeNull();
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, 'verified-stop', 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`]);
});
it.each(['disable', 'unlink'])('withdrawal %s failure does not drain, unload, or compensate', async boundary => {
  const f = await fixture(); await f.seed(); if (boundary === 'disable') f.state.fail = `disable ${SYSTEMD_UNIT_NAME}`;
  const result = await f.service(boundary === 'unlink' ? { unlink: async () => { throw new Error('unlink refused'); } } : {}).uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(await f.bytes()).toEqual(f.desired);
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`]); expect(f.state.enabled).toBe(boundary === 'disable');
});
it.each(['', '-1', '1.5', '0\n0', '9007199254740992', 'word'])('restores exact kept bytes on malformed MainPID %j without unload', async value => {
  const f = await fixture(); await f.seed(); f.state.pidReply = ok(value);
  const result = await f.service().uninstall();
  expect(result.kind).toBe('uninstall_rolled_back'); expect(result.detail).toContain('query_failed');
  expect(await f.bytes()).toEqual(f.desired); expect(f.state.enabled).toBe(true);
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`]);
});
it('uncertain stop is terminal even when later diagnostics fail', async () => {
  const f = await fixture(); await f.seed(); f.state.pid = 41001; f.state.owner = { pid: 41001, startedAt: 'birth', listen: '127.0.0.1:32123' };
  let rejected = false;
  const result = await f.service({ stopOwner: async () => { f.calls.push('stop-rejected'); rejected = true; throw new Error('reply lost'); }, readOwner: async () => { if (rejected) throw new Error('diagnostics lost'); return f.state.owner; } }).uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('stop_unconfirmed');
  expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, 'stop-rejected']);
});
it('resumed uninstall retains unrelated owner without stop or wait', async () => {
  const f = await fixture(); f.state.loaded = true; f.state.owner = { pid: 42000, startedAt: 'retained', listen: '127.0.0.1:32123' };
  const result = await f.service().uninstall();
  expect(result.kind).toBe('uninstalled'); expect(result.retained).toEqual({ pid: 42000, startedAt: 'retained' }); expect(f.state.clock).toBe(0);
  expect(f.mutations()).toEqual(['daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`]);
});
it('start rejects registered port mismatch without manager mutations', async () => {
  const f = await fixture(); await f.seed(); await expect(f.service().start({ port: 32124 })).rejects.toThrow('32123'); expect(f.mutations()).toEqual([]);
});
it('status only observes', async () => { const f = await fixture(); await f.seed(); const result = await f.service().status(); expect(result.registration.kind).toBe('ours'); expect(result.running).toBe(false); expect(f.mutations()).toEqual([]); });

it.each(['development', 'unknown'] as const)('refuses %s distribution before writing', async kind => {
  const f = await fixture(); expect((await f.service({ distribution: async () => ({ kind, cliPath: '/dev/bin.mjs' }) }).install()).kind).toBe('install_refused');
  expect(f.mutations()).toEqual([]); expect((await f.registration()).kind).toBe('absent');
});
it.each(['LoadState=loaded\nFragmentPath=/unit\n', 'LoadState=loaded\nFragmentPath=/unit\nMainPID=0\nMainPID=0', 'LoadState=not-found\nFragmentPath=/unit\nMainPID=0', '', 'LoadState=loaded\nFragmentPath=/unit\nMainPID=-1'])('unknown structured properties refuse overwrite: %j', async stdout => {
  const f = await fixture(); await f.seed(); f.state.showReply = ok(stdout);
  expect((await f.service().install()).kind).toBe('install_refused'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([]);
});
it.each([failed('bus unavailable'), { ...failed('client timed out'), status: null }])('MainPID command failure is never absence', async response => {
  const f = await fixture(); await f.seed(); f.state.pidReply = response;
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstall_rolled_back'); expect(result.detail).toContain('query_failed');
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`]);
});
it('foreign and unrecognized registrations refuse all writes', async () => {
  const f = await fixture(); await f.seed(Buffer.from('foreign unit bytes'));
  expect((await f.service().install()).kind).toBe('install_refused'); expect((await f.service().uninstall()).kind).toBe('uninstall_refused');
  expect(await f.bytes()).toEqual(Buffer.from('foreign unit bytes')); expect(f.mutations()).toEqual([]);
});
it('changed definition with live manager PID refuses replacement', async () => {
  const f = await fixture(); await f.seed(); f.state.pid = 41001;
  expect((await f.service({ capturedPath: '/new/path' }).install()).kind).toBe('install_refused'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([]);
});
it('file changed during disable is retained without unlink or compensation', async () => {
  const f = await fixture(); await f.seed();
  f.state.onCommand = async command => { if (command.startsWith('disable ')) await writeFile(f.unitPath, 'external replacement'); };
  expect((await f.service().uninstall()).kind).toBe('uninstall_incomplete');
  expect((await f.bytes()).toString()).toBe('external replacement'); expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`]);
});
it('ambiguous disable completion reports observed disabled state without compensation', async () => {
  const f = await fixture(); await f.seed(); f.state.fail = `disable ${SYSTEMD_UNIT_NAME}`;
  f.state.onCommand = async command => { if (command === f.state.fail) f.state.enabled = false; };
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstall_incomplete'); expect(f.state.enabled).toBe(false);
  expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([f.state.fail]);
});
it.each(['daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`])('uninstall unload failure restores kept bytes and enable only: %s', async command => {
  const f = await fixture(); await f.seed(); f.state.fail = command;
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstall_rolled_back'); expect(await f.bytes()).toEqual(f.desired); expect(f.state.enabled).toBe(true);
  expect(f.mutations().at(-1)).toBe(`enable ${SYSTEMD_UNIT_NAME}`); expect(f.calls.filter(c => c === 'daemon-reload')).toHaveLength(1);
});
it('surviving loaded unit is unload failure, never absence', async () => {
  const f = await fixture(); await f.seed(); f.state.showReply = ok(`LoadState=loaded\nFragmentPath=${f.unitPath}\nMainPID=0`);
  expect((await f.service().uninstall()).kind).toBe('uninstall_rolled_back'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations().at(-1)).toBe(`enable ${SYSTEMD_UNIT_NAME}`);
});
it('resumed uninstall refuses a foreign manager PID without stopping it', async () => {
  const f = await fixture(); f.state.loaded = true; f.state.pid = 42000;
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('foreign_job_pid');
  expect(f.state.pid).toBe(42000); expect(f.mutations()).toEqual([]);
});
it('resumed unload failure has no bytes to restore', async () => {
  const f = await fixture(); f.state.loaded = true; f.state.fail = 'daemon-reload';
  expect((await f.service().uninstall()).kind).toBe('uninstall_incomplete'); expect((await f.registration()).kind).toBe('absent');
  expect(f.mutations()).toEqual(['daemon-reload']);
});
it('enable-only restoration failure is incomplete with actual bytes', async () => {
  const f = await fixture(); await f.seed(); f.state.pidReply = failed(); f.state.fail = `enable ${SYSTEMD_UNIT_NAME}`;
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('restore failed');
  expect(await f.bytes()).toEqual(f.desired); expect(f.state.enabled).toBe(false);
});
it.each([false, true])('failed install restores previous bytes when present=%s', async previous => {
  const f = await fixture(); if (previous) await f.seed();
  f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  const result = await f.service({ capturedPath: '/replacement/tools' }).install();
  expect(result.kind).toBe('install_rolled_back'); expect(result.retained).toBeNull();
  if (previous) { expect(await f.bytes()).toEqual(f.desired); expect(f.state.enabled).toBe(true); }
  else expect((await f.registration()).kind).toBe('absent');
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, ...(previous ? [`enable ${SYSTEMD_UNIT_NAME}`] : [])]);
});
it('rollback query failure restores withdrawn new bytes, never previous bytes', async () => {
  const f = await fixture(); await f.seed(); f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`; f.state.pidReply = failed();
  const result = await f.service({ capturedPath: '/replacement/tools' }).install();
  expect(result.kind).toBe('install_incomplete'); expect(result.detail).toContain('query_failed');
  expect((await f.bytes()).toString()).toContain('/replacement/tools'); expect(f.state.enabled).toBe(true);
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`]);
});
it('rollback unload failure restores previous bytes but remains incomplete', async () => {
  const f = await fixture(); await f.seed(); f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  f.state.onCommand = async command => { if (command.startsWith('disable ')) f.state.fail = `reset-failed ${SYSTEMD_UNIT_NAME}`; };
  const result = await f.service({ capturedPath: '/replacement/tools' }).install();
  expect(result.kind).toBe('install_incomplete'); expect(await f.bytes()).toEqual(f.desired); expect(f.state.enabled).toBe(true);
});
it('same PID with new birth cannot be classified as rolled back', async () => {
  const f = await fixture(); f.state.owner = { pid: 42000, startedAt: 'before', listen: '127.0.0.1:32123' }; f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  f.state.onCommand = async command => { if (command.startsWith('disable ')) f.state.owner = { pid: 42000, startedAt: 'after', listen: '127.0.0.1:32123' }; };
  const result = await f.service().install(); expect(result.kind).toBe('install_incomplete'); expect(result.retained).toEqual({ pid: 42000, startedAt: 'after' });
  expect(f.state.clock).toBe(0); expect(f.calls.some(c => c.startsWith('stop:'))).toBe(false);
});
it('failed install retains the identical self-hosted owner', async () => {
  const f = await fixture(); f.state.owner = { pid: 42000, startedAt: 'before', listen: '127.0.0.1:32123' }; f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  const result = await f.service().install(); expect(result.kind).toBe('install_rolled_back'); expect(result.retained).toEqual({ pid: 42000, startedAt: 'before' }); expect(f.state.clock).toBe(0);
});
it('rollback uncertain stop restores neither byte set and never unloads', async () => {
  const f = await fixture(); await f.seed(); f.state.autoStart = false;
  f.state.onCommand = async command => { if (command === `enable --now ${SYSTEMD_UNIT_NAME}`) { f.state.pid = 41001; f.state.owner = { pid: 41001, startedAt: 'new', listen: '127.0.0.1:32124' }; } };
  f.state.stopError = true;
  const result = await f.service({ capturedPath: '/replacement/tools' }).install(); expect(result.kind).toBe('install_incomplete'); expect(result.detail).toContain('stop_unconfirmed');
  expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, 'stop:41001']);
});
it('confirmed drain can take minutes and receives one stop', async () => {
  const f = await fixture(); await f.seed(); f.state.pid = 41001; f.state.owner = { pid: 41001, startedAt: 'long', listen: '127.0.0.1:32123' };
  f.state.onPause = async () => { if (f.state.clock >= 180_000) { f.state.owner = null; f.state.pid = 0; } };
  const result = await f.service({ stopOwner: async () => { f.calls.push('confirmed-stop'); } }).uninstall();
  expect(result.kind).toBe('uninstalled'); expect(f.state.clock).toBeGreaterThanOrEqual(180_000); expect(f.calls.filter(c => c === 'confirmed-stop')).toHaveLength(1);
});
it('unpublished manager child stays visible until it publishes and is drained', async () => {
  const f = await fixture(); f.state.autoStart = false; f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  f.state.onCommand = async command => { if (command === f.state.fail) f.state.pid = 41001; };
  f.state.onPause = async () => { if (f.state.pid) f.state.owner = { pid: f.state.pid, startedAt: 'late', listen: '127.0.0.1:32123' }; };
  const result = await f.service().install(); expect(result.kind).toBe('install_rolled_back'); expect(f.state.pid).toBe(0);
  const stopped = f.calls.indexOf('stop:41001'); expect(stopped).toBeGreaterThan(0); expect(f.calls.lastIndexOf('daemon-reload')).toBeGreaterThan(stopped);
});
it('final all-owner drain stops a newly appearing owner without another unload', async () => {
  const f = await fixture(); await f.seed();
  f.state.onCommand = async command => { if (command.startsWith('reset-failed')) f.state.owner = { pid: 42000, startedAt: 'late', listen: '127.0.0.1:32123' }; };
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstalled'); expect(f.state.owner).toBeNull();
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, 'stop:42000']);
});
it('final stop rejection does not restore or repeat unload', async () => {
  const f = await fixture(); await f.seed(); f.state.stopError = true;
  f.state.onCommand = async command => { if (command.startsWith('reset-failed')) f.state.owner = { pid: 42000, startedAt: 'late', listen: '127.0.0.1:32123' }; };
  const result = await f.service().uninstall(); expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('stop_unconfirmed'); expect(result.detail).toContain('already unloaded');
  expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, 'stop:42000']);
});
it('start owns the readiness timeout and never falls back to spawning', async () => {
  const f = await fixture(); await f.seed(); f.state.autoStart = false;
  await expect(f.service().start()).rejects.toThrow('readiness timed out'); expect(f.state.clock).toBe(25_000); expect(f.mutations()).toEqual([`start ${SYSTEMD_UNIT_NAME}`]);
});

it.each(['open', 'write', 'sync', 'close', 'rename'])('atomic %s failure preserves untouched previous bytes and cleans owned temporary files', async boundary => {
  const f = await fixture(); await f.seed(); const effects: string[] = [];
  const result = await f.service({ capturedPath: '/replacement/tools',
    open: async (...args) => {
      if (args[1] !== 'wx') return open(...args);
      effects.push('open'); if (boundary === 'open') throw new Error('open rejected');
      const file = await open(...args); const close = file.close.bind(file); const write = file.writeFile.bind(file); const sync = file.sync.bind(file);
      file.writeFile = async (...values) => { effects.push('write'); if (boundary === 'write') throw new Error('write rejected'); return write(...values); };
      file.sync = async () => { effects.push('sync'); if (boundary === 'sync') throw new Error('sync rejected'); return sync(); };
      file.close = async () => { effects.push('close'); await close(); if (boundary === 'close') throw new Error('close rejected'); };
      return file;
    },
    rename: async (...args) => { effects.push('rename'); if (boundary === 'rename') throw new Error('rename rejected'); await rename(...args); },
  }).install();
  expect(result.kind).toBe('install_incomplete'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([]);
  expect(await readdir(join(f.root, '.config/systemd/user'))).toEqual([SYSTEMD_UNIT_NAME]);
  expect(effects).toEqual(boundary === 'open' ? ['open'] : boundary === 'write' ? ['open', 'write', 'close'] : boundary === 'sync' || boundary === 'close' ? ['open', 'write', 'sync', 'close'] : ['open', 'write', 'sync', 'close', 'rename']);
});
it('successful publication orders write, fsync, close and rename before loading', async () => {
  const f = await fixture(); const effects: string[] = [];
  f.state.onCommand = async command => { if (command === 'daemon-reload') expect(effects).toEqual(['open', 'write', 'sync', 'close', 'rename']); };
  const result = await f.service({ open: async (...args) => {
    const file = await open(...args); if (args[1] !== 'wx') return file;
    effects.push('open'); const write = file.writeFile.bind(file); const sync = file.sync.bind(file); const close = file.close.bind(file);
    file.writeFile = async (...values) => { effects.push('write'); return write(...values); };
    file.sync = async () => { effects.push('sync'); return sync(); };
    file.close = async () => { effects.push('close'); return close(); }; return file;
  }, rename: async (...args) => { effects.push('rename'); await rename(...args); } }).install();
  expect(result.kind).toBe('installed'); expect(await f.bytes()).toEqual(f.desired);
});
it('concurrent change during fsync prevents rename and preserves the external bytes', async () => {
  const f = await fixture(); await f.seed();
  const result = await f.service({ capturedPath: '/replacement/tools', open: async (...args) => {
    const file = await open(...args); if (args[1] !== 'wx') return file;
    const sync = file.sync.bind(file); file.sync = async () => { await sync(); await writeFile(f.unitPath, 'external bytes'); }; return file;
  } }).install();
  expect(result.kind).toBe('install_incomplete'); expect((await f.bytes()).toString()).toBe('external bytes'); expect(f.mutations()).toEqual([]);
  expect(await readdir(join(f.root, '.config/systemd/user'))).toEqual([SYSTEMD_UNIT_NAME]);
});
it('restoration atomic write failure reports actual absent registration', async () => {
  const f = await fixture(); await f.seed(); f.state.pidReply = failed();
  const result = await f.service({ open: async (...args) => { if (args[1] === 'wx') throw new Error('restore open rejected'); return open(...args); } }).uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('restore failed'); expect((await f.registration()).kind).toBe('absent');
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`]);
});

it('owned temporary unlink failure reports incomplete and names the leftover file', async () => {
  const f = await fixture();
  const result = await f.service({ rename: async () => { throw new Error('rename rejected'); }, unlink: async () => { throw new Error('cleanup rejected'); } }).install();
  expect(result.kind).toBe('install_incomplete'); expect(result.leftovers.some(item => item.includes('.tmp'))).toBe(true);
  expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual([]);
  expect((await readdir(join(f.root, '.config/systemd/user'))).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
});
it.each([false, true])('unpublished write failure with manager absent and previous bytes=%s preserves bytes without withdrawing', async previous => {
  const f = await fixture(); if (previous) await f.seed(); f.state.loaded = false;
  const result = await f.service({ capturedPath: '/replacement/tools', open: async (...args) => { if (args[1] === 'wx') throw new Error('open rejected'); return open(...args); } }).install();
  expect(result.kind).toBe('install_rolled_back'); expect(f.mutations()).toEqual([]);
  if (previous) expect(await f.bytes()).toEqual(f.desired); else expect((await f.registration()).kind).toBe('absent');
});
it('owner read failure after unpublished write failure cannot mean unchanged absence', async () => {
  const f = await fixture(); let writing = false;
  const result = await f.service({ open: async () => { writing = true; throw new Error('open rejected'); }, readOwner: async () => { if (writing) throw new Error('owner unknown'); return null; } }).install();
  expect(result.kind).toBe('install_incomplete'); expect(result.leftovers.some(item => item.includes('owner unknown'))).toBe(true); expect(f.mutations()).toEqual([]);
});
it('relative XDG directory refuses installation with a complete outcome', async () => {
  const f = await fixture();
  const result = await f.service({ xdgConfigHome: 'relative' }).install();
  expect(result).toEqual({ kind: 'install_refused', detail: 'Config home must be absolute', retained: null, leftovers: [] }); expect(f.mutations()).toEqual([]);
});
it('rollback stops only after two stable owner observations', async () => {
  const f = await fixture(); f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  let withdrawn = false; let observations = 0;
  const owner = { pid: 41001, startedAt: 'same', listen: '127.0.0.1:32123' };
  f.state.onCommand = async command => {
    if (command === f.state.fail) { f.state.pid = owner.pid; f.state.owner = owner; }
    if (command.startsWith('disable ')) withdrawn = true;
  };
  const result = await f.service({ readOwner: async () => {
    if (withdrawn && ++observations <= 4) return observations % 2 === 0 ? { ...owner, listen: '127.0.0.1:32124' } : owner;
    return f.state.owner;
  } }).install();
  expect(result.kind).toBe('install_incomplete'); expect(result.detail).toContain('owner_unproven'); expect(await f.bytes()).toEqual(f.desired);
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`]);
});

it('readiness timeout rolls fresh install back after exactly 25 seconds', async () => {
  const f = await fixture(); f.state.autoStart = false;
  const result = await f.service().install(); expect(result.kind).toBe('install_rolled_back'); expect(result.detail).toContain('readiness timed out'); expect(f.state.clock).toBe(25_000);
  expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`]);
});
it('bundled install uses the captured executable and desktop Node mode with root-local logs', async () => {
  const f = await fixture();
  expect((await f.service({ distribution: async () => ({ kind: 'bundled', cliPath: '/bundle/daemon/bin/vonvon.mjs' }), executable: '/bundle/Electron' }).install()).kind).toBe('installed');
  const unit = (await f.bytes()).toString(); expect(unit).toContain('ExecStart="/bundle/Electron" "/bundle/daemon/bin/vonvon.mjs" daemon run --port 32123');
  expect(unit).toContain('Environment="ELECTRON_RUN_AS_NODE=1"'); expect(unit).toContain(`StandardOutput=append:${f.root}/service.log`); expect(unit).not.toContain('CODEX_BIN');
  expect(await readFile(join(f.root, 'service.log'))).toEqual(Buffer.alloc(0)); expect(await readFile(join(f.root, 'service.err.log'))).toEqual(Buffer.alloc(0));
});
it('authenticated self-hosted owner fixes the install port and stays running', async () => {
  const f = await fixture(); f.state.owner = { pid: 42000, startedAt: 'self-hosted', listen: '127.0.0.1:32124' };
  let verified = 0; const service = f.service({ verifyOwner: async () => { verified++; } });
  expect((await service.install({ port: 32123 })).kind).toBe('install_refused'); expect(f.mutations()).toEqual([]);
  expect((await service.install()).kind).toBe('installed'); expect((await f.bytes()).toString()).toContain('daemon run --port 32124'); expect(f.state.owner.pid).toBe(42000); expect(verified).toBe(3);
});
it.each(['open', 'write', 'sync', 'close', 'rename'])('restoration %s failure never reports rolled back', async boundary => {
  const f = await fixture(); await f.seed(); f.state.pidReply = failed();
  const result = await f.service({
    open: async (...args) => {
      if (boundary === 'open') throw new Error('restore open failed');
      const file = await open(...args); const close = file.close.bind(file);
      if (boundary === 'write') file.writeFile = async () => { throw new Error('restore write failed'); };
      if (boundary === 'sync') file.sync = async () => { throw new Error('restore sync failed'); };
      if (boundary === 'close') file.close = async () => { await close(); throw new Error('restore close failed'); };
      return file;
    },
    rename: async (...args) => { if (boundary === 'rename') throw new Error('restore rename failed'); await rename(...args); },
  }).uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('restore failed'); expect((await f.registration()).kind).toBe('absent'); expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`]);
  expect(await readdir(join(f.root, '.config/systemd/user'))).toEqual([]);
});
it.each(['disable', 'unlink'])('install rollback withdrawal %s failure cannot drain or restore', async boundary => {
  const f = await fixture(); f.state.fail = `enable --now ${SYSTEMD_UNIT_NAME}`;
  f.state.onCommand = async command => { if (command.startsWith('disable ') && boundary === 'disable') f.state.fail = command; };
  const result = await f.service(boundary === 'unlink' ? { unlink: async () => { throw new Error('unlink rejected'); } } : {}).install();
  expect(result.kind).toBe('install_incomplete'); expect(await f.bytes()).toEqual(f.desired);
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`]);
});
it('start authentication failure never starts or stops another owner', async () => {
  const f = await fixture(); await f.seed(); f.state.owner = { pid: 42000, startedAt: 'unproven', listen: '127.0.0.1:32123' };
  await expect(f.service({ verifyOwner: async () => { throw new Error('auth refused'); } }).start()).rejects.toThrow('auth refused'); expect(f.mutations()).toEqual([]);
});
it('unknown enable observation refuses installation before writing', async () => {
  const f = await fixture(); await f.seed(); f.state.enabledReply = { ...failed('client timed out'), status: null, stdout: 'enabled' };
  expect((await f.service().install()).kind).toBe('install_refused'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([]);
});

it('a foreign canonical root registration is never replaced or removed', async () => {
  const f = await fixture(); const other = await fixture();
  const rendered = renderDefinition({ target: f.target, ...f.definition, root: other.root }); if (rendered.platform !== 'linux') throw new Error('Expected unit');
  await f.seed(rendered.unit);
  expect((await f.service().install()).kind).toBe('install_refused'); expect((await f.service().uninstall()).kind).toBe('uninstall_refused');
  expect(await f.bytes()).toEqual(Buffer.from(rendered.unit)); expect(f.mutations()).toEqual([]);
});
it('symlink registration is never followed for mutation', async () => {
  const f = await fixture(); await f.seed(); const destination = join(f.root, 'external.unit'); await writeFile(destination, f.desired); await unlink(f.unitPath); await symlink(destination, f.unitPath);
  expect((await f.service().install()).kind).toBe('install_refused'); expect((await f.service().uninstall()).kind).toBe('uninstall_refused');
  expect(await readFile(destination)).toEqual(f.desired); expect(f.mutations()).toEqual([]);
});
it('ambiguous enable timeout still drains the child it actually launched', async () => {
  const f = await fixture(); const run = f.dependencies.run; if (!run) throw new Error('Missing fake manager');
  const result = await f.service({ run: async (args, timeout) => {
    const response = await run(args, timeout);
    return args.join(' ') === `enable --now ${SYSTEMD_UNIT_NAME}` ? { ...failed('client timed out'), status: null } : response;
  } }).install();
  expect(result.kind).toBe('install_rolled_back'); expect(f.state.pid).toBe(0); expect(f.state.owner).toBeNull(); expect((await f.registration()).kind).toBe('absent');
  expect(f.mutations()).toEqual(['daemon-reload', `enable --now ${SYSTEMD_UNIT_NAME}`, `disable ${SYSTEMD_UNIT_NAME}`, 'stop:41001', 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`]);
});
it('final owner read failure restores kept bytes without repeating unload', async () => {
  const f = await fixture(); await f.seed(); let afterUnload = false; let failedOnce = false;
  f.state.onCommand = async command => { if (command.startsWith('reset-failed')) afterUnload = true; };
  const result = await f.service({ readOwner: async () => { if (afterUnload && !failedOnce) { failedOnce = true; throw new Error('owner query failed'); } return null; } }).uninstall();
  expect(result.kind).toBe('uninstall_rolled_back'); expect(result.detail).toContain('query_failed'); expect(await f.bytes()).toEqual(f.desired);
  expect(f.mutations()).toEqual([`disable ${SYSTEMD_UNIT_NAME}`, 'daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`, `enable ${SYSTEMD_UNIT_NAME}`]);
});
it('unpublished write failure with previous unit disabled cannot promise enabled rollback', async () => {
  const f = await fixture(); await f.seed(); f.state.loaded = false; f.state.enabled = false;
  const result = await f.service({ capturedPath: '/replacement/tools', open: async () => { throw new Error('write denied'); } }).install();
  expect(result.kind).toBe('install_incomplete'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([]);
});

it.each(['before-withdrawal', 'during-withdrawal', 'after-withdrawal'])('uninstall observes the live manager child %s until it drains or exits', async phase => {
  const f = await fixture(); await f.seed();
  const owner = { pid: 41001, startedAt: 'race', listen: '127.0.0.1:32123' };
  if (phase === 'before-withdrawal') { f.state.pid = owner.pid; f.state.owner = owner; }
  f.state.onCommand = async command => { if (phase === 'during-withdrawal' && command.startsWith('disable ')) f.state.pid = owner.pid; };
  f.state.onPause = async () => {
    if (phase === 'during-withdrawal' && f.state.pid) f.state.owner = owner;
    if (phase === 'after-withdrawal') { expect((await f.registration()).kind).toBe('absent'); f.state.pid = 0; }
  };
  const result = await f.service({ unlink: async path => {
    await unlink(path);
    if (phase === 'after-withdrawal') f.state.pid = owner.pid;
  } }).uninstall();
  expect(result.kind).toBe('uninstalled'); expect(f.state.owner).toBeNull(); expect(f.state.pid).toBe(0); expect((await f.registration()).kind).toBe('absent');
  const stops = f.calls.filter(call => call.startsWith('stop:'));
  expect(stops).toEqual(phase === 'after-withdrawal' ? [] : ['stop:41001']);
  expect(f.calls.filter(call => call === 'daemon-reload')).toHaveLength(1);
});
it.each([false, true])('resumed matching-owner stop rejection stays terminal when accepted=%s', async accepted => {
  const f = await fixture(); f.state.loaded = true; f.state.pid = 41001; f.state.owner = { pid: 41001, startedAt: 'resumed', listen: '127.0.0.1:32123' };
  const work = { draining: false, completed: false };
  const result = await f.service({ stopOwner: async () => { f.calls.push('stop-attempt'); work.draining = accepted; throw new Error(accepted ? 'done reply lost' : 'socket refused'); } }).uninstall();
  expect(result.kind).toBe('uninstall_incomplete'); expect(result.detail).toContain('stop_unconfirmed'); expect(result.retained).toEqual({ pid: 41001, startedAt: 'resumed' });
  expect(work).toEqual({ draining: accepted, completed: false }); expect(f.mutations()).toEqual(['stop-attempt']); expect((await f.registration()).kind).toBe('absent');
});
it('a second uninstall converges after an uncertain stop eventually completes', async () => {
  const f = await fixture(); await f.seed(); f.state.pid = 41001; f.state.owner = { pid: 41001, startedAt: 'draining', listen: '127.0.0.1:32123' }; f.state.stopError = true;
  expect((await f.service().uninstall()).kind).toBe('uninstall_incomplete');
  f.state.owner = null; f.state.pid = 0; f.state.stopError = false; f.calls.length = 0;
  expect((await f.service().uninstall()).kind).toBe('uninstalled'); expect(f.mutations()).toEqual(['daemon-reload', `reset-failed ${SYSTEMD_UNIT_NAME}`]);
  expect((await f.service().uninstall()).kind).toBe('not-installed');
});

it.each([
  { ...failed(''), status: 4, stdout: 'disabled' },
  { ...failed(''), status: 3, stdout: 'disabled' },
  { ...ok('enabled'), status: null },
  { ...failed(''), status: 0, stdout: 'disabled' },
])('inconsistent is-enabled exit/output is unknown and refuses writes: %j', async reply => {
  const f = await fixture(); await f.seed(); f.state.enabledReply = reply;
  const result = await f.service().install(); expect(result.kind).toBe('install_refused'); expect(await f.bytes()).toEqual(f.desired); expect(f.mutations()).toEqual([]);
});
