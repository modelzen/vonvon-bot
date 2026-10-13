import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../../config/paths';
import { readRecentLogs } from '../../core/logger';
import { stopVerifiedOwner, verifyPidLockOwner } from '../../server/owner-verification';
import { getPidLockInfo, isPidLockOwnerRunning, readRunningPidLock, type PidLockInfo } from '../../server/pid-lock';
import { readStartupRegistration, startRegisteredDaemon } from '../../service/startup';

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
  const waitReady = async (pid: number): Promise<DaemonStatus | null> => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const owner = await readRunningPidLock(paths.appDir);
      if (!owner || owner.pid !== pid) return null;
      if (owner.listen) return checkedStatus();
      await pause(50);
    }
    throw new Error(`Daemon PID ${pid} did not publish readiness.`);
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
        const endpoint = await startRegisteredDaemon(paths.appDir, port);
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
    if (lock && lock.pid !== child.pid) {
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
      if (Date.now() - exitedAt > 1000) throw new Error(`Daemon exited before readiness. Check ${join(paths.appDir, 'daemon.log')}.`);
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

export async function runStatus(json = false): Promise<void> {
  const status = await daemonStatus();
  if (json) process.stdout.write(`${JSON.stringify(status)}\n`);
  else process.stdout.write(status.running ? `running PID ${status.pid} at ${status.listen}\n` : 'stopped\n');
}

export async function runLogs(tail = 200): Promise<void> {
  const recent = await readRecentLogs({ maxBytes: Math.min(Math.max(tail * 200, 1024), 256 * 1024) });
  process.stdout.write(recent);
}
