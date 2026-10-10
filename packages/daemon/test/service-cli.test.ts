import { expect, it, vi } from 'vitest';
import { runServiceCommand } from '../src/cli/commands/service';

it('dispatches service installation and removal only through the OS adapter', async () => {
  const adapter = { install: vi.fn(async () => ({ platformName: 'test', installed: true, running: true, servicePath: '', stdoutPath: '', stderrPath: '', raw: '' })), uninstall: vi.fn(async () => {}) };
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await runServiceCommand('install', adapter);
    expect(adapter.install).toHaveBeenCalledOnce();
    expect(adapter.uninstall).not.toHaveBeenCalled();
    await runServiceCommand('uninstall', adapter);
    expect(adapter.uninstall).toHaveBeenCalledOnce();
    expect(output.mock.calls.map(call => call[0])).toEqual(['service installed\n', 'service uninstalled\n']);
  } finally { output.mockRestore(); }
});
