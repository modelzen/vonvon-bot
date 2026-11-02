import { afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tailscaleIps, type Exec } from '../src/remote/tailscale';

afterEach(() => { vi.useRealTimers(); });
const fail = (code: unknown): Error & { code?: unknown } => Object.assign(new Error('failed'), { code });

// D3 第 5 节: main 必败, there was no tailscale.ts.
it('reads both families, and tells a missing command from one that fails or hangs', async () => {
  const calls: Array<[string, string[], number]> = [];
  const answer = (error: (Error & { code?: unknown }) | null, stdout = ''): Exec => (file, args, options, done) => { calls.push([file, args, options.timeout]); done(error, stdout); };
  expect(await tailscaleIps({ exec: answer(null, '100.101.2.3\nfd7a:115c:a1e0::5\n') })).toEqual({ installed: true, ips: ['100.101.2.3', 'fd7a:115c:a1e0::5'] });
  expect(calls[0]).toEqual(['tailscale', ['ip'], 5_000]);
  expect(await tailscaleIps({ exec: answer(fail('ENOENT')) })).toEqual({ installed: false, ips: [] });
  expect(await tailscaleIps({ exec: answer(fail(1), 'Tailscale is stopped.') })).toEqual({ installed: true, ips: [] });
  expect(await tailscaleIps({ exec: () => { throw fail('ENOENT'); } })).toEqual({ installed: false, ips: [] });
  vi.useFakeTimers();
  const hung = tailscaleIps({ exec: () => undefined });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(await hung).toEqual({ installed: true, ips: [] });
});

// devices-ui-3 4.2: the Tailscale app's own command where it is not on PATH. main 必败: only `tailscale` was tried
it('tries the Tailscale app\'s own command on macOS and Windows when `tailscale` is not on PATH', async () => {
  const at = (found: Record<string, string>): { exec: Exec; tried: string[] } => {
    const tried: string[] = [];
    return { tried, exec: (file, _args, _options, done) => { tried.push(file); if (file in found) done(null, found[file] ?? ''); else done(fail('ENOENT'), ''); } };
  };
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  const mac = at({ [app]: '100.64.0.10\n' });
  expect(await tailscaleIps({ exec: mac.exec, platform: 'darwin', env: {} })).toEqual({ installed: true, ips: ['100.64.0.10'] });
  expect(mac.tried).toEqual(['tailscale', app]);
  const exe = join('C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const windows = at({ [exe]: '100.64.0.11\n' });
  expect(await tailscaleIps({ exec: windows.exec, platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' } })).toEqual({ installed: true, ips: ['100.64.0.11'] });
  expect(windows.tried).toEqual(['tailscale', exe]);
  // no ProgramFiles: nothing else to try; Linux has no app
  expect(await tailscaleIps({ exec: at({}).exec, platform: 'win32', env: {} })).toEqual({ installed: false, ips: [] });
  const linux = at({});
  expect(await tailscaleIps({ exec: linux.exec, platform: 'linux', env: {} })).toEqual({ installed: false, ips: [] });
  expect(linux.tried).toEqual(['tailscale']);
  // the one on PATH answers first
  const path = at({ tailscale: '100.64.0.12\n', [app]: '100.64.0.10\n' });
  expect(await tailscaleIps({ exec: path.exec, platform: 'darwin', env: {} })).toEqual({ installed: true, ips: ['100.64.0.12'] });
  expect(path.tried).toEqual(['tailscale']);
});
