import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { afterLinuxInstall, LINGER_QUESTION, runServiceCommand, runServiceStatus, type AfterInstallDependencies, type LingerChoice, type ServiceCommandDependencies } from '../src/cli/commands/service';
import { acquireMutex, closeMutex } from '../src/config/data-access';
import type { PidLockInfo } from '../src/server/pid-lock';
import { classifyServiceFailure, readServiceActionRecord } from '../src/service/action-report';
import { serviceStatus } from '../src/service/adapter';
import type { ServiceTransactionOutcome } from '../src/service/adapter';
import { TRANSLOCATED_REFUSAL } from '../src/service/launchd';

const outcome = (kind: ServiceTransactionOutcome['kind'], extra: Partial<ServiceTransactionOutcome> = {}): ServiceTransactionOutcome => ({ kind, detail: kind, retained: null, leftovers: [], ...extra });
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
/** A data root, and a daemon lock that `owners` hands out one read at a time (the last one repeats). */
async function helper(owners: (PidLockInfo | null)[] = [null]) {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-service-cli-')); roots.push(root);
  const reads = [...owners];
  const start = vi.fn(async (_port: number) => ({ pid: 4242 }));
  const deps: Partial<ServiceCommandDependencies> = { root, start, now: () => 1000, linux: undefined, readOwner: async () => (reads.length > 1 ? reads.shift() : reads[0]) ?? null };
  return { root, start, deps };
}
/** No data root: the s07 behaviour, without the mutex or the report. */
const absent: Partial<ServiceCommandDependencies> = { root: join(tmpdir(), 'vonvon-service-cli-absent', 'root'), readOwner: async () => null, linux: undefined };
const daemon: PidLockInfo = { pid: 31, startedAt: '2026-10-15T00:00:00.000Z', listen: '127.0.0.1:43210' };

it.each(['installed', 'already-installed'] as const)('install prints %s and succeeds', async kind => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const adapter = { install: vi.fn(async () => outcome(kind)), uninstall: vi.fn() };
  await runServiceCommand('install', adapter, { port: 32123 }, absent);
  expect(adapter.install).toHaveBeenCalledWith({ port: 32123 }); expect(adapter.uninstall).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledWith(`${kind}: ${kind}\n`);
});
it('a successful install names the service daemon without calling it left behind', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const adapter = { install: vi.fn(async () => outcome('installed', { detail: 'Installed', retained: { pid: 7, startedAt: 'x' }, leftovers: ['retained pid 7', 'plist /p: ours'] })), uninstall: vi.fn() };
  await runServiceCommand('install', adapter, {}, absent);
  expect(write).toHaveBeenCalledWith('installed: Installed\nDaemon PID 7 is running under the service.\n');
});
it.each(['install_refused', 'install_rolled_back', 'install_incomplete'] as const)('install %s fails with the detail and what was left behind', async kind => {
  const adapter = { install: vi.fn(async () => outcome(kind, { detail: 'stop_unconfirmed: lost', retained: { pid: 7, startedAt: 'x' }, leftovers: ['plist /p: ours'] })), uninstall: vi.fn() };
  await expect(runServiceCommand('install', adapter, {}, absent)).rejects.toThrow(`${kind}: stop_unconfirmed: lost\nDaemon PID 7 is still running.\nLeft behind: plist /p: ours\nNext step: vonvon service uninstall`);
});
it('uninstall reports not-installed as success', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const adapter = { install: vi.fn(), uninstall: vi.fn(async () => outcome('not-installed')) };
  await expect(runServiceCommand('uninstall', adapter, {}, absent)).resolves.toBeUndefined();
});

