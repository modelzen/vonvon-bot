import { afterEach, expect, it, vi } from 'vitest';
import { controlDesktopService, SERVICE_UNAVAILABLE } from '../src/host/service';

const adapter = { install: vi.fn(), uninstall: vi.fn(), restart: vi.fn(), status: vi.fn(), logs: vi.fn() };
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it('reports observed macOS service status through the existing machine fields', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  adapter.status.mockResolvedValue({ platformName: 'launchd (macOS)', installed: true, running: true, servicePath: '/tmp/vonvon.plist', stdoutPath: '/tmp/service.log', stderrPath: '/tmp/service.err.log', pid: '123', raw: 'registered' });
  expect(await controlDesktopService('status', adapter)).toMatchObject({ supported: true, installed: true, running: true, pid: '123' });
  expect(adapter.status).toHaveBeenCalledOnce();
});
it('leaves Windows status unsupported without calling the legacy startup adapter', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  expect(await controlDesktopService('status', adapter)).toEqual({ supported: false, installed: false, running: false });
  expect(adapter.status).not.toHaveBeenCalled();
});
it('returns an explicit error when the frozen machine status cannot describe another registration root', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  adapter.status.mockRejectedValue(new Error('Vonvon service registration belongs to /tmp/another-root.'));
  await expect(controlDesktopService('status', adapter)).rejects.toThrow('/tmp/another-root');
});
it.each(['install', 'start', 'stop', 'uninstall', 'restart; rm'])('refuses desktop service %s without adapter or inspection calls', async action => {
  const inspect = vi.fn();
  await expect(controlDesktopService(action, adapter, inspect)).rejects.toThrow(SERVICE_UNAVAILABLE);
  expect(inspect).not.toHaveBeenCalled();
  for (const method of Object.values(adapter)) expect(method).not.toHaveBeenCalled();
});
