import { pendingGroupsFile, retireBoundPendingGroup } from './pending-groups';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { botPaths } from '../config/paths';
import { assertBotIdentity, withBotGroupBinding, type BotIdentity } from '../config/bots';
import { admitDirectorySettings, resolveProjectsRootDir } from '../config/directories';
import { log } from '../core/logger';
import { feishuError } from '../utils/feishu-error';
import { addProject, bindNoMention, bindProject, listProjectsIn, type Project, type RegistryLocation } from './registry';
import type { PermissionMode } from '../agent/types';
import { DEFAULT_BACKEND_ID, effectiveDefaultBackend, isBackendEntryInstalled } from '../agent';
import { catalogById, isInstallable, projectCreatableBackends } from '../agent/catalog';
import { setAnnouncement } from './announcement';
import { onboardGroup } from './onboarding';
import { CreationClientClosedError, withCreationClient } from './creation-client';

/**
 * 校验「创建时选定的后端」此刻仍可用（已下载 + 支持该权限档）。防御卡渲染与提交之间
 * 的卸载竞态——否则会把无效后端写进项目，直到建会话才 fail-closed 报错。复用
 * {@link projectCreatableBackends} 的同源过滤（codex external-cli 基线特判，恒可用）。
 * backend 未设（落回默认 codex）直接放行。
 */
export function assertBackendUsable(backend: string | undefined, mode: PermissionMode): void {
  if (!backend) return;
  const ok = projectCreatableBackends(mode, isBackendEntryInstalled).some((e) => e.id === backend);
  if (ok) return;
  // 选了一个「未下载」的后端（下拉里标注了「未下载」的项）：给可下载的明确指引去 Web 下载，
  // 等价于「置灰提示」（Feishu 下拉无法对单项真置灰，故选中后在此友好拦截）。
  const entry = catalogById(backend);
  if (entry && isInstallable(entry)) {
    throw new Error(`「${entry.displayName}」尚未下载——请到 Web 控制台「后端 Agent」页点「下载」装好后，再回卡片选用。`);
  }
  throw new Error(`所选后端「${backend}」当前不可用（未下载或不支持该权限档），请回卡片重新选择`);
}

export function bindModeFor(backend?: string): PermissionMode | undefined {
  const modes = backend ? catalogById(backend)?.supportedModes : undefined;
  if (modes && !modes.includes('qa')) return modes.includes('full') ? 'full' : modes[0];
  return undefined;
}

export interface CreateProjectInput {
  /** Feishu's dedupe key for this one creation (chat.create `uuid`, at most 50 characters): the web makes one per
   * RPC, the DM one per card click. Nothing retries chat.create; a retry would have to reuse it. */
  requestId: string;
  requestSignature?: string;
  /** The registered bot this process runs as. Checked before Feishu is called; the default directory is under it. */
  bot: BotIdentity;
  name: string;
  /** DM sender open_id — invited to the new group + set as a member. */
  ownerOpenId: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** optional config.json override for the parent directory of blank projects. */
  projectsRootDir?: string;
  /** 会话方式, required: every entry asks for it (product.md 3.4). */
  kind: 'multi' | 'single';
  /** 免@; left out → {@link bindNoMention}. Always written, so a later 会话方式 switch keeps it. */
  noMention?: boolean;
  /** permission tier (default 'full' for self-created projects). */
  mode?: PermissionMode;
  /** agent backend chosen at creation (fixed afterwards — no switching). Left out (the DM form shows no picker
   *  for a single backend) → the effective default the runtime used to fall back to, written into the row so the
   *  group never follows a later default (s36d1). */
  backend?: string;
  /** allow the sandboxed shell to reach the network (default false). */
  network?: boolean;
  /** Stops every Feishu call of this creation, for the daemon's shutdown. */
  signal?: AbortSignal;
  /** One budget for every Feishu call: token, create, admin, announcement and welcome. Default {@link CREATION_BUDGET_MS}. */
  timeoutMs?: number;
}

