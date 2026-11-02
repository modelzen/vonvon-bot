import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { startupBlock } from '@vonvon/protocol';
import { commandFailure } from '../src/cli/command-error';
import { runStandaloneSetup, runStandaloneTeardown, SERVER_CLI_MARKER, type StandaloneDependencies } from '../src/cli/commands/standalone-setup';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** An install root with `releases/<version>` for each version, and an empty home beside it. */
async function fixture(versions = ['1.0.0']) {
  const base = await mkdtemp(join(tmpdir(), 'vonvon-standalone-')); roots.push(base);
  const home = join(base, 'home');
  const root = join(home, '.local', 'share', 'vonvon-bot', 'server');
  await mkdir(home, { recursive: true });
  for (const version of versions) {
    await mkdir(join(root, 'releases', version), { recursive: true });
    await writeFile(join(root, 'releases', version, 'standalone.json'), `${JSON.stringify({ v: 1, version, target: 'linux-x64', node: 'test' }, null, 2)}\n`);
  }
  const deps: Partial<StandaloneDependencies> = { platform: 'linux', home, zdotdir: undefined, path: '/usr/bin:/bin' };
  let out = '';
  const io = { json: true, write: (text: string) => { out += text; } };
  return { base, home, root, deps, io, out: () => { const text = out; out = ''; return text; } };
}
const STARTUP = ['.zshrc', '.zprofile', '.profile', '.bashrc'];

