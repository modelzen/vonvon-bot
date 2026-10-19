import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { capOrphanDrain } from '../src/host/crash-guard';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  crashDir, listCrashRecords, readBootId, readRunMarker, writeCrashRecordSync, writeResumeRequest, writeRunMarkerSync,
  type Clock, type CrashRecord, type RunMarker,
} from '../src/host/crash-store';

type Guard = typeof import('../src/host/crash-guard');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'vonvon-crash-guard-')); roots.push(root); return root; };
const PREV_RUN = '11111111-1111-4111-8111-111111111111';
const CHAIN = '22222222-2222-4222-8222-222222222222';
const T0 = Date.parse('2026-10-16T05:00:00.000Z');
const UP = 50_000_000;
const at = (ms: number): string => new Date(ms).toISOString();
const log = () => ({ info: vi.fn(), warn: vi.fn(), fail: vi.fn() });

describe('capOrphanDrain', () => {
  let disconnect: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    const originalOnce = process.once.bind(process);
    vi.spyOn(process, 'once').mockImplementation(((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === 'disconnect') { disconnect = listener; return process; }
      return originalOnce(event, listener);
    }) as typeof process.once);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined as never));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); disconnect = undefined; });

  it('s18g ③ logs registered and unconfirmed provider PIDs before orphan cutoff', async () => {
    const logs = log();
    capOrphanDrain({ log: logs, providers: () => ({ registered: [11, 12], unconfirmed: [12] }) });
    expect(disconnect).toBeTypeOf('function');
    disconnect?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith('run', 'orphan-drain-cut', { waitedMs: 20_000, registered: [11, 12], unconfirmed: [12] });
    await vi.advanceTimersByTimeAsync(1500);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('s18g ④ cuts orphan drain when reading provider PIDs fails', async () => {
    const logs = log();
    capOrphanDrain({ log: logs, providers: () => { throw new Error('registry unavailable'); } });
    disconnect?.();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(logs.warn).toHaveBeenCalledExactlyOnceWith('run', 'orphan-drain-cut', { waitedMs: 20_000 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});
let now = T0;
let up = UP;
const clock = (bootId: string | undefined = 'boot-a'): Clock => ({ now: () => now, uptimeMs: () => up, bootId: () => bootId });
function marker(fields: Partial<RunMarker> = {}): RunMarker {
  return {
    v: 1, runId: PREV_RUN, chainId: CHAIN, pid: 4242, startedAt: at(T0 - 120_000), startUptimeMs: UP - 120_000,
    aliveAt: at(T0 - 30_000), aliveUptimeMs: UP - 30_000, bootId: 'boot-a', version: '0.6.0', managed: 'systemd', state: 'running', ...fields,
  };
}
function crash(fields: Partial<CrashRecord> = {}): CrashRecord {
  return {
    v: 1, at: at(T0 - 60_000), sysUptimeMs: UP - 60_000, bootId: 'boot-a', kind: 'exception', scope: 'host', pid: 4000,
    runId: '33333333-3333-4333-8333-333333333333', chainId: CHAIN, startedAt: at(T0 - 90_000), uptimeMs: 30_000,
    version: '0.6.0', managed: 'systemd', during: 'run', reason: 'Error: boom', ...fields,
  };
}

describe('openHostRun and closeHostRun', () => {
  let guard: Guard;
  let root: string;
  let logs: ReturnType<typeof log>;
  const open = (bootId?: string | null) => guard.openHostRun({ root, startedAt: at(now), version: '0.7.0', intent: () => 'running', log: logs, clock: clock(bootId === null ? undefined : bootId ?? 'boot-a'), pid: 5000 });
  beforeEach(async () => {
    vi.resetModules();
    guard = await import('../src/host/crash-guard');
    root = tempRoot();
    logs = log();
    now = T0; up = UP;
  });
  afterEach(() => { guard.closeHostRun({ kind: 'clean' }); vi.useRealTimers(); });
  it('starts a new chain without a marker and writes its own', () => {
    const start = open();
    expect(start).toMatchObject({ tracked: true, paused: false, previous: null, resumed: false, pauseEntered: false });
    expect(readRunMarker(root)).toMatchObject({ runId: start.runId, chainId: start.chainId, pid: 5000, state: 'running', aliveAt: at(T0), startUptimeMs: UP, bootId: 'boot-a' });
    expect(listCrashRecords(root)).toEqual([]);
  });
  it('finds the record the previous run wrote and keeps its chain', () => {
    writeRunMarkerSync(root, marker());
    writeCrashRecordSync(root, crash({ runId: PREV_RUN }));
    const start = open();
    expect(start).toMatchObject({ chainId: CHAIN, paused: false, previous: { runId: PREV_RUN, kind: 'exception' } });
    expect(listCrashRecords(root)).toHaveLength(1);
  });
  it('writes one forced record from the heartbeat of a run that left no record', () => {
    writeRunMarkerSync(root, marker());
    const start = open();
    const [forced] = listCrashRecords(root);
    expect(forced).toMatchObject({ kind: 'forced', runId: PREV_RUN, chainId: CHAIN, pid: 4242, at: at(T0 - 30_000), sysUptimeMs: UP - 30_000, uptimeMs: 90_000, version: '0.6.0', reason: '被系统强制结束' });
    expect(start.chainId).toBe(CHAIN);
    expect(logs.warn).toHaveBeenCalledWith('daemon-crash', 'previous_forced', expect.objectContaining({ pid: 4242 }));
  });
  it('does not count a kill hours ago at the time of the next start', () => {
    writeRunMarkerSync(root, marker({ aliveAt: at(T0 - 7_200_000), aliveUptimeMs: UP - 7_200_000, startUptimeMs: UP - 7_300_000 }));
    writeCrashRecordSync(root, crash({ sysUptimeMs: UP - 60_000 }));
    writeCrashRecordSync(root, crash({ sysUptimeMs: UP - 30_000 }));
    expect(open().paused).toBe(false);
    expect(listCrashRecords(root)).toHaveLength(3);
  });
  it.each([
    ['boot ids differ', 'boot-b' as string | null, {}],
    ['macOS fallback: started before this boot', null, { bootId: undefined, startedAt: at(T0 - UP - 60_000) }],
  ])('starts a new chain after a reboot (%s) and writes no record', (_label, bootId, fields) => {
    writeRunMarkerSync(root, marker(fields));
    const start = open(bootId);
    expect(start.chainId).not.toBe(CHAIN);
    expect(start.paused).toBe(false);
    expect(listCrashRecords(root)).toEqual([]);
    expect(logs.info).toHaveBeenCalledWith('daemon-crash', 'previous_reboot', { pid: 4242 });
  });
  it('pauses at 3 crashes of one chain in 10 minutes, not at 2 plus one 11 minutes back', () => {
    writeRunMarkerSync(root, marker());
    writeCrashRecordSync(root, crash({ runId: PREV_RUN, sysUptimeMs: UP - 30_000 }));
    writeCrashRecordSync(root, crash({ sysUptimeMs: UP - 60_000 }));
    writeCrashRecordSync(root, crash({ sysUptimeMs: UP - 660_000 }));
    expect(open().paused).toBe(false);
  });
  it('comes up paused after the third crash, and stays paused after one more', async () => {
    writeRunMarkerSync(root, marker());
    writeCrashRecordSync(root, crash({ sysUptimeMs: UP - 300_000 }));
    writeCrashRecordSync(root, crash({ sysUptimeMs: UP - 120_000 }));
    const start = open();
    // s18b: the start that paused the run tells the owner at once; the next paused start does not.
    expect(start).toMatchObject({ paused: true, pauseCrashes: 3, pausedAt: at(T0), crashes: 3, chainId: CHAIN, pauseEntered: true, resumed: false });
    const paused = readRunMarker(root);
    expect(paused).toMatchObject({ state: 'paused', pausedAt: at(T0), pauseCrashes: 3 });
    expect(logs.warn).toHaveBeenCalledWith('daemon-crash', 'paused', { crashes: 3 });
    // The paused run is killed 15 minutes later: only it is in the window now, and the pause sticks.
    now = T0 + 900_000; up = UP + 900_000;
    vi.resetModules();
    const fresh = await import('../src/host/crash-guard');
    const again = fresh.openHostRun({ root, startedAt: at(now), version: '0.7.0', intent: () => 'running', log: logs, clock: clock() });
    expect(again).toMatchObject({ paused: true, pauseCrashes: 3, pauseEntered: false });
    expect(readRunMarker(root)).toMatchObject({ state: 'paused', pausedAt: at(T0) });
    expect(listCrashRecords(root)[0]).toMatchObject({ kind: 'forced', paused: true });
    fresh.closeHostRun({ kind: 'clean' });
  });
  it('a resume request starts a new chain, is consumed and still records the run that was killed', () => {
    writeRunMarkerSync(root, marker({ state: 'paused', pausedAt: at(T0 - 60_000), pauseCrashes: 3 }));
    writeResumeRequest(root, now - 10_000);
    const start = open();
    expect(start).toMatchObject({ paused: false, resumed: true, pauseEntered: false, crashes: 0, previous: { runId: PREV_RUN } });
    expect(start.chainId).not.toBe(CHAIN);
    expect(listCrashRecords(root)).toMatchObject([{ kind: 'forced', runId: PREV_RUN, chainId: CHAIN, paused: true }]);
    expect(readdirSync(crashDir(root))).not.toContain('resume.json');
    expect(logs.info).toHaveBeenCalledWith('daemon-crash', 'resumed', {});
  });
  it('runs unpaused and untracked when the crash directory cannot be written', () => {
    writeFileSync(join(root, 'crash'), 'not a directory');
    expect(open()).toEqual({ tracked: false, paused: false, crashes: 0, previous: null, resumed: false, pauseEntered: false });
    expect(logs.fail).toHaveBeenCalledWith('daemon-crash', expect.anything(), { phase: 'open-run' });
    guard.closeHostRun({ kind: 'fatal', error: new Error('ignored') });
  });
  it('rewrites the heartbeat every minute until closed, and logs a failed write once', () => {
    vi.useFakeTimers();
    const start = open();
    now = T0 + 60_000; up = UP + 60_000;
    vi.advanceTimersByTime(60_000);
    expect(readRunMarker(root)).toMatchObject({ runId: start.runId, aliveAt: at(T0 + 60_000), aliveUptimeMs: UP + 60_000, startUptimeMs: UP });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(crashDir(root), 0o500);
      try { vi.advanceTimersByTime(120_000); }
      finally { chmodSync(crashDir(root), 0o700); }
      expect(logs.fail.mock.calls.filter(call => call[2]?.phase === 'heartbeat')).toHaveLength(1);
    }
    guard.closeHostRun({ kind: 'clean' });
    expect(readRunMarker(root)).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(readRunMarker(root)).toBeNull();
  });
  it('a clean end removes only its own marker; a fatal end writes a record and keeps it', async () => {
    open();
    writeRunMarkerSync(root, marker({ runId: '44444444-4444-4444-8444-444444444444' }));
    guard.closeHostRun({ kind: 'clean' });
    expect(readRunMarker(root)).toMatchObject({ runId: '44444444-4444-4444-8444-444444444444' });
    vi.resetModules();
    const fresh = await import('../src/host/crash-guard');
    fresh.closeHostRun({ kind: 'fatal', error: new Error('no context') });
    expect(listCrashRecords(root)).toEqual([]);
    const second = tempRoot();
    const start = fresh.openHostRun({ root: second, startedAt: at(now), version: '0.7.0', intent: () => 'running', log: logs, clock: clock() });
    fresh.closeHostRun({ kind: 'fatal', error: Object.assign(new Error('listen EADDRINUSE: address already in use 127.0.0.1:43119'), { code: 'EADDRINUSE' }) });
    expect(listCrashRecords(second)).toEqual([expect.objectContaining({ kind: 'fatal', runId: start.runId, during: 'run', reason: 'Error: listen EADDRINUSE: address already in use 127.0.0.1:43119', errorName: 'Error:EADDRINUSE' })]);
    expect(readRunMarker(second)).toMatchObject({ runId: start.runId });
    fresh.closeHostRun({ kind: 'fatal', error: new Error('twice') });
    expect(listCrashRecords(second)).toHaveLength(1);
  });
});

describe('crash handler in a real process', () => {
  let bundle: string;
  beforeAll(async () => {
    const dir = tempRoot();
    bundle = join(dir, 'crash-child.cjs');
    await build({ entryPoints: [fileURLToPath(new URL('./fixtures/crash-child.ts', import.meta.url))], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  });
  function crashChild(root: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
    if (!env.VONVON_SERVICE) delete childEnv.VONVON_SERVICE;
    const child = spawn(process.execPath, [bundle, root, ...args], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    return new Promise<{ code: number | null; stderr: string }>(resolve => child.once('close', code => resolve({ code, stderr })));
  }
  it('records an uncaught exception, keeps the marker and exits 70', async () => {
    const root = tempRoot();
    const { code, stderr } = await crashChild(root, ['host']);
    expect(code).toBe(70);
    expect(stderr).toContain('vonvon: uncaught exception');
    expect(stderr).toContain('TypeError: fixture boom');
    expect(listCrashRecords(root)).toEqual([expect.objectContaining({ kind: 'exception', scope: 'host', during: 'run', reason: 'TypeError: fixture boom', errorName: 'TypeError', managed: null })]);
    expect(readRunMarker(root)).toMatchObject({ state: 'running' });
  });
  it('prints each error of an uncaught AggregateError and keeps the record format (s17b)', async () => {
    const root = tempRoot();
    const { code, stderr } = await crashChild(root, ['host-aggregate']);
    expect(code).toBe(70);
    expect(stderr).toContain('AggregateError: fixture group');
    expect(stderr).toContain('\n  - Error: first leaf\n  - inner group › Error: second leaf\n');
    expect(listCrashRecords(root)).toEqual([expect.objectContaining({ kind: 'exception', reason: 'AggregateError: fixture group', errorName: 'AggregateError' })]);
  });
  it('records an unhandled rejection of a non-Error', async () => {
    const root = tempRoot();
    const { code } = await crashChild(root, ['host-rejection']);
    expect(code).toBe(70);
    expect(listCrashRecords(root)).toEqual([expect.objectContaining({ kind: 'rejection', reason: 'plain string' })]);
  });
  it.each([['restart', 75], ['stop', 0]] as const)('under a manager keeps a requested %s (exit %i), not counted, marker removed', async (intent, expected) => {
    const root = tempRoot();
    const { code } = await crashChild(root, ['host', intent], { VONVON_SERVICE: 'systemd' });
    expect(code).toBe(expected);
    expect(listCrashRecords(root)).toEqual([expect.objectContaining({ during: intent, managed: 'systemd' })]);
    expect(readRunMarker(root)).toBeNull();
  });
  it('a paused run under a manager exits 0 so the manager leaves it down, and stays paused', async () => {
    const root = tempRoot();
    const bootId = readBootId();
    writeRunMarkerSync(root, marker({ state: 'paused', pausedAt: at(Date.now()), pauseCrashes: 3, startedAt: at(Date.now() - 1000), aliveAt: at(Date.now() - 1000), ...(bootId ? { bootId } : { bootId: undefined }) }));
    const { code } = await crashChild(root, ['host'], { VONVON_SERVICE: 'systemd' });
    expect(code).toBe(0);
    const records = listCrashRecords(root);
    expect(records.find(entry => entry.kind === 'exception')).toMatchObject({ paused: true });
    expect(readRunMarker(root)).toMatchObject({ state: 'paused', pauseCrashes: 3 });
  });
  const RUN = '55555555-5555-4555-8555-555555555555';
  const ids = { VONVON_HOST_RUN_ID: RUN, VONVON_HOST_CHAIN_ID: CHAIN };
  it.each(['bot-hook', 'bot-hook-throws', 'bot-hook-noctx'])('%s runs remaining sync hooks before exiting, even without a crash context', async scenario => {
    const root = tempRoot();
    expect((await crashChild(root, [scenario], ids)).code).toBe(70);
    const count = scenario === 'bot-hook-noctx' ? 0 : 1;
    expect(readFileSync(join(root, 'hooked'), 'utf8')).toBe(String(count));
    expect(listCrashRecords(root)).toHaveLength(count);
    expect(existsSync(join(root, 'unregistered'))).toBe(false);
  });
  it('a bot child records under its host run and chain, exits 70 even under a manager, and never removes the host marker (s18a)', async () => {
    const root = tempRoot();
    writeRunMarkerSync(root, marker({ runId: RUN }));
    expect((await crashChild(root, ['bot'], ids)).code).toBe(70);
    expect((await crashChild(root, ['bot', 'stop'], { ...ids, VONVON_SERVICE: 'systemd' })).code).toBe(70);
    expect(listCrashRecords(root).map(({ scope, appId, runId, chainId, during, kind }) => ({ scope, appId, runId, chainId, during, kind }))).toEqual([
      { scope: 'bot', appId: 'cli_fixture', runId: RUN, chainId: CHAIN, during: 'stop', kind: 'exception' },
      { scope: 'bot', appId: 'cli_fixture', runId: RUN, chainId: CHAIN, during: 'run', kind: 'exception' },
    ]);
    expect(readRunMarker(root)).toMatchObject({ runId: RUN });
    const bare = tempRoot();
    expect((await crashChild(bare, ['bot'])).code).toBe(70);
    expect(() => readdirSync(crashDir(bare))).toThrow();
  });
  it.each([['bot-drain', 0], ['bot-drain-unguarded', 70]] as const)('%s: a child whose host died drains to the end only with the pipe guard (exit %i, s18 D1)', async (scenario, expected) => {
    const root = tempRoot();
    writeRunMarkerSync(root, marker({ runId: RUN }));
    const child = spawn(process.execPath, [bundle, root, scenario], { env: { ...process.env, ...ids }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout?.resume(); child.stderr?.resume();
    await new Promise(resolve => child.once('message', resolve));
    const exited = new Promise(resolve => child.once('exit', resolve));
    // The host's kill -9 as the child sees it: the IPC channel and the readers of stdout and stderr are gone.
    child.stdout?.destroy(); child.stderr?.destroy(); child.disconnect();
    expect(await exited).toBe(expected);
    expect(existsSync(join(root, 'drained'))).toBe(expected === 0);
    expect(listCrashRecords(root)).toEqual(expected === 0 ? [] : [expect.objectContaining({ scope: 'bot', during: 'stop', errorName: 'Error:EPIPE' })]);
    expect(readRunMarker(root)).toMatchObject({ runId: RUN });
  });
  it.each(['bot-orphan', 'bot-orphan-flush', 'bot-orphan-fast'])('%s exits cleanly and releases its bot lock after IPC disconnects', async scenario => {
    const root = tempRoot();
    const child = spawn(process.execPath, [bundle, root, scenario], { env: { ...process.env, ...ids, VONVON_HOME: root }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout?.resume(); child.stderr?.resume();
    try {
      const ready = new AbortController();
      const deadline = setTimeout(() => ready.abort(new Error('fixture readiness timed out')), 5000);
      try {
        await Promise.race([
          once(child, 'message', { signal: ready.signal }),
          once(child, 'exit', { signal: ready.signal }).then(() => { throw new Error('fixture exited before ready'); }),
        ]);
      } finally { clearTimeout(deadline); ready.abort(); }
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(child.exitCode).toBeNull();
      expect(existsSync(join(root, 'orphan-lock.json'))).toBe(true);
      child.disconnect();
      await vi.waitFor(() => expect(child.exitCode).toBe(0), { timeout: 5000 });
      expect(existsSync(join(root, 'exited'))).toBe(true);
      expect(existsSync(join(root, 'orphan-lock.json'))).toBe(false);
      expect(listCrashRecords(root)).toEqual([]);
    } finally {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  });
  it('a host that crashes before it owns the run writes nothing', async () => {
    const root = tempRoot();
    const { code } = await crashChild(root, ['before-open'], { VONVON_SERVICE: 'systemd' });
    expect(code).toBe(70);
    expect(() => readdirSync(crashDir(root))).toThrow();
  });
});
