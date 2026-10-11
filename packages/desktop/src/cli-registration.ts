import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { classifyDistribution } from '../../daemon/src/service/distribution.js';

export type CliRegistration = { kind: 'ready'; bin: string; message: string } | { kind: 'error'; message: string };
export type WindowsPath = { value: string; type: 'REG_SZ' | 'REG_EXPAND_SZ' };
export interface WindowsPathStore {
  read(): Promise<WindowsPath>;
  write(value: string, type: WindowsPath['type']): Promise<void>;
}
export interface CliRegistrationOptions {
  platform: NodeJS.Platform;
  home: string;
  executable: string;
  resources: string;
  packaged: boolean;
  zdotdir?: string;
  localAppData?: string;
  windowsPath?: WindowsPathStore;
}

const marker = 'Vonvon Bot managed CLI v1';
const begin = '# >>> Vonvon Bot CLI >>>';
const end = '# <<< Vonvon Bot CLI <<<';
const exec = promisify(execFile);

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function cmd(value: string): string { return value.replaceAll('%', '%%'); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function location(options: CliRegistrationOptions): { bin: string; wrapper: string; cli: string } {
  const bin = options.platform === 'win32'
    ? join(options.localAppData ?? join(options.home, 'AppData', 'Local'), 'Vonvon Bot', 'bin')
    : join(options.home, '.local', 'share', 'vonvon-bot', 'bin');
  return { bin, wrapper: join(bin, options.platform === 'win32' ? 'vonvon.cmd' : 'vonvon'),
    cli: join(options.resources, 'daemon', 'bin', 'vonvon.mjs') };
}

function wrapperBody(options: CliRegistrationOptions, cli: string): string {
  return options.platform === 'win32'
    ? `@echo off\r\nrem ${marker}\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "_VB_CP=%%C"\r\nchcp 65001 >nul\r\nif errorlevel 1 exit /b 1\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${cmd(options.executable)}" "${cmd(cli)}" %*\r\nset "_VB_EXIT=%ERRORLEVEL%"\r\nif defined _VB_CP chcp %_VB_CP% >nul\r\nexit /b %_VB_EXIT%\r\n`
    : `#!/bin/sh\n# ${marker}\nELECTRON_RUN_AS_NODE=1; export ELECTRON_RUN_AS_NODE\nexec ${quote(options.executable)} ${quote(cli)} "$@"\n`;
}

function startupBlock(bin: string): string {
  return `${begin}\n_vv_rest=$PATH\n_vv_path=\n_vv_first=1\nwhile :; do\n  case $_vv_rest in *:*) _vv_part=\${_vv_rest%%:*}; _vv_rest=\${_vv_rest#*:}; _vv_more=1 ;; *) _vv_part=$_vv_rest; _vv_more=0 ;; esac\n  if [ "$_vv_part" != ${quote(bin)} ]; then\n    if [ "$_vv_first" = 1 ]; then _vv_path=$_vv_part; _vv_first=0; else _vv_path=$_vv_path:$_vv_part; fi\n  fi\n  [ "$_vv_more" = 0 ] && break\ndone\nPATH=${quote(bin)}\${_vv_path:+:$_vv_path}; export PATH\nunset _vv_rest _vv_path _vv_first _vv_part _vv_more\n${end}\n`;
}

async function regularText(path: string): Promise<string | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`不是普通文件，未覆盖：${path}`);
    return await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

async function startupPaths(options: CliRegistrationOptions): Promise<string[]> {
  const zsh = options.zdotdir ?? options.home;
  let bash = '.profile';
  for (const candidate of ['.bash_profile', '.bash_login', '.profile']) {
    try { await lstat(join(options.home, candidate)); bash = candidate; break; }
    catch (error) { if (!missing(error)) throw error; }
  }
  return [join(zsh, '.zshrc'), join(zsh, '.zprofile'), join(options.home, bash), join(options.home, '.bashrc')];
}

function updatedStartup(before: string, bin: string, path: string): string {
  const start = before.indexOf(begin);
  const finish = before.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error(`CLI PATH 标记不完整：${path}`);
  const without = start < 0 ? before : before.slice(0, start) + before.slice(finish + end.length).replace(/^\n/, '');
  return `${without}${without && !without.endsWith('\n') ? '\n' : ''}${startupBlock(bin)}`;
}

async function validateDistribution(options: CliRegistrationOptions, cli: string): Promise<void> {
  if (!options.packaged) throw new Error('开发版本无法注册命令行工具。');
  if (options.platform !== 'darwin' && options.platform !== 'win32') throw new Error(`不支持的平台：${options.platform}`);
  if (classifyDistribution(join(options.resources, 'daemon')).kind !== 'bundled') throw new Error('桌面版未包含有效的 Vonvon Bot 命令行分发。');
  if (!(await stat(options.executable)).isFile() || !(await stat(cli)).isFile()) throw new Error('桌面命令行程序不是普通文件。');
}

