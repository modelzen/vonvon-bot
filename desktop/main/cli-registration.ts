import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {chmod, lstat, mkdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname, join, isAbsolute} from 'node:path';

const exec = promisify(execFile);
const names = ['vonvon-bot', 'vonvon-bridge', 'feishu-codex-bridge'] as const;
const marker = 'Vonvon Bridge managed CLI v1';
const begin = '# >>> Vonvon Bridge CLI >>>';
const end = '# <<< Vonvon Bridge CLI <<<';
export type Registration = {kind:'ready'; bin:string; message:string} | {kind:'error'; message:string};
export type CliScope = 'user'|'system';
type RegistryPath = {value:string;type:'REG_SZ'|'REG_EXPAND_SZ'};
export interface WindowsPathStore {read():Promise<RegistryPath>;write(value:string,type:RegistryPath['type']):Promise<void>}
export interface CliRegistrationOptions {
  platform:'darwin'|'win32';
  scope:CliScope;
  runtime:string;
  home?:string;
  zdotdir?:string;
  systemRoot?:string;
  localAppData?:string;
  windowsPath?:WindowsPathStore;
}

function shellQuote(value:string):string {return `'${value.replaceAll("'", "'\\''")}'`;}
function cmdValue(value:string):string {return value.replaceAll('%','%%');}
function paths(options:CliRegistrationOptions) {
  const node = join(options.runtime,'node',options.platform==='win32'?'node.exe':'bin/node');
  const npm = join(options.runtime,'node',options.platform==='win32'?'node_modules/npm/bin/npm-cli.js':'lib/node_modules/npm/bin/npm-cli.js');
  const cli = join(options.runtime,'core','bin','feishu-codex-bridge.mjs');
  const bin = options.platform==='win32'
    ? join(options.localAppData??(process.env.LOCALAPPDATA&&isAbsolute(process.env.LOCALAPPDATA)?process.env.LOCALAPPDATA:join(options.home??homedir(),'AppData','Local')),'Vonvon Bridge','bin')
    : options.scope==='system'
      ? join(options.systemRoot??'/','usr','local','lib','vonvon-bridge','bin')
      : join(options.home??homedir(),'.local','share','vonvon-bridge','bin');
  return {node,npm,cli,bin};
}

