import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminServiceDeps } from '../src/admin/service';
import {
  crashDir, crashScopeKey, listCrashRecords, readCrashSummary, writeBotPausesSync, writeCrashRecordSync, writeRunMarkerSync, type CrashRecord,
} from '../src/host/crash-store';

// Real children (`node -e`) under the real supervisor, its data root a temp dir: s18a's records, count, pause and resume.
const f = vi.hoisted(() => ({ root: '', deps: undefined as AdminServiceDeps | undefined, crashes: undefined as { application(now: number): unknown; paused(appId: string): unknown } | undefined, warn: vi.fn() }));
vi.mock('../src/config/paths', async original => {
  const real = await original<typeof import('../src/config/paths')>();
  return { ...real, paths: { ...real.paths, get appDir() { return f.root; } } };
});
vi.mock('../src/agent/codex-appserver/owned-process', () => ({ closeOwnedCodexProcesses: async () => {}, unconfirmedCodexPids: () => [] }));
vi.mock('../src/admin/service', () => ({ createAdminService: (deps: AdminServiceDeps) => { f.deps = deps; return deps; } }));
vi.mock('../src/server/http', async original => ({ ...await original<typeof import('../src/server/http')>(), startApi: vi.fn(async (options: { crashes?: typeof f.crashes }) => {
  f.crashes = options.crashes;
  return { port: 1, listen: '127.0.0.1:1', invalidate() {}, beginDrain: async () => {}, release: async () => {}, close: async () => {} };
}) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn: f.warn, fail() {} } }));
vi.mock('../src/agent', () => ({ installBackendDep() {}, uninstallBackendDep() {} }));
vi.mock('../src/core/single-instance', () => ({ readSingleInstanceHolder: () => undefined }));
vi.mock('../src/platform/spawn', () => ({ spawnProcess: vi.fn() }));
import { spawnProcess } from '../src/platform/spawn';
import { runSupervisor } from '../src/bot/supervisor';

const A = 'cli_crashy';
const B = 'cli_steady';
const RUN = '11111111-1111-4111-8111-111111111111';
const CHAIN = '22222222-2222-4222-8222-222222222222';
const OTHER_CHAIN = '33333333-3333-4333-8333-333333333333';
const fixture = `
  const keep = setInterval(() => {}, 1000);
  // A stop sends bridge:shutdown and SIGTERM back to back: exit a moment later, never while the SIGTERM is on its way.
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; setTimeout(() => { clearInterval(keep); process.exit(0); }, 300); };
  process.on('SIGTERM', stop);
  process.on('message', m => {
    if (m.type === 'bridge:shutdown') stop();
    else if (m.fcb === 'exit') { if (m.line) process.stderr.write(m.line + '\\n'); setTimeout(() => process.exit(m.code), 100); }
    // A 'hold' request is never answered: a web write still in flight when the child ends.
    else if (m.fcb === 'fcb.admin.req' && m.op.kind !== 'hold') process.send({ fcb: 'fcb.admin.res', id: m.id, ok: true, result: { connection: 'connected' } });
  });
`;
const procs = new Map<string, ChildProcess[]>();
let shutdown = (): void => {};
let supervisor: Promise<void> | undefined;

