import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import type { Call } from '../src/cli/daemon-client';
import type { PidLockInfo } from '../src/server/pid-lock';

vi.mock('../src/server/owner-verification', async original => ({ ...await original<object>(), verifyPidLockOwner: vi.fn(async () => {}) }));
import { runRestart, runStatus, type RestartDeps } from '../src/cli/commands/daemon';
import { crashDir, readBootId, writeCrashRecordSync, writeRunMarkerSync, type CrashRecord, type RunMarker } from '../src/host/crash-store';
import { PidLockError } from '../src/server/pid-lock';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'vonvon-restart-')); roots.push(root); return root; };
const T0 = Date.parse('2026-10-16T05:00:00.000Z');
const at = (ms: number): string => new Date(ms).toISOString();
const old: PidLockInfo = { pid: 41234, startedAt: at(T0 - 60_000), listen: '127.0.0.1:43119' };
const next: PidLockInfo = { pid: 41300, startedAt: at(T0 + 5000), listen: '127.0.0.1:43119' };
const RUN = '11111111-1111-4111-8111-111111111111';
const CHAIN = '22222222-2222-4222-8222-222222222222';
const BOOT = readBootId(); // so a stopped daemon's paused marker is not taken for one from an earlier boot (CI VMs boot fresh)
function marker(fields: Partial<RunMarker> = {}): RunMarker {
  return { v: 1, runId: RUN, chainId: CHAIN, pid: old.pid, startedAt: old.startedAt, startUptimeMs: 1, aliveAt: old.startedAt, aliveUptimeMs: 1, ...(BOOT ? { bootId: BOOT } : {}), version: '0.7.0', managed: null, state: 'running', ...fields };
}
function crash(fields: Partial<CrashRecord> = {}): CrashRecord {
  return { v: 1, at: at(T0 - 60_000), sysUptimeMs: 1, kind: 'exception', scope: 'host', pid: 4000, runId: RUN, chainId: CHAIN, startedAt: at(T0 - 249_000), uptimeMs: 189_284, version: '0.7.0', managed: null, during: 'run', reason: "TypeError: Cannot read properties of undefined (reading 'x')", ...fields };
}

