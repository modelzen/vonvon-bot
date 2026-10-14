import type { ServiceStatus } from './common';
import { SERVICE_UNAVAILABLE } from '../host/service';

export type { ServiceStatus };

export interface ServiceAdapter {
  install(): Promise<ServiceStatus>;
  uninstall(): Promise<void>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<ServiceStatus>;
  logs(follow: boolean): Promise<void>;
}

export function getServiceAdapter(): ServiceAdapter {
  throw new Error(SERVICE_UNAVAILABLE);
}
