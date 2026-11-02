import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  commandSchema, conversationCopy, FULL_ACCESS_WARNING, groupIdSchema, modeToConversation, replyModeSchema, toolSchema,
  type Agent, type AgentId, type CollaborationReply, type Conversation, type DesktopSnapshot, type FolderChoice, type GroupId, type LibraryProject, type Membership, type ProjectRecord,
} from '@vonvon/protocol';
import {
  bindingsHidden, conversationLabel, localTime, pickBot, pickGroup, print, runningBot, toolLabel, want, withDaemon, withoutAvatar, type Call, type Daemon, type Io,
} from '../daemon-client';
import { badArgs, CommandError } from '../command-error';
import { expandHome, pathFor } from '../../platform/home-path';

/** One Feishu page holds 50 groups, so this is 1000 groups. */
const MAX_PAGES = 20;
type JoinedGroup = { id: string; name: string; bound: boolean };

export async function runGroupList(options: { bot?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const snapshot = await daemon(call => call('读取快照', c => c.snapshot()));
  const only = options.bot === undefined ? undefined : pickBot(snapshot.agents, options.bot);
  const groups = snapshot.memberships.filter(m => !only || m.agentId === only.id);
  const prefix = !only && snapshot.agents.length > 1;
  const human = groups.length ? groups.map(m => {
    const owner = prefix ? `${snapshot.agents.find(agent => agent.id === m.agentId)?.name ?? m.agentId} / ` : '';
    return `${owner}${m.name}  ${m.groupId}  ${toolLabel(m.backend)}  ${conversationLabel(m.conversation)}  ${m.directory}${m.stale ? '（读取失败，显示的是上次的数据）' : ''}`;
  }) : ['还没有绑定的群。用 vonvon group pending 看 Bot 刚加入的群，再用 vonvon group bind 绑定。'];
  print(io, human, { groups: groups.map(withoutAvatar) });
}

/** Follows nextCursor like the web dialog: stops on a repeated cursor and drops repeated ids. */
async function joinedGroups(call: Call, agentId: AgentId): Promise<{ groups: JoinedGroup[]; complete: boolean }> {
  const groups = new Map<string, JoinedGroup>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const reply = await call('查已加入的群', c => c.run({ type: 'listJoinedGroups', agentId, ...(cursor ? { cursor } : {}) }), { feishu: true });
    const { groups: found, nextCursor: next } = want('查已加入的群', reply, 'groups');
    for (const group of found) if (!groups.has(group.id)) groups.set(group.id, group);
    if (!next || cursors.has(next)) return { groups: [...groups.values()], complete: true };
    cursors.add(next);
    cursor = next;
  }
  return { groups: [...groups.values()], complete: false };
}

export async function runGroupJoined(options: { bot?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { groups, complete } = await daemon(async call => {
    const agent = pickBot((await call('读取快照', c => c.snapshot())).agents, options.bot);
    return joinedGroups(call, agent.id);
  });
  const human = groups.map(group => `${group.id}  ${group.name}  ${group.bound ? '已绑定' : '未绑定'}`);
  if (!groups.length) human.push('Bot 还没加入任何群。');
  if (!complete) human.push(`只显示了前 ${MAX_PAGES * 50} 个群。`);
  print(io, human, { groups, complete });
}

/** Like the web page, drops a pending record whose group is already bound to this bot. */
export async function runGroupPending(options: { bot?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const groups = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = pickBot(snapshot.agents, options.bot);
    const pending = want('查待绑定的群', await call('查待绑定的群', c => c.run({ type: 'listPendingGroups', agentId: agent.id })), 'pendingGroups').groups;
    return pending.filter(group => !snapshot.memberships.some(m => m.agentId === agent.id && m.groupId === group.chatId));
  });
  const human = groups.length
    ? groups.map(group => `${group.chatId}  ${group.name}  ${localTime(group.addedAt)} 加入`)
    : ['没有待绑定的群。Bot 离线时被拉进的群，用 vonvon group joined 查。'];
  print(io, human, { groups });
}

export type Host = { cwd: string; home: string; platform: NodeJS.Platform };
export const thisHost = (): Host => ({ cwd: process.cwd(), home: homedir(), platform: process.platform });

/**
 * A folder as typed, made absolute on this computer (cli-3-groups 4.5): bash leaves --folder=~/x alone, and the daemon
 * resolves relative paths against its own working directory. `~\x` counts on Windows only, and the path rules are the
 * host's own. Whether it is a folder is the daemon's to say (devices 8.3); a folder that is not there comes back as
 * `invalid_directory`, exit 2.
 */
