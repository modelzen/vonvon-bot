import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observeCli, registerCli, type CliRegistrationOptions } from '../src/cli-registration.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'vonvon-win-cli-'));
  roots.push(root);
  const home = join(root, '用户 home');
  const app = join(root, '中文安装 & !');
  const executable = join(app, 'Vonvon Bot.exe');
  const resources = join(app, 'resources');
  const cli = join(resources, 'daemon', 'bin', 'vonvon.mjs');
  const bin = join(resources, 'cli');
  const launcher = join(bin, 'vonvon.exe');
  await mkdir(home);
  await mkdir(join(resources, 'daemon', 'bin'), { recursive: true });
  await mkdir(bin);
  await mkdir(join(resources, 'daemon', 'dist'));
  await mkdir(join(resources, 'app.asar', 'desktop'), { recursive: true });
  await writeFile(executable, 'runtime');
  await writeFile(launcher, 'native launcher');
  await writeFile(cli, 'cli');
  await writeFile(join(resources, 'daemon', 'dist', 'cli.js'), 'cli');
  await writeFile(join(resources, 'daemon', 'package.json'), JSON.stringify({ name: '@vonvon/daemon', bin: { vonvon: 'bin/vonvon.mjs' } }));
  await writeFile(join(resources, 'app.asar', 'package.json'), JSON.stringify({ name: 'vonvon-bot-desktop', main: 'desktop/main.cjs' }));
  await writeFile(join(resources, 'app.asar', 'desktop', 'main.cjs'), 'main');
  let path = false;
  const windowsPath = { contains: vi.fn(async () => path), add: vi.fn(async () => { path = true; }) };
  const options: CliRegistrationOptions = { platform: 'win32', home, executable, resources, packaged: true, windowsPath,
    windowsCliSha256: createHash('sha256').update('native launcher').digest('hex') };
  return { root, home, app, cli, bin, launcher, executable, resources, options, windowsPath, clearPath: () => { path = false; } };
}

describe('Windows desktop CLI', () => {
  it('registers and repairs user PATH without rewriting the packaged launcher or shell profiles', async () => {
    const f = await fixture();
    expect(await observeCli(f.options)).toMatchObject({ kind: 'error', message: 'Windows 用户 PATH 尚未注册。' });
    const before = await stat(f.launcher);
    expect(await registerCli(f.options)).toMatchObject({ kind: 'ready', bin: f.bin });
    await expect(stat(join(f.home, '.profile'))).rejects.toThrow();
    await expect(stat(join(f.home, '.zshrc'))).rejects.toThrow();
    await registerCli(f.options);
    expect((await stat(f.launcher)).mtimeMs).toBe(before.mtimeMs);
    expect(f.windowsPath.add).toHaveBeenCalledTimes(1);
    f.clearPath();
    expect(await observeCli(f.options)).toMatchObject({ kind: 'error' });
    expect(await registerCli(f.options)).toMatchObject({ kind: 'ready' });
  });

  it('refuses changed/missing launchers and incomplete/development distributions before touching PATH', async () => {
    const f = await fixture();
    await writeFile(f.launcher, 'foreign');
    expect(await registerCli(f.options)).toMatchObject({ kind: 'error' });
    expect(await readFile(f.launcher, 'utf8')).toBe('foreign');
    await rm(f.launcher);
    expect(await registerCli(f.options)).toMatchObject({ kind: 'error' });
    expect(await registerCli({ ...f.options, packaged: false })).toMatchObject({ kind: 'error' });
    await rm(join(f.resources, 'daemon', 'dist', 'cli.js'));
    expect(await registerCli(f.options)).toMatchObject({ kind: 'error' });
    expect(f.windowsPath.add).not.toHaveBeenCalled();
  });

  it('reports a PATH write failure and can retry', async () => {
    const f = await fixture();
    f.windowsPath.add.mockRejectedValueOnce(new Error('registry denied'));
    expect(await registerCli(f.options)).toEqual({ kind: 'error', message: 'registry denied' });
    expect(await observeCli(f.options)).toMatchObject({ kind: 'error' });
    expect(await registerCli(f.options)).toMatchObject({ kind: 'ready' });
  });

  it.runIf(process.platform === 'win32')('runs the compiled launcher in CMD and PowerShell with exact arguments, stdin, stderr and exit codes', async () => {
    const f = await fixture();
    // Compile the real Console executable. Node stands in for Electron's Node mode for precise argv/stream checks.
    const helper = new URL('../../../scripts/build-windows-cli.mjs', import.meta.url).href;
    const { buildWindowsCli } = await import(helper);
    f.options.windowsCliSha256 = await buildWindowsCli(f.bin);
    await copyFile(process.execPath, f.executable);
    await writeFile(f.cli, `let input = ''; if (process.argv.includes('--read-input')) for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({args: process.argv.slice(2), input, mode: process.env.ELECTRON_RUN_AS_NODE, cwd: process.cwd()}));
console.error('cli-stderr'); process.exitCode = process.argv.includes('--fail') ? 27 : 0;`);
    expect(await registerCli(f.options)).toMatchObject({ kind: 'ready' });
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: 'before', PATH: `${f.bin};${process.env.PATH ?? ''}`, VONVON_CLI_ARG: 'unchanged' };
    const run = async (executable: string, args: string[]) => {
      const child = execFile(executable, args, { env, cwd: f.home, windowsHide: true, timeout: 15000 });
      child.stdin!.end('piped input 中文');
      return await new Promise<{stdout: string; stderr: string}>((resolve, reject) => {
        let stdout = '', stderr = '';
        child.stdout!.on('data', value => { stdout += value; });
        child.stderr!.on('data', value => { stderr += value; });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(Object.assign(new Error(stderr), { code, stdout })));
      });
    };
    const args = ['two words', '中文 & !', 'hello&world', 'literal-%VONVON_CLI_ARG%', '', 'a"b', 'C:\\ends with slash\\', '--read-input'];
    const direct = await run(f.launcher, args);
    const received = JSON.parse(direct.stdout);
    // Hosted Windows TEMP may use an 8.3 username; Node reports the same directory with its long name.
    expect({ ...received, cwd: await realpath(received.cwd) }).toEqual({ args, input: 'piped input 中文', mode: '1', cwd: await realpath(f.home) });
    expect(direct.stderr.trim()).toBe('cli-stderr');
    const cmd = await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'vonvon --json']);
    expect(JSON.parse(cmd.stdout).args).toEqual(['--json']);
    const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const ps = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', "& vonvon 'hello&world' 'literal-%VONVON_CLI_ARG%'; exit $LASTEXITCODE"]);
    expect(JSON.parse(ps.stdout).args).toEqual(['hello&world', 'literal-%VONVON_CLI_ARG%']);
    await expect(run(powershell, ['-NoProfile', '-NonInteractive', '-Command', '& vonvon --fail; exit $LASTEXITCODE'])).rejects.toMatchObject({ code: 27 });
    const scoped = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', '& vonvon --json > $null 2> $null; Write-Output $env:ELECTRON_RUN_AS_NODE']);
    expect(scoped.stdout.trim()).toBe('before');
  }, 60000);
});
