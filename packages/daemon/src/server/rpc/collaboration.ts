import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { collaborationReplySchema, conversationToMode, groupIdSchema, projectRecordSchema, type CollaborationRequest, type CollaborationReply } from '@vonvon/protocol';
import { SMART_NO_MENTION } from '../../admin/groups';
import type { AdminService } from '../../admin/service';
import type { CollaborationRequest as ServiceRequest } from '../../admin/collaboration';
import { UsageError, type UsageErrorKind } from '../../agent/types';
import { AdminWriteError } from '../../admin/ops';
import { NotWiredYetError } from '../../admin/service';
import { CREATED_UNSAVED, CREATION_UNKNOWN, type GroupInvitee } from '../../project/lifecycle';
import type { DirectoryBrowser } from '../directory-browser';
import type { RpcOutcome } from '../rpc';
import { getRpcErrorCode, RpcError, unsupported } from '../errors';
import { requireRunningAgent } from './ownership';
import { discoverProviderModels } from '../../admin/model-catalog';
import { toolCommand } from '../../environment/tool-command';

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
    subagents: z.array(z.object({ id: z.string(), name: z.string(), task: z.string(), status: z.enum(['running', 'completed', 'failed', 'stopped']), stoppable: z.boolean() })).optional(),
  }).nullable(),
});
const shareResult = z.object({ messageId: z.string().min(1) });

/** `login`: what signs Codex in from a terminal; a managed copy is on no PATH (0.9.0 Linux acceptance). */
const usageErrorMessages = (login: string): Record<UsageErrorKind, string> => ({
  'no-auth': '这台设备上的 Codex 没有用 ChatGPT 账号，看不到账号用量。',
  'api-key-mode': '当前 Codex 用的是 API Key，没有 ChatGPT 账号的用量可读。',
  'need-relogin': `Codex 的 ChatGPT 账号凭据过期了，在终端运行 \`${login}\` 后再看。`,
  transient: '暂时无法读取 Codex 用量，请稍后重试。',
});

/** What Claude's quota column says when the account has no quota to show; the local stats still come back. */
const claudeQuotaGaps = (login: string): Record<UsageErrorKind, string> => ({
  'no-auth': '没有读到 Claude 订阅登录，看不到额度',
  'api-key-mode': '用的是 API 接入，没有订阅额度',
  'need-relogin': `订阅凭据过期了，在终端运行 \`${login}\` 后再看`,
  transient: '额度暂时读不到',
});

/** `invitee`: who a group made from a private chat pulls in (authz.ts); the bot's primary admin from the desktop and the terminal. */
export async function collaborationRpc(service: AdminService, directory: DirectoryBrowser, request: CollaborationRequest, invitee?: GroupInvitee): Promise<RpcOutcome<CollaborationReply>> {
  if (request.action === 'providerModels') {
    const result = await discoverProviderModels(request.backend, undefined, request.refresh);
    return { kind: 'read', value: collaborationReplySchema.parse({ kind: 'providerModels', backend: request.backend, state: result.models.length ? 'ready' : 'unavailable', models: result.models, ...(result.message ? { message: result.message } : {}) }) };
  }
  if (request.action === 'usage') {
    const claude = request.backend === 'claude-agent';
    const provider = claude ? 'Claude' : 'Codex';
    try {
      const data = await service.accountUsage(request.force, request.backend ?? 'codex-appserver');
      const { unavailable: gap, ...usage } = data.usage;
      const unavailable = claude && gap ? { reason: gap, message: claudeQuotaGaps(toolCommand('claude'))[gap] } : undefined;
      return { kind: 'read', value: collaborationReplySchema.parse({ kind: 'usage', data: { ...data, usage: { ...usage, ...(unavailable ? { unavailable } : {}) } } }) };
    } catch (error) {
      const messages: Record<UsageErrorKind, string> = claude ? {
        'no-auth': '这台设备上没有可读取的 Claude 订阅凭据，请在该设备上运行 Claude Code 检查配置。',
        'api-key-mode': '当前 Claude 用的是 API 接入，没有订阅额度可读。',
        'need-relogin': `Claude 的订阅凭据过期了，在终端运行 \`${toolCommand('claude')}\` 更新配置后再看。`,
        transient: '暂时无法读取 Claude 用量，请稍后重试。',
      } : usageErrorMessages(`${toolCommand('codex')} login`);
      throw new RpcError(error instanceof UsageError ? 'usage_unavailable' : 'operation_failed', error instanceof UsageError ? messages[error.kind] : `读取 ${provider} 用量失败`);
    }
  }
  let operation: ServiceRequest;
  try {
    await requireRunningAgent(service, request.agentId);
    if (!service.collaboration) return unsupported();
    if (request.action === 'createProject') {
      if (request.conversation === 'smart' && request.response !== undefined) throw new RpcError('invalid_request', `${SMART_NO_MENTION}。`);
      operation = { action: 'createProject', requestId: request.requestId ?? randomUUID(), name: request.name, ...(invitee ? { invitee } : {}), ...(request.project ? { project: request.project } : {}), kind: conversationToMode(request.conversation), ...(request.judge ? {judge:request.judge} : {}), ...(request.response ? { noMention: request.response === 'all' } : {}), backend: request.tool === 'codex' ? 'codex-appserver' : 'claude-agent', ...(request.folder.kind === 'existing' ? { directory: await directory.resolve(request.folder.folderToken) } : {}) };
    } else if (request.action === 'editProject') {
      operation = { action: 'editProject', projectName: request.projectName, chatId: request.groupId, expectedRevision: request.expectedRevision, ...(request.folderToken ? { directory: await directory.resolve(request.folderToken) } : {}), ...(request.project ? { project: request.project } : {}), ...(request.conversation ? { kind: conversationToMode(request.conversation) } : {}), ...(request.enabled !== undefined ? { enabled: request.enabled } : {}) };
    } else {
      const { agentId: _agentId, groupId, ...rest } = request;
      operation = { ...rest, chatId: groupId };
    }
  } catch (error) {
    if (request.action !== 'createProject') throw error;
    throw new RpcError(getRpcErrorCode(error), error instanceof Error ? error.message : '建群前检查失败', {creationRefused:true});
  }
  let raw: unknown;
  try { raw = await service.collaboration(request.agentId, operation); }
  catch (error) {
    // s36d1: only the bot's own refusal says no group was made. A lost IPC answer, a bot that exited or timed out, or
    // a creation the bot itself could not settle, may have made one; the desktop then says so instead of a raw error.
    // A group made and not saved is named as such, with the bot's word on where to bind it.
    const failure = error as {code?: string; chatId?: unknown; message: string} | null;
    if (request.action === 'createProject' && failure?.code === CREATED_UNSAVED) {
      const id = groupIdSchema.safeParse(failure.chatId);
      throw new RpcError('created_unsaved', failure.message, id.success ? {groupId:id.data} : undefined);
    }
    if (request.action === 'createProject' && error instanceof AdminWriteError)
      throw new RpcError('conflict', error.message, {creationRefused:true});
    if (request.action === 'createProject' && !(error instanceof NotWiredYetError)) throw new RpcError('outcome_unknown', CREATION_UNKNOWN);
    throw error;
  }
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
