import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { loadBots, type BotEntry } from '../config/bots';
import { botDir, botPaths, paths } from '../config/paths';
import { acquireMutex, closeMutex } from '../config/data-access';
import { admitDirectorySettings } from '../config/directories';
import { directoryFailure, DirectoryError } from '../config/directory-errors';
import { log } from '../core/logger';
import { acquireSingleInstanceLock, readSingleInstanceHolder } from '../core/single-instance';
import { botFiles, migrateRoleFiles, readText } from '../bot/role-files';
import { importGroupMemory, importSharedMemory } from '../bot/memory-import';
import { botMemoryLocation, MemoryStore, projectMemoryLocation } from '../bot/memory-store';
import { assertBridgeImportReservation } from '../import/bridge/reservation';
import { listProjectsIn, mutateProject, previousProjectIdIn, withStoredRows, type Project } from '../project/registry';
import { detachSessionsForChatIn } from '../bot/session-store';
import {
  deleteLibraryProject, isProjectId, libraryLocation, LibraryError, newProjectId, ownLibrary, PROJECT_NAME_MAX, readLibrary, resolveDirectory, sameMainFolder,
  renameLibraryProject, setLibraryWorkspace, workspaceMirror,
  type LibraryProject, type LibraryWorkspace, type ResolvedDirectory,
} from '../project/library';
import { AdminWriteError } from './ops';

/**
 * host 一侧的项目库（记忆设计 §2.6 `admin/library.ts`）：启动时的迁移步骤 A、漂移检查和给 `vonvon project list` 的总览，
 * 以及 P1b 的 `library.*` 服务：工作区的唯一写入口（settings、`editProject`、reset、首次绑定都经它）和给每个绑定行
 * 扇出镜像、归档会话的 IPC `libraryWorkspaceChanged`。
 */

export interface LibraryStartupOptions {
  now?: () => number;
  /** Test seam: runs after a bot's new projects are in the library and before its rows name them. */
  afterLibraryWrite?: (botId: string) => void | Promise<void>;
}
export type DriftField = 'primary' | 'additional' | 'repositories';
/**
 * A project whose bindings' mirrors no longer match it. The library is the source of truth since P1b funnels every
 * workspace write through it, so a row that differs was missed by a fan-out (the bot was down, the process died
 * between the two writes) or written by an older daemon: `repaired` = the row took the project's workspace and its
 * sessions were archived; `failed` = it could not (the bot runs outside this daemon, the folder is gone), tried again
 * at the next start.
 */
