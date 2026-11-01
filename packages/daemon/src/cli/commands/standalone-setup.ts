import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { removePathBlock, startupFiles, writePathBlock } from '../../platform/shell-path';
import { switchCurrent, VERSION } from '../../service/current-release';
import { badArgs, CommandError } from '../command-error';
import type { Io } from '../daemon-client';

/**
 * The two hidden commands the install scripts call (server-2 4.3): `__standalone-setup` points `current` at a release,
 * writes the `bin/vonvon` launcher and the PATH block; `__standalone-teardown` takes the PATH block out again. They run
 * from the release itself before `current` points at it, so they do not ask what kind of distribution this is.
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
  // I4a writes the Windows launchers (bin\vonvon.cmd); until then nothing is switched there.
  if (d.platform === 'win32') throw new CommandError('failed', 'Windows 上的服务端安装还没有做好。', { reason: 'unsupported_platform' });
  let previous: string | null;
  // switchCurrent refuses a release without its standalone.json naming this version
  try { ({ previous } = await switchCurrent(installRoot, version, d.platform)); }
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
  const written = await writePathBlock(await startupFiles(d.home, d.zdotdir), bin);
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

/** Only the block that names this install root's `bin` is taken out; the desktop app's block stays. */
export async function runStandaloneTeardown(options: { installRoot: string }, io: Io, overrides: Partial<StandaloneDependencies> = {}): Promise<{ pathFiles: string[]; pathNote?: string }> {
  const d = { ...defaults(), ...overrides };
  if (!isAbsolute(options.installRoot)) throw badArgs(`--install-root 要是绝对路径：${options.installRoot}`);
  // On Windows the PATH is in the registry and the script edits it.
  const removed = d.platform === 'win32' ? { files: [], notes: [] } : await removePathBlock(await startupFiles(d.home, d.zdotdir), join(options.installRoot, 'bin'));
  const result = { pathFiles: removed.files, ...removed.notes.length ? { pathNote: removed.notes.join('；') } : {} };
  if (io.json) io.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  else io.write(`${removed.files.length ? `已从 ${removed.files.join('、')} 去掉 PATH` : '启动文件里没有服务端的 PATH'}\n${result.pathNote ? `${result.pathNote}\n` : ''}`);
  return result;
}
