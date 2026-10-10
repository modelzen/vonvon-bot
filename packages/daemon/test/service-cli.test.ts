import { expect, it, vi } from 'vitest';
import { runServiceCommand } from '../src/cli/commands/service';
import { SERVICE_UNAVAILABLE } from '../src/host/service';
it.each(['install', 'uninstall'] as const)('CLI service %s refuses without mutating registrations', async action => {
  const adapter = { install: vi.fn(), uninstall: vi.fn() };
  await expect(runServiceCommand(action, adapter)).rejects.toThrow(SERVICE_UNAVAILABLE);
  expect(adapter.install).not.toHaveBeenCalled();
  expect(adapter.uninstall).not.toHaveBeenCalled();
});
