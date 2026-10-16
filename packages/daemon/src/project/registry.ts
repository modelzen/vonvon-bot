import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { paths } from '../config/paths';
import type { PermissionMode, ReasoningEffort } from '../agent/types';

/** A project = a Feishu group bound to a fixed working directory. */
export interface Project {
  /** unique project name (also the group name) */
  name: string;
  enabled?: boolean;
  creationRequestId?: string;
  creationRequestSignature?: string;
  /** the bound Feishu group chat_id (oc_xxx) */
  chatId: string;
  /** absolute working directory codex runs in for this project */
  cwd: string;
  /** true when bridge created the cwd as a blank project (under projectsRootDir) */
  blank: boolean;
  createdAt: number;
  /** last branch shown in the announcement (for lazy change detection) */
  branch?: string;
  /** group session model: 'multi' (default) = a topic per session (现状);
   * 'single' = the whole group is one session keyed by chatId. */
  kind?: 'multi' | 'single';
  /** respond to non-@ messages too. Read as `noMention ?? defaultNoMention(p)`.
   * multi: only inside a topic; single: whole group. Needs im:message.group_msg. */
  noMention?: boolean;
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
export function defaultNoMention(p: Pick<Project, 'kind' | 'origin'>): boolean {
  return !((p.origin ?? 'created') === 'joined' && (p.kind ?? 'multi') === 'single');
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

async function read(): Promise<Project[]> {
  return listProjectsIn(paths.projectsFile);
}

/** 读取指定 projects.json（绝对路径）。Web 控制台 / supervisor 跨 bot 聚合视图
 * 专用——daemon 进程内绝不可用 useBotDir 全局切目录，显式路径才安全。文件缺失
 * 视为空注册表（与当前 bot 路径同语义）。 */
export async function listProjectsIn(file: string): Promise<Project[]> {
  try {
    const text = await readFile(file, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    if (!parsed || !Array.isArray(parsed.projects) || parsed.projects.some(p => !p || typeof p !== 'object' || typeof p.name !== 'string' || typeof p.cwd !== 'string')) throw new Error('项目注册表格式无效');
    return parsed.projects.map(foldGuestTier);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
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

// 同进程内并发的「读-改-写」串行化（addProject/updateProject/removeProject）：既防
// 共用 tmp 文件交错损坏，也防两个回调基于同一旧快照算 next、后写覆盖前写的丢更新
// （白名单数组增删最易踩中）。配合函数式 updater，把 read+算+write 收进一个临界区。
let opChain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = opChain.then(fn, fn);
  opChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** projects.json as stored, `{}` when missing. */
async function readStored(): Promise<Record<string, unknown>> {
  return readFile(paths.projectsFile, 'utf8').then(text => JSON.parse(text)).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
}

async function writeStored(body: object): Promise<void> {
  await mkdir(dirname(paths.projectsFile), { recursive: true });
  const tmp = `${paths.projectsFile}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  await rename(tmp, paths.projectsFile);
}

async function write(projects: Project[]): Promise<void> {
  const body: StoreFile = { ...(await readStored()), version: FILE_VERSION, projects };
  await writeStored(body);
}

/**
 * s15c: name the chats whose tier merge failed, so the next start retries them
 * after a write has dropped `guestMode`; an empty list drops the key. Rows stay
 * as stored. Writes only when there is something to change.
 */
export async function setTierMergePending(chats: readonly string[]): Promise<void> {
  return withLock(async () => {
    const stored = await readStored();
    if (!Array.isArray(stored.projects) || (!chats.length && !Object.hasOwn(stored, TIER_MERGE_PENDING))) return;
    if (chats.length) stored[TIER_MERGE_PENDING] = [...chats];
    else delete stored[TIER_MERGE_PENDING];
    await writeStored(stored);
  });
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
export async function addProject(p: Project): Promise<void> {
  return withLock(async () => {
    const projects = await read();
    if (projects.some((x) => x.name === p.name)) {
      throw new Error(`项目名「${p.name}」已存在`);
    }
    if (p.chatId) {
      const bound = projects.find((x) => x.chatId === p.chatId);
      if (bound) throw new Error(`该群已绑定为项目「${bound.name}」`);
    }
    projects.push(p);
    await write(projects);
  });
}

/** Patch fields of a project by name; no-op if it doesn't exist. `patch` 可以是
 * 对象，或一个 `(p) => patch` 函数——后者在同一临界区内基于**最新盘值**计算补丁，
 * 用于数组增量改写（如 allowedUsers append/filter）避免丢更新。 */
export async function updateProject(
  name: string,
  patch: Partial<Omit<Project, 'name'>> | ((p: Project) => Partial<Omit<Project, 'name'>>),
): Promise<void> {
  return withLock(async () => {
    const projects = await read();
    const p = projects.find((x) => x.name === name);
    if (!p) return;
    const actual = typeof patch === 'function' ? patch(p) : patch;
    const target = p as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(actual)) {
      if (v !== undefined) target[k] = v;
    }
    await write(projects);
  });
}

/** Remove (unbind) a project by name. Returns the removed entry, if any. */
export async function removeProject(name: string, beforeRemove?: (project: Project) => void): Promise<Project | undefined> {
  return withLock(async () => {
    const projects = await read();
    const idx = projects.findIndex((p) => p.name === name);
    if (idx === -1) return undefined;
    beforeRemove?.(projects[idx]!);
    const [removed] = projects.splice(idx, 1);
    await write(projects);
    return removed;
  });
}

export async function mutateProject(name: string, mutate: (project: Project) => void | Promise<void>): Promise<Project> {
  return withLock(async () => {
    const projects = await read();
    const project = projects.find(item => item.name === name);
    if (!project) throw new Error('项目不存在');
    await mutate(project);
    await write(projects);
    return project;
  });
}
