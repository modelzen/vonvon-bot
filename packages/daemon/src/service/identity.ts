import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import { decodeConsoleText, runWindowsCommand, withTimeout, type WindowsRun } from './windows-command';

export const LAUNCHD_LABEL = 'com.vonvon.bot.daemon';
export const SYSTEMD_UNIT_NAME = 'vonvon-bot.service';

declare const canonicalRoot: unique symbol;
export type CanonicalRoot = string & { readonly [canonicalRoot]: true };

export type Target =
  | { platform: 'darwin'; label: string; plistPath: string }
  | { platform: 'linux'; unitName: string; unitPath: string }
  /** A scheduled task (I4a): no file; the name is the task path, `sid` the user it runs as. */
  | { platform: 'win32'; taskName: string; sid: string };

export async function resolveServiceRoot(path: string): Promise<CanonicalRoot> {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error(`Service root is not a directory: ${root}`);
  return root as CanonicalRoot;
}

/** The real path, resolving the nearest existing ancestor of a path not created yet, as `resolveDataRoot` does. */
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch {
    const parent = posix.dirname(path);
    return parent === path ? path : posix.join(canonical(parent), posix.basename(path));
  }
}

/**
 * The service name for a data root. The default root `~/.vonvon-bot` keeps the
 * fixed names; any other `VONVON_HOME` gets names suffixed with a hash of its
 * canonical path, so a test or second install never replaces the user's service.
 */
export function serviceName(platform: 'darwin' | 'linux', root: string, home: string): string {
  const fixed = canonical(root) === canonical(posix.join(canonical(home), '.vonvon-bot'));
  const suffix = fixed ? '' : createHash('sha256').update(canonical(root)).digest('hex').slice(0, 12);
  if (platform === 'darwin') return suffix ? `${LAUNCHD_LABEL}.${suffix}` : LAUNCHD_LABEL;
  return suffix ? `vonvon-bot-${suffix}.service` : SYSTEMD_UNIT_NAME;
}

type PosixTargetInput =
  | { platform: 'darwin'; home: string; root: string }
  | { platform: 'linux'; home: string; root: string; xdgConfigHome: string | undefined };
export function serviceTarget(input: { platform: 'win32'; sid: string; root: string }): Extract<Target, { platform: 'win32' }>;
export function serviceTarget(input: PosixTargetInput): Exclude<Target, { platform: 'win32' }>;
export function serviceTarget(input: PosixTargetInput | { platform: 'win32'; sid: string; root: string }): Target;
export function serviceTarget(input: PosixTargetInput | { platform: 'win32'; sid: string; root: string }): Target {
  if (input.platform === 'win32') {
    if (!SID.test(input.sid)) throw new SidUnavailable(`Not a user SID: ${input.sid}`);
    return { platform: 'win32', taskName: windowsTaskName(input.sid, nativeRealpath(input.root)), sid: input.sid };
  }
  const name = serviceName(input.platform, input.root, input.home);
  switch (input.platform) {
    case 'darwin':
      if (!posix.isAbsolute(input.home)) throw new Error('Home must be absolute');
      return { platform: input.platform, label: name, plistPath: posix.join(input.home, 'Library/LaunchAgents', `${name}.plist`) };
    case 'linux': {
      const config = input.xdgConfigHome || posix.join(input.home, '.config');
      if (!posix.isAbsolute(config)) throw new Error('Config home must be absolute');
      return { platform: input.platform, unitName: name, unitPath: posix.join(config, 'systemd/user', name) };
    }
  }
}

const SID = /^S-1-[0-9-]+$/;
const hash12 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** The real path where it exists, as `resolveServiceRoot` (the native realpath) gives it; the path as given otherwise. */
function nativeRealpath(path: string): string {
  try { return realpathSync.native(path); } catch { return path; }
}

/** C7: the data root, normalized for Windows, lower case, without a trailing backslash. */
export function canonicalWindowsRoot(root: string): string {
  return win32.normalize(root).toLowerCase().replace(/\\+$/, '');
}

/**
 * C7: `\VonvonBot-<sid-hash12>-<root-hash12>`. Task names are machine-wide, so even the default data root carries both
 * hashes: two users, or one user's second data root, never share a task. The task sits in the root folder, as per-user
 * installs' tasks do: a standard user may create tasks there but not a folder (I4a review F2).
 */
export function windowsTaskName(sid: string, root: string): string {
  return `\\VonvonBot-${hash12(sid)}-${hash12(canonicalWindowsRoot(root))}`;
}

export class SidUnavailable extends Error {
  constructor(detail: string) { super(`Cannot read the current user's SID: ${detail}`); this.name = 'SidUnavailable'; }
}

/** `whoami /user /fo csv /nh` prints one line, `"<domain\\user>","S-1-5-21-…"`; the SID is the second column. */
export function parseWhoamiSid(output: string): string {
  const line = output.split(/\r?\n/).find(text => text.trim() !== '') ?? '';
  const match = /^\s*"(?:[^"]|"")*","([^"]*)"\s*$/.exec(line);
  const sid = match?.[1];
  if (sid === undefined || !SID.test(sid)) throw new SidUnavailable(line.trim() ? 'unexpected whoami output' : 'empty whoami output');
  return sid;
}

/** Asks `whoami` once per reader; a failure is not kept, so the next call asks again. */
export function createSidReader(run: WindowsRun): () => Promise<string> {
  let cached: Promise<string> | undefined;
  return () => {
    cached ??= (async () => {
      const result = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
      if (!result.ok || result.status !== 0) throw new SidUnavailable(`whoami: ${result.stderr.trim() || `exit ${result.status}`}`);
      return parseWhoamiSid(decodeConsoleText(result.stdout));
    })();
    cached.catch(() => { cached = undefined; });
    return cached;
  };
}

/** This process's user SID, read once (I4a §4.1). */
export const currentWindowsSid: () => Promise<string> = createSidReader(withTimeout(runWindowsCommand));
