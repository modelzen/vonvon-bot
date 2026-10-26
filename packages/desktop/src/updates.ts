import {z} from 'zod';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {dirname} from 'node:path';
import type {DesktopUpdate} from '@vonvon/protocol';

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
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  beforeInstall?:()=>Promise<void>;
  statePath?:string;
}
/** 清单里没认识的字段一律忽略，以后加字段（说明、最低系统版本……）不会让已发出的版本解析失败；必需的两项和下面的同源检查照旧。 */
const manifestSchema = z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),feedURL:z.string().url()});
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
  private result(state:DesktopUpdate['state'],message:string,latest=this.latest):DesktopUpdate { return {state,current:this.options.current,latest,message}; }
  /** 打包版、配置了更新地址并通过签名校验：只有这时才有东西可查，自动检查也只在这时开。 */
  get enabled():boolean { return this.options.signed && Boolean(this.options.manifestURL); }
  /** 正在下载：这时不再发起自动检查。 */
  get busy():boolean { return this.pending !== undefined; }
  /**
   * 上次点了"安装并重启"记下的预期版本。当前版本已经到了（或记录读不懂）就删掉记录，
   * 否则一次没装成功的更新会让以后每次检查都被拦住。返回仍未生效的预期版本。
   */
  private async unsettledInstall():Promise<string|undefined> {
    const path = this.options.statePath;
    if (!path) return undefined;
    const raw = await readFile(path,'utf8').catch(()=>undefined);
    if (raw === undefined) return undefined;
    const expected = raw.trim();
    if (/^\d+\.\d+\.\d+$/.test(expected) && isNewer(expected,this.options.current)) return expected;
    await rm(path,{force:true}).catch(()=>{});
    return undefined;
  }
  /** 启动时调用一次，把已经过期的预期版本记录清掉。 */
  async settleInstallState():Promise<void> { await this.unsettledInstall(); }
  /** 用户选了"重试"：忘掉上次没生效的安装，重新检查。 */
  async retry():Promise<DesktopUpdate> {
    if (this.options.statePath) await rm(this.options.statePath,{force:true});
    return this.check();
  }
  async check():Promise<DesktopUpdate> {
    if (this.downloadedVersion) return this.result('downloaded','更新已下载，点击安装并重启');
    this.feedURL = undefined;
    const expected = await this.unsettledInstall();
    if (expected) return this.result('install-pending',`上次安装尚未生效，预期 ${expected}，当前 ${this.options.current}`,expected);
    if (!this.options.signed || !this.options.manifestURL) return this.result('unavailable','此预览版没有配置签名更新源。桌面版本和内置 Core 保持不变。');
    const source = new URL(this.options.manifestURL);
    if (source.protocol !== 'https:') throw new Error('桌面更新源必须使用 HTTPS');
    const response = await (this.options.fetch ?? fetch)(source.href,{signal:AbortSignal.timeout(15000),redirect:'error'});
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

export interface UpdateScheduleOptions {
  firstDelayMs?:number;
  intervalMs?:number;
  /** 每次再多等 0 到这么久，免得所有人在同一时刻查。 */
  jitterMs?:number;
  /** 检查失败（比如没联网）后多久再试。 */
  retryMs?:number;
  random?:()=>number;
  setTimer?:(callback:()=>void,ms:number)=>unknown;
  clearTimer?:(timer:unknown)=>void;
}
/**
 * 启动约 60 秒后查一次，之后每 24 小时（加最多 1 小时随机延迟）查一次，只查不装；失败的检查 1 小时后再试。
 * 返回的函数取消还没触发的定时器，退出时调用。
 */
export function scheduleUpdateChecks(updater:{check():Promise<DesktopUpdate>;readonly busy:boolean},onResult:(update:DesktopUpdate)=>void,options:UpdateScheduleOptions={}):()=>void {
  const hour = 60*60*1000;
  const random = options.random ?? Math.random;
  const set = options.setTimer ?? ((callback,ms)=>{const timer = setTimeout(callback,ms);timer.unref();return timer;});
  const clear = options.clearTimer ?? (timer=>{clearTimeout(timer as NodeJS.Timeout);});
  let timer:unknown;
  let stopped = false;
  const arm = (ms:number) => {timer = set(()=>{void run();},ms);};
  const run = async () => {
    timer = undefined;
    let next = (options.intervalMs ?? 24*hour) + random()*(options.jitterMs ?? hour);
    if (!updater.busy) {
      let update:DesktopUpdate|undefined;
      try {update = await updater.check();} catch {next = (options.retryMs ?? hour) + random()*(options.jitterMs ?? hour);}
      if (update && !stopped) try {onResult(update);} catch {/* 提示失败不影响下一次检查 */}
    }
    if (!stopped) arm(next);
  };
  arm(options.firstDelayMs ?? 60*1000);
  return () => {stopped = true;if (timer !== undefined) clear(timer);timer = undefined;};
}
