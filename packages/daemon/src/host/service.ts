import type { ServiceAdapter } from '../service/adapter';
import type { HostInspection } from './client';

export const SERVICE_UNAVAILABLE = 'Vonvon Bot cannot manage an OS service in this version. Use vonvon daemon start and vonvon daemon stop.';

export async function controlDesktopService(action: string, _adapter?: ServiceAdapter, _inspect?: () => Promise<HostInspection>) {
  if (action === 'status') return { supported: false, installed: false, running: false };
  throw new Error(SERVICE_UNAVAILABLE);
}
