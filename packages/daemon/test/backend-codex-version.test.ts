import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  installed: vi.fn(),
  latest: vi.fn(),
}));
vi.mock('../src/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/agent')>(),
  installedBackendVersion: dependencies.installed,
  latestNpmVersion: dependencies.latest,
}));

import { createAdminService } from '../src/admin/service';
import { codexVersionAsync, resolveCodexBin } from '../src/agent/codex-appserver/locate';
import { managedToolExecutable } from '../src/agent/codex-appserver/managed-tools';
import { paths } from '../src/config/paths';
import { writeNodeExecutable } from './helpers/node-executable';

const originalAppDir = paths.appDir;
const originalBackendsDir = paths.backendsDir;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'backend-codex-version-'));
  paths.appDir = join(dir, 'vonvon');
  paths.backendsDir = join(dir, 'backends');
  vi.stubEnv('CODEX_BIN', undefined);
  dependencies.installed.mockReturnValue('99.0.0');
  dependencies.latest.mockResolvedValue('9.164.0');
});

afterEach(() => {
  paths.appDir = originalAppDir;
  paths.backendsDir = originalBackendsDir;
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function executable(directory: string, output: string, code = 0) {
  mkdirSync(directory, { recursive: true });
  return writeNodeExecutable(directory, 'codex', `console.log(${JSON.stringify(output)}); process.exit(${code});`);
}

function managed(output: string) {
  const generation = '12345678-1234-1234-1234-123456789012';
  const root = join(paths.appDir, 'managed-tools', 'codex');
  const bin = managedToolExecutable(join(root, 'releases', generation), 'codex');
  executable(join(bin, '..'), output);
  // A stale metadata version must not substitute for the executable's output.
  writeFileSync(join(root, 'current.json'), JSON.stringify({ schemaVersion: 1, tool: 'codex', state: 'active', generation, version: '0.100.0' }));
  return bin;
}

describe('Codex installed/latest versions use the runtime executable', () => {
  it('prefers the newer stable managed CLI over PATH and refreshes an upgrade at the same path', async () => {
    const external = join(dir, 'external');
    executable(external, 'codex-cli 9.162.1');
    vi.stubEnv('PATH', external);
    const bin = managed('codex-cli 9.163.0');
    const service = createAdminService();

    expect(resolveCodexBin({ force: true })).toBe(bin);
    expect(await codexVersionAsync(bin)).toBe('codex-cli 9.163.0');
    expect(await service.backendVersion('codex-appserver')).toEqual({ installed: '9.163.0', latest: '9.164.0', hasUpdate: true });
    expect(dependencies.latest).toHaveBeenCalledWith('@openai/codex');
    expect(dependencies.installed).not.toHaveBeenCalledWith('@openai/codex');

    executable(join(bin, '..'), 'codex-cli 9.164.0');
    expect(await service.backendVersion('codex-appserver')).toEqual({ installed: '9.164.0', latest: '9.164.0', hasUpdate: false });
    const catalog = await service.listBackendCatalog();
    expect(catalog.entries.find(entry => entry.id === 'codex-appserver')).toMatchObject({ version: 'codex-cli 9.164.0', installedVersion: '9.164.0' });
  });

  it('respects CODEX_BIN over the managed copy and refreshes its cached version', async () => {
    managed('codex-cli 9.164.0');
    const override = executable(join(dir, 'override'), 'codex-cli 9.162.1');
    vi.stubEnv('CODEX_BIN', override.bin);
    expect(await codexVersionAsync(override.bin)).toBe('codex-cli 9.162.1');
    executable(join(dir, 'override'), 'codex-cli 9.163.0');

    expect(await createAdminService().backendVersion('codex-appserver')).toEqual({ installed: '9.163.0', latest: '9.164.0', hasUpdate: true });
  });

  it('refreshes PATH selection instead of retaining a previously cached external CLI', async () => {
    const a = executable(join(dir, 'external-a'), 'codex-cli 9.162.1');
    const b = executable(join(dir, 'external-b'), 'codex-cli 9.164.0');
    vi.stubEnv('PATH', join(dir, 'external-a'));
    expect(resolveCodexBin({ force: true })).toBe(a.bin);
    expect(await codexVersionAsync(a.bin)).toBe('codex-cli 9.162.1');
    vi.stubEnv('PATH', join(dir, 'external-b'));

    expect(await createAdminService().backendVersion('codex-appserver')).toEqual({ installed: '9.164.0', latest: '9.164.0', hasUpdate: false });
    expect(resolveCodexBin()).toBe(b.bin);
  });

  it.each([
    { output: 'codex-cli 9.164.0', code: 1 },
    { output: 'unrecognized version output', code: 0 },
  ])('returns an unknown installed version after a failed probe: $output / $code', async ({ output, code }) => {
    const fixture = executable(join(dir, 'invalid'), 'codex-cli 9.162.1');
    vi.stubEnv('CODEX_BIN', fixture.bin);
    expect(await codexVersionAsync(fixture.bin)).toBe('codex-cli 9.162.1');
    executable(join(dir, 'invalid'), output, code);

    expect(await createAdminService().backendVersion('codex-appserver')).toEqual({ installed: null, latest: '9.164.0', hasUpdate: false });
  });

  it('does not fall back to another installed CLI when CODEX_BIN is missing', async () => {
    managed('codex-cli 9.164.0');
    vi.stubEnv('CODEX_BIN', join(dir, 'missing'));
    expect(await createAdminService().backendVersion('codex-appserver')).toEqual({ installed: null, latest: '9.164.0', hasUpdate: false });
  });

  it('keeps the actual installed version when the registry query fails', async () => {
    vi.stubEnv('CODEX_BIN', executable(join(dir, 'override'), 'codex-cli 9.164.0').bin);
    dependencies.latest.mockRejectedValue(new Error('registry unavailable'));
    expect(await createAdminService().backendVersion('codex-appserver')).toEqual({ installed: '9.164.0', latest: null, hasUpdate: false });
  });

  it.each([
    { installed: '9.164.0-alpha.3', latest: '9.164.0', hasUpdate: true },
    { installed: '9.165.0-alpha.3', latest: '9.164.0', hasUpdate: false },
  ])('compares prerelease precedence: $installed / $latest', async ({ installed, latest, hasUpdate }) => {
    vi.stubEnv('CODEX_BIN', executable(join(dir, 'override'), `codex-cli ${installed}`).bin);
    dependencies.latest.mockResolvedValue(latest);
    expect(await createAdminService().backendVersion('codex-appserver')).toEqual({ installed, latest, hasUpdate });
  });
});
