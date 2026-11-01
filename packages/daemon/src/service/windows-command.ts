import { spawn } from 'node:child_process';
import { join } from 'node:path';

/** What `schtasks`, `whoami` and `taskkill` returned. `stdout` stays bytes: `schtasks /Query /XML` is read as XML (I4a §4.2). */
export type WindowsCommandResult = { ok: boolean; status: number | null; stdout: Uint8Array | string; stderr: string };
/** Runs one of the System32 tools by name (`schtasks`, `whoami`, `taskkill`); tests inject a table of replies. */
export type WindowsRun = (command: string, args: readonly string[]) => Promise<WindowsCommandResult>;

/** `schtasks` hangs when the Task Scheduler service is not running; past this a call counts as failed (I4a §4.3). */
export const WINDOWS_COMMAND_TIMEOUT_MS = 15_000;
/** One byte past the definition limit, so the reader can tell an oversized reply from a full one. */
const MAX_OUTPUT_BYTES = 1024 * 1024 + 1;

export const timeoutText = (command: string, args: readonly string[], ms: number): string =>
  `${command} ${args.join(' ')} 超时（${Math.round(ms / 1000)} 秒没有返回）`;

/**
 * Wraps a runner with the 15-second limit, for injected runners too; the real runner also kills the process at its own
 * limit. A timeout is a failed call whose stderr names the command and says 超时.
 */
export function withTimeout(run: WindowsRun, ms = WINDOWS_COMMAND_TIMEOUT_MS): WindowsRun {
  return (command, args) => new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, status: null, stdout: '', stderr: timeoutText(command, args, ms) }), ms);
    run(command, args).then(
      result => { clearTimeout(timer); resolve(result); },
      (error: unknown) => { clearTimeout(timer); resolve({ ok: false, status: null, stdout: '', stderr: `${command}: ${error instanceof Error ? error.message : String(error)}` }); },
    );
  });
}

/** The real runner: the tool from `%SystemRoot%\System32`, no console window, no shell. */
export function runWindowsCommand(command: string, args: readonly string[], timeoutMs = WINDOWS_COMMAND_TIMEOUT_MS): Promise<WindowsCommandResult> {
  const file = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', `${command}.exe`);
  return new Promise(resolve => {
    const child = spawn(file, [...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outSize = 0;
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (outSize >= MAX_OUTPUT_BYTES) return;
      out.push(chunk.subarray(0, MAX_OUTPUT_BYTES - outSize));
      outSize += Math.min(chunk.length, MAX_OUTPUT_BYTES - outSize);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (err.reduce((n, b) => n + b.length, 0) < 65_536) err.push(chunk); });
    child.once('error', error => { clearTimeout(timer); resolve({ ok: false, status: null, stdout: Buffer.concat(out), stderr: `${command}: ${error.message}` }); });
    child.once('close', code => {
      clearTimeout(timer);
      if (expired) { resolve({ ok: false, status: null, stdout: Buffer.concat(out), stderr: timeoutText(command, args, timeoutMs) }); return; }
      resolve({ ok: code === 0, status: code, stdout: Buffer.concat(out), stderr: decodeConsoleText(Buffer.concat(err)) });
    });
  });
}

/** A strict decoder, or undefined where this Node lacks the encoding (GB18030 needs full ICU). */
function decode(label: string, bytes: Uint8Array): string | undefined {
  let strict;
  try { strict = new TextDecoder(label, { fatal: true }); } catch { return undefined; }
  try { return strict.decode(bytes); } catch { return undefined; }
}

/**
 * Console tools write UTF-16 (with or without a BOM) or the console code page. Our own fields are ASCII; a byte order
 * mark or NULs between ASCII bytes mean UTF-16LE; otherwise valid UTF-8, then GB18030 (a Chinese console), then Latin-1.
 */
export function decodeConsoleText(input: Uint8Array | string): string {
  if (typeof input === 'string') return input;
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes.length >= 2 && bytes.length % 2 === 0 && bytes[1] === 0 && bytes[0] !== 0) return bytes.toString('utf16le');
  return decode('utf-8', bytes) ?? decode('gb18030', bytes) ?? bytes.toString('latin1');
}
