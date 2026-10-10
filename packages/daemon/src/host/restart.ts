import { spawn } from 'node:child_process';
import { paths } from '../config/paths';
import { getPidLockInfo, isPidLockOwnerRunning } from '../server/pid-lock';

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runSamePortRestartHelper(options: { port: number; oldPid: number }): Promise<void> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535 ||
      !Number.isSafeInteger(options.oldPid) || options.oldPid < 1) throw new Error('Invalid restart identity.');
  const cliEntry = process.argv[1];
  if (!cliEntry) throw new Error('Cannot locate daemon CLI for restart.');
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const lock = await getPidLockInfo(paths.appDir);
    if (!lock || !isPidLockOwnerRunning(lock)) break;
    if (lock.pid !== options.oldPid) return;
    await pause(100);
  }
  if (Date.now() >= deadline) throw new Error('Old daemon did not release its PID lock for restart.');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, 'daemon', 'start', '--port', String(options.port)], {
      stdio: 'ignore',
      env: { ...process.env, VONVON_HOME: paths.appDir },
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Restart start command exited ${code}.`)));
  });
}
