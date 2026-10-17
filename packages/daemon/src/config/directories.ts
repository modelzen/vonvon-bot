import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { spawnProcess } from '../platform/spawn';

const AbsolutePathSchema = z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'));
export const WorkspacesSchema = z.strictObject({
  primary: AbsolutePathSchema,
  additional: z.array(AbsolutePathSchema),
});
export const DirectoriesSchema = z.strictObject({
  workspaces: WorkspacesSchema.optional(),
  repositories: z.array(AbsolutePathSchema).optional(),
});
export type DirectorySettings = z.infer<typeof DirectoriesSchema>;

/** Validate only the owned block, never strip the surrounding legacy document. */
export function parseDirectorySettings(raw: unknown): DirectorySettings | undefined {
  if (raw === undefined) return undefined;
  const result = DirectoriesSchema.safeParse(raw);
  if (result.success) return result.data;
  const known = new Set(['workspaces', 'primary', 'additional', 'repositories']);
  const locations = [...new Set(result.error.issues.map(issue =>
    ['directories', ...issue.path.filter(part => typeof part === 'string' && known.has(part))].join('.'),
  ))];
  throw new Error(`Invalid directory settings: ${locations.join(', ')}`);
}

export function configDirectories(config: unknown): DirectorySettings | undefined {
  if (typeof config !== 'object' || config === null || !('preferences' in config)) return undefined;
  const preferences = config.preferences;
  if (typeof preferences !== 'object' || preferences === null || !('directories' in preferences)) return undefined;
  return parseDirectorySettings(preferences.directories);
}

function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve a not-yet-created data directory without creating it. */
async function prospectiveRealpath(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Invalid directory policy');
    return canonical;
  }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    // A dangling symlink is not an absent suffix we can append lexically.
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Invalid directory policy'); }
    catch (entryError) {
      if (!(entryError instanceof Error && 'code' in entryError && entryError.code === 'ENOENT')) throw entryError;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    const resolvedParent = await prospectiveRealpath(parent);
    return join(resolvedParent, relative(parent, path));
  }
}

class GitCleanupError extends Error {
  constructor() { super('Invalid directory settings: directories.repositories (Git cleanup failed)'); }
}

async function assertGitRoot(path: string): Promise<void> {
  // Git's repository/config environment must not substitute another checkout.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  try {
    const metadata = await stat(join(path, '.git'));
    if (!metadata.isDirectory() && !metadata.isFile()) throw new Error('not checkout metadata');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawnProcess('git', ['--no-optional-locks', '-C', path, '-c', 'core.fsmonitor=false', 'rev-parse', '--show-toplevel'], {
        env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      let output = '';
      let settled = false;
      const finish = (failed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        let cleanupError: GitCleanupError | undefined;
        if (child.pid !== undefined) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) cleanupError = new GitCleanupError();
          }
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (cleanupError) reject(cleanupError);
        else if (failed) reject(new Error('Git root check failed'));
        else resolve(output);
      };
      // A helper may inherit stdout after the direct child exits: close is not a deadline.
      const deadline = setTimeout(() => finish(true), 5_000);
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        if (settled) return;
        if (Buffer.byteLength(output) + Buffer.byteLength(chunk) > 64 * 1024) {
          finish(true);
        } else output += chunk;
      });
      child.once('error', () => finish(true));
      child.once('close', code => finish(code !== 0));
    });
    const root = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
    if (await realpath(root) !== path) throw new Error('not root');
  } catch (error) {
    if (error instanceof GitCleanupError) throw error;
    throw new Error('Invalid directory settings: directories.repositories (expected local Git root)');
  }
}

/**
 * Admit current filesystem state. Returns canonical selections for explicit callers;
 * persistence additionally rejects noncanonical input rather than silently rewriting it.
 */
export async function admitDirectorySettings(raw: unknown, policy: { dataDir: string }): Promise<DirectorySettings | undefined> {
  const settings = parseDirectorySettings(raw);
  if (!settings) return undefined;
  if (!isAbsolute(policy.dataDir) || policy.dataDir.includes('\0')) throw new Error('Invalid directory policy');
  let dataDir: string;
  try { dataDir = await prospectiveRealpath(policy.dataDir); }
  catch { throw new Error('Invalid directory policy'); }
  // Derive this lexically from canonical dataDir: projects -> bots must not admit bots.
  const projects = join(dataDir, 'projects');
  async function directory(path: string, field: string): Promise<string> {
    try {
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory() || contains(canonical, dataDir)
        || (contains(dataDir, canonical) && !(canonical !== projects && contains(projects, canonical)))) {
        throw new Error('outside allowed locations');
      }
      return canonical;
    } catch { throw new Error(`Invalid directory settings: directories.${field}`); }
  }
  async function unique(list: string[], field: string): Promise<string[]> {
    const canonical = await Promise.all(list.map(path => directory(path, field)));
    if (new Set(canonical).size !== canonical.length) throw new Error(`Invalid directory settings: directories.${field} (duplicate)`);
    return canonical;
  }
  const result: DirectorySettings = {};
  if (settings.workspaces) {
    const primary = await directory(settings.workspaces.primary, 'workspaces.primary');
    const additional = await unique(settings.workspaces.additional, 'workspaces.additional');
    if (additional.includes(primary)) throw new Error('Invalid directory settings: directories.workspaces (duplicate)');
    result.workspaces = { primary, additional };
  }
  if (settings.repositories) {
    result.repositories = await unique(settings.repositories, 'repositories');
    for (const repository of result.repositories) await assertGitRoot(repository);
  }
  return result;
}

/** Unchanged declarations can survive a temporarily missing mount on unrelated saves. */
export async function admitDirectoryChanges(next: DirectorySettings | undefined, previous: DirectorySettings | undefined, dataDir: string): Promise<void> {
  for (const key of ['workspaces', 'repositories'] as const) {
    if (next?.[key] === undefined || JSON.stringify(next[key]) === JSON.stringify(previous?.[key])) continue;
    const selected = { [key]: next[key] };
    const admitted = await admitDirectorySettings(selected, { dataDir });
    if (JSON.stringify(admitted) !== JSON.stringify(selected)) throw new Error(`Invalid directory settings: directories.${key} (expected canonical paths)`);
  }
}
