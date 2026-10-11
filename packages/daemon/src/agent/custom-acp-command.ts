import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { log } from '../core/logger';

export type CustomAcpCommand = [string, ...string[]] | null;
export type CustomAcpInvalidReason = 'unreadable' | 'not-json' | 'unsupported-version' | 'invalid-command';
export type CustomAcpCommandState =
  | { kind: 'unset' }
  | { kind: 'set'; command: [string, ...string[]] }
  | { kind: 'invalid'; file: string; reason: CustomAcpInvalidReason };

const reasonText: Record<CustomAcpInvalidReason, string> = {
  unreadable: '无法读取命令文件',
  'not-json': '命令文件不是有效 JSON',
  'unsupported-version': '命令文件版本不受支持',
  'invalid-command': '命令文件内容无效',
};
export function customAcpInvalidHint(state: Extract<CustomAcpCommandState, { kind: 'invalid' }>): string {
  return `自定义 ACP 命令文件无效：${state.file}（${reasonText[state.reason]}）。在主机设置 › 执行中重新保存，或修复或删除该文件，然后重启 Vonvon。`;
}

const commandSchema = z.custom<[string, ...string[]]>(value => {
  try { return parseCustomAcpCommand(value) !== null; }
  catch { return false; }
});
export const customAcpStateSchema: z.ZodType<CustomAcpCommandState> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('unset') }).strict(),
  z.object({ kind: z.literal('set'), command: commandSchema }).strict(),
  z.object({ kind: z.literal('invalid'), file: z.string().refine(file => file === join(paths.appDir, FILE_NAME)), reason: z.enum(['unreadable', 'not-json', 'unsupported-version', 'invalid-command']) }).strict(),
]);

class CustomAcpFileError extends Error {
  constructor(readonly file: string, readonly reason: CustomAcpInvalidReason) {
    super(`自定义 ACP 命令配置无效：${file}（${reasonText[reason]}）`);
  }
}

const FILE_NAME = 'custom-acp.json';
const UNSAFE_CHARACTER = /[\0\r\n]/;
const PATH_SEPARATOR = /[\\/]/;

export function parseCustomAcpCommand(value: unknown): CustomAcpCommand {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 ||
      !value.every((part): part is string =>
        typeof part === 'string' && part.length >= 1 && part.length <= 4096 &&
        !UNSAFE_CHARACTER.test(part))) {
    throw new Error('自定义 ACP 命令必须包含 1 到 64 个有效参数。');
  }
  const [binary, ...args] = value;
  if (binary === undefined) throw new Error('自定义 ACP 命令不能为空。');
  if (!isAbsolute(binary) && PATH_SEPARATOR.test(binary)) {
    throw new Error('自定义 ACP 可执行文件必须是绝对路径或不含路径分隔符的命令名。');
  }
  return [binary, ...args];
}

export function readCustomAcpCommand(appDir: string = paths.appDir): CustomAcpCommand {
  const file = join(appDir, FILE_NAME);
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw new CustomAcpFileError(file, 'unreadable');
  }
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    throw new CustomAcpFileError(file, 'not-json');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      !('version' in record) || record.version !== 1 ||
      !('command' in record) || Object.keys(record).length !== 2) {
    throw new CustomAcpFileError(file, record && typeof record === 'object' && 'version' in record && record.version !== 1 ? 'unsupported-version' : 'invalid-command');
  }
  try {
    return parseCustomAcpCommand(record.command);
  } catch {
    throw new CustomAcpFileError(file, 'invalid-command');
  }
}

export function resolveCustomAcpCommand(appDir: string): CustomAcpCommandState {
  try {
    const command = readCustomAcpCommand(appDir);
    return command ? { kind: 'set', command } : { kind: 'unset' };
  } catch (error) {
    return { kind: 'invalid', file: join(appDir, FILE_NAME), reason: error instanceof CustomAcpFileError ? error.reason : 'unreadable' };
  }
}

let captured: CustomAcpCommandState | undefined;
let initializing: Promise<CustomAcpCommandState> | undefined;
const HANDSHAKE_ERROR = '未收到主进程的自定义 ACP 设置';

function record(state: CustomAcpCommandState): CustomAcpCommandState {
  captured = state;
  if (!process.send) log.info('custom-acp', 'custom-acp-init', state.kind === 'invalid'
    ? { state: state.kind, file: state.file, reason: state.reason }
    : { state: state.kind });
  return state;
}

export function initCustomAcpCommand(): Promise<CustomAcpCommandState> {
  if (captured) return Promise.resolve(captured);
  if (initializing) return initializing;
  if (!process.send) return initializing = Promise.resolve(record(resolveCustomAcpCommand(paths.appDir)));
  initializing = new Promise<CustomAcpCommandState>((resolve, reject) => {
    const fail = (): void => { cleanup(); reject(new Error(HANDSHAKE_ERROR)); };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== 'object' || !('fcb' in message) || message.fcb !== 'fcb.custom-acp') return;
      const parsed = z.object({ fcb: z.literal('fcb.custom-acp'), state: customAcpStateSchema }).strict().safeParse(message);
      if (!parsed.success) return fail();
      cleanup(); resolve(record(parsed.data.state));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      process.off('message', onMessage);
      process.off('disconnect', fail);
    };
    const timeout = setTimeout(fail, 10_000);
    process.on('message', onMessage);
    process.on('disconnect', fail);
    try { process.send?.({ fcb: 'fcb.custom-acp.req' }, (error: Error | null) => { if (error) fail(); }); }
    catch { fail(); }
  });
  return initializing;
}

export function customAcpCommand(): CustomAcpCommandState {
  if (captured) return captured;
  if (process.send) throw new Error('自定义 ACP 命令尚未初始化');
  return record(resolveCustomAcpCommand(paths.appDir));
}

export function saveCustomAcpCommand(value: unknown, appDir: string = paths.appDir): void {
  const command = parseCustomAcpCommand(value);
  mkdirSync(appDir, { recursive: true });
  const file = join(appDir, FILE_NAME);
  const temporary = file + '.tmp-' + process.pid + '-' + randomUUID();
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, command }) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the write error. */ }
  }
}
