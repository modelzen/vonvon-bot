import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PidLockInfo } from '../src/server/pid-lock';
import { renderDefinition } from '../src/service/definitions';
import { resolveServiceRoot, serviceTarget, type CanonicalRoot } from '../src/service/identity';
import { decodeConsoleText, withTimeout, type WindowsCommandResult } from '../src/service/windows-command';
import { createWindowsService, NOT_RUNNING_WARNING, parseCsvRow, WINDOWS_SERVICE_TIMING } from '../src/service/windows';
import { fail, foreignTaskXml, INSTALL_ROOT, NO_TASK, ok, recorder, reserialized, SID, standalone, WHOAMI } from './service-windows-fixture';

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The task as Task Scheduler gives it back after someone disabled it. */
const disabled = (xml: Uint8Array | null): Buffer => Buffer.from(decodeConsoleText(xml ?? Buffer.alloc(0)).replace('<Enabled>true</Enabled>\n\t<RestartOnFailure>', '<Enabled>false</Enabled>\n\t<RestartOnFailure>'));
const owner = (pid: number, port = 7788): PidLockInfo => ({ pid, startedAt: `2026-11-01T00:00:0${pid % 10}.000Z`, listen: `127.0.0.1:${port}` });

/** Task Scheduler, the data root's lock and the supervisor, as one fake machine on a fake clock. */
async function machine(extra: NonNullable<Parameters<typeof createWindowsService>[1]> = {}) {
  const root = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-tx-'))); dirs.push(root);
  const temp = await mkdtemp(join(tmpdir(), 'vonvon-win-tmp-')); dirs.push(temp);
  const target = serviceTarget({ platform: 'win32', sid: SID, root });
  const name = target.taskName;
  const state = {
    clock: 0, task: null as Uint8Array | null, status: 'Ready', lock: null as PidLockInfo | null, supervisor: null as number | null,
    alive: new Set<number>(), createdFile: '', createdBytes: null as Buffer | null, lockReads: 0,
    reply: {} as Record<string, WindowsCommandResult | undefined>,
    /** Called on every lock read; returns the lock to show. */
    onRead: (_reads: number): void => {},
    onRun: (): void => {}, onStop: (_pid: number): void => {}, onKill: (pid: number): void => { if (state.lock?.pid === pid) state.lock = null; state.alive.delete(pid); },
    onSleep: (): void => {},
    onDelete: (): WindowsCommandResult => { state.task = null; return ok(); },
  };
  const r = recorder(async (command, args) => {
    const key = [command, ...args.filter(arg => arg !== name)].join(' ');
    const injected = Object.entries(state.reply).find(([prefix]) => key.startsWith(prefix))?.[1];
    if (injected) return injected;
    if (command === 'whoami') return WHOAMI;
    if (key === 'schtasks /Query /TN /FO CSV /NH') return state.task ? ok(`"${name}","N/A","${state.status}"\r\n`) : NO_TASK;
    if (key === 'schtasks /Query /TN /XML') return state.task ? ok(state.task) : NO_TASK;
    if (key === 'schtasks /Query /TN /FO CSV /V /NH') return state.task ? ok(`"HOST","${name}","N/A","${state.status}","Interactive only"\r\n`) : NO_TASK;
    if (key.startsWith('schtasks /Create /TN /XML ')) {
      state.createdFile = args[4] ?? '';
      state.createdBytes = await readFile(state.createdFile);
      state.task = reserialized(decodeConsoleText(state.createdBytes));
      return ok('SUCCESS: The scheduled task has been created.');
    }
    if (key === 'schtasks /Run /TN') { state.onRun(); return ok('SUCCESS: Attempted to run.'); }
    if (key === 'schtasks /End /TN') return ok();
    if (key === 'schtasks /Delete /TN /F') return state.onDelete();
    if (command === 'taskkill') { state.onKill(Number(args[3])); return ok(); }
    throw new Error(`unexpected ${key}`);
  });
  const stops: number[] = [];
  const service = createWindowsService({ root }, {
    run: r.run, tmpdir: temp, capturedPath: 'C:\\Windows\\system32',
    distribution: async () => ({ kind: 'standalone', cliPath: `${INSTALL_ROOT}\\releases\\1.0.0\\app\\bin\\vonvon.mjs`, installRoot: INSTALL_ROOT }),
    isFile: () => true, freePort: async () => 7788,
    readLock: async () => { state.lockReads++; state.onRead(state.lockReads); return state.lock; },
    verifyOwner: async () => {},
    stopHost: async (_root, lock) => { stops.push(lock.pid); r.calls.push(`stopHost ${lock.pid}`); state.onStop(lock.pid); },
    readSupervisor: async () => state.supervisor, isAlive: pid => state.alive.has(pid),
    sleep: async ms => { state.clock += ms; state.onSleep(); if (state.clock > 600_000) throw new Error('fake clock ran away'); }, now: () => state.clock,
    ...extra,
  });
  const ours = (port = 7788) => renderDefinition({ target, root: root as CanonicalRoot, port, distribution: standalone, capturedPath: 'C:\\Windows\\system32' }).xml;
  const schtasks = () => r.calls.filter(call => !call.startsWith('stopHost'));
  return { root, temp, name, state, calls: r.calls, schtasks, stops, service, ours };
}

