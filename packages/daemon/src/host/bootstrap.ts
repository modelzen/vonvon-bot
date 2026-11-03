import { randomUUID } from 'node:crypto';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex, DataAccessError } from '../config/data-access';
import { prepareDevicesDirectory } from '../remote/files';
import { listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from './lifecycle';
import { readServiceCodexBin } from '../service/codex-bin';
import { codexVersionAsync, resolveCodexBin } from '../agent/codex-appserver/locate';
import { codexTierUnavailable } from '../agent/codex-appserver/full-only';
import { refreshWindowsSandbox } from '../agent/codex-appserver/windows-sandbox';
import { acquirePidLock, getPidLockInfo, isPidLockOwnerRunning, PidLockError, publishPidLock, readRunningPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';
import { verifyPidLockOwner } from '../server/owner-verification';
import { readStartupRegistration } from '../service/startup';
import { flushLogs, log, startLogGc } from '../core/logger';
import { startLoopLagMonitor } from '../core/loop-lag';
import { wasLogged } from '../core/error-parts';
import { bridgeVersion } from '../core/version';
import { defaultHolderPath, ProcessHost } from '../provider/process/process-host';
import { capOrphanDrain, closeHostRun, guardParentPipes, openBotCrashContext, openHostRun, type HostRunStart } from './crash-guard';
import { crashEntry } from './crash-store';
import { registeredProviderPids, unconfirmedProviderPids } from '../agent/owned-process';
import type { HostNotice } from './crash-notify';
import {bridgeImportRuntime} from '../import/bridge/runtime';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Once this daemon owns its port (server-3 4.5, 4.6, 4.10): end the update record that restarted it, clear the
 * releases a standalone server no longer needs, and start its daily manifest check. Nothing here holds startup up.
 */
async function startUpdateUpkeep(alive: () => boolean): Promise<() => void> {
  try {
    const [{ runtimeDistribution }, upkeep] = await Promise.all([import('../service/distribution'), import('../service/standalone-update')]);
    const distribution = await runtimeDistribution().catch(() => undefined);
    const installRoot = distribution?.kind === 'standalone' ? distribution.installRoot : undefined;
    void upkeep.settleUpdateAtStartup({ version: bridgeVersion(), installRoot, alive }).catch(error => log.fail('core-update', error, { phase: 'startup' }));
    return installRoot ? upkeep.scheduleStandaloneChecks({ installRoot, currentVersion: bridgeVersion() }) : () => {};
  } catch (error) {
    log.fail('core-update', error, { phase: 'startup' });
    return () => {};
  }
}

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
  let stopLoopLag: (() => void) | undefined;
  let stopLogGc: (() => void) | undefined;
  let stopUpkeep: (() => void) | undefined;
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
      // Before any Bot can start a session: its read deny names this directory only when it already exists (remote/files.ts).
      await prepareDevicesDirectory(paths.appDir);
      run = openHostRun({ root: paths.appDir, startedAt: owner.startedAt, version: bridgeVersion(), intent: () => control.intent ?? (control.requested ? 'stop' : 'running'), log });
      if (run.paused) console.log(`daemon 已暂停：10 分钟内崩溃了 ${run.pauseCrashes ?? 3} 次，Bot 都没有启动。查完原因后运行 vonvon daemon restart 恢复运行。`);
    } else if (options.bot) {
      // A supervised bot child (s18a): its records go under the host's run and chain, and a host that died does not
      // turn the drain's next console.log into a crash.
      openBotCrashContext({
        root: paths.appDir, appId: options.bot, runId: process.env.VONVON_HOST_RUN_ID, chainId: process.env.VONVON_HOST_CHAIN_ID,
        startedAt: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(), version: bridgeVersion(),
        intent: () => control.intent ?? (control.requested ? 'stop' : 'running'),
      });
      guardParentPipes(control);
      capOrphanDrain({ log, flush: flushLogs, providers: () => ({ registered: registeredProviderPids(), unconfirmed: unconfirmedProviderPids() }) });
    }
    if (control.requested) return;
    // the supervisor and each bot child (s23f2); one-off commands never get here
    stopLoopLag = startLoopLagMonitor({ pid: process.pid, ...(options.bot ? { bot: options.bot } : {}) });
    // The daily logs are shared by the supervisor and its bot children: only the supervisor trims them, once at start, then daily.
    if (!process.send) stopLogGc = startLogGc();
    host = new ProcessHost({
      dataDir: paths.appDir, daemonBootId: randomUUID(),
      ...(process.platform === 'win32' ? { platform: 'win32' } : { platform: 'posix', holderPath: defaultHolderPath() }),
    });
    log.info('process-host', 'boot-sweep', { ...await host.sweepOrphans() });
    log.info('process-host', 'boot-admission', { admission: host.admission()?.reason ?? 'allowed' });
    // Recover migration before runRun reads the registry or starts any Bot; orphan providers were drained above.
    if (!process.send) await bridgeImportRuntime().recover();
    // Also before any Bot starts (memory design §7.1 step A): every binding row, stopped bots' too, gets its project in
    // the library. It logs what fails and never fails the start; a paused run leaves it for the next one.
    if (!process.send && !run?.paused) {
      try { await (await import('../admin/library')).prepareLibraryAtStartup(); }
      catch (error) { log.fail('library', error, { phase: 'startup' }); }
    }
    // Lane 10 hook: the value is a fake-child.mjs path; the real `vonvon daemon run` has no other seam a lane can reach.
    if (process.env.VONVON_TEST_SPAWN_FAKE_CHILD) {
      await host.spawn('codex', 'lane-10', { file: process.execPath, args: [process.env.VONVON_TEST_SPAWN_FAKE_CHILD, '--ignore-term', '--grandchildren', '1'], env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
    }
    if (options.managed) {
      const codexBin = readServiceCodexBin();
      if (codexBin === null) delete process.env.CODEX_BIN;
      else if (codexBin !== undefined) process.env.CODEX_BIN = codexBin;
    }
    // The supervisor and each bot child have their own version cache. Warm it after
    // applying the managed binary selection, without holding startup on the probe.
    try {
      const bin = resolveCodexBin();
      if (bin) void codexVersionAsync(bin).then(async version => {
        if (process.platform === 'win32' && !codexTierUnavailable('qa', 'win32', version, { status: 'ready', implementation: 'mxc' })) {
          await refreshWindowsSandbox(bin);
        }
      }).catch(error => log.fail('daemon-startup', error, { phase: 'codex-permissions' }));
    } catch (error) {
      log.fail('daemon-startup', error, { phase: 'codex-version' });
    }
    // JP-VPS acceptance seam (s17): a real uncaught exception or rejection in a host, 2 s into the run.
    const seam = process.env.VONVON_TEST_CRASH;
    // Acceptance only: a value left in the environment is named at every start, in the log and on stderr.
    if (!process.send && (seam === 'exception' || seam === 'rejection' || seam === 'cleanup')) log.warn('daemon-startup', 'test_seam', { seam });
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
      onListening: claimedOwner ? async (listen) => {
        await publishPidLock(paths.appDir, claimedOwner, listen);
        const upkeep = startUpdateUpkeep(() => !control.requested);
        stopUpkeep = () => { void upkeep.then(stop => stop(), () => undefined); };
      } : undefined,
    });
  } catch (error) {
    errors.push(error);
    if (!control.requested) fatal = { error };
    // The supervisor and a single bot log what fails inside their run; a failure before it (the registration, a
    // lock, the registry) is logged here (s17b), in the JSON log only: the CLI prints this error itself.
    if (!wasLogged(error)) log.fail('daemon-run', error, { phase: 'run' }, { console: false });
  }
  finally {
    stopLoopLag?.();
    stopLogGc?.();
    stopUpkeep?.();
    // A cleanup failure no longer turns a requested restart into a stop (v1-plan s17): the replacement starts only
    // after this process has exited, and leftover provider processes are swept at the next boot.
    try { await host?.closeAll(); } catch (error) { log.fail('daemon-shutdown', error, { phase: 'process-host' }); errors.push(error); }
    if (!process.send) bridgeImportRuntime().dispose();
    // JP-VPS acceptance seam (s17b): a two-level cleanup failure, to see each error in the logs and on stderr.
    if (host && !process.send && process.env.VONVON_TEST_CRASH === 'cleanup') {
      const seam = new AggregateError([new Error('step 1'), new AggregateError([new Error('step 2')], 'VONVON_TEST_CRASH nested')], 'VONVON_TEST_CRASH cleanup');
      log.fail('daemon-shutdown', seam, { phase: 'test-seam' });
      errors.push(seam);
    }
    // complete() logs its own failure before it throws. It runs once: a run that called it already threw this
    // rejection, alone or in its group, so it is not added again.
    try { await control.completeShutdown(async () => {}); }
    catch (error) { if (!errors.some(item => item === error || (item instanceof AggregateError && Array.isArray(item.errors) && item.errors.includes(error)))) errors.push(error); }
    control.dispose();
    closeHostRun(fatal ? { kind: 'fatal', error: fatal.error } : { kind: 'clean' });
    // A paused run that cannot stay up exits 0 under a manager, which then leaves it down: the pause ends the loop.
    if (fatal && run?.paused && process.env.VONVON_SERVICE && !process.send) process.exitCode = 0;
    if (!errors.some(listenerCloseUnconfirmed)) {
      if (owner) {
        try { await releasePidLock(paths.appDir, owner); } catch (error) { log.fail('daemon-shutdown', error, { phase: 'pid-lock' }); errors.push(error); }
      }
      if (lock) {
        try { await closeMutex(lock); } catch (error) { log.fail('daemon-shutdown', error, { phase: 'host-mutex' }); errors.push(error); }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Host shutdown failed.');
  }
}
