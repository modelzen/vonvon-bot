import { accessSync, closeSync, constants, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { paths } from '../config/paths';
import { resolveCodexBin } from '../agent/codex-appserver/locate';
import { managedToolSelection } from '../agent/codex-appserver/managed-tools';

/**
 * What to type in a terminal to start `executable` (0.9.0 Linux acceptance): a managed copy is on no PATH, so its path,
 * quoted where a shell needs it. A Node script goes behind `nodePath` when that is a real `node`: the Linux server runs
 * the managed copies on the Node it ships, which no terminal has on PATH. The desktop app's `nodePath` is Electron, not a
 * `node`; a managed copy there runs on the computer's own Node, which its terminal has too.
 */
export function terminalCommand(executable: string, nodePath = process.execPath, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return /[\s&()^,;=]/.test(executable) ? `"${executable}"` : executable;
  return basename(nodePath) === 'node' && nodeScript(executable) ? `${shellWord(nodePath)} ${shellWord(executable)}` : shellWord(executable);
}

/**
 * The managed copy's {@link terminalCommand} when it is the Codex or Claude in use, else nothing: the texts that send
 * someone to a terminal (配置, 重新登录) then name the tool. Codex is the one the daemon resolved; Claude's managed copy
 * is the one the 本机环境 uses before any other.
 */
export function managedToolCommand(tool: 'codex' | 'claude', dataRoot = paths.appDir): string | undefined {
  const executable = tool === 'codex' ? resolveCodexBin({ dataRoot }) : managedClaude(dataRoot);
  return executable ? managedCommand(executable, dataRoot) : undefined;
}

/** {@link managedToolCommand}, or the tool's own name. */
export function toolCommand(tool: 'codex' | 'claude', dataRoot = paths.appDir): string {
  return managedToolCommand(tool, dataRoot) ?? tool;
}

/** `executable`'s {@link terminalCommand} when it is one of the copies this data directory manages (either layout). */
export function managedCommand(executable: string, dataRoot = paths.appDir): string | undefined {
  const managed = [join(dataRoot, 'managed-tools'), join(dataRoot, 'codex-cli')].some(directory => {
    const path = relative(directory, executable);
    return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  });
  return managed ? terminalCommand(executable) : undefined;
}

function managedClaude(dataRoot: string): string | null {
  const selection = managedToolSelection(dataRoot, 'claude');
  if (selection.kind === 'active') return selection.executable;
  const legacy = join(dataRoot, 'managed-tools', 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
  if (selection.kind !== 'absent') return null;
  try { accessSync(legacy, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return legacy; } catch { return null; }
}

const shellWord = (value: string): string => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/** A `#!` file whose interpreter line names node, like npm's launcher of Codex; Claude Code's is a native program. */
function nodeScript(executable: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(executable, 'r');
    const head = Buffer.alloc(128);
    const line = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('utf8').split('\n')[0] ?? '';
    return line.startsWith('#!') && /\bnode\b/.test(line);
  } catch { return false; }
  finally { if (fd !== undefined) closeSync(fd); }
}
