import type { MemoryReply, MemoryRequest } from '@vonvon/protocol';
import { memoryAction } from '../../admin/memory';
import type { RpcOutcome } from '../rpc';

/** Nothing in the snapshot shows memory yet (the counts come with the pages), so every request is a read: no rebuild, no revision. */
export async function memoryRpc(request: MemoryRequest): Promise<RpcOutcome<MemoryReply>> {
  return { kind: 'read', value: await memoryAction(request) };
}
