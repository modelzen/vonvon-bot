import {groupDecisionSchema, groupIdentitySchema, type GroupDecision, type GroupIdentity} from '@vonvon/protocol';
import { createTopicContext } from '../bot/topic-context';
import { createNameBook } from '../bot/names';
import { paths } from '../config/paths';
import type { BotIdentity } from '../config/bots';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { bindModeFor, joinExistingGroup } from '../project/lifecycle';
import { listProjects, type Project, type SessionMode } from '../project/registry';
import { isProjectId } from '../project/library';
import { log } from '../core/logger';
import { feishuError, scopeDenial } from '../utils/feishu-error';
import { AdminWriteError } from './ops';

export interface BindGroupInput {
  chatId: string;
  projectName: string;
  directory?: string;
  /** Join this library project (its id) instead of making one; with no folder and no project, a group unbound before comes back to its own. */
  project?: string;
  backend: 'codex-appserver' | 'claude-agent';
  kind: SessionMode;
  /** 免@; left out → 3.4's default for `kind`. 智能 has none and refuses it. */
  noMention?: boolean;
  judge?: GroupDecision;
}
export type AdminGroupOp = { kind: 'joinedGroups'; cursor?: string } | { kind: 'groupMembers'; chatId: string; cursor?: string }
  | {kind: 'groupIdentity'; chatId: string; identity: BotIdentity}
  | {kind: 'groupMembership'; chatId: string; identity: BotIdentity} | { kind: 'bindGroup'; input: BindGroupInput };
export interface GroupMembership {inChat: true}
export function parseGroupMembership(raw: unknown): GroupMembership {
  if (!raw || typeof raw !== 'object' || !('inChat' in raw) || raw.inChat !== true) throw new GroupUpstreamError('无法确认机器人群成员身份');
  return {inChat: true};
}
export interface JoinedGroups {
  groups: { chatId: string; name: string; bound: boolean; hasOtherBots?: boolean }[];
  nextCursor?: string;
}
export interface GroupMembers {
  members: { openId: string; name: string }[];
  nextCursor?: string;
}
export function parseGroupMembers(raw: unknown): GroupMembers {
  if (!raw || typeof raw !== 'object' || !('members' in raw) || !Array.isArray(raw.members)) throw new GroupUpstreamError('群成员响应无效');
  const members = raw.members.map(member => {
    if (!member || typeof member !== 'object' || typeof member.openId !== 'string' || !member.openId || typeof member.name !== 'string') throw new GroupUpstreamError('群成员响应无效');
    return { openId: member.openId, name: member.name };
  });
  if ('nextCursor' in raw && raw.nextCursor !== undefined && (typeof raw.nextCursor !== 'string' || !raw.nextCursor)) throw new GroupUpstreamError('群成员游标无效');
  return { members, ...('nextCursor' in raw && typeof raw.nextCursor === 'string' ? { nextCursor: raw.nextCursor } : {}) };
}
export class GroupUpstreamError extends Error {
  readonly code = 'GROUP_UPSTREAM';
}
export class InvalidGroupInput extends Error { readonly code = 'INVALID_GROUP_INPUT'; }
/** 智能 has no 免@ (3.4): a bind or a new group that asks for both is refused (s25c). */
export const SMART_NO_MENTION = '智能开话题由 Bot 判断回不回，没有免 @';

export function parseBindGroupInput(raw: Record<string, unknown>): BindGroupInput {
  const { chatId, projectName, directory, project, backend, kind, noMention, judge } = raw;
  if (Object.keys(raw).some(key => !['chatId', 'projectName', 'directory', 'project', 'backend', 'kind', 'noMention', 'judge'].includes(key)) ||
      (project !== undefined && (!isProjectId(project) || directory !== undefined)) ||
      typeof chatId !== 'string' || !/^oc_[\w-]{1,200}$/.test(chatId) ||
      typeof projectName !== 'string' || !projectName.trim() || projectName.length > 200 || /[\x00-\x1f]/.test(projectName) ||
      (directory !== undefined && (typeof directory !== 'string' || !isAbsolute(directory) || directory.length > 4096 || /[\x00-\x1f]/.test(directory))) ||
      (backend !== 'codex-appserver' && backend !== 'claude-agent') || (kind !== 'multi' && kind !== 'single' && kind !== 'smart') || (noMention !== undefined && typeof noMention !== 'boolean')) {
    throw new InvalidGroupInput('群绑定参数无效');
  }
  if (judge !== undefined && !groupDecisionSchema.safeParse(judge).success) throw new InvalidGroupInput('决策模型设置无效');
  if (kind === 'smart' && noMention !== undefined) throw new InvalidGroupInput(SMART_NO_MENTION);
  return { chatId, projectName: projectName.trim(), directory, ...(project === undefined ? {} : { project }), backend, kind, ...(judge === undefined ? {} : {judge: groupDecisionSchema.parse(judge)}), ...(noMention === undefined ? {} : { noMention }) };
}