export interface DriftNote { projectId: string; rows: number; fields: DriftField[]; outcome: 'repaired' | 'failed' }
export interface LibraryStartupReport {
  /** rows that got their step-B marker (supplement and memory) this start */
  memoryMigrated?: number;
  /** rows that got their `projectId` or step-A marker this start */
  linked: number;
  /** projects made for them */
  created: number;
  failed: { botId: string; error: string }[];
  drift: DriftNote[];
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** The bot's name as people know it (the Feishu app name), for project names and lists. */
export function botLabel(bot: Pick<BotEntry, 'appId' | 'name' | 'botName'>): string {
  return (bot.botName ?? '').replace(CONTROL, '').trim() || bot.name.replace(CONTROL, '').trim() || bot.appId;
}

/**
 * The workspace a binding row mirrors: its folder as the main one, plus its own extra folders and repositories.
 * `resolved: false` when the folder's canonical path cannot be known now (project/library.ts `resolveDirectory`):
 * `primary` is then only the lexical path.
 */
export async function rowWorkspace(row: Pick<Project, 'cwd' | 'directories'>): Promise<{ workspace: LibraryWorkspace; resolved: boolean }> {
  const directories = row.directories;
  const primary = await resolveDirectory(row.cwd);
  return {
    resolved: primary.resolved,
    workspace: {
      primary: primary.path,
      additional: [...directories?.workspaces?.additional ?? []],
      ...(directories?.repositories ? { repositories: [...directories.repositories] } : {}),
    },
  };
}

const stepADone = (row: Project): boolean => {
  const migration: unknown = row.migration;
  return isRecord(migration) && typeof migration.library === 'number' && Number.isFinite(migration.library);
};

/** `text` cut to at most `max` UTF-16 units (the unit the library's limits count), never inside a character. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const character of text) {
    if (out.length + character.length > max) break;
    out += character;
  }
  return out;
}

/**
 * The name of a project made from a row (memory design §7.1, owner D2): the group's name; for a group whose bots use
 * different folders, every one of its projects gets "（<bot 名>）", so none looks like the group's only one; a name
 * another group already has gets " 2", " 3" (§2.1). The group's name is cut so the whole fits the library's limit.
 */
function migratedName(projects: readonly LibraryProject[], row: Project, bot: BotEntry, split: boolean): string {
  const taken = new Set(projects.map(project => project.name));
  const base = row.name.replace(CONTROL, '').trim() || row.chatId;
  const label = split ? `（${clip(botLabel(bot), 100)}）` : '';
  const name = (n: number): string => {
    const tail = `${label}${n > 1 ? ` ${n}` : ''}`;
    return `${clip(base, PROJECT_NAME_MAX - tail.length)}${tail}`;
  };
  for (let n = 1; ; n++) if (!taken.has(name(n))) return name(n);
}

/** Whether a stored row still needs step A: no project the library knows, or no marker yet. A row without a group is never linked. */
function needsStepA(row: Project, known: ReadonlySet<string>): boolean {
  if (typeof row.chatId !== 'string' || !row.chatId) return false;
  return !(isProjectId(row.projectId) && known.has(row.projectId)) || !stepADone(row);
}

/**
 * The groups whose bots use different main folders (owner D2): read lock-free from every bot's rows before step A
 * makes any project, since the first bot's project is named before the second bot is seen. A bot whose rows cannot
 * be read is left out; step A reports it.
 */
async function splitGroups(bots: readonly BotEntry[]): Promise<Set<string>> {
  const folders = new Map<string, { bots: Set<string>; mains: Set<string> }>();
  for (const bot of bots) {
    let rows: Project[];
    try { rows = await listProjectsIn(botPaths(bot.appId).projectsFile); } catch { continue; }
    for (const row of rows) {
      if (typeof row.chatId !== 'string' || !row.chatId) continue;
      const group = folders.get(row.chatId) ?? { bots: new Set(), mains: new Set() };
      group.bots.add(bot.appId);
      group.mains.add((await resolveDirectory(row.cwd)).path);
      folders.set(row.chatId, group);
    }
  }
  return new Set([...folders].filter(([, group]) => group.bots.size > 1 && group.mains.size > 1).map(([chatId]) => chatId));
}

/**
 * The workspace of a project and a row that joins it by main folder (step A): extra folders and repositories are the
 * union, the project's own first. A side with no explicit repositories inherits its bot's, which the project can only
 * keep by holding none; when only one side has a list, the project takes it, so the repositories someone chose are
 * kept (the other row now shares that list instead of its bot's default).
 */
export function mergeWorkspaces(project: LibraryWorkspace, row: LibraryWorkspace): LibraryWorkspace {
  const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];
  const additional = union(project.additional, row.additional).filter(path => path !== project.primary);
  const repositories = project.repositories || row.repositories ? union(project.repositories ?? [], row.repositories ?? []) : undefined;
  const { repositories: _repositories, ...rest } = project;
  return { ...rest, additional, ...(repositories ? { repositories } : {}) };
}

/**
 * Step A for one bot (memory design §7.1), holding library → this bot's projects. Each row that needs it is linked to
 * the project whose main folder is the row's: the one made from it by a run cut off between the two writes, or one
 * two bindings of one folder were always sharing. A row whose folder cannot be resolved now goes to the project made
 * from it before (`migratedFrom`) instead. Otherwise a new project, under the row's own `projectId` when the library
 * lost that project, so whatever else names it finds it again. `migratedFrom` alone never decides for a row whose
 * folder resolves: a group unbound and bound again to another folder gets a new project, and the old one keeps its
 * folder (D4). A row joining a project by its folder adds its extra folders and repositories to the project's
 * ({@link mergeWorkspaces}), since the library's workspace replaces every row's mirror at the next drift check.
 * The library is written first, the rows second; a run that stops in between leaves projects the next run finds again, never an orphan.
 */
