import { readFile, readlink, rename, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Which release of a standalone server is current (server-3 C5). POSIX: `<installRoot>/current`, a relative symbolic
 * link `releases/<version>`, replaced by renaming `current.next` over it. Windows: `current.txt`, two lines, the current
 * version and the previous one, replaced by renaming `current.txt.tmp` over it. Either way a crash leaves the old or the
 * new pointer, never neither. The install script (I2) and the update (I3) both switch through here.
 */
export const VERSION = /^\d+\.\d+\.\d+$/;
const LINK = /^releases\/(\d+\.\d+\.\d+)$/;

export class ReleaseIncomplete extends Error {
  constructor(readonly version: string) { super(`releases/${version} is not a complete release`); }
}

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export async function readCurrent(installRoot: string, platform: NodeJS.Platform = process.platform): Promise<{ version: string; previous?: string } | null> {
  try {
    if (platform !== 'win32') {
      const version = LINK.exec(await readlink(join(installRoot, 'current')))?.[1];
      return version ? { version } : null;
    }
    const [version = '', previous = ''] = (await readFile(join(installRoot, 'current.txt'), 'utf8')).split('\n');
    if (!VERSION.test(version)) return null;
    return VERSION.test(previous) ? { version, previous } : { version };
  } catch (error) {
    // EINVAL: `current` is there but is not a link, which no install of ours makes.
    if (missing(error) || (error instanceof Error && 'code' in error && error.code === 'EINVAL')) return null;
    throw error;
  }
}

/** A release directory with its `standalone.json` naming `version`. */
export async function isCompleteRelease(installRoot: string, version: string): Promise<boolean> {
  if (!VERSION.test(version)) return false;
  try {
    const file = join(installRoot, 'releases', version, 'standalone.json');
    if (!(await stat(file)).isFile()) return false;
    return (JSON.parse(await readFile(file, 'utf8')) as { version?: unknown }).version === version;
  } catch { return false; }
}

/**
 * Points `current` at `releases/<version>`; returns the version it pointed at before. On Windows the second line of
 * `current.txt` is the release to fall back to: `previous` when the caller knows it (an update names the release
 * running now), else what `current` named before, unless that is `version` itself.
 */
export async function switchCurrent(installRoot: string, version: string, platform: NodeJS.Platform = process.platform, previous?: string): Promise<{ previous: string | null }> {
  if (!(await isCompleteRelease(installRoot, version))) throw new ReleaseIncomplete(version);
  const before = await readCurrent(installRoot, platform);
  if (platform === 'win32') {
    const file = join(installRoot, 'current.txt');
    const fallback = previous ?? (before && before.version !== version ? before.version : before?.previous) ?? '';
    await writeFile(`${file}.tmp`, `${version}\n${fallback}\n`);
    await rename(`${file}.tmp`, file);
  } else {
    const next = join(installRoot, 'current.next');
    await unlink(next).catch((error: unknown) => { if (!missing(error)) throw error; });
    await symlink(`releases/${version}`, next);
    await rename(next, join(installRoot, 'current'));
  }
  return { previous: before?.version ?? null };
}

/** The Node and CLI entry of a release; the restart helper starts the current one through them. */
export function releaseCommand(installRoot: string, version: string, platform: NodeJS.Platform = process.platform): { node: string; entry: string } {
  const release = join(installRoot, 'releases', version);
  return { node: join(release, 'node', platform === 'win32' ? 'node.exe' : join('bin', 'node')), entry: join(release, 'app', 'bin', 'vonvon.mjs') };
}