it('installs: whoami, /Query, /Create from a temporary file, /Run, then waits for the daemon', async () => {
  const m = await machine();
  m.state.onRead = reads => { if (reads === 3) m.state.lock = owner(41001); };
  const result = await m.service.install();
  expect(result).toMatchObject({ kind: 'installed', retained: { pid: 41001 } });
  expect(m.calls).toEqual([
    'whoami /user /fo csv /nh',
    `schtasks /Query /TN ${m.name} /FO CSV /NH`,
    `schtasks /Create /TN ${m.name} /XML ${m.state.createdFile} /F`,
    `schtasks /Run /TN ${m.name}`,
  ]);
  expect(m.calls.some(call => / \/(SC|RL|RU) /.test(call))).toBe(false);
  expect(m.state.createdFile.startsWith(join(m.temp, 'vonvon-task-'))).toBe(true);
  expect(m.state.createdBytes?.equals(Buffer.from(m.ours()))).toBe(true);
  expect(existsSync(m.state.createdFile)).toBe(false);
  expect(existsSync(join(m.state.createdFile, '..'))).toBe(false);
});

it('replaces its own task with /F, but leaves a foreign one alone', async () => {
  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours(7799)));
  m.state.onRun = () => { m.state.lock = owner(41001, 7799); };
  await expect(m.service.install()).resolves.toMatchObject({ kind: 'installed' });
  expect(m.calls).toContain(`schtasks /Create /TN ${m.name} /XML ${m.state.createdFile} /F`);
  expect(decodeConsoleText(m.state.createdBytes ?? Buffer.alloc(0))).toContain('--port 7799');

  const f = await machine();
  f.state.task = foreignTaskXml();
  await expect(f.service.install()).resolves.toMatchObject({ kind: 'install_refused', reason: 'task_foreign' });
  expect(f.calls.some(call => call.includes('/Create') || call.includes('/Delete'))).toBe(false);
  expect(f.state.task).toEqual(foreignTaskXml());
});

it('a task for another data root is task_other_root', async () => {
  const m = await machine();
  const other = await resolveServiceRoot(await mkdtemp(join(tmpdir(), 'vonvon-win-other-'))); dirs.push(other);
  m.state.task = renderDefinition({ target: serviceTarget({ platform: 'win32', sid: SID, root: m.root }), root: other, port: 7788, distribution: standalone, capturedPath: '' }).xml;
  await expect(m.service.install()).resolves.toMatchObject({ kind: 'install_refused', reason: 'task_other_root' });
  expect(m.calls.some(call => call.includes('/Create'))).toBe(false);
});

