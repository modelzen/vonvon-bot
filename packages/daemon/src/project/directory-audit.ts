import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { DirectoryProblem } from '@vonvon/protocol';
import { paths } from '../config/paths';
import { loadBots } from '../config/bots';
import { resolveProjectsRootDir } from '../config/directories';
import { loadConfig } from '../config/store';

export interface DirectoryContext {
  dataDir: string;
  /** Every projects root a group's default directory was made under: the default, configured ones, allocation parents. */
  projectsRoots: readonly string[];
  /** Each bot's stable directory and its `groups`. */
  botRoots: readonly string[];
}

/** The places to compare with, read from bots.json; `projectsRoots` adds a bot's configured root. */
export async function directoryContext(dataDir = paths.appDir, projectsRoots: readonly string[] = []): Promise<DirectoryContext> {
  const registry = await loadBots();
  const allocations = Object.values(registry.allocations ?? {});
  return { dataDir, projectsRoots: [paths.projectsRootDir, ...projectsRoots, ...allocations.map(record => record.parent)],
    botRoots: [...allocations, ...Object.values(registry.groupContainers ?? {})].map(record => record.namespaceRoot) };
}

/** A bot's own `preferences.projectsRootDir`, where its old rows were made; none when unset or unreadable. */
export async function configuredProjectsRoots(configFile: string): Promise<string[]> {
  try {
    const configured = (await loadConfig(configFile)).preferences?.projectsRootDir;
    return configured === undefined ? [] : [resolveProjectsRootDir(configured)];
  } catch { return []; }
}

async function canonical(path: string): Promise<string> { return realpath(path).catch(() => path); }
async function identity(path: string): Promise<string | undefined> {
  return lstat(path, { bigint: true }).then(entry => `${entry.dev}:${entry.ino}`, () => undefined);
}
function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Rows the old creation entries left in the wrong place (s36c2d, review R4-1/R6-1): before s36d1 a new group's
 * default directory was `<projects root>/<group name>`, so a name equal to a bot's handle landed in that bot's stable
 * directory, `.` in the projects root and `..` or the DM's `../x` in the data directory. A directory is compared by
 * its canonical path and its inode, which also catches a name that differs only in case on macOS. Read only; nothing
 * is moved. `projects/` and below is where workspaces may be, so only its root counts there.
 */
export async function legacyDirectoryProblems(cwds: readonly string[], context: DirectoryContext): Promise<Array<DirectoryProblem | undefined>> {
  const places = async (list: readonly string[]) => {
    const resolved = await Promise.all(list.map(async path => [await canonical(path), await identity(path)] as const));
    return { paths: new Set(resolved.map(([path]) => path)), objects: new Set(resolved.flatMap(([, object]) => object ? [object] : [])) };
  };
  const [bots, roots, dataDir] = await Promise.all([places(context.botRoots), places(context.projectsRoots), canonical(context.dataDir)]);
  const projects = join(dataDir, 'projects');
  return Promise.all(cwds.map(async cwd => {
    const path = await canonical(cwd), object = await identity(cwd);
    const matches = (set: { paths: Set<string>; objects: Set<string> }) => set.paths.has(path) || (object !== undefined && set.objects.has(object));
    if (matches(bots)) return 'botRoot';
    if (matches(roots)) return 'projectsRoot';
    if (inside(dataDir, path) && !(path !== projects && inside(projects, path))) return 'dataDir';
    return undefined;
  }));
}
