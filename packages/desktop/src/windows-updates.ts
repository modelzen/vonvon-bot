import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {GenericProvider} from 'electron-updater/out/providers/GenericProvider.js';
import type {ProviderRuntimeOptions} from 'electron-updater/out/providers/Provider.js';
import type {AppUpdater} from 'electron-updater';
import {normalizeWindowsPublicKey,verifyWindowsUpdate,type WindowsUpdateManifest} from './windows-update-manifest.mjs';
import type {DesktopUpdate} from '@vonvon/protocol';
import {DesktopUpdateError} from './updates.js';
import {NsisUpdater} from 'electron-updater';

export const WINDOWS_UPDATE_URL = 'https://dl.vonvon.cc/bot/windows/stable/';
const newer = (a:string,b:string):boolean => { const x=a.split('.').map(Number),y=b.split('.').map(Number);for(let i=0;i<3;i++){if(x[i]!==y[i])return x[i]!>y[i]!;}return false; };
const version = (value:unknown):value is string => typeof value==='string' && /^\d+\.\d+\.\d+$/.test(value);
export interface WindowsUpdateDriver {
  autoDownload:boolean;autoInstallOnAppQuit:boolean;allowPrerelease:boolean;disableWebInstaller:boolean;
  checkForUpdates():Promise<{isUpdateAvailable:boolean;updateInfo:{version:string;files:Array<{url:string;sha512:string;size?:number}>;packages?:unknown;signedUpdate?:unknown}}|null>;
  downloadUpdate():Promise<string[]>;
  quitAndInstall(isSilent?:boolean,isForceRunAfter?:boolean):void;
  on(event:string,listener:(...args:unknown[])=>void):unknown;
}
export function allowedWindowsUpdateRequest(value:string):boolean {
  try {const url=new URL(value);return url.origin==='https://dl.vonvon.cc'&&url.pathname.startsWith('/bot/windows/')&&!url.username&&!url.password;}catch{return false;}
}
const guardedRangeExecutors=new WeakSet<object>();
/** electron-updater 6.8.11 rejects a failed single range but still pipes its body and advances to the next COPY.
 * Report that HTTP error through the request instead, before the differential callback can touch the failed response.
 * The updater retains its ordinary full-download fallback and final integrity checks. */
