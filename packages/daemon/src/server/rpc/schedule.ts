import { scheduleReplySchema, type Hello, type ScheduleReply, type ScheduleRequest } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { RpcOutcome } from '../rpc';
import { RpcError, unsupported } from '../errors';

/** The desktop app and the browser page are the same owner UI; `cli` is `vonvon schedule`. */
const VIA = { desktop: 'desktop', web: 'desktop', cli: 'cli' } as const satisfies Record<Hello['clientKind'], 'desktop' | 'cli'>;

/**
 * Scheduled tasks over the wire. Whoever holds the local credential is the owner (as for settings), so the bot process
 * runs these as the local actor; scope, roles and refusals are decided there (admin/schedule-commands.ts), and a bot that
 * is not running is a `refused` reply, not an error. Lists are reads; every other action writes schedules.json.
 */
export async function scheduleRpc(service: AdminService, clientKind: Hello['clientKind'] | undefined, payload: { botId: string; request: ScheduleRequest }): Promise<RpcOutcome<ScheduleReply>> {
  if (!service.executeSchedule) return unsupported();
  if (!clientKind) throw new RpcError('invalid_request', '连接没有说明客户端类型。');
  const reply = scheduleReplySchema.parse(await service.executeSchedule(payload.botId, VIA[clientKind], payload.request));
  if (payload.request.action === 'list' || payload.request.action === 'listBot') return { kind: 'read', value: reply };
  return { kind: 'mutation', reply: () => reply };
}
