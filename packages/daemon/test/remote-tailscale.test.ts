import { afterEach, expect, it, vi } from 'vitest';
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
