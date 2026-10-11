import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from './lifecycle';
import { recordServicePid, clearServicePid } from '../service/win-startup';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, publishPidLock, readRunningPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';
import { readStartupRegistration } from '../service/startup';
import { log } from '../core/logger';

export async function runHostRuntime(options: { bot?: string; port?: number; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  let owner: PidLockInfo | undefined;
  const errors: unknown[] = [];
  try {
    if (!process.send) {
      const serviceManaged = Boolean(process.env.VONVON_SERVICE);
      if (process.platform === 'win32' && serviceManaged) throw new Error('Windows service startup is unavailable.');
      const registration = process.platform === 'win32' ? null : await readStartupRegistration(paths.appDir).catch(error => {
        if (!serviceManaged) throw error;
        return null;
      });
      if (serviceManaged && registration?.kind !== 'ours') {
        log.info('daemon-startup', 'registration_absent');
        process.exitCode = 0;
        return;
      }
      if (serviceManaged) {
        const existing = await readRunningPidLock(paths.appDir);
        if (existing) {
          log.info('daemon-startup', 'owner_present', { pid: existing.pid });
          process.exitCode = 0;
          return;
        }
      } else if (registration?.kind === 'ours') {
        process.exitCode = 1;
        throw new Error('Daemon is registered as a service. Use vonvon daemon start or vonvon service uninstall.');
      }
      try {
        lock = await acquireMutex(paths.appDir, 'host');
        owner = await acquirePidLock(paths.appDir);
      } catch (error) {
        const existing = serviceManaged ? await readRunningPidLock(paths.appDir) : null;
        if (!existing || existing.pid === process.pid) throw error;
        log.info('daemon-startup', 'owner_present', { pid: existing.pid });
        process.exitCode = 0;
        return;
      }
    }
    if (control.requested) return;
    if (owner) recordServicePid();
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
    try { await control.completeShutdown(async () => {}); }
    catch (error) { errors.push(error); }
    control.dispose();
    if (!errors.some(listenerCloseUnconfirmed)) {
      if (owner) {
        try { clearServicePid(); } catch (error) { errors.push(error); }
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
