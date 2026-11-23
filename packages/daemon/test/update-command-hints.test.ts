import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('../src/service/update'); vi.doUnmock('../src/service/distribution'); });

async function run(options: { check?: boolean }, overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.doMock('../src/service/distribution', () => ({ runtimeDistribution: async () => ({ kind: 'global-npm', cliPath: '/usr/bin/vonvon' }) }));
  vi.doMock('../src/service/update', () => ({
    currentVersion: () => '0.7.0', latestVersion: async () => '0.7.1', isNewer: () => true, isDevSource: () => false,
    packageName: () => 'vonvon-bot', daemonRunning: () => true, installLatest: async () => ({ ok: true }),
    restartDaemon: async () => { throw new Error('boom'); }, ...overrides,
  }));
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const { runUpdate } = await import('../src/cli/commands/update');
  await runUpdate(options);
  const text = output.mock.calls.map(call => String(call[0])).join('\n');
  output.mockRestore();
  return text;
}

it('tells the user the vonvon commands, not the retired bridge ones', async () => {
  const check = await run({ check: true });
  expect(check).toContain('npm i -g vonvon-bot@latest');
  expect(check).toContain('vonvon daemon restart');
  const failedRestart = await run({});
  expect(failedRestart).toContain('请手动执行：vonvon daemon restart');
  for (const text of [check, failedRestart]) expect(text).not.toContain('feishu-codex-bridge');
});

it('points at the download page without asking GitHub, only on macOS', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(await run({ check: true })).toContain('https://vonvon.cc/get/');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    expect(await run({ check: true })).not.toContain('vonvon.cc');
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllGlobals();
  }
});