const observed = { platformName: 'launchd (macOS)', name: 'com.vonvon.bot.daemon', servicePath: '/Users/u/Library/LaunchAgents/com.vonvon.bot.daemon.plist', ownerError: null } as const;
const ours = { kind: 'ours', definition: {} } as never;
it.each([
  ['not-installed', { registration: { kind: 'absent' }, manager: { kind: 'absent' }, owner: null, running: false }],
  ['conflict', { registration: { kind: 'absent' }, manager: { kind: 'enabled', pid: null }, owner: null, running: false }],
  ['disabled', { registration: ours, manager: { kind: 'absent' }, owner: null, running: false }],
  ['running', { registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: true }],
  ['detached', { registration: ours, manager: { kind: 'enabled', pid: null }, owner: { pid: 9 }, running: true }],
  ['stopped', { registration: ours, manager: { kind: 'enabled', pid: null }, owner: null, running: false }],
  ['conflict', { registration: { kind: 'unrecognized', location: '/p', reason: 'old' }, manager: { kind: 'enabled', pid: null }, owner: null, running: false }],
  ['unknown', { registration: ours, manager: { kind: 'unknown', detail: 'timed out' }, owner: null, running: false }],
] as const)('status folds into %s', (state, input) => {
  const status = serviceStatus({ ...observed, ...input } as Parameters<typeof serviceStatus>[0]);
  expect(status.state).toBe(state);
  expect(status.installed).toBe(input.registration.kind !== 'absent');
  expect(status.pid).toBe(input.running ? '9' : undefined);
});
it('a plist that launchd does not know reads as turned off in System Settings (e06)', () => {
  const status = serviceStatus({ ...observed, registration: ours, manager: { kind: 'absent' }, owner: null, running: false });
  expect(status.detail).toContain('Login Items & Extensions');
});
it('a daemon that does not authenticate is a conflict, not running', () => {
  const status = serviceStatus({ ...observed, registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: false, ownerError: 'bad credential' });
  expect(status.state).toBe('conflict'); expect(status.detail).toContain('bad credential');
});
it('status prints the state, its next step and the files, or JSON', async () => {
  const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const status = serviceStatus({ ...observed, registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: true });
  await runServiceStatus(false, { status: async () => status });
  expect(String(write.mock.calls[0]?.[0])).toMatch(/^launchd \(macOS\) com\.vonvon\.bot\.daemon: running \(PID 9\)\nRunning under the service manager\.\nDefinition: .*com\.vonvon\.bot\.daemon\.plist\nLogs: /);
  await runServiceStatus(true, { status: async () => status });
  expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({ state: 'running', pid: '9', installed: true });
});
describe('the manager\'s record of the exits (s17b)', () => {
  const killed = { manager: 'launchd', runs: 4, lastExitCode: null, lastExitText: null, lastSignal: 'Killed: 9' } as const;
  const running = { ...observed, registration: ours, manager: { kind: 'enabled', pid: 9 }, owner: { pid: 9 }, running: true } as const;
  it('adds the record and its line without changing the state', () => {
    const plain = serviceStatus(running);
    const withExits = serviceStatus({ ...running, exits: killed });
    expect(withExits).toEqual({ ...plain, exits: killed, lastExit: '被信号结束（Killed: 9，kill -9 或内存不够）' });
    expect(plain).not.toHaveProperty('exits');
    expect(plain).not.toHaveProperty('lastExit');
    // systemd while the service runs keeps no last exit: after a restart the web page says so as the command does;
    // before any, it has none.
    const systemd = (nRestarts: number) => serviceStatus({ ...running, platformName: 'systemd (Linux)', exits: { manager: 'systemd', result: 'success', execMainCode: 0, execMainStatus: 0, nRestarts, exitedAt: null } });
    expect(systemd(1).exits).toMatchObject({ nRestarts: 1 });
    expect(systemd(1).lastExit).toBe('服务在运行时 systemd 不保留，崩溃记录看 vonvon daemon status');
    expect(systemd(0)).not.toHaveProperty('lastExit');
  });
  it('prints the lines after the state and before the files; --json carries both fields', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const status = serviceStatus({ ...running, exits: killed });
    await runServiceStatus(false, { status: async () => status });
    expect(String(write.mock.calls[0]?.[0]).split('\n').slice(0, 5)).toEqual([
      'launchd (macOS) com.vonvon.bot.daemon: running (PID 9)',
      'Running under the service manager.',
      '上次退出：被信号结束（Killed: 9，kill -9 或内存不够）',
      '启动次数：4（launchd 从这次登录或安装服务算起）',
      'Definition: /Users/u/Library/LaunchAgents/com.vonvon.bot.daemon.plist',
    ]);
    await runServiceStatus(true, { status: async () => status });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({ exits: killed, lastExit: '被信号结束（Killed: 9，kill -9 或内存不够）' });
  });
});

