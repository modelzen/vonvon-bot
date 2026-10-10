import { getServiceAdapter, type ServiceAdapter } from '../../service/adapter';

export async function runServiceCommand(action: 'install' | 'uninstall', adapter: Pick<ServiceAdapter, 'install' | 'uninstall'> = getServiceAdapter()): Promise<void> {
  if (action === 'install') await adapter.install();
  else await adapter.uninstall();
  process.stdout.write(action === 'install' ? 'service installed\n' : 'service uninstalled\n');
}
