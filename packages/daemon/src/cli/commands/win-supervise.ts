import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { paths } from '../../config/paths';
import { bridgeVersion } from '../../core/version';
import { SUPERVISOR_PID_FILE } from '../../service/windows';

/**
 * `__win-supervise --port N --home <data root>`: what the Windows scheduled task runs (I4a §4.6). PLACEHOLDER until I4b:
 * it starts `daemon run` once, as the service (`VONVON_SERVICE=windows`, the task's data root, output to the service
 * logs, no window), and exits with the daemon's code; Task Scheduler's RestartOnFailure is the only restart. I4b replaces
 * this file with the supervisor (0 / 75 / other, version hand-over).
 */
export type WinSuperviseDependencies = {
  spawn: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  execPath: string;
  entry: string | undefined;
  pid: number;
  now: () => number;
  version: string;
};

const defaults = (): WinSuperviseDependencies => ({
  spawn: (file, args, options) => spawn(file, args, options), execPath: process.execPath, entry: process.argv[1],
  pid: process.pid, now: Date.now, version: bridgeVersion(),
});

export async function runWinSupervise(options: { port: number; home?: string }, overrides: Partial<WinSuperviseDependencies> = {}): Promise<number> {
  const d = { ...defaults(), ...overrides };
  const root = options.home ?? paths.appDir;
  if (!isAbsolute(root)) throw new Error('--home must be an absolute path');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid port.');
  if (!d.entry) throw new Error('Cannot locate the daemon CLI entry.');
  const pidFile = join(root, SUPERVISOR_PID_FILE);
  writeFileSync(`${pidFile}.tmp`, `${JSON.stringify({ pid: d.pid, startedAt: new Date(d.now()).toISOString(), version: d.version })}\n`, { mode: 0o600 });
  renameSync(`${pidFile}.tmp`, pidFile);
  try {
    const out = openSync(join(root, 'service.log'), 'a', 0o600);
    const err = openSync(join(root, 'service.err.log'), 'a', 0o600);
    let child: ChildProcess;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, VONVON_HOME: root, VONVON_SERVICE: 'windows' };
      child = d.spawn(d.execPath, [d.entry, 'daemon', 'run', '--port', String(options.port)], { env, stdio: ['ignore', out, err], windowsHide: true });
    } finally { closeSync(out); closeSync(err); }
    return await new Promise<number>(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
    });
  } finally {
    // Only the file this process wrote: a later supervisor may have replaced it.
    try { if ((JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown }).pid === d.pid) unlinkSync(pidFile); }
    catch { /* already gone */ }
  }
}
