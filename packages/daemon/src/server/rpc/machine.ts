import type { MachineRequest, MachineReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { ShutdownControl } from '../../host/lifecycle';
import { runtimeDistribution } from '../../service/distribution';
import type { RpcOutcome } from '../rpc';
import { unsupported } from '../errors';

export async function machineRpc(service: AdminService, control: ShutdownControl | undefined, port: number, request: MachineRequest): Promise<RpcOutcome<MachineReply>> {
  switch (request.type) {
    case 'checkCoreUpdate': return { kind: 'read', value: { type: 'coreUpdate', distribution: await runtimeDistribution(), ...await service.checkUpdate() } };
    case 'coreUpdateStatus': return { kind: 'read', value: { type: 'coreUpdateStatus', status: service.updateStatus() } };
    case 'stopHost': {
      if (!control) return unsupported();
      return { kind: 'shutdown', reply: () => ({ type: 'done', message: '正在停止 daemon。' }), afterReply: () => control.requestStop() };
    }
    case 'applyCoreUpdate': {
      if (!control) return unsupported();
      await service.applyUpdate();
      return { kind: 'shutdown', reply: () => ({ type: 'done', message: '正在更新 daemon。' }), afterReply: () => control.requestRestart(port) };
    }
    default: return unsupported();
  }
}
