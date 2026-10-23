import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandSchema, conversationCopy, groupIdSchema, replyModeSchema, toolSchema, type AgentId, type Conversation } from '@vonvon/protocol';
import {
  conversationLabel, localTime, pickBot, print, toolLabel, want, withDaemon, withoutAvatar, type Call, type Daemon, type Io,
} from '../daemon-client';

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

export type BindOptions = { folder: string; name?: string; tool?: string; conversation?: string; response?: string; bot?: string };

/** `--conversation` values: multi / single / smart (product.md 3.4's 多会话、单会话、智能); the wire names threads / shared still work. */
const CONVERSATIONS: Record<string, Conversation> = { multi: 'threads', single: 'shared', smart: 'smart', threads: 'threads', shared: 'shared' };
const CONVERSATION_HELP = `--conversation 必须选一项：multi（${conversationCopy.threads.title}）、single（${conversationCopy.shared.title}）或 smart（${conversationCopy.smart.title}）。`;
/** 智能 has no 免@ (3.4, s25c). */
const SMART_RESPONSE_HELP = `${conversationCopy.smart.title}由 Bot 判断回不回，没有免 @，不能带 --response。`;
export type Host = { cwd: string; home: string; platform: NodeJS.Platform };

/** Everything that can be checked offline is checked before connecting, so a typo sends no RPC. */
export async function runGroupBind(rawGroupId: string, options: BindOptions, io: Io, daemon: Daemon = withDaemon,
  host: Host = { cwd: process.cwd(), home: homedir(), platform: process.platform }): Promise<void> {
  const groupId = groupIdSchema.safeParse(rawGroupId);
  if (!groupId.success) throw new Error('群 id 应该以 oc_ 开头。用 vonvon group pending 或 vonvon group joined 查。');
  const tool = toolSchema.safeParse(options.tool ?? 'codex');
  if (!tool.success) throw new Error('--tool 只能是 codex 或 claude。');
  const picked = options.conversation !== undefined && Object.hasOwn(CONVERSATIONS, options.conversation) ? CONVERSATIONS[options.conversation] : undefined;
  if (picked === undefined) throw new Error(CONVERSATION_HELP);
  const conversation = { data: picked };
  if (picked === 'smart' && options.response !== undefined) throw new Error(SMART_RESPONSE_HELP);
  const response = options.response === undefined ? undefined : replyModeSchema.safeParse(options.response);
  if (response && !response.success) throw new Error('--response 只能是 mention（@ 我才回）或 all（免 @，不 @ 也回）。');
  // Left out: 3.4's default, 多会话开，单会话关; the daemon writes the same. Only a different pick goes
  // on the wire, so a daemon from before s21 still takes the default case.
  const fallback = picked === 'threads' ? 'all' : 'mention';
  const reply = response?.data ?? fallback;
  const sent = reply === fallback ? {} : { response: reply };
  // bash leaves --folder=~/x alone, and the daemon resolves relative paths against its own working directory.
  const expanded = options.folder === '~' || options.folder.startsWith('~/') ? join(host.home, options.folder.slice(1)) : options.folder;
  const folder = resolve(host.cwd, expanded);
  const info = await stat(folder).catch(() => undefined);
  if (!info) throw new Error(`文件夹不存在：${folder}`);
  if (!info.isDirectory()) throw new Error(`不是文件夹：${folder}`);
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
    if (name === undefined) throw new Error('找不到这个群的名字，用 --name 指定项目名。');
    const command = commandSchema.safeParse({ type: 'bindGroup', agentId: agent.id, groupId: groupId.data, projectName: name, folder: { kind: 'existing', folderToken: randomUUID() }, tool: tool.data, conversation: conversation.data, ...sent });
    if (!command.success || command.data.type !== 'bindGroup') throw new Error('项目名要 1 到 100 个字，不能有 / 、\\ 和控制字符，用 --name 换一个。');
    const projectName = command.data.projectName;
    const chosen = want('选择文件夹', await call('选择文件夹', c => c.directory({ type: 'choose', path: folder })), 'folderChosen').folder;
    const bound = await call('绑定群', c => c.run({ type: 'bindGroup', agentId: agent.id, groupId: groupId.data, projectName, folder: { kind: 'existing', folderToken: chosen.token }, tool: tool.data, conversation: conversation.data, ...sent }), { feishu: true, unknown });
    const view = tool.data === 'codex'
      ? want('读取群设置', await call('读取群设置', c => c.settings({ type: 'read', scope: { kind: 'project', botId: agent.id, projectName } })), 'view').view
      : undefined;
    const fullOnly = view && 'identity' in view && 'fullOnly' in view.identity ? view.identity.fullOnly : undefined;
    return { fullOnly, revision: want('绑定群', bound, 'applied', unknown).revision, name: projectName, folder: chosen.displayPath, several: snapshot.agents.length > 1, agentId: agent.id };
  });
  const smart = picked === 'smart';
  const human = [`已绑定 ${result.name}（${groupId.data}）→ ${result.folder} · ${tool.data === 'codex' ? 'Codex' : 'Claude'} · ${conversationLabel(conversation.data)}${smart ? '' : ` · 免 @ ${reply === 'all' ? '开' : '关'}`}`];
  if (result.fullOnly) {
    human.push(`${result.fullOnly} 运行：vonvon settings set${result.several ? ` --bot ${result.agentId}` : ''} --group ${groupId.data} permission.mode=full`);
  }
  print(io, human, { groupId: groupId.data, name: result.name, folder: result.folder, tool: tool.data, conversation: conversation.data, ...(smart ? {} : { response: reply }), revision: result.revision });
}
