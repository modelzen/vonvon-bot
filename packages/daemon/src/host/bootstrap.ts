import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { readHostEndpoint } from './discovery';
import { observeShutdown, type ShutdownControl } from './lifecycle';
import { readServiceCodexBin } from '../service/codex-bin';

export async function runHostRuntime(options: { bot?: string; managed: boolean; control?: ShutdownControl }): Promise<void> {
  const control = options.control ?? observeShutdown(options.managed);
  let lock: Awaited<ReturnType<typeof acquireMutex>> | undefined;
  try {
    if (!process.send) {
      lock = await acquireMutex(paths.appDir, 'host');
      const existing = await readHostEndpoint(paths.appDir, true);
      if (existing) throw new Error('kind' in existing ? existing.message : `Host ${existing.pid} is already running.`);
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
    if (lock) await closeMutex(lock);
  }
}