export const CREATION_BUDGET_MS = 30_000;
/** What the owner (2026-10-18) has the person told when a creation's result is not known. */
export const CREATION_UNKNOWN = '可能已经建好了，先去飞书看一眼再重试';
/** Feishu's "the group is being created" (uuid-contract.md): no proof that no group came of it. */
const CREATING_CODE = 232068;
/** Network failures before a connection exists: the request never reached Feishu. */
const UNSENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

/** Nothing was created: the request never left, or Feishu answered with a refusal. */
export class CreationRefusedError extends Error {}
/** chat.create was sent and no answer says what came of it: a group may exist. */
export class CreationOutcomeUnknownError extends Error {
  constructor(readonly reason: unknown) { super(CREATION_UNKNOWN); }
}
/** {@link CreatedButUnsavedError}'s code. It crosses the admin IPC, so the web also hears "created" and locks its form. */
export const CREATED_UNSAVED = 'CREATED_UNSAVED';
/** The group exists on Feishu but its row was not saved. Creating again would make a second group. */
export class CreatedButUnsavedError extends Error {
  readonly code = CREATED_UNSAVED;
  constructor(readonly chatId: string, name: string, reason: unknown) {
    super(`群「${name}」已建好，但没存上：${reason instanceof Error ? reason.message : String(reason)}。请在网页「加入现有飞书群」→「查找已经加入的群」里选它绑定，不要再建。绑回来是只读，要完全访问就到群设置里改`);
  }
}

/** What a chat.create failure means. Only a refusal Feishu answered, or a request that never left, says no group exists. */
function creationFailure(error: unknown, dispatched: boolean): Error {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  const code = (error as { code?: unknown } | null)?.code;
  if (!dispatched || (status === undefined && typeof code === 'string' && UNSENT_CODES.has(code))) {
    return new CreationRefusedError(`没有发出建群请求：${error instanceof CreationClientClosedError ? '已超时或已取消' : error instanceof Error ? error.message : String(error)}`);
  }
  const feishu = feishuError(error);
  if (feishu && feishu.code !== CREATING_CODE && typeof status === 'number' && status < 500) return new CreationRefusedError(`飞书拒绝建群 code=${feishu.code}：${feishu.msg ?? '没有说明'}`);
  return new CreationOutcomeUnknownError(error);
}

export interface JoinGroupInput {
  bot: BotIdentity;
  /** project name — editable in the bind card, defaults to the group's name. */
  name: string;
  /** the pre-existing group the bot was added to. */
  chatId: string;
  /** open_id of the admin who added the bot + submitted the bind. */
  addedBy?: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** optional config.json override for the parent directory of blank projects. */
  projectsRootDir?: string;
  /** 会话方式, required: every entry asks for it (product.md 3.4). */
  kind: 'multi' | 'single';
  /** 免@; left out → {@link bindNoMention}. */
  noMention?: boolean;
  /** permission tier (default 'qa' — read-only — for joined external groups). */
  mode?: PermissionMode;
  /** agent backend chosen at bind time (fixed afterwards — no switching). */
  backend?: string;
  /** allow the sandboxed shell to reach the network (default false). */
  network?: boolean;
}

/**
 * Admit an explicit `existingPath` (must exist, outside protected locations).
 * Throws before any group is touched so a bad path never leaves an orphan group.
 * A default directory is allocated by {@link withBotGroupBinding} once the group exists.
 */
async function admitExistingDirectory(existingPath: string, dataDir: string): Promise<Pick<Project, 'cwd' | 'blank' | 'directories'>> {
  const directories = await admitDirectorySettings({ workspaces: { primary: existingPath, additional: [] } }, { dataDir });
  if (!directories?.workspaces) throw new Error('Invalid directory settings: directories.workspaces.primary');
  return { cwd: directories.workspaces.primary, blank: false, directories };
}

/**
 * Create a project: check everything local, create a bound Feishu group (bot
 * stays owner, creator invited + promoted to admin), save its row at once, then
 * the admin, announcement and welcome. Every Feishu call of it shares one budget
 * (s36d1); the steps after the save are best-effort and cut when it runs out.
 * Throws on duplicate name, a bad path or a stale bot before creating a group,
 * so those leave no orphan group; see {@link creationFailure} for the rest.
 */
