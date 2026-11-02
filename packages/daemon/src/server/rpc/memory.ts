import type { MemoryReply, MemoryRequest } from '@vonvon/protocol';
import { memoryAction, type MemoryAdminDeps } from '../../admin/memory';
import { NotWiredYetError, type AdminService } from '../../admin/service';
import type { RpcOutcome } from '../rpc';

const READS = new Set<MemoryRequest['type']>(['list', 'export', 'events', 'newCounts', 'seen']);

/**
 * Reads change nothing, so they stay reads (no rebuild, no revision). Every other request writes memory files: the
 * read-only preview process (no daemon, no lease) refuses them, and the daemon answers them as mutations.
 */
export async function memoryRpc(service: AdminService, request: MemoryRequest, deps: Pick<MemoryAdminDeps, 'origin' | 'actor'> = {}): Promise<RpcOutcome<MemoryReply>> {
  if (READS.has(request.type)) return { kind: 'read', value: await memoryAction(request, deps) };
  if (service.readonlyPreview) throw new NotWiredYetError('记忆修改');
  const value = await memoryAction(request, deps);
  return { kind: 'mutation', reply: () => value };
}
