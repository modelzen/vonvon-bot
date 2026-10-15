import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { observeCli, registerCli, windowsPathStore, type CliRegistrationOptions } from '../src/cli-registration.js';

const exec = promisify(execFile);
const system32 = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const roots: string[] = [];
const subkey = `Software\\Vonvon Bot Test ${randomUUID()}`;

function reg(args: string[]): Promise<{ stdout: string }> {
  return exec(win32.join(system32, 'reg.exe'), args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
}

async function queryType(key: string, value: string): Promise<string | undefined> {
  return /\s(REG_\w+)/.exec((await reg(['query', key, '/v', value])).stdout)?.[1];
}

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vonvon-windows-native-')));
  roots.push(root);
  return root;
}

async function bundledResources(root: string, cli: string): Promise<string> {
  const resources = join(root, '资源 100%PATH% resources');
  const files: Array<[string, string]> = [
    ['daemon/package.json', JSON.stringify({ name: '@vonvon/daemon', bin: { vonvon: 'bin/vonvon.mjs' } })],
    ['daemon/bin/vonvon.mjs', cli],
    ['daemon/dist/cli.js', ''],
    ['app.asar/package.json', JSON.stringify({ name: 'vonvon-bot-desktop', main: 'desktop/main.cjs' })],
    ['app.asar/desktop/main.cjs', ''],
  ];
  for (const [file, content] of files) {
    await mkdir(dirname(join(resources, file)), { recursive: true });
    await writeFile(join(resources, file), content);
  }
  return resources;
}

afterAll(async () => {
  await reg(['delete', `HKCU\\${subkey}`, '/f']).catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'win32')('Windows native CLI registration', () => {
  it('reads and writes the user PATH value in the registry and keeps its type', async () => {
    const store = windowsPathStore(subkey);
    expect(await store.read()).toEqual({ value: '', type: 'REG_EXPAND_SZ' });
    await store.write('C:\\工具 Tools;D:\\bin', 'REG_SZ');
    expect(await store.read()).toEqual({ value: 'C:\\工具 Tools;D:\\bin', type: 'REG_SZ' });
    expect(await queryType(`HKCU\\${subkey}`, 'Path')).toBe('REG_SZ');
    await store.write('%USERPROFILE%\\bin', 'REG_EXPAND_SZ');
    expect(await store.read()).toEqual({ value: '%USERPROFILE%\\bin', type: 'REG_EXPAND_SZ' });
    expect(await queryType(`HKCU\\${subkey}`, 'Path')).toBe('REG_EXPAND_SZ');
    await reg(['add', `HKCU\\${subkey}`, '/v', 'Path', '/t', 'REG_DWORD', '/d', '1', '/f']);
    await expect(store.read()).rejects.toThrow('用户 PATH 类型不受支持。');
  }, 60_000);

  it('registers a wrapper that runs the bundled CLI with its arguments and exit code', async () => {
    const root = await tempRoot();
    const resources = await bundledResources(root, [
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null }));',
      'process.exit(Number(process.argv.at(-1)));',
    ].join('\n'));
    const home = join(root, 'home');
    const options: CliRegistrationOptions = { platform: 'win32', home, executable: process.execPath, resources,
      packaged: true, localAppData: join(home, 'AppData', 'Local'), windowsPath: windowsPathStore(subkey) };
    const bin = join(home, 'AppData', 'Local', 'Vonvon Bot', 'bin');
    await reg(['add', `HKCU\\${subkey}`, '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', `%SystemRoot%\\system32;${bin}`, '/f']);

    expect(await registerCli(options)).toMatchObject({ kind: 'ready', bin });
    expect(await windowsPathStore(subkey).read()).toEqual({ value: `${bin};%SystemRoot%\\system32`, type: 'REG_EXPAND_SZ' });
    expect(await queryType(`HKCU\\${subkey}`, 'Path')).toBe('REG_EXPAND_SZ');

    const wrapper = join(bin, 'vonvon.cmd');
    const run = (command: string) => spawnSync(win32.join(system32, 'cmd.exe'), ['/d', '/s', '/c', `"${command}"`], {
      windowsVerbatimArguments: true, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    const child = run(`"${wrapper}" alpha "two words" 7`);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(7);
    expect(JSON.parse(child.stdout)).toEqual({ args: ['alpha', 'two words', '7'], runAsNode: '1' });

    const pages = run(`chcp & "${wrapper}" 0 >nul & chcp`);
    expect(pages.status, pages.stderr).toBe(0);
    const [before, after] = pages.stdout.trim().split(/\r?\n/);
    expect(after).toBe(before);
  }, 60_000);

  it('reads the real user Environment key when no PATH store is supplied', async () => {
    const root = await tempRoot();
    const resources = await bundledResources(root, '');
    const home = join(root, 'home');
    const options: CliRegistrationOptions = { platform: 'win32', home, executable: process.execPath, resources,
      packaged: true, localAppData: join(home, 'AppData', 'Local') };
    expect(await registerCli({ ...options, windowsPath: windowsPathStore(subkey) })).toMatchObject({ kind: 'ready' });
    expect(await observeCli(options)).toEqual({ kind: 'error', message: '用户 PATH 尚未注册命令行目录。' });
  }, 60_000);
});
