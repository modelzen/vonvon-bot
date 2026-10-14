import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/**
 * Where Homebrew, the official Node installer and user-level installs put command-line tools.
 * An app opened from Finder, and a launchd service, get only `/usr/bin:/bin:/usr/sbin:/sbin`,
 * so Codex and the `node` its npm launcher needs are found here. No login shell is run: it
 * could hang on the user's interactive startup files.
 */
export function toolDirectories(home: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return [];
  const directories = ['/usr/local/bin', join(home, '.local', 'bin')];
  return platform === 'darwin' ? ['/opt/homebrew/bin', ...directories] : directories;
}

/** `path` with the {@link toolDirectories} that it lacks appended, so the user's own order wins. */
export function withToolDirectories(path: string | undefined, home: string, platform: NodeJS.Platform = process.platform): string {
  return appendDirectories(path, toolDirectories(home, platform));
}

/**
 * PATH for a child started from `bin`: `path` plus `bin`'s own directory and the
 * {@link toolDirectories}, appended where missing. An npm launcher such as nvm's `codex`
 * starts with `#!/usr/bin/env node`, and the `node` it needs sits next to it, which an
 * app opened from Finder does not have on PATH. `bin` is used as given, not resolved:
 * the symlink's directory is the one that holds `node`.
 */
export function withBinDirectory(bin: string, path: string | undefined = process.env.PATH, home: string = homedir(), platform: NodeJS.Platform = process.platform): string {
  return appendDirectories(path, [...(isAbsolute(bin) ? [dirname(bin)] : []), ...toolDirectories(home, platform)]);
}

function appendDirectories(path: string | undefined, directories: string[]): string {
  const entries = (path ?? '').split(delimiter).filter(Boolean);
  for (const directory of directories) if (!entries.includes(directory)) entries.push(directory);
  return entries.join(delimiter);
}
