import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { crashText } from '@vonvon/protocol';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { readRecentLogs } from '../../core/logger';
import { stopVerifiedOwner, verifyPidLockOwner } from '../../server/owner-verification';
import { getPidLockInfo, isPidLockOwnerRunning, PidLockError, readRunningPidLock, type PidLockInfo } from '../../server/pid-lock';
import { readStartupRegistration, startRegisteredDaemon } from '../../service/startup';
import { readCrashSummary, removeResumeRequest, writeResumeRequest, type CrashRecord } from '../../host/crash-store';
import { CommandError } from '../command-error';
import { localTime, want, withDaemon, type Daemon, type Io } from '../daemon-client';

export type DaemonStatus = { running: false } | {
  running: true;
  pid: number;
  listen: string;
  version?: string;
  startedAt: string;
};

export async function daemonStatus(home = paths.appDir): Promise<DaemonStatus> {
  const lock = await readRunningPidLock(home);
  if (!lock?.listen) return { running: false };
  await verifyPidLockOwner(home, lock);
  return { running: true, pid: lock.pid, listen: lock.listen, ...(lock.version ? { version: lock.version } : {}), startedAt: lock.startedAt };
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runStart(port = 0): Promise<DaemonStatus> {
  const checkedStatus = async (): Promise<DaemonStatus> => {
    const ready = await daemonStatus();
    if (!ready.running) throw new Error('Daemon lost readiness before startup completed.');
    if (port !== 0 && ready.listen !== `127.0.0.1:${port}`) throw new Error(`Daemon PID ${ready.pid} already runs at ${ready.listen}, not requested port ${port}.`);
    return ready;
  };
  let unverified: PidLockInfo | undefined;
  const waitReady = async (pid: number): Promise<DaemonStatus | null> => {
    const deadline = Date.now() + 25_000;
    let owner: PidLockInfo | null = null;
    while (Date.now() < deadline) {
      owner = await readRunningPidLock(paths.appDir);
      if (!owner || owner.pid !== pid) return null;
      if (owner.listen) {
        // A lock that fails authentication may be a dead daemon's PID reused by another process; the child decides under the host mutex.
        try { return await checkedStatus(); }
        catch (error) { if (!(error instanceof PidLockError)) throw error; unverified = owner; return null; }
      }
      await pause(50);
    }
    // Never ready may also be a PID reused after a crash before readiness; the host mutex decides that too.
    if (owner) unverified = owner;
    return null;
  };
  const existing = await readRunningPidLock(paths.appDir);
  if (existing) {
    const ready = await waitReady(existing.pid);
    if (ready) return ready;
  }
  {
    const registration = await readStartupRegistration(paths.appDir);
    switch (registration.kind) {
      case 'ours': {
        const endpoint = await startRegisteredDaemon(paths.appDir, port, unverified);
        return { running: true, pid: endpoint.pid, listen: endpoint.listen, startedAt: endpoint.startedAt };
      }
      case 'unrecognized':
        throw new Error(`Unrecognized service registration ${registration.location}: ${registration.reason}`);
      case 'absent':
      case 'other-root':
        break;
      default: {
        const exhaustive: never = registration;
        throw new Error(`Invalid service registration: ${exhaustive}`);
      }
    }
  }
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('Cannot locate the daemon CLI entry.');
  const log = await open(join(paths.appDir, 'daemon.log'), 'a', 0o600);
  const env: NodeJS.ProcessEnv = { ...process.env, VONVON_HOME: paths.appDir };
  delete env.VONVON_SERVICE;
  let child;
  try {
    child = spawn(process.execPath, [cliEntry, 'daemon', 'run', '--port', String(port)], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log.fd, log.fd],
      env,
    });
  } finally { await log.close(); }
  child.unref();
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  const deadline = Date.now() + 25_000;
  let exitedAt: number | undefined;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    const lock = await readRunningPidLock(paths.appDir);
    if (lock && lock.pid === child.pid && lock.listen) return checkedStatus();
    if (lock && lock.pid !== child.pid && !(unverified && lock.pid === unverified.pid && lock.startedAt === unverified.startedAt)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const loserDeadline = Date.now() + 5_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < loserDeadline) await pause(25);
        if (child.exitCode === null && child.signalCode === null) throw new Error(`Cannot stop competing daemon PID ${child.pid}.`);
      }
      const winner = await waitReady(lock.pid);
      if (winner) return winner;
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      exitedAt ??= Date.now();
      if (Date.now() - exitedAt > 1000) {
        // The child lost the host mutex to an owner we could not verify; it may have become ready since.
        if (lock && unverified && lock.pid === unverified.pid && lock.listen) {
          try { return await checkedStatus(); }
          catch (error) { if (!(error instanceof PidLockError)) throw error; }
        }
        throw new Error(`Daemon exited before readiness. Check ${join(paths.appDir, 'daemon.log')}.`);
      }
    }
    await pause(50);
  }
  throw new Error(`Daemon readiness timed out. Check ${join(paths.appDir, 'daemon.log')}.`);
}