it('maps /Create failures: Access is denied → schtasks_denied with the detached fallback; anything else → schtasks_create_failed', async () => {
  for (const stderr of ['ERROR: Access is denied.', '错误: 拒绝访问。', 'ERROR: 0x80070005']) {
    const m = await machine();
    m.state.reply['schtasks /Create'] = fail(stderr);
    await expect(m.service.install()).resolves.toMatchObject({ kind: 'install_refused', reason: 'schtasks_denied', fallback: 'detached' });
    expect(m.calls.some(call => call.includes('/Run'))).toBe(false);
  }
  const m = await machine();
  m.state.reply['schtasks /Create'] = fail('ERROR: The task XML is malformed.');
  const result = await m.service.install();
  expect(result).toMatchObject({ kind: 'install_refused', reason: 'schtasks_create_failed' });
  expect(result.detail).toContain('The task XML is malformed.');
  expect(result.fallback).toBeUndefined();
  expect(existsSync(m.state.createdFile || join(m.temp, 'none'))).toBe(false);
  expect(await import('node:fs/promises').then(fs => fs.readdir(m.temp))).toEqual([]);
});

it('a /Run that fails leaves the task registered and says to run daemon start', async () => {
  const m = await machine();
  m.state.reply['schtasks /Run'] = fail('ERROR: The task is disabled.');
  const result = await m.service.install();
  expect(result).toMatchObject({ kind: 'install_incomplete', reason: 'schtasks_run_failed' });
  expect(result.detail).toContain('vonvon daemon start');
  expect(m.state.task).not.toBeNull();
});

it('no daemon within 30 s is still installed, with a warning; /Run is asked once more after 5 s', async () => {
  const m = await machine();
  const result = await m.service.install();
  expect(result).toMatchObject({ kind: 'installed', warning: NOT_RUNNING_WARNING });
  expect(result.detail).toContain(NOT_RUNNING_WARNING);
  expect(m.state.clock).toBeGreaterThanOrEqual(WINDOWS_SERVICE_TIMING.readyMs);
  expect(m.state.clock).toBeLessThan(WINDOWS_SERVICE_TIMING.readyMs + 1000);
  expect(m.calls.filter(call => call.includes('/Run'))).toHaveLength(2);
  expect(m.state.task).not.toBeNull();
});

it('hands a detached daemon over: stops it, waits for it to exit, then /Run on its port', async () => {
  const m = await machine();
  m.state.lock = owner(500, 7801);
  m.state.onStop = () => { m.state.onSleep = () => { if (m.state.clock >= 2000) m.state.lock = null; }; };
  m.state.onRun = () => { m.state.lock = owner(600, 7801); };
  await expect(m.service.install()).resolves.toMatchObject({ kind: 'installed', retained: { pid: 600 } });
  expect(m.calls.slice(-3)).toEqual([`schtasks /Create /TN ${m.name} /XML ${m.state.createdFile} /F`, 'stopHost 500', `schtasks /Run /TN ${m.name}`]);
  expect(decodeConsoleText(m.state.createdBytes ?? Buffer.alloc(0))).toContain('--port 7801');
  expect(m.calls.some(call => call.startsWith('taskkill'))).toBe(false);
});

it('a daemon that does not exit 15 s after the stop is killed with taskkill /T /F', async () => {
  const m = await machine();
  m.state.lock = owner(500);
  m.state.onRun = () => { m.state.lock = owner(600); };
  await expect(m.service.install()).resolves.toMatchObject({ kind: 'installed', retained: { pid: 600 } });
  expect(m.calls).toContain('taskkill /T /F /PID 500');
  expect(m.calls.indexOf('taskkill /T /F /PID 500')).toBeLessThan(m.calls.indexOf(`schtasks /Run /TN ${m.name}`));
  expect(m.state.clock).toBeGreaterThanOrEqual(WINDOWS_SERVICE_TIMING.handoverMs);
});

it('hands over once the daemon is gone, whatever a stale supervisor.pid names, and kills nothing by PID (F6)', async () => {
  // supervisor.pid left by a killed supervisor, its PID now someone else's: the hand-over does not wait on it.
  const m = await machine();
  m.state.lock = owner(500);
  m.state.supervisor = 499; m.state.alive.add(499);
  m.state.onStop = () => { m.state.lock = null; };
  m.state.onRun = () => { m.state.lock = owner(600); };
  await expect(m.service.install()).resolves.toMatchObject({ kind: 'installed', retained: { pid: 600 } });
  expect(m.calls.slice(-2)).toEqual(['stopHost 500', `schtasks /Run /TN ${m.name}`]);
  expect(m.calls.some(call => call.startsWith('taskkill'))).toBe(false);
  expect(m.state.clock).toBeLessThan(WINDOWS_SERVICE_TIMING.handoverMs);
});

