import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { observeShutdown, type ShutdownControl } from './lifecycle';
import { recordServicePid, clearServicePid } from '../service/win-startup';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, publishPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';

export async function runHostRuntime(options: { bot?: string; port?: number; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  let owner: PidLockInfo | undefined;
  try {
    if (!process.send) {
      lock = await acquireMutex(paths.appDir, 'host');
      owner = await acquirePidLock(paths.appDir);
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
  } finally {
    await control.completeShutdown(async () => {});
    control.dispose();
    if (owner) {
      clearServicePid();
      await releasePidLock(paths.appDir, owner);
    }
    if (lock) await closeMutex(lock);
  }
}
