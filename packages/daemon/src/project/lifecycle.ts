import type {GroupDecision} from '@vonvon/protocol';
import {prepareNewGroupSettings} from './initial-settings';
import { pendingGroupsFile, retireBoundPendingGroup } from './pending-groups';
import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Client, LarkChannel } from '@larksuiteoapi/node-sdk';
import { paths } from '../config/paths';
import { botPaths } from '../config/paths';
import { assertBotIdentity, withBotGroupBinding, type BotIdentity } from '../config/bots';
import { admitDirectorySettings, resolveProjectsRootDir } from '../config/directories';
import { log } from '../core/logger';
import { feishuError } from '../utils/feishu-error';
import { addProject, bindNoMention, bindProject, listProjectsIn, previousDirectoryIn, previousProjectIdIn, sessionModeOf, storedMode, type PreviousDirectory, type Project, type RegistryLocation, type SessionMode } from './registry';
import { createLibraryProject, projectWithMainFolder, readLibrary, resolveDirectory, workspaceMirror, type LibraryProject } from './library';
import { directoryContext, legacyDirectoryProblems } from './directory-audit';
import { DirectoryError, directoryError } from '../config/directory-errors';
import type { PermissionMode } from '../agent/types';
import type { WelcomeCardPreference } from '../config/schema';
import { TIER_NETWORK } from '../agent/permission';
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

/**
 * A person as the Bot making the group can name them. An open_id is its app's; another Bot of this computer gets the
 * union_id, which the same developer's apps share (dm-agent 6.4).
 */
export interface GroupInvitee { idType: 'open_id' | 'union_id'; id: string }
/** dm-agent 6.4: a person another Bot could not pull in, so no group. */
export const cannotInvite = (bot: string): string => `Bot ${bot} 拉不了你。可以你自己建群、把 ${bot} 拉进去，再让我绑定。`;