export function parseJoinedGroups(raw: unknown): JoinedGroups {
  if (!raw || typeof raw !== 'object' || !('groups' in raw) || !Array.isArray(raw.groups)) throw new GroupUpstreamError('群列表响应无效');
  const groups = raw.groups.map(group => {
    if (!group || typeof group !== 'object' || typeof group.chatId !== 'string' || typeof group.name !== 'string' || typeof group.bound !== 'boolean') throw new GroupUpstreamError('群列表响应无效');
    if ('hasOtherBots' in group && group.hasOtherBots !== undefined && typeof group.hasOtherBots !== 'boolean') throw new GroupUpstreamError('群列表响应无效');
    return { chatId: group.chatId, name: group.name, bound: group.bound, ...('hasOtherBots' in group && typeof group.hasOtherBots === 'boolean' ? { hasOtherBots: group.hasOtherBots } : {}) };
  });
  if ('nextCursor' in raw && raw.nextCursor !== undefined && typeof raw.nextCursor !== 'string') throw new GroupUpstreamError('群列表游标无效');
  return { groups, ...('nextCursor' in raw && typeof raw.nextCursor === 'string' ? { nextCursor: raw.nextCursor } : {}) };
}

/** Listing groups and checking membership need this scope; it is in the one-click grant link. */
const GROUP_READ_SCOPE = 'im:chat:readonly';
/** Shown for a chat Feishu lists without a name, so one odd item cannot fail the whole list. */
export const UNNAMED_GROUP = '（未命名群）';
type GroupPhase = 'joined-groups' | 'bind-group' | 'group-members';

/**
 * What the desktop shows for a failed Feishu group call. The SDK throws axios errors whose message
 * is only "Request failed with status code 400"; Feishu's own code and msg are in the body.
 */
export function describeGroupFailure(failure: unknown): string {
  const denial = scopeDenial(failure);
  if (denial) {
    if (!denial.accepted.length || denial.accepted.includes(GROUP_READ_SCOPE)) {
      return `缺少飞书权限 ${GROUP_READ_SCOPE}（读取群信息）。在 Bot 设置点「一键开权限」，再到开发者后台创建版本并发布。`;
    }
    return `缺少飞书权限 ${denial.accepted.slice(0, 4).join(' 或 ')}（读取群信息）。到开发者后台开通其中一项，再创建版本并发布。`;
  }
  const feishu = feishuError(failure);
  if (feishu) return `飞书接口出错 code=${feishu.code}：${feishu.msg ?? '没有说明'}`;
  return `飞书群接口调用失败：${failure instanceof Error ? failure.message : String(failure)}`;
}

/** Log the raw failure (with Feishu's body) and throw the readable one. */
function upstream(phase: GroupPhase): (failure: unknown) => never {
  return failure => {
    log.fail('groups', failure, { phase });
    throw new GroupUpstreamError(describeGroupFailure(failure));
  };
}

/** A reply Feishu resolved but did not answer properly; a non-zero code reads like a thrown one. */
function refused(phase: GroupPhase, reply: { code?: number; msg?: string }, fallback: string): never {
  const feishu = feishuError(reply);
  const error = new GroupUpstreamError(feishu ? describeGroupFailure(reply) : fallback);
  log.fail('groups', error, { phase, ...feishu });
  throw error;
}