describe('runRestart', () => {
  let home: string;
  let clock: number;
  let locks: Array<PidLockInfo | null | Error>;
  let sent: unknown[];
  let reply: () => Promise<unknown>;
  const deps = (fields: Partial<RestartDeps> = {}): RestartDeps => ({
    readLock: async () => { const value = locks.length > 1 ? locks.shift() : locks[0]; if (value instanceof Error) throw value; return value ?? null; },
    verify: vi.fn(async () => {}),
    start: vi.fn(async () => ({ running: true as const, ...next, listen: next.listen ?? '' })),
    daemon: async fn => fn((async (_what: string, run: (c: VonvonClient) => Promise<unknown>) => run({ run: async (command: unknown) => { sent.push(command); return reply(); } } as unknown as VonvonClient)) as Call),
    now: () => clock, pause: async ms => { clock += ms; }, progress: vi.fn(), timeoutMs: 120_000, ...fields,
  });
  beforeEach(() => { home = tempRoot(); clock = T0; sent = []; reply = async () => ({ kind: 'applied', revision: 1 }); });
  it('restarts a running daemon through restartHost and waits past the old, an unverifiable and a half-written lock', async () => {
    locks = [old, old, old, new PidLockError('Invalid daemon PID lock JSON.'), next, next];
    const verify = vi.fn().mockRejectedValueOnce(new PidLockError('Cannot verify daemon owner')).mockResolvedValue(undefined);
    const d = deps({ verify });
    const result = await runRestart(home, d);
    expect(sent).toEqual([{ type: 'restartHost' }]);
    expect(result).toEqual({ status: { running: true, pid: next.pid, listen: next.listen, startedAt: next.startedAt }, outcome: 'restarted' });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(d.start).not.toHaveBeenCalled();
    expect(() => readdirSync(crashDir(home))).toThrow();
  });
  it('says resumed when the running daemon was paused', async () => {
    writeRunMarkerSync(home, marker({ state: 'paused', pausedAt: at(T0), pauseCrashes: 3 }));
    locks = [old, next];
    expect((await runRestart(home, deps())).outcome).toBe('resumed');
  });
  it('starts a stopped daemon with a resume request, which the start consumes', async () => {
    writeRunMarkerSync(home, marker({ state: 'paused', pausedAt: at(T0), pauseCrashes: 3 }));
    locks = [null];
    const d = deps({ start: vi.fn(async () => { expect(readdirSync(crashDir(home))).toContain('resume.json'); return { running: true as const, pid: next.pid, listen: next.listen ?? '', startedAt: next.startedAt }; }) });
    expect(await runRestart(home, d)).toMatchObject({ outcome: 'resumed', status: { pid: next.pid } });
    expect(d.start).toHaveBeenCalledWith(0);
    expect(sent).toEqual([]);
    locks = [null];
    expect((await runRestart(tempRoot(), d)).outcome).toBe('started');
  });
  it('removes its resume request when the start fails', async () => {
    locks = [null];
    await expect(runRestart(home, deps({ start: async () => { throw new Error('Daemon exited before readiness.'); } }))).rejects.toThrow('before readiness');
    expect(readdirSync(crashDir(home))).toEqual([]);
  });
  it('restarts a daemon that came up on its own instead of leaving the request for it', async () => {
    locks = [null, old, next];
    const d = deps({ start: vi.fn(async () => ({ running: true as const, pid: old.pid, listen: old.listen ?? '', startedAt: old.startedAt })) });
    expect(await runRestart(home, d)).toMatchObject({ outcome: 'restarted', status: { pid: next.pid } });
    expect(sent).toEqual([{ type: 'restartHost' }]);
    expect(readdirSync(crashDir(home))).toEqual([]);
  });
  it('reports a refused restart and writes nothing', async () => {
    locks = [old];
    reply = async () => ({ kind: 'refused', code: 'x', message: '已有重启正在进行' });
    await expect(runRestart(home, deps())).rejects.toThrow('重启 daemon没有完成：已有重启正在进行');
    expect(() => readdirSync(crashDir(home))).toThrow();
  });
  it('tells a draining daemon apart and does not wait for a replacement', async () => {
    locks = [old];
    const d = deps({ daemon: async () => { throw new Error('和 daemon 的连接断了，daemon 可能正在停止。'); } });
    await expect(runRestart(home, d)).rejects.toThrow('daemon 正在停止或重启，等它结束后再试。');
  });
  it('gives up after the timeout with a progress line every 5 s', async () => {
    locks = [old];
    const d = deps({ timeoutMs: 12_000 });
    await expect(runRestart(home, d)).rejects.toThrow('daemon 12 秒内没有重启好。运行 vonvon daemon status 和 vonvon daemon logs 查看。');
    expect(d.progress).toHaveBeenCalledWith(`等待 daemon 重启…（旧 PID ${old.pid}）\n`);
    expect(vi.mocked(d.progress).mock.calls).toHaveLength(2);
  });
});

