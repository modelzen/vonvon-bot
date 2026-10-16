import { randomUUID } from 'node:crypto';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex, DataAccessError } from '../config/data-access';
import { listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from './lifecycle';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, getPidLockInfo, isPidLockOwnerRunning, PidLockError, publishPidLock, readRunningPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';
import { verifyPidLockOwner } from '../server/owner-verification';
import { readStartupRegistration } from '../service/startup';
import { log } from '../core/logger';
import { bridgeVersion } from '../core/version';
import { defaultHolderPath, ProcessHost } from '../provider/process/process-host';
import { closeHostRun, guardParentPipes, openBotCrashContext, openHostRun, type HostRunStart } from './crash-guard';
import { crashEntry } from './crash-store';
import type { HostNotice } from './crash-notify';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for the host mutex holder to publish readiness, then authenticates it; null when it never proves itself. */
async function verifiedOtherOwner(): Promise<PidLockInfo | null> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const existing = await readRunningPidLock(paths.appDir);
    if (existing && existing.pid !== process.pid && existing.listen) {
      try { await verifyPidLockOwner(paths.appDir, existing); return existing; }
      catch (error) { if (!(error instanceof PidLockError)) throw error; }
    }
    if (Date.now() >= deadline) return null;
    await pause(100);
  }
}

