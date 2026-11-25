import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { managedToolSelection } from '../agent/codex-appserver/managed-tools';
import { paths } from '../config/paths';
import { pathFor } from './home-path';
import { toolDirectories } from './tool-path';

export interface ResolveLarkCliOptions {
  dataRoot?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

function isRunnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function candidatesInDir(dir: string, platform: NodeJS.Platform): string[] {
  if (!dir) return [];
  const p = pathFor(platform);
  return platform === 'win32'
    ? [p.join(dir, 'lark-cli.cmd'), p.join(dir, 'lark-cli.exe'), p.join(dir, 'lark-cli')]
    : [p.join(dir, 'lark-cli')];
}

/**
 * Resolve the user's `lark-cli` executable without spawning a login shell:
 * 1. Vonvon's managed install (`vonvon env install lark-cli`),
 * 2. Current `PATH`,
 * 3. Common user/version-manager bins (NVM, Volta, fnm, asdf, Bun, Homebrew, `/usr/local/bin`, `~/.local/bin`).
 */
export function resolveLarkCliBin(opts: ResolveLarkCliOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const root = opts.dataRoot ?? paths?.appDir;
  const p = pathFor(platform);

  const explicit = env.VONVON_LARK_CLI?.trim();
  if (explicit && isRunnableFile(explicit, platform)) return explicit;

  const managed = root ? managedToolSelection(root, 'lark-cli', platform) : { kind: 'absent' as const };
  if (managed.kind === 'active' && isRunnableFile(managed.executable, platform)) {
    return managed.executable;
  }

  const dirs: string[] = [];
  const rawPath = env.PATH ?? env.Path ?? env.path ?? '';
  for (const entry of rawPath.split(p.delimiter).filter(Boolean)) {
    dirs.push(entry.replace(/^"|"$/g, ''));
  }

  if (platform !== 'win32') {
    try {
      const nvmRoot = join(home, '.nvm', 'versions', 'node');
      const versions = readdirSync(nvmRoot)
        .filter(v => /^v\d+\.\d+\.\d+/.test(v))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) dirs.push(join(nvmRoot, version, 'bin'));
    } catch {
      // No NVM installed.
    }
    if (env.VOLTA_HOME) dirs.push(join(env.VOLTA_HOME, 'bin'));
    dirs.push(
      join(home, '.volta', 'bin'),
      join(home, '.fnm', 'aliases', 'default', 'bin'),
      join(home, '.asdf', 'shims'),
      join(home, '.bun', 'bin'),
      join(home, '.lark-cli', 'bin'),
      ...toolDirectories(home, platform),
    );
  } else {
    if (env.NVM_SYMLINK) dirs.push(env.NVM_SYMLINK);
    if (env.VOLTA_HOME) dirs.push(p.join(env.VOLTA_HOME, 'bin'));
    dirs.push(
      p.join(env.APPDATA ?? p.join(home, 'AppData', 'Roaming'), 'npm'),
      p.join(home, '.local', 'bin'),
      p.join(home, 'scoop', 'shims'),
    );
  }

  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const candidate of candidatesInDir(dir, platform)) {
      if (isRunnableFile(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

/**
 * Append `lark-cli`'s directory to the Bot process PATH (if not already present) so child Codex/Claude
 * shells inherit both `lark-cli` and its sibling `node` runtime (e.g. under NVM) without shadowing
 * user-preferred earlier PATH entries.
 */
export function appendLarkCliToPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): void {
  const { delimiter, dirname } = pathFor(platform);
  const key = platform === 'win32'
    ? Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'Path'
    : 'PATH';
  const dir = dirname(bin);
  const current = (env[key] ?? '').split(delimiter).filter(Boolean);
  if (!current.includes(dir)) {
    env[key] = [...current, dir].join(delimiter);
  }
}
