import { randomUUID } from 'node:crypto';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from './lifecycle';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, publishPidLock, readRunningPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';
import { readStartupRegistration } from '../service/startup';
import { log } from '../core/logger';
import { defaultHolderPath, ProcessHost } from '../provider/process/process-host';

export async function runHostRuntime(options: { bot?: string; port?: number; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  let owner: PidLockInfo | undefined;
  let host: ProcessHost | undefined;
  const errors: unknown[] = [];
  try {
    if (!process.send) {
      const serviceManaged = Boolean(process.env.VONVON_SERVICE);
      const liveOtherOwner = async () => {
        const existing = await readRunningPidLock(paths.appDir);
        return existing && existing.pid !== process.pid ? existing : null;
      };
      const registration = await readStartupRegistration(paths.appDir);
      if (serviceManaged) {
        if (registration.kind !== 'ours') {
          log.info('daemon-startup', 'registration_absent', registration.kind === 'other-root' ? { kind: registration.kind, recordedRoot: registration.recordedRoot } : registration);
          process.exitCode = 0;
          return;
        }
        const existing = await liveOtherOwner();
        if (existing) {
          log.info('daemon-startup', 'owner_present', { pid: existing.pid });
          process.exitCode = 0;
          return;
        }
      } else if (registration.kind === 'ours') {
        throw new Error('Daemon is registered as a service. Use vonvon daemon start or vonvon service uninstall.');
      }
      try {
        lock = await acquireMutex(paths.appDir, 'host');
        owner = await acquirePidLock(paths.appDir);
      } catch (error) {
        const existing = serviceManaged ? await liveOtherOwner() : null;
        if (!existing) throw error;
        log.info('daemon-startup', 'owner_present', { pid: existing.pid });
        process.exitCode = 0;
        return;
      }
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
    const { runRun } = await import('../cli/commands/run');
    const claimedOwner = owner;
    await runRun(options.bot, {
      control,
      managed: options.managed,
      port: options.port,
      onListening: claimedOwner ? async (listen) => { await publishPidLock(paths.appDir, claimedOwner, listen); } : undefined,
    });
  } catch (error) { errors.push(error); }
  finally {
    try { await host?.closeAll(); } catch (error) { errors.push(error); }
    if (errors.length && control.requested) control.requestStop();
    try { await control.completeShutdown(async () => {}); }
    catch (error) { errors.push(error); }
    control.dispose();
    if (!errors.some(listenerCloseUnconfirmed)) {
      if (owner) {
        try { await releasePidLock(paths.appDir, owner); } catch (error) { errors.push(error); }
      }
      if (lock) {
        try { await closeMutex(lock); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length && process.exitCode === 75 && process.env.VONVON_SERVICE && !process.send) process.exitCode = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, 'Host shutdown failed.');
  }
}