it('a /Run that IgnoreNew drops while the old supervisor exits is asked again after 5 s', async () => {
  const m = await machine();
  m.state.lock = owner(500);
  m.state.onStop = () => { m.state.lock = null; };
  let runs = 0;
  m.state.onRun = () => { runs++; if (runs === 2) m.state.lock = owner(600); };
  await expect(m.service.install()).resolves.toMatchObject({ kind: 'installed', retained: { pid: 600 } });
  expect(m.calls.filter(call => call.includes('/Run'))).toHaveLength(2);
  expect(m.state.clock).toBeGreaterThanOrEqual(WINDOWS_SERVICE_TIMING.rerunAfterMs);
});

it('kills by PID only while the lock still names the daemon that answered the stop', async () => {
  // It answered, then let the lock go just as the 15 s ran out: no taskkill on a PID that may be reused by now.
  const m = await machine();
  m.state.lock = owner(500);
  let phase = 0;
  m.state.onStop = () => {
    m.state.onRead = () => {
      if (phase === 0 && m.state.clock >= WINDOWS_SERVICE_TIMING.handoverMs) phase = 1;
      else if (phase === 1) { m.state.lock = null; phase = 2; }
    };
  };
  m.state.onRun = () => { m.state.lock = owner(600); };
  const result = await m.service.install();
  expect(result).toMatchObject({ kind: 'installed' });
  expect(m.calls.some(call => call.startsWith('taskkill'))).toBe(false);
});

it('an owner that does not answer the stop is never killed by PID', async () => {
  const m = await machine();
  m.state.lock = owner(500);
  const service = createWindowsService({ root: m.root }, {
    run: async (command, args) => { m.calls.push([command, ...args].join(' ')); return command === 'whoami' ? WHOAMI : args.includes('/Create') ? ok() : NO_TASK; },
    tmpdir: m.temp, isFile: () => true, freePort: async () => 7788, verifyOwner: async () => {},
    distribution: async () => ({ kind: 'standalone', cliPath: 'x', installRoot: INSTALL_ROOT }),
    readLock: async () => m.state.lock, stopHost: async () => { throw new Error('no answer'); },
    readSupervisor: async () => null, isAlive: () => false, sleep: async ms => { m.state.clock += ms; }, now: () => m.state.clock,
  });
  await expect(service.install()).resolves.toMatchObject({ kind: 'install_incomplete', reason: 'handover_failed' });
  expect(m.calls.some(call => call.startsWith('taskkill') || call.includes('/Run'))).toBe(false);
});

it('--keep-running leaves the running daemon alone: the task takes over at the next logon', async () => {
  const m = await machine();
  m.state.lock = owner(500);
  const result = await m.service.install({ keepRunning: true });
  expect(result).toMatchObject({ kind: 'installed', retained: { pid: 500 } });
  expect(result.detail).toContain('下次登录');
  expect(m.stops).toEqual([]);
  expect(m.calls.some(call => call.includes('/Run'))).toBe(false);
});

it('refuses without the SID, and for a distribution other than standalone', async () => {
  const m = await machine();
  const noSid = createWindowsService({ root: m.root }, { run: async () => fail('ERROR: whoami failed') });
  await expect(noSid.install()).resolves.toMatchObject({ kind: 'install_refused', reason: 'sid_unavailable' });
  await expect(noSid.uninstall()).resolves.toMatchObject({ kind: 'uninstall_refused', reason: 'sid_unavailable' });
  const bundled = createWindowsService({ root: m.root }, { run: async () => WHOAMI, distribution: async () => ({ kind: 'bundled', cliPath: 'C:\\x\\vonvon.mjs' }) });
  await expect(bundled.install()).resolves.toMatchObject({ kind: 'install_refused', detail: expect.stringContaining('standalone') });
});

