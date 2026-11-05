import type { MemoryReply, MemoryRequest } from '@vonvon/protocol';
import { memoryAction, type MemoryAdminDeps } from '../../admin/memory';
import { NotWiredYetError, type AdminService } from '../../admin/service';
import { SESSION_TURN_ENDED } from '../../agent/entry/registry';
import { RpcError } from '../errors';
import type { RpcOutcome } from '../rpc';

const READS = new Set<MemoryRequest['type']>(['list', 'export', 'events', 'newCounts', 'seen', 'dmPeople']);

/**
 * Reads change nothing, so they stay reads (no rebuild, no revision). Every other request writes memory files: the
 * read-only preview process (no daemon, no lease) refuses them, and the daemon answers them as mutations.
 */
export async function memoryRpc(service: AdminService, request: MemoryRequest, deps: Pick<MemoryAdminDeps, 'origin' | 'landing'> & { session?: boolean } = {}): Promise<RpcOutcome<MemoryReply>> {
  const { session, ...admin } = deps;
  if (READS.has(request.type)) return { kind: 'read', value: await memoryAction(request, admin) };
  // A Bot session's write without its Bot process's say on where it lands would be the owner's: never.
  if (session && !admin.landing) throw new RpcError('permission_denied', SESSION_TURN_ENDED);
  if (service.readonlyPreview) throw new NotWiredYetError('记忆修改');
  const value = await memoryAction(request, admin);
  return { kind: 'mutation', reply: () => value };
}
