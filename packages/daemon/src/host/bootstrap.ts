import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { observeShutdown, type ShutdownControl } from './lifecycle';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';

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
    if (options.managed) {
      const codexBin = readServiceCodexBin();
      if (codexBin === null) delete process.env.CODEX_BIN;
      else if (codexBin !== undefined) process.env.CODEX_BIN = codexBin;
    }
    const { runRun } = await import('../cli/commands/run');
    await runRun(options.bot, { control, managed: options.managed });
  } finally {
    control.dispose();
    if (owner) await releasePidLock(paths.appDir, owner);
    if (lock) await closeMutex(lock);
  }
}
