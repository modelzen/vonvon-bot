import { mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { paths } from '../config/paths';
import { acquireMutex, closeMutex, holdMutexRole } from '../config/data-access';
import { syncDirectory } from '../config/bot-namespace';
import { REASONING_EFFORTS, type PermissionMode, type ReasoningEffort } from '../agent/types';
import { admitDirectoryChanges, parseDirectorySettings, type DirectorySettings } from '../config/directories';
import type { JudgeSelectionStored } from '../judge/types';
import { isProjectId } from './library';

export interface BotProfile { persona: string; memory: string }
export interface GroupProfile extends BotProfile { inheritPersona: boolean; inheritMemory: boolean }
export interface ProjectModelAccess { backend: string; models: string[]; efforts: ReasoningEffort[] }
export interface ProjectWorkspace { primary: string; directories: string[]; repositories: string[] }
export interface ProjectSmartRules { respond: string; newTopic: string }
export interface ProjectSkills { disabledPaths: string[] }
export interface ProjectPresentation { voiceEnabled: boolean; showToolCalls: boolean; showModel?: 'off' | 'running' | 'always'; completionMode: 'manual' | 'long' | 'failures' | 'always'; longTaskMinutes: number }

/** A project = a Feishu group bound to a fixed working directory. */
export interface Project {
  profile?: GroupProfile;
  modelAccess?: ProjectModelAccess;
  smartRules?: ProjectSmartRules;
  skills?: ProjectSkills;
  presentation?: ProjectPresentation;
  /** unique project name (also the group name) */
  name: string;
  enabled?: boolean;
  creationRequestId?: string;
  creationRequestSignature?: string;
  /** the bound Feishu group chat_id (oc_xxx) */
  chatId: string;
  /** absolute working directory codex runs in for this project */
  cwd: string;
  /** Raw group overrides; absent repositories inherit, [] explicitly clears. */
  directories?: DirectorySettings;
  /** true when bridge created the cwd as a blank project (under projectsRootDir) */
  blank: boolean;
  createdAt: number;
  /** last branch shown in the announcement (for lazy change detection) */
  branch?: string;
  /** How the main area runs (product.md 3.4): 'multi' = 多会话, a topic per session;
   * 'single' = 单会话, the main area is one session keyed by chatId. Missing or unknown
   * reads as 'multi'. Read via {@link ruleKind}. */
  kind?: 'multi' | 'single';
  /** 智能 (3.4): stored with `kind: 'single'`, so a daemon from before s21 runs it as 单会话.
   * Every entry writes it through {@link storedMode} (s25c); a group that has it judges every message (s25, {@link noMentionOf}).
   * Read via {@link sessionModeOf}; switching to 多会话 or 单会话 drops it. */
  smart?: boolean;
  /** respond to non-@ messages too. Read as `noMention ?? defaultNoMention(p)`.
   * multi: only inside a topic; single: whole group. Needs im:message.group_msg. */
  noMention?: boolean;
  /** 运行中来了消息 for this group: steer (插话) or queue (排队). Unset inherits the bot's
   * `preferences.pendingPolicy`; read via {@link pendingPolicyOf}. */
  pendingPolicy?: 'steer' | 'queue';
  /** how the bot got into this group. 'created' (default, omitted on old data) =
   * bridge built the group via chat.create and is its owner; 'joined' = a human
   * added the bot to a pre-existing group and the bot is just a plain member. */
  origin?: 'created' | 'joined';
  /** for 'joined' projects: open_id of the person who added the bot + did the
   * bind (the bot DMs them the bind card / a removal notice). */
  addedBy?: string;
  /** 项目级响应白名单：谁能让 bot 在本群响应/跑 codex。空/缺省 = 所有人；
   * admin/owner 恒豁免（见 isUserAllowedInProject）。 */
  allowedUsers?: string[];
  /** the group's one permission tier for codex's sandbox: everyone in the group runs at it (s15c).
   * Omitted on old data → treated as 'full' (danger-full-access), preserving prior behavior.
   * Read via {@link effectiveMode}. 'qa'/'write' confine reads+writes to `cwd`. Old rows'
   * `guestMode` (a second tier for non-admins) is folded in on read, see {@link foldGuestTier}. */
  mode?: PermissionMode;
  /** allow the agent's shell to reach the network in 'qa'/'write' ('full' always can), and Vonvon to
   * fetch remote images in every tier. Default false. */
  network?: boolean;
  // Old projects.json rows may still carry `autoCompact: false`. Since s12 both
  // backends always auto-compact and nothing reads it; rows keep it until s60.
  /** agent backend id for this project (see src/agent/index.ts registry).
   * Omitted on old/normal data → the codex default (DEFAULT_BACKEND_ID — historical path,
   * zero behavior change). Routed per project in createOrchestrator's
   * backendFor(). Set via the DM 项目设置卡的「🧠 后端」picker（校验见
   * validateBackendSwitch）；只影响新话题——已有话题会话按 SessionRecord.backend
   * 仍走原后端. */
  backend?: string;
  /** 本项目**新话题**的默认模型 id。优先级在 per-session `/model` 覆盖之下、后端自带
   * 默认之上。跟项目 backend 走（创建时固定）；读取时经 {@link pickDefault} 对后端的
   * **实时**模型列表校验——不在列表里（改了后端 / 模型下架）即忽略、回落后端 isDefault，
   * 所以默认值自愈、永不把坏 id 喂给 CLI。只影响新会话，不动进行中 / 已 resume 的会话。
   * 在 DM 项目设置卡（或群 /settings 镜像）里设；仅管理员可改。 */
  defaultModel?: string;
  /** 本项目新话题的默认推理强度。仅当所选 {@link defaultModel} 支持该 effort 时生效，
   * 否则回落该模型的 defaultEffort（claude 等不调 effort 的后端忽略）。 */
  defaultEffort?: ReasoningEffort;
  /** true 表示 {@link defaultModel} 是手填的 id（3.11）：不在模型列表里也照用，不回落
   * 后端默认。选回列表里的模型时写 false。 */
  defaultModelCustom?: boolean;
  /** 智能模式的判断模型，覆盖 bot 层的（s23c）。`backend` 一定是存的时候群的后端；群后来换了后端，
   * 这一项不再适用、也不删。手改坏了当没设（parseStoredJudge）。 */
  judge?: JudgeSelectionStored;
  /** 这一行（某个 bot 在某个群）属于项目库里的哪个项目（project/library.ts）。host 启动时补上（记忆设计 7.1 步骤 A）；
   * 旧 daemon 不认这个键，读写都原样带着。不是字符串、或者库里没有这个项目，下次启动重新补。 */
  projectId?: string;
  /** 记忆设计 7.1 的分步标记，每步做完的时间（epoch ms）：`library` = 步骤 A，`memory` = 步骤 B。 */
  migration?: { library?: number; memory?: number };
}

/**
 * Default for 免@ (respond without @) when a project hasn't set `noMention`
 * explicitly. On for everything **except** a *joined* single-session group:
 * making the whole of a pre-existing (possibly busy / multi-person) group run
 * codex on every message without an @ is too aggressive, so that one combo
 * defaults off. Created groups (incl. single) keep the historical default (on),
 * so existing data is unaffected. Single source of truth — every
 * `noMention ?? …` read goes through here.
 */
export function defaultNoMention(p: Pick<Project, 'kind' | 'smart' | 'origin'>): boolean {
  return !((p.origin ?? 'created') === 'joined' && ruleKind(p) === 'single');
}

export type SessionMode = 'multi' | 'single' | 'smart';

/** The stored 会话方式; missing or unknown values read as 'multi' (rule mode, as before s21). */
export function sessionModeOf(p: Pick<Project, 'kind' | 'smart'>): SessionMode {
  // `smart` counts only with 'single': a daemon from before s21 that switched the group to 多会话 left it behind.
  if (p.kind !== 'single') return 'multi';
  return p.smart === true ? 'smart' : 'single';
}

/** How the main area runs. 智能's main area is one session, as 单会话; a judgement comes first (s25). */
export function ruleKind(p: Pick<Project, 'kind' | 'smart'>): 'multi' | 'single' {
  return sessionModeOf(p) === 'multi' ? 'multi' : 'single';
}

/** The group's effective 免@. 智能 has no 免@ (3.4): a judgement decides instead (s25, handle-message). */
export function noMentionOf(p: Pick<Project, 'kind' | 'smart' | 'origin' | 'noMention'>): boolean {
  if (sessionModeOf(p) === 'smart') return false;
  return p.noMention ?? defaultNoMention(p);
}

/** 免@ written for a new bind or a new group when the entry left it out (3.4): 多会话开，单会话关.
 * 智能 has none and always stores false, so a daemon from before s21 runs it as 单会话、仅 @ (s25c). */
export function bindNoMention(kind: SessionMode): boolean {
  return kind === 'multi';
}

/** The stored fields of a 会话方式 (s25c). 智能 keeps `kind: 'single'` and pins `noMention: false`: older daemons
 * read it as 单会话 that answers only an @. */
export function storedMode(mode: SessionMode): Pick<Project, 'kind' | 'smart'> & { noMention?: false } {
  return mode === 'smart' ? { kind: 'single', smart: true, noMention: false } : { kind: mode };
}

/** The group's 运行中来了消息: its own override, else the bot's. Claude cannot steer, so it queues. */
export function pendingPolicyOf(botPolicy: 'steer' | 'queue', p: Pick<Project, 'pendingPolicy' | 'backend'> | undefined): 'steer' | 'queue' {
  if (p?.backend === 'claude-agent') return 'queue';
  return p?.pendingPolicy ?? botPolicy;
}

/**
 * A project's effective permission tier. Old data (no `mode`) → 'full', so
 * existing projects keep danger-full-access and are unaffected; only an
 * explicitly-set tier confines the sandbox. Single source of truth — every
 * `mode ?? …` read goes through here.
 */
export function effectiveMode(p: Pick<Project, 'mode'>): PermissionMode {
  return p.mode ?? 'full';
}

const TIERS: readonly PermissionMode[] = ['qa', 'write', 'full'];

/** The stricter of two tiers (qa < write < full); a value that is not a tier counts as qa. */
export function stricterTier(a: unknown, b: unknown): PermissionMode {
  const rank = (t: unknown) => Math.max(0, TIERS.indexOf(t as PermissionMode));
  return TIERS[Math.min(rank(a), rank(b))]!;
}

/**
 * A row as the rest of the daemon sees it. Before s15c a row could carry
 * `guestMode`, a second tier for non-admins; a group has one tier now, the
 * stricter of the two. `null` meant "same as `mode`" and only drops the key.
 * Every write starts from read rows, so the next write of projects.json drops
 * the key from every row.
 */
function foldGuestTier(row: Project): Project {
  if (!Object.hasOwn(row, 'guestMode')) return row;
  const { guestMode, ...rest } = row as Project & { guestMode?: unknown };
  return guestMode == null ? rest : { ...rest, mode: stricterTier(effectiveMode(rest), guestMode) };
}

interface StoreFile {
  version: number;
  projects: Project[];
}

const FILE_VERSION = 1;

async function read(file = paths.projectsFile): Promise<Project[]> {
  return listProjectsIn(file);
}

/** 读取指定 projects.json（绝对路径）。Web 控制台 / supervisor 跨 bot 聚合视图
 * 专用——daemon 进程内绝不可用 useBotDir 全局切目录，显式路径才安全。文件缺失
 * 视为空注册表（与当前 bot 路径同语义）。 */
export async function listProjectsIn(file: string): Promise<Project[]> {
  try {
    const text = await readFile(file, 'utf8');
    return storedRows(JSON.parse(text)).map(foldGuestTier);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The rows of a parsed projects.json, as stored (no fold); any malformed row fails the whole file. */
function storedRows(parsed: unknown): Project[] {
  const file = parsed as Partial<StoreFile> | null;
  if (!file || !Array.isArray(file.projects) || file.projects.some(p => !p || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.cwd !== 'string')) throw new Error('项目注册表格式无效');
  for (const project of file.projects) { parseDirectorySettings(project.directories); validateGroupSettings(project as unknown as Record<string, unknown>); }
  return file.projects;
}

/**
 * Top-level key of projects.json (s15c): the chats a failed start left for
 * {@link splitTierChats}. A row loses `guestMode` at the next write, whatever
 * it is for; this key outlives that (write keeps top-level keys) until a merge
 * succeeds.
 */
const TIER_MERGE_PENDING = 'tierMergePending';

/**
 * Groups whose stored row still has two tiers (s15c), chat id → the stricter
 * one they run at now. Read as stored, before the fold, with the comparison
 * the old split made: admins of exactly these groups talked in `<place>#admin`
 * sessions. Bound chats named by {@link setTierMergePending} count too, folded
 * or not. A missing file has none.
 */
export async function splitTierChats(file = paths.projectsFile): Promise<Map<string, PermissionMode>> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }
  const stored = JSON.parse(text) as Partial<StoreFile> & { [TIER_MERGE_PENDING]?: unknown };
  const pending = new Set(Array.isArray(stored[TIER_MERGE_PENDING]) ? stored[TIER_MERGE_PENDING] : []);
  const split = new Map<string, PermissionMode>();
  for (const row of Array.isArray(stored.projects) ? stored.projects : []) {
    const raw = row as Project & { guestMode?: unknown };
    if (!raw || typeof raw.chatId !== 'string') continue;
    if ((raw.guestMode != null && raw.guestMode !== effectiveMode(raw)) || pending.has(raw.chatId)) split.set(raw.chatId, effectiveMode(foldGuestTier(raw)));
  }
  return split;
}

export type RegistryLocation = Readonly<{ file: string; dataRoot: string }>;
let opChain: Promise<unknown> = Promise.resolve();
/** Lock order bots → library → projects (data-access.ts): inside an operation here, `library` and another `projects` are refused. */
function ownProjects<T>(operation: (location: RegistryLocation) => Promise<T>, target: RegistryLocation = { file: paths.projectsFile, dataRoot: paths.appDir }): Promise<T> {
  const captured = { ...target };
  return holdMutexRole('projects', () => queueProjects(operation, captured));
}
function queueProjects<T>(operation: (location: RegistryLocation) => Promise<T>, captured: RegistryLocation): Promise<T> {
  const run = opChain.then(async () => {
    await mkdir(dirname(captured.file), { recursive: true });
    const parent = await realpath(dirname(captured.file));
    const location = { ...captured, file: join(parent, basename(captured.file)) };
    const mutex = await acquireMutex(parent, 'projects', 30_000);
    let result: T;
    try { result = await operation(location); }
    catch (error) {
      try { await closeMutex(mutex); }
      catch (releaseError) { throw new AggregateError([error, releaseError], 'Project operation and mutex release failed'); }
      throw error;
    }
    await closeMutex(mutex);
    return result;
  });
  opChain = run.catch(() => undefined);
  return run;
}

/** projects.json as stored, `{}` when missing. */
async function readStored(file: string): Promise<Record<string, unknown>> {
  return readFile(file, 'utf8').then(text => JSON.parse(text)).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
}

type DirectoryRow = Pick<Project, 'name' | 'cwd'> & Record<string, unknown>;
function isDirectoryRow(row: unknown): row is DirectoryRow {
  return typeof row === 'object' && row !== null && !Array.isArray(row)
    && 'name' in row && typeof row.name === 'string' && 'cwd' in row && typeof row.cwd === 'string';
}
function directoryRows(raw: unknown): DirectoryRow[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('项目注册表格式无效');
  const rows: unknown[] = raw;
  return rows.map(row => {
    if (!isDirectoryRow(row)) throw new Error('项目注册表格式无效');
    return row;
  });
}

/** A row that names a project, which holds its folders; the row's own `cwd` and `directories` only mirror them (§2.1). */
function isBoundRow(row: Record<string, unknown>): row is Record<string, unknown> & { projectId: string } { return isProjectId(row.projectId); }
const foldersOf = (row: Record<string, unknown>): string => {
  const directories = (row.directories ?? {}) as DirectorySettings;
  return JSON.stringify([row.cwd, directories.workspaces ?? null, directories.repositories ?? null]);
};

/**
 * The stored shape of a row's settings blocks: the registry's own copy (memory design §2.2), equal today to the
 * protocol's section schemas they were checked with, so a later protocol change to a section (`profile` → `role`)
 * cannot make rows already on disk unreadable. New fields get their limits where they are written, not here: one
 * row that fails here fails the whole file.
 */
const storedSectionSchemas = {
  profile: z.object({ persona: z.string().max(30000), memory: z.string().max(30000), inheritPersona: z.boolean(), inheritMemory: z.boolean() }),
  modelAccess: z.object({ backend: z.string().min(1).max(1000), models: z.array(z.string().trim().min(1).max(1000)).max(1000), efforts: z.array(z.enum(REASONING_EFFORTS)).max(8) }),
  smartRules: z.object({ respond: z.string().max(30000), newTopic: z.string().max(30000) }),
  skills: z.object({ disabledPaths: z.array(z.string().min(1).max(4096)).max(1000) }),
  presentation: z.object({ voiceEnabled: z.boolean(), showToolCalls: z.boolean(), showModel: z.enum(['off', 'running', 'always']).optional(),
    completionMode: z.enum(['manual', 'long', 'failures', 'always']), longTaskMinutes: z.number().int().min(1).max(1440) }),
};

/** Explicit group settings never silently fall back to broader Bot permissions when malformed. */
function validateGroupSettings(row: Record<string, unknown>): void {
  for (const key of ['profile', 'modelAccess', 'smartRules', 'skills', 'presentation'] as const) {
    if (row[key] !== undefined && !storedSectionSchemas[key].safeParse(row[key]).success) throw new Error(`Invalid group settings: ${key}`);
  }
  const access = row.modelAccess as ProjectModelAccess | undefined;
  if (access && (!access.models.length || new Set(access.models).size !== access.models.length || new Set(access.efforts).size !== access.efforts.length)) throw new Error('Invalid group settings: modelAccess');
}

async function writeStored(location: RegistryLocation, body: Record<string, unknown>, previous: Record<string, unknown>, beforeCommit?: () => void, durable = false, mirror = false): Promise<void> {
  // Both callers own detached rows and a separate previous disk snapshot.
  const next = body;
  const oldProjects = directoryRows(previous.projects);
  const nextProjects = directoryRows(next.projects);
  for (const row of nextProjects) {
    validateGroupSettings(row);
    const directories = parseDirectorySettings(row.directories);
    const old = oldProjects.find(project => project.chatId === row.chatId && project.name === row.name);
    const oldDirectories = parseDirectorySettings(old?.directories);
    if (!mirror && old && isBoundRow(row) && isBoundRow(old) && row.projectId === old.projectId && foldersOf(row) !== foldersOf(old)) {
      throw new Error('这个群的工作区归项目管，请改项目的工作区（library.workspace），不要直接改群的目录');
    }
    if (directories?.workspaces && (row.cwd !== old?.cwd
      || JSON.stringify(directories.workspaces) !== JSON.stringify(oldDirectories?.workspaces))) {
      let cwd: string;
      try { cwd = await realpath(row.cwd); }
      catch { throw new Error('Invalid directory settings: directories.workspaces.primary (cwd unavailable)'); }
      // A legacy explicit cwd edit also updates a declaration that still names the old primary.
      if (oldDirectories?.workspaces && row.cwd !== old?.cwd && directories.workspaces.primary === oldDirectories.workspaces.primary) {
        directories.workspaces.primary = cwd;
        row.directories = directories;
      }
      if (directories.workspaces.primary !== cwd) throw new Error('Invalid directory settings: directories.workspaces.primary (must match cwd)');
    }
    await admitDirectoryChanges(directories, oldDirectories, location.dataRoot);
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = `${location.file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    if (durable) {
      const file = await open(tmp, 'wx');
      let failed = false;
      try { await file.writeFile(serialized, 'utf8'); await file.sync(); }
      catch (error) { failed = true; throw error; }
      finally { try { await file.close(); } catch (error) { if (!failed) throw error; } }
    } else await writeFile(tmp, serialized, 'utf8');
    beforeCommit?.();
    await rename(tmp, location.file);
  } catch (error) {
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  if (durable) await syncDirectory(dirname(location.file));
}

export interface ProjectCommitOptions {
  beforeCommit?: () => void;
  /** Set only by the host's workspace funnel (admin/library.ts): the one writer allowed to change the folders of a row
   * that belongs to a library project, to make them the project's again. */
  mirror?: boolean;
}
async function write(location: RegistryLocation, projects: Project[], selected?: undefined, options?: ProjectCommitOptions): Promise<void>;
async function write(location: RegistryLocation, projects: Project[], selected: Project, options?: ProjectCommitOptions): Promise<Project>;
async function write(location: RegistryLocation, projects: Project[], selected?: Project, options?: ProjectCommitOptions): Promise<Project | void> {
  const detached: Project[] = JSON.parse(JSON.stringify(projects));
  const result = selected === undefined ? undefined : detached[projects.indexOf(selected)];
  if (selected !== undefined && result === undefined) throw new Error('待保存的项目不存在');
  const previous = await readStored(location.file);
  await writeStored(location, { ...previous, version: FILE_VERSION, projects: detached }, previous, options?.beforeCommit, false, options?.mirror === true);
  return result;
}

/**
 * s15c: name the chats whose tier merge failed, so the next start retries them
 * after a write has dropped `guestMode`; an empty list drops the key. Rows stay
 * as stored. Writes only when there is something to change.
 */
export async function setTierMergePending(chats: readonly string[]): Promise<void> {
  const capturedChats = [...chats];
  return ownProjects(async location => {
    const stored = await readStored(location.file);
    if (!Array.isArray(stored.projects) || (!capturedChats.length && !Object.hasOwn(stored, TIER_MERGE_PENDING))) return;
    const previous: Record<string, unknown> = JSON.parse(JSON.stringify(stored));
    if (capturedChats.length) stored[TIER_MERGE_PENDING] = capturedChats;
    else delete stored[TIER_MERGE_PENDING];
    await writeStored(location, stored, previous);
  });
}

/**
 * Runs `operation` on the rows of `target` as stored (no fold: a pre-s15c `guestMode` stays for
 * {@link splitTierChats}) under the projects owner, and writes them back when it returns true. For keys the rest of
 * the daemon does not read yet (`projectId`, `migration`): its callers add keys and leave a row's directories alone.
 * The write is synced before and after the rename: the startup migration rewrites every bot's file once, stopped
 * bots' too, and a power cut must not leave one of them empty (an empty file stops that bot from starting).
 */
export function withStoredRows(target: RegistryLocation, operation: (rows: Project[]) => Promise<boolean>): Promise<void> {
  return ownProjects(async location => {
    const stored = await readStored(location.file);
    if (stored.projects === undefined) return;
    const rows = storedRows(stored);
    const previous: Record<string, unknown> = JSON.parse(JSON.stringify(stored));
    if (await operation(rows)) await writeStored(location, { ...stored, version: FILE_VERSION, projects: rows }, previous, undefined, true);
  }, target);
}

export async function listProjects(): Promise<Project[]> {
  return read();
}

export async function getProjectByChatId(chatId: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.chatId === chatId);
}

export async function getProjectByName(name: string): Promise<Project | undefined> {
  return (await read()).find((p) => p.name === name);
}

/** Add a project. Throws if the name — or the bound chat — is already taken.
 * The chatId check is the registry-level hard guard against binding one group
 * twice (createProject's chatId is freshly minted so it never trips). */
export async function addProject(input: Project, target?: RegistryLocation): Promise<void> {
  const p = structuredClone(input);
  return ownProjects(async location => {
    const projects = await read(location.file);
    if (projects.some((x) => x.name === p.name)) {
      throw new Error(`项目名「${p.name}」已存在`);
    }
    if (p.chatId) {
      const bound = projects.find((x) => x.chatId === p.chatId);
      if (bound) throw new Error(`该群已绑定为项目「${bound.name}」`);
    }
    projects.push(p);
    await write(location, projects);
  }, target);
}

/**
 * Top-level key of projects.json (s36c2d): chat id → the directory a row from before s36c2c3 (one without
 * `directories`) had when its group was unbound. Binding the group again with the default directory goes back there,
 * as it did before s36c2c3, instead of a new empty one; rows from s36c2c3 on come back through their allocation.
 */
const PREVIOUS_DIRECTORIES = 'previousDirectories';
export type PreviousDirectory = { cwd: string; blank: boolean };
function previousDirectories(stored: Record<string, unknown>): Record<string, PreviousDirectory> {
  const raw = stored[PREVIOUS_DIRECTORIES];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, PreviousDirectory] => {
    const value: unknown = entry[1];
    return typeof value === 'object' && value !== null && 'cwd' in value && typeof value.cwd === 'string' && 'blank' in value && typeof value.blank === 'boolean';
  }));
}

/**
 * Top-level key of projects.json: chat id → the library project the group's row had when it was unbound, so binding
 * the group again can offer "接回" that project (§2.1; the same precedent as {@link PREVIOUS_DIRECTORIES}). Kept for
 * every unbound row that had a project, whatever its age.
 */
const PREVIOUS_PROJECTS = 'previousProjects';
function previousProjects(stored: Record<string, unknown>): Record<string, string> {
  const raw = stored[PREVIOUS_PROJECTS];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => isProjectId(entry[1])));
}
/** The directory the group `chatId` had when it was unbound, if the bot's file remembers one (rows from before s36c2c3). */
export async function previousDirectoryIn(file: string, chatId: string): Promise<PreviousDirectory | undefined> {
  return previousDirectories(await readStored(file))[chatId];
}
/** The library project the group `chatId` was bound to before it was unbound, if the bot's file remembers one. */
export async function previousProjectIdIn(file: string, chatId: string): Promise<string | undefined> {
  return previousProjects(await readStored(file))[chatId];
}

type ProjectBinding = Pick<Project, 'name' | 'chatId'> & {
  /** A new group has no `legacyPath`: its chat id is fresh, so no stored row is compared with it. */
  cwd: { kind: 'existing'; path: string } | { kind: 'default'; legacyPath?: string; allocatedPath?: string };
  backend: string;
  defaultBackend: string;
  kind: SessionMode;
  noMention: boolean;
  /** The library project this binding belongs to, made before this call (project/library.ts, §2.1): the row names it
   * and carries the step-A marker, so the next start does not migrate it again. Left out → the row waits for step A. */
  project?: { id: string };
};
type NewBinding = Pick<Project, 'cwd' | 'blank' | 'createdAt' | 'directories' | 'origin' | 'addedBy' | 'mode' | 'backend' | 'network' | 'creationRequestId' | 'creationRequestSignature'> & Partial<Pick<Project, 'migration'>>;
type BindingResult = { kind: 'bound'; project: Project } | { kind: 'existing'; project: Project };

/** Decide against the latest row under the projects owner. prepareNew is local
 * filesystem work only; callers send welcomes after this operation releases. A
 * default binding hands it the chat's {@link PreviousDirectory}, if any. */
export function bindProject(input: ProjectBinding, prepareNew: (previous?: PreviousDirectory) => Promise<NewBinding>, target?: RegistryLocation): Promise<BindingResult> {
  const binding = structuredClone(input);
  return ownProjects(async location => {
    const projects = await read(location.file);
    const previous = binding.cwd.kind === 'default' ? previousDirectories(await readStored(location.file))[binding.chatId] : undefined;
    const existing = projects.find(project => project.chatId === binding.chatId);
    if (existing) {
      const cwd = await realpath(existing.cwd).catch(() => existing.cwd);
      const candidates = binding.cwd.kind === 'existing' ? [binding.cwd.path]
        : [binding.cwd.legacyPath, binding.cwd.allocatedPath, previous?.cwd].filter((path): path is string => path !== undefined);
      const requested = await Promise.all(candidates.map(path => realpath(path).catch(() => path)));
      if (existing.name === binding.name && requested.includes(cwd)
        && (existing.backend ?? binding.defaultBackend) === binding.backend
        && sessionModeOf(existing) === binding.kind && noMentionOf(existing) === binding.noMention) {
        return { kind: 'existing', project: existing };
      }
      throw new Error(`该群已绑定为项目「${existing.name}」，现有文件夹、后端和会话方式不可修改，免 @ 请在群设置里改`);
    }
    if (projects.some(project => project.name === binding.name)) throw new Error(`项目名「${binding.name}」已存在`);
    const prepared = await prepareNew(previous);
    if (binding.cwd.kind === 'existing' && prepared.cwd !== binding.cwd.path) throw new Error('工作目录已改变，请重新选择');
    const project: Project = { ...prepared, name: binding.name, chatId: binding.chatId,
      noMention: binding.noMention, ...storedMode(binding.kind),
      ...(binding.project ? { projectId: binding.project.id, migration: { ...prepared.migration, library: Date.now() } } : {}) };
    projects.push(project);
    return { kind: 'bound', project: await write(location, projects, project) };
  }, target);
}

/** Patch fields of a project by name; no-op if it doesn't exist. `patch` 可以是
 * 对象，或一个 `(p) => patch` 函数——后者在同一临界区内基于**最新盘值**计算补丁，
 * 用于数组增量改写（如 allowedUsers append/filter）避免丢更新。 */
export async function updateProject(
  name: string,
  patch: Partial<Omit<Project, 'name'>> | ((p: Project) => Partial<Omit<Project, 'name'>>),
  options?: ProjectCommitOptions,
): Promise<void> {
  const capturedPatch = typeof patch === 'function' ? patch : structuredClone(patch);
  return ownProjects(async location => {
    const projects = await read(location.file);
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    const actual = typeof capturedPatch === 'function' ? capturedPatch(p) : capturedPatch;
    const target = p as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v !== undefined) target[k] = v;
    }
    await write(location, projects, undefined, options);
  });
}

/** Remove (unbind) a project by name. Returns the removed entry, if any. A row
 * from before s36c2c3 leaves its directory as the chat's {@link PreviousDirectory}. */
export async function removeProject(name: string, beforeRemove?: (project: Project) => void): Promise<Project | undefined> {
  return ownProjects(async location => {
    const projects = await read(location.file);
    const idx = projects.findIndex((p) => p.name === name);
    if (idx === -1) return undefined;
    beforeRemove?.(projects[idx]!);
    const [removed] = projects.splice(idx, 1);
    const previous = await readStored(location.file);
    const keepDirectory = !!removed?.chatId && !removed.directories?.workspaces;
    const keepProject = !!removed?.chatId && isProjectId(removed.projectId);
    if (!removed || (!keepDirectory && !keepProject)) {
      await write(location, projects);
      return removed;
    }
    const remembered: Record<string, unknown> = {};
    if (keepDirectory) remembered[PREVIOUS_DIRECTORIES] = { ...previousDirectories(previous), [removed.chatId]: { cwd: removed.cwd, blank: removed.blank === true } };
    if (keepProject) remembered[PREVIOUS_PROJECTS] = { ...previousProjects(previous), [removed.chatId]: removed.projectId };
    await writeStored(location, { ...previous, version: FILE_VERSION, projects: JSON.parse(JSON.stringify(projects)), ...remembered }, previous);
    return removed;
  });
}

export async function mutateProject(name: string, mutate: (project: Project) => void | Promise<void>, options?: ProjectCommitOptions, location?: RegistryLocation): Promise<Project> {
  return ownProjects(async location => {
    const projects = await read(location.file);
    const project = projects.find(item => item.name === name);
    if (!project) throw new Error('项目不存在');
    await mutate(project);
    return write(location, projects, project, options);
  }, location);
}

/** Remove exactly one raw directory override; other keys/settings are retained. */
export async function resetProjectDirectoryOverride(name: string, key: keyof DirectorySettings): Promise<void> {
  return ownProjects(async location => {
    const projects = await read(location.file);
    const project = projects.find(item => item.name === name);
    if (!project?.directories || !Object.hasOwn(project.directories, key)) return;
    // A row of a library project mirrors it: the override goes in the project (admin/library.ts `resetWorkspaceOverride`).
    if (isProjectId(project.projectId)) throw new Error('这个群的工作区归项目管，请改项目的工作区（library.workspace），不要直接改群的目录');
    delete project.directories[key];
    await write(location, projects);
  });
}