export interface CreateProjectInput {
  /** Feishu's dedupe key for this one creation (chat.create `uuid`, at most 50 characters): the web makes one per
   * RPC, the DM one per card click. Nothing retries chat.create; a retry would have to reuse it. */
  requestId: string;
  requestSignature?: string;
  /** The registered bot this process runs as. Checked before Feishu is called; the default directory is under it. */
  bot: BotIdentity;
  name: string;
  /** Who the new group is for: invited, then made its admin. */
  invitee: GroupInvitee;
  /** This Bot's name, for the refusal of an invitee it cannot pull in. */
  botName?: string;
  /** when set, bind this existing folder; otherwise create a blank project. */
  existingPath?: string;
  /** Join this library project (its id) instead of making one: the group uses its workspace, `existingPath` is not used. */
  project?: string;
  /** optional config.json override for the parent directory of blank projects. */
  projectsRootDir?: string;
  /** 会话方式, required: every entry asks for it (product.md 3.4). */
  kind: SessionMode;
  /** 免@; left out → {@link bindNoMention}. Always written, so a later 会话方式 switch keeps it. 智能 ignores it. */
  noMention?: boolean;
  judge?: GroupDecision;
  /** permission tier (default 'full' for self-created projects). */
  mode?: PermissionMode;
  /** agent backend chosen at creation (fixed afterwards — no switching). Left out (the DM form shows no picker
   *  for a single backend) → the effective default the runtime used to fall back to, written into the row so the
   *  group never follows a later default (s36d1). */
  backend?: string;
  /** Stops every Feishu call of this creation, for the daemon's shutdown. */
  signal?: AbortSignal;
  /** One budget for every Feishu call: token, create, admin, announcement and welcome. Default {@link CREATION_BUDGET_MS}. */
  timeoutMs?: number;
  /** This Bot's optional onboarding-card copy, read from its preferences by the caller. */
  welcomeCard?: WelcomeCardPreference;
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

/** 免@ an entry writes: the picked one, else {@link bindNoMention}. 智能 has none, so a pick is dropped (s25c). */
function entryNoMention(input: { kind: SessionMode; noMention?: boolean }): boolean {
  return input.kind === 'smart' ? false : input.noMention ?? bindNoMention(input.kind);
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
  /** Join this library project (its id) instead of making one. Left out, a group unbound before comes back to the
   * project it had, unless a folder is chosen; any other group gets a project of its own. */
  project?: string;
  /** optional config.json override for the parent directory of blank projects. */
  projectsRootDir?: string;
  /** 会话方式, required: every entry asks for it (product.md 3.4). */
  kind: SessionMode;
  /** 免@; left out → {@link bindNoMention}. 智能 ignores it. */
  noMention?: boolean;
  judge?: GroupDecision;
  /** permission tier (default 'qa' — read-only — for joined external groups). */
  mode?: PermissionMode;
  /** agent backend chosen at bind time (fixed afterwards — no switching). */
  backend?: string;
  /** This Bot's optional onboarding-card copy, read from its preferences by the caller. */
  welcomeCard?: WelcomeCardPreference;
}

/**
 * Admit an explicit `existingPath` (must exist, outside protected locations).
 * Throws before any group is touched so a bad path never leaves an orphan group.
 * A default directory is allocated by {@link withBotGroupBinding} once the group exists.
 */
async function admitExistingDirectory(existingPath: string, dataDir: string): Promise<Pick<Project, 'cwd' | 'blank' | 'directories'>> {
  try { if (!(await stat(existingPath)).isDirectory()) throw new Error('not directory'); }
  catch { throw new DirectoryError('所选文件夹不存在或不是目录'); }
  return directoryError(undefined, async () => {
    const directories = await admitDirectorySettings({ workspaces: { primary: existingPath, additional: [] } }, { dataDir });
    if (!directories?.workspaces) throw new Error('Invalid directory settings: directories.workspaces.primary');
    return { cwd: directories.workspaces.primary, blank: false, directories };
  });
}

/**
 * The directory a row from before s36c2c3 had when its group was unbound, if binding that group again with the
 * default directory can go back there, as it did before s36c2c3 (s36c2d): still a directory a workspace may be, and
 * not one of the wrong places an old creation entry left ({@link legacyDirectoryProblems}). The row keeps its old
 * shape, with no `directories`, so unbinding it again remembers it again.
 */
async function restorableDirectory(previous: PreviousDirectory | undefined, dataDir: string, projectsRoot: string): Promise<Pick<Project, 'cwd' | 'blank'> | undefined> {
  if (!previous) return undefined;
  try {
    const { cwd } = await admitExistingDirectory(previous.cwd, dataDir);
    const [problem] = await legacyDirectoryProblems([cwd], await directoryContext(dataDir, [projectsRoot]));
    return problem ? undefined : { cwd, blank: previous.blank };
  } catch { return undefined; }
}

/** The library project a binding joins, as the caller named it; refused before anything is made when it is gone. */
async function joinableProject(id: string): Promise<LibraryProject> {
  const project = (await readLibrary()).projects.find(item => item.id === id);
  if (!project) throw new Error('要加入的项目不存在，请刷新后重选');
  return project;
}

/** The project whose main folder this is, if any. */
async function mainFolderOwner(workspace: Pick<Project, 'cwd'>): Promise<LibraryProject | undefined> {
  return projectWithMainFolder((await readLibrary()).projects, (await resolveDirectory(workspace.cwd)).path);
}

/** Makes the project a new binding of a folder belongs to, before its row (§2.1). `workspace` is admitted. */
async function newBindingProject(bot: BotIdentity, group: { chatId: string; name: string }, workspace: Pick<Project, 'cwd' | 'directories'>): Promise<{ id: string }> {
  const additional = workspace.directories?.workspaces?.additional ?? [];
  const repositories = workspace.directories?.repositories;
  const primary = (await resolveDirectory(workspace.cwd)).path;
  return createLibraryProject({ name: group.name, createdBy: { botId: bot.appId, chatId: group.chatId },
    workspace: { primary, additional: [...additional], ...(repositories ? { repositories: [...repositories] } : {}) } });
}

const botLabel = (input: Pick<CreateProjectInput, 'bot' | 'botName'>): string => input.botName ?? input.bot.appId;

/**
 * dm-agent 6.4: a union_id of another organization can come back as a group without the person, a group nobody asked for.
 * Asked before the row is saved: then the group goes and the creation is refused. A check that fails says nothing of
 * that, so the group stands as Feishu answered.
 */
async function refuseIfLeftOut(client: Client, chatId: string, input: CreateProjectInput): Promise<void> {
  if (input.invitee.idType !== 'union_id') return;
  let left = false;
  try {
    const reply = await client.im.v1.chatMembers.get({ path: { chat_id: chatId }, params: { member_id_type: 'union_id', page_size: 100 } });
    left = reply.code === 0 && Array.isArray(reply.data?.items) && !reply.data.has_more && !reply.data.items.some(member => member.member_id === input.invitee.id);
  } catch (error) { log.fail('project', error, { phase: 'invitee-check', requestId: input.requestId }); }
  if (!left) return;
  await client.im.v1.chat.delete({ path: { chat_id: chatId } }).catch((error: unknown) => log.fail('project', error, { phase: 'invitee-disband', chatId }));
  throw new CreationRefusedError(cannotInvite(botLabel(input)));
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
  if (input.project !== undefined && existingPath) throw new Error('加入已有项目时不能再选文件夹');
  const joined = input.project === undefined ? undefined : await joinableProject(input.project);
  const explicit = existingPath ? await admitExistingDirectory(existingPath, location.dataRoot) : undefined;
  const root = existingPath || joined ? '' : resolveProjectsRootDir(input.projectsRootDir);
  await assertBotIdentity(input.bot);
  const initialSettings = await prepareNewGroupSettings({backend, kind:input.kind, judge:input.judge});
  const row = { ...initialSettings, createdAt: Date.now(), origin: 'created' as const, mode, backend,
    network: TIER_NETWORK[mode], creationRequestId: input.requestId,
    ...(input.requestSignature === undefined ? {} : { creationRequestSignature: input.requestSignature }) };
  const noMention = entryNoMention(input);

  let dispatched = false;
  return withCreationClient(channel.rawClient, async (client, limits) => {
    // Create the bound group — bot stays as owner (no owner_id passed); the creator is
    // invited as a member here, then promoted to admin below so the two share every
    // day-to-day permission. The owner (bot) keeps only disband / transfer /
    // manage-admins to itself — Feishu allows exactly one owner.
    let chatId: string | undefined;
    try {
      const res = await client.im.v1.chat.create({
        params: { user_id_type: input.invitee.idType, uuid: input.requestId },
        data: { name, user_id_list: [input.invitee.id] },
      });
      // The SDK resolves a 2xx with Feishu's error code in it.
      if (typeof res.code === 'number' && res.code !== 0) throw Object.assign(new Error(`chat.create code ${res.code}`), { response: { status: 200, data: res } });
      chatId = res.data?.chat_id;
    } catch (error) {
      log.fail('project', error, { phase: 'create', requestId: input.requestId });
      const failure = creationFailure(error, dispatched);
      // Feishu's words stay beside ours: not every refusal of a union_id is the other organization's.
      throw input.invitee.idType === 'union_id' && failure instanceof CreationRefusedError && dispatched ? new CreationRefusedError(`${cannotInvite(botLabel(input))}（${failure.message}）`) : failure;
    }
    if (!chatId) throw new CreationOutcomeUnknownError(new Error('chat.create returned no chat_id'));
    await refuseIfLeftOut(client, chatId, input);

    // Saved before anything else, so a stuck admin call cannot keep a created group out of projects.json.
    let saved: Project;
    try {
      if (joined) {
        // The group uses the project's workspace; nothing is allocated for it.
        const mirror = workspaceMirror(joined.workspace);
        saved = (await bindProject({ name, chatId, cwd: { kind: 'existing', path: mirror.cwd }, defaultBackend: row.backend, backend: row.backend,
          kind: input.kind, noMention, project: { id: joined.id } }, async () => ({ ...mirror, ...row }), location)).project;
      } else if (explicit) {
        const project = await newBindingProject(input.bot, { chatId, name }, explicit);
        saved = { ...row, ...explicit, name, chatId, noMention, ...storedMode(input.kind), projectId: project.id, migration: { library: Date.now(), memory: Date.now() } };
        await addProject(saved, location);
      } else {
        saved = (await withBotGroupBinding(input.bot, { chatId, name, projectsRootDir: root }, async scope => {
          // The default folder is allocated first (a retry finds the same one), so the project can be made before the row.
          const prepared = await scope.prepareDefault();
          const project = await newBindingProject(input.bot, { chatId, name }, prepared);
          return bindProject({ name, chatId, cwd: { kind: 'default', allocatedPath: scope.allocatedPath }, defaultBackend: row.backend, backend: row.backend,
            kind: input.kind, noMention, project: { id: project.id } }, async () => ({ ...prepared, ...row }), location);
        })).project;
      }
    } catch (error) { throw new CreatedButUnsavedError(chatId, name, error); }
    log.info('project', 'create', { name, chatId, cwd: saved.cwd, blank: saved.blank, kind: sessionModeOf(saved), mode, backend: saved.backend, requestId: input.requestId });

    // Promote the creator to group admin (only the owner, our bot, may), then the
    // announcement (top banner) and onboarding (welcome card / Pin / tab). All
    // best-effort: the group is usable even if they fail or run out of budget.
    await client.im.v1.chatManagers
      .addManagers({ path: { chat_id: chatId }, params: { member_id_type: input.invitee.idType }, data: { manager_ids: [input.invitee.id] } })
      .catch((err) => log.fail('project', err, { phase: 'add-manager' }));
    await setAnnouncement({ rawClient: client }, saved, limits).catch((err) => log.fail('project', err, { phase: 'announcement' }));
    await onboardGroup({ rawClient: client }, saved, input.welcomeCard).catch((err) => log.fail('project', err, { phase: 'onboard' }));
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
  if (input.project !== undefined && existingPath) throw new Error('加入已有项目时不能再选文件夹');
  const result = await withBotGroupBinding(input.bot, { name, chatId: input.chatId, projectsRootDir: root }, async scope => {
    // A group already bound answers from its row (below), before anything is made for it.
    const bound = (await listProjectsIn(location.file)).some(row => row.chatId === input.chatId);
    let joined: LibraryProject | undefined;
    let workspace: Pick<Project, 'cwd' | 'blank' | 'directories'> | undefined;
    let initialSettings: Awaited<ReturnType<typeof prepareNewGroupSettings>> | undefined;
    let project: { id: string } | undefined;
    if (!bound) {
      assertBackendUsable(input.backend, mode);
      // 接回: a group unbound before comes back to the project it had, unless a folder is chosen.
      const previousId = input.project === undefined && !existingPath ? await previousProjectIdIn(location.file, input.chatId) : undefined;
      joined = input.project !== undefined ? await joinableProject(input.project)
        : previousId ? (await readLibrary()).projects.find(item => item.id === previousId) : undefined;
      initialSettings = await prepareNewGroupSettings({backend:input.backend || defaultBackend,kind:input.kind,judge:input.judge});
      if (joined) { workspace = workspaceMirror(joined.workspace); project = { id: joined.id }; }
      else {
        const restored = existingPath || scope.allocatedPath ? undefined : await restorableDirectory(await previousDirectoryIn(location.file, input.chatId), location.dataRoot, root);
        workspace = existingPath ? await admitExistingDirectory(existingPath, location.dataRoot) : restored ?? await scope.prepareDefault();
        // A default folder allocated for this group (or restored for it) reconnects to its existing project; an explicitly chosen folder creates an independent project even when another group uses the same directory.
        if (!existingPath) joined = await mainFolderOwner(workspace);
        if (joined) { workspace = workspaceMirror(joined.workspace); project = { id: joined.id }; }
        else project = await newBindingProject(input.bot, { chatId: input.chatId, name }, workspace);
      }
    }
    const binding = await bindProject({ name, chatId: input.chatId,
      cwd: existingPath ? { kind: 'existing', path: cwd } : { kind: 'default', legacyPath: cwd, allocatedPath: scope.allocatedPath }, defaultBackend,
      backend: input.backend ?? defaultBackend, kind: input.kind, noMention: entryNoMention(input), ...(project ? { project } : {}) }, async previous => {
      assertBackendUsable(input.backend, mode);
      const restored = existingPath || scope.allocatedPath ? undefined : await restorableDirectory(previous, location.dataRoot, root);
      const settings = initialSettings ?? await prepareNewGroupSettings({backend:input.backend || defaultBackend,kind:input.kind,judge:input.judge});
      const chosen = workspace ?? (existingPath ? await admitExistingDirectory(existingPath, location.dataRoot) : restored ?? await scope.prepareDefault());
      return { ...chosen, ...settings, createdAt: Date.now(), origin: 'joined', addedBy: input.addedBy,
        mode, backend: input.backend || defaultBackend, network: TIER_NETWORK[mode] };
    }, location);
    await retireBoundPendingGroup(pendingGroupsFile(location.file), binding.project.chatId);
    return binding;
  });
  const project = result.project;
  if (result.kind === 'existing') return project;
  log.info('project', 'join', { name, chatId: project.chatId, cwd: project.cwd, blank: project.blank, kind: sessionModeOf(project), mode: project.mode, backend: project.backend });

  // Onboarding only (no announcement / Pin / tab — see onboardGroup's joined
  // branch); best-effort, the binding holds even if the welcome card fails.
  await onboardGroup(channel, project, input.welcomeCard).catch((err) => log.fail('project', err, { phase: 'onboard-join' }));
  return project;
}
