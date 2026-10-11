import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { paths } from '../../config/paths';
import { daemonStatus, runStart } from './daemon';

const run = promisify(execFile);

export function buildOpenUrl(listen: string, credential: string): string {
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(listen)) throw new Error('Daemon is not listening on loopback.');
  if (!/^[a-f0-9]{64}$/i.test(credential)) throw new Error('Invalid local daemon credential.');
  return `http://${listen}/#credential=${encodeURIComponent(credential)}`;
}

export async function runOpen(): Promise<void> {
  const current = await daemonStatus();
  const status = current.running ? current : await runStart();
  if (!status.running) throw new Error('Daemon did not start.');
  const credential = (await readFile(join(paths.appDir, 'local-credential'), 'utf8')).trim();
  const url = buildOpenUrl(status.listen, credential);
  if (process.platform === 'darwin') await run('open', [url]);
  else if (process.platform === 'win32') await run('cmd', ['/c', 'start', '', url]);
  else await run('xdg-open', [url]);
}