describe('Linux: linger and the user manager (s20a)', () => {
  const guide = ['网页地址：', '  http://127.0.0.1:41234/'];
  function after(state: 'on' | 'off' | 'unknown', fields: Partial<AfterInstallDependencies> = {}) {
    let out = '';
    const states = [state];
    const d: AfterInstallDependencies = {
      readLinger: vi.fn(async () => ({ state: states.shift() ?? state, ...(state === 'unknown' ? { detail: '找不到 loginctl' } : {}) })),
      enableLinger: vi.fn(async () => ({ ok: true as const })), ask: vi.fn(async () => true), interactive: true, user: 'ops',
      guide: async () => guide, write: text => { out += text; }, ...fields,
    };
    return { d, out: () => out, run: (choice: LingerChoice) => afterLinuxInstall(choice, d) };
  }
  const OFF = '没开 linger：退出最后一个登录会话后 Bot 会停，开机也不启动。要开就运行 loginctl enable-linger（不行再用 sudo loginctl enable-linger ops）。';
  it.each([
    ['on', 'ask', true, ['linger 已开：开机就启动，退出 SSH 以后 bot 也还在跑。'], false, false],
    ['off', 'ask', true, ['已开 linger。'], true, true],
    ['off', 'ask', false, [OFF], true, false],
    ['off', 'off', true, [OFF], false, false],
    ['off', 'on', true, ['已开 linger。'], false, true],
    ['unknown', 'ask', true, ['查不到 linger 的状态：找不到 loginctl。要开就运行 loginctl enable-linger（不行再用 sudo loginctl enable-linger ops）。'], false, false],
  ] as const)('linger %s with %s and an answer of %s', async (state, choice, answer, lines, asked, enabled) => {
    const h = after(state, { ask: vi.fn(async () => answer) });
    await expect(h.run(choice)).resolves.toBe(true);
    expect(h.out()).toBe([...lines, ...guide, ''].join('\n'));
    expect(h.d.ask).toHaveBeenCalledTimes(asked ? 1 : 0);
    if (asked) expect(h.d.ask).toHaveBeenCalledWith(LINGER_QUESTION);
    expect(h.d.enableLinger).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });
  it('asks nobody without a terminal, and fails only --linger that did not take', async () => {
    const piped = after('off', { interactive: false });
    await piped.run('ask');
    expect(piped.d.ask).not.toHaveBeenCalled();
    expect(piped.d.enableLinger).not.toHaveBeenCalled();
    const failed = after('off', { enableLinger: vi.fn(async () => ({ ok: false as const, detail: 'Access denied' })) });
    await expect(failed.run('on')).resolves.toBe(false);
    expect(failed.out()).toBe(['没开成：Access denied。用管理员权限运行：sudo loginctl enable-linger ops', ...guide, ''].join('\n'));
    await expect(after('off', { enableLinger: failed.d.enableLinger }).run('ask')).resolves.toBe(true);
  });
  const linux = (fields: Partial<NonNullable<ServiceCommandDependencies['linux']>> = {}) => ({ ...absent, linux: { afterInstall: vi.fn(async () => true), afterUninstall: vi.fn(async () => undefined), hint: vi.fn(async () => undefined), ...fields } });
  it('runs the Linux step after a successful install only, and exits 1 when it says so', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const ok = linux();
    await runServiceCommand('install', { install: vi.fn(async () => outcome('installed')), uninstall: vi.fn() }, { linger: 'on' }, ok);
    expect(ok.linux.afterInstall).toHaveBeenCalledWith('on');
    const refused = linux();
    await expect(runServiceCommand('install', { install: vi.fn(async () => outcome('install_refused')), uninstall: vi.fn() }, {}, refused)).rejects.toThrow('install_refused');
    expect(refused.linux.afterInstall).not.toHaveBeenCalled();
    await expect(runServiceCommand('install', { install: vi.fn(async () => outcome('installed')), uninstall: vi.fn() }, {}, linux({ afterInstall: async () => false }))).rejects.toThrow('服务已经装好，只是 linger 没开成。');
  });
  it('explains an unavailable user manager and a linger left on by uninstall', async () => {
    const hint = '当前终端没有 XDG_RUNTIME_DIR（用 sudo -u 或 su 切到这个账号时常见）。';
    const failed = { install: vi.fn(async () => outcome('install_refused', { detail: 'User manager unavailable: Failed to connect to bus: No medium found' })), uninstall: vi.fn() };
    await expect(runServiceCommand('install', failed, {}, linux({ hint: async () => hint }))).rejects.toThrow(`install_refused: User manager unavailable: Failed to connect to bus: No medium found\n${hint}`);
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const kept = 'linger 没关：这个账号上别的用户服务可能也要它。不需要的话运行 loginctl disable-linger。';
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('uninstalled', { detail: 'Uninstalled' })) }, {}, linux({ afterUninstall: async () => kept }));
    expect(write).toHaveBeenLastCalledWith(`uninstalled: Uninstalled\n${kept}\n`);
  });
  it('status prints the hint under the manager error and the linger line', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const status = serviceStatus({ ...observed, platformName: 'systemd (Linux)', registration: ours, manager: { kind: 'unknown', detail: 'Failed to connect to bus: No medium found' }, owner: null, running: false });
    await runServiceStatus(false, { status: async () => ({ ...status, hint: '当前终端没有 XDG_RUNTIME_DIR。', linger: { state: 'on' } }) });
    expect(String(write.mock.calls[0]?.[0])).toMatch(/: unknown\nCannot ask systemd \(Linux\): Failed to connect to bus: No medium found\n当前终端没有 XDG_RUNTIME_DIR。\nlinger 已开：开机就启动，退出 SSH 以后 bot 也还在跑。\nDefinition: /);
    await runServiceStatus(true, { status: async () => ({ ...status, linger: { state: 'off' } }) });
    expect(JSON.parse(String(write.mock.calls[1]?.[0]))).toMatchObject({ state: 'unknown', linger: { state: 'off' } });
  });
});

