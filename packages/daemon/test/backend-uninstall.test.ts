import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { paths } from '../src/config/paths';
import { uninstallBackendDep } from '../src/agent/installer';
import { spawnProcess } from '../src/platform/spawn';

vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} } }));

const npmCli = join(dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin/npm-cli.js');
let home: string | undefined;
const original = { backendsDir: paths.backendsDir, npmCacheDir: paths.npmCacheDir };

afterEach(async () => {
  vi.unstubAllEnvs();
  Object.assign(paths, original);
  if (home) await rm(home, { recursive: true, force: true });
  home = undefined;
});

async function npm(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(process.execPath, [npmCli, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', paths.npmCacheDir], {
      cwd, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', chunk => { out += String(chunk); });
    child.stderr?.on('data', chunk => { err += String(chunk); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`npm exited ${code}: ${err}`)));
  });
}

async function pack(name: string, fields: Record<string, unknown> = {}): Promise<string> {
  const source = join(home!, 'sources', name);
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.cjs', ...fields }));
  await writeFile(join(source, 'index.cjs'), 'module.exports = {};');
  const packed = JSON.parse(await npm(['pack', '--json'], source)) as Array<{ filename: string }>;
  return `file:${join(source, packed[0]!.filename)}`;
}

describe('managed backend npm uninstall', () => {
  it('removes hoisted native/private dependencies while retaining another managed backend, shared packages, and account data', async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-backend-uninstall-')));
    Object.assign(paths, { backendsDir: join(home, 'backends'), npmCacheDir: join(home, 'cache') });
    vi.stubEnv('VONVON_NPM_CLI', npmCli);
    // Real local tarballs produce the same npm-hoisted optional dependency graph as Claude SDK.
    const shared = await pack('fixture-shared');
    const native = await pack('fixture-sdk-native');
    const privateDep = await pack('fixture-sdk-private');
    const sdk = await pack('fixture-sdk', {
      dependencies: { 'fixture-shared': shared, 'fixture-sdk-private': privateDep },
      optionalDependencies: { 'fixture-sdk-native': native },
    });
    const other = await pack('fixture-other', { dependencies: { 'fixture-shared': shared } });
    await mkdir(paths.backendsDir, { recursive: true });
    await writeFile(join(paths.backendsDir, 'package.json'), JSON.stringify({
      name: 'fixture-backends', private: true, version: '1.0.0',
      dependencies: { 'fixture-sdk': sdk, 'fixture-other': other },
    }));
    const accountData = join(home, '.claude', 'account.json');
    await mkdir(dirname(accountData), { recursive: true });
    await writeFile(accountData, 'fixture-account-data');
    await npm(['install', '--include=optional', '--prefix', paths.backendsDir], home);
    const installed = (name: string) => existsSync(join(paths.backendsDir, 'node_modules', name, 'package.json'));
    for (const name of ['fixture-sdk', 'fixture-sdk-native', 'fixture-sdk-private', 'fixture-other', 'fixture-shared']) {
      expect(installed(name)).toBe(true);
    }

    expect(await uninstallBackendDep('fixture-sdk')).toBe('uninstalled');
    for (const name of ['fixture-sdk', 'fixture-sdk-native', 'fixture-sdk-private']) expect.soft(installed(name)).toBe(false);
    for (const name of ['fixture-other', 'fixture-shared']) expect.soft(installed(name)).toBe(true);
    expect(await readFile(accountData, 'utf8')).toBe('fixture-account-data');
    const manifest = JSON.parse(await readFile(join(paths.backendsDir, 'package.json'), 'utf8'));
    expect(manifest.dependencies).toEqual({ 'fixture-other': other });
    const lock = JSON.parse(await readFile(join(paths.backendsDir, 'package-lock.json'), 'utf8'));
    expect(lock.packages[''].dependencies).toEqual({ 'fixture-other': other });
    expect(lock.packages['node_modules/fixture-sdk-native']).toBeUndefined();
    expect(lock.packages['node_modules/fixture-shared']).toBeDefined();
  });
});
