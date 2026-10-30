import { scheduleReplySchema, type Hello, type ScheduleReply, type ScheduleRequest } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import { log } from '../../core/logger';
import type { RpcOutcome } from '../rpc';
import { RpcError, unsupported } from '../errors';

/** The desktop app and the browser page are the same owner UI; `cli` is `vonvon schedule`. */
const VIA = { desktop: 'desktop', web: 'desktop', cli: 'cli' } as const satisfies Record<Hello['clientKind'], 'desktop' | 'cli'>;

/**
 * Scheduled tasks over the wire. Whoever holds the local credential is the owner (as for settings), so the bot process
 * runs these as the local actor; scope, roles and refusals are decided there (admin/schedule-commands.ts), and a bot that
 * is not running is a `refused` reply, not an error. Every action, writes too, is a read here: the snapshot carries no
 * tasks, so rebuilding it would only turn a write that landed into an error when the rebuild fails.
 */
export async function scheduleRpc(service: AdminService, clientKind: Hello['clientKind'] | undefined, payload: { botId: string; request: ScheduleRequest }): Promise<RpcOutcome<ScheduleReply>> {
  if (!service.executeSchedule) return unsupported();
  if (!clientKind) throw new RpcError('invalid_request', '连接没有说明客户端类型。');
  const parsed = scheduleReplySchema.safeParse(await service.executeSchedule(payload.botId, VIA[clientKind], payload.request));
  if (!parsed.success) {
    log.warn('schedule', 'reply-invalid', { action: payload.request.action, issues: parsed.error.issues.slice(0, 5).map(issue => `${issue.path.join('.')}: ${issue.message}`) });
    throw new RpcError('operation_failed', 'Bot 回的任务数据格式不对（daemon 和 Bot 进程版本可能不一致）。');
  }
  return { kind: 'read', value: parsed.data };
}