describe('the helper run (s08)', () => {
  it('records running before the transaction and the result after it, readable only by the user', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { root, deps } = await helper();
    const adapter = { install: vi.fn(async () => { expect(readServiceActionRecord(root)).toEqual({ pid: process.pid, action: 'install', phase: 'running', startedAt: 1000 }); return outcome('installed', { detail: 'Installed' }); }), uninstall: vi.fn() };
    await runServiceCommand('install', adapter, {}, deps);
    expect(adapter.install).toHaveBeenCalledOnce();
    expect(readServiceActionRecord(root)).toEqual({ pid: process.pid, action: 'install', phase: 'done', ok: true, kind: 'installed', detail: 'Installed', leftovers: [], startedAt: 1000, finishedAt: 1000 });
    if (process.platform !== 'win32') expect((await stat(join(root, 'service-action.json'))).mode & 0o777).toBe(0o600);
  });
  it.each([
    ['installed', true], ['already-installed', true], ['uninstalled', true], ['not-installed', true],
    ['install_refused', false], ['install_rolled_back', false], ['install_incomplete', false],
    ['uninstall_refused', false], ['uninstall_rolled_back', false], ['uninstall_incomplete', false],
  ] as const)('reports %s with ok=%s and, on failure, its reason', async (kind, ok) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { root, deps } = await helper();
    const action = kind.startsWith('un') || kind === 'not-installed' ? 'uninstall' : 'install';
    const detail = ok ? 'Done' : 'Run vonvon daemon stop before replacing the service';
    const transaction = vi.fn(async () => outcome(kind, { detail, leftovers: ['plist /p: ours'] }));
    const run = runServiceCommand(action, { install: transaction, uninstall: transaction }, {}, deps);
    if (ok) await run; else await expect(run).rejects.toThrow(`${kind}: ${detail}`);
    expect(readServiceActionRecord(root)).toEqual({
      pid: process.pid, action, phase: 'done', ok, kind, detail, leftovers: ['plist /p: ours'], startedAt: 1000, finishedAt: 1000,
      ...(ok ? {} : { reason: 'replace-running' }),
    });
  });
  it('--keep-running after install_incomplete starts the drained daemon again on its port', async () => {
    const { root, start, deps } = await helper([daemon, null]);
    const adapter = { install: vi.fn(async () => outcome('install_incomplete', { detail: 'Daemon readiness timed out; the detached daemon was stopped, run vonvon daemon start to start it again' })), uninstall: vi.fn() };
    await expect(runServiceCommand('install', adapter, { keepRunning: true }, deps)).rejects.toThrow('Daemon PID 4242 was started again, detached, on port 43210.');
    expect(start).toHaveBeenCalledWith(43210);
    expect(readServiceActionRecord(root)).toMatchObject({ phase: 'done', ok: false, kind: 'install_incomplete', reason: 'other', restarted: { pid: 4242 } });
  });
  it('--keep-running after uninstall starts a detached daemon on the old port', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { root, start, deps } = await helper([daemon, null]);
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('uninstalled', { detail: 'Uninstalled' })) }, { keepRunning: true }, deps);
    expect(start).toHaveBeenCalledWith(43210);
    expect(write).toHaveBeenCalledWith('uninstalled: Uninstalled\nDaemon PID 4242 was started again, detached, on port 43210.\n');
    expect(readServiceActionRecord(root)).toMatchObject({ ok: true, kind: 'uninstalled', restarted: { pid: 4242 } });
  });
  it('--keep-running does not start a daemon on a fresh port when the old one had not published its port', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { root, start, deps } = await helper([{ ...daemon, listen: null }, null]);
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('uninstalled', { detail: 'Uninstalled' })) }, { keepRunning: true }, deps);
    expect(start).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('uninstalled: Uninstalled\nThe daemon was not started again: Daemon PID 31 had not published its port. Run vonvon daemon start.\n');
    expect(readServiceActionRecord(root)).toMatchObject({ ok: true, restartError: 'Daemon PID 31 had not published its port' });
    expect(readServiceActionRecord(root)).not.toHaveProperty('restarted');
  });
  it('--keep-running records a failed restart without failing the uninstall', async () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { root, start, deps } = await helper([daemon, null]);
    start.mockRejectedValueOnce(new Error('Daemon readiness timed out.'));
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('uninstalled')) }, { keepRunning: true }, deps);
    expect(readServiceActionRecord(root)).toMatchObject({ ok: true, restartError: 'Daemon readiness timed out.' });
  });
  it.each([
    ['no daemon ran before', [null], true],
    ['the service now runs one', [daemon, { ...daemon, pid: 32 }], true],
    ['--keep-running was not given', [daemon, null], false],
  ] as const)('starts nothing when %s', async (_case, owners, keepRunning) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { root, start, deps } = await helper([...owners]);
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('uninstalled')) }, { keepRunning }, deps);
    expect(start).not.toHaveBeenCalled();
    expect(readServiceActionRecord(root)).not.toHaveProperty('restarted');
  });
  it('refuses while another install or uninstall holds the service mutex, and leaves the report alone', async () => {
    const { root, deps } = await helper();
    const previous = `${JSON.stringify({ pid: 77, action: 'install', phase: 'running', startedAt: 5 })}\n`;
    await writeFile(join(root, 'service-action.json'), previous);
    const held = await acquireMutex(root, 'service', 0);
    try {
      const adapter = { install: vi.fn(), uninstall: vi.fn() };
      await expect(runServiceCommand('uninstall', adapter, { keepRunning: true }, deps)).rejects.toThrow(/^uninstall_refused: Another vonvon service install or uninstall is running\.$/);
      expect(adapter.uninstall).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'service-action.json'), 'utf8')).toBe(previous);
    } finally { await closeMutex(held); }
    // The mutex is released after each run, so the next one goes ahead.
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('not-installed')) }, {}, deps);
    await runServiceCommand('uninstall', { install: vi.fn(), uninstall: vi.fn(async () => outcome('not-installed')) }, {}, deps);
  });
  it('turns a thrown transaction into an incomplete report', async () => {
    const { root, deps } = await helper();
    await expect(runServiceCommand('install', { install: vi.fn(async () => { throw new Error('EACCES: plist'); }), uninstall: vi.fn() }, {}, deps)).rejects.toThrow('install_incomplete: EACCES: plist');
    expect(readServiceActionRecord(root)).toMatchObject({ phase: 'done', ok: false, kind: 'install_incomplete', reason: 'other', detail: 'EACCES: plist' });
  });
});

