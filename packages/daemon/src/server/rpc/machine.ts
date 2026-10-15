import { serviceActionStartedMessage, type MachineRequest, type MachineReply } from '@vonvon/protocol';
import type { AdminService } from '../../admin/service';
import type { ShutdownControl } from '../../host/lifecycle';
import { controlDesktopService } from '../../host/service';
import type { ServiceActionLauncher } from '../../host/service-action';
import { writeServiceSkipped } from '../../service/action-report';
import { resolveCliBinPath, serviceStdoutPath, serviceStderrPath } from '../../service/common';
import { runtimeDistribution } from '../../service/distribution';
import type { RpcOutcome } from '../rpc';
import type { SnapshotStore } from '../snapshot';
import { unsupported } from '../errors';

/** The login-time service switch (3.10): the helper launcher, the snapshot that shows it, and the data root. */
export type MachineServiceContext = { launcher: ServiceActionLauncher; snapshots: Pick<SnapshotStore, 'observeService' | 'refreshService'>; root: string };

export async function machineRpc(service: AdminService, control: ShutdownControl | undefined, port: number, request: MachineRequest, services?: MachineServiceContext): Promise<RpcOutcome<MachineReply>> {
  switch (request.type) {
    case 'status': {
      const status = await controlDesktopService('status');
      // 重新检测 asks here; the snapshot takes the same answer instead of waiting for its 60 s read.
      services?.snapshots.observeService(status);
      return { kind: 'read', value: { type: 'status', service: {
        platformName: process.platform, servicePath: '', stdoutPath: serviceStdoutPath(), stderrPath: serviceStderrPath(),
        ...status,
      }, host: { ownership: 'owned', pid: process.pid }, cli: { kind: 'ready', bin: resolveCliBinPath(), message: 'Vonvon CLI 已就绪。' } } };
    }
    case 'logs': return { kind: 'read', value: { type: 'logs', text: await service.tailLogs({ maxBytes: 64 * 1024 }) } };
    case 'checkCoreUpdate': return { kind: 'read', value: { type: 'coreUpdate', distribution: await runtimeDistribution(), ...await service.checkUpdate() } };
    case 'coreUpdateStatus': return { kind: 'read', value: { type: 'coreUpdateStatus', status: service.updateStatus() } };
    case 'stopHost': {
      if (!control) return unsupported();
      control.requestStop();
      return { kind: 'read', value: { type: 'done', message: '正在停止 daemon。' } };
    }
    case 'applyCoreUpdate': {
      if (!control) return unsupported();
      const update = await service.applyUpdate();
      return { kind: 'shutdown', reply: () => ({ type: 'done', message: '正在更新 daemon。' }), afterReply: () => control.requestRestart(port, update ?? undefined) };
    }
    case 'service': {
      // start and stop stay with the desktop shell and the terminal.
      if (!services || (request.action !== 'install' && request.action !== 'uninstall')) return unsupported();
      const helper = services.launcher.reserve(request.action);
      const message = serviceActionStartedMessage(request.action);
      // The helper stops this daemon, so the reply goes out first.
      return { kind: 'shutdown', reply: () => ({ type: 'done', message }), afterReply: helper.start, cancel: helper.cancel };
    }
    case 'setServiceSkipped': {
      if (!services) return unsupported();
      await writeServiceSkipped(services.root, request.skipped);
      void services.snapshots.refreshService().catch(() => undefined);
      return { kind: 'mutation', reply: () => ({ type: 'done', message: request.skipped ? '已跳过登录时启动。' : '已取消跳过。' }) };
    }
    default: return unsupported();
  }
}
