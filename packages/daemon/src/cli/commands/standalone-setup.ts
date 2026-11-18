import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { everyStartupFile, removePathBlock, startupFiles, writePathBlock, type AddedBreaks } from '../../platform/shell-path';
import { switchCurrent, VERSION } from '../../service/current-release';
import { badArgs, CommandError } from '../command-error';
import type { Io } from '../daemon-client';

/**
 * The two hidden commands the Linux install scripts call (server-2 4.3): `__standalone-setup` points `current` at a
 * release, writes the `bin/vonvon` launcher and the PATH block; `__standalone-teardown` takes the PATH block out again.
 * They run from the release itself before `current` points at it, so they do not ask what kind of distribution this is.
 */
export const SERVER_CLI_MARKER = '# Vonvon Bot server CLI v1';
/** Follows `current` at every run: it resolves `bin/..`, not `current`, so a switched `current` takes effect at once. */
export const SERVER_LAUNCHER = `#!/bin/sh
${SERVER_CLI_MARKER}
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
PATH="$root/current/node/bin:$PATH"
export PATH
exec "$root/current/node/bin/node" "$root/current/app/bin/vonvon.mjs" "$@"
`;

export type StandaloneDependencies = { platform: NodeJS.Platform; home: string; zdotdir: string | undefined; path: string | undefined };
const defaults = (): StandaloneDependencies => ({ platform: process.platform, home: homedir(), zdotdir: process.env.ZDOTDIR, path: process.env.PATH });
const detailOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

export type StandaloneSetupResult = {
  version: string; previous: string | null; launcher: string; pathFiles: string[]; pathAlreadyOnPath: boolean; pathNote?: string;
};

/**
 * What setup did to the startup files, for teardown: every file it put the PATH block in, across runs, the line breaks
 * it put before the block (shell-path `AddedBreaks`), and each `bin` path the block named. The block names the install
 * root as setup was given it, which is the home as it was then: a home reached through a link at one run and by its
 * real path at another gives two texts for one install root. Kept in the install root, which uninstall deletes after
 * teardown.
 */
type PathRecord = { files: string[]; breaks: AddedBreaks; bins: string[] };
const recordFile = (installRoot: string): string => join(installRoot, 'path-block.json');
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Nothing recorded, or a record that cannot be read: teardown then looks only in the files that could hold the block
 * now, and keeps those line breaks.
 */
async function readRecord(installRoot: string): Promise<PathRecord> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(recordFile(installRoot), 'utf8')); }
  catch { return { files: [], breaks: {}, bins: [] }; }
  if (!isRecord(parsed)) return { files: [], breaks: {}, bins: [] };
  const paths = (value: unknown): string[] => Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && isAbsolute(path)) : [];
  return {
    files: paths(parsed.files),
    breaks: isRecord(parsed.breaks) ? Object.fromEntries(Object.entries(parsed.breaks).filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && Number(entry[1]) >= 0)) : {},
    bins: paths(parsed.bins),
  };
}

async function checkedRoot(installRoot: string): Promise<void> {
  if (!isAbsolute(installRoot)) throw badArgs(`--install-root 要是绝对路径：${installRoot}`);
  const info = await stat(installRoot).catch(() => null);
  if (!info?.isDirectory()) throw badArgs(`安装根不存在：${installRoot}`);
}

