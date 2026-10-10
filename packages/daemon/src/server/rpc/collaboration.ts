import { randomUUID } from 'node:crypto';
import { collaborationReplySchema, type CollaborationRequest, type CollaborationReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { CollaborationRequest as ServiceRequest } from '../../admin/collaboration';
import type { DirectoryBrowser } from '../directory-browser';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';
import { requireRunningAgent } from './ownership';

export async function collaborationRpc(service: AdminService, directory: DirectoryBrowser, request: CollaborationRequest): Promise<RpcOutcome<CollaborationReply>> {
  if (request.action === 'usage') return { kind: 'read', value: collaborationReplySchema.parse({ kind: 'usage', data: await service.accountUsage(request.force) }) };
  if (request.action === 'openGroup') return unsupported();
  await requireRunningAgent(service, request.agentId);
  if (!service.collaboration) return unsupported();
  let operation: ServiceRequest;
  if (request.action === 'createProject') {
    operation = { action: 'createProject', requestId: randomUUID(), name: request.name, kind: request.conversation === 'threads' ? 'multi' : 'single', backend: request.tool === 'codex' ? 'codex-appserver' : 'claude-agent', ...(request.folder.kind === 'existing' ? { directory: await directory.resolve(request.folder.folderToken) } : {}) };
  } else if (request.action === 'editProject') {
    operation = { action: 'editProject', projectName: request.projectName, chatId: request.groupId, expectedRevision: request.expectedRevision, ...(request.folderToken ? { directory: await directory.resolve(request.folderToken) } : {}), ...(request.conversation ? { kind: request.conversation === 'threads' ? 'multi' : 'single' } : {}), ...(request.enabled !== undefined ? { enabled: request.enabled } : {}) };
  } else {
    const { agentId: _agentId, groupId, ...rest } = request;
    operation = { ...rest, chatId: groupId };
  }
  const value = collaborationReplySchema.parse(await service.collaboration(request.agentId, operation));
  if (request.action === 'project' || request.action === 'history' || request.action === 'context') return { kind: 'read', value };
  return { kind: 'mutation', reply: () => value };
}