async function registryPath(): Promise<WindowsPath> {
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($null -eq $k -or $k.GetValueNames() -notcontains 'Path') { '{"exists":false}' } else { $v=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=$k.GetValueKind('Path').ToString(); [pscustomobject]@{exists=$true;value=$v;kind=$kind} | ConvertTo-Json -Compress }`;
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || !('exists' in value)) throw new Error('无法读取用户 PATH。');
  if (value.exists === false) return { value: '', type: 'REG_EXPAND_SZ' };
  if (value.exists !== true || !('value' in value) || typeof value.value !== 'string' ||
      !('kind' in value) || (value.kind !== 'String' && value.kind !== 'ExpandString'))
    throw new Error('用户 PATH 类型不受支持。');
  return { value: value.value, type: value.kind === 'String' ? 'REG_SZ' : 'REG_EXPAND_SZ' };
}

async function writeRegistryPath(value: string, type: WindowsPath['type']): Promise<void> {
  await exec('reg.exe', ['add', 'HKCU\\Environment', '/v', 'Path', '/t', type, '/d', value, '/f'], { windowsHide: true });
  const broadcast = `Add-Type -Namespace Win32 -Name Environment -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, string lParam, int flags, int timeout, out IntPtr result);'; $r=[IntPtr]::Zero; [void][Win32.Environment]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,5000,[ref]$r)`;
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', broadcast], { windowsHide: true });
}
const nativeWindowsPath: WindowsPathStore = { read: registryPath, write: writeRegistryPath };

export async function observeCli(options: CliRegistrationOptions): Promise<CliRegistration> {
  try {
    const { bin, wrapper, cli } = location(options);
    await validateDistribution(options, cli);
    const actual = await regularText(wrapper);
    if (actual !== wrapperBody(options, cli)) throw new Error(actual === undefined ? '命令行工具尚未注册。' : `现有命令行入口不属于当前桌面版：${wrapper}`);
    if (options.platform === 'darwin') {
      const info = await lstat(wrapper);
      if ((info.mode & 0o111) === 0) throw new Error('命令行入口没有执行权限。');
      for (const path of await startupPaths(options)) {
        const content = await regularText(path);
        if (content === undefined || !content.includes(startupBlock(bin))) throw new Error(`终端 PATH 尚未注册：${path}`);
      }
    } else {
      const current = await (options.windowsPath ?? nativeWindowsPath).read();
      if (current.value.split(';')[0].toLowerCase() !== bin.toLowerCase()) throw new Error('用户 PATH 尚未注册命令行目录。');
    }
    return { kind: 'ready', bin, message: '命令行工具已安装。请打开新的终端使用 vonvon。' };
  } catch (error) { return { kind: 'error', message: errorMessage(error) }; }
}

export async function registerCli(options: CliRegistrationOptions): Promise<CliRegistration> {
  try {
    const { bin, wrapper, cli } = location(options);
    await validateDistribution(options, cli);
    const body = wrapperBody(options, cli);
    const prior = await regularText(wrapper);
    if (prior !== undefined && !prior.includes(marker)) throw new Error(`发现其他程序的文件，未覆盖：${wrapper}`);
    const startup = options.platform === 'darwin'
      ? await Promise.all((await startupPaths(options)).map(async path => ({ path, before: await regularText(path) ?? '' })))
      : [];
    const updates = startup.map(({ path, before }) => ({ path, before, after: updatedStartup(before, bin, path) }));
    await mkdir(bin, { recursive: true });
    if (prior !== body) {
      const temporary = `${wrapper}.${process.pid}.tmp`;
      try { await writeFile(temporary, body, { flag: 'wx', mode: options.platform === 'darwin' ? 0o755 : 0o644 }); await rename(temporary, wrapper); }
      finally { await rm(temporary, { force: true }); }
    }
    if (options.platform === 'darwin') {
      await chmod(wrapper, 0o755);
      for (const { path, before, after } of updates) if (after !== before) await writeFile(path, after);
    } else {
      const store = options.windowsPath ?? nativeWindowsPath;
      const current = await store.read();
      const other = current.value.split(';').filter(entry => entry.toLowerCase() !== bin.toLowerCase()).join(';');
      const next = `${bin}${other ? `;${other}` : ''}`;
      if (next !== current.value) await store.write(next, current.type);
    }
    return await observeCli(options);
  } catch (error) { return { kind: 'error', message: errorMessage(error) }; }
}

export function desktopCliOptions(options: Pick<CliRegistrationOptions, 'platform' | 'executable' | 'resources' | 'packaged'>): CliRegistrationOptions {
  const home = homedir();
  const zdotdir = process.env.ZDOTDIR;
  const localAppData = process.env.LOCALAPPDATA;
  return { ...options, home,
    ...(options.platform === 'darwin' && zdotdir && isAbsolute(zdotdir) ? { zdotdir } : {}),
    ...(options.platform === 'win32' && localAppData && isAbsolute(localAppData) ? { localAppData } : {}) };
}
