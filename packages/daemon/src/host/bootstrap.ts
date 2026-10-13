import { randomUUID } from 'node:crypto';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { listenerCloseUnconfirmed, observeShutdown, type ShutdownControl } from './lifecycle';
import { recordServicePid, clearServicePid } from '../service/win-startup';
import { readServiceCodexBin } from '../service/codex-bin';
import { acquirePidLock, publishPidLock, releasePidLock, type PidLockInfo } from '../server/pid-lock';
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
      lock = await acquireMutex(paths.appDir, 'host');
      owner = await acquirePidLock(paths.appDir);
    }
    if (control.requested) return;
    if (owner) recordServicePid();
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