async function writeOwned(path:string, content:string, executable=false):Promise<void> {
  let existing:string|undefined;
  try {const info=await lstat(path);if(!info.isFile())throw new Error(`不是普通文件，未覆盖：${path}`);}
  catch(error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  try {existing=await readFile(path,'utf8');}
  catch(error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  if (existing!==undefined && !existing.includes(marker)) throw new Error(`发现其他程序的文件，未覆盖：${path}`);
  if (existing!==content) {
    const temporary=`${path}.${process.pid}.tmp`;
    try {await writeFile(temporary,content,{flag:'wx',mode:executable?0o755:0o644});await rename(temporary,path);}
    finally {await rm(temporary,{force:true});}
  }
  if (executable) await chmod(path,0o755);
}

async function removeOwned(path:string,node:string,cli:string,platform:'darwin'|'win32'):Promise<boolean> {
  try {const info=await lstat(path);if(!info.isFile())return false;}
  catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error;}
  let existing:string;
  try {existing=await readFile(path,'utf8');}
  catch(error) {if ((error as NodeJS.ErrnoException).code==='ENOENT') return false;throw error;}
  const owned=existing.includes(marker)&&existing.includes(platform==='win32'?`"${cmdValue(node)}"`:`exec ${shellQuote(node)}`)&&existing.includes(platform==='win32'?`"${cmdValue(cli)}"`:` ${shellQuote(cli)} "$@"`);
  if(owned)await rm(path);
  return owned;
}

async function shellStartup(path:string, bin:string, remove=false):Promise<void> {
  let before='';
  try {before=await readFile(path,'utf8');}
  catch(error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
  const start=before.indexOf(begin);
  const finish=before.indexOf(end);
  if ((start<0)!==(finish<0) || (start>=0 && finish<start)) throw new Error(`CLI PATH 标记不完整：${path}`);
  if (remove && start<0) return;
  const without=start<0?before:before.slice(0,start)+before.slice(finish+end.length).replace(/^\n/,'');
  const block=`${begin}\n_vb_rest=$PATH\n_vb_path=\n_vb_first=1\nwhile :; do\n  case $_vb_rest in *:*) _vb_part=\${_vb_rest%%:*}; _vb_rest=\${_vb_rest#*:}; _vb_more=1 ;; *) _vb_part=$_vb_rest; _vb_more=0 ;; esac\n  if [ "$_vb_part" != ${shellQuote(bin)} ]; then\n    if [ "$_vb_first" = 1 ]; then _vb_path=$_vb_part; _vb_first=0; else _vb_path=$_vb_path:$_vb_part; fi\n  fi\n  [ "$_vb_more" = 0 ] && break\ndone\nPATH=${shellQuote(bin)}\${_vb_path:+:$_vb_path}; export PATH\nunset _vb_rest _vb_path _vb_first _vb_part _vb_more\n${end}\n`;
  const after=remove?without:`${without}${without.endsWith('\n')||!without?'':'\n'}${block}`;
  if (after!==before) await writeFile(path,after);
}

async function registryPath():Promise<{value:string;type:'REG_SZ'|'REG_EXPAND_SZ'}> {
  const command=`[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($null -eq $k -or $k.GetValueNames() -notcontains 'Path') { '{"exists":false}' } else { $v=$k.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=$k.GetValueKind('Path').ToString(); [pscustomobject]@{exists=$true;value=$v;kind=$kind} | ConvertTo-Json -Compress }`;
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true});
  const parsed:unknown=JSON.parse(stdout);
  if (typeof parsed!=='object'||parsed===null||!('exists' in parsed))throw new Error('无法读取用户 PATH 注册表值。');
  if(parsed.exists===false)return {type:'REG_EXPAND_SZ',value:''};
  if(parsed.exists!==true||!('value' in parsed)||typeof parsed.value!=='string'||!('kind' in parsed)||(parsed.kind!=='String'&&parsed.kind!=='ExpandString'))
    throw new Error('用户 PATH 注册表值类型不受支持，未修改。');
  return {type:parsed.kind==='ExpandString'?'REG_EXPAND_SZ':'REG_SZ',value:parsed.value};
}

async function setRegistryPath(value:string,type:'REG_SZ'|'REG_EXPAND_SZ'):Promise<void> {
  await exec('reg.exe',['add','HKCU\\Environment','/v','Path','/t',type,'/d',value,'/f'],{windowsHide:true});
  const broadcast=`Add-Type -Namespace Win32 -Name Environment -MemberDefinition '[DllImport("user32.dll", CharSet=CharSet.Auto, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, string lParam, int flags, int timeout, out IntPtr result);'; $r=[IntPtr]::Zero; [void][Win32.Environment]::SendMessageTimeout([IntPtr]0xffff,0x1a,[IntPtr]::Zero,'Environment',2,5000,[ref]$r)`;
  await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',broadcast],{windowsHide:true});
}
const nativeWindowsPath:WindowsPathStore={read:registryPath,write:setRegistryPath};