// main 必败: there was no __standalone-setup (server-2 4.3)
describe('__standalone-setup', () => {
  it('points current at the release, writes the launcher and the same PATH block as the desktop app, and repeats without changes', async () => {
    const f = await fixture();
    await writeFile(join(f.home, '.bashrc'), 'export KEEP=1\n');
    const result = await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    expect(JSON.parse(f.out())).toEqual({ ok: true, ...result });
    expect(result).toMatchObject({ version: '1.0.0', previous: null, launcher: join(f.root, 'bin', 'vonvon'), pathAlreadyOnPath: false });
    expect(result.pathFiles).toEqual(STARTUP.map(name => join(f.home, name)));
    expect(await readlink(join(f.root, 'current'))).toBe('releases/1.0.0');
    const launcher = await readFile(join(f.root, 'bin', 'vonvon'), 'utf8');
    expect(launcher.split('\n').slice(0, 2)).toEqual(['#!/bin/sh', SERVER_CLI_MARKER]);
    expect((await stat(join(f.root, 'bin', 'vonvon'))).mode & 0o777).toBe(0o755);
    await expect(lstat(join(f.root, 'bin', 'vonvon.tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
    const block = startupBlock(join(f.root, 'bin'));
    for (const name of STARTUP) expect(await readFile(join(f.home, name), 'utf8')).toBe(name === '.bashrc' ? `export KEEP=1\n${block}` : block);
    const files = await Promise.all(STARTUP.map(name => readFile(join(f.home, name), 'utf8')));
    const again = await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, { ...f.deps, path: `/usr/bin:${join(f.root, 'bin')}` });
    expect(again).toMatchObject({ previous: '1.0.0', pathAlreadyOnPath: true });
    expect(await Promise.all(STARTUP.map(name => readFile(join(f.home, name), 'utf8')))).toEqual(files);
  });

  // root may write a read-only file
  it.skipIf(process.getuid?.() === 0)('names a startup file it cannot write and still succeeds', async () => {
    const f = await fixture();
    await writeFile(join(f.home, '.bashrc'), 'export KEEP=1\n');
    await chmod(join(f.home, '.bashrc'), 0o444);
    const result = await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    expect(result.pathFiles).not.toContain(join(f.home, '.bashrc'));
    expect(result.pathNote).toBe(`${join(f.home, '.bashrc')} 没写进去：EACCES`);
    expect(await readFile(join(f.home, '.bashrc'), 'utf8')).toBe('export KEEP=1\n');
    expect(JSON.parse(f.out())).toMatchObject({ ok: true, pathNote: expect.stringContaining('.bashrc') });
  });

  it('refuses arguments that do not name an install root and version, and a release that is not complete', async () => {
    const f = await fixture(['1.0.0', '1.0.1']);
    const failure = async (installRoot: string, version: string, deps = f.deps) => commandFailure(await runStandaloneSetup({ installRoot, version }, f.io, deps).catch((error: unknown) => error));
    expect(await failure('relative/root', '1.0.0')).toMatchObject({ exitCode: 2, error: { kind: 'bad-args' } });
    expect(await failure(join(f.base, 'nowhere'), '1.0.0')).toMatchObject({ exitCode: 2 });
    expect(await failure(f.root, '1.0')).toMatchObject({ exitCode: 2 });
    await writeFile(join(f.root, 'releases', '1.0.1', 'standalone.json'), JSON.stringify({ v: 1, version: '1.0.0' }));
    expect(await failure(f.root, '1.0.1')).toMatchObject({ exitCode: 1, error: { kind: 'failed', reason: 'release_incomplete' } });
    expect(await failure(f.root, '9.9.9')).toMatchObject({ error: { reason: 'release_incomplete' } });
    await expect(lstat(join(f.root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    // owner 2026-11-01: Mac and Windows install the desktop app, which carries the server
    for (const platform of ['win32', 'darwin'] as const) {
      expect(await failure(f.root, '1.0.0', { ...f.deps, platform })).toMatchObject({ exitCode: 1, error: { reason: 'unsupported_platform', message: expect.stringContaining('https://vonvon.cc/get/') } });
    }
    await expect(lstat(join(f.root, 'current.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.root, 'current'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(join(f.root, 'bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(join(f.root, 'bin', 'vonvon.tmp'), { recursive: true });
    expect(await failure(f.root, '1.0.0')).toMatchObject({ error: { reason: 'launcher_write_failed' } });
    expect(await readlink(join(f.root, 'current'))).toBe('releases/1.0.0');
  });

  it.runIf(process.platform !== 'win32')('the launcher runs the current release with its Node first in PATH, wherever it is called from', async () => {
    const f = await fixture(['1.0.0', '1.0.1']);
    for (const version of ['1.0.0', '1.0.1']) {
      const node = join(f.root, 'releases', version, 'node', 'bin', 'node');
      await mkdir(join(node, '..'), { recursive: true });
      await writeFile(node, `#!/bin/sh\nprintf '%s\\n' "${version}" "$PATH" "$@"\n`, { mode: 0o755 });
    }
    await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    const run = async () => (await promisify(execFile)(join(f.root, 'bin', 'vonvon'), ['a', 'b c'], { cwd: f.base, env: { PATH: '/usr/bin:/bin' } })).stdout.split('\n');
    const first = await run();
    // `pwd -P`: macOS's temporary directory is behind a link
    const root = await realpath(f.root);
    expect(first[0]).toBe('1.0.0');
    expect(first[1]?.startsWith(`${join(root, 'current', 'node', 'bin')}:`)).toBe(true);
    expect(first.slice(2, 5)).toEqual([join(root, 'current', 'app', 'bin', 'vonvon.mjs'), 'a', 'b c']);
    await runStandaloneSetup({ installRoot: f.root, version: '1.0.1' }, f.io, f.deps);
    expect((await run())[0]).toBe('1.0.1');
  });
});

// main 必败: there was no __standalone-teardown
describe('__standalone-teardown', () => {
  it('takes out the block for this install root only, keeping the rest of each file and its last newline', async () => {
    const f = await fixture();
    await writeFile(join(f.home, '.bashrc'), 'export KEEP=1\n');
    await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    const desktop = `export Z=1\n${startupBlock(join(f.home, '.local', 'share', 'vonvon-bot', 'bin'))}`;
    await writeFile(join(f.home, '.zshrc'), desktop);
    f.out();
    const result = await runStandaloneTeardown({ installRoot: f.root }, f.io, f.deps);
    expect(JSON.parse(f.out())).toEqual({ ok: true, pathFiles: [join(f.home, '.zprofile'), join(f.home, '.profile'), join(f.home, '.bashrc')] });
    expect(result.pathFiles).not.toContain(join(f.home, '.zshrc'));
    expect(await readFile(join(f.home, '.zshrc'), 'utf8')).toBe(desktop);
    expect(await readFile(join(f.home, '.bashrc'), 'utf8')).toBe('export KEEP=1\n');
    expect(await readFile(join(f.home, '.zprofile'), 'utf8')).toBe('');
    // nothing left to take out, and the install root is not touched
    expect((await runStandaloneTeardown({ installRoot: f.root }, f.io, f.deps)).pathFiles).toEqual([]);
    expect(await readlink(join(f.root, 'current'))).toBe('releases/1.0.0');
  });

  it('follows a startup file that is a link, writing the file it names', async () => {
    const f = await fixture();
    const dotfiles = join(f.base, 'dotfiles');
    await mkdir(dotfiles);
    await writeFile(join(dotfiles, 'bashrc'), 'export KEEP=1\n');
    await symlink(join(dotfiles, 'bashrc'), join(f.home, '.bashrc'));
    await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    expect((await lstat(join(f.home, '.bashrc'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(dotfiles, 'bashrc'), 'utf8')).toBe(`export KEEP=1\n${startupBlock(join(f.root, 'bin'))}`);
    await runStandaloneTeardown({ installRoot: f.root }, f.io, f.deps);
    expect(await readFile(join(dotfiles, 'bashrc'), 'utf8')).toBe('export KEEP=1\n');
  });

  // review F3: the rename used to replace a link to nothing with a plain file
  it('leaves a startup file that is a link to nothing as it is, and names it', async () => {
    const f = await fixture();
    await symlink(join(f.base, 'dotfiles', 'zshrc'), join(f.home, '.zshrc'));
    const result = await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    expect(result.pathFiles).not.toContain(join(f.home, '.zshrc'));
    expect(result.pathNote).toBe(`${join(f.home, '.zshrc')} 没写进去：符号链接指向的文件不存在`);
    expect(await readlink(join(f.home, '.zshrc'))).toBe(join(f.base, 'dotfiles', 'zshrc'));
    f.out();
    expect(await runStandaloneTeardown({ installRoot: f.root }, f.io, f.deps)).not.toHaveProperty('pathNote');
    expect(await readlink(join(f.home, '.zshrc'))).toBe(join(f.base, 'dotfiles', 'zshrc'));
  });

  // review 218 P3: the line break put before the block in a file without one at its end stayed after uninstall
  it('puts each startup file back byte for byte: with and without a last newline, empty, CRLF, across a second setup', async () => {
    const f = await fixture();
    const before: Record<string, string> = { '.zshrc': 'export KEEP=1', '.zprofile': '', '.profile': 'export A=1\r\nexport B=2\r\n', '.bashrc': 'export A=1\r' };
    for (const [name, text] of Object.entries(before)) await writeFile(join(f.home, name), text);
    await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    // the block still starts on a line of its own, and the file still ends with a newline
    expect(await readFile(join(f.home, '.zshrc'), 'utf8')).toBe(`export KEEP=1\n${startupBlock(join(f.root, 'bin'))}`);
    // an upgrade runs setup again
    await runStandaloneSetup({ installRoot: f.root, version: '1.0.0' }, f.io, f.deps);
    await runStandaloneTeardown({ installRoot: f.root }, f.io, f.deps);
    for (const [name, text] of Object.entries(before)) expect(await readFile(join(f.home, name), 'latin1')).toBe(text);

    // A line that went in after the block keeps the line break before it, whether or not setup ran again and moved
    // the block after that line.
    for (const again of [false, true]) {
      const g = await fixture();
      await writeFile(join(g.home, '.bashrc'), 'export KEEP=1');
      await runStandaloneSetup({ installRoot: g.root, version: '1.0.0' }, g.io, g.deps);
      await writeFile(join(g.home, '.bashrc'), `${await readFile(join(g.home, '.bashrc'), 'utf8')}export LATER=1\n`);
      if (again) {
        await runStandaloneSetup({ installRoot: g.root, version: '1.0.0' }, g.io, g.deps);
        expect(await readFile(join(g.home, '.bashrc'), 'utf8')).toBe(`export KEEP=1\nexport LATER=1\n${startupBlock(join(g.root, 'bin'))}`);
      }
      await runStandaloneTeardown({ installRoot: g.root }, g.io, g.deps);
      expect(await readFile(join(g.home, '.bashrc'), 'utf8')).toBe('export KEEP=1\nexport LATER=1\n');
    }
  });

  // review F1: reading the file as UTF-8 turned other bytes (a GBK comment) into U+FFFD for good
  it('keeps bytes that are not UTF-8, and writes the block for a bin path that is not ASCII as UTF-8', async () => {
    const f = await fixture();
    const gbk = Buffer.concat([Buffer.from('# '), Buffer.from('d6d0cec4d7a2cacd', 'hex'), Buffer.from('\nalias ll="ls -l"\n')]);
    await writeFile(join(f.home, '.bashrc'), gbk);
    const root = join(f.home, '服务端');
    await mkdir(join(root, 'releases', '1.0.0'), { recursive: true });
    await writeFile(join(root, 'releases', '1.0.0', 'standalone.json'), `${JSON.stringify({ v: 1, version: '1.0.0', target: 'linux-x64', node: 'test' })}\n`);
    await runStandaloneSetup({ installRoot: root, version: '1.0.0' }, f.io, f.deps);
    const block = Buffer.from(startupBlock(join(root, 'bin')), 'utf8');
    expect(await readFile(join(f.home, '.bashrc'))).toEqual(Buffer.concat([gbk, block]));
    expect(await readFile(join(f.home, '.zshrc'))).toEqual(block);
    const result = await runStandaloneTeardown({ installRoot: root }, f.io, f.deps);
    expect(result.pathFiles).toContain(join(f.home, '.bashrc'));
    expect(await readFile(join(f.home, '.bashrc'))).toEqual(gbk);
    expect(await readFile(join(f.home, '.zshrc'), 'utf8')).toBe('');
  });
});
