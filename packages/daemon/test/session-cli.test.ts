import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
import { launcherFiles, sessionCliEnv, writeSessionCli, type CliRuntime } from '../src/agent/session-cli';

// dm-agent 9: a session finds `vonvon` without the shell's startup files.
const roots: string[] = [];
const temporary = (): string => { const root = mkdtempSync(join(tmpdir(), 'session-cli-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });

const plain: CliRuntime = { execPath: '/opt/vonvon/node/bin/node', entry: '/opt/vonvon/app/bin/vonvon.mjs', electron: false };
const posix = (runtime: CliRuntime) => launcherFiles(runtime, 'linux')[0]!;

describe('the launcher', () => {
  it('runs the daemon\'s own Node on its own entry', () => {
    expect(launcherFiles(plain, 'linux')).toEqual([{ name: 'vonvon', mode: 0o755,
      content: `#!/bin/sh\n# Vonvon Bot session launcher; rewritten each time a Bot starts\nexec '/opt/vonvon/node/bin/node' '/opt/vonvon/app/bin/vonvon.mjs' "$@"\n` }]);
  });
  it('tells Electron to be a Node when the daemon runs inside it, and only then', () => {
    expect(posix({ ...plain, electron: true }).content).toContain('\nELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE\nexec ');
    expect(posix(plain).content).not.toContain('ELECTRON_RUN_AS_NODE');
  });
  it('quotes a path with spaces and a single quote', () => {
    expect(posix({ ...plain, execPath: `/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot`, entry: `/it's here/vonvon.mjs` }).content)
      .toContain(`exec '/Applications/Vonvon Bot.app/Contents/MacOS/Vonvon Bot' '/it'\\''s here/vonvon.mjs' "$@"`);
  });

  // What a shell does with it, in folders a person might have.
  it.skipIf(process.platform === 'win32').each([['spaces', 'Vonvon Bot'], ['a quote', `it's`], ['Chinese', '张 三'], ['a dollar', '$HOME `x`']])('runs from a path with %s, arguments intact', async (_case, folder) => {
    const root = join(temporary(), folder);
    mkdirSync(root);
    const execPath = join(root, 'fake node');
    writeFileSync(execPath, '#!/bin/sh\nprintf "%s\\n" "electron=$ELECTRON_RUN_AS_NODE" "$@"\nexit 7\n');
    chmodSync(execPath, 0o755);
    const cli = await writeSessionCli({ execPath, entry: join(root, 'vonvon.mjs'), electron: true }, join(root, 'bin'), 'linux');
    const run = spawnSync(cli!, ['settings get', '--group', '研发 群', '$VONVON', ''], { encoding: 'utf8' });
    expect(run.stdout.split('\n')).toEqual(['electron=1', join(root, 'vonvon.mjs'), 'settings get', '--group', '研发 群', '$VONVON', '', '']);
    expect(run.status).toBe(7);
    expect(statSync(cli!).mode & 0o777).toBe(0o755);
  });
});

describe('the Windows launcher', () => {
  const windows: CliRuntime = { execPath: 'C:\\Users\\张三\\AppData\\Local\\Programs\\Vonvon Bot\\Vonvon Bot.exe', entry: 'C:\\Users\\张三\\AppData\\Local\\Programs\\Vonvon Bot\\resources\\daemon\\bin\\vonvon.mjs', electron: true };
  const [cmd, sh] = launcherFiles(windows, 'win32');
  const lines = cmd!.content.split('\r\n');
  it('is vonvon.cmd, with an sh one beside it for Git Bash', () => {
    expect(cmd!.name).toBe('vonvon.cmd');
    expect(sh!.name).toBe('vonvon');
    expect(sh!.content).toContain(`exec '${windows.execPath}' '${windows.entry}' "$@"`);
  });
  it('quotes both paths, passes the arguments on and keeps the exit code', () => {
    expect(lines).toContain(`"${windows.execPath}" "${windows.entry}" %*`);
    expect(lines[0]).toBe('@echo off');
    expect(lines.indexOf('set "VONVON_EXIT=%ERRORLEVEL%"')).toBe(lines.indexOf(`"${windows.execPath}" "${windows.entry}" %*`) + 1);
    expect(lines.at(-2)).toBe('exit /b %VONVON_EXIT%');
    expect(cmd!.content.replaceAll('\r\n', '')).not.toContain('\n');
  });
  it('reads the paths as UTF-8 and puts the code page back', () => {
    const ascii = (line: string | undefined) => /^[\x20-\x7e]*$/.test(line ?? '');
    const utf8 = lines.indexOf('chcp 65001 >nul 2>nul');
    expect(utf8).toBeGreaterThan(0);
    expect(lines.slice(0, utf8 + 1).every(ascii)).toBe(true);
    expect(lines.indexOf(`"${windows.execPath}" "${windows.entry}" %*`)).toBeGreaterThan(utf8);
    expect(lines).toContain('chcp %VONVON_CODE_PAGE% >nul 2>nul');
  });
  it('sets ELECTRON_RUN_AS_NODE only for Electron, inside setlocal, and doubles a % in a path', () => {
    expect(lines).toContain('set "ELECTRON_RUN_AS_NODE=1"');
    expect(lines.indexOf('setlocal DisableDelayedExpansion')).toBeLessThan(lines.indexOf('set "ELECTRON_RUN_AS_NODE=1"'));
    expect(launcherFiles({ execPath: 'C:\\100% real\\node.exe', entry: 'C:\\a & b\\vonvon.mjs', electron: false }, 'win32')[0]!.content)
      .toContain('"C:\\100%% real\\node.exe" "C:\\a & b\\vonvon.mjs" %*');
    expect(launcherFiles({ ...windows, electron: false }, 'win32')[0]!.content).not.toContain('ELECTRON_RUN_AS_NODE');
  });
});

describe('writing it', () => {
  it('returns the full path, writes each file named for the platform, and follows an upgrade', async () => {
    const bin = join(temporary(), 'data', 'bin');
    expect(await writeSessionCli(plain, bin, 'linux')).toBe(join(bin, 'vonvon'));
    const upgraded = { ...plain, entry: '/opt/vonvon/releases/2/app/bin/vonvon.mjs' };
    expect(await writeSessionCli(upgraded, bin, 'linux')).toBe(join(bin, 'vonvon'));
    expect(readFileSync(join(bin, 'vonvon'), 'utf8')).toBe(posix(upgraded).content);
    expect(await writeSessionCli(plain, bin, 'win32')).toBe(join(bin, 'vonvon.cmd'));
    expect(readdirSync(bin).sort()).toEqual(['vonvon', 'vonvon.cmd']);
  });
  it('leaves the same text alone, its mode restored', async () => {
    const bin = temporary();
    const cli = await writeSessionCli(plain, bin, 'linux');
    const before = statSync(cli!).mtimeMs;
    if (process.platform !== 'win32') chmodSync(cli!, 0o644);
    await writeSessionCli(plain, bin, 'linux');
    expect(statSync(cli!).mtimeMs).toBe(before);
    if (process.platform !== 'win32') expect(statSync(cli!).mode & 0o777).toBe(0o755);
  });
  it('survives every Bot starting at once', async () => {
    const bin = temporary();
    const upgraded = { ...plain, entry: '/new/vonvon.mjs' };
    await writeSessionCli(plain, bin, 'linux');
    const written = await Promise.all(Array.from({ length: 8 }, () => writeSessionCli(upgraded, bin, 'linux')));
    expect(new Set(written)).toEqual(new Set([join(bin, 'vonvon')]));
    expect(readdirSync(bin)).toEqual(['vonvon']);
    expect(readFileSync(join(bin, 'vonvon'), 'utf8')).toBe(posix(upgraded).content);
  });
  it('logs a failure and returns nothing, so a Bot starts anyway', async () => {
    const root = temporary();
    writeFileSync(join(root, 'bin'), 'a file where the directory goes');
    await expect(writeSessionCli(plain, join(root, 'bin'), 'linux')).resolves.toBeUndefined();
    expect(fake.log.fail).toHaveBeenCalledTimes(1);
    expect(fake.log.fail).toHaveBeenCalledWith('agent', expect.anything(), { phase: 'session-cli-failed' });
  });
  it('offers no launcher it could not write, even with an older one there', async () => {
    const bin = temporary();
    const cli = await writeSessionCli(plain, bin, 'linux');
    const blocked = join(bin, 'blocked');
    mkdirSync(join(blocked, 'vonvon'), { recursive: true });
    expect(await writeSessionCli({ ...plain, entry: '/new/vonvon.mjs' }, blocked, 'linux')).toBeUndefined();
    expect(readFileSync(cli!, 'utf8')).toBe(posix(plain).content);
    expect(readdirSync(blocked)).toEqual(['vonvon']);
  });
  it('wants an entry', async () => {
    await expect(writeSessionCli({ ...plain, entry: '' }, temporary(), 'linux')).resolves.toBeUndefined();
    expect(fake.log.fail).toHaveBeenCalledTimes(1);
  });
});

describe('a session\'s environment', () => {
  it('puts the launcher\'s directory first and names the launcher', () => {
    expect(sessionCliEnv('/data/bin/vonvon', { PATH: '/usr/bin:/bin' }, 'linux')).toEqual({ PATH: '/data/bin:/usr/bin:/bin', VONVON_CLI: '/data/bin/vonvon' });
  });
  it('does not repeat it: a daemon started from a session has it already', () => {
    expect(sessionCliEnv('/data/bin/vonvon', { PATH: '/data/bin:/usr/bin:/data/bin' }, 'linux').PATH).toBe('/data/bin:/usr/bin');
  });
  it('stands alone with no PATH to add to', () => {
    expect(sessionCliEnv('/data/bin/vonvon', {}, 'linux').PATH).toBe('/data/bin');
  });
  it('keeps Windows\' own spelling and separator, so a child does not get two', () => {
    expect(sessionCliEnv('C:\\data\\bin\\vonvon.cmd', { Path: 'C:\\Windows;C:\\tools' }, 'win32'))
      .toEqual({ Path: 'C:\\data\\bin;C:\\Windows;C:\\tools', VONVON_CLI: 'C:\\data\\bin\\vonvon.cmd' });
  });
  it('leaves another variable called Path alone off Windows', () => {
    expect(sessionCliEnv('/data/bin/vonvon', { Path: 'x', PATH: '/bin' }, 'linux')).toEqual({ PATH: '/data/bin:/bin', VONVON_CLI: '/data/bin/vonvon' });
  });
});
