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
import type { EnvironmentService } from '../../environment/service';
import type {BridgeImporter} from '../../import/bridge/transaction';
import {RpcError} from '../errors';
import { checkStandaloneUpdate, lastStandaloneCheck, startStandaloneUpdate, type StandaloneDeps } from '../../service/standalone-update';
import { currentVersion, UpdateBusyError } from '../../service/update';

const standaloneDeps = (installRoot: string): StandaloneDeps => ({ installRoot, currentVersion: currentVersion() });

/** The login-time service switch (3.10): the helper launcher, the snapshot that shows it, and the data root. */
export type MachineServiceContext = { launcher: ServiceActionLauncher; snapshots: Pick<SnapshotStore, 'observeService' | 'refreshService'>; root: string; bridgeImport?: BridgeImporter; environment?: Pick<EnvironmentService, 'mcp'> };

export async function machineRpc(service: AdminService, control: ShutdownControl | undefined, port: number, request: MachineRequest, services?: MachineServiceContext): Promise<RpcOutcome<MachineReply>> {
  switch (request.type) {
    case 'mcp': {
      if (!services?.environment) return unsupported();
      const reply = await services.environment.mcp(request.request);
      return request.request.action === 'list' ? { kind: 'read', value: reply } : { kind: 'mutation', reply: () => reply };
    }
    case 'bridgeImport': {
      if (!services?.bridgeImport) return unsupported();
      if (request.action === 'start' && request.acceptedChanges !== true) throw new RpcError('invalid_request', '请先确认导入后的变化。');
      const reply = await services.bridgeImport[request.action]();
      return request.action === 'start' || request.action === 'rollback' ? {kind: 'mutation', reply: () => reply} : {kind: 'read', value: reply};
    }
    case 'status': {
      const read = controlDesktopService('status');
      // 重新检测 asks here; the snapshot takes the same answer instead of waiting for its 60 s read.
      services?.snapshots.observeService(read);
      const status = await read;
      return { kind: 'read', value: { type: 'status', service: {
        platformName: process.platform, servicePath: '', stdoutPath: serviceStdoutPath(), stderrPath: serviceStderrPath(),
        ...status,
      }, host: { ownership: 'owned', pid: process.pid }, cli: { kind: 'ready', bin: resolveCliBinPath(), message: 'Vonvon CLI 已就绪。' } } };
    }
    case 'logs': return { kind: 'read', value: { type: 'logs', text: await service.tailLogs({ maxBytes: 64 * 1024 }) } };
    case 'checkCoreUpdate': {
      const distribution = await runtimeDistribution();
      if (distribution.kind !== 'standalone') return { kind: 'read', value: { type: 'coreUpdate', distribution, ...await service.checkUpdate() } };
      // The page's own reads take the daily check (devices 6.5); 检查 and `vonvon update --check` read the manifest.
      const check = (request.fresh === false ? lastStandaloneCheck() : undefined) ?? await checkStandaloneUpdate(standaloneDeps(distribution.installRoot));
      return { kind: 'read', value: { type: 'coreUpdate', distribution, dev: false, ...check } };
    }
    case 'coreUpdateStatus': return { kind: 'read', value: { type: 'coreUpdateStatus', status: service.updateStatus() } };
    case 'stopHost': {
      if (!control) return unsupported();
      control.requestStop();
      return { kind: 'read', value: { type: 'done', message: '正在停止 daemon。' } };
    }
    case 'applyCoreUpdate': {
      if (!control) return unsupported();
      const distribution = await runtimeDistribution();
      if (distribution.kind === 'standalone') {
        if (request.allowDowngrade && !request.version) throw new RpcError('invalid_request', '降级要写明版本：--allow-downgrade --to <版本>。');
        // Answered at once: the download may take minutes, and the drain only starts after `current` is switched.
        try { void startStandaloneUpdate(request, { ...standaloneDeps(distribution.installRoot), requestRestart: status => control.requestRestart(port, status) }).done; }
        catch (error) { if (error instanceof UpdateBusyError) throw new RpcError('conflict', error.message); throw error; }
        return { kind: 'read', value: { type: 'done', message: '开始更新…' } };
      }
      if (request.version !== undefined || request.allowDowngrade) throw new RpcError('invalid_request', '只有独立安装的服务端能指定版本。');
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