describe('runStatus', () => {
  let home: string;
  let out: string;
  beforeEach(() => {
    home = tempRoot(); out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out += String(chunk); return true; });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const running = (): void => writeFileSync(join(home, 'daemon.pid'), JSON.stringify({ pid: process.pid, startedAt: at(Date.now() - 1000), listen: '127.0.0.1:43119' }));
  it('prints one line when there is nothing to show', async () => {
    running();
    await runStatus(false, home, () => T0);
    expect(out).toBe('running PID ' + process.pid + ' at 127.0.0.1:43119\n');
    out = '';
    await runStatus(true, home, () => T0);
    expect(JSON.parse(out)).toMatchObject({ running: true, pid: process.pid, crashes: [] });
  });
  it('shows the pause and the last day of crashes', async () => {
    running();
    writeRunMarkerSync(home, marker({ pid: process.pid, state: 'paused', pausedAt: at(T0), pauseCrashes: 3 }));
    writeCrashRecordSync(home, crash({ at: at(T0 - 60_000), kind: 'forced', reason: '被系统强制结束', uptimeMs: 170_000, paused: true }));
    writeCrashRecordSync(home, crash({ at: at(T0 - 120_000) }));
    writeCrashRecordSync(home, crash({ at: at(T0 - 780_000), scope: 'bot', appId: 'cli_a1b2c3d4', kind: 'rejection', reason: 'Error: boom', uptimeMs: 12_000 }));
    writeCrashRecordSync(home, crash({ at: at(T0 - 25 * 3_600_000) }));
    writeCrashRecordSync(home, crash({ at: at(T0 - 900_000), kind: 'forced', reason: '被系统强制结束', uptimeMs: 0 }));
    await runStatus(false, home, () => T0);
    const lines = out.trimEnd().split('\n');
    expect(lines[0]).toBe(`running PID ${process.pid} at 127.0.0.1:43119`);
    expect(lines[1]).toBe('已暂停：10 分钟内崩溃了 3 次，bot 都没有启动。查完原因后运行 vonvon daemon restart 恢复运行。');
    expect(lines[2]).toBe('最近 24 小时的崩溃：');
    expect(lines[3]).toMatch(/^ {2}\d{4}-\d\d-\d\d \d\d:\d\d {2}daemon {2}被系统强制结束（kill -9、内存不够，或者关机、注销时没来得及退出），运行了至少 2 分 50 秒（暂停期间）$/);
    expect(lines[4]).toMatch(/ {2}daemon {2}程序出错：TypeError: Cannot read properties of undefined \(reading 'x'\)，运行了 3 分 9 秒$/);
    expect(lines[5]).toMatch(/ {2}bot cli_a1b2c3d4 {2}程序出错（未处理的异步错误）：Error: boom，运行了 12 秒$/);
    expect(lines[6]).toMatch(/ {2}daemon {2}被系统强制结束（kill -9、内存不够，或者关机、注销时没来得及退出）$/);
    expect(lines).toHaveLength(7);
    out = '';
    await runStatus(true, home, () => T0);
    const json = JSON.parse(out);
    expect(json.paused).toEqual({ since: at(T0), crashes: 3, running: true });
    expect(json.crashes).toHaveLength(4);
    expect(json.crashes[0]).toEqual({ at: at(T0 - 60_000), kind: 'forced', scope: 'host', version: '0.7.0', uptimeMs: 170_000, paused: true, reason: '被系统强制结束' });
    expect(json.crashes[2]).toMatchObject({ scope: 'bot', appId: 'cli_a1b2c3d4' });
  });
  it('stopped while paused: the paused run ended and nothing restarted it', async () => {
    writeRunMarkerSync(home, marker({ state: 'paused', pausedAt: at(T0), pauseCrashes: 3 }));
    writeCrashRecordSync(home, crash({ kind: 'fatal', reason: 'Error: listen EADDRINUSE', paused: true }));
    await runStatus(false, home, () => T0);
    const lines = out.trimEnd().split('\n');
    expect(lines.slice(0, 3)).toEqual(['stopped', '已暂停：10 分钟内崩溃了 3 次；暂停期间 daemon 又出错退出，没有自动重启。查完原因后运行 vonvon daemon restart 恢复运行。', '最近 24 小时的崩溃：']);
    expect(lines[3]).toMatch(/出错退出：Error: listen EADDRINUSE，运行了 3 分 9 秒（暂停期间）$/);
    out = '';
    await runStatus(true, home, () => T0);
    expect(JSON.parse(out)).toMatchObject({ running: false, paused: { running: false, crashes: 3 } });
  });
  it('ignores a paused marker of another live daemon', async () => {
    running();
    writeRunMarkerSync(home, marker({ pid: process.pid + 1, state: 'paused', pausedAt: at(T0), pauseCrashes: 3 }));
    await runStatus(false, home, () => T0);
    expect(out).toBe(`running PID ${process.pid} at 127.0.0.1:43119\n`);
  });
});