export async function runStandaloneSetup(options: { installRoot: string; version: string }, io: Io, overrides: Partial<StandaloneDependencies> = {}): Promise<StandaloneSetupResult> {
  const d = { ...defaults(), ...overrides };
  const { installRoot, version } = options;
  await checkedRoot(installRoot);
  if (!VERSION.test(version)) throw badArgs(`版本号不对：${version}`);
  // Only Linux has a script-installed server (owner 2026-11-01): Mac and Windows get theirs inside the desktop app.
  if (d.platform !== 'linux') throw new CommandError('failed', '只有 Linux 用安装脚本装服务端；Mac、Windows 请下载安装包：https://vonvon.bot/get/', { reason: 'unsupported_platform' });
  let previous: string | null;
  // switchCurrent refuses a release without its standalone.json naming this version
  try { ({ previous } = await switchCurrent(installRoot, version)); }
  catch (error) { throw new CommandError('failed', `没切成 ${version}：${detailOf(error)}`, { reason: 'release_incomplete' }); }
  const bin = join(installRoot, 'bin');
  const launcher = join(bin, 'vonvon');
  try {
    await mkdir(bin, { recursive: true, mode: 0o755 });
    await writeFile(`${launcher}.tmp`, SERVER_LAUNCHER, { mode: 0o755 });
    await chmod(`${launcher}.tmp`, 0o755);
    await rename(`${launcher}.tmp`, launcher);
  } catch (error) {
    // `current` is switched already: running the script again reuses the release and comes back here
    throw new CommandError('failed', `写不了 ${launcher}：${detailOf(error)}`, { reason: 'launcher_write_failed' });
  }
  const record = await readRecord(installRoot);
  const recorded = JSON.stringify(record);
  const written = await writePathBlock(await startupFiles(d.home, d.zdotdir), bin, record.breaks);
  for (const file of written.files) if (!record.files.includes(file)) record.files.push(file);
  if (written.files.length && !record.bins.includes(bin)) record.bins.push(bin);
  if (JSON.stringify(record) !== recorded) {
    const file = recordFile(installRoot);
    try { await writeFile(`${file}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o644 }); await rename(`${file}.tmp`, file); }
    catch (error) {
      // without it uninstall leaves one line break at the end of these files
      const breaks = Object.keys(record.breaks);
      written.notes.push(`${file} 没写进去：${detailOf(error)}${breaks.length ? `，卸载后 ${breaks.join('、')} 末尾会多一个换行` : ''}`);
    }
  }
  const result: StandaloneSetupResult = {
    version, previous, launcher, pathFiles: written.files, pathAlreadyOnPath: (d.path ?? '').split(':').includes(bin),
    ...written.notes.length ? { pathNote: written.notes.join('；') } : {},
  };
  if (io.json) io.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  else {
    io.write([
      `已切到 ${version}${previous ? `（之前是 ${previous}）` : ''}。`,
      `命令：${launcher}`,
      written.files.length ? `PATH 写进了 ${written.files.join('、')}` : 'PATH 没写进任何启动文件',
      ...result.pathNote ? [result.pathNote] : [],
    ].join('\n') + '\n');
  }
  return result;
}

/**
 * Only the blocks that name this install root's `bin` are taken out; the desktop app's block stays. Its `bin` is each
 * path setup recorded, the one given now and the one under the install root's real path: the home may have been
 * reached through a link at setup and not now, or the other way round. The block is looked for in every file that
 * could hold it now and every file setup recorded, not only in the files setup would pick today.
 */
export async function runStandaloneTeardown(options: { installRoot: string }, io: Io, overrides: Partial<StandaloneDependencies> = {}): Promise<{ pathFiles: string[]; pathNote?: string }> {
  const d = { ...defaults(), ...overrides };
  if (!isAbsolute(options.installRoot)) throw badArgs(`--install-root 要是绝对路径：${options.installRoot}`);
  const record = await readRecord(options.installRoot);
  const files = [...new Set([...everyStartupFile(d.home, d.zdotdir), ...record.files])];
  const bin = join(options.installRoot, 'bin');
  // the install root's real path, not `bin`'s: a `bin` that is a link names some other directory
  const realBin = await realpath(options.installRoot).then(root => join(root, 'bin'), () => bin);
  const removed = await removePathBlock(files, [...new Set([...record.bins, bin, realBin])], record.breaks);
  const result = { pathFiles: removed.files, ...removed.notes.length ? { pathNote: removed.notes.join('；') } : {} };
  if (io.json) io.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  else io.write(`${removed.files.length ? `已从 ${removed.files.join('、')} 去掉 PATH` : '启动文件里没有服务端的 PATH'}\n${result.pathNote ? `${result.pathNote}\n` : ''}`);
  return result;
}