beforeEach(() => { f.root = mkdtempSync(join(tmpdir(), 'vonvon-supervisor-crash-')); procs.clear(); });
afterEach(async () => {
  shutdown();
  await supervisor;
  for (const child of [...procs.values()].flat()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  try { chmodSync(join(f.root, 'crash'), 0o700); } catch { /* none */ }
  rmSync(f.root, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function start(ids: string[], running = ids, failSpawns = 0): Promise<AdminServiceDeps> {
  f.deps = undefined;
  vi.mocked(spawnProcess).mockImplementation((_bin, args, options) => {
    if (failSpawns-- > 0) throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
    const child = spawn(process.execPath, ['-e', fixture], options ?? {});
    const id = String(args?.[4]);
    procs.set(id, [...procs.get(id) ?? [], child]);
    return child;
  });
  const pending = new Promise<void>(resolve => { shutdown = resolve; });
  supervisor = runSupervisor(ids.map(appId => ({ appId, name: appId, tenant: 'feishu' as const, createdAt: 0 })), {
    crash: { runId: RUN, chainId: CHAIN },
    control: { requested: false, waitForRequest: () => pending, requestStop() {}, requestRestart() {}, completeShutdown: async release => release(), dispose() {} },
  });
  await vi.waitFor(() => expect(f.deps).toBeDefined());
  const deps = f.deps as unknown as AdminServiceDeps;
  for (const id of running) await vi.waitFor(async () => expect(await deps.liveStatus?.(id)).toMatchObject({ connection: 'connected' }), { timeout: 10_000, interval: 50 });
  return deps;
}
/** Ends A's child (SIGKILL, or an exit with a last stderr line) and waits for the restart unless told it stays down. */
async function crash(how: 'kill' | { code: number; line?: string }, restarts = true): Promise<void> {
  const before = procs.get(A) ?? [];
  const child = before.at(-1);
  if (!child) throw new Error('no child');
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (how === 'kill') child.kill('SIGKILL');
  else child.send({ fcb: 'exit', ...how });
  await exited;
  if (!restarts) return;
  await vi.waitFor(() => expect(procs.get(A)).toHaveLength(before.length + 1), { timeout: 10_000, interval: 50 });
  await vi.waitFor(async () => expect(await f.deps?.liveStatus?.(A)).toMatchObject({ connection: 'connected' }), { timeout: 10_000, interval: 50 });
}
const records = (): CrashRecord[] => listCrashRecords(f.root, { scope: crashScopeKey('bot', A) });
const pauses = (): { chainId: string; bots: Record<string, object> } => JSON.parse(readFileSync(join(f.root, 'crash', 'bot-pauses.json'), 'utf8'));
/** A record of A from before this supervisor started, a minute ago in this chain unless told otherwise. */
const seed = (fields: Partial<CrashRecord> = {}): void => { writeCrashRecordSync(f.root, {
  v: 1, at: new Date().toISOString(), sysUptimeMs: Math.round(uptime() * 1000) - 60_000, kind: 'exception', scope: 'bot', appId: A, pid: 4000, runId: RUN, chainId: CHAIN,
  startedAt: new Date().toISOString(), version: '0.7.0', managed: null, during: 'run', reason: 'Error: before', ...fields,
}); };

it('records what the child could not, once each, and the third crash stops only that bot', async () => {
  const deps = await start([A, B]);
  await crash('kill');
  expect(vi.mocked(spawnProcess).mock.calls[0]?.[2]?.env).toMatchObject({ VONVON_HOST_RUN_ID: RUN, VONVON_HOST_CHAIN_ID: CHAIN });
  expect(records()).toMatchObject([{ kind: 'forced', reason: 'SIGKILL', scope: 'bot', appId: A, runId: RUN, chainId: CHAIN, during: 'run' }]);
  await crash({ code: 1, line: `Error: no config at ${homedir()}/x` });
  expect(records()[0]).toMatchObject({ kind: 'fatal', reason: 'Error: no config at ~/x' });
  // The child's own handler wrote this one before exiting 70: the supervisor adds none.
  const [fatal] = records();
  if (!fatal) throw new Error('no record');
  writeCrashRecordSync(f.root, { ...fatal, kind: 'exception', pid: procs.get(A)?.at(-1)?.pid ?? 1, at: new Date().toISOString(), reason: 'TypeError: boom' });
  await crash({ code: 70 }, false);
  expect(records().map(record => record.kind)).toEqual(['exception', 'fatal', 'forced']);
  expect(f.crashes?.paused(A)).toMatchObject({ crashes: 3 });
  expect(pauses()).toMatchObject({ chainId: CHAIN, bots: { [A]: { pauseCrashes: 3 } } });
  expect(await deps.liveStatus?.(A)).toBeUndefined();
  expect(await deps.liveStatus?.(B)).toMatchObject({ running: true });
  await expect(deps.executeWrite?.(A, {} as never)).rejects.toThrow('已暂停');
  expect(f.crashes?.application(Date.now())).toMatchObject({ records: [{ kind: 'exception', appId: A }, { kind: 'fatal' }, { kind: 'forced', reason: 'SIGKILL' }] });
});

it('exit 70 without a record gets one; exits 0 and 75 are not crashes', async () => {
  await start([A]);
  await crash({ code: 70 });
  expect(records()).toMatchObject([{ kind: 'exception', reason: '子进程出错退出，没留下记录' }]);
  await crash({ code: 75 });
  await crash({ code: 0 }, false);
  expect(records()).toHaveLength(1);
  expect(f.crashes?.paused(A)).toBeUndefined();
});

it('counts this chain\'s crashes on disk in the window, and none from before 恢复运行', async () => {
  seed(); // before the host crashed, same chain
  seed({ chainId: OTHER_CHAIN });
  seed({ sysUptimeMs: Math.round(uptime() * 1000) - 660_000 });
  seed({ during: 'stop' });
  const deps = await start([A]);
  await crash('kill');
  expect(f.crashes?.paused(A)).toBeUndefined();
  await crash('kill', false);
  expect(f.crashes?.paused(A)).toMatchObject({ crashes: 3 });
  await deps.applyBotActivation?.(A, true);
  expect(f.crashes?.paused(A)).toBeUndefined();
  expect(pauses().bots[A]).toEqual({ resumedUptimeMs: expect.any(Number) });
  await crash('kill');
  expect(f.crashes?.paused(A)).toBeUndefined();
});

it('keeps a bot paused in this chain down at start, and starts one paused in another chain', async () => {
  writeBotPausesSync(f.root, CHAIN, { [A]: { pausedAt: new Date().toISOString(), pauseCrashes: 3 } });
  await start([A, B], [B]);
  expect(procs.get(A)).toBeUndefined();
  expect(f.crashes?.paused(A)).toMatchObject({ crashes: 3 });
  shutdown();
  await supervisor;
  writeBotPausesSync(f.root, OTHER_CHAIN, { [A]: { pausedAt: new Date().toISOString(), pauseCrashes: 3 } });
  await start([A]);
  expect(f.crashes?.paused(A)).toBeUndefined();
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('counts in memory when crash/ can be neither read nor written, and the host lives on', async () => {
  mkdirSync(join(f.root, 'crash'), { mode: 0o000 });
  await start([A]);
  await crash('kill');
  await crash('kill');
  await crash('kill', false);
  expect(f.crashes?.paused(A)).toMatchObject({ crashes: 3 });
  expect(f.crashes?.application(Date.now())).toEqual({ records: [] });
});

// Real backoff 1 + 2 + 4 s: longer than vitest's default 5 s when run from the repo root.
it('a spawn without a PID (EAGAIN) leaves one record a minute and is retried without counting', async () => {
  await start([A], [A], 3);
  expect(records()).toMatchObject([{ kind: 'fatal', reason: 'spawn EAGAIN', during: 'run' }]);
  expect(f.crashes?.paused(A)).toBeUndefined();
}, 15_000);

it('a failed spawn prunes the old records too', async () => {
  const at = Date.now() - 3_600_000;
  for (let i = 0; i < 60; i++) {
    writeCrashRecordSync(f.root, {
      v: 1, at: new Date(at + i * 1000).toISOString(), sysUptimeMs: 1, kind: 'exception', scope: 'bot', appId: A, pid: 5000 + i, runId: RUN, chainId: OTHER_CHAIN,
      startedAt: new Date(at).toISOString(), version: '0.7.0', managed: null, during: 'run', reason: 'Error: old',
    });
  }
  await start([A], [A], 1);
  expect(readdirSync(join(f.root, 'crash')).filter(name => name.startsWith(crashScopeKey('bot', A)))).toHaveLength(50);
});

it('恢复运行 that crashes straight back into a pause says so, instead of timing out', async () => {
  writeBotPausesSync(f.root, CHAIN, { [A]: { pausedAt: new Date().toISOString(), pauseCrashes: 3 } });
  const deps = await start([A], []);
  vi.mocked(spawnProcess).mockImplementation((_bin, _args, options) => spawn(process.execPath, ['-e', 'process.exit(1)'], options ?? {}));
  const begun = Date.now();
  await expect(deps.applyBotActivation?.(A, true)).rejects.toThrow('已暂停。在状态与诊断页点「恢复运行」后再试');
  expect(Date.now() - begun).toBeLessThan(11_000);
  expect(f.crashes?.paused(A)).toMatchObject({ crashes: 3 });
}, 15_000);

it('the third crash tells a request in flight that the bot is paused, and so do group and collaboration writes after it', async () => {
  seed();
  seed();
  const deps = await start([A]);
  const held = expect(deps.executeWrite?.(A, { kind: 'hold' } as never)).rejects.toThrow('10 分钟内崩溃了 3 次，已暂停');
  await crash('kill', false);
  await held;
  expect(f.crashes?.paused(A)).toMatchObject({ crashes: 3 });
  await expect(deps.executeGroups?.(A, { kind: 'bindGroup' } as never)).rejects.toThrow('已暂停。在状态与诊断页点「恢复运行」后再试');
  await expect(deps.executeCollaboration?.(A, {} as never)).rejects.toThrow('已暂停。在状态与诊断页点「恢复运行」后再试');
});

it('a disable gives the pause up, in memory, on disk and for daemon status', async () => {
  const now = new Date().toISOString();
  writeRunMarkerSync(f.root, {
    v: 1, runId: RUN, chainId: CHAIN, pid: process.pid, startedAt: now, startUptimeMs: 0, aliveAt: now, aliveUptimeMs: 0, version: '0.7.0', managed: null, state: 'running',
  });
  writeBotPausesSync(f.root, CHAIN, { [A]: { pausedAt: now, pauseCrashes: 3 } });
  const deps = await start([A, B], [B]);
  const pausedBots = () => readCrashSummary(f.root, { running: true, ownerPid: process.pid, now: Date.now() }).pausedBots;
  expect(pausedBots()).toMatchObject([{ appId: A, crashes: 3 }]);
  await deps.applyBotActivation?.(A, false);
  expect(f.crashes?.paused(A)).toBeUndefined();
  expect(pauses().bots[A]).toEqual({ resumedUptimeMs: expect.any(Number) });
  expect(pausedBots()).toEqual([]);
  expect(procs.get(A)).toBeUndefined();
});

it('keeps the saved state of a bot disabled since the start when another bot writes the file', async () => {
  writeBotPausesSync(f.root, CHAIN, { [A]: { resumedUptimeMs: 5 }, [B]: { pausedAt: new Date().toISOString(), pauseCrashes: 3 } });
  const deps = await start([B], []);
  await deps.applyBotActivation?.(B, true);
  expect(pauses().bots).toEqual({ [A]: { resumedUptimeMs: 5 }, [B]: { resumedUptimeMs: expect.any(Number) } });
});

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('恢复运行 does not wait on the disk: a failed write is made good once crash/ is writable again', async () => {
  writeBotPausesSync(f.root, CHAIN, { [A]: { pausedAt: new Date().toISOString(), pauseCrashes: 3 } });
  const deps = await start([A], []);
  chmodSync(join(f.root, 'crash'), 0o500);
  await deps.applyBotActivation?.(A, true);
  expect(f.crashes?.paused(A)).toBeUndefined();
  expect(pauses().bots[A]).toMatchObject({ pausedAt: expect.any(String) });
  chmodSync(join(f.root, 'crash'), 0o700);
  await crash('kill');
  expect(pauses().bots[A]).toEqual({ resumedUptimeMs: expect.any(Number) });
});

it('starts every bot over a damaged bot-pauses.json and logs it', async () => {
  mkdirSync(join(f.root, 'crash'), { recursive: true });
  writeFileSync(join(f.root, 'crash', 'bot-pauses.json'), `{"v":1,"chainId":"${CHAIN}","bots":{"cl`);
  await start([A]);
  expect(f.warn).toHaveBeenCalledWith('daemon-crash', 'bot_pauses_corrupt', {});
});

it('lists crash/ again as soon as a child exits, though its mtime did not move', async () => {
  await start([A]);
  mkdirSync(crashDir(f.root), { recursive: true });
  // A coarse file system clock: the record written at the exit leaves the directory's mtime where it was.
  const stamp = Math.floor(Date.now() / 1000) - 60;
  utimesSync(crashDir(f.root), stamp, stamp);
  expect(f.crashes?.application(Date.now())).toEqual({ records: [] });
  await crash('kill');
  utimesSync(crashDir(f.root), stamp, stamp);
  expect(f.crashes?.application(Date.now())).toMatchObject({ records: [{ kind: 'forced', reason: 'SIGKILL', appId: A }] });
});