function sameOwner(left: PidLockInfo | null, right: PidLockInfo): boolean {
  return left?.pid === right.pid && left.startedAt === right.startedAt;
}

export async function runStop(home = paths.appDir): Promise<boolean> {
  const lock = await readRunningPidLock(home);
  if (!lock) return false;
  if (lock.pid === process.pid) throw new Error('Refusing to stop the current CLI process.');
  await stopVerifiedOwner(home, lock);
  let progressAt = Date.now() + 5000;
  for (;;) {
    const current = await getPidLockInfo(home);
    if (current && !sameOwner(current, lock) && isPidLockOwnerRunning(current)) {
      throw new Error(`Daemon was replaced by PID ${current.pid} at ${current.listen ?? 'not ready'}.`);
    }
    if (!isPidLockOwnerRunning(lock)) {
      if (!sameOwner(current, lock)) return true;
      throw new Error(`Daemon ${lock.pid} exited without releasing daemon.pid. Cleanup was not confirmed; see vonvon daemon logs.`);
    }
    if (Date.now() >= progressAt) {
      process.stderr.write(`Waiting for daemon PID ${lock.pid} at ${lock.listen} to finish stopping…\n`);
      progressAt = Date.now() + 5000;
    }
    await pause(100);
  }
}

const PAUSED_RUNNING = '已暂停：10 分钟内崩溃了 {n} 次，Bot 都没有启动。查完原因后运行 vonvon daemon restart 恢复运行。';
const PAUSED_STOPPED = '已暂停：10 分钟内崩溃了 {n} 次；暂停期间 daemon 又出错退出，没有自动重启。查完原因后运行 vonvon daemon restart 恢复运行。';

/** Bot names from `bots.json`, read only; an unreadable registry leaves the app ids. */
function botNames(home: string): Map<string, string> {
  try {
    const bots = (JSON.parse(readFileSync(join(home, 'bots.json'), 'utf8')) as { bots?: Array<{ appId?: unknown; name?: unknown }> }).bots ?? [];
    return new Map(bots.flatMap(bot => typeof bot.appId === 'string' && typeof bot.name === 'string' ? [[bot.appId, bot.name] as const] : []));
  } catch { return new Map(); }
}
const crashLine = (record: CrashRecord, names: Map<string, string>): string =>
  `  ${localTime(Date.parse(record.at))}  ${record.scope === 'host' ? 'daemon' : `bot ${names.get(record.appId ?? '') ?? record.appId ?? ''}`.trim()}  ${crashText(record)}`;

export async function runStatus(json = false, home = paths.appDir, now: () => number = Date.now): Promise<void> {
  const status = await daemonStatus(home);
  const summary = readCrashSummary(home, { running: status.running, ...(status.running ? { ownerPid: status.pid } : {}), now: now() });
  if (json) {
    const crashes = summary.crashes.map(({ at, kind, scope, appId, version, uptimeMs, paused, reason }) => ({ at, kind, scope, ...(appId ? { appId } : {}), version, ...(uptimeMs !== undefined ? { uptimeMs } : {}), ...(paused ? { paused } : {}), reason }));
    // devices 8.3: read from the files here; an answer over RPC (C8) will say `source: 'daemon'`.
    process.stdout.write(`${JSON.stringify({ ok: true, ...status, source: 'files', ...(summary.paused ? { paused: summary.paused } : {}), pausedBots: summary.pausedBots, crashes })}\n`);
    return;
  }
  const names = botNames(home);
  const lines = [status.running ? `running PID ${status.pid} at ${status.listen}` : 'stopped'];
  if (summary.paused) lines.push((summary.paused.running ? PAUSED_RUNNING : PAUSED_STOPPED).replace('{n}', String(summary.paused.crashes)));
  if (summary.pausedBots.length) {
    lines.push(`已暂停的 Bot：${summary.pausedBots.map(bot => `${names.get(bot.appId) ?? bot.appId}（10 分钟内崩溃了 ${bot.crashes} 次）`).join('、')}。查完原因后在网页的状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。`);
  }
  if (summary.crashes.length) lines.push('最近 24 小时的崩溃：', ...summary.crashes.map(record => crashLine(record, names)));
  process.stdout.write(`${lines.join('\n')}\n`);
}

