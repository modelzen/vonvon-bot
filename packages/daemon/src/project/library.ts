import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex, holdMutexRole, isDead } from '../config/data-access';
import { syncDirectory } from '../config/bot-namespace';
import type { DirectorySettings } from '../config/directories';

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
  /** A project made at binding time: from which bot's group. {@link createLibraryProject} finds the project a run cut
   * off between the library write and the row write already made, by this and the main folder. */
  createdBy?: { botId: string; chatId: string };
  workspace: LibraryWorkspace;
}

/** 工作区目录声明。多个项目可以指向同一主目录。`repositories` 没有 = 每个绑定行沿用各自 bot 的默认，和绑定行的 `directories` 同一规矩 */
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
  createdBy: z.looseObject({ botId: z.string().min(1).max(200), chatId: z.string().min(1).max(204) }).optional(),
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
  if (ids.size !== snapshot.projects.length || names.size !== snapshot.projects.length) {
    throw new Error('项目库里的项目 id 和名字都要唯一');
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

/** Why a library operation was refused; `project` is the one in the way (`primary-taken`, `name-taken`). */
export type LibraryErrorCode = 'not-found' | 'revision' | 'primary-taken' | 'name-taken';
export class LibraryError extends Error {
  constructor(readonly code: LibraryErrorCode, message: string, readonly project?: { id: string; name: string }) {
    super(message);
    this.name = 'LibraryError';
  }
}

/**
 * Whether a project's main folder is `primary`, as stored or as it resolves now: a project made while its folder could
 * not be resolved holds the lexical path until the drift check corrects it. `resolved` caches each path's resolution.
 */
export async function sameMainFolder(project: LibraryProject, primary: string, resolved: Map<string, Promise<ResolvedDirectory>>): Promise<boolean> {
  const stored = project.workspace.primary;
  if (stored === primary) return true;
  if (!resolved.has(stored)) resolved.set(stored, resolveDirectory(stored));
  const now = await resolved.get(stored)!;
  return now.resolved && now.path === primary;
}

/** The project whose main folder is `primary` (canonical), other than `exceptId`. */
export async function projectWithMainFolder(projects: readonly LibraryProject[], primary: string, exceptId?: string): Promise<LibraryProject | undefined> {
  const resolved = new Map<string, Promise<ResolvedDirectory>>();
  for (const project of projects) if (project.id !== exceptId && await sameMainFolder(project, primary, resolved)) return project;
  return undefined;
}

/** `name` made unique among `projects` with " 2", " 3" (§2.1), cut so the whole fits the library's limit. */
export function uniqueProjectName(projects: readonly { name: string }[], name: string): string {
  const taken = new Set(projects.map(project => project.name));
  const base = name.trim() || '项目';
  const candidate = (n: number): string => {
    const tail = n > 1 ? ` ${n}` : '';
    let head = '';
    for (const character of base) { if (head.length + character.length + tail.length > PROJECT_NAME_MAX) break; head += character; }
    return `${head}${tail}`;
  };
  for (let n = 1; ; n++) if (!taken.has(candidate(n))) return candidate(n);
}

export interface NewLibraryProject {
  name: string;
  /** Admitted, with a canonical main folder (`admitDirectorySettings`). */
  workspace: LibraryWorkspace;
  createdBy: { botId: string; chatId: string };
}

/**
 * Makes the project a binding is about to join, before the binding's own row is written (§2.1): the library first,
 * the rows second, so a run cut off in between leaves a project the next run finds again, never one a row names
 * without the library knowing it. Multiple projects may use the same main folder; a retry for the same `(botId, chatId)`
 * and main folder reuses the project created by the interrupted run. A taken name gets " 2".
 */
export function createLibraryProject(input: NewLibraryProject, location?: LibraryLocation, now: () => number = Date.now): Promise<LibraryProject> {
  const request = structuredClone(input);
  return ownLibrary(async draft => {
    const resolved = new Map<string, Promise<ResolvedDirectory>>();
    for (const item of draft.projects) {
      if (item.createdBy?.botId === request.createdBy.botId && item.createdBy.chatId === request.createdBy.chatId && await sameMainFolder(item, request.workspace.primary, resolved)) {
        return item;
      }
    }
    const project: LibraryProject = {
      id: newProjectId(new Set(draft.projects.map(item => item.id))),
      name: uniqueProjectName(draft.projects, request.name),
      createdAt: now(), revision: 1, createdBy: request.createdBy, workspace: request.workspace,
    };
    draft.projects.push(project);
    await draft.commit();
    return project;
  }, location);
}

/**
 * Sets a project's workspace inside {@link ownLibrary} (the one operation every workspace entry goes through, §2.1).
 * `revision` is the project's, refused when it moved; `workspace` is admitted already. A workspace the project has
 * already changes nothing, not even its revision. Multiple projects may share the same main folder.
 */
export async function setLibraryWorkspace(draft: LibraryDraft, change: { projectId: string; revision: number; workspace: LibraryWorkspace }): Promise<{ project: LibraryProject; changed: boolean }> {
  const project = draft.projects.find(item => item.id === change.projectId);
  if (!project) throw new LibraryError('not-found', '项目不存在，请刷新');
  if (project.revision !== change.revision) throw new LibraryError('revision', '项目已改变，请刷新后重试');
  if (JSON.stringify(project.workspace) === JSON.stringify(change.workspace)) return { project, changed: false };
  project.workspace = change.workspace;
  project.revision += 1;
  await draft.commit();
  return { project, changed: true };
}

/** Renames a project inside {@link ownLibrary}. Names stay unique in the library; the same name again changes nothing, not even the revision. */
export async function renameLibraryProject(draft: LibraryDraft, change: { projectId: string; revision: number; name: string }): Promise<{ project: LibraryProject; changed: boolean }> {
  const project = draft.projects.find(item => item.id === change.projectId);
  if (!project) throw new LibraryError('not-found', '项目不存在，请刷新');
  if (project.revision !== change.revision) throw new LibraryError('revision', '项目已改变，请刷新后重试');
  const name = change.name.trim();
  if (!name || name.length > PROJECT_NAME_MAX) throw new LibraryError('name-taken', '项目名无效');
  if (project.name === name) return { project, changed: false };
  const owner = draft.projects.find(item => item.id !== project.id && item.name === name);
  if (owner) throw new LibraryError('name-taken', `已经有一个叫「${name}」的项目`, { id: owner.id, name: owner.name });
  project.name = name;
  project.revision += 1;
  await draft.commit();
  return { project, changed: true };
}

/**
 * Deletes a project inside {@link ownLibrary}: the library entry first, then its own directory (memory and events go
 * with it). The caller has checked that no binding row names it. The directory name comes from {@link projectDirectory},
 * which refuses anything that is not a project id.
 */
export async function deleteLibraryProject(draft: LibraryDraft, change: { projectId: string; revision: number }, location?: LibraryLocation): Promise<LibraryProject> {
  const index = draft.projects.findIndex(item => item.id === change.projectId);
  if (index < 0) throw new LibraryError('not-found', '项目不存在，请刷新');
  const project = draft.projects[index]!;
  if (project.revision !== change.revision) throw new LibraryError('revision', '项目已改变，请刷新后重试');
  const directory = projectDirectory(project.id, location);
  draft.projects.splice(index, 1);
  await draft.commit();
  await rm(directory, { recursive: true, force: true });
  return project;
}

/** The `cwd`, `blank` and `directories` of a binding row that mirrors `workspace` (§2.1); the one place that shapes them. */
export function workspaceMirror(workspace: LibraryWorkspace): { cwd: string; blank: false; directories: DirectorySettings } {
  return {
    cwd: workspace.primary,
    blank: false,
    directories: { workspaces: { primary: workspace.primary, additional: [...workspace.additional] }, ...(workspace.repositories ? { repositories: [...workspace.repositories] } : {}) },
  };
}
