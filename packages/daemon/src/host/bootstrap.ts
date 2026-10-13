import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from './lifecycle';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, publishPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';

export async function runHostRuntime(options: { bot?: string; port?: number; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  let owner: PidLockInfo | undefined;
  const errors: unknown[] = [];
  try {
    if (!process.send) {
      lock = await acquireMutex(paths.appDir, 'host');
      owner = await acquirePidLock(paths.appDir);
    }
    if (control.requested) return;
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
