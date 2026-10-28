import {execFile} from 'node:child_process';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {promisify} from 'node:util';
import type {DesktopUpdate} from '@vonvon/protocol';
import {DesktopUpdateError} from './updates.js';
import {NsisUpdater} from 'electron-updater';

export const WINDOWS_UPDATE_URL = 'https://dl.vonvon.cc/bot/windows/stable/';
const exec = promisify(execFile);
const newer = (a:string,b:string):boolean => { const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]!>y[i]!;}return false; };
const version = (value:unknown):value is string => typeof value==='string' && /^\d+\.\d+\.\d+$/.test(value);
export interface WindowsUpdateDriver {
  autoDownload:boolean;autoInstallOnAppQuit:boolean;allowPrerelease:boolean;disableWebInstaller:boolean;
  checkForUpdates():Promise<{isUpdateAvailable:boolean;updateInfo:{version:string;files:Array<{url:string;sha512:string}>;packages?:unknown}}|null>;
  downloadUpdate():Promise<string[]>;
  quitAndInstall(isSilent?:boolean,isForceRunAfter?:boolean):void;
  on(event:string,listener:(...args:unknown[])=>void):unknown;
}
export function allowedWindowsUpdateRequest(value:string):boolean {
  try {const url=new URL(value);return url.origin==='https://dl.vonvon.cc'&&url.pathname.startsWith('/bot/windows/')&&!url.username&&!url.password;}catch{return false;}
}
export function createWindowsUpdateDriver():NsisUpdater {
  const driver=new NsisUpdater({provider:'generic',url:WINDOWS_UPDATE_URL});
  // This is the updater's own Electron partition. The hook also sees redirect destinations.
  driver.netSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>callback({cancel:!allowedWindowsUpdateRequest(details.url)}));
  return driver;
}
/** Strict Authenticode verification; subprocess/JSON failures never turn into success. */
export async function verifyWindowsPublisher(file:string,publisher:string):Promise<boolean> {
  try {
    const powershell=join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const script='$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature -LiteralPath $env:VONVON_UPDATE_EXECUTABLE; @{valid=($s.Status -eq "Valid"); publisher=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{""}} | ConvertTo-Json -Compress';
    const {stdout}=await exec(powershell,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000,maxBuffer:4096,env:{...process.env,VONVON_UPDATE_EXECUTABLE:file}});
    const result=JSON.parse(stdout);return result.valid===true && result.publisher===publisher;
  } catch {return false;}
}
export async function windowsUpdateConfiguration(options:{appPath:string;isPackaged:boolean;executable?:string;verify?:(file:string,publisher:string)=>Promise<boolean>}):Promise<{signed:boolean;publisherName?:string}> {
  if(!options.isPackaged)return {signed:false};
  try {
    const config=JSON.parse(await readFile(join(options.appPath,'dist','windows-update-config.json'),'utf8'));
    if(Object.keys(config).length!==1 || typeof config.publisherName!=='string' || !config.publisherName.trim() || config.publisherName!==config.publisherName.trim() || /[\x00-\x1f]/.test(config.publisherName))return {signed:false};
    if(!await (options.verify ?? verifyWindowsPublisher)(options.executable ?? process.execPath,config.publisherName))return {signed:false};
    return {signed:true,publisherName:config.publisherName};
  }catch{return {signed:false};}
}
/** NSIS uses electron-updater, independently of macOS's Squirrel feed. */
export class WindowsDesktopUpdater {
  private latest?:string;private availableVersion?:string;private downloaded?:string;private downloadedPath?:string;private checking?:Promise<DesktopUpdate>;private downloading?:Promise<DesktopUpdate>;private installing?:Promise<DesktopUpdate>;
  constructor(private readonly options:{current:string;signed:boolean;publisherName?:string;driver:WindowsUpdateDriver;beforeInstall?:()=>Promise<void>;statePath?:string;verify?:(file:string,publisher:string)=>Promise<boolean>}) {
    options.driver.autoDownload=false;options.driver.autoInstallOnAppQuit=false;options.driver.allowPrerelease=false;options.driver.disableWebInstaller=true;
    // electron-updater emits error as well as rejecting its promises.
    options.driver.on('error',()=>{});
  }
  get enabled():boolean{return this.options.signed && Boolean(this.options.publisherName);}
  get busy():boolean{return Boolean(this.downloading||this.installing);}
  private result(state:DesktopUpdate['state'],message:string):DesktopUpdate{return {state,current:this.options.current,latest:this.latest,message};}
  private async expected():Promise<string|undefined>{
    if(!this.options.statePath)return;
    const value=(await readFile(this.options.statePath,'utf8').catch(()=>'')).trim();
    if(version(value)&&newer(value,this.options.current))return value;
    await rm(this.options.statePath,{force:true});
  }
  async settleInstallState():Promise<void>{await this.expected();}
  async retry():Promise<DesktopUpdate>{if(this.options.statePath)await rm(this.options.statePath,{force:true});await this.checking?.catch(()=>{});return this.check();}
  check():Promise<DesktopUpdate>{
    if(this.installing)return this.installing;
    if(this.downloading)return this.downloading;
    if(this.downloaded)return Promise.resolve(this.result('downloaded','更新已下载，点击安装并重启'));
    return this.checking ??= this.lookUp().finally(()=>{this.checking=undefined;});
  }
  private async lookUp():Promise<DesktopUpdate>{
    this.availableVersion=undefined;
    const expected=await this.expected();
    const pending=():DesktopUpdate=>({...this.result('install-pending',`上次安装尚未生效，预期 ${expected}，当前 ${this.options.current}`),latest:expected});
    if(!this.enabled)return expected?pending():this.result('unavailable','这个安装包没有可用的签名更新源，请到官网下载新版本：https://vonvon.cc/get/');
    try {
      const found=await this.options.driver.checkForUpdates();if(!found)throw Error('No update response');
      const info=found.updateInfo;if(!version(info.version))throw Error('Invalid update version');
      if(!found.isUpdateAvailable){this.latest=info.version;return expected?pending():this.result('current','当前没有适用的桌面更新');}
      if(info.packages!==undefined)throw Error('Web installer packages are not supported');
      // Metadata may not point the downloader at another origin or another product's path.
      for(const file of info.files){const url=new URL(file.url,WINDOWS_UPDATE_URL);if(url.origin!=='https://dl.vonvon.cc'||!url.pathname.startsWith('/bot/windows/')||url.username||url.password||url.search||url.hash||!file.sha512)throw Error('Untrusted update artifact');}
      if(!info.files.some(file=>new URL(file.url,WINDOWS_UPDATE_URL).pathname.endsWith('.exe')))throw Error('No NSIS installer');
      this.latest=info.version;
      if(expected&&!newer(info.version,expected))return pending();
      if(newer(info.version,this.options.current))this.availableVersion=info.version;
      return newer(info.version,this.options.current)?this.result('available','可下载并安装桌面更新，内置 Core 随应用一起更新'):this.result('current','桌面应用已是最新版本');
    }catch(cause){if(expected)return pending();throw new DesktopUpdateError('检查桌面更新失败，请检查网络或稍后重试。',{cause});}
  }
  async install():Promise<DesktopUpdate>{
    if(this.installing)return this.installing;
    if(this.downloaded){
      this.installing=(async()=>{
        if(!this.downloadedPath||!await (this.options.verify ?? verifyWindowsPublisher)(this.downloadedPath,this.options.publisherName!))throw new DesktopUpdateError('桌面更新未通过签名校验');
        // Persist before shutdown: an unwritable state directory must not stop the daemon.
        if(this.options.statePath){await mkdir(dirname(this.options.statePath),{recursive:true});await writeFile(this.options.statePath,this.downloaded!,{mode:0o600});}
        try {await this.options.beforeInstall?.();this.options.driver.quitAndInstall(false,true);}
        catch(error){if(this.options.statePath)await rm(this.options.statePath,{force:true}).catch(()=>{});throw error;}
        return this.result('downloaded','正在安装并重启桌面应用');
      })().finally(()=>{this.installing=undefined;});return this.installing;
    }
    if(this.downloading)return this.downloading;
    if(!this.enabled||!this.availableVersion)throw new DesktopUpdateError('请先检查桌面更新');
    const latest=this.availableVersion;
    this.downloading=(async()=>{
      try{const paths=await this.options.driver.downloadUpdate();const file=paths.find(path=>path.toLowerCase().endsWith('.exe'));if(!file||!await (this.options.verify ?? verifyWindowsPublisher)(file,this.options.publisherName!))throw Error('Publisher verification failed');this.downloaded=latest;this.downloadedPath=file;return this.result('downloaded','更新已下载并通过签名校验，点击安装并重启');}
      catch(cause){throw new DesktopUpdateError('桌面更新下载或签名校验失败',{cause});}
    })().finally(()=>{this.downloading=undefined;});return this.downloading;
  }
}