export function createGroupExecutor(channel: LarkChannel, identity: BotIdentity, projectsRootDir?: string): (op: AdminGroupOp) => Promise<JoinedGroups | GroupMembers | GroupMembership | GroupIdentity | Project> {
  const bot = { ...identity };
  const topicContext = createTopicContext(channel, undefined, createNameBook(channel), { stopping: () => false, track: p => p });
  async function bind(request: BindGroupInput): Promise<Project> {
    const input = { ...request };
    const location = { file: paths.projectsFile, dataRoot: paths.appDir };
    let directory: string | undefined;
    if (input.directory !== undefined) try {
      directory = await realpath(input.directory);
      if (!(await stat(directory)).isDirectory()) throw new Error('not directory');
    } catch { throw new InvalidGroupInput('所选文件夹不存在或不是目录'); }
    const membership = await channel.rawClient.im.v1.chatMembers.isInChat({ path: { chat_id: input.chatId } }).catch(upstream('bind-group'));
    if (membership.code !== 0 || typeof membership.data?.is_in_chat !== 'boolean') refused('bind-group', membership, '无法确认机器人群成员身份');
    if (!membership.data.is_in_chat) throw new AdminWriteError('机器人不在此群中');
    try {
      return await joinExistingGroup(channel, { bot, name: input.projectName, chatId: input.chatId, existingPath: directory, project: input.project, projectsRootDir, backend: input.backend, kind: input.kind, noMention: input.noMention, judge: input.judge, mode: bindModeFor(input.backend) }, location);
    } catch (error) {
      throw new AdminWriteError(error instanceof Error ? error.message : '群绑定失败');
    }
  }
  return async op => {
    if (op.kind === 'groupMembership' || op.kind === 'groupIdentity') {
      const expected = op.identity;
      if (expected.appId !== bot.appId || expected.tenant !== bot.tenant || expected.createdAt !== bot.createdAt
        || expected.registrationId !== bot.registrationId) throw new AdminWriteError('机器人身份已改变，请重启后再试');
      const membership = await channel.rawClient.im.v1.chatMembers.isInChat({path: {chat_id: op.chatId}}).catch(upstream('group-members'));
      if (membership.code !== 0 || typeof membership.data?.is_in_chat !== 'boolean') refused('group-members', membership, '无法确认机器人群成员身份');
      if (!membership.data.is_in_chat) throw new AdminWriteError('机器人不在此群中');
      if (op.kind === 'groupMembership') return {inChat: true};
      const info = await channel.rawClient.im.v1.chat.get({path: {chat_id: op.chatId}}).catch(upstream('group-members'));
      if (info.code !== 0 || typeof info.data?.name !== 'string' || !info.data.name.trim()) refused('group-members', info, '无法读取飞书群名');
      return groupIdentitySchema.parse({kind: 'groupIdentity', agentId: bot.appId, groupId: op.chatId, name: info.data.name});
    }
    if (op.kind === 'bindGroup') {
      return bind(op.input);
    }
    if (op.kind === 'groupMembers') {
      const membership = await channel.rawClient.im.v1.chatMembers.isInChat({ path: { chat_id: op.chatId } }).catch(upstream('group-members'));
      if (membership.code !== 0 || typeof membership.data?.is_in_chat !== 'boolean') refused('group-members', membership, '无法确认机器人群成员身份');
      if (!membership.data.is_in_chat) throw new AdminWriteError('机器人不在此群中');
      const reply = await channel.rawClient.im.v1.chatMembers.get({ path: { chat_id: op.chatId }, params: { member_id_type: 'open_id', page_size: 100, ...(op.cursor ? { page_token: op.cursor } : {}) } }).catch(upstream('group-members'));
      if (reply.code !== 0 || !Array.isArray(reply.data?.items)) refused('group-members', reply, '飞书群成员响应无效');
      if (reply.data.has_more && !reply.data.page_token) refused('group-members', {}, '飞书群成员缺少下一页游标');
      const members = reply.data.items.map(member => {
        if (!member.member_id) refused('group-members', {}, '飞书群成员缺少 open_id');
        return { openId: member.member_id, name: member.name || '（未命名成员）' };
      });
      return { members, ...(reply.data.has_more ? { nextCursor: reply.data.page_token } : {}) };
    }
    const response = await channel.rawClient.im.v1.chat.list({ params: { page_size: 50, ...(op.cursor ? { page_token: op.cursor } : {}) } }).catch(upstream('joined-groups'));
    if (response.code !== 0 || !response.data || !Array.isArray(response.data.items)) refused('joined-groups', response, '飞书群列表响应无效');
    const projects = await listProjects();
    // A chat without an id cannot be bound, so it is left out; one without a name is still listed.
    const groups = response.data.items.flatMap(item => item.chat_id ? [{
      chatId: item.chat_id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name : UNNAMED_GROUP,
      bound: projects.some(project => project.chatId === item.chat_id),
    }] : []);
    if (response.data.has_more && !response.data.page_token) refused('joined-groups', {}, '飞书群列表缺少下一页游标');
    const enriched = await Promise.all(groups.map(async group => {
      const info = await topicContext.chatInfo(group.chatId);
      return { ...group, ...(info.ok && info.bots !== undefined ? { hasOtherBots: info.bots > 1 } : {}) };
    }));
    return { groups: enriched, ...(response.data.has_more ? { nextCursor: response.data.page_token } : {}) };
  };
}