// The s07 strings as launchd.ts, systemd.ts and adapter.ts write them; a reworded refusal fails here first.
it.each([
  ['launchd has no job for the installed plist. launchd has not loaded the service; if it is turned off in System Settings > General > Login Items & Extensions, turn it on. Or run vonvon daemon stop, then vonvon service install.', 'turned-off'],
  ['Bootstrap failed: 5: Input/output error launchd has not loaded the service; if it is turned off in System Settings > General > Login Items & Extensions, turn it on.', 'turned-off'],
  ['Run vonvon daemon stop before replacing the service', 'replace-running'],
  ['Distribution cannot install a service', 'distribution'],
  [TRANSLOCATED_REFUSAL, 'translocated'],
  ['Interrupted uninstall; run vonvon service uninstall first', 'interrupted'],
  ['Registration belongs to /Users/u/.vonvon-other', 'other-root'],
  ['GUI domain unavailable', 'manager-unavailable'],
  ['GUI domain unavailable: Could not find domain for user gui: 501', 'manager-unavailable'],
  ['launchd query failed: launchctl client timed out', 'manager-unavailable'],
  ['User manager unavailable: offline', 'manager-unavailable'],
  ['User manager unavailable: Failed to connect to bus: No medium found', 'manager-unavailable'],
  ['Could not stop the detached daemon: stop_unconfirmed: lost', 'other'],
  ['Daemon readiness timed out; the detached daemon was stopped, run vonvon daemon start to start it again', 'other'],
] as const)('classifies %s', (detail, reason) => {
  expect(classifyServiceFailure(detail)).toBe(reason);
});
