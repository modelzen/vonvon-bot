import type { ServiceAdapter } from '../../service/adapter';
import { SERVICE_UNAVAILABLE } from '../../host/service';

export async function runServiceCommand(_action: 'install' | 'uninstall', _adapter?: Pick<ServiceAdapter, 'install' | 'uninstall'>): Promise<void> {
  throw new Error(SERVICE_UNAVAILABLE);
}
