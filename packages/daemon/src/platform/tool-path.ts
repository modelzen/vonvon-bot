import { delimiter, join } from 'node:path';

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
  const entries = (path ?? '').split(delimiter).filter(Boolean);
  for (const directory of toolDirectories(home, platform)) if (!entries.includes(directory)) entries.push(directory);
  return entries.join(delimiter);
}
