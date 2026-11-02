import { readFile, readlink, rename, stat, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Which release of a standalone server is current (server-3 C5): `<installRoot>/current`, a relative symbolic link
 * `releases/<version>`, replaced by renaming `current.next` over it, so a crash leaves the old or the new link, never
 * neither. Only Linux has a standalone server (owner 2026-11-01). The install script (I2) and the update (I3) both
 * switch through here.
 */
export const VERSION = /^\d+\.\d+\.\d+$/;
const LINK = /^releases\/(\d+\.\d+\.\d+)$/;

export class ReleaseIncomplete extends Error {
  constructor(readonly version: string) { super(`releases/${version} is not a complete release`); }
}

const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export async function readCurrent(installRoot: string): Promise<{ version: string } | null> {
  try {
    const version = LINK.exec(await readlink(join(installRoot, 'current')))?.[1];
    return version ? { version } : null;
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

/** Points `current` at `releases/<version>`; returns the version it pointed at before. */
export async function switchCurrent(installRoot: string, version: string): Promise<{ previous: string | null }> {
  if (!(await isCompleteRelease(installRoot, version))) throw new ReleaseIncomplete(version);
  const before = await readCurrent(installRoot);
  const next = join(installRoot, 'current.next');
  await unlink(next).catch((error: unknown) => { if (!missing(error)) throw error; });
  await symlink(`releases/${version}`, next);
  await rename(next, join(installRoot, 'current'));
  return { previous: before?.version ?? null };
}

/** The Node and CLI entry of a release; the restart helper starts the current one through them. */
export function releaseCommand(installRoot: string, version: string): { node: string; entry: string } {
  const release = join(installRoot, 'releases', version);
  return { node: join(release, 'node', 'bin', 'node'), entry: join(release, 'app', 'bin', 'vonvon.mjs') };
}
