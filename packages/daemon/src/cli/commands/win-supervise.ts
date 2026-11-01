import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { paths } from '../../config/paths';
import { bridgeVersion } from '../../core/version';
import { SUPERVISOR_PID_FILE } from '../../service/windows';

/**
 * `__win-supervise --port N --home <data root>`: what the Windows scheduled task runs (I4a §4.6). PLACEHOLDER until I4b:
 * it runs `daemon run` as the service (`VONVON_SERVICE=windows`, the task's data root, output to the service logs, no
 * window) and restarts it itself: Task Scheduler's RestartOnFailure only retries a task that failed to start, never one
 * whose process exited non-zero (I4a review F4). 0 ends it; 75 (a requested restart) starts the daemon again at once;
 * anything else after 5 seconds, or 30 after five failures in a row, each within a minute of its start. I4b replaces this
 * file with the supervisor (version hand-over, its own lock).
 */
export type WinSuperviseDependencies = {
  spawn: (file: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;
  execPath: string;
  entry: string | undefined;
  pid: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  version: string;
};

/** The placeholder's restart waits (I4b keeps the same numbers). */
export const WIN_SUPERVISE_TIMING = { restartMs: 5_000, backoffMs: 30_000, quickMs: 60_000, quickFailures: 5 } as const;

const defaults = (): WinSuperviseDependencies => ({
  spawn: (file, args, options) => spawn(file, args, options), execPath: process.execPath, entry: process.argv[1],
  pid: process.pid, now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), version: bridgeVersion(),
});

export async function runWinSupervise(options: { port: number; home?: string }, overrides: Partial<WinSuperviseDependencies> = {}): Promise<number> {
  const d = { ...defaults(), ...overrides };
  const root = options.home ?? paths.appDir;
  if (!isAbsolute(root)) throw new Error('--home must be an absolute path');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid port.');
  if (!d.entry) throw new Error('Cannot locate the daemon CLI entry.');
  const entry = d.entry;
  const pidFile = join(root, SUPERVISOR_PID_FILE);
  writeFileSync(`${pidFile}.tmp`, `${JSON.stringify({ pid: d.pid, startedAt: new Date(d.now()).toISOString(), version: d.version })}\n`, { mode: 0o600 });
  renameSync(`${pidFile}.tmp`, pidFile);
  const once = async (): Promise<number> => {
    const out = openSync(join(root, 'service.log'), 'a', 0o600);
    const err = openSync(join(root, 'service.err.log'), 'a', 0o600);
    let child: ChildProcess;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, VONVON_HOME: root, VONVON_SERVICE: 'windows' };
      child = d.spawn(d.execPath, [entry, 'daemon', 'run', '--port', String(options.port)], { env, stdio: ['ignore', out, err], windowsHide: true });
    } finally { closeSync(out); closeSync(err); }
    return new Promise<number>(resolve => {
      child.once('error', () => resolve(1));
      child.once('exit', code => resolve(code ?? 1));
    });
  };
  try {
    let quick = 0;
    for (;;) {
      const started = d.now();
      const code = await once();
      if (code === 0) return 0;
      // A requested restart is no failure; a failure that ran a minute or more starts the count again.
      quick = code !== 75 && d.now() - started < WIN_SUPERVISE_TIMING.quickMs ? quick + 1 : 0;
      const wait = quick >= WIN_SUPERVISE_TIMING.quickFailures ? WIN_SUPERVISE_TIMING.backoffMs : code === 75 ? 0 : WIN_SUPERVISE_TIMING.restartMs;
      try { appendFileSync(join(root, 'service.err.log'), `vonvon __win-supervise: daemon exited ${code}; starting it again in ${wait / 1000} s\n`); }
      catch { /* the log is not worth stopping for */ }
      if (wait > 0) await d.sleep(wait);
    }
  } finally {
    // Only the file this process wrote: a later supervisor may have replaced it.
    try { if ((JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: unknown }).pid === d.pid) unlinkSync(pidFile); }
    catch { /* already gone */ }
  }
}
