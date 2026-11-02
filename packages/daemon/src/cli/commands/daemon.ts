import { selfEntry } from '../../core/self-entry';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { ConnectionError, type VonvonClient } from '@vonvon/client';
import { crashText } from '@vonvon/protocol';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { inBotSession, withoutSessionMarkers } from '../../config/session-env';
import { readRecentLogs } from '../../core/logger';
import { stopVerifiedOwner, verifyPidLockOwner } from '../../server/owner-verification';
import { getPidLockInfo, isPidLockOwnerRunning, PidLockError, readRunningPidLock, type PidLockInfo } from '../../server/pid-lock';
import { readStartupRegistration, startRegisteredDaemon } from '../../service/startup';
import { readCrashSummary, removeResumeRequest, writeResumeRequest, type CrashRecord, type CrashSummary } from '../../host/crash-store';
import { CommandError } from '../command-error';
import { cliScope, localTime, print, scopeNeedsDaemon, want, withDaemon, type Daemon, type Io } from '../daemon-client';
import { interrupts, onSigint, type Interrupts, type OnInterrupt } from '../interrupt';

export type DaemonStatus = { running: false } | {
  running: true;
  pid: number;
  listen: string;
  version?: string;
  startedAt: string;
};

/**
 * In a Bot's session the lock is taken as it is: the owner check reads `local-credential`, which a session never does
 * (devices-4a 4.9). `checkOwner: false` takes it so outside a session too (the discovery child, see runStatus).
 */
