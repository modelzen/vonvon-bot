import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { CLI_PATH_BLOCK_BEGIN, CLI_PATH_BLOCK_END, shellStartupFiles, spliceBlock, startupBlock } from '@vonvon/protocol';
import { classifyDistribution } from '../../daemon/src/service/distribution.js';

export type CliRegistration = { kind: 'ready'; bin: string; message: string } | { kind: 'error'; message: string };
export interface CliRegistrationOptions {
  platform: NodeJS.Platform;
  home: string;
  executable: string;
  resources: string;
  packaged: boolean;
  zdotdir?: string;
}

const marker = 'Vonvon Bot managed CLI v1';

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function location(options: CliRegistrationOptions): { bin: string; wrapper: string; cli: string } {
  const bin = join(options.home, '.local', 'share', 'vonvon-bot', 'bin');
  return { bin, wrapper: join(bin, 'vonvon'), cli: join(options.resources, 'daemon', 'bin', 'vonvon.mjs') };
}

function wrapperBody(options: CliRegistrationOptions, cli: string): string {
  return `#!/bin/sh\n# ${marker}\nELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE\nexec ${quote(options.executable)} ${quote(cli)} "$@"\n`;
}

async function regularText(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`不是普通文件，未覆盖：${path}`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function startupPaths(options: CliRegistrationOptions): Promise<string[]> {
  const exists = async (path: string): Promise<boolean> => {
    try { await lstat(path); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  };
  return shellStartupFiles(options.home, { ...(options.zdotdir ? { zdotdir: options.zdotdir } : {}), exists });
}

/** The block and its splicing are shared with the Linux server's setup (protocol `cli-path-block`); a half-written one is not touched. */
function updatedStartup(before: string, bin: string, path: string): string {
  const start = before.indexOf(CLI_PATH_BLOCK_BEGIN);
  const finish = before.indexOf(CLI_PATH_BLOCK_END);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error(`CLI PATH 标记不完整：${path}`);
  return spliceBlock(before, startupBlock(bin));
}

async function validateDistribution(options: CliRegistrationOptions, cli: string): Promise<void> {
  if (!options.packaged) throw new Error('开发版本无法注册命令行工具。');
  if (options.platform !== 'darwin') throw new Error(`不支持的平台：${options.platform}`);
  if (classifyDistribution(join(options.resources, 'daemon')).kind !== 'bundled') throw new Error('桌面版未包含有效的 Vonvon Bot 命令行分发。');
  if (!(await stat(options.executable)).isFile() || !(await stat(cli)).isFile()) throw new Error('桌面命令行程序不是普通文件。');
}

export async function observeCli(options: CliRegistrationOptions): Promise<CliRegistration> {
  try {
    const { bin, wrapper, cli } = location(options);
    await validateDistribution(options, cli);
    const actual = await regularText(wrapper);
    if (actual !== wrapperBody(options, cli)) throw new Error(actual === undefined ? '命令行工具尚未注册。' : `现有命令行入口不属于当前桌面版：${wrapper}`);
    const info = await lstat(wrapper);
    if ((info.mode & 0o111) === 0) throw new Error('命令行入口没有执行权限。');
    for (const path of await startupPaths(options)) {
      const content = await regularText(path);
      if (content === undefined || !content.includes(startupBlock(bin))) throw new Error(`终端 PATH 尚未注册：${path}`);
    }
    return { kind: 'ready', bin, message: '命令行工具已安装。请打开新的终端使用 vonvon。' };
  } catch (error) { return { kind: 'error', message: errorMessage(error) }; }
}

export async function registerCli(options: CliRegistrationOptions): Promise<CliRegistration> {
  try {
    const { bin, wrapper, cli } = location(options);
    await validateDistribution(options, cli);
    const body = wrapperBody(options, cli);
    const prior = await regularText(wrapper);
    if (prior !== undefined && !prior.includes(marker)) throw new Error(`发现其他程序的文件，未覆盖：${wrapper}`);
    const startup = await Promise.all((await startupPaths(options)).map(async path => ({ path, before: await regularText(path) ?? '' })));
    const updates = startup.map(({ path, before }) => ({ path, before, after: updatedStartup(before, bin, path) }));
    await mkdir(bin, { recursive: true });
    if (prior !== body) {
      const temporary = `${wrapper}.${process.pid}.tmp`;
      try { await writeFile(temporary, body, { flag: 'wx', mode: 0o755 }); await rename(temporary, wrapper); }
      finally { await rm(temporary, { force: true }); }
    }
    await chmod(wrapper, 0o755);
    for (const { path, before, after } of updates) if (after !== before) await writeFile(path, after);
    return await observeCli(options);
  } catch (error) { return { kind: 'error', message: errorMessage(error) }; }
}

export function desktopCliOptions(options: Pick<CliRegistrationOptions, 'platform' | 'executable' | 'resources' | 'packaged'>): CliRegistrationOptions {
  const home = homedir();
  const zdotdir = process.env.ZDOTDIR;
  return { ...options, home, ...(options.platform === 'darwin' && zdotdir && isAbsolute(zdotdir) ? { zdotdir } : {}) };
}