export type RunningStatus = Extract<DaemonStatus, { running: true }>;
export type RestartDeps = {
  /** The running `daemon.pid` owner, or null; throws PidLockError for a lock being rewritten. */
  readLock: (home: string) => Promise<PidLockInfo | null>;
  verify: (home: string, lock: PidLockInfo) => Promise<void>;
  start: (port: number) => Promise<DaemonStatus>;
  daemon: Daemon;
  now: () => number;
  pause: (ms: number) => Promise<void>;
  progress: (text: string) => void;
  timeoutMs: number;
};
const restartDeps: RestartDeps = {
  readLock: readRunningPidLock, verify: verifyPidLockOwner, start: runStart, daemon: withDaemon,
  now: Date.now, pause, progress: text => { process.stderr.write(text); }, timeoutMs: 120_000,
};
const DRAINING = 'daemon 正在停止或重启，等它结束后再试。';
const runningStatus = (lock: PidLockInfo & { listen: string }): RunningStatus => ({ running: true, pid: lock.pid, listen: lock.listen, ...(lock.version ? { version: lock.version } : {}), startedAt: lock.startedAt });

/** Waits for a verified owner other than `before`, as the manager or the restart helper starts it. */
async function waitForReplacement(home: string, before: Pick<PidLockInfo, 'pid' | 'startedAt'>, d: RestartDeps): Promise<RunningStatus> {
  const deadline = d.now() + d.timeoutMs;
  let progressAt = d.now() + 5000;
  for (;;) {
    let lock: PidLockInfo | null = null;
    try { lock = await d.readLock(home); }
    catch (error) { if (!(error instanceof PidLockError)) throw error; }
    if (lock?.listen && !(lock.pid === before.pid && lock.startedAt === before.startedAt)) {
      try { await d.verify(home, lock); return runningStatus({ ...lock, listen: lock.listen }); }
      catch (error) { if (!(error instanceof PidLockError)) throw error; }
    }
    if (d.now() >= deadline) throw new CommandError('outcome-unknown', `daemon ${Math.round(d.timeoutMs / 1000)} 秒内没有重启好。运行 vonvon daemon status 和 vonvon daemon logs 查看。`);
    if (d.now() >= progressAt) { d.progress(`等待 daemon 重启…（旧 PID ${before.pid}）\n`); progressAt = d.now() + 5000; }
    await d.pause(100);
  }
}

/**
 * `vonvon daemon restart`: a running daemon restarts through `restartHost` (the manager or the same-port helper starts
 * the next one), which also leaves a crash pause. With nothing running it starts one with a resume request, so a
 * paused run that a manager left down comes back unpaused.
 */
export async function runRestart(home = paths.appDir, d: RestartDeps = restartDeps): Promise<{ status: RunningStatus; outcome: 'restarted' | 'resumed' | 'started' }> {
  const current = await d.readLock(home);
  if (current && !current.listen) throw new CommandError('connection', 'daemon 正在启动，稍后再试。');
  let before: Pick<PidLockInfo, 'pid' | 'startedAt'> | null = current;
  if (!before) {
    const wasPaused = readCrashSummary(home, { running: false, now: d.now() }).paused !== undefined;
    const requestedAt = writeResumeRequest(home, d.now());
    let after: DaemonStatus;
    try { after = await d.start(0); }
    catch (error) { removeResumeRequest(home, requestedAt); throw error; }
    if (!after.running) { removeResumeRequest(home, requestedAt); throw new Error('Daemon lost readiness before startup completed.'); }
    if (Date.parse(after.startedAt) >= requestedAt) return { status: after, outcome: wasPaused ? 'resumed' : 'started' };
    // A daemon came up on its own meanwhile and runStart returned it: the request was not consumed, so it must not
    // reset the chain of whatever start comes next. Restart that daemon instead.
    removeResumeRequest(home, requestedAt);
    before = after;
  }
  const wasPaused = readCrashSummary(home, { running: true, ownerPid: before.pid, now: d.now() }).paused !== undefined;
  try {
    await d.daemon(call => call('重启 daemon', async c => want('重启 daemon', await c.run({ type: 'restartHost' }), 'applied')));
  } catch (error) {
    // A draining daemon answers only stopHost and daemonStatus and closes the connection on anything else.
    if (error instanceof Error && error.message.startsWith('和 daemon 的连接断了')) throw new CommandError('connection', DRAINING);
    throw error;
  }
  return { status: await waitForReplacement(home, before, d), outcome: wasPaused ? 'resumed' : 'restarted' };
}

export async function runLogs(tail: number, io: Io): Promise<void> {
  const recent = await readRecentLogs({ maxBytes: Math.min(Math.max(tail * 200, 1024), 256 * 1024) });
  io.write(io.json ? `${JSON.stringify({ ok: true, source: 'files', text: recent })}\n` : recent);
}