export async function createProject(channel: Pick<LarkChannel, 'rawClient'>, request: CreateProjectInput, target: RegistryLocation = { file: paths.projectsFile, dataRoot: paths.appDir }): Promise<Project> {
  const { signal, ...fields } = request;
  const input = structuredClone(fields);
  const location = { ...target };
  if (!input.bot) throw new Error('缺少机器人注册身份，请重启后再建群');
  if (location.file !== botPaths(input.bot.appId).projectsFile || location.dataRoot !== paths.appDir) throw new Error('机器人项目目录不匹配');
  if (typeof input.requestId !== 'string' || !/^[\w-]{1,50}$/.test(input.requestId)) throw new Error('建群请求标识无效');
  const name = input.name.trim();
  if (!name) throw new Error('项目名不能为空');
  if ((await listProjectsIn(location.file)).some(project => project.name === name)) throw new Error(`项目名「${name}」已存在，换个名或用 /projects 看已有的`);
  const mode = input.mode ?? 'full'; // 创建默认「完全访问」档
  assertBackendUsable(input.backend, mode);
  const backend = input.backend || await effectiveDefaultBackend().catch(() => DEFAULT_BACKEND_ID);
  const existingPath = input.existingPath ? resolve(input.existingPath) : undefined;
  const explicit = existingPath ? await admitExistingDirectory(existingPath, location.dataRoot) : undefined;
  const root = existingPath ? '' : resolveProjectsRootDir(input.projectsRootDir);
  await assertBotIdentity(input.bot);
  const row = { createdAt: Date.now(), origin: 'created' as const, mode, backend,
    network: input.network ?? false, creationRequestId: input.requestId,
    ...(input.requestSignature === undefined ? {} : { creationRequestSignature: input.requestSignature }) };
  const noMention = input.noMention ?? bindNoMention(input.kind);

  let dispatched = false;
  return withCreationClient(channel.rawClient, async (client, limits) => {
    // Create the bound group — bot stays as owner (no owner_id passed); the creator is
    // invited as a member here, then promoted to admin below so the two share every
    // day-to-day permission. The owner (bot) keeps only disband / transfer /
    // manage-admins to itself — Feishu allows exactly one owner.
    let chatId: string | undefined;
    try {
      const res = await client.im.v1.chat.create({
        params: { user_id_type: 'open_id', uuid: input.requestId },
        data: { name, user_id_list: [input.ownerOpenId] },
      });
      // The SDK resolves a 2xx with Feishu's error code in it.
      if (typeof res.code === 'number' && res.code !== 0) throw Object.assign(new Error(`chat.create code ${res.code}`), { response: { status: 200, data: res } });
      chatId = res.data?.chat_id;
    } catch (error) {
      log.fail('project', error, { phase: 'create', requestId: input.requestId });
      throw creationFailure(error, dispatched);
    }
    if (!chatId) throw new CreationOutcomeUnknownError(new Error('chat.create returned no chat_id'));

    // Saved before anything else, so a stuck admin call cannot keep a created group out of projects.json.
    let saved: Project;
    try {
      if (explicit) {
        saved = { ...row, ...explicit, name, chatId, kind: input.kind, noMention };
        await addProject(saved, location);
      } else {
        saved = (await withBotGroupBinding(input.bot, { chatId, name, projectsRootDir: root }, scope => bindProject({ name, chatId,
          cwd: { kind: 'default', allocatedPath: scope.allocatedPath }, defaultBackend: row.backend, backend: row.backend, kind: input.kind, noMention },
          async () => ({ ...await scope.prepareDefault(), ...row }), location))).project;
      }
    } catch (error) { throw new CreatedButUnsavedError(chatId, name, error); }
    log.info('project', 'create', { name, chatId, cwd: saved.cwd, blank: saved.blank, mode, backend: saved.backend, requestId: input.requestId });

    // Promote the creator to group admin (only the owner, our bot, may), then the
    // announcement (top banner) and onboarding (welcome card / Pin / tab). All
    // best-effort: the group is usable even if they fail or run out of budget.
    await client.im.v1.chatManagers
      .addManagers({ path: { chat_id: chatId }, params: { member_id_type: 'open_id' }, data: { manager_ids: [input.ownerOpenId] } })
      .catch((err) => log.fail('project', err, { phase: 'add-manager' }));
    await setAnnouncement({ rawClient: client }, saved, limits).catch((err) => log.fail('project', err, { phase: 'announcement' }));
    await onboardGroup({ rawClient: client }, saved).catch((err) => log.fail('project', err, { phase: 'onboard' }));
    return saved;
  }, { timeoutMs: input.timeoutMs ?? CREATION_BUDGET_MS, signal, onSend: sent => {
    if (sent.method === 'POST' && /\/open-apis\/im\/v1\/chats$/.test(sent.url)) dispatched = true;
  } }).catch((error: unknown) => {
    // Errors from inside are already sorted; the rest come from the scope itself.
    if (error instanceof CreationRefusedError || error instanceof CreationOutcomeUnknownError || error instanceof CreatedButUnsavedError) throw error;
    throw creationFailure(error, dispatched);
  });
}

