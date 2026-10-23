import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { loadBots, type BotEntry } from '../config/bots';
import { botPaths, paths } from '../config/paths';
import { log } from '../core/logger';
import { migrateRoleFiles } from '../bot/role-files';
import { assertBridgeImportReservation } from '../import/bridge/reservation';
import { listProjectsIn, withStoredRows, type Project } from '../project/registry';
import {
  isProjectId, libraryLocation, newProjectId, ownLibrary, PROJECT_NAME_MAX, readLibrary, resolveDirectory,
  type LibraryProject, type LibraryWorkspace, type ResolvedDirectory,
} from '../project/library';

/**
 * host 一侧的项目库（记忆设计 §2.6 `admin/library.ts`）。P1a 只有启动时的迁移步骤 A、漂移检查和给
 * `vonvon project list` 的总览；`library.*` 服务和 IPC 扇出在 P1b。
 */

export interface LibraryStartupOptions {
  now?: () => number;
  /** Test seam: runs after a bot's new projects are in the library and before its rows name them. */
  afterLibraryWrite?: (botId: string) => void | Promise<void>;
}
export type DriftField = 'primary' | 'additional' | 'repositories';
/**
 * A project whose bindings' mirrors no longer match it. `repaired`: its bindings, all alike, were changed by a path
 * that still writes the row (P1b funnels them), so the library took their workspace. `shared`: bindings of one
 * project disagree with each other, left for the owner. `primary-taken`: their new main folder is another project's.
 */
export interface DriftNote { projectId: string; rows: number; fields: DriftField[]; outcome: 'repaired' | 'shared' | 'primary-taken' }
export interface LibraryStartupReport {
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

/**
 * Whether a project's main folder is `primary`, as stored or as it resolves now: a project made while its folder could
 * not be resolved holds the lexical path until the drift check corrects it. `resolved` caches each path's resolution.
 */
async function sameMain(project: LibraryProject, primary: string, resolved: Map<string, Promise<ResolvedDirectory>>): Promise<boolean> {
  const stored = project.workspace.primary;
  if (stored === primary) return true;
  if (!resolved.has(stored)) resolved.set(stored, resolveDirectory(stored));
  const now = await resolved.get(stored)!;
  return now.resolved && now.path === primary;
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
 * Step A for one bot (memory design §7.1), holding library → this bot's projects. Each row that needs it is linked to
 * the project whose main folder is the row's: the one made from it by a run cut off between the two writes, or one
 * two bindings of one folder were always sharing. A row whose folder cannot be resolved now goes to the project made
 * from it before (`migratedFrom`) instead. Otherwise a new project, under the row's own `projectId` when the library
 * lost that project, so whatever else names it finds it again. `migratedFrom` alone never decides for a row whose
 * folder resolves: a group unbound and bound again to another folder gets a new project, and the old one keeps its
 * folder (D4). A row joining a project by its folder brings nothing else: the project keeps the first row's extra
 * folders and repositories, and the drift check reports the difference (`shared`). The library is written first,
 * the rows second; a run that stops in between leaves projects the next run finds again, never an orphan.
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
      for (const item of draft.projects) if (!project && await sameMain(item, workspace.primary, mains)) project = item;
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
    if (created) {
      await draft.commit();
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

function driftFields(project: LibraryWorkspace, row: LibraryWorkspace): DriftField[] {
  const fields: DriftField[] = [];
  if (project.primary !== row.primary) fields.push('primary');
  if (JSON.stringify(project.additional) !== JSON.stringify(row.additional)) fields.push('additional');
  if (JSON.stringify(project.repositories ?? null) !== JSON.stringify(row.repositories ?? null)) fields.push('repositories');
  return fields;
}

/**
 * Startup drift check (memory design §2.1): each project against the mirrors in its binding rows, once, logged once
 * per project. Until P1b funnels every workspace write through the library, a row edited since step A is the newer
 * side, so a project whose bindings all mirror one workspace takes it; P1b turns this around to the library's.
 * Bindings that disagree with each other, or a move onto another project's main folder, are only reported. A row
 * whose folder cannot be resolved now (an unmounted volume behind a link) is left out: its lexical path is not an
 * edit, and taking it would flip the project at every mount and unmount.
 */
async function checkDrift(bots: readonly BotEntry[], report: LibraryStartupReport): Promise<void> {
  if (!(await readLibrary()).projects.length) return;
  await ownLibrary(async draft => {
    const ids = new Set(draft.projects.map(project => project.id));
    const bound = new Map<string, LibraryWorkspace[]>();
    for (const bot of bots) {
      let rows: Project[];
      // Unreadable rows were reported by step A just before.
      try { rows = await listProjectsIn(botPaths(bot.appId).projectsFile); } catch { continue; }
      for (const row of rows) {
        if (!isProjectId(row.projectId) || !ids.has(row.projectId)) continue;
        const mirror = await rowWorkspace(row);
        if (mirror.resolved) bound.set(row.projectId, [...bound.get(row.projectId) ?? [], mirror.workspace]);
      }
    }
    let changed = false;
    for (const project of draft.projects) {
      const mirrors = bound.get(project.id) ?? [];
      const fields = [...new Set(mirrors.flatMap(mirror => driftFields(project.workspace, mirror)))];
      if (!fields.length) continue;
      let outcome: DriftNote['outcome'] = 'shared';
      const [only, ...others] = mirrors;
      if (only && others.every(mirror => !driftFields(only, mirror).length)) {
        if (only.primary !== project.workspace.primary && draft.projects.some(other => other !== project && other.workspace.primary === only.primary)) outcome = 'primary-taken';
        else {
          project.workspace = only;
          project.revision += 1;
          changed = true;
          outcome = 'repaired';
        }
      }
      const note: DriftNote = { projectId: project.id, rows: mirrors.length, fields, outcome };
      report.drift.push(note);
      if (outcome === 'repaired') log.info('library', 'drift_repaired', { ...note });
      else log.warn('library', 'drift', { ...note });
    }
    if (changed) await draft.commit();
  });
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