it('a schtasks that never answers counts as failed after 15 s, naming schtasks and 超时', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const m = await machine();
  const hang = createWindowsService({ root: m.root }, {
    run: async (command, args) => {
      m.calls.push([command, ...args].join(' '));
      if (command === 'whoami') return WHOAMI;
      if (args.includes('/Create')) return new Promise<WindowsCommandResult>(() => {});
      return NO_TASK;
    },
    tmpdir: m.temp, isFile: () => true, freePort: async () => 7788, verifyOwner: async () => {}, readLock: async () => null,
    distribution: async () => ({ kind: 'standalone', cliPath: 'x', installRoot: INSTALL_ROOT }),
  });
  const pending = hang.install();
  while (!m.calls.some(call => call.includes('/Create'))) await new Promise(resolve => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(15_000);
  const result = await pending;
  expect(result).toMatchObject({ kind: 'install_refused', reason: 'schtasks_create_failed' });
  expect(result.detail).toMatch(/schtasks \/Create .*超时/);
  expect(await import('node:fs/promises').then(fs => fs.readdir(m.temp))).toEqual([]);

  const late = withTimeout(() => new Promise(() => {}));
  const answer = late('schtasks', ['/Query']);
  await vi.advanceTimersByTimeAsync(14_999);
  let settled = false; void answer.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(answer).resolves.toMatchObject({ ok: false, status: null, stderr: expect.stringMatching(/^schtasks \/Query 超时/) });
});

it('uninstall of nothing is not-installed with reason not_registered, and deletes nothing', async () => {
  const m = await machine();
  await expect(m.service.uninstall()).resolves.toMatchObject({ kind: 'not-installed', reason: 'not_registered' });
  expect(m.calls.some(call => call.includes('/Delete'))).toBe(false);
});

it('uninstall stops the daemon first, waits for the supervisor to go, then deletes the task', async () => {
  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  m.state.lock = owner(500); m.state.supervisor = 499; m.state.alive.add(499);
  m.state.onStop = () => { m.state.lock = null; m.state.onSleep = () => { if (m.state.clock >= 2000) { m.state.supervisor = null; m.state.alive.delete(499); } }; };
  await expect(m.service.uninstall()).resolves.toMatchObject({ kind: 'uninstalled', leftovers: [] });
  expect(m.calls.slice(-2)).toEqual(['stopHost 500', `schtasks /Delete /TN ${m.name} /F`]);
  expect(m.calls.some(call => call.includes('/End') || call.startsWith('taskkill'))).toBe(false);
  expect(m.state.clock).toBeGreaterThanOrEqual(2000);
  expect(m.state.task).toBeNull();
});

it('uninstall ends the task and kills the daemon when they are still there after 10 s, then deletes', async () => {
  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  m.state.lock = owner(500); m.state.supervisor = 499; m.state.alive.add(499);
  await expect(m.service.uninstall()).resolves.toMatchObject({ kind: 'uninstalled' });
  expect(m.calls.slice(-4)).toEqual(['stopHost 500', `schtasks /End /TN ${m.name}`, 'taskkill /T /F /PID 500', `schtasks /Delete /TN ${m.name} /F`]);
  expect(m.state.clock).toBeGreaterThanOrEqual(WINDOWS_SERVICE_TIMING.stopMs);
});

it('uninstall never kills by PID a daemon that did not answer the stop: /End, delete, and name it as still running', async () => {
  // The lock may be stale and its PID reused by another program; only /End, which Task Scheduler scopes to its own processes, is safe.
  const m = await machine({ stopHost: async () => { throw new Error('no answer'); } });
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  m.state.lock = owner(500);
  await expect(m.service.uninstall()).resolves.toMatchObject({ kind: 'uninstall_incomplete', leftovers: ['retained pid 500'] });
  expect(m.calls.slice(-2)).toEqual([`schtasks /End /TN ${m.name}`, `schtasks /Delete /TN ${m.name} /F`]);
  expect(m.calls.some(call => call.startsWith('taskkill'))).toBe(false);
});