async function linkBot(bot: BotEntry, report: LibraryStartupReport, options: LibraryStartupOptions, split: () => Promise<ReadonlySet<string>>): Promise<void> {
  const file = botPaths(bot.appId).projectsFile;
  // Lock-free first: a bot with nothing to do takes no lock and creates no library directory.
  const [rows, library] = await Promise.all([listProjectsIn(file), readLibrary()]);
  const known = new Set(library.projects.map(project => project.id));
  if (!rows.some(row => needsStepA(row, known))) return;
  // A bot the bridge import still holds (a rollback that failed, a cleanup pending) is left as it is, like settings do.
  await assertBridgeImportReservation(paths.appDir, bot.appId);
  const splitChats = await split();
  const now = options.now ?? Date.now;
  let linked = 0, created = 0;
  await ownLibrary(async draft => withStoredRows({ file, dataRoot: paths.appDir }, async stored => {
    const byId = new Map(draft.projects.map(project => [project.id, project]));
    const mains = new Map<string, Promise<ResolvedDirectory>>();
    const links: Array<{ row: Project; id: string }> = [];
    const mergedProjects = new Set<string>();
    const at = now();
    for (const row of stored) {
      const current = isProjectId(row.projectId) ? byId.get(row.projectId) : undefined;
      if (current) {
        if (!stepADone(row)) links.push({ row, id: current.id });
        continue;
      }
      if (typeof row.chatId !== 'string' || !row.chatId) {
        log.warn('library', 'row_skipped', { botId: bot.appId, reason: 'no-chat' });
        continue;
      }
      const { workspace, resolved } = await rowWorkspace(row);
      let project: LibraryProject | undefined;
      for (const item of draft.projects) if (!project && await sameMainFolder(item, workspace.primary, mains)) project = item;
      // The library is authoritative from P1b, so a row joining a project by its folder must not lose its own extra
      // folders and repositories when the project's replace the row's mirror: the project takes the union (never silent).
      if (project && resolved) {
        const merged = mergeWorkspaces(project.workspace, workspace);
        if (JSON.stringify(merged) !== JSON.stringify(project.workspace)) {
          project.workspace = merged;
          project.revision += 1;
          mergedProjects.add(project.id);
        }
      }
      // A folder that cannot be resolved now is not compared; the project made from this row before is still its.
      if (!project && !resolved) project = draft.projects.filter(item => item.migratedFrom?.botId === bot.appId && item.migratedFrom.chatId === row.chatId).at(-1);
      if (!project) {
        project = {
          id: isProjectId(row.projectId) && !byId.has(row.projectId) ? row.projectId : newProjectId(new Set(byId.keys())),
          name: migratedName(draft.projects, row, bot, splitChats.has(row.chatId)),
          createdAt: Number.isFinite(row.createdAt) ? row.createdAt : at,
          revision: 1,
          migratedFrom: { botId: bot.appId, chatId: row.chatId },
          workspace,
        };
        draft.projects.push(project);
        byId.set(project.id, project);
        created++;
      }
      links.push({ row, id: project.id });
    }
    if (created || mergedProjects.size) {
      await draft.commit();
      if (mergedProjects.size) log.info('library', 'workspace_merged', { botId: bot.appId, projects: mergedProjects.size });
      await options.afterLibraryWrite?.(bot.appId);
    }
    for (const { row, id } of links) {
      const migration: unknown = row.migration;
      row.projectId = id;
      row.migration = { ...isRecord(migration) ? migration : {}, library: at };
    }
    linked = links.length;
    return links.length > 0;
  }));
  // Counted once both files are written; a bot that failed shows in `failed` instead.
  report.linked += linked;
  report.created += created;
}

/**
 * Step B for one bot (memory design §7.1, P4a): each row that has its project and no `migration.memory` yet. The old
 * group persona becomes the row's `supplement`, the old group memory becomes project entries under "背景" (what the
 * desktop wrote is trusted, what only a file on disk held is not), and the bot's `memory/shared.md` becomes archived
 * Bot entries waiting to be picked. The entries go in first, under the memory mutex and with no library or projects
 * lock held (memory locks are never taken inside them); the markers are written last under the projects lock, so a
 * run cut off in between imports nothing twice (every entry carries an import hash) and writes the markers next time.
 * A row whose project the library lost, or that changed meanwhile, is left for the next start.
 */