export function folderPath(raw: string, host: Host): string {
  return pathFor(host.platform).resolve(host.cwd, expandHome(raw, host.home, host.platform));
}

/** `--folder default`, or none: the folder the daemon makes for the group. */
const DEFAULT_FOLDER = 'default';
const FOLDER_OR_PROJECT = '--project 加入已有项目，用的是那个项目的文件夹，不能再给 --folder <path>。';
/** The path of --folder, or undefined for the daemon's default; a path and --project together are refused. */
function folderOption(options: { folder?: string; project?: string }, host: Host): string | undefined {
  if (options.folder === undefined || options.folder === DEFAULT_FOLDER) return undefined;
  if (options.project !== undefined) throw badArgs(FOLDER_OR_PROJECT);
  return folderPath(options.folder, host);
}

/** The daemon checks the folder and hands back a token for it; a folder that is not there is exit 2 in its words. */
async function chooseFolder(call: Call, path: string): Promise<FolderChoice> {
  return want('选择文件夹', await call('选择文件夹', c => c.directory({ type: 'choose', path })), 'folderChosen').folder;
}

export async function libraryProjects(call: Call): Promise<LibraryProject[]> {
  return want('读取项目', await call('读取项目', c => c.library({ type: 'list' })), 'list').projects;
}

/** A library project by its id (prj_…) or its name; a name two projects share needs the id. */
export function pickProject(projects: readonly LibraryProject[], wanted: string): LibraryProject {
  const byId = projects.find(project => project.id === wanted);
  if (byId) return byId;
  const named = projects.filter(project => project.name === wanted);
  if (named.length > 1) throw badArgs(`有 ${named.length} 个项目都叫「${wanted}」，用 id 指定：${named.map(project => project.id).join('、')}`);
  if (named[0]) return named[0];
  throw badArgs(`没有找到项目「${wanted}」。用 vonvon project list 查看。`);
}

/** The protocol's rule for a project's (and a created group's) name. */
// eslint-disable-next-line no-control-regex
const PROJECT_NAME = /^[^/\\\x00-\x1f]+$/;
export function projectName(raw: string, what = '项目名'): string {
  const name = raw.trim();
  if (!name || name.length > 100 || !PROJECT_NAME.test(name)) throw badArgs(`${what}要 1 到 100 个字，不能有 / 、\\ 和控制字符。`);
  return name;
}

/** `--conversation` values: multi / single / smart (product.md 3.4's 多会话、单会话、智能); the wire names threads / shared still work. */
const CONVERSATIONS: Record<string, Conversation> = { multi: 'threads', single: 'shared', smart: 'smart', threads: 'threads', shared: 'shared' };
const CONVERSATION_HELP = `--conversation 必须选一项：multi（${conversationCopy.threads.title}）、single（${conversationCopy.shared.title}）或 smart（${conversationCopy.smart.title}）。`;
/** 智能 has no 免@ (3.4, s25c). */
const SMART_RESPONSE_HELP = `${conversationCopy.smart.title}由 Bot 判断回不回，没有免 @，不能带 --response。`;
const conversationOf = (raw: string | undefined): Conversation => {
  const picked = raw !== undefined && Object.hasOwn(CONVERSATIONS, raw) ? CONVERSATIONS[raw] : undefined;
  if (picked === undefined) throw badArgs(CONVERSATION_HELP);
  return picked;
};
const toolOf = (raw: string | undefined) => {
  const tool = toolSchema.safeParse(raw ?? 'codex');
  if (!tool.success) throw badArgs('--tool 只能是 codex 或 claude。');
  return tool.data;
};
/** 3.4's default 免@: 多会话开，单会话关. */
const defaultResponse = (conversation: Conversation): 'all' | 'mention' => conversation === 'threads' ? 'all' : 'mention';
/** --conversation and --response, as bind and create take them; `response` is the 免@ the group gets, none for 智能. */
function modeOf(options: { conversation?: string; response?: string }): { conversation: Conversation; response?: 'all' | 'mention' } {
  const conversation = conversationOf(options.conversation);
  if (conversation === 'smart') {
    if (options.response !== undefined) throw badArgs(SMART_RESPONSE_HELP);
    return { conversation };
  }
  const response = options.response === undefined ? undefined : replyModeSchema.safeParse(options.response);
  if (response && !response.success) throw badArgs('--response 只能是 mention（@ 我才回）或 all（免 @，不 @ 也回）。');
  return { conversation, response: response?.data ?? defaultResponse(conversation) };
}
const responseText = (response: 'all' | 'mention' | undefined): string => response === undefined ? '' : ` · 免 @ ${response === 'all' ? '开' : '关'}`;

