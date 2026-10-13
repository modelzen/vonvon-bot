import type { ServiceStatus } from './common';
import {
  installSystemd,
  restartSystemd,
  statusSystemd,
  uninstallSystemd,
} from './systemd';
import { tailServiceLogs } from './common';

export type { ServiceStatus };

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

/**
 * The background-service adapter for the current platform: systemd (user
 * units) on Linux/WSL. Throws on every other platform until the Vonvon
 * launchd and Windows services land.
 */
export function getServiceAdapter(): ServiceAdapter {
  if (process.platform === 'linux') {
    return {
      install: installSystemd,
      uninstall: uninstallSystemd,
      status: async () => statusSystemd(),
      restart: restartSystemd,
      logs: tailServiceLogs,
    };
  }

  throw new Error(
    'service：当前平台暂不支持后台服务（仅 Linux systemd）。' +
      '请用 `vonvon daemon start` 和 `vonvon daemon stop`。',
  );
}
