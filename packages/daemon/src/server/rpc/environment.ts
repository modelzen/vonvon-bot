import { environmentReplySchema, type EnvironmentRequest, type EnvironmentReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { Jobs, JobPeer } from '../jobs';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';

export async function environmentRpc(service: AdminService, jobs: Jobs, peer: JobPeer, request: EnvironmentRequest): Promise<RpcOutcome<EnvironmentReply>> {
  switch (request.type) {
    case 'backendCatalog': return { kind: 'read', value: environmentReplySchema.parse({ kind: 'backends', entries: (await service.listBackendCatalog()).entries }) };
    case 'backendVersion': return { kind: 'read', value: { kind: 'backendVersion', id: request.id, ...await service.backendVersion(request.id) } };
    case 'backendUninstall': {
      const result = await service.uninstallBackend(request.id);
      return { kind: 'mutation', reply: () => result.ok ? { kind: 'applied', message: result.message } : { kind: 'refused', code: 'uninstall_failed', message: result.message } };
    }
    case 'backendInstall': {
      const admission = jobs.selectBackend(request.id, request.update);
      return { kind: 'mutation', reply: () => jobs.attachBackend(admission, peer) };
    }
    default: return unsupported();
  }
}
