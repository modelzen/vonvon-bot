import { posix, win32 } from 'node:path';

/** The path functions of `platform`, so code given another platform answers as that platform would on any host. */
export const pathFor = (platform: NodeJS.Platform = process.platform): typeof posix => platform === 'win32' ? win32 : posix;

/**
 * Whether a typed path starts at the home directory: `~` and `~/…` everywhere, and `~\…` on Windows, where `\` is the
 * separator people type (Windows acceptance task 205). `~user` and, outside Windows, `~\x` are ordinary names.
 * The directory worker in server/directory-suggestions.ts repeats this rule; keep the two the same.
 */
export function isHomeRelative(value: string, platform: NodeJS.Platform = process.platform): boolean {
  return value === '~' || value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'));
}

/** `value` with its leading {@link isHomeRelative} `~` turned into `home`; any other value as it is. */
export function expandHome(value: string, home: string, platform: NodeJS.Platform = process.platform): string {
  return isHomeRelative(value, platform) ? pathFor(platform).join(home, value.slice(1)) : value;
}
