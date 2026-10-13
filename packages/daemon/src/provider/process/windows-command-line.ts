import { win32 } from 'node:path';

/**
 * The one Windows command line the supervisor hands to `CreateProcessW` verbatim.
 *
 * Callers resolve the command themselves and pass the result as the `launch` command's `file` (the application path,
 * `cmd.exe`'s full path for a shim) with this string as the single argument frame. Nothing here touches PATH or PATHEXT.
 *
 * `shim: false` reproduces libuv's `quote_cmd_arg` and `make_program_args` from Node v22.12.0 (`deps/uv/src/win/process.c`),
 * with `argv[0]` quoted the same way as the arguments. `shim: true` reproduces cross-spawn 7.0.6's `parseNonShell` for a
 * `.cmd` or `.bat` command: `escape.command` on the normalized path, `escape.argument` on each argument, double-escaped when the
 * command is a `node_modules/.bin` cmd-shim, then `cmd.exe /d /s /c "<shell command>"`.
 */
export function windowsCommandLine(file: string, args: readonly string[], resolved: { shim: boolean }): string {
  if (!resolved.shim) return [file, ...args].map(quoteCmdArg).join(' ');
  const command = win32.normalize(file);
  const doubleEscape = /node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i.test(command);
  const shell = [escapeCommand(command), ...args.map(arg => escapeArgument(arg, doubleEscape))].join(' ');
  return `cmd.exe /d /s /c "${shell}"`;
}

/** libuv `quote_cmd_arg`: a backslash run before a quote or before the closing quote doubles; every other backslash stays. */
export function quoteCmdArg(source: string): string {
  if (source === '') return '""';
  if (!/[ \t"]/.test(source)) return source;
  if (!/["\\]/.test(source)) return `"${source}"`;
  let out = '';
  let backslashes = 0;
  for (const char of source) {
    if (char === '\\') { backslashes += 1; continue; }
    if (char === '"') out += '\\'.repeat(backslashes * 2) + '\\"';
    else out += '\\'.repeat(backslashes) + char;
    backslashes = 0;
  }
  return `"${out}${'\\'.repeat(backslashes * 2)}"`;
}

const META = /([()\][%!^"`<>&|;, *?])/g;

const escapeCommand = (arg: string): string => arg.replace(META, '^$1');

function escapeArgument(arg: string, doubleEscape: boolean): string {
  let out = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  out = `"${out}"`.replace(META, '^$1');
  return doubleEscape ? out.replace(META, '^$1') : out;
}