async function migrateBotMemory(bot: BotEntry, options: LibraryStartupOptions): Promise<number> {
  const file = botPaths(bot.appId).projectsFile;
  const rows = await listProjectsIn(file);
  const pending = rows.filter(row => typeof row.chatId === 'string' && row.chatId && isProjectId(row.projectId) && stepADone(row) && row.migration?.memory === undefined);
  if (!pending.length) return 0;
  await assertBridgeImportReservation(paths.appDir, bot.appId);
  const files = await botFiles(bot.appId);
  const shared = await readText(files, { kind: 'public-memory' });
  if (shared.trim()) {
    const result = await importSharedMemory(new MemoryStore(botMemoryLocation(botDir(bot.appId))), { importFile: 'memory/shared.md', text: shared, botId: bot.appId });
    if (result.rejected) log.warn('library', 'memory_import_rejected', { botId: bot.appId, source: 'shared', rejected: result.rejected });
  }
  const library = await readLibrary();
  const done = new Map<string, { supplement: string }>();
  for (const row of pending) {
    const project = library.projects.find(item => item.id === row.projectId);
    if (!project) { log.warn('library', 'memory_project_missing', { botId: bot.appId }); continue; }
    const limit = (project as { memoryLimit?: unknown }).memoryLimit;
    const store = new MemoryStore(projectMemoryLocation(project.id, typeof limit === 'number' && Number.isInteger(limit) && limit > 0 ? { limit } : {}));
    let supplement: string;
    let memory: string;
    let importFile: string;
    let trusted: boolean;
    if (row.profile) {
      ({ persona: supplement, memory } = row.profile);
      importFile = `projects.json#${row.chatId}.profile.memory`;
      trusted = true;
    } else {
      [supplement, memory] = await Promise.all([readText(files, { kind: 'group-soul', chatId: row.chatId }), readText(files, { kind: 'group-memory', chatId: row.chatId })]);
      importFile = `groups/${row.chatId}/memory/group.md`;
      trusted = false;
    }
    if (memory.trim()) {
      const result = await importGroupMemory(store, { importFile, text: memory, botId: bot.appId, chatId: row.chatId, trusted });
      if (result.rejected) log.warn('library', 'memory_import_rejected', { botId: bot.appId, source: 'group', rejected: result.rejected });
    }
    done.set(row.chatId, { supplement });
  }
  if (!done.size) return 0;
  const at = (options.now ?? Date.now)();
  let marked = 0;
  await withStoredRows({ file, dataRoot: paths.appDir }, async stored => {
    for (const row of stored) {
      const step = done.get(row.chatId);
      if (!step || row.migration?.memory !== undefined) continue;
      if (row.supplement === undefined && step.supplement.trim()) row.supplement = step.supplement;
      row.migration = { ...row.migration, memory: at };
      marked++;
    }
    return marked > 0;
  });
  return marked;
}

function driftFields(project: LibraryWorkspace, row: LibraryWorkspace): DriftField[] {
  const fields: DriftField[] = [];
  if (project.primary !== row.primary) fields.push('primary');
  if (JSON.stringify(project.additional) !== JSON.stringify(row.additional)) fields.push('additional');
  if (JSON.stringify(project.repositories ?? null) !== JSON.stringify(row.repositories ?? null)) fields.push('repositories');
  return fields;
}

/** The row fields that mirror a project's workspace (§2.1): the main folder, its declaration and the repositories. */
export function applyMirror(row: Project, workspace: LibraryWorkspace): void {
  const mirror = workspaceMirror(workspace);
  if (row.cwd !== mirror.cwd) row.blank = false; // a folder somebody chose is no blank project the bridge made
  row.cwd = mirror.cwd;
  row.directories = mirror.directories;
}

export interface MirrorOutcome { chatId: string; name: string; fields: DriftField[]; state: 'archived' | 'failed'; error?: string }
/** Archives the sessions of a chat, then runs `commit`; the bot's own `detachSessionsForChat` or one on a named file. */
export type ArchiveChat = <T>(chatId: string, commit: () => Promise<T>) => Promise<T>;

/** The rows of this bot that belong to the project and no longer mirror it. Lock-free; a row whose folder cannot be resolved now is left out. */
export async function driftedRows(botId: string, projectId: string): Promise<Array<{ row: Project; fields: DriftField[] }>> {
  const project = (await readLibrary()).projects.find(item => item.id === projectId);
  if (!project) return [];
  const drifted: Array<{ row: Project; fields: DriftField[] }> = [];
  for (const row of await listProjectsIn(botPaths(botId).projectsFile)) {
    if (row.projectId !== projectId) continue;
    const mirror = await rowWorkspace(row);
    const fields = mirror.resolved ? driftFields(project.workspace, mirror.workspace) : [];
    if (fields.length) drifted.push({ row, fields });
  }
  return drifted;
}

/**
 * Makes every row of this bot that belongs to the project mirror it again, archiving the group's sessions first
 * (`archive`, §2.1: a workspace change always starts the group's sessions over). Reads the library's latest at the
 * moment it writes, so two changes arriving out of order still end at the newest. One row failing leaves the others
 * done. Runs in the bot's own process (it holds `projects` there) or, for a bot that is stopped, in the host.
 */
