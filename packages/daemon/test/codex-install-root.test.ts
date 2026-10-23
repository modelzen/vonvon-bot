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
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

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
    const root = fixture();
    expect(codexInstallRoot(binary(join(root, 'codex')))).toEqual({ path: root, kind: 'dir' });
  });
  it('grants only the binary in the home or a common installation directory', () => {
    host.home = fixture();
    const bin = binary(join(host.home, 'codex'));
    expect(codexInstallRoot(bin)).toEqual({ path: bin, kind: 'file' });
    expect(codexInstallRoot('/usr/local/bin/missing-codex-fixture')).toEqual({ path: '/usr/local/bin/missing-codex-fixture', kind: 'file' });
  });
  it('checks fallback paths and cached directories against workspace ancestors', () => {
    const root = fixture(); const bin = join(root, 'missing-codex');
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
  it('adds the real resolver target only when Linux network is enabled', () => {
    const resolver = realpathSync('/etc/resolv.conf');
    expect(codexFilesystem([], 'qa', undefined, 'linux', true)).toHaveProperty([resolver], { '.': 'read' });
    expect(codexFilesystem([], 'qa', undefined, 'linux', false)).not.toHaveProperty([resolver]);
  });
});
