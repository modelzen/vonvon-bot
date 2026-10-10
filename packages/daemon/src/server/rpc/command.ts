import { groupIdSchema, pendingGroupsSchema, type Command, type CommandResult, type Diagnostic } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { ShutdownControl } from '../../host/lifecycle';
import type { DirectoryBrowser } from '../directory-browser';
import { RpcError, unsupported } from '../errors';
import type { Jobs, JobPeer } from '../jobs';
import type { RpcOutcome } from '../rpc';
import type { SnapshotStore } from '../snapshot';
import { diagnosis } from './admin';

export async function commandRpc(options: { service: AdminService; jobs: Jobs; peer: JobPeer; directory: DirectoryBrowser; snapshots: SnapshotStore; control?: ShutdownControl; port: number }, request: Command): Promise<RpcOutcome<CommandResult>> {
  const { service, jobs, peer, directory, snapshots, control, port } = options;
  const applied: RpcOutcome<CommandResult> = { kind: 'mutation', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }) };
  switch (request.type) {
    case 'registerAgent': case 'refreshAgentCredentials': {
      const value = jobs.startRegistration(peer, request.type === 'refreshAgentCredentials' ? request.agentId : undefined);
      return { kind: 'mutation', reply: () => value };
    }
    case 'installCodex': case 'startCodexLogin': {
      const value = jobs.startCodex(request.type === 'installCodex' ? 'install' : 'login');
      return { kind: 'mutation', reply: () => value };
    }
    case 'cancelJob': {
      const value = await jobs.cancel(request.jobId);
      return { kind: 'mutation', reply: () => value };
    }
    case 'listPendingGroups': {
      if (!service.pendingGroups) return unsupported();
      return { kind: 'read', value: { kind: 'pendingGroups', ...pendingGroupsSchema.parse(await service.pendingGroups(request.agentId)) } };
    }
    case 'listJoinedGroups': {
      if (!service.joinedGroups) return unsupported();
      const result = await service.joinedGroups(request.agentId, request.cursor);
      return { kind: 'read', value: { kind: 'groups', groups: result.groups.map(group => ({ id: groupIdSchema.parse(group.chatId), name: group.name, bound: group.bound })), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) } };
    }
    case 'bindGroup': {
      if (!service.bindGroup) return unsupported();
      await service.bindGroup(request.agentId, { chatId: request.groupId, projectName: request.projectName, directory: await directory.resolve(request.folderToken), backend: request.tool === 'codex' ? 'codex-appserver' : 'claude-agent', kind: request.conversation === 'threads' ? 'multi' : 'single' });
      return applied;
    }
    case 'setPermission': case 'setResponse': {
      const member = snapshots.current().memberships.find(member => member.id === request.membershipId);
      if (!member || member.stale) throw new RpcError('invalid_membership', '群绑定不存在或状态已失效，请刷新后重试。');
      if (request.type === 'setPermission') await service.setPermissionMode(member.agentId, member.name, { mode: request.administrator, guestMode: request.member, network: request.network });
      else await service.setNoMention(member.agentId, member.name, request.response === 'all');
      return applied;
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
    case 'inspectAgent': {
      const result = await diagnosis(service, request.agentId);
      const diagnostics: Diagnostic[] = result.backends.map(backend => ({ title: backend.name, message: backend.hint ?? backend.version ?? '', status: backend.ok ? 'ok' : 'warning' }));
      if (result.event) diagnostics.push({ title: '事件订阅', message: result.event.reason ?? result.event.state, status: result.event.state === 'ok' ? 'ok' : 'warning', ...(result.eventConfigUrl ? { eventConfigUrl: result.eventConfigUrl } : {}) });
      snapshots.diagnose(request.agentId, diagnostics);
      return applied;
    }
    case 'restartHost': {
      if (!control) return unsupported();
      return { kind: 'shutdown', reply: snapshot => ({ kind: 'applied', revision: snapshot.revision }), afterReply: () => control.requestRestart(port) };
    }
    default: return unsupported();
  }
}
