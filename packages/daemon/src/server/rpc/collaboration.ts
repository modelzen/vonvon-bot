import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { backendByTool, collaborationReplySchema, projectRecordSchema, type CollaborationRequest, type CollaborationReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { CollaborationRequest as ServiceRequest } from '../../admin/collaboration';
import { UsageError, type UsageErrorKind } from '../../agent/types';
import type { DirectoryBrowser } from '../directory-browser';
import type { RpcOutcome } from '../rpc';
import { RpcError, unsupported } from '../errors';
import { requireRunningAgent } from './ownership';

const projectRecord = z.unknown().transform(value => projectRecordSchema.parse(value));
const mutation = z.object({
  ok: z.literal(true),
  project: projectRecord.optional(),
  threadId: z.string().optional(),
  messageId: z.string().optional(),
  groupEffect: z.enum(['left', 'transferred', 'failed']).optional(),
  warning: z.string().optional(),
  message: z.string().optional(),
});
const projectResult = z.object({ project: projectRecord });
const historyResult = z.object({
  sessions: z.array(z.object({
    threadId: z.string(), chatId: z.string(), sessionId: z.string(), summary: z.string(),
    backend: z.string(), cwd: z.string(),
    createdAt: z.number(), updatedAt: z.number(), detached: z.boolean().optional(),
  })),
  threads: z.array(z.object({
    sessionId: z.string(), preview: z.string(), name: z.string().optional(),
    createdAt: z.number(), updatedAt: z.number(),
  })),
  backend: z.string(),
  threadsError: z.string().optional(),
});
const contextResult = z.object({
  threadId: z.string(),
  usage: z.object({ used: z.number(), window: z.number().nullable() }).nullable(),
  run: z.object({
    id: z.string(), goal: z.boolean(), canStop: z.boolean(),
    canEndGoal: z.boolean(), canRemind: z.boolean(), reminderRequested: z.boolean(),
  }).nullable(),
});
const shareResult = z.object({ messageId: z.string().min(1) });

const usageErrorMessages: Record<UsageErrorKind, string> = {
  'no-auth': '请先登录 Codex，再查看用量。',
  'api-key-mode': '当前 Codex 使用 API Key 登录，无法读取 ChatGPT 账号用量。',
  'need-relogin': 'Codex 登录已失效，请重新登录。',
  transient: '暂时无法读取 Codex 用量，请稍后重试。',
};

export async function collaborationRpc(service: AdminService, directory: DirectoryBrowser, request: CollaborationRequest): Promise<RpcOutcome<CollaborationReply>> {
  if (request.action === 'usage') {
    try { return { kind: 'read', value: collaborationReplySchema.parse({ kind: 'usage', data: await service.accountUsage(request.force) }) }; }
    catch (error) {
      throw new RpcError(error instanceof UsageError ? 'usage_unavailable' : 'operation_failed', error instanceof UsageError ? usageErrorMessages[error.kind] : '读取 Codex 用量失败');
    }
  }
  if (request.action === 'openGroup') return unsupported();
  await requireRunningAgent(service, request.agentId);
  if (!service.collaboration) return unsupported();
  let operation: ServiceRequest;
  if (request.action === 'createProject') {
    operation = { action: 'createProject', requestId: randomUUID(), name: request.name, kind: request.conversation === 'threads' ? 'multi' : 'single', backend: backendByTool[request.tool], ...(request.folder.kind === 'existing' ? { directory: await directory.resolve(request.folder.folderToken) } : {}) };
  } else if (request.action === 'editProject') {
    operation = { action: 'editProject', projectName: request.projectName, chatId: request.groupId, expectedRevision: request.expectedRevision, ...(request.folderToken ? { directory: await directory.resolve(request.folderToken) } : {}), ...(request.conversation ? { kind: request.conversation === 'threads' ? 'multi' : 'single' } : {}), ...(request.enabled !== undefined ? { enabled: request.enabled } : {}) };
  } else {
    const { agentId: _agentId, groupId, ...rest } = request;
    operation = { ...rest, chatId: groupId };
  }
  const raw = await service.collaboration(request.agentId, operation);
  let reply: unknown;
  switch (request.action) {
    case 'project': reply = { kind: 'project', ...projectResult.parse(raw) }; break;
    case 'history': reply = { kind: 'history', ...historyResult.parse(raw) }; break;
    case 'context': reply = { kind: 'context', ...contextResult.parse(raw) }; break;
    case 'shareUsage': reply = { kind: 'applied', ...shareResult.parse(raw) }; break;
    default: reply = { kind: 'applied', ...mutation.parse(raw) };
  }
  const value = collaborationReplySchema.parse(reply);
  if (request.action === 'project' || request.action === 'history' || request.action === 'context') return { kind: 'read', value };
  return { kind: 'mutation', reply: () => value };
}
