import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// `vonvon project list` reads published files only: no data root is made and no lease taken, like `secrets get`.
const fixture = vi.hoisted(() => ({ list: vi.fn(), enter: vi.fn(), mkdir: vi.fn() }));
vi.mock('../src/core/version', () => ({ bridgeVersion: () => '0.7.0' }));
vi.mock('../src/config/paths', () => ({ paths: { appDir: '/owned/root' } }));
vi.mock('node:fs/promises', () => ({ mkdir: fixture.mkdir }));
vi.mock('../src/config/data-access', () => ({ enterDataAccess: fixture.enter }));
vi.mock('../src/cli/commands/project', () => ({ runProjectList: fixture.list }));
vi.mock('../src/host/bootstrap', () => ({ runHostRuntime: vi.fn() }));
vi.mock('../src/host/lifecycle', () => ({ observeShutdown: () => ({ dispose() {} }) }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('process', Object.assign(Object.create(process), { argv: ['node', '/cli', 'project', 'list', '--json'], exitCode: undefined }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('runs project list with --json and without a lease', async () => {
  await import('../src/cli/index');
  await vi.waitFor(() => expect(fixture.list).toHaveBeenCalledTimes(1));
  expect(fixture.list.mock.calls[0]?.[0]).toMatchObject({ json: true });
  expect(fixture.enter).not.toHaveBeenCalled();
  expect(fixture.mkdir).not.toHaveBeenCalled();
});
