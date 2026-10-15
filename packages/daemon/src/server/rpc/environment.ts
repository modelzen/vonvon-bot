import { environmentReplySchema, type EnvironmentRequest, type EnvironmentReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { Jobs, JobPeer } from '../jobs';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';
import type { EnvironmentService } from '../../environment/service';

export async function environmentRpc(service: AdminService, jobs: Jobs, peer: JobPeer, request: EnvironmentRequest, environment?: EnvironmentService): Promise<RpcOutcome<EnvironmentReply>> {
  switch (request.type) {
    case 'backendCatalog': return { kind: 'read', value: environmentReplySchema.parse({ kind: 'backends', entries: (await service.listBackendCatalog()).entries }) };
    case 'backendVersion': return { kind: 'read', value: { kind: 'backendVersion', id: request.id, ...await service.backendVersion(request.id) } };
    case 'backendLogin': {
      // A mutation so the reply waits for a rebuild that shows the new cached login (s19).
      const login = await service.backendLogin(request.id, request.refresh);
      return { kind: 'mutation', reply: () => ({ kind: 'backendLogin', id: request.id, ...login }) };
    }
    case 'backendUninstall': {
      const result = await service.uninstallBackend(request.id);
      return { kind: 'mutation', reply: () => result.ok ? { kind: 'applied', message: result.message } : { kind: 'refused', code: 'uninstall_failed', message: result.message } };
    }
    case 'backendInstall': {
      const admission = jobs.selectBackend(request.id, request.update);
      return { kind: 'mutation', reply: () => jobs.attachBackend(admission, peer) };
    }
    case 'scan': case 'install': case 'update': case 'uninstall': case 'toolInstallStatus': case 'cancelInstall':
    case 'authStatus': case 'startLogin': case 'loginStatus': case 'cancelLogin': case 'profileList':
    case 'profileUse': case 'profileAdd': case 'profileInit': case 'profileInitStatus': case 'profileInitCancel': {
      if (!environment) return unsupported();
      const reply = await environment.run(request);
      return { kind: 'read', value: environmentReplySchema.parse(reply) };
    }
    default: return unsupported();
  }
}
