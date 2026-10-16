import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AdminServiceDeps } from '../src/admin/service';
import { crashScopeKey, listCrashRecords, writeBotPausesSync, writeCrashRecordSync, type CrashRecord } from '../src/host/crash-store';

// Real children (`node -e`) under the real supervisor, its data root a temp dir: s18a's records, count, pause and resume.
const f = vi.hoisted(() => ({ root: '', deps: undefined as AdminServiceDeps | undefined, crashes: undefined as { application(now: number): unknown; paused(appId: string): unknown } | undefined }));
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
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));
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
    else if (m.fcb === 'fcb.admin.req') process.send({ fcb: 'fcb.admin.res', id: m.id, ok: true, result: { connection: 'connected' } });
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
  const up = Math.round(uptime() * 1000);
  const seed = (fields: Partial<CrashRecord>): void => { writeCrashRecordSync(f.root, {
    v: 1, at: new Date().toISOString(), sysUptimeMs: up - 60_000, kind: 'exception', scope: 'bot', appId: A, pid: 4000, runId: RUN, chainId: CHAIN,
    startedAt: new Date().toISOString(), version: '0.7.0', managed: null, during: 'run', reason: 'Error: before', ...fields,
  }); };
  seed({}); // before the host crashed, same chain
  seed({ chainId: OTHER_CHAIN });
  seed({ sysUptimeMs: up - 660_000 });
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

it('a spawn without a PID (EAGAIN) leaves one record a minute and is retried without counting', async () => {
  await start([A], [A], 3);
  expect(records()).toMatchObject([{ kind: 'fatal', reason: 'spawn EAGAIN', during: 'run' }]);
  expect(f.crashes?.paused(A)).toBeUndefined();
});
