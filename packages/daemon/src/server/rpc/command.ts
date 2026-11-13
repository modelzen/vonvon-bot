import { conversationToMode, groupIdSchema, pendingGroupsSchema, type Command, type CommandResult } from '@vonvon/protocol';
import { TIER_NETWORK } from '../../agent/permission';
import { log } from '../../core/logger';
import { SMART_NO_MENTION } from '../../admin/groups';
import type { FeishuReach } from '../../admin/feishu-route';
import type { AdminService } from '../../admin/service';
import type { ShutdownControl } from '../../host/lifecycle';
import type { DirectoryBrowser } from '../directory-browser';
import { feishuReadProblem } from '../../agent/entry/feishu-tools';
import { RpcError, unsupported } from '../errors';
import type { Jobs, JobPeer } from '../jobs';
import type { PeerOwner } from '../peer-label';
import type { RpcOutcome } from '../rpc';
import type { SnapshotStore } from '../snapshot';
import { requireRunningAgent } from './ownership';

/**
 * `owner`: the client the connection belongs to (devices-ui-3 `peerOwner`), which a scan it starts is kept for. `feishu`: the
 * Bot and chat authz keeps a Feishu read to (dm-agent 7.2).
 */
export async function commandRpc(options: { service: AdminService; jobs: Jobs; peer: JobPeer; owner?: PeerOwner; directory: DirectoryBrowser; snapshots: SnapshotStore; control?: ShutdownControl; port: number; feishu?: FeishuReach }, request: Command): Promise<RpcOutcome<CommandResult>> {
  const { service, jobs, peer, directory, snapshots, control, port } = options;
  const applied: RpcOutcome<CommandResult> = { kind: 'mutation', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }) };
  switch (request.type) {
    case 'refresh':
      // Provider checks need a fresh probe; ordinary page refreshes stay inexpensive.
      if (request.tools) await snapshots.refreshTools();
      return applied;
    case 'registerAgent': case 'refreshAgentCredentials': {
      const value = jobs.startRegistration(peer, request.type === 'refreshAgentCredentials' ? request.agentId : undefined, options.owner);
      return { kind: 'mutation', reply: () => value };
    }
    case 'cancelJob': {
      const value = await jobs.cancel(request.jobId);
      return { kind: 'mutation', reply: () => value };
    }
    case 'listPendingGroups': {
      await requireRunningAgent(service, request.agentId);
      if (!service.pendingGroups) return unsupported();
      return { kind: 'read', value: { kind: 'pendingGroups', ...pendingGroupsSchema.parse(await service.pendingGroups(request.agentId)) } };
    }
    case 'readGroupIdentity': {
      await requireRunningAgent(service, request.agentId);
      if (!service.readGroupIdentity) return unsupported();
      return {kind: 'read', value: await service.readGroupIdentity(request.agentId, request.groupId)};
    }
    case 'listJoinedGroups': {
      await requireRunningAgent(service, request.agentId);
      if (!service.joinedGroups) return unsupported();
      const result = await service.joinedGroups(request.agentId, request.cursor);
      return { kind: 'read', value: { kind: 'groups', groups: result.groups.map(group => ({ id: groupIdSchema.parse(group.chatId), name: group.name, bound: group.bound, ...(group.hasOtherBots === undefined ? {} : { hasOtherBots: group.hasOtherBots }) })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) } };
    }
    case 'listGroupMembers': {
      await requireRunningAgent(service, request.agentId);
      if (!service.groupMembers) return unsupported();
      const result = await service.groupMembers(request.agentId, request.groupId, request.cursor);
      return { kind: 'read', value: { kind: 'members', ...result } };
    }
    case 'feishuRead': {
      if (!service.feishuRead) return unsupported();
      const problem = feishuReadProblem(request);
      if (problem) throw new RpcError('invalid_request', problem);
      const reply = await service.feishuRead({ ...(request.agentId ? { bot: request.agentId } : {}), ...options.feishu }, { tool: request.tool, args: request.args });
      return { kind: 'read', value: reply.ok ? { kind: 'feishuRead', result: reply.result } : { kind: 'refused', code: 'feishu_read_refused', message: reply.message } };
    }
    case 'bindGroup': {
      await requireRunningAgent(service, request.agentId);
      if (!service.bindGroup) return unsupported();
      if (request.conversation === 'smart' && request.response !== undefined) throw new RpcError('invalid_request', `${SMART_NO_MENTION}。`);
      await service.bindGroup(request.agentId, { chatId: request.groupId, projectName: request.projectName, directory: request.folder.kind === 'existing' ? await directory.resolve(request.folder.folderToken) : undefined, ...(request.project ? { project: request.project } : {}), backend: request.tool === 'codex' ? 'codex-appserver' : 'claude-agent', kind: conversationToMode(request.conversation), ...(request.judge ? {judge:request.judge} : {}), ...(request.response ? { noMention: request.response === 'all' } : {}) });
      return applied;
    }
    case 'setPermission': case 'setResponse': {
      const member = snapshots.current().memberships.find(member => member.id === request.membershipId);
      if (!member || member.stale) throw new RpcError('invalid_membership', '群绑定不存在或状态已失效，请刷新后重试。');
      if (request.type === 'setPermission') {
        if (request.network !== undefined && request.network !== TIER_NETWORK[request.administrator]) {
          throw new RpcError('invalid_request', '联网已经并进权限的档位：只读不联网，工作区可写联网，完全访问不限制。只读又要联网这类组合，用高级设置 permission.custom。');
        }
        if (request.network !== undefined) log.warn('permission', 'rpc-network-ignored');
        await service.setPermissionMode(member.agentId, member.name, { mode: request.administrator });
      }
      else await service.setNoMention(member.agentId, member.name, request.response === 'all');
      return applied;
    }
    case 'setAgentBadgeNumber': {
      const result = await service.setBotBadgeNumber(request.agentId, request.badgeNumber);
      return result.ok ? applied : {kind: 'mutation', reply: () => ({kind: 'refused', code: 'badge_number_refused', message: result.reason})};
    }
    case 'setAgentEnabled': {
      const result = await service.setBotEnabled(request.agentId, request.enabled);
      if (!result.ok) return { kind: 'mutation', reply: () => ({ kind: 'refused', code: 'activation_failed', message: result.reason }) };
      if (result.activation === 'restartRequired') return { kind: 'mutation', reply: () => ({ kind: 'activationPending', message: result.message }) };
      return applied;
    }
    case 'deleteAgent': {
      const result = await service.deleteBot(request.agentId);
      return result.ok ? applied : { kind: 'mutation', reply: () => ({ kind: 'refused', code: 'delete_failed', message: result.reason }) };
    }
    case 'restartHost': {
      if (!control) return unsupported();
      return { kind: 'shutdown', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }), afterReply: () => control.requestRestart(port) };
    }
    default: return unsupported();
  }
}
