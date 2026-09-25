import {z} from 'zod';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {DesktopUpdate} from '../shared/machine';

export interface NativeUpdateDriver {
  setFeedURL(options:{url:string}):void;
  checkForUpdates():void;
  quitAndInstall():void;
  on(event:string,listener:(...args:unknown[])=>void):unknown;
  removeListener(event:string,listener:(...args:unknown[])=>void):unknown;
}
export interface DesktopUpdateOptions {
  current:string;
  manifestURL?:string;
  signed:boolean;
  driver:NativeUpdateDriver;
  fetch?:typeof fetch;
  beforeInstall?:()=>Promise<void>;
  statePath?:string;
}
const manifestSchema = z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),feedURL:z.string().url()}).strict();
function versionParts(version:string):number[] { return version.split('.').map(Number); }
function isNewer(latest:string,current:string):boolean {
  const a = versionParts(latest), b = versionParts(current);
  for(let i=0;i<3;i++) { if(a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0); }
  return false;
}
export class DesktopUpdater {
  private feedURL?:string;
  private latest?:string;
  private downloadedVersion?:string;
  private nativeError = false;
  private pending?:Promise<DesktopUpdate>;
  constructor(private readonly options:DesktopUpdateOptions) {
    options.driver.on('error',()=>{this.nativeError = true;});
  }
  private result(state:DesktopUpdate['state'],message:string):DesktopUpdate { return {state,current:this.options.current,latest:this.latest,message}; }
  async check():Promise<DesktopUpdate> {
    if (this.downloadedVersion) return this.result('downloaded','更新已下载，点击安装并重启');
    this.feedURL = undefined;
    if (this.options.statePath) {
      const expected = await readFile(this.options.statePath,'utf8').catch(()=>undefined);
      if (expected && expected.trim() !== this.options.current) return this.result('unavailable',`上次安装尚未生效，预期 ${expected.trim()}，当前 ${this.options.current}`);
    }
    if (!this.options.signed || !this.options.manifestURL) return this.result('unavailable','此预览版没有配置签名更新源。桌面版本和内置 Core 保持不变。');
    const source = new URL(this.options.manifestURL);
    if (source.protocol !== 'https:') throw new Error('桌面更新源必须使用 HTTPS');
    const response = await (this.options.fetch ?? fetch)(source,{signal:AbortSignal.timeout(15000),redirect:'error'});
    if (!response.ok) throw new Error(`桌面更新检查失败 (${response.status})`);
    const body = await response.text();
    if (body.length > 16384) throw new Error('更新清单过大');
    const manifest = manifestSchema.parse(JSON.parse(body));
    const feed = new URL(manifest.feedURL);
    if (feed.protocol !== 'https:' || feed.origin !== source.origin || feed.username || feed.password) throw new Error('更新源地址不可信');
    this.latest = manifest.version;
    if (!isNewer(manifest.version,this.options.current)) return this.result('current','桌面应用已是最新版本');
    this.feedURL = feed.href;
    return this.result('available','可下载并安装桌面更新，内置 Core 随应用一起更新');
  }
  async install():Promise<DesktopUpdate> {
    if (this.downloadedVersion) {
      await this.options.beforeInstall?.();
      if (this.options.statePath && this.downloadedVersion) {
        await mkdir(dirname(this.options.statePath),{recursive:true});
        await writeFile(this.options.statePath,this.downloadedVersion,{mode:0o600});
      }
      this.options.driver.quitAndInstall();
      return this.result('downloaded','正在安装并重启桌面应用');
    }
    if (this.pending) return this.pending;
    if (!this.feedURL) throw new Error('请先检查桌面更新');
    const driver = this.options.driver;
    this.nativeError = false;
    this.pending = new Promise<DesktopUpdate>((resolve,reject)=>{
      const cleanup = () => {clearTimeout(timer);driver.removeListener('update-downloaded',done);driver.removeListener('error',failed);driver.removeListener('update-not-available',none);};
      const done = () => {cleanup();if (this.nativeError) {reject(new Error('桌面更新未通过原生校验'));return;}this.downloadedVersion = this.latest;resolve(this.result('downloaded','更新已下载并通过原生签名校验，点击安装并重启'));};
      const failed = () => {cleanup();reject(new Error('桌面更新下载或签名校验失败'));};
      const none = () => {cleanup();resolve(this.result('current','更新源中没有可用的桌面安装包'));};
      const timer = setTimeout(()=>{cleanup();reject(new Error('桌面更新下载超时'));},10*60*1000);
      driver.on('update-downloaded',done);driver.on('error',failed);driver.on('update-not-available',none);
      try {driver.setFeedURL({url:this.feedURL!});driver.checkForUpdates();} catch {failed();}
    }).finally(()=>{this.pending = undefined;});
    return this.pending;
  }
}