export async function runHostRuntime(options: { bot?: string; port?: number; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  let owner: PidLockInfo | undefined;
  let host: ProcessHost | undefined;
  let run: HostRunStart | undefined;
  // The failure that no stop or restart asked for: it is a crash (`fatal`) and counts toward the pause.
  let fatal: { error: unknown } | undefined;
  const errors: unknown[] = [];
  try {
    if (!process.send) {
      // Read the registration before any lock: a service manager may only run a daemon its own registration names.
      const serviceManaged = Boolean(process.env.VONVON_SERVICE);
      const registration = await readStartupRegistration(paths.appDir);
      // An unreadable registration may be one being rewritten; fail so the manager tries again.
      if (serviceManaged && registration.kind === 'unrecognized') throw new Error(`Unrecognized service registration ${registration.location}: ${registration.reason}`);
      if (serviceManaged && registration.kind !== 'ours') {
        log.info('daemon-startup', 'registration_absent', registration.kind === 'other-root' ? { kind: registration.kind, recordedRoot: registration.recordedRoot } : { kind: registration.kind });
        process.exitCode = 0;
        return;
      }
      if (!serviceManaged && registration.kind === 'ours') throw new Error('Daemon is registered as a service. Use vonvon daemon start or vonvon service uninstall.');
      try { lock = await acquireMutex(paths.appDir, 'host'); }
      catch (error) {
        // Exit 0 only for an owner that proves it is our daemon; anything else exits 1 so the manager retries.
        const existing = serviceManaged && error instanceof DataAccessError ? await verifiedOtherOwner() : null;
        if (!existing) throw error;
        log.info('daemon-startup', 'owner_present', { pid: existing.pid });
        process.exitCode = 0;
        return;
      }
      const previous = await getPidLockInfo(paths.appDir).catch(() => null);
      if (previous && isPidLockOwnerRunning(previous)) log.info('daemon-startup', 'stale_owner_replaced', { pid: previous.pid });
      owner = await acquirePidLock(paths.appDir, { hostMutexHeld: true });
      run = openHostRun({ root: paths.appDir, startedAt: owner.startedAt, version: bridgeVersion(), intent: () => control.intent ?? (control.requested ? 'stop' : 'running'), log });
      if (run.paused) console.log(`daemon 已暂停：10 分钟内崩溃了 ${run.pauseCrashes ?? 3} 次，bot 都没有启动。查完原因后运行 vonvon daemon restart 恢复运行。`);
    } else if (options.bot) {
      // A supervised bot child (s18a): its records go under the host's run and chain, and a host that died does not
      // turn the drain's next console.log into a crash.
      openBotCrashContext({
        root: paths.appDir, appId: options.bot, runId: process.env.VONVON_HOST_RUN_ID, chainId: process.env.VONVON_HOST_CHAIN_ID,
        startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(), version: bridgeVersion(),
        intent: () => control.intent ?? (control.requested ? 'stop' : 'running'),
      });
      guardParentPipes(control);
    }
    if (control.requested) return;
    host = new ProcessHost({
      dataDir: paths.appDir, daemonBootId: randomUUID(),
      ...(process.platform === 'win32' ? { platform: 'win32' } : { platform: 'posix', holderPath: defaultHolderPath() }),
    });
    log.info('process-host', 'boot-sweep', { ...await host.sweepOrphans() });
    log.info('process-host', 'boot-admission', { admission: host.admission()?.reason ?? 'allowed' });
    // Lane 10 hook: the value is a fake-child.mjs path; the real `vonvon daemon run` has no other seam a lane can reach.
    if (process.env.VONVON_TEST_SPAWN_FAKE_CHILD) {
      await host.spawn('codex', 'lane-10', { file: process.execPath, args: [process.env.VONVON_TEST_SPAWN_FAKE_CHILD, '--ignore-term', '--grandchildren', '1'], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
    }
    if (options.managed) {
      const codexBin = readServiceCodexBin();
      if (codexBin === null) delete process.env.CODEX_BIN;
      else if (codexBin !== undefined) process.env.CODEX_BIN = codexBin;
    }
    // JP-VPS acceptance seam (s17): a real uncaught exception or rejection in a host, 2 s into the run.
    const seam = process.env.VONVON_TEST_CRASH;
    if (!process.send && (seam === 'exception' || seam === 'rejection')) {
      setTimeout(() => {
        if (seam === 'exception') throw new Error('VONVON_TEST_CRASH exception');
        void Promise.reject(new Error('VONVON_TEST_CRASH rejection'));
      }, 2000).unref();
    }
    const { runRun } = await import('../cli/commands/run');
    const claimedOwner = owner;
    // The owner's private message (s18b): the previous run's crash, unless it happened during a requested stop or restart.
    const notice: HostNotice | undefined = run?.tracked ? {
      ...(run.previous && (run.previous.during ?? 'run') === 'run' ? { previous: crashEntry(run.previous) } : {}),
      crashes: run.paused ? run.pauseCrashes ?? 3 : run.crashes, resumed: run.resumed, pauseEntered: run.pauseEntered,
    } : undefined;
    await runRun(options.bot, {
      control,
      managed: options.managed,
      port: options.port,
      ...(run?.paused ? { paused: true } : {}),
      ...(run?.runId && run.chainId ? { crash: { runId: run.runId, chainId: run.chainId, ...(run.paused ? { pause: { since: run.pausedAt ? Date.parse(run.pausedAt) : Date.now(), crashes: run.pauseCrashes ?? 3 } } : {}), ...(notice ? { notice } : {}) } } : {}),
      onListening: claimedOwner ? async (listen) => { await publishPidLock(paths.appDir, claimedOwner, listen); } : undefined,
    });
  } catch (error) {
    errors.push(error);
    if (!control.requested) fatal = { error };
  }
  finally {
    // A cleanup failure no longer turns a requested restart into a stop (v1-plan s17): the replacement starts only
    // after this process has exited, and leftover provider processes are swept at the next boot.
    try { await host?.closeAll(); } catch (error) { errors.push(error); }
    try { await control.completeShutdown(async () => {}); }
    catch (error) { errors.push(error); }
    control.dispose();
    closeHostRun(fatal ? { kind: 'fatal', error: fatal.error } : { kind: 'clean' });
    // A paused run that cannot stay up exits 0 under a manager, which then leaves it down: the pause ends the loop.
    if (fatal && run?.paused && process.env.VONVON_SERVICE && !process.send) process.exitCode = 0;
    if (!errors.some(listenerCloseUnconfirmed)) {
      if (owner) {
        try { await releasePidLock(paths.appDir, owner); } catch (error) { errors.push(error); }
      }
      if (lock) {
        try { await closeMutex(lock); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Host shutdown failed.');
  }
}