export type BindOptions = { folder?: string; project?: string; name?: string; tool?: string; conversation?: string; response?: string; bot?: string };

/** Everything that can be checked offline is checked before connecting, so a typo sends no RPC. */
export async function runGroupBind(rawGroupId: string, options: BindOptions, io: Io, daemon: Daemon = withDaemon, host: Host = thisHost()): Promise<void> {
  const groupId = groupIdSchema.safeParse(rawGroupId);
  if (!groupId.success) throw badArgs('群 id 应该以 oc_ 开头。用 vonvon group pending 或 vonvon group joined 查。');
  const tool = toolOf(options.tool);
  const { conversation, response } = modeOf(options);
  // Left out: 3.4's default, 多会话开，单会话关; the daemon writes the same. Only a different pick goes
  // on the wire, so a daemon from before s21 still takes the default case.
  const sent = response === undefined || response === defaultResponse(conversation) ? {} : { response };
  const folder = folderOption(options, host);
  const unknown = '绑定可能已经完成，运行 vonvon group list 查看。';

  const result = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = pickBot(snapshot.agents, options.bot);
    let name = options.name;
    if (name === undefined) {
      const pending = want('查待绑定的群', await call('查待绑定的群', c => c.run({ type: 'listPendingGroups', agentId: agent.id })), 'pendingGroups');
      name = pending.groups.find(group => group.chatId === groupId.data)?.name;
    }
    name ??= (await joinedGroups(call, agent.id)).groups.find(group => group.id === groupId.data)?.name;
    if (name === undefined) throw badArgs('找不到这个群的名字，用 --name 指定项目名。');
    const joined = options.project === undefined ? {} : { project: pickProject(await libraryProjects(call), options.project).id };
    const command = commandSchema.safeParse({ type: 'bindGroup', agentId: agent.id, groupId: groupId.data, projectName: name, folder: folder === undefined ? { kind: 'default' } : { kind: 'existing', folderToken: randomUUID() }, ...joined, tool, conversation, ...sent });
    if (!command.success || command.data.type !== 'bindGroup') throw badArgs('项目名要 1 到 100 个字，不能有 / 、\\ 和控制字符，用 --name 换一个。');
    const projectName = command.data.projectName;
    const chosen = folder === undefined ? undefined : await chooseFolder(call, folder);
    const selection = chosen ? { kind: 'existing' as const, folderToken: chosen.token } : { kind: 'default' as const };
    const bound = await call('绑定群', c => c.run({ type: 'bindGroup', agentId: agent.id, groupId: groupId.data, projectName, folder: selection, ...joined, tool, conversation, ...sent }), { feishu: true, unknown });
    const revision = want('绑定群', bound, 'applied', unknown).revision;
    // the daemon's own folder (default or the project's) is in the snapshot it rebuilt before answering
    const where = chosen?.displayPath ?? await call('读取快照', c => c.snapshot())
      .then(after => after.memberships.find(m => m.agentId === agent.id && m.groupId === groupId.data)?.directory, () => undefined);
    const view = tool === 'codex'
      ? want('读取群设置', await call('读取群设置', c => c.settings({ type: 'read', scope: { kind: 'project', botId: agent.id, projectName } })), 'view').view
      : undefined;
    const fullOnly = view && 'identity' in view && 'fullOnly' in view.identity ? view.identity.fullOnly : undefined;
    return { fullOnly, revision, name: projectName, folder: where, several: snapshot.agents.length > 1, agentId: agent.id };
  });
  const human = [`已绑定 ${result.name}（${groupId.data}）→ ${result.folder ?? '默认文件夹'} · ${tool === 'codex' ? 'Codex' : 'Claude'} · ${conversationLabel(conversation)}${responseText(response)}`];
  if (result.fullOnly) {
    human.push(`${result.fullOnly} 运行：vonvon settings set${result.several ? ` --bot ${result.agentId}` : ''} --group ${groupId.data} permission.mode=full`);
  }
  print(io, human, { groupId: groupId.data, name: result.name, ...(result.folder === undefined ? {} : { folder: result.folder }), tool, conversation, ...(response === undefined ? {} : { response }), revision: result.revision });
}

