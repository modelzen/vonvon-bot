import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// `vonvon memory` takes no data lease and makes no data root, in or out of a Bot's session: a sandbox may forbid the
// lease's admission socket, so a refusal has to come before it, exactly like `secrets set`.
const fixture = vi.hoisted(() => ({ add: vi.fn(), list: vi.fn(), edit: vi.fn(), branch: vi.fn(), enter: vi.fn(), mkdir: vi.fn() }));
vi.mock('../src/core/version', () => ({ bridgeVersion: () => '0.7.0' }));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('node:fs/promises', () => ({ mkdir: fixture.mkdir }));
vi.mock('../src/config/data-access', () => ({ enterDataAccess: fixture.enter }));
vi.mock('../src/cli/commands/memory', () => ({
  terminalMemoryContext: () => ({ fake: true }), runMemoryAdd: fixture.add, runMemoryList: fixture.list, runMemoryEdit: fixture.edit, runMemoryBranch: fixture.branch,
}));
vi.mock('../src/host/bootstrap', () => ({ runHostRuntime: vi.fn() }));
vi.mock('../src/host/lifecycle', () => ({ observeShutdown: () => ({ dispose() {} }) }));

const start = (argv: string[], env: Record<string, string> = {}): void => {
  vi.stubGlobal('process', Object.assign(Object.create(process), { argv: ['node', '/cli', ...argv], exitCode: undefined, env: { ...env } }));
};
beforeEach(() => { vi.resetModules(); vi.resetAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('calls add in a Bot session without a lease, and leaves the refusal to the command', async () => {
  start(['memory', 'add', '周四发版', '--project', 'p'], { VONVON_SESSION: 'abc' });
  await import('../src/cli/index');
  await vi.waitFor(() => expect(fixture.add).toHaveBeenCalledTimes(1));
  expect(fixture.add.mock.calls[0]?.slice(0, 2)).toEqual(['周四发版', expect.objectContaining({ project: 'p' })]);
  expect(fixture.enter).not.toHaveBeenCalled();
  expect(fixture.mkdir).not.toHaveBeenCalled();
});

it('takes no lease for the reading, editing and branch commands either', async () => {
  for (const argv of [['memory', 'list', '--bot', 'cli_a'], ['memory', 'edit', 'b:abc', '--revision', '2', '--text', 'x', '--bot', 'cli_a'], ['memory', 'branch-merge', '甲', '乙', '--bot', 'cli_a']]) {
    vi.resetModules(); vi.resetAllMocks();
    start(argv);
    await import('../src/cli/index');
    await vi.waitFor(() => expect(fixture.list.mock.calls.length + fixture.edit.mock.calls.length + fixture.branch.mock.calls.length).toBe(1));
    expect(fixture.enter).not.toHaveBeenCalled();
    expect(fixture.mkdir).not.toHaveBeenCalled();
  }
});
