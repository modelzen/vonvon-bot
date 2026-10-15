import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { posix } from 'node:path';

export const LAUNCHD_LABEL = 'com.vonvon.bot.daemon';
export const SYSTEMD_UNIT_NAME = 'vonvon-bot.service';

declare const canonicalRoot: unique symbol;
export type CanonicalRoot = string & { readonly [canonicalRoot]: true };

export type Target =
  | { platform: 'darwin'; label: string; plistPath: string }
  | { platform: 'linux'; unitName: string; unitPath: string };

export async function resolveServiceRoot(path: string): Promise<CanonicalRoot> {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error(`Service root is not a directory: ${root}`);
  return root as CanonicalRoot;
}

/** The real path, resolving the nearest existing ancestor of a path not created yet, as `resolveDataRoot` does. */
function canonical(path: string): string {
  try { return realpathSync(path); }
  catch {
    const parent = posix.dirname(path);
    return parent === path ? path : posix.join(canonical(parent), posix.basename(path));
  }
}

/**
 * The service name for a data root. The default root `~/.vonvon-bot` keeps the
 * fixed names; any other `VONVON_HOME` gets names suffixed with a hash of its
 * canonical path, so a test or second install never replaces the user's service.
 */
export function serviceName(platform: 'darwin' | 'linux', root: string, home: string): string {
  const fixed = canonical(root) === canonical(posix.join(canonical(home), '.vonvon-bot'));
  const suffix = fixed ? '' : createHash('sha256').update(canonical(root)).digest('hex').slice(0, 12);
  if (platform === 'darwin') return suffix ? `${LAUNCHD_LABEL}.${suffix}` : LAUNCHD_LABEL;
  return suffix ? `vonvon-bot-${suffix}.service` : SYSTEMD_UNIT_NAME;
}

export function serviceTarget(input:
  | { platform: 'darwin'; home: string; root: string }
  | { platform: 'linux'; home: string; root: string; xdgConfigHome: string | undefined }
): Target {
  const name = serviceName(input.platform, input.root, input.home);
  switch (input.platform) {
    case 'darwin':
      if (!posix.isAbsolute(input.home)) throw new Error('Home must be absolute');
      return { platform: input.platform, label: name, plistPath: posix.join(input.home, 'Library/LaunchAgents', `${name}.plist`) };
    case 'linux': {
      const config = input.xdgConfigHome || posix.join(input.home, '.config');
      if (!posix.isAbsolute(config)) throw new Error('Config home must be absolute');
      return { platform: input.platform, unitName: name, unitPath: posix.join(config, 'systemd/user', name) };
    }
  }
}
