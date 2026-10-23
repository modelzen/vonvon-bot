import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex, holdMutexRole, isDead } from '../config/data-access';
import { syncDirectory } from '../config/bot-namespace';

/**
 * 项目库（记忆设计 §2.1）：`<数据根>/library/projects.json`。项目是工作区的真相源，以后也是项目记忆的主人；
 * 绑定行（某个 bot 的 projects.json 里的一行，project/registry.ts 的 `Project`）用 `projectId` 指向它，
 * `cwd`、`directories` 留作镜像，运行时照旧只读绑定行。
 */
export interface LibraryProject {
  /** `prj_` 加 8 位十六进制，建好不变；绑定行和以后的 `library/<id>/` 都按它找 */
  id: string;
  /** 全库唯一；不跟群名联动 */
  name: string;
  createdAt: number;
  /** 每次改这个项目加一 */
  revision: number;
  /** 迁移建的项目：从哪个 bot 的哪个群的绑定行来。迁移按它找已经建过的项目，中途退出再启不会再建一个 */
  migratedFrom?: { botId: string; chatId: string };
  workspace: LibraryWorkspace;
}

/** 主目录全库唯一（真实路径）。`repositories` 没有 = 每个绑定行沿用各自 bot 的默认，和绑定行的 `directories` 同一规矩 */
export interface LibraryWorkspace { primary: string; additional: string[]; repositories?: string[] }

export type LibraryLocation = Readonly<{ dir: string; file: string }>;
export function libraryLocation(dataRoot: string = paths.appDir): LibraryLocation {
  const dir = join(dataRoot, 'library');
  return { dir, file: join(dir, 'projects.json') };
}

const PROJECT_ID = /^prj_[0-9a-f]{8}$/;
export const isProjectId = (value: unknown): value is string => typeof value === 'string' && PROJECT_ID.test(value);
export function newProjectId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `prj_${randomBytes(4).toString('hex')}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * A directory's canonical path, the key that makes two bindings one project. A folder that does not exist yet is
 * canonical through its longest existing ancestor (`realpath(ancestor)` plus the missing tail), so it keeps one key
 * whether it exists or not. `resolved: false` when that cannot be known (a link on the way whose target is gone, an
 * unmounted volume behind it, an unreadable ancestor): `path` is then only the lexical path, never compared as
 * canonical, and the caller leaves the binding's main folder for a later start.
 */
export interface ResolvedDirectory { path: string; resolved: boolean }
export async function resolveDirectory(path: string): Promise<ResolvedDirectory> {
  const lexical = resolve(path);
  const tail: string[] = [];
  for (let current = lexical; ;) {
    try {
      const real = await realpath(current);
      return { path: tail.length ? join(real, ...tail) : real, resolved: true };
    } catch (error) {
      if (!isMissing(error)) return { path: lexical, resolved: false };
    }
    // realpath said missing: either this entry is absent (go up) or it is a link whose target is gone (unknown).
    const absent = await lstat(current).then(() => false, (error: unknown) => isMissing(error));
    const parent = dirname(current);
    if (!absent || parent === current) return { path: lexical, resolved: false };
    tail.unshift(basename(current));
    current = parent;
  }
}
const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

const AbsolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes('\0'));
// Loose objects: keys a later version adds (the memory limit, say) survive a rewrite by this one.
const WorkspaceSchema = z.looseObject({
  primary: AbsolutePath,
  additional: z.array(AbsolutePath).max(1000),
  repositories: z.array(AbsolutePath).max(1000).optional(),
});
/** The longest project name the library takes. */
export const PROJECT_NAME_MAX = 1000;
const ProjectSchema = z.looseObject({
  id: z.string().regex(PROJECT_ID),
  name: z.string().min(1).max(PROJECT_NAME_MAX),
  createdAt: z.number().finite(),
  revision: z.number().int().min(1),
  migratedFrom: z.looseObject({ botId: z.string().min(1).max(200), chatId: z.string().min(1).max(204) }).optional(),
  workspace: WorkspaceSchema,
});
const FileSchema = z.looseObject({ version: z.literal(1), projects: z.array(ProjectSchema) });

/** One read of the library: its projects, and the other top-level keys as they were, for the next write. */
export interface LibrarySnapshot { projects: LibraryProject[]; rest: Record<string, unknown> }

const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;

/**
 * Reads the library; a missing file is an empty library. Lock-free: the only writer publishes with tmp + rename. A
 * file that is not one regular file of ours (a link, another version, a broken document) is an error, never empty:
 * the migration would otherwise make every project again.
 */
export async function readLibrary(location: LibraryLocation = libraryLocation()): Promise<LibrarySnapshot> {
  let text: string;
  try {
    const file = await open(location.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_LIBRARY_BYTES) throw new Error('项目库文件无效');
      text = await file.readFile('utf8');
    } finally { await file.close(); }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { projects: [], rest: {} };
    throw error;
  }
  const parsed = FileSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error('项目库格式无效');
  const { version: _version, projects, ...rest } = parsed.data;
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw new Error('项目库里有重复的项目 id');
  return { projects: projects as LibraryProject[], rest };
}

async function writeLibrary(location: LibraryLocation, snapshot: LibrarySnapshot, beforeRename?: () => void | Promise<void>): Promise<void> {
  const ids = new Set(snapshot.projects.map(project => project.id));
  const names = new Set(snapshot.projects.map(project => project.name));
  const primaries = new Set(snapshot.projects.map(project => project.workspace.primary));
  if (ids.size !== snapshot.projects.length || names.size !== snapshot.projects.length || primaries.size !== snapshot.projects.length) {
    throw new Error('项目库里的项目 id、名字和主目录都要唯一');
  }
  const body = { ...snapshot.rest, version: 1, projects: snapshot.projects };
  if (!FileSchema.safeParse(body).success) throw new Error('项目库格式无效');
  const content = `${JSON.stringify(body, null, 2)}\n`;
  if (Buffer.byteLength(content) > MAX_LIBRARY_BYTES) throw new Error('项目库太大');
  const tmp = `${location.file}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    const file = await open(tmp, 'wx', 0o600);
    let failed = false;
    try { await file.writeFile(content, 'utf8'); await file.sync(); }
    catch (error) { failed = true; throw error; }
    finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
    await beforeRename?.();
    await rename(tmp, location.file);
    renamed = true;
    await syncDirectory(location.dir);
  } finally {
    if (!renamed) await unlink(tmp).catch(() => undefined);
  }
}

