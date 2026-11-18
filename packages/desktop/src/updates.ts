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
  architecture?:NodeJS.Architecture;
  manifestURL?:string;
  signed:boolean;
  driver:NativeUpdateDriver;
  fetch?:(url:string,init:RequestInit)=>Promise<Response>;
  beforeInstall?:()=>Promise<void>;
  statePath?:string;
}
/**
 * 可以原样给用户看的更新错误：文字就是中文说明，不带路径、令牌之类的内部细节。
 * 桌面桥只透传这一类；别的异常一律只显示通用提示。
 */
export class DesktopUpdateError extends Error {
  constructor(message:string,options?:ErrorOptions) { super(message,options);this.name = 'DesktopUpdateError'; }
}
/** 清单里没认识的字段一律忽略，以后加字段（说明、最低系统版本……）不会让已发出的版本解析失败；必需的两项和下面的同源检查照旧。 */
const manifestSchema = z.object({version:z.string().regex(/^\d+\.\d+\.\d+$/),feedURL:z.string().url(),feedURLs:z.object({arm64:z.string().url(),x64:z.string().url()}).optional()});
function versionParts(version:string):number[] { return version.split('.').map(Number); }
function isNewer(latest:string,current:string):boolean {
  const a = versionParts(latest), b = versionParts(current);
  for(let i=0;i<3;i++) { if(a[i] !== b[i]) return (a[i] ?? 0) > (b[i] ?? 0); }
  return false;
}
const downloadPage = 'https://vonvon.bot/get/';
interface Lookup { result:DesktopUpdate; latest?:string; feedURL?:string }
export class DesktopUpdater {
  private feedURL?:string;
  private latest?:string;
  private downloadedVersion?:string;
  private nativeError = false;
  private pending?:Promise<DesktopUpdate>;
  private checking?:Promise<DesktopUpdate>;
  constructor(private readonly options:DesktopUpdateOptions) {
    options.driver.on('error',()=>{this.nativeError = true;});
  }
  private result(state:DesktopUpdate['state'],message:string,latest=this.latest):DesktopUpdate { return {state,current:this.options.current,latest,message}; }
  /** 打包版、配置了更新地址并通过签名校验：只有这时才有东西可查，自动检查也只在这时开。 */
  get enabled():boolean { return this.options.signed && Boolean(this.options.manifestURL); }
  /** 正在下载：这时不再发起自动检查。 */
  get busy():boolean { return this.pending !== undefined; }
  /**
   * 上次点了"重启升级"（原来叫"安装并重启"）记下的预期版本。当前版本已经到了（或记录读不懂）就删掉记录，
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
    if (this.options.statePath) {
      try { await rm(this.options.statePath,{force:true}); }
      catch { throw new DesktopUpdateError(`没能清除上次安装的记录，请到官网重新下载安装：${downloadPage}`); }
    }
    // 正在进行的检查可能已经读过旧记录，等它结束再查一次。
    await this.checking?.catch(()=>{});
    return this.check();
  }
  /** 同一时间只查一次：自动检查进行中用户再点"检查更新"，直接用同一次的结果。 */
  check():Promise<DesktopUpdate> {
    if (this.downloadedVersion) return Promise.resolve(this.result('downloaded','更新已下载，点击重启升级'));
    this.checking ??= this.lookUp().then(found=>{
      // 检查期间用户可能已经把更新下载好了：以现在的情况为准，别再让界面提示"下载更新"。
      if (this.downloadedVersion) return this.result('downloaded','更新已下载，点击重启升级');
      // 结果出来后一起改，检查进行中不动 feedURL 和 latest，免得同时点"下载更新"被拒。
      this.latest = found.latest;
      this.feedURL = found.feedURL;
      return found.result;
    }).finally(()=>{this.checking = undefined;});
    return this.checking;
  }
  private async fetchManifest():Promise<{version:string;feedURL:string}> {
    const source = new URL(this.options.manifestURL!);
    if (source.protocol !== 'https:') throw new DesktopUpdateError('桌面更新源必须使用 HTTPS');
    let body:string;
    try {
      const response = await (this.options.fetch ?? fetch)(source.href,{signal:AbortSignal.timeout(15000),redirect:'error'});
      if (!response.ok) throw new DesktopUpdateError(`检查更新失败：更新服务器返回 ${response.status}，请稍后重试。`);
      body = await response.text();
    } catch (error) {
      if (error instanceof DesktopUpdateError) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new DesktopUpdateError(timedOut ? '检查更新超时：更新服务器没有及时回应，请稍后重试。' : '检查更新失败：连不上更新服务器，请检查网络后重试。',{cause:error});
    }
    if (body.length > 16384) throw new DesktopUpdateError('更新清单过大');
    let manifest:z.infer<typeof manifestSchema>;
    try { manifest = manifestSchema.parse(JSON.parse(body)); }
    catch (error) { throw new DesktopUpdateError('更新清单格式不对，请稍后重试。',{cause:error}); }
    const architecture = this.options.architecture ?? process.arch;
    const selected = architecture === 'arm64' || architecture === 'x64' ? manifest.feedURLs?.[architecture] : undefined;
    const feed = new URL(selected ?? manifest.feedURL);
    if (feed.protocol !== 'https:' || feed.origin !== source.origin || feed.username || feed.password) throw new DesktopUpdateError('更新源地址不可信');
    return {version:manifest.version,feedURL:feed.href};
  }
  private async lookUp():Promise<Lookup> {
    const expected = await this.unsettledInstall();
    const stuck = (): Lookup => ({result:this.result('install-pending',`上次安装尚未生效，预期 ${expected}，当前 ${this.options.current}`,expected)});
    if (!this.options.signed || !this.options.manifestURL) {
      if (expected) return stuck();
      return {result:this.result('unavailable','这个安装包没有可用的签名更新源，请到官网下载新版本：'+downloadPage,this.latest)};
    }
    let manifest:{version:string;feedURL:string};
    try { manifest = await this.fetchManifest(); }
    catch (error) {
      // 没联网也要让用户看到"上次没装上"，不然出口只在设置深处。
      if (expected) return stuck();
      throw error;
    }
    // 清单里已经有比预期更新的版本：上次没装上的那个不重要了，直接当有新版本提示。
    if (expected && !isNewer(manifest.version,expected)) return stuck();
    const note = expected ? `；上次安装 ${expected} 没有生效` : '';
    if (!isNewer(manifest.version,this.options.current)) return {latest:manifest.version,result:this.result('current','桌面应用已是最新版本',manifest.version)};
    return {latest:manifest.version,feedURL:manifest.feedURL,result:this.result('available',`可下载并安装桌面更新，内置 Core 随应用一起更新${note}`,manifest.version)};
  }
  async install():Promise<DesktopUpdate> {
    if (this.downloadedVersion) {
      await this.options.beforeInstall?.();
      if (this.options.statePath && this.downloadedVersion) {
        await mkdir(dirname(this.options.statePath),{recursive:true});
        await writeFile(this.options.statePath,this.downloadedVersion,{mode:0o600});
      }
      this.options.driver.quitAndInstall();
      return this.result('downloaded','正在重启升级桌面应用');
    }
    if (this.pending) return this.pending;
    if (!this.feedURL) throw new DesktopUpdateError('请先检查桌面更新');
    const driver = this.options.driver;
    // 下载期间用户或定时器又查了一次，this.latest 可能变；记下的是这次下载开始时点的那个版本。
    const feedURL = this.feedURL, version = this.latest;
    this.nativeError = false;
    this.pending = new Promise<DesktopUpdate>((resolve,reject)=>{
      const cleanup = () => {clearTimeout(timer);driver.removeListener('update-downloaded',done);driver.removeListener('error',failed);driver.removeListener('update-not-available',none);};
      const done = () => {cleanup();if (this.nativeError) {reject(new DesktopUpdateError('桌面更新未通过原生校验'));return;}this.downloadedVersion = version;resolve(this.result('downloaded','更新已下载并通过原生签名校验，点击重启升级',version));};
      const failed = () => {cleanup();reject(new DesktopUpdateError('桌面更新下载或签名校验失败'));};
      const none = () => {cleanup();resolve(this.result('current','更新源中没有可用的桌面安装包'));};
      const timer = setTimeout(()=>{cleanup();reject(new DesktopUpdateError('桌面更新下载超时'));},10*60*1000);
      driver.on('update-downloaded',done);driver.on('error',failed);driver.on('update-not-available',none);
      try {driver.setFeedURL({url:feedURL});driver.checkForUpdates();} catch {failed();}
    }).finally(()=>{this.pending = undefined;});
    return this.pending;
  }
}

