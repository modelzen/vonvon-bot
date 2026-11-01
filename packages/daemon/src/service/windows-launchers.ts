import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The two launchers in `<installRoot>\bin`: `vonvon.cmd` for people, `vonvon-server.cmd` for the scheduled task (I4a §4.4). */
export const WINDOWS_LAUNCHERS = { cli: 'vonvon.cmd', server: 'vonvon-server.cmd' } as const;
/** The launchers' "no usable release" exit code (EX_SOFTWARE). */
export const LAUNCHER_FAILURE_EXIT = 70;

/**
 * One launcher; only the marker on the second line differs, so the task's command line and the user's can change apart.
 * `current.txt` (C5): line 1 is the current version, line 2 the previous one, empty on a first install. `for /f` skips
 * empty lines, so an empty line 2 leaves VONVON_PREV undefined. Every path is quoted (spaces, parentheses, non-ASCII);
 * inside the `( … )` blocks only versions are expanded, never a path, so a `)` in a path cannot end a block early.
 * `%*` passes the arguments through as typed, and the exit code (75, 0, any other) goes back to the caller.
 */
function launcher(marker: string): string {
  return [
    '@echo off',
    `rem ${marker}`,
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "VONVON_ROOT=%~dp0.."',
    'set "VONVON_VER="',
    'set "VONVON_PREV="',
    `if not exist "%VONVON_ROOT%\\current.txt" ( echo Vonvon Bot: current.txt is missing 1>&2 & exit /b ${LAUNCHER_FAILURE_EXIT} )`,
    'for /f "usebackq delims=" %%L in ("%VONVON_ROOT%\\current.txt") do (',
    '  if not defined VONVON_VER ( set "VONVON_VER=%%L" ) else if not defined VONVON_PREV ( set "VONVON_PREV=%%L" )',
    ')',
    `if not defined VONVON_VER ( echo Vonvon Bot: current.txt is empty 1>&2 & exit /b ${LAUNCHER_FAILURE_EXIT} )`,
    'if not exist "%VONVON_ROOT%\\releases\\%VONVON_VER%\\standalone.json" (',
    `  if defined VONVON_PREV ( set "VONVON_VER=%VONVON_PREV%" ) else ( echo Vonvon Bot: release %VONVON_VER% is missing 1>&2 & exit /b ${LAUNCHER_FAILURE_EXIT} )`,
    ')',
    `if not exist "%VONVON_ROOT%\\releases\\%VONVON_VER%\\standalone.json" ( echo Vonvon Bot: no usable release, %VONVON_VER% is missing too 1>&2 & exit /b ${LAUNCHER_FAILURE_EXIT} )`,
    'set "PATH=%VONVON_ROOT%\\releases\\%VONVON_VER%\\node;%PATH%"',
    '"%VONVON_ROOT%\\releases\\%VONVON_VER%\\node\\node.exe" "%VONVON_ROOT%\\releases\\%VONVON_VER%\\app\\bin\\vonvon.mjs" %*',
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** The launchers' text, CRLF, keyed by their path under the install root. */
export function renderWindowsLaunchers(): { 'bin\\vonvon.cmd': string; 'bin\\vonvon-server.cmd': string } {
  return {
    'bin\\vonvon.cmd': launcher('Vonvon Bot server CLI v1'),
    'bin\\vonvon-server.cmd': launcher('Vonvon Bot server supervisor v1'),
  };
}

type LauncherFs = {
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (path: string, data: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
};

/** Writes both launchers into `<installRoot>\bin`, each to `.cmd.tmp` first and renamed over the old one (I2's `__standalone-setup` calls it). */
export async function writeWindowsLaunchers(installRoot: string, fs: LauncherFs = { mkdir, writeFile, rename }): Promise<string[]> {
  const bin = join(installRoot, 'bin');
  await fs.mkdir(bin, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of [[WINDOWS_LAUNCHERS.cli, renderWindowsLaunchers()['bin\\vonvon.cmd']], [WINDOWS_LAUNCHERS.server, renderWindowsLaunchers()['bin\\vonvon-server.cmd']]] as const) {
    const path = join(bin, name);
    await fs.writeFile(`${path}.tmp`, content);
    await fs.rename(`${path}.tmp`, path);
    written.push(path);
  }
  return written;
}

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * C5 `current.txt`, read the way the launchers read it: `for /f` skips empty lines, so the first non-empty line is the
 * version and the second the previous one. Null when the first is missing or not a version; a malformed second line is
 * no previous version. I3's `readCurrent` uses this on Windows.
 */
export function parseCurrentTxt(text: string): { version: string; previous?: string } | null {
  const lines = text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line !== '');
  const [version, previous] = lines;
  if (version === undefined || !VERSION.test(version)) return null;
  return previous !== undefined && VERSION.test(previous) ? { version, previous } : { version };
}