const TEMPORARY = /^projects\.json\.tmp-(\d+)-[0-9a-f-]{36}$/;
/** Whether the process that named a temporary file is gone; one we may not signal counts as alive. */
function writerGone(pid: number): boolean {
  if (pid === process.pid) return false;
  try { return isDead(pid); } catch { return false; }
}

/** The library inside {@link ownLibrary}: change `projects` in place, then `commit` writes them. */
export interface LibraryDraft {
  readonly projects: LibraryProject[];
  /** Publishes `projects` atomically; `beforeRename` is a test seam for a failure between the temporary file and the rename. */
  commit(options?: { beforeRename?: () => void | Promise<void> }): Promise<void>;
  /**
   * Removes the temporary files of writers killed between creating them and the rename (they never unlinked them);
   * only a dead process's, and safe here because every writer writes under this mutex. Returns how many.
   */
  sweepTemporaries(): Promise<number>;
}

/** Waits this long for another process's `library` (the default 1.5 s would fail while several bots bind at once). */
export const LIBRARY_MUTEX_TIMEOUT_MS = 30_000;
let libraryChain: Promise<unknown> = Promise.resolve();

/**
 * Reads, changes and writes the library under its `library` mutex, one operation at a time in this process. Lock
 * order bots → library → projects → memory: an operation here may take a bot's projects; called while `library`
 * itself, `projects` or `memory` is held it is refused before it waits (a nested call would wait for its own caller).
 */
export function ownLibrary<T>(operation: (library: LibraryDraft) => Promise<T>, location: LibraryLocation = libraryLocation()): Promise<T> {
  const target = { ...location };
  return holdMutexRole('library', () => {
    const run = libraryChain.then(async () => {
      await mkdir(target.dir, { recursive: true, mode: 0o700 });
      const mutex = await acquireMutex(target.dir, 'library', LIBRARY_MUTEX_TIMEOUT_MS);
      let result: T;
      try {
        const snapshot = await readLibrary(target);
        result = await operation({
          projects: snapshot.projects,
          commit: options => writeLibrary(target, snapshot, options?.beforeRename),
          sweepTemporaries: async () => {
            let removed = 0;
            for (const name of await readdir(target.dir)) {
              const match = TEMPORARY.exec(name);
              if (!match || !writerGone(Number(match[1]))) continue;
              await unlink(join(target.dir, name)).then(() => { removed++; }, () => undefined);
            }
            return removed;
          },
        });
      } catch (error) {
        try { await closeMutex(mutex); }
        catch (releaseError) { throw new AggregateError([error, releaseError], 'Library operation and mutex release failed'); }
        throw error;
      }
      await closeMutex(mutex);
      return result;
    });
    libraryChain = run.catch(() => undefined);
    return run;
  });
}

/**
 * Holds the `memory` mutex of one memory store's directory (a project's `library/<projectId>/`, a bot's own
 * directory) for `operation`, waiting as long as {@link ownLibrary}. The last in the lock order: inside it none of
 * the four is taken, another store's `memory` included, so two processes never hold two stores in opposite order.
 * P1a only provides it; the memory store (P2) is its first user.
 */
export function holdMemoryDirectory<T>(dir: string, operation: () => Promise<T>): Promise<T> {
  return holdMutexRole('memory', async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const mutex = await acquireMutex(dir, 'memory', LIBRARY_MUTEX_TIMEOUT_MS);
    try { return await operation(); }
    finally { await closeMutex(mutex); }
  });
}

/** `library/<projectId>/`, the directory of a project's own files; refuses anything that is not a project id. */
export function projectDirectory(projectId: string, location: LibraryLocation = libraryLocation()): string {
  if (!isProjectId(projectId)) throw new Error('项目 id 无效');
  return join(location.dir, projectId);
}
