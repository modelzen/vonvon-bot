import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { startToken, type StartToken } from './ledger';

export type StartRead = StartToken | 'absent' | 'unreadable';

const ABSENT_EXIT = 3;
let linuxBootId: Promise<string> | undefined;

async function readLinux(pid: number): Promise<StartRead> {
  linuxBootId ??= readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(text => text.trim());
  const bootId = await linuxBootId;
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { return errnoOf(error) === 'ENOENT' ? 'absent' : 'unreadable'; }
  // comm (field 2) may contain spaces and parentheses; fields after the last ')' start at field 3.
  const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return ticks && /^\d+$/.test(ticks) && bootId ? startToken(`linux:${bootId}:${ticks}`) : 'unreadable';
}

/** One-second resolution: two processes may share a token, so only `absent` or a different token proves anything. */
export async function readDarwin(pid: number): Promise<StartRead> {
  const result = await run('ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C', TZ: 'UTC' });
  const lstart = result.stdout.trim();
  if (result.code === 0 && lstart && result.stderr.trim() === '') return startToken(`darwin:${lstart}`);
  // ps exits 1 both for "no such pid" and for its own failures, so absence is confirmed by the kernel, not by ps.
  return result.code !== 0 && signalProbe(pid) === 'ESRCH' ? 'absent' : 'unreadable';
}

function signalProbe(pid: number): unknown {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return errnoOf(error); }
}

async function readWin32(pid: number): Promise<StartRead> {
  const script = `try { $p=[Diagnostics.Process]::GetProcessById(${pid}) } catch [ArgumentException] { exit ${ABSENT_EXIT} }; [Console]::Out.WriteLine($p.StartTime.ToFileTimeUtc())`;
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], process.env);
  if (result.code === ABSENT_EXIT) return 'absent';
  const filetime = result.stdout.trim();
  return result.code === 0 && /^\d+$/.test(filetime) ? startTokenFromFileTime(filetime) : 'unreadable';
}

const READERS: Partial<Record<NodeJS.Platform, (pid: number) => Promise<StartRead>>> = {
  linux: readLinux, darwin: readDarwin, win32: readWin32,
};

/** A different token, or `absent`, for a recorded pid proves the recorded process is gone; an equal token proves nothing more. Never rejects. */
export function readStartToken(pid: number): Promise<StartRead> {
  const reader = READERS[process.platform];
  if (!reader || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve('unreadable');
  return reader(pid).catch(() => 'unreadable' as const);
}

/** The token the Windows supervisor's `hello` carries: its own creation FILETIME in decimal. */
export function startTokenFromFileTime(decimal: string): StartToken {
  if (!/^\d+$/.test(decimal)) throw new Error(`not a decimal FILETIME: ${decimal}`);
  return startToken(`win32:${BigInt(decimal).toString()}`);
}

export const hostBootMs = (): number => Date.now() - uptime() * 1000;

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr });
      reject(error);
    });
  });
}

function errnoOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}
