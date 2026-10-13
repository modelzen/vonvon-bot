import type { ServiceStatus } from './common';
import {
  installLaunchd,
  restartLaunchd,
  statusLaunchd,
  tailLaunchdLogs,
  uninstallLaunchd,
} from './launchd';
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
 * The background-service adapter for the current platform: launchd on macOS,
 * systemd (user units) on Linux/WSL. Throws on any other platform, Windows
 * included, until the Vonvon Windows service lands.
 */
export function getServiceAdapter(): ServiceAdapter {
  if (process.platform === 'darwin') {
    return {
      install: installLaunchd,
      uninstall: uninstallLaunchd,
      status: async () => statusLaunchd(),
      restart: restartLaunchd,
      logs: tailLaunchdLogs,
    };
  }

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
    'service：当前平台暂不支持后台服务（仅 macOS launchd / Linux systemd）。' +
      '请用 `vonvon daemon start` 和 `vonvon daemon stop`。',
  );
}