export async function daemonStatus(home = paths.appDir, env: NodeJS.ProcessEnv = process.env, checkOwner = !inBotSession(env)): Promise<DaemonStatus> {
  const lock = await readRunningPidLock(home);
  if (!lock?.listen) return { running: false };
  if (checkOwner) await verifyPidLockOwner(home, lock);
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
  const cliEntry = selfEntry();
  if (!cliEntry) throw new Error('Cannot locate the daemon CLI entry.');
  const log = await open(join(paths.appDir, 'daemon.log'), 'a', 0o600);
  const env: NodeJS.ProcessEnv = { ...withoutSessionMarkers(process.env), VONVON_HOME: paths.appDir };
  delete env.VONVON_SERVICE;
  let child;
  try {
    child = spawn(process.execPath, [cliEntry, 'daemon', 'run', '--port', String(port)], {
      detached: true,
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

export async function runStop(home = paths.appDir, reason?: 'update'): Promise<boolean> {
  const lock = await readRunningPidLock(home);
  if (!lock) return false;
  if (lock.pid === process.pid) throw new Error('Refusing to stop the current CLI process.');
  await stopVerifiedOwner(home, lock, reason);
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
type CrashLine = Pick<CrashRecord, 'at' | 'scope' | 'appId' | 'kind' | 'reason' | 'uptimeMs' | 'paused'>;
const crashLine = (record: CrashLine, names: Map<string, string>): string =>
  `  ${localTime(Date.parse(record.at))}  ${record.scope === 'host' ? 'daemon' : `bot ${names.get(record.appId ?? '') ?? record.appId ?? ''}`.trim()}  ${crashText(record)}`;

/** What `daemon status` prints besides the lock, in the files' shape (`readCrashSummary`) whoever answered. */
type Summary = Omit<CrashSummary, 'crashes'> & { crashes: Array<CrashLine & { version?: string }> };
const iso = (ms: number): string => new Date(ms).toISOString();
const DISTRIBUTION: Record<string, string> = { standalone: 'standalone（安装脚本）', 'global-npm': 'npm', bundled: '桌面端', development: '开发目录' };

export type StatusDeps = {
  home: string; now: () => number; env: NodeJS.ProcessEnv;
  /** daemon status --json is also how a client finds the daemon (`connectLocal`): asking it here would ask itself. */
  daemon: Daemon;
  /** the owner gave `--scope`: only the daemon answers, which cuts the bots and crashes to it (devices 5.3) */
  scoped: boolean;
};
const statusDeps = (): StatusDeps => ({ home: paths.appDir, now: Date.now, env: process.env, daemon: withDaemon, scoped: cliScope() !== undefined });
const NOT_RUNNING = 'daemon 没有运行。先运行 vonvon daemon start。';

/**
 * devices 8.3: a running daemon answers, with how it was installed and its data root (`source: 'daemon'`); otherwise
 * the files do (`source: 'files'`). Both shapes keep `running`, `pid` and `listen`, which `connectLocal` reads.
 * In a Bot's session (devices-4a 4.9) only the lock answers, token or not: the daemon would need the session's
 * `--scope` for its snapshot, and the crash files name the other bots. So it does for `connectLocal`'s discovery
 * (`VONVON_STATUS_FROM_FILES=1`): a caller that hands it a credential of its own (a session's token) must not have the
 * owner's read for it, and the owner's callers check the owner themselves before they connect (Codex review 230-2).
 * With the owner's `--scope` the files do not answer either: their crashes name every bot, which the daemon leaves out
 * under a scope (Codex review 251-1).
 * A session gets of the lock only what connectLocal reads, `running` and `listen` (Codex review 256-1: no PID, start time
 * or version), discovery or not: the session can ask either way.
 */
export async function runStatus(io: Io, overrides: Partial<StatusDeps> = {}): Promise<void> {
  const d = { ...statusDeps(), ...overrides };
  const discovery = d.env.VONVON_STATUS_FROM_FILES === '1';
  const session = inBotSession(d.env);
  const lockOnly = discovery || session;
  const status = await daemonStatus(d.home, d.env, !lockOnly);
  if (lockOnly) {
    if (!status.running && !discovery) throw new CommandError('connection', NOT_RUNNING);
    if (session) print(io, [status.running ? `running at ${status.listen}` : 'stopped'], { ...status.running ? { running: true, listen: status.listen } : { running: false }, source: 'files' });
    else print(io, [status.running ? `running PID ${status.pid} at ${status.listen}` : 'stopped'], { ...status, source: 'files' });
    return;
  }
  if (status.running) {
    try { await statusFromDaemon(status, io, d.daemon); return; }
    catch (error) {
      if (!(error instanceof CommandError && error.kind === 'connection')) throw error;
      if (d.scoped) throw scopeNeedsDaemon(error);
    }
  }
  if (d.scoped) throw scopeNeedsDaemon(NOT_RUNNING);
  const summary = readCrashSummary(d.home, { running: status.running, ...(status.running ? { ownerPid: status.pid } : {}), now: d.now() });
  const crashes = summary.crashes.map(({ at, kind, scope, appId, version, uptimeMs, paused, reason }) => ({ at, kind, scope, ...(appId ? { appId } : {}), version, ...(uptimeMs !== undefined ? { uptimeMs } : {}), ...(paused ? { paused } : {}), reason }));
  print(io, statusLines(status, summary, botNames(d.home)), { ...status, source: 'files', ...(summary.paused ? { paused: summary.paused } : {}), pausedBots: summary.pausedBots, crashes });
}

async function statusFromDaemon(status: RunningStatus, io: Io, daemon: Daemon): Promise<void> {
  const { daemon: answer, application, agents } = await daemon(async call => {
    const reply = want('读 daemon 状态', await call('读 daemon 状态', c => c.admin({ type: 'daemonStatus' })), 'daemonStatus');
    const snapshot = await call('读取快照', c => c.snapshot());
    return { daemon: reply.status, application: snapshot.application, agents: snapshot.agents };
  });
  const paused = application.crashes?.paused;
  const summary: Summary = {
    ...paused ? { paused: { since: iso(paused.since), crashes: paused.crashes, running: true } } : {},
    pausedBots: agents.flatMap(agent => agent.paused ? [{ appId: agent.id, since: iso(agent.paused.since), crashes: agent.paused.crashes }] : []),
    crashes: (application.crashes?.records ?? []).map(({ at, appId, ...record }) => ({ at: iso(at), scope: appId ? 'bot' as const : 'host' as const, ...appId ? { appId } : {}, ...record })),
  };
  const { distribution, uptimeMs, version, installed, supported, platformName, servicePath, stdoutPath, stderrPath } = answer;
  const human = statusLines(status, summary, new Map(agents.map(agent => [agent.id, agent.name])));
  if (distribution) human.push(`安装方式：${DISTRIBUTION[distribution.kind] ?? distribution.kind}`);
  human.push(`数据目录：${application.dataPath}`);
  print(io, human, {
    ...status, version, source: 'daemon', ...summary.paused ? { paused: summary.paused } : {}, pausedBots: summary.pausedBots, crashes: summary.crashes,
    ...distribution ? { distribution } : {}, dataPath: application.dataPath, platform: application.platform, ...uptimeMs === undefined ? {} : { uptimeMs },
    service: { installed, supported, ...platformName ? { platformName } : {}, ...servicePath ? { servicePath, stdoutPath, stderrPath } : {} },
  });
}

function statusLines(status: DaemonStatus, summary: Summary, names: Map<string, string>): string[] {
  const lines = [status.running ? `running PID ${status.pid} at ${status.listen}` : 'stopped'];
  if (summary.paused) lines.push((summary.paused.running ? PAUSED_RUNNING : PAUSED_STOPPED).replace('{n}', String(summary.paused.crashes)));
  if (summary.pausedBots.length) {
    lines.push(`已暂停的 Bot：${summary.pausedBots.map(bot => `${names.get(bot.appId) ?? bot.appId}（10 分钟内崩溃了 ${bot.crashes} 次）`).join('、')}。查完原因后在网页的状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。`);
  }
  if (summary.crashes.length) lines.push('最近 24 小时的崩溃：', ...summary.crashes.map(record => crashLine(record, names)));
  return lines;
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
    // A draining daemon answers its few kinds and `draining` to the rest (devices 4.7); one stopping may close the connection.
    if (error instanceof CommandError && error.reason === 'draining') throw new CommandError('connection', DRAINING, { reason: 'draining' });
    if (error instanceof Error && error.message.startsWith('和 daemon 的连接断了')) throw new CommandError('connection', DRAINING);
    throw error;
  }
  return { status: await waitForReplacement(home, before, d), outcome: wasPaused ? 'resumed' : 'restarted' };
}

export type LogsDeps = {
  env: NodeJS.ProcessEnv;
  daemon: Daemon;
  /** Without a daemon: today's and yesterday's log files. */
  readFiles: (maxBytes: number) => Promise<string>;
  onInterrupt: OnInterrupt;
};
const logsDeps = (): LogsDeps => ({ env: process.env, daemon: withDaemon, readFiles: maxBytes => readRecentLogs({ maxBytes }), onInterrupt: onSigint });
/** --follow waits as long as the user does; a timer longer than this fires at once. */
const FOREVER = 2_147_483_647;
/** Logs keep tabs and line breaks; other control characters, which could drive the terminal, go. */
// eslint-disable-next-line no-control-regex
const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
export function lastLines(text: string, count: number): string {
  const kept = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').slice(-count).join('\n');
  return kept ? `${kept}\n` : '';
}
/**
 * The follower first sends the end of today's file again, up to 16 KB (server/logs.ts): what was printed already is
 * not printed twice, whether that replay holds all of it (a short --tail) or starts inside it (a long one).
 */
export function afterPrinted(printed: string, lines: string): string {
  if (!printed) return lines;
  for (let at = lines.lastIndexOf(printed); at >= 0; at = at ? lines.lastIndexOf(printed, at - 1) : -1) {
    if (at === 0 || lines[at - 1] === '\n') return lines.slice(at + printed.length);
  }
  for (let start = Math.max(0, printed.length - lines.length); start < printed.length; start++) {
    if ((start === 0 || printed[start - 1] === '\n') && lines.startsWith(printed.slice(start))) return lines.slice(printed.length - start);
  }
  return lines;
}

const STOPPED = '不再跟日志。';

/**
 * `vonvon daemon logs` (devices 8.3): a running daemon reads its own logs (`admin.logs`), else the files are read. With
 * --follow it then sends each new batch (`admin.followLogs`) until Ctrl-C (130) or the daemon stops (3); nothing falls
 * back to the files then, nor in a Bot's session. With --follow, Ctrl-C from the first request on decides: 130.
 */
export async function runLogs(options: { tail: number; follow?: boolean | undefined }, io: Io, overrides: Partial<LogsDeps> = {}): Promise<void> {
  const d = { ...logsDeps(), ...overrides };
  try {
    await d.daemon(async call => {
      const ctrlC = options.follow ? interrupts(d.onInterrupt, () => new CommandError('interrupted', STOPPED)) : undefined;
      try {
        const maxBytes = Math.min(256 * 1024, Math.max(1024, options.tail * 400));
        const read = call('读日志', c => c.admin({ type: 'logs', maxBytes }));
        const text = lastLines(want('读日志', await (ctrlC ? ctrlC.until(read) : read), 'logs').text, options.tail);
        if (!ctrlC) {
          if (io.json) print(io, [], { source: 'daemon', text });
          else io.write(clean(text));
          return;
        }
        const write = (lines: string): void => { if (lines) io.write(io.json ? `${JSON.stringify({ event: 'log', lines })}\n` : clean(lines)); };
        write(text);
        const outcome = await call('跟日志', c => followLogs(c, ctrlC, text, write), { ms: FOREVER });
        throw outcome === 'interrupted' ? new CommandError('interrupted', STOPPED) : new CommandError('connection', 'daemon 停了，日志跟不下去了。运行 vonvon daemon status 查看。');
      } finally { ctrlC?.stop(); }
    });
    return;
  } catch (error) {
    if (options.follow || inBotSession(d.env) || !(error instanceof CommandError && error.kind === 'connection')) throw error;
  }
  const recent = await d.readFiles(Math.min(Math.max(options.tail * 200, 1024), 256 * 1024));
  io.write(io.json ? `${JSON.stringify({ ok: true, source: 'files', text: recent })}\n` : recent);
}

/**
 * Prints each batch until Ctrl-C or the connection ends. After Ctrl-C the outcome is `interrupted` whatever comes next:
 * it asks the daemon to stop sending, 1 s at most, and a second Ctrl-C, a dropped connection or a failed request ends
 * that wait at once. The connection closes when the command ends either way.
 */
function followLogs(c: VonvonClient, ctrlC: Interrupts, printed: string, write: (lines: string) => void): Promise<'interrupted' | 'lost'> {
  return new Promise((resolve, reject) => {
    let first = true;
    let settled = false;
    const stops: Array<() => void> = [];
    /** Without a failure, the connection ended, or Ctrl-C's wait did. */
    const end = (failure?: { error: unknown }): void => {
      if (settled) return;
      settled = true;
      for (const stop of stops.splice(0)) stop();
      if (ctrlC.interrupted) resolve('interrupted');
      else if (failure) reject(failure.error);
      else resolve('lost');
    };
    stops.push(c.onLog(({ lines }) => {
      if (settled || ctrlC.interrupted) return;
      write(first ? afterPrinted(printed, lines) : lines);
      first = false;
    }));
    stops.push(c.onError(error => { if (error instanceof ConnectionError) end(); }));
    stops.push(ctrlC.on(count => {
      if (count > 1) { end(); return; }
      const timer = setTimeout(() => end(), 1000);
      stops.push(() => { clearTimeout(timer); });
      void c.admin({ type: 'followLogs', follow: false }).catch(() => undefined).then(() => end());
    }));
    c.admin({ type: 'followLogs', follow: true }).then(reply => {
      if (reply.kind !== 'following') end({ error: new CommandError('failed', `跟日志没有开始：daemon 回了意外的结果（${reply.kind}）。`) });
    }, (error: unknown) => end({ error }));
  });
}