export async function mirrorProjectIntoBot(botId: string, projectId: string, archive: ArchiveChat): Promise<MirrorOutcome[]> {
  const files = botPaths(botId);
  const outcomes: MirrorOutcome[] = [];
  for (const { row, fields } of await driftedRows(botId, projectId)) {
    const workspace = (await readLibrary()).projects.find(item => item.id === projectId)?.workspace;
    if (!workspace) break;
    try {
      await archive(row.chatId, () => mutateProject(row.name, latest => {
        if (latest.projectId !== projectId) throw new Error('这个群已经换了项目');
        applyMirror(latest, workspace);
      }, { mirror: true }, { file: files.projectsFile, dataRoot: paths.appDir }));
      outcomes.push({ chatId: row.chatId, name: row.name, fields, state: 'archived' });
    } catch (error) {
      outcomes.push({ chatId: row.chatId, name: row.name, fields, state: 'failed', error: messageOf(error) });
    }
  }
  return outcomes;
}

/**
 * Runs `operation` on a bot no process owns, the way settings edit a stopped bot (admin/settings-service.ts): the
 * `bots` mutex keeps registration and starts out, the instance lock keeps a start out for the duration. A bot that
 * runs, here or in another terminal, is refused: its files belong to its process.
 */
async function withStoppedBot<T>(botId: string, operation: () => Promise<T>): Promise<T> {
  const mutex = await acquireMutex(paths.appDir, 'bots', 3000);
  let release: (() => void) | undefined;
  try {
    if (!(await loadBots()).bots.some(bot => bot.appId === botId)) throw new Error('Bot 已移除');
    await assertBridgeImportReservation(paths.appDir, botId);
    const files = botPaths(botId);
    const raw = await readFile(files.processesFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if ((raw && JSON.parse(raw).pid === process.pid) || readSingleInstanceHolder(botId, files.processesFile)) throw new Error('这个 Bot 正在别的进程里运行');
    release = acquireSingleInstanceLock(botId, files.processesFile, { createDir: false, onExit: false });
    return await operation();
  } finally { release?.(); await closeMutex(mutex); }
}

/** {@link mirrorProjectIntoBot} for a bot that is not running: sessions archived on its own file by the host. */
async function mirrorStoppedBot(botId: string, projectId: string): Promise<MirrorOutcome[]> {
  if (!(await driftedRows(botId, projectId)).length) return [];
  const sessionsFile = botPaths(botId).sessionsFile;
  return withStoppedBot(botId, () => mirrorProjectIntoBot(botId, projectId, (chatId, commit) => detachSessionsForChatIn(sessionsFile, chatId, commit)));
}

/**
 * Startup drift check (memory design §2.1): the library is the source of truth, so a row whose mirror differs from
 * its project (a fan-out missed it, an older daemon wrote it) takes the project's workspace, its group's sessions
 * archived, logged once per project. A row whose folder cannot be resolved now (an unmounted volume behind a link) is
 * left out: its lexical path is not an edit, and a project's folder must not flip at every mount and unmount.
 */
async function checkDrift(bots: readonly BotEntry[], report: LibraryStartupReport): Promise<void> {
  if (!(await readLibrary()).projects.length) return;
  const notes = new Map<string, DriftNote>();
  // A folder the library only held lexically (a link whose target was gone when its project was made) that resolves
  // now is the same folder, not a change: the library takes its canonical path, so no row looks drifted for it.
  await ownLibrary(async draft => {
    let changed = false;
    for (const project of draft.projects) {
      const now = await resolveDirectory(project.workspace.primary);
      if (!now.resolved || now.path === project.workspace.primary) continue;
      project.workspace = { ...project.workspace, primary: now.path };
      project.revision += 1;
      changed = true;
      notes.set(project.id, { projectId: project.id, rows: 0, fields: ['primary'], outcome: 'repaired' });
    }
    if (changed) await draft.commit();
  });
  const ids = new Set((await readLibrary()).projects.map(project => project.id));
  for (const bot of bots) {
    let projectIds: string[];
    // Unreadable rows were reported by step A just before.
    try { projectIds = [...new Set((await listProjectsIn(botPaths(bot.appId).projectsFile)).map(row => row.projectId).filter((id): id is string => isProjectId(id) && ids.has(id)))]; } catch { continue; }
    for (const projectId of projectIds) {
      let outcomes: MirrorOutcome[];
      try { outcomes = await mirrorStoppedBot(bot.appId, projectId); }
      catch (error) {
        // Stays drifted for the next start; whatever runs meanwhile reads the row's own folders, as before.
        const drifted = await driftedRows(bot.appId, projectId).catch(() => []);
        if (!drifted.length) continue;
        outcomes = drifted.map(({ row, fields }) => ({ chatId: row.chatId, name: row.name, fields, state: 'failed' as const, error: messageOf(error) }));
      }
      if (!outcomes.length) continue;
      const note = notes.get(projectId) ?? { projectId, rows: 0, fields: [], outcome: 'repaired' } satisfies DriftNote;
      note.rows += outcomes.length;
      note.fields = [...new Set([...note.fields, ...outcomes.flatMap(outcome => outcome.fields)])];
      if (outcomes.some(outcome => outcome.state === 'failed')) note.outcome = 'failed';
      notes.set(projectId, note);
    }
  }
  for (const note of notes.values()) {
    report.drift.push(note);
    if (note.outcome === 'repaired') log.info('library', 'drift_repaired', { ...note });
    else log.warn('library', 'drift', { ...note });
  }
}

/**
 * Runs at host start, before any bot (memory design §7.1, not in each bot's `initialize`): step A for every
 * registered bot, enabled or not, then the drift check. Idempotent; a bot that fails is logged and tried again at
 * the next start, its rows working as before meanwhile. Never throws.
 */
export async function prepareLibraryAtStartup(options: LibraryStartupOptions = {}): Promise<LibraryStartupReport> {
  const report: LibraryStartupReport = { linked: 0, created: 0, failed: [], drift: [] };
  // Made before any Bot session starts, rows or not: a sandbox deny list drops paths missing when the session spawns,
  // so a library first created under a running session would stay readable from it (s31b).
  try { await mkdir(libraryLocation().dir, { recursive: true, mode: 0o700 }); }
  catch (error) { log.fail('library', error, { phase: 'mkdir' }); }
  let bots: BotEntry[];
  // Not logged here: the run reads the same registry right after and reports it there.
  try { bots = (await loadBots()).bots; }
  catch { return report; }
  if (!bots.length) return report;
  // Under the mutex every writer takes, so only a killed writer's files are left to find.
  if (existsSync(libraryLocation().dir)) {
    try { await ownLibrary(draft => draft.sweepTemporaries()); }
    catch (error) { log.fail('library', error, { phase: 'sweep' }); }
  }
  let split: Promise<Set<string>> | undefined;
  const splitOnce = () => split ??= splitGroups(bots);
  for (const bot of bots) {
    try { await linkBot(bot, report, options, splitOnce); }
    catch (error) {
      report.failed.push({ botId: bot.appId, error: messageOf(error) });
      log.fail('library', error, { phase: 'migrate', botId: bot.appId });
    }
  }
  // Step R, per bot directory and independent of A: a bot whose rows failed above still gets its role files tidied.
  let rolesMerged = 0;
  for (const bot of bots) {
    try { if ((await migrateRoleFiles(bot.appId)) === 'merged') rolesMerged++; }
    catch (error) {
      report.failed.push({ botId: bot.appId, error: messageOf(error) });
      log.fail('library', error, { phase: 'role', botId: bot.appId });
    }
  }
  if (rolesMerged) log.info('library', 'roles_merged', { count: rolesMerged });
  // Step B, after A (it needs the rows' projects) and R (the role files are settled). A bot whose rows A could not read
  // has nothing B could read either: it is in `failed` once and tried again at the next start.
  const unread = new Set(report.failed.map(failure => failure.botId));
  report.memoryMigrated = 0;
  for (const bot of bots) {
    if (unread.has(bot.appId)) continue;
    try { report.memoryMigrated += await migrateBotMemory(bot, options); }
    catch (error) {
      report.failed.push({ botId: bot.appId, error: messageOf(error) });
      log.fail('library', error, { phase: 'memory', botId: bot.appId });
    }
  }
  if (report.memoryMigrated) log.info('library', 'memory_migrated', { rows: report.memoryMigrated });
  if (report.linked) log.info('library', 'migrated', { linked: report.linked, created: report.created });
  try { await checkDrift(bots, report); }
  catch (error) { log.fail('library', error, { phase: 'drift' }); }
  return report;
}

export interface OverviewBinding { botId: string; botName: string; chatId: string; name: string; enabled: boolean }
export interface LibraryOverview {
  projects: Array<LibraryProject & { bindings: OverviewBinding[] }>;
  /** binding rows with no project yet: bound since the last start, or failed there */
  unlinked: OverviewBinding[];
  unreadable: { botId: string; botName: string; error: string }[];
}

/** Every project with the groups that use it, read from the published files (no daemon, no lock). */
export async function libraryOverview(): Promise<LibraryOverview> {
  const [library, registry] = await Promise.all([readLibrary(), loadBots()]);
  const projects = library.projects.map(project => ({ ...project, bindings: [] as OverviewBinding[] }));
  const byId = new Map(projects.map(project => [project.id, project]));
  const overview: LibraryOverview = { projects, unlinked: [], unreadable: [] };
  for (const bot of registry.bots) {
    const botName = botLabel(bot);
    let rows: Project[];
    try { rows = await listProjectsIn(botPaths(bot.appId).projectsFile); }
    catch (error) { overview.unreadable.push({ botId: bot.appId, botName, error: messageOf(error) }); continue; }
    for (const row of rows) {
      const binding = { botId: bot.appId, botName, chatId: row.chatId, name: row.name, enabled: row.enabled !== false };
      const project = isProjectId(row.projectId) ? byId.get(row.projectId) : undefined;
      if (project) project.bindings.push(binding);
      else overview.unlinked.push(binding);
    }
  }
  return overview;
}

/**
 * The project another bot already works in for this group, if any (§5.6): the setup card offers to join it. The first
 * one in the library's order when the group's bots are in different projects. Read from the published files, no lock.
 */
export async function siblingProjectOfChat(chatId: string, exceptBotId: string): Promise<{ id: string; name: string } | undefined> {
  const found = (await libraryOverview()).projects.find(project => project.bindings.some(binding => binding.chatId === chatId && binding.botId !== exceptBotId));
  return found && { id: found.id, name: found.name };
}

/** What the host asks a running bot process to do about a project's workspace (admin/ipc.ts carries it). */
export type AdminLibraryOp =
  /** make this bot's rows of the project mirror the library again and archive their groups' sessions; answers {@link MirrorOutcome}[] */
  | { kind: 'libraryWorkspaceChanged'; projectId: string }
  /** whether this bot is running something its rows of the project would interrupt; answers `{ busy }` */
  | { kind: 'libraryWorkspaceCheck'; projectId: string };

export interface WorkspaceRequest {
  projectId: string;
  /** The project's revision the caller saw; left out = the current one (an entry that has its own row-level check). */
  revision?: number;
  workspace: { primary: string; additional: string[]; repositories?: string[] };
  /** Refuse while a bot using the project is running something, as `editProject` always did. Settings saves never refused. */
  refuseWhenBusy?: boolean;
}
export interface WorkspaceChange {
  project: LibraryProject;
  /** false when the library already held this workspace; the rows are still brought in line */
  changed: boolean;
  /** one entry per binding row that needed it; `failed` ones stay drifted and are repaired at the next start */
  rebound: Array<MirrorOutcome & { botId: string }>;
}
export interface LibraryHostDeps {
  /** Whether the bot has a running process of this daemon. */
  liveStatus?: (botId: string) => Promise<{ running: boolean } | undefined>;
  /** Reaches that process (supervisor IPC, or the process itself for a single bot). */
  executeLibrary?: (botId: string, op: AdminLibraryOp) => Promise<unknown>;
  readonlyPreview?: boolean;
}
export interface HostLibrary {
  overview(): Promise<LibraryOverview>;
  /** The one writer of a project's workspace (§2.1): the library, then every bot's rows. */
  workspace(request: WorkspaceRequest): Promise<WorkspaceChange>;
  /** Drops one override of the project's workspace: `repositories` back to each bot's default, `workspaces` to no extra folders. */
  resetOverride(projectId: string, key: 'workspaces' | 'repositories'): Promise<WorkspaceChange>;
  /** A project's own name (§5.3); no binding row holds it, so nothing fans out. */
  rename(request: { projectId: string; revision: number; name: string }): Promise<LibraryProject>;
  /** The project a group of this bot was bound to before it was unbound, if the library still has it. */
  previous(botId: string, chatId: string): Promise<{ id: string; name: string } | undefined>;
  /** Deletes a project no binding uses (§5.3); refused while any bot has a row of it. */
  remove(request: { projectId: string; revision: number }): Promise<void>;
}

/** The workspace as the library holds it, admitted: canonical folders, inside the places a workspace may be. */
export async function admitLibraryWorkspace(workspace: WorkspaceRequest['workspace']): Promise<LibraryWorkspace> {
  try {
    const admitted = await admitDirectorySettings({ workspaces: { primary: workspace.primary, additional: workspace.additional }, ...(workspace.repositories ? { repositories: workspace.repositories } : {}) }, { dataDir: paths.appDir });
    return { primary: admitted!.workspaces!.primary, additional: admitted!.workspaces!.additional, ...(admitted!.repositories ? { repositories: admitted!.repositories } : {}) };
  } catch (error) {
    const failure = directoryFailure(error);
    throw failure instanceof DirectoryError ? new AdminWriteError(failure.message) : failure;
  }
}

export function createHostLibrary(deps: LibraryHostDeps = {}): HostLibrary {
  // The host's own operations on workspaces run one at a time, so two fan-outs never interleave their archiving.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = chain.then(operation);
    chain = run.catch(() => undefined);
    return run;
  };
  const live = async (botId: string): Promise<boolean> => !!deps.executeLibrary && (await deps.liveStatus?.(botId).catch(() => undefined))?.running === true;
  /** The registered bots with a row of the project; a bot whose rows cannot be read is left out (the next start tells). */
  async function bindingBots(projectId: string): Promise<BotEntry[]> {
    const found: BotEntry[] = [];
    for (const bot of (await loadBots()).bots) {
      try { if ((await listProjectsIn(botPaths(bot.appId).projectsFile)).some(row => row.projectId === projectId)) found.push(bot); }
      catch { /* reported by step A and the drift check */ }
    }
    return found;
  }
  async function change(request: WorkspaceRequest): Promise<WorkspaceChange> {
    if (deps.readonlyPreview) throw new AdminWriteError('预览模式不能改工作区，请先启动 daemon');
    const workspace = await admitLibraryWorkspace(request.workspace);
    const bots = await bindingBots(request.projectId);
    if (request.refuseWhenBusy) {
      for (const bot of bots) {
        if (!await live(bot.appId)) continue;
        const answer = await deps.executeLibrary!(bot.appId, { kind: 'libraryWorkspaceCheck', projectId: request.projectId }) as { busy?: boolean };
        if (answer?.busy) throw new AdminWriteError(`共用这个项目的 Bot「${botLabel(bot)}」正在执行任务，请结束后修改工作区`);
      }
    }
    const written = await ownLibrary(draft => setLibraryWorkspace(draft, {
      projectId: request.projectId,
      revision: request.revision ?? draft.projects.find(project => project.id === request.projectId)?.revision ?? 0,
      workspace,
    }));
    // The library is released: a bot's own process takes `projects` next and must never wait for `library` (lock order).
    const rebound: WorkspaceChange['rebound'] = [];
    for (const bot of bots) {
      try {
        const outcomes = await live(bot.appId)
          ? await deps.executeLibrary!(bot.appId, { kind: 'libraryWorkspaceChanged', projectId: request.projectId }) as MirrorOutcome[]
          : await mirrorStoppedBot(bot.appId, request.projectId);
        rebound.push(...outcomes.map(outcome => ({ botId: bot.appId, ...outcome })));
      } catch (error) {
        log.fail('library', error, { phase: 'fan-out', botId: bot.appId, projectId: request.projectId });
        rebound.push({ botId: bot.appId, chatId: '', name: '', fields: [], state: 'failed', error: messageOf(error) });
      }
    }
    return { project: written.project, changed: written.changed, rebound };
  }
  return {
    overview: libraryOverview,
    workspace: request => serial(() => change(request)),
    previous: async (botId, chatId) => {
      const id = await previousProjectIdIn(botPaths(botId).projectsFile, chatId);
      const project = id ? (await readLibrary()).projects.find(item => item.id === id) : undefined;
      return project ? { id: project.id, name: project.name } : undefined;
    },
    rename: request => serial(async () => {
      if (deps.readonlyPreview) throw new AdminWriteError('预览模式不能改项目，请先启动 daemon');
      return (await ownLibrary(draft => renameLibraryProject(draft, request))).project;
    }),
    remove: request => serial(async () => {
      if (deps.readonlyPreview) throw new AdminWriteError('预览模式不能删项目，请先启动 daemon');
      await ownLibrary(async draft => {
        // Read-only on the rows, so allowed under `library` (lock order bots, library, projects, memory).
        if ((await bindingBots(request.projectId)).length) throw new AdminWriteError('这个项目还有群在用，先让群解绑或换到别的项目');
        await deleteLibraryProject(draft, request);
      });
    }),
    resetOverride: (projectId, key) => serial(async () => {
      const project = (await readLibrary()).projects.find(item => item.id === projectId);
      if (!project) throw new LibraryError('not-found', '项目不存在，请刷新');
      const { repositories: _repositories, ...rest } = project.workspace;
      const workspace = key === 'repositories' ? rest : { ...project.workspace, additional: [] };
      return change({ projectId, workspace });
    }),
  };
}
