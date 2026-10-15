import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';

export const LAUNCHD_LABEL = 'com.vonvon.bot.daemon';
export const SYSTEMD_UNIT_NAME = 'vonvon-bot.service';

declare const canonicalRoot: unique symbol;
export type CanonicalRoot = string & { readonly [canonicalRoot]: true };

export type Target =
  | { platform: 'darwin'; plistPath: string }
  | { platform: 'linux'; unitPath: string };

export async function resolveServiceRoot(path: string): Promise<CanonicalRoot> {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error(`Service root is not a directory: ${root}`);
  return root as CanonicalRoot;
}

export function serviceTarget(input:
  | { platform: 'darwin'; home: string }
  | { platform: 'linux'; home: string; xdgConfigHome: string | undefined }
): Target {
  switch (input.platform) {
    case 'darwin':
      if (!posix.isAbsolute(input.home)) throw new Error('Home must be absolute');
      return { platform: input.platform, plistPath: posix.join(input.home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`) };
    case 'linux': {
      const config = input.xdgConfigHome || posix.join(input.home, '.config');
      if (!posix.isAbsolute(config)) throw new Error('Config home must be absolute');
      return { platform: input.platform, unitPath: posix.join(config, 'systemd/user', SYSTEMD_UNIT_NAME) };
    }
  }
}
