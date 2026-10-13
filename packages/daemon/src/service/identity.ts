import { realpath, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

export const LAUNCHD_LABEL = 'com.vonvon.bot.daemon';
export const SYSTEMD_UNIT_NAME = 'vonvon-bot.service';
export const WINDOWS_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const WINDOWS_RUN_VALUE = 'Vonvon Bot';
export const WINDOWS_CMD_NAME = 'vonvon-bot.cmd';
export const WINDOWS_VBS_NAME = 'vonvon-bot.vbs';

declare const canonicalRoot: unique symbol;
export type CanonicalRoot = string & { readonly [canonicalRoot]: true };

export type Target =
  | { platform: 'darwin'; plistPath: string }
  | { platform: 'linux'; unitPath: string }
  | { platform: 'win32'; cmdPath: string; vbsPath: string };

export async function resolveServiceRoot(path: string): Promise<CanonicalRoot> {
  const root = await realpath(path);
  if (!(await stat(root)).isDirectory()) throw new Error(`Service root is not a directory: ${root}`);
  return root as CanonicalRoot;
}

export function serviceTarget(input:
  | { platform: 'darwin'; home: string }
  | { platform: 'linux'; home: string; xdgConfigHome: string | undefined }
  | { platform: 'win32'; root: CanonicalRoot }
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
    case 'win32':
      if (!win32.isAbsolute(input.root)) throw new Error('Root must be absolute');
      return { platform: input.platform, cmdPath: win32.join(input.root, 'service', WINDOWS_CMD_NAME), vbsPath: win32.join(input.root, 'service', WINDOWS_VBS_NAME) };
  }
}
