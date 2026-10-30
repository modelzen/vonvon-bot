import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvironmentServiceOptions } from '../src/environment/service';

const adapter = vi.hoisted(() => ({
  options: undefined as EnvironmentServiceOptions | undefined,
  run: vi.fn(), close: vi.fn(), refresh: vi.fn(),
}));
vi.mock('../src/environment/service', () => ({
  EnvironmentService: class {
    constructor(options: EnvironmentServiceOptions) { adapter.options = options; }
    run = adapter.run;
    close = adapter.close;
  },
}));
vi.mock('../src/agent/codex-appserver/locate', () => ({ refreshCodexResolution: adapter.refresh }));
import { installManagedCodex, managedCodexBin, privateCodexBin } from '../src/agent/codex-appserver/managed-install';
import { paths } from '../src/config/paths';

const home = mkdtempSync(join(tmpdir(), 'managed-install-adapter-'));
beforeEach(() => {
  vi.stubEnv('CODEX_BIN', '');
  adapter.run.mockReset().mockResolvedValue({ kind: 'applied', message: 'installed' });
  adapter.close.mockReset().mockResolvedValue(undefined);
  adapter.refresh.mockReset().mockResolvedValue('/newer/external/codex');
  adapter.options = undefined;
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('legacy setup installation uses the unified environment installer', () => {
  it('forwards the real signal and data root, accepts success when a newer external CLI is selected, and closes', async () => {
    const abort = new AbortController();
    await installManagedCodex(abort.signal);
    expect(adapter.run).toHaveBeenCalledWith({ type: 'install', tool: 'codex' });
    expect(adapter.options).toMatchObject({ home: homedir(), nodePath: process.execPath, installSignal: abort.signal, requireTrustedNpm: true });
    expect(adapter.options!.getDataRoot()).toBe(paths.appDir);
    expect(await adapter.options!.resolveCodex()).toBe('/newer/external/codex');
    expect(adapter.refresh).toHaveBeenCalledWith({ force: true });
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('does not report a late cancellation after the installer has published success', async () => {
    const abort = new AbortController();
    adapter.run.mockImplementation(async () => {
      abort.abort(new Error('late cancellation'));
      return { kind: 'applied', message: 'published successfully' };
    });
    await expect(installManagedCodex(abort.signal)).resolves.toBeUndefined();
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('reports the environment installer failure and still drains its processes', async () => {
    adapter.run.mockResolvedValue({ kind: 'refused', code: 'install-failed', message: 'fixture install failure' });
    await expect(installManagedCodex(new AbortController().signal)).rejects.toThrow('fixture install failure');
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('does not start installation for explicit overrides or an already cancelled request', async () => {
    vi.stubEnv('CODEX_BIN', process.execPath);
    await expect(installManagedCodex(new AbortController().signal)).rejects.toThrow('CODEX_BIN');
    vi.stubEnv('CODEX_BIN', '');
    const abort = new AbortController();
    abort.abort(new Error('cancelled before install'));
    await expect(installManagedCodex(abort.signal)).rejects.toThrow('cancelled before install');
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('passes cancellation through the shared installer and waits for cleanup', async () => {
    const abort = new AbortController();
    adapter.run.mockImplementation(() => new Promise(resolve => {
      adapter.options!.installSignal!.addEventListener('abort', () => resolve({ kind: 'refused', code: 'install-cancelled', message: 'cancelled' }), { once: true });
    }));
    const install = installManagedCodex(abort.signal);
    const outcome = install.catch(error => error);
    await vi.waitFor(() => expect(adapter.run).toHaveBeenCalled());
    abort.abort(new Error('cancelled during install'));
    expect(await outcome).toMatchObject({ message: 'cancelled during install' });
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });
});

it('still reads existing legacy generations without writing a new legacy pointer', () => {
  const generation = '12345678-1234-1234-1234-123456789012';
  const root = join(home, 'codex-cli');
  const release = join(root, 'releases', generation);
  mkdirSync(join(release, 'node_modules', '.bin'), { recursive: true });
  const bin = privateCodexBin(release);
  writeFileSync(bin, '');
  writeFileSync(join(root, 'current.json'), JSON.stringify({ generation, version: '0.156.1' }));
  expect(managedCodexBin(root)).toBe(bin);
});
