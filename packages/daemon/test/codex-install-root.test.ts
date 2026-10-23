import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PROTECTED_PATHS, codexFilesystem, codexInstallRoot } from '../src/agent/codex-appserver/workspace-policy';

const host = vi.hoisted(() => ({ home: '/unused-home' }));
vi.mock('node:os', async original => ({ ...await original<typeof import('node:os')>(), homedir: () => host.home }));
const temporary: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vonvon-codex-install-')));
  temporary.push(root);
  return root;
}
function binary(path: string) { writeFileSync(path, 'fixture'); return path; }
afterEach(() => { vi.unstubAllEnvs(); host.home = '/unused-home'; for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Codex runtime read boundary', () => {
  it('follows npm launch symlinks to the package containing platform runtime files', () => {
    const root = fixture();
    const pkg = join(root, 'lib/node_modules/@openai/codex');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const target = binary(join(pkg, 'bin/codex.js'));
    const launch = join(root, 'codex'); symlinkSync(target, launch);
    expect(codexInstallRoot(launch)).toEqual({ path: pkg, kind: 'dir' });
  });
  it('allows a dedicated standalone runtime directory', () => {
    const root = join(fixture(), 'runtime'); mkdirSync(root);
    expect(codexInstallRoot(binary(join(root, 'codex')))).toEqual({ path: root, kind: 'dir' });
  });
  it('grants only the binary in the home or a common installation directory', () => {
    host.home = fixture();
    const bin = binary(join(host.home, 'codex'));
    expect(codexInstallRoot(bin)).toEqual({ path: bin, kind: 'file' });
    expect(codexInstallRoot('/usr/local/bin/missing-codex-fixture')).toEqual({ path: '/usr/local/bin/missing-codex-fixture', kind: 'file' });
  });
  it.each(['/etc', '/var', '/srv', '/mnt', '/usr/lib', '/usr/sbin', '/usr/local/sbin', '/snap/bin'])(
    'does not grant a shared system directory: %s', directory => {
      const bin = join(directory, 'missing-codex-fixture');
      expect(codexInstallRoot(bin)).toEqual({ path: bin, kind: 'file' });
    });
  it('protects default and custom Codex credentials and their ancestors', () => {
    host.home = join(fixture(), 'home');
    const custom = join(fixture(), 'private', 'codex-home');
    vi.stubEnv('CODEX_HOME', custom);
    for (const directory of [join(host.home, '.codex'), custom, join(custom, '..')]) {
      mkdirSync(directory, { recursive: true });
      const bin = binary(join(directory, 'codex'));
      expect(codexInstallRoot(bin)).toEqual({ path: bin, kind: 'file' });
    }
  });
  it('protects a credential home reached through a symlink', () => {
    const root = fixture(), secrets = join(root, 'private'), alias = join(root, 'alias');
    mkdirSync(secrets); symlinkSync(secrets, alias, 'dir');
    vi.stubEnv('CODEX_HOME', alias);
    const bin = binary(join(secrets, 'codex'));
    expect(codexInstallRoot(bin)).toEqual({ path: bin, kind: 'file' });
  });
  it('checks fallback paths and cached directories against workspace ancestors', () => {
    const root = join(fixture(), 'runtime'); mkdirSync(root); const bin = join(root, 'missing-codex');
    expect(codexInstallRoot(bin)).toEqual({ path: root, kind: 'dir' });
    expect(codexInstallRoot(bin, [{ path: join(root, 'workspace'), access: 'write' }])).toEqual({ path: bin, kind: 'file' });
  });
  it('includes the runtime as read-only and keeps only existing Linux protected paths', () => {
    const root = fixture();
    mkdirSync(join(root, '.claude')); writeFileSync(join(root, '.claude/settings.json'), '{}');
    const roots = [{ path: root, access: 'write' }] as const;
    const linux = codexFilesystem(roots, 'write', { path: '/dedicated-codex', kind: 'dir' }, 'linux');
    expect(linux).toHaveProperty('/dedicated-codex', { '.': 'read' });
    expect(linux).toHaveProperty(root, { '.': 'write', '.claude/settings.json': 'read' });
    const mac = codexFilesystem(roots, 'write', undefined, 'darwin');
    expect(mac).toHaveProperty(root, { '.': 'write', ...Object.fromEntries(CODEX_PROTECTED_PATHS.map(path => [path, 'read'])) });
  });
  it('retains explicit read entries for already existing native Codex metadata', () => {
    const root = fixture();
    mkdirSync(join(root, '.codex')); writeFileSync(join(root, '.codex/config.toml'), '');
    mkdirSync(join(root, '.agents/skills/x'), { recursive: true });
    writeFileSync(join(root, '.agents/skills/x/SKILL.md'), 'fixture');
    for (const mode of ['qa', 'write'] as const) {
      expect(codexFilesystem([{ path: root, access: 'write' }], mode, undefined, 'linux'))
        .toHaveProperty(root, { '.': mode === 'qa' ? 'read' : 'write', '.codex': 'read', '.agents/skills': 'read' });
    }
  });
  it('adds the real resolver target only when Linux network is enabled', () => {
    const resolver = realpathSync('/etc/resolv.conf');
    expect(codexFilesystem([], 'qa', undefined, 'linux', true)).toHaveProperty([resolver], { '.': 'read' });
    expect(codexFilesystem([], 'qa', undefined, 'linux', false)).not.toHaveProperty([resolver]);
  });
});