/** A bound group as `group show / create / set` print it; `response` (免@) comes from the snapshot, none for 智能. */
export type GroupView = { groupId: string; name: string; folder: string; tool: string; conversation: Conversation; response?: 'all' | 'mention'; enabled: boolean; revision: string };
const TOOLS: Readonly<Record<string, string>> = { 'codex-appserver': 'codex', 'claude-agent': 'claude' };
function groupView(record: ProjectRecord, response: 'all' | 'mention' | undefined): GroupView {
  const conversation = modeToConversation(record.kind);
  return {
    groupId: record.chatId, name: record.name, folder: record.cwd, tool: TOOLS[record.backend] ?? record.backend, conversation,
    ...(conversation === 'smart' || response === undefined ? {} : { response }), enabled: record.enabled, revision: record.revision,
  };
}
const groupLine = (group: GroupView, backend: string): string =>
  `${group.name}  ${group.groupId}  ${toolLabel(backend)} · ${conversationCopy[group.conversation].name} · ${group.enabled ? '已启用' : '已停用'}  ${group.folder}`;

const target = (membership: Membership) => ({ agentId: membership.agentId, projectName: membership.name, groupId: membership.groupId });
/** The daemon's refusal in its own words (exit 4, its code as `reason`), or a reply this command did not expect. */
function notDone(what: string, reply: CollaborationReply): CommandError {
  if (reply.kind === 'refused') return new CommandError('refused', reply.message, { reason: reply.code });
  return new CommandError('failed', `${what}没有完成：daemon 回了意外的结果（${reply.kind}）。`);
}
function applied(what: string, reply: CollaborationReply): Extract<CollaborationReply, { kind: 'applied' }> {
  if (reply.kind === 'applied') return reply;
  throw notDone(what, reply);
}
async function readGroup(call: Call, membership: Membership): Promise<ProjectRecord> {
  const reply = await call('读取群', c => c.collaboration({ action: 'project', ...target(membership) }));
  if (reply.kind === 'project') return reply.project;
  throw notDone('读取群', reply);
}
/**
 * s1b: in a session whose snapshot has no bindings (a group's, a comment's), the group a command names. Its project's name
 * stands for it (the snapshot keeps the group's project with its own binding), and an `oc_` id is taken as it is, as
 * schedule's chatOf does. None: pickGroup refuses as for any read.
 */
function hiddenTarget(snapshot: Pick<DesktopSnapshot, 'memberships' | 'projects'>, agent: Agent, wanted: string): { agentId: AgentId; projectName: string; groupId: GroupId } | undefined {
  if (!bindingsHidden(snapshot.memberships, agent)) return undefined;
  for (const project of snapshot.projects ?? []) {
    const binding = project.bindings.find(each => each.agentId === agent.id && (project.name === wanted || each.groupId === wanted));
    if (binding) return { agentId: agent.id, projectName: project.name, groupId: binding.groupId };
  }
  const id = groupIdSchema.safeParse(wanted);
  return id.success ? { agentId: agent.id, projectName: wanted, groupId: id.data } : undefined;
}
/** The bot named (or the only one), running, and its group by id or name. */
async function botGroup(call: Call, options: { bot?: string }, wanted: string) {
  const snapshot = await call('读取快照', c => c.snapshot());
  const agent = runningBot(snapshot.agents, options.bot);
  return { snapshot, agent, membership: pickGroup(snapshot.memberships, agent, wanted) };
}

export type CreateOptions = { folder?: string; project?: string; tool?: string; conversation?: string; response?: string; bot?: string };
const CREATE_UNKNOWN = '群可能已经建好，运行 vonvon group list 查看。';

/**
 * `vonvon group create` (cli-3-groups 4.2): the web page's 创建群聊, a new Feishu group with the bot in it, bound. The
 * group is full access (devices 5.3), so the output ends with the 15 节 sentence; a creation that may have made a group
 * (`outcome_unknown`, no answer in time) is exit 6, one made and not saved (`created_unsaved`) exit 1.
 */