/**
 * Bind a *pre-existing* group (the bot was just added to it by a human) as a
 * `joined` project. Unlike {@link createProject}: no group is created, no
 * announcement is written, no admin is promoted and ownership is never touched —
 * the bot stays a plain member. Onboarding only posts a (non-pinned) welcome
 * card. Identical bindings return the existing row without rewriting it or
 * sending another welcome. Conflicts fail before preparing a new workspace.
 * A group this bot created whose row was not saved binds here too, as joined and
 * read-only: Feishu leaves `owner_id` out of chat.get when a bot owns the group
 * (measured 2026-10-18), so it cannot be told from another app's bot's group (s36d1).
 */
export async function joinExistingGroup(channel: LarkChannel, request: JoinGroupInput, target: RegistryLocation = { file: paths.projectsFile, dataRoot: paths.appDir }): Promise<Project> {
  const input = structuredClone(request);
  const location = { ...target };
  if (location.file !== botPaths(input.bot.appId).projectsFile || location.dataRoot !== paths.appDir) throw new Error('机器人项目目录不匹配');
  const name = input.name.trim();
  if (!name) throw new Error('项目名不能为空');
  const existingPath = input.existingPath ? resolve(input.existingPath) : undefined;
  const root = existingPath ? '' : resolveProjectsRootDir(input.projectsRootDir);
  let cwd = existingPath ?? join(root, name);
  if (existingPath) {
    try {
      cwd = await realpath(existingPath);
      if (!(await stat(cwd)).isDirectory()) throw new Error('not directory');
    } catch { throw new Error('所选文件夹不存在或不是目录'); }
  }
  const defaultBackend = await effectiveDefaultBackend().catch(() => DEFAULT_BACKEND_ID);
  const mode = input.mode ?? 'qa';
  const result = await withBotGroupBinding(input.bot, { name, chatId: input.chatId, projectsRootDir: root }, async scope => {
    const binding = await bindProject({ name, chatId: input.chatId,
      cwd: existingPath ? { kind: 'existing', path: cwd } : { kind: 'default', legacyPath: cwd, allocatedPath: scope.allocatedPath }, defaultBackend,
      backend: input.backend ?? defaultBackend, kind: input.kind, noMention: input.noMention ?? bindNoMention(input.kind) }, async () => {
      assertBackendUsable(input.backend, mode);
      const workspace = existingPath ? await admitExistingDirectory(existingPath, location.dataRoot) : await scope.prepareDefault();
      return { ...workspace, createdAt: Date.now(), origin: 'joined', addedBy: input.addedBy,
        mode, backend: input.backend || defaultBackend, network: input.network ?? false };
    }, location);
    await retireBoundPendingGroup(pendingGroupsFile(location.file), binding.project.chatId);
    return binding;
  });
  const project = result.project;
  if (result.kind === 'existing') return project;
  log.info('project', 'join', { name, chatId: project.chatId, cwd: project.cwd, blank: project.blank, kind: project.kind, mode: project.mode, backend: project.backend });

  // Onboarding only (no announcement / Pin / tab — see onboardGroup's joined
  // branch); best-effort, the binding holds even if the welcome card fails.
  await onboardGroup(channel, project).catch((err) => log.fail('project', err, { phase: 'onboard-join' }));
  return project;
}