export async function registerCli(options:CliRegistrationOptions):Promise<Registration> {
  try {
    if (options.platform==='win32' && options.scope==='system') throw new Error('Windows CLI 仅支持当前用户安装。');
    const {node,npm,cli,bin}=paths(options);
    await Promise.all([node,npm,cli].map(path=>stat(path)));
    await mkdir(bin,{recursive:true});
    for (const name of names) {
      const file=join(bin,`${name}${options.platform==='win32'?'.cmd':''}`);
      const body=options.platform==='win32'
        ? `@echo off\r\nrem ${marker}\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\nfor /f "tokens=2 delims=:" %%C in ('chcp') do set "_VB_CP=%%C"\r\nchcp 65001 >nul\r\nif errorlevel 1 exit /b 1\r\nset "VONVON_NPM_CLI=${cmdValue(npm)}"\r\nset "PATH=${cmdValue(dirname(node))};%PATH%"\r\n"${cmdValue(node)}" "${cmdValue(cli)}" %*\r\nset "_VB_EXIT=%ERRORLEVEL%"\r\nif defined _VB_CP chcp %_VB_CP% >nul\r\nexit /b %_VB_EXIT%\r\n`
        : `#!/bin/sh\n# ${marker}\nVONVON_NPM_CLI=${shellQuote(npm)}; export VONVON_NPM_CLI\nPATH=${shellQuote(dirname(node))}:"$PATH"; export PATH\nexec ${shellQuote(node)} ${shellQuote(cli)} "$@"\n`;
      await writeOwned(file,body,options.platform==='darwin');
    }
    if (options.platform==='darwin' && options.scope==='system') {
      const path=join(options.systemRoot??'/','etc','paths.d','vonvon-bridge');
      await mkdir(dirname(path),{recursive:true});
      let current:string|undefined;
      try {const info=await lstat(path);if(!info.isFile())throw new Error(`不是普通文件，未覆盖：${path}`);current=await readFile(path,'utf8');}
      catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      if(current!==undefined && current!==`${bin}\n`)throw new Error(`发现其他程序的 PATH 文件，未覆盖：${path}`);
      if(current===undefined)await writeFile(path,`${bin}\n`,{flag:'wx'});
    } else if (options.platform==='darwin') {
      const userHome=options.home??homedir();
      const zshHome=options.zdotdir??process.env.ZDOTDIR??userHome;
      await shellStartup(join(zshHome,'.zshrc'),bin);
      await shellStartup(join(zshHome,'.zprofile'),bin);
      let bashLogin='.profile';
      for (const candidate of ['.bash_profile','.bash_login','.profile']) {
        try {await stat(join(userHome,candidate));bashLogin=candidate;break;}
        catch(error) {if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
      }
      await shellStartup(join(userHome,bashLogin),bin);
      await shellStartup(join(userHome,'.bashrc'),bin);
    } else {
      const pathStore=options.windowsPath??nativeWindowsPath;
      const current=await pathStore.read();
      const other=current.value.split(';').filter(entry=>entry.toLowerCase()!==bin.toLowerCase()).join(';');
      const next=`${bin}${other?`;${other}`:''}`;
      if(next!==current.value)await pathStore.write(next,current.type);
    }
    return {kind:'ready',bin,message:'命令行工具已安装。请打开新的终端使用 vonvon-bot。'};
  } catch(error) {return {kind:'error',message:error instanceof Error?error.message:String(error)};}
}

export async function removeCli(options:CliRegistrationOptions):Promise<Registration> {
  try {
    const {bin,node,cli}=paths(options);
    const existing=await Promise.all(names.map(async name=>{
      const path=join(bin,`${name}${options.platform==='win32'?'.cmd':''}`);
      try{return await readFile(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}
    }));
    if(existing.some(content=>content!==undefined && (!content.includes(marker)||!content.includes(options.platform==='win32'?`"${cmdValue(node)}"`:`exec ${shellQuote(node)}`)||!content.includes(options.platform==='win32'?`"${cmdValue(cli)}"`:` ${shellQuote(cli)} "$@"`))))
      return {kind:'ready',bin,message:'CLI 已由另一版本的桌面应用管理，保留当前入口。'};
    for (const name of names) await removeOwned(join(bin,`${name}${options.platform==='win32'?'.cmd':''}`),node,cli,options.platform);
    if (options.platform==='darwin' && options.scope==='system')
      {
        const path=join(options.systemRoot??'/','etc','paths.d','vonvon-bridge');
        try {if((await readFile(path,'utf8'))===`${bin}\n`)await rm(path);}
        catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
    else if (options.platform==='darwin') {
      const userHome=options.home??homedir();
      const zshHome=options.zdotdir??process.env.ZDOTDIR??userHome;
      for (const rc of ['.zshrc','.zprofile']) await shellStartup(join(zshHome,rc),bin,true);
      for (const rc of ['.bash_profile','.bash_login','.profile','.bashrc']) await shellStartup(join(userHome,rc),bin,true);
    } else {
      const pathStore=options.windowsPath??nativeWindowsPath;
      const current=await pathStore.read();
      const next=current.value.split(';').filter(entry=>entry.toLowerCase()!==bin.toLowerCase()).join(';');
      if (next!==current.value) await pathStore.write(next,current.type);
    }
    return {kind:'ready',bin,message:'已移除桌面应用管理的 CLI 入口。'};
  } catch(error) {return {kind:'error',message:error instanceof Error?error.message:String(error)};}
}