export function rejectFailedWindowsRanges(executor:Pick<ProviderRuntimeOptions['executor'],'createRequest'>):void {
  if(guardedRangeExecutors.has(executor))return;
  guardedRangeExecutors.add(executor);
  const createRequest=executor.createRequest.bind(executor);
  executor.createRequest=(options,callback)=>{
    const range=Object.entries(options.headers??{}).some(([key,value])=>key.toLowerCase()==='range'&&Boolean(value));
    if(!range)return createRequest(options,callback);
    let failed=false;
    const request=createRequest(options,response=>{
      if(failed)return;
      if((response.statusCode??0)<400)return callback(response);
      failed=true;
      // Aborting can emit a response error; this response deliberately has no downloader listeners.
      response.on('error',()=>{});
      try {request.emit('error',new Error(`Differential update request failed: HTTP ${response.statusCode}`));}
      finally {request.abort();}
    });
    return request;
  };
}
/** The provider returns only metadata decoded from a verified, architecture-specific envelope. */
export function createWindowsUpdateDriver(publicKey?:string,architecture=process.arch):NsisUpdater {
  class SignedProvider extends GenericProvider {
    constructor(_config:unknown,updater:AppUpdater,runtime:ProviderRuntimeOptions) {
      // COS/CDN may reject multipart Range or return only its first range.
      // Keep differential downloads, but fetch each changed range separately.
      super({provider:'generic',url:WINDOWS_UPDATE_URL},updater,{...runtime,isUseMultipleRangeRequest:false});
      rejectFailedWindowsRanges(runtime.executor);
    }
    override async getLatestVersion() {
      if(!publicKey||!['x64','arm64'].includes(architecture))throw Error('Windows update trust is not configured');
      const raw=await this.httpRequest(new URL(`${architecture}/update.json`,WINDOWS_UPDATE_URL));
      if(!raw||raw.length>32768)throw Error('Invalid Windows update manifest size');
      const signedUpdate:unknown=JSON.parse(raw),payload=verifyWindowsUpdate(signedUpdate,publicKey,architecture);
      return {version:payload.version,path:payload.url,sha512:payload.sha512,releaseDate:'1970-01-01T00:00:00.000Z',releaseNotes:payload.notes,
        files:[{url:payload.url,sha512:payload.sha512,size:payload.size}],signedUpdate};
    }
  }
  const driver=new NsisUpdater({provider:'custom',updateProvider:SignedProvider});
  // Bind every update to this running installation, including later relaunches
  // whose registry or shell context differs. NsisUpdater passes this as /D last.
  driver.installDirectory=dirname(process.execPath);
  // Includes redirects and range requests made by the updater, on its own partition.
  driver.netSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>callback({cancel:!allowedWindowsUpdateRequest(details.url)}));
  return driver;
}
export async function windowsUpdateConfiguration(options:{appPath:string;isPackaged:boolean}):Promise<{publicKey?:string}> {
  if(!options.isPackaged)return {};
  try {
    const config=JSON.parse(await readFile(join(options.appPath,'dist','windows-update-config.json'),'utf8'));
    if(!config||Object.keys(config).length!==1)return {};
    return {publicKey:normalizeWindowsPublicKey(config.publicKey)};
  }catch{return {};}
}
/** Verify the final EXE, including one reconstructed by differential download. */
export async function verifyWindowsInstaller(file:string,manifest:WindowsUpdateManifest):Promise<boolean> {
  try {
    if(!(await stat(file)).isFile()||(await stat(file)).size!==manifest.size)return false;
    const hash=createHash('sha512');for await(const chunk of createReadStream(file))hash.update(chunk);
    return hash.digest('base64')===manifest.sha512;
  }catch{return false;}
}
/** NSIS uses electron-updater, independently of macOS's Squirrel feed. */
export class WindowsDesktopUpdater {
  private latest?:string;private availableVersion?:string;private manifest?:WindowsUpdateManifest;private progress?:DesktopUpdate['downloadProgress'];private downloaded?:string;private downloadedPath?:string;private checking?:Promise<DesktopUpdate>;private downloading?:Promise<DesktopUpdate>;private installing?:Promise<DesktopUpdate>;
  constructor(private readonly options:{current:string;publicKey?:string;architecture?:string;driver:WindowsUpdateDriver;beforeInstall?:()=>Promise<void>;statePath?:string;onUpdate?:(update:DesktopUpdate)=>void;verify?:(file:string,manifest:WindowsUpdateManifest)=>Promise<boolean>}) {
    options.driver.autoDownload=false;options.driver.autoInstallOnAppQuit=false;options.driver.allowPrerelease=false;options.driver.disableWebInstaller=true;
    // electron-updater emits error as well as rejecting its promises.
    options.driver.on('error',()=>{});
    options.driver.on('download-progress',value=>{
      const p=value as {percent?:number;transferred?:number;total?:number};
      if(!this.downloading||!p||![p.percent,p.transferred,p.total].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))return;
      this.progress={percent:Math.min(100,p.percent!),transferred:p.transferred!,total:p.total!};
      this.options.onUpdate?.(this.result('available','正在下载更新'));
    });
  }
  get enabled():boolean{return Boolean(this.options.publicKey)&&['x64','arm64'].includes(this.options.architecture??process.arch);}
  get busy():boolean{return Boolean(this.downloading||this.installing);}
  private result(state:DesktopUpdate['state'],message:string):DesktopUpdate{return {state,current:this.options.current,latest:this.latest,message,releaseNotes:this.manifest?.notes,...(this.progress?{downloadProgress:this.progress}:{})};}
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
    if(this.downloaded)return Promise.resolve(this.result('downloaded','更新已下载，点击重启升级'));
    return this.checking ??= this.lookUp().finally(()=>{this.checking=undefined;});
  }
  private async lookUp():Promise<DesktopUpdate>{
    this.availableVersion=undefined;this.manifest=undefined;this.progress=undefined;
    const expected=await this.expected();
    const pending=():DesktopUpdate=>({...this.result('install-pending',`上次安装尚未生效，预期 ${expected}，当前 ${this.options.current}`),latest:expected});
    if(!this.enabled)return expected?pending():this.result('unavailable','这个安装包没有配置可信更新源，请到官网下载新版本：https://vonvon.cc/get/');
    try {
      const found=await this.options.driver.checkForUpdates();if(!found)throw Error('No update response');
      const info=found.updateInfo;if(!version(info.version))throw Error('Invalid update version');
      if(!found.isUpdateAvailable){this.latest=info.version;return expected?pending():this.result('current','当前没有适用的桌面更新');}
      const manifest=verifyWindowsUpdate(info.signedUpdate,this.options.publicKey!,this.options.architecture??process.arch);
      const file=info.files[0];
      if(info.packages!==undefined||info.files.length!==1||info.version!==manifest.version||file?.url!==manifest.url||file.sha512!==manifest.sha512||file.size!==manifest.size)throw Error('Update metadata differs from signed manifest');
      this.manifest=manifest;
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
        if(!this.downloadedPath||!await (this.options.verify ?? verifyWindowsInstaller)(this.downloadedPath,this.manifest!))throw new DesktopUpdateError('桌面更新未通过签名校验');
        // Persist before shutdown: an unwritable state directory must not stop the daemon.
        if(this.options.statePath){await mkdir(dirname(this.options.statePath),{recursive:true});await writeFile(this.options.statePath,this.downloaded!,{mode:0o600});}
        try {await this.options.beforeInstall?.();this.options.driver.quitAndInstall(false,true);}
        catch(error){if(this.options.statePath)await rm(this.options.statePath,{force:true}).catch(()=>{});throw error;}
        return this.result('downloaded','正在重启升级桌面应用');
      })().finally(()=>{this.installing=undefined;});return this.installing;
    }
    if(this.downloading)return this.downloading;
    if(!this.enabled||!this.availableVersion)throw new DesktopUpdateError('请先检查桌面更新');
    const latest=this.availableVersion;const manifest=this.manifest!;
    this.downloading=(async()=>{
      try{const paths=await this.options.driver.downloadUpdate();const file=paths.find(path=>path.toLowerCase().endsWith('.exe'));if(!file||!await (this.options.verify ?? verifyWindowsInstaller)(file,manifest))throw Error('Publisher verification failed');this.downloaded=latest;this.downloadedPath=file;this.progress=undefined;return this.result('downloaded','更新已下载并通过发布签名及完整性校验，点击重启升级');}
      catch(cause){throw new DesktopUpdateError('桌面更新下载或签名校验失败',{cause});}
    })().finally(()=>{this.downloading=undefined;});return this.downloading;
  }
}