export async function runGroupCreate(rawName: string, options: CreateOptions, io: Io, daemon: Daemon = withDaemon, host: Host = thisHost()): Promise<void> {
  const name = projectName(rawName, '群名');
  const tool = toolOf(options.tool);
  const { conversation, response } = modeOf(options);
  // as the web page sends it: a daemon from before s21 made every group with 免@ on, so only 多会话's default goes unsaid
  const sent = response === undefined || (conversation === 'threads' && response === defaultResponse(conversation)) ? {} : { response };
  const folder = folderOption(options, host);
  const created = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = runningBot(snapshot.agents, options.bot);
    const joined = options.project === undefined ? {} : { project: pickProject(await libraryProjects(call), options.project).id };
    const chosen = folder === undefined ? undefined : await chooseFolder(call, folder);
    const reply = await call('建群', c => c.collaboration({
      action: 'createProject', agentId: agent.id, name, folder: chosen ? { kind: 'existing', folderToken: chosen.token } : { kind: 'default' }, ...joined, tool, conversation, ...sent,
    }), { feishu: true, unknown: CREATE_UNKNOWN });
    const project = applied('建群', reply).project;
    if (!project) throw new CommandError('outcome-unknown', `建群没有确认：daemon 没说建好的是哪个群。\n${CREATE_UNKNOWN}`);
    return project;
  });
  const group = groupView(created, response);
  print(io, [`已建群并绑定 ${group.name}（${group.groupId}）→ ${group.folder} · ${toolLabel(created.backend)} · ${conversationLabel(conversation)}${responseText(response)}`, FULL_ACCESS_WARNING],
    { group, warning: FULL_ACCESS_WARNING });
}