it('uninstall removes its own task when the data directory is gone, and still refuses a foreign one (F7)', async () => {
  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  await rm(m.root, { recursive: true, force: true });
  await expect(m.service.uninstall()).resolves.toMatchObject({ kind: 'uninstalled' });
  expect(m.calls.at(-1)).toBe(`schtasks /Delete /TN ${m.name} /F`);
  expect(m.stops).toEqual([]);
  expect(m.state.task).toBeNull();

  const f = await machine();
  f.state.task = foreignTaskXml();
  await rm(f.root, { recursive: true, force: true });
  await expect(f.service.uninstall()).resolves.toMatchObject({ kind: 'uninstall_refused', reason: 'task_foreign' });
  expect(f.calls.some(call => call.includes('/Delete'))).toBe(false);
});

it('uninstall refuses a foreign task, and reports a /Delete that failed while the task is still there', async () => {
  const f = await machine();
  f.state.task = foreignTaskXml();
  await expect(f.service.uninstall()).resolves.toMatchObject({ kind: 'uninstall_refused', reason: 'task_foreign' });
  expect(f.calls.some(call => call.includes('/Delete'))).toBe(false);

  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  m.state.reply['schtasks /Delete'] = fail('ERROR: Access is denied.');
  await expect(m.service.uninstall()).resolves.toMatchObject({ kind: 'uninstall_incomplete', reason: 'schtasks_delete_failed' });

  // A /Delete that failed because the task is already gone is a success.
  const gone = await machine();
  gone.state.task = reserialized(decodeConsoleText(gone.ours()));
  gone.state.onDelete = () => { gone.state.task = null; return NO_TASK; };
  await expect(gone.service.uninstall()).resolves.toMatchObject({ kind: 'uninstalled' });
});

it('status: running, stopped, disabled and not installed; the Status column is shown, not decided on', async () => {
  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  m.state.status = 'Running'; m.state.lock = owner(500);
  await expect(m.service.status()).resolves.toMatchObject({ platformName: 'Task Scheduler (Windows)', state: 'running', installed: true, running: true, pid: '500', name: m.name, task: { name: m.name, status: 'Running' } });

  m.state.status = 'Ready'; m.state.lock = null;
  const stopped = await m.service.status();
  expect(stopped).toMatchObject({ state: 'stopped', installed: true, running: false, task: { status: 'Ready' } });
  expect(stopped.detail).toContain('daemon start');

  m.state.status = 'Disabled';
  await expect(m.service.status()).resolves.toMatchObject({ state: 'disabled', task: { status: 'Disabled' } });
  // Disabled in another UI language: the XML's Settings decide.
  m.state.status = '已禁用';
  m.state.task = disabled(m.state.task);
  await expect(m.service.status()).resolves.toMatchObject({ state: 'disabled', task: { status: '已禁用' } });

  const n = await machine();
  n.state.lock = owner(500);
  const detached = await n.service.status();
  expect(detached).toMatchObject({ state: 'not-installed', installed: false, running: true });
  expect(detached.detail).toContain('daemon start 起的');
  const f = await machine();
  f.state.task = foreignTaskXml();
  await expect(f.service.status()).resolves.toMatchObject({ state: 'conflict' });
});

it('start runs the task and returns the daemon that comes up; a /Run that fails says the task may be disabled', async () => {
  const m = await machine();
  m.state.task = reserialized(decodeConsoleText(m.ours()));
  m.state.onRun = () => { m.state.lock = owner(700); };
  await expect(m.service.start({})).resolves.toEqual({ pid: 700, startedAt: owner(700).startedAt, listen: '127.0.0.1:7788', port: 7788 });
  await expect(m.service.start({ port: 7789 })).rejects.toThrow('not requested port 7789');

  const d = await machine();
  d.state.task = reserialized(decodeConsoleText(d.ours()));
  d.state.reply['schtasks /Run'] = fail('ERROR: The task has been disabled.');
  await expect(d.service.start({})).rejects.toThrow('禁用');
  d.state.task = disabled(d.state.task);
  await expect(d.service.start({})).rejects.toThrow('禁用');
});

it('parses one CSV row with quotes, commas and doubled quotes', () => {
  expect(parseCsvRow('"HOST","\\VonvonBot-a-b","N/A","Running","x, ""y"""\r\n"second"')).toEqual(['HOST', '\\VonvonBot-a-b', 'N/A', 'Running', 'x, "y"']);
  expect(parseCsvRow('')).toEqual(['']);
});
