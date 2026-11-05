import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../config/paths';
import { SESSION_CLI_ENV } from '../config/session-env';
import { log } from '../core/logger';
import { selfEntry } from '../core/self-entry';
import { pathFor } from '../platform/home-path';

/**
 * dm-agent 9: a session finds `vonvon` however it was started. The desktop's registration writes shell startup files, and
 * the Linux server its PATH block, but those fail, are skipped by a development build, go unread by a shell that is not a
 * login shell, and miss a daemon that started first. So each Bot writes its own launcher and puts it on its sessions' PATH.
 * Rewritten at every start, it follows an upgrade; both Providers take it from `SessionProfile.env`.
 */
export interface CliRuntime {
  execPath: string;
  entry: string;
  /** The daemon runs inside Electron, which is only a Node when told so. */
  electron: boolean;
}
export interface LauncherFile { name: string; content: string; mode: number }

const MARKER = 'Vonvon Bot session launcher; rewritten each time a Bot starts';

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
function shLauncher({ execPath, entry, electron }: CliRuntime): string {
  return `#!/bin/sh\n# ${MARKER}\n${electron ? 'ELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE\n' : ''}exec ${shQuote(execPath)} ${shQuote(entry)} "$@"\n`;
}

/** Inside double quotes cmd.exe still expands `%`; `&`, `^`, spaces and the like stay as they are. */
const cmdQuote = (value: string): string => `"${value.replaceAll('%', '%%')}"`;
/**
 * cmd.exe decodes a batch file line by line in the console's code page, so a path with Chinese in it (the user's folder
 * is in most of them) reaches Windows garbled unless the page is UTF-8 while that line is read. It is put back after, and
 * the command's exit code kept. `%%~nb` takes the dot off the number some languages' `chcp` end with.
 */
function cmdLauncher({ execPath, entry, electron }: CliRuntime): string {
  return [
    '@echo off',
    `rem ${MARKER}`,
    'setlocal DisableDelayedExpansion',
    `for /f "tokens=*" %%a in ('chcp') do for %%b in (%%a) do set "VONVON_CODE_PAGE=%%~nb"`,
    'chcp 65001 >nul 2>nul',
    ...electron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : [],
    `${cmdQuote(execPath)} ${cmdQuote(entry)} %*`,
    'set "VONVON_EXIT=%ERRORLEVEL%"',
    'chcp %VONVON_CODE_PAGE% >nul 2>nul',
    'exit /b %VONVON_EXIT%',
    '',
  ].join('\r\n');
}

/** What goes in `<data>/bin`, the one a session's `$VONVON_CLI` names first. Claude's Bash on Windows is Git Bash, which runs no `.cmd` by a bare name, so it gets the `sh` one beside it, the way npm installs itself. */
export function launcherFiles(runtime: CliRuntime, platform: NodeJS.Platform = process.platform): LauncherFile[] {
  const sh = { name: 'vonvon', content: shLauncher(runtime), mode: 0o755 };
  return platform === 'win32' ? [{ name: 'vonvon.cmd', content: cmdLauncher(runtime), mode: 0o755 }, sh] : [sh];
}

const currentRuntime = (): CliRuntime => ({ execPath: process.execPath, entry: selfEntry(), electron: Boolean(process.env.ELECTRON_RUN_AS_NODE) });
const text = (path: string): Promise<string | undefined> => readFile(path, 'utf8').catch(() => undefined);

/** Bots start together and write the same file: a rename is whole, and one that loses to the same text has lost nothing. */
async function writeLauncher(path: string, content: string, mode: number): Promise<void> {
  if (await text(path) === content) { await chmod(path, mode); return; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (await text(path) !== content) throw error;
  }
}

/**
 * The launcher's full path, or undefined when it could not be written: that is logged and never holds a Bot up, and its
 * sessions then keep the PATH they had. An older launcher left there is not offered, since it may name a release that is gone.
 */
export async function writeSessionCli(runtime: CliRuntime = currentRuntime(), directory?: string, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  try {
    if (!runtime.entry) throw new Error('无法解析 CLI 入口');
    const bin = directory ?? join(paths.appDir, 'bin');
    await mkdir(bin, { recursive: true, mode: 0o700 });
    const files = launcherFiles(runtime, platform);
    for (const { name, content, mode } of files) await writeLauncher(join(bin, name), content, mode);
    return join(bin, files[0]!.name);
  } catch (error) {
    log.fail('agent', error, { phase: 'session-cli-failed' });
    return undefined;
  }
}

/**
 * The launcher's directory ahead of this process's PATH, read when a session starts, and its full path. On Windows the
 * variable keeps the spelling it has here (usually `Path`), so a child environment does not end up with two.
 */
export function sessionCliEnv(cli: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const { delimiter, dirname } = pathFor(platform);
  const name = platform === 'win32' ? Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  const directory = dirname(cli);
  return { [name]: [directory, ...(env[name] ?? '').split(delimiter).filter(entry => entry && entry !== directory)].join(delimiter), [SESSION_CLI_ENV]: cli };
}