/** `vonvon group show`: the group as the daemon has it now, with the revision `group set --revision` takes. */
export async function runGroupShow(wanted: string, options: { bot?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const { record, membership } = await daemon(async call => {
    const { membership } = await botGroup(call, options, wanted);
    return { record: await readGroup(call, membership), membership };
  });
  const group = groupView(record, membership.response);
  print(io, [groupLine(group, record.backend)], { group });
}

export type SetOptions = { enable?: boolean; disable?: boolean; conversation?: string; folder?: string; project?: string; revision?: string; bot?: string };
type Change = 'enabled' | 'conversation' | 'folder' | 'project';

/**
 * `vonvon group set` (cli-3-groups 4.2): 启用 / 停用, 会话方式, 文件夹 and 换项目 of a group's settings page. Without
 * --revision it reads the group's and writes right after; with it (read from `group show --json`) a change made
 * elsewhere in between is a conflict, exit 5.
 */
export async function runGroupSet(wanted: string, options: SetOptions, io: Io, daemon: Daemon = withDaemon, host: Host = thisHost()): Promise<void> {
  if (options.enable && options.disable) throw badArgs('--enable 和 --disable 只能选一个。');
  const enabled = options.enable ? true : options.disable ? false : undefined;
  const conversation = options.conversation === undefined ? undefined : conversationOf(options.conversation);
  if (options.folder === DEFAULT_FOLDER) throw badArgs('group set 的 --folder 只接路径：绑好的群不能换回默认文件夹。');
  if (options.folder !== undefined && options.project !== undefined) throw badArgs('--folder 和 --project 要分两次改。');
  const folder = options.folder === undefined ? undefined : folderPath(options.folder, host);
  const changed: Change[] = [
    ...enabled === undefined ? [] : ['enabled' as const], ...conversation === undefined ? [] : ['conversation' as const],
    ...folder === undefined ? [] : ['folder' as const], ...options.project === undefined ? [] : ['project' as const],
  ];
  if (!changed.length) throw badArgs('没有要改的。给 --enable、--disable、--conversation、--folder 或 --project 里的至少一项。');
  const unknown = `可能已经改了，运行 vonvon group show ${wanted} 查看。`;
  const result = await daemon(async call => {
    const snapshot = await call('读取快照', c => c.snapshot());
    const agent = runningBot(snapshot.agents, options.bot);
    const hidden = hiddenTarget(snapshot, agent, wanted);
    // A group's or a comment's session (Codex review 256-3): a group setting is a settings write, which the daemon refuses
    // there with the not-dm sentence before it reads the group. So it goes first and nothing is looked up (folders, the
    // library and the group's revision are not that session's to read); a reply other than a refusal is not one to expect.
    if (hidden) {
      throw notDone('改群设置', await call('改群设置', c => c.collaboration({
        action: 'editProject', ...hidden, expectedRevision: options.revision ?? '-', ...conversation === undefined ? {} : { conversation }, ...enabled === undefined ? {} : { enabled },
      }), { feishu: true, unknown }));
    }
    const membership = pickGroup(snapshot.memberships, agent, wanted);
    const project = options.project === undefined ? undefined : pickProject(await libraryProjects(call), options.project);
    const chosen = folder === undefined ? undefined : await chooseFolder(call, folder);
    const expectedRevision = options.revision ?? (await readGroup(call, membership)).revision;
    let reply: CollaborationReply;
    try {
      reply = await call('改群设置', c => c.collaboration({
        action: 'editProject', ...target(membership), expectedRevision, ...chosen ? { folderToken: chosen.token } : {}, ...project ? { project: project.id } : {},
        ...conversation === undefined ? {} : { conversation }, ...enabled === undefined ? {} : { enabled },
      }), { feishu: true, unknown });
    } catch (error) {
      // the daemon's word first: a conflict is also a bot busy with a task, or a 会话方式 notice still being posted
      if (error instanceof CommandError && error.kind === 'conflict') throw new CommandError('conflict', `${error.message}\n群设置刚被别处改过的话，运行 vonvon group show ${wanted} 看最新的再改。`, { reason: error.reason ?? 'conflict' });
      throw error;
    }
    const done = applied('改群设置', reply);
    const record = done.project ?? await readGroup(call, membership).catch(() => undefined);
    return { done, record, membership, project, chosen };
  });
  const said = changed.map(change => change === 'enabled' ? (enabled ? '已启用' : '已停用')
    : change === 'conversation' ? `会话方式 → ${conversationCopy[conversation!].name}`
    : change === 'folder' ? `文件夹 → ${result.chosen?.displayPath ?? folder}` : `项目 → 「${result.project?.name ?? options.project}」`);
  const group = result.record ? groupView(result.record, result.membership.response) : undefined;
  const human = [`已改「${result.membership.name}」：${said.join('，')}`];
  if (group && result.record) human.push(groupLine(group, result.record.backend));
  if (result.done.warning) human.push(result.done.warning);
  if (result.done.message) human.push(result.done.message);
  print(io, human, { ...group ? { group } : {}, changed, ...result.done.warning ? { warning: result.done.warning } : {}, ...result.done.message ? { message: result.done.message } : {} });
}

const GROUP_EFFECT = {
  left: 'Bot 已退出这个群。',
  transferred: '群主已转给你，Bot 已退出。',
  failed: '已解绑，但 Bot 没能退出飞书群，要自己在飞书里移除。',
} as const;

/**
 * `vonvon group unbind` (cli-3-groups 4.2): the web page's 解除群绑定. Without --yes nothing is sent but the read: the
 * failure says what the web page's confirmation says, and what would be unbound. A bot that could not leave the Feishu
 * group still unbound it, so that is exit 0 with `groupEffect: 'failed'`.
 */
export async function runGroupUnbind(wanted: string, options: { yes?: boolean; bot?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const unknown = '可能已经解绑，运行 vonvon group list 查看。';
  const { membership, done } = await daemon(async call => {
    const { snapshot, agent, membership } = await botGroup(call, options, wanted);
    const record = await readGroup(call, membership);
    if (!options.yes) {
      const group = groupView(record, membership.response);
      const groupName = snapshot.groups.find(each => each.id === membership.groupId)?.name ?? membership.name;
      throw new CommandError('bad-args', `解除 ${agent.name} 与「${groupName}」的关联。Bot 加入的群会退出；Bot 创建的群会尝试转交群主。本地目录和文件保留。确认后加 --yes 再运行一次。`, {
        reason: 'confirm_required', partial: { groupId: group.groupId, name: group.name, folder: group.folder, tool: group.tool, conversation: group.conversation },
      });
    }
    const reply = await call('解绑群', c => c.collaboration({ action: 'removeProject', ...target(membership), expectedRevision: record.revision }), { feishu: true, unknown });
    return { membership, done: applied('解绑群', reply) };
  });
  const human = [`已解绑「${membership.name}」（${membership.groupId}）。`];
  if (done.groupEffect) human.push(GROUP_EFFECT[done.groupEffect]);
  if (done.warning) human.push(`飞书群后续操作未完成：${done.warning}`);
  print(io, human, { unbound: { groupId: membership.groupId, name: membership.name }, ...done.groupEffect ? { groupEffect: done.groupEffect } : {}, ...done.warning ? { warning: done.warning } : {} });
}
