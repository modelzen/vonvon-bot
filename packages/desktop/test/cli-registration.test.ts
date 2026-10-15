import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopCliOptions, observeCli, registerCli, type CliRegistrationOptions } from '../src/cli-registration.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ options: CliRegistrationOptions; wrapper: string; bin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-cli-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const resources = join(root, '资源 resources');
  const daemon = join(resources, 'daemon');
  const executable = join(root, "Vonvon Bot's Electron");
  await mkdir(join(daemon, 'bin'), { recursive: true });
  await mkdir(join(daemon, 'dist'));
  await mkdir(join(resources, 'app.asar', 'desktop'), { recursive: true });
  await mkdir(home);
  await writeFile(executable, 'electron');
  await writeFile(join(daemon, 'package.json'), JSON.stringify({ name: '@vonvon/daemon', bin: { vonvon: 'bin/vonvon.mjs' } }));
  await writeFile(join(daemon, 'bin', 'vonvon.mjs'), 'cli');
  await writeFile(join(daemon, 'dist', 'cli.js'), 'cli');
  await writeFile(join(resources, 'app.asar', 'package.json'), JSON.stringify({ name: 'vonvon-bot-desktop', main: 'desktop/main.cjs' }));
  await writeFile(join(resources, 'app.asar', 'desktop', 'main.cjs'), 'main');
  const bin = join(home, '.local', 'share', 'vonvon-bot', 'bin');
  const wrapper = join(bin, 'vonvon');
  return { options: { platform: 'darwin', home, executable, resources, packaged: true, zdotdir: home }, wrapper, bin };
}

describe('desktop CLI registration', () => {
  it('reports absence, installs the packaged macOS command, preserves startup content and repeats without changes', async () => {
    const { options, wrapper, bin } = await fixture();
    await writeFile(join(options.home, '.zshrc'), 'export ORIGINAL=1\n');
    await writeFile(join(options.home, '.bash_profile'), 'export BASH_ORIGINAL=1\n');
    expect((await observeCli(options)).kind).toBe('error');
    expect(await registerCli(options)).toMatchObject({ kind: 'ready', bin });
    const body = await readFile(wrapper, 'utf8');
    expect(body).toContain(`exec '${options.executable.replaceAll("'", "'\\''")}' '${join(options.resources, 'daemon', 'bin', 'vonvon.mjs')}' "$@"`);
    expect(body).toContain('ELECTRON_RUN_AS_NODE=1');
    expect((await stat(wrapper)).mode & 0o111).not.toBe(0);
    const zsh = await readFile(join(options.home, '.zshrc'), 'utf8');
    expect(zsh).toContain('export ORIGINAL=1\n');
    expect(zsh).toContain(bin);
    expect((await readFile(join(options.home, '.bash_profile'), 'utf8'))).toContain('export BASH_ORIGINAL=1\n');
    expect(await registerCli(options)).toMatchObject({ kind: 'ready', bin });
    expect(await readFile(join(options.home, '.zshrc'), 'utf8')).toBe(zsh);
    await rm(join(options.home, '.zprofile'));
    expect(await observeCli(options)).toMatchObject({ kind: 'error' });
  });

  it('honors an absolute ZDOTDIR outside HOME and ignores a relative one', async () => {
    const { options, bin } = await fixture();
    const { platform, executable, resources, packaged } = options;
    const zdotdir = join(dirname(options.home), 'zsh-config');
    await mkdir(zdotdir);
    await writeFile(join(zdotdir, '.zshrc'), 'export ORIGINAL=external\n');
    vi.stubEnv('HOME', options.home);
    vi.stubEnv('ZDOTDIR', 'relative-zsh');
    expect(desktopCliOptions({ platform, executable, resources, packaged })).not.toHaveProperty('zdotdir');
    vi.stubEnv('ZDOTDIR', zdotdir);
    const configured = desktopCliOptions({ platform, executable, resources, packaged });
    expect(configured).toMatchObject({ home: options.home, zdotdir });
    expect(await registerCli(configured)).toMatchObject({ kind: 'ready', bin });
    expect(await readFile(join(zdotdir, '.zshrc'), 'utf8')).toMatch(/^export ORIGINAL=external\n# >>> Vonvon Bot CLI >>>/);
    expect(await readFile(join(zdotdir, '.zprofile'), 'utf8')).toContain(bin);
    await expect(stat(join(options.home, '.zshrc'))).rejects.toThrow();
    expect(await readFile(join(options.home, '.profile'), 'utf8')).toContain(bin);
  });

  it.runIf(process.platform === 'darwin')('resolves the registered command in fresh zsh with external ZDOTDIR', async () => {
    const { options, wrapper, bin } = await fixture();
    const zdotdir = join(dirname(options.home), 'zsh-config');
    await mkdir(zdotdir);
    await writeFile(join(zdotdir, '.zshrc'), 'export ORIGINAL=external\n');
    vi.stubEnv('HOME', options.home);
    vi.stubEnv('ZDOTDIR', zdotdir);
    const configured = desktopCliOptions(options);
    expect(await registerCli(configured)).toMatchObject({ kind: 'ready', bin });
    expect(await readFile(join(zdotdir, '.zshrc'), 'utf8')).toContain('export ORIGINAL=external\n');
    await expect(stat(join(options.home, '.zshrc'))).rejects.toThrow();
    const { stdout } = await promisify(execFile)('/bin/zsh', ['-lic', 'command -v vonvon'], {
      env: { HOME: options.home, ZDOTDIR: zdotdir, PATH: '/usr/bin:/bin', TERM: 'dumb' },
    });
    expect(stdout.trim()).toBe(wrapper);
    await rm(join(zdotdir, '.zprofile'));
    expect(await observeCli(configured)).toMatchObject({ kind: 'error' });
  });

  it('refuses foreign files and symlinks before writing startup files', async () => {
    const { options, wrapper, bin } = await fixture();
    await mkdir(bin, { recursive: true });
    await writeFile(wrapper, 'foreign');
    expect(await registerCli(options)).toMatchObject({ kind: 'error' });
    expect(await readFile(wrapper, 'utf8')).toBe('foreign');
    await rm(wrapper);
    await symlink(join(options.home, 'foreign'), wrapper);
    expect(await registerCli(options)).toMatchObject({ kind: 'error' });
    await rm(wrapper);
    await writeFile(join(options.home, '.zshrc'), '# >>> Vonvon Bot CLI >>>\n');
    expect(await registerCli(options)).toMatchObject({ kind: 'error' });
    await expect(stat(wrapper)).rejects.toThrow();
  });

  it('rejects development builds, other platforms and incomplete distributions without creating command entries', async () => {
    const { options, wrapper } = await fixture();
    expect(await registerCli({ ...options, packaged: false })).toMatchObject({ kind: 'error' });
    expect(await registerCli({ ...options, platform: 'win32' })).toEqual({ kind: 'error', message: '不支持的平台：win32' });
    expect(await observeCli({ ...options, platform: 'linux' })).toEqual({ kind: 'error', message: '不支持的平台：linux' });
    await rm(join(options.resources, 'daemon', 'dist', 'cli.js'));
    expect(await registerCli(options)).toMatchObject({ kind: 'error' });
    await expect(stat(wrapper)).rejects.toThrow();
  });
});