export interface UpdateScheduleOptions {
  firstDelayMs?:number;
  intervalMs?:number;
  now?:()=>number;
  /** 平台负责监听唤醒；返回取消监听的函数，随调度器一起清理。 */
  onResume?:(listener:()=>void)=>()=>void;
  setTimer?:(callback:()=>void,ms:number)=>unknown;
  clearTimer?:(timer:unknown)=>void;
}
/**
 * 启动完成 2 分钟后查一次，每轮结束后固定等 90 分钟；失败也继续，不要求用户重启。
 * 只在北京时间 05:00～次日 02:00 自动检查。夜间或下载中跳过本轮，保留各自的计时节奏。
 * 唤醒后只补一次已到期的检查；手动检查不经过此调度器。返回的函数在退出时清理计时和监听。
 */
export function scheduleUpdateChecks(updater:{check():Promise<DesktopUpdate>;readonly busy:boolean},onResult:(update:DesktopUpdate)=>void,options:UpdateScheduleOptions={}):()=>void {
  const hour = 60*60*1000;
  const interval = options.intervalMs ?? 90*60*1000;
  const now = options.now ?? Date.now;
  const set = options.setTimer ?? ((callback,ms)=>{const timer = setTimeout(callback,ms);timer.unref();return timer;});
  const clear = options.clearTimer ?? (timer=>{clearTimeout(timer as NodeJS.Timeout);});
  let timer:unknown;
  let stopped = false;
  let running = false;
  let dueAt:number;
  let generation = 0;
  const arm = (at:number) => {
    dueAt = at;
    const scheduled = ++generation;
    timer = set(()=>{if (scheduled !== generation) return;timer = undefined;void run();},Math.max(0,at-now()));
  };
  const run = async () => {
    // A resume and an already queued timer may arrive together. Only one may check or re-arm.
    if (stopped || running) return;
    if (now() < dueAt) {
      // A system clock correction must not consume the only timer and stop the loop.
      if (timer === undefined) arm(dueAt);
      return;
    }
    ++generation;
    if (timer !== undefined) clear(timer);
    timer = undefined;
    const at = now();
    // Beijing uses UTC+8, independently of the computer's local time zone.
    const beijingHour = new Date(at + 8*hour).getUTCHours();
    if ((beijingHour >= 2 && beijingHour < 5) || updater.busy) {
      // Skip missed slots without replaying them or moving everyone to 05:00.
      arm(dueAt + (Math.floor((at-dueAt)/interval)+1)*interval);
      return;
    }
    running = true;
    try {
      let update:DesktopUpdate|undefined;
      try {update = await updater.check();} catch {/* 网络失败也照常安排下一轮。 */}
      if (update && !stopped) try {onResult(update);} catch {/* 提示失败不影响下一次检查 */}
    } finally {
      running = false;
      if (!stopped) arm(now()+interval);
    }
  };
  arm(now()+(options.firstDelayMs ?? 2*60*1000));
  const unsubscribe = options.onResume?.(()=>{void run();});
  return () => {if (stopped) return;stopped = true;unsubscribe?.();if (timer !== undefined) clear(timer);timer = undefined;};
}
