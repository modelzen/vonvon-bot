import { expect, it, vi } from 'vitest';
import { controlDesktopService, SERVICE_UNAVAILABLE } from '../src/host/service';

const adapter = { install: vi.fn(), uninstall: vi.fn(), restart: vi.fn(), status: vi.fn(), logs: vi.fn() };
it('reports native service unsupported without inspecting the old registration', async () => {
  expect(await controlDesktopService('status', adapter)).toEqual({ supported: false, installed: false, running: false });
  expect(adapter.status).not.toHaveBeenCalled();
});
it.each(['install', 'start', 'stop', 'uninstall', 'restart; rm'])('refuses desktop service %s without adapter or inspection calls', async action => {
  const inspect = vi.fn();
  await expect(controlDesktopService(action, adapter, inspect)).rejects.toThrow(SERVICE_UNAVAILABLE);
  expect(inspect).not.toHaveBeenCalled();
  for (const method of Object.values(adapter)) expect(method).not.toHaveBeenCalled();
});
