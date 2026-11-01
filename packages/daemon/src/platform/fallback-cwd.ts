import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyDistribution, nearestPackageRoot } from '../service/distribution';
import { pathFor } from './home-path';

/** The folder this daemon was installed in: the standalone install root, the app around the desktop's Resources/daemon, or the package itself. */
export function ownInstallDirectory(root = nearestPackageRoot(fileURLToPath(import.meta.url))): string {
  const distribution = classifyDistribution(root);
  if (distribution.kind === 'standalone') return distribution.installRoot;
  const packageRoot = dirname(dirname(distribution.cliPath));
  return distribution.kind === 'bundled' ? dirname(dirname(packageRoot)) : packageRoot;
}

export type FallbackInput = { env?: NodeJS.ProcessEnv; cwd?: string; home?: string; platform?: NodeJS.Platform; installDirectory?: string };

/**
 * Where a session runs when nothing names a folder (`runtime.fallbackCwd`): `FEISHU_CODEX_CWD` when set, otherwise the
 * folder the daemon was started in, but only when a person could have meant it. A service starts in `/` (launchd), the
 * Windows scheduled task in `C:\Windows\System32`, and a daemon started from inside its own install folder would hand
 * the product's files to its sessions; those, and a working folder that is gone, give the home folder instead
 * (Windows acceptance task 205).
 */
export function fallbackWorkingDirectory(input: FallbackInput = {}): string {
  const env = input.env ?? process.env;
  if (env.FEISHU_CODEX_CWD) return env.FEISHU_CODEX_CWD;
  const platform = input.platform ?? process.platform;
  const path = pathFor(platform);
  const home = input.home ?? homedir();
  let cwd: string;
  try { cwd = path.resolve(input.cwd ?? process.cwd()); } catch { return home; }
  // path.win32.relative compares without case, as Windows does.
  const inside = (parent: string): boolean => {
    const rel = path.relative(path.resolve(parent), cwd);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  };
  const systemRoot = platform === 'win32' ? env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? 'C:\\Windows' : undefined;
  if (path.parse(cwd).root === cwd || (systemRoot && inside(systemRoot)) || inside(input.installDirectory ?? ownInstallDirectory())) return home;
  return cwd;
}
