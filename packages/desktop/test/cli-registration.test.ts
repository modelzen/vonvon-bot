import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopCliOptions, observeCli, registerCli, type CliRegistrationOptions, type WindowsPath } from '../src/cli-registration.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  if (process.platform !== 'win32') return actual;
  const executableModes = new Map<string, number>();
  return {
    ...actual,
    chmod: async (path: string, mode: number) => {
      await actual.chmod(path, mode);
      executableModes.set(path, mode & 0o111);
    },
    lstat: async (path: string) => {
      const info = await actual.lstat(path);
      const mode = executableModes.get(path);
      if (mode !== undefined) info.mode = (info.mode & ~0o111) | mode;
      return info;
    },
    stat: async (path: string) => {
      const info = await actual.stat(path);
      const mode = executableModes.get(path);
      if (mode !== undefined) info.mode = (info.mode & ~0o111) | mode;
      return info;
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(platform: 'darwin' | 'win32'): Promise<{ options: CliRegistrationOptions; wrapper: string; bin: string }> {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-cli-test-'));
  roots.push(root);
  const home = join(root, 'home');
  const resources = join(root, '资源 resources');
  const daemon = join(resources, 'daemon');
  const executable = join(root, platform === 'win32' ? '应用 Vonvon Bot.exe' : "Vonvon Bot's Electron");
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
  const bin = platform === 'win32' ? join(home, 'AppData', 'Local', 'Vonvon Bot', 'bin') : join(home, '.local', 'share', 'vonvon-bot', 'bin');
  const wrapper = join(bin, platform === 'win32' ? 'vonvon.cmd' : 'vonvon');
  return { options: { platform, home, executable, resources, packaged: true, zdotdir: home,
    localAppData: join(home, 'AppData', 'Local') }, wrapper, bin };
}

describe('desktop CLI registration', () => {
  it('reports absence, installs the packaged macOS command, preserves startup content and repeats without changes', async () => {
    const { options, wrapper, bin } = await fixture('darwin');
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

  it('honors configured absolute startup and application-data directories outside HOME', async () => {
    const { options } = await fixture('win32');
    const zdotdir = join(dirname(options.home), 'zsh-config');
    const localAppData = join(dirname(options.home), 'local-app-data');
    vi.stubEnv('HOME', options.home);
    vi.stubEnv('USERPROFILE', options.home);
    vi.stubEnv('ZDOTDIR', zdotdir);
    vi.stubEnv('LOCALAPPDATA', localAppData);
    expect(desktopCliOptions({ ...options, platform: 'darwin' })).toMatchObject({ home: options.home, zdotdir });
    const configured = desktopCliOptions(options);
    expect(configured).toMatchObject({ home: options.home, localAppData });
    let path: WindowsPath = { value: '', type: 'REG_SZ' };
    configured.windowsPath = { read: async () => path, write: async (value, type) => { path = { value, type }; } };
    const bin = join(localAppData, 'Vonvon Bot', 'bin');
    expect(await registerCli(configured)).toMatchObject({ kind: 'ready', bin });
    expect(path.value).toBe(bin);
    expect(await readFile(join(bin, 'vonvon.cmd'), 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
  });

  it.runIf(process.platform === 'darwin')('resolves the registered command in fresh zsh with external ZDOTDIR', async () => {
    const { options, wrapper, bin } = await fixture('darwin');
    const zdotdir = join(dirname(options.home), 'zsh-config');
    await mkdir(zdotdir);
    await writeFile(join(zdotdir, '.zshrc'), 'export ORIGINAL=external\n');
    vi.stubEnv('HOME', options.home);
    vi.stubEnv('ZDOTDIR', zdotdir);
    vi.stubEnv('LOCALAPPDATA', join(options.home, 'AppData', 'Local'));
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
    const { options, wrapper, bin } = await fixture('darwin');
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

  it('rejects development and incomplete distributions without creating command entries', async () => {
    const { options, wrapper } = await fixture('darwin');
    expect(await registerCli({ ...options, packaged: false })).toMatchObject({ kind: 'error' });
    await rm(join(options.resources, 'daemon', 'dist', 'cli.js'));
    expect(await registerCli(options)).toMatchObject({ kind: 'error' });
    await expect(stat(wrapper)).rejects.toThrow();
  });

  it('checks Windows PATH through the injected user registry store and preserves its value type', async () => {
    const { options, wrapper, bin } = await fixture('win32');
    let path: WindowsPath = { type: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\bin' };
    const write = vi.fn(async (value: string, type: WindowsPath['type']) => { path = { value, type }; });
    options.windowsPath = { read: async () => path, write };
    expect(await registerCli(options)).toMatchObject({ kind: 'ready', bin });
    const body = await readFile(wrapper, 'utf8');
    expect(body.split('\r\n')).toEqual([
      '@echo off',
      'rem Vonvon Bot managed CLI v1',
      'setlocal EnableExtensions DisableDelayedExpansion',
      'for /f "tokens=2 delims=:" %%C in (\'chcp\') do set "_VB_CP=%%C"',
      'chcp 65001 >nul',
      'if errorlevel 1 exit /b 1',
      'set "ELECTRON_RUN_AS_NODE=1"',
      '"' + options.executable + '" "' + join(options.resources, 'daemon', 'bin', 'vonvon.mjs') + '" %*',
      'set "_VB_EXIT=%ERRORLEVEL%"',
      'if defined _VB_CP chcp %_VB_CP% >nul',
      'exit /b %_VB_EXIT%',
      '',
    ]);
    expect(write).toHaveBeenCalledWith(`${bin};%USERPROFILE%\\bin`, 'REG_EXPAND_SZ');
    expect(await registerCli(options)).toMatchObject({ kind: 'ready' });
    expect(write).toHaveBeenCalledOnce();
    path = { ...path, value: '%USERPROFILE%\\bin' };
    expect(await observeCli(options)).toMatchObject({ kind: 'error' });
  });

  it('does not report success when PATH writing fails after the wrapper was created', async () => {
    const { options, wrapper } = await fixture('win32');
    options.windowsPath = { read: async () => ({ value: '', type: 'REG_SZ' }), write: async () => { throw new Error('registry denied'); } };
    expect(await registerCli(options)).toMatchObject({ kind: 'error', message: 'registry denied' });
    expect(await readFile(wrapper, 'utf8')).toContain('Vonvon Bot managed CLI v1');
    expect(await observeCli(options)).toMatchObject({ kind: 'error' });
  });
});
