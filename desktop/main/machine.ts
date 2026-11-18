import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {machineRequestSchema, serviceStatusSchema, coreUpdateStatusSchema, type MachineRequest, type MachineReply} from '../shared/machine';
import type {HostHandle, HostRuntime} from './host';
import {recentLogs} from './logs';
import type {DesktopUpdater} from './updates';
import type {Registration} from './cli-registration';

const exec = promisify(execFile);
export interface MachineHooks {
  runtime:HostRuntime;
  host():HostHandle|undefined;
  stopHost():Promise<void>;
  startHost(bot?:string):Promise<void>;
  updater:DesktopUpdater;
  openReleases?:()=>Promise<void>;
  serviceCommand?:(action:'status'|'install'|'start'|'stop'|'uninstall')=>Promise<unknown>;
  cliRegistration?:()=>Registration;
  repairCli?:()=>Promise<Registration>;
}
export class MachineService {
  private lane:Promise<unknown> = Promise.resolve();
  private closing = false;
  private temporaryAgent?:string;
  constructor(private readonly hooks:MachineHooks) {}
  request(input:MachineRequest):Promise<MachineReply> {
    if (this.closing) return Promise.reject(new Error('桌面正在退出，无法开始新的服务操作。'));
    const request = machineRequestSchema.parse(input);
    const next = this.lane.then(()=>{
      if (this.closing) throw new Error('桌面正在退出，已取消尚未开始的服务操作。');
      return this.perform(request);
    });
    this.lane = next.catch(()=>{});
    return next;
  }
  beginClosing():void {
    this.closing = true;
  }
  async close(timeoutMs = 60000):Promise<void> {
    this.beginClosing();
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([
        this.lane,
        new Promise<never>((_,reject)=>{
          timer = setTimeout(()=>reject(new Error('服务操作仍未结束，已阻止桌面退出。请稍后重试。')),timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async service(action:'status'|'install'|'start'|'stop'|'uninstall') {
    if (this.hooks.serviceCommand) return serviceStatusSchema.parse(await this.hooks.serviceCommand(action));
    const {home,nodePath,cliPath} = this.hooks.runtime;
    const {stdout} = await exec(nodePath,[cliPath,'__desktop-service',action],{env:{...process.env,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:`${home}/.config`},timeout:45000,maxBuffer:65536,windowsHide:true});
    return serviceStatusSchema.parse(JSON.parse(stdout));
  }
  private connected():HostHandle {
    const host = this.hooks.host();
    if (!host) throw new Error('Bridge 已停止，请先启动。');
    return host;
  }
  private async json(path:string,method = 'GET'):Promise<unknown> {
    const response = await this.connected().request(path,{method,signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error(`Bridge 请求失败 (${response.status})`);
    return response.json();
  }
  private async distribution() {
    return z.object({distribution:z.object({kind:z.enum(['global-npm','bundled','development','unknown']),cliPath:z.string()}).optional()}).parse(await this.json('/api/daemon')).distribution ?? {kind:'unknown' as const,cliPath:''};
  }
  private async perform(request:MachineRequest):Promise<MachineReply> {
    switch(request.type) {
      case 'status': {
        const host = this.hooks.host();
        return {type:'status',service:await this.service('status'),host:host ? {ownership:host.ownership,pid:host.pid}:null,temporaryAgent:this.temporaryAgent,cli:this.hooks.cliRegistration?.()??{kind:'error',message:'此运行方式未配置 CLI。'}};
      }
      case 'repairCli': {
        if (!this.hooks.repairCli) throw new Error('此运行方式无法修复 CLI。');
        const result=await this.hooks.repairCli();
        if(result.kind==='error')throw new Error(result.message);
        return {type:'done',message:result.message};
      }
      case 'service': {
        const host = this.hooks.host();
        const before = await this.service('status');
        const starts = request.action === 'install' || request.action === 'start';
        if (request.action === 'install' && before.installed) throw new Error('后台服务已安装。');
        if (request.action === 'start' && (!before.installed || before.running)) throw new Error('只有已安装且停止的服务可以启动。');
        if (!starts && !before.installed) throw new Error('后台服务尚未安装。');
        if (host?.ownership === 'attached') {
          if (starts) throw new Error('外部 Bridge 正在运行，请先停止后切换服务。');
          if (!before.running || Number(before.pid) !== host.pid) throw new Error('当前 Bridge 不属于已识别的后台服务，不能从这里停止。');
        }
        const previousAgent = this.temporaryAgent;
        if (host?.ownership === 'owned') await this.hooks.stopHost();
        try {
          await this.service(request.action);
          if (starts) {
            const deadline = Date.now() + 20_000;
            for (;;) {
              try {
                await this.hooks.startHost();
                this.connected();
                break;
              } catch (error) {
                if (this.hooks.host() || Date.now() >= deadline) throw error;
                const pending = await this.service('status');
                if (!pending.installed) throw error;
                await new Promise(resolve => setTimeout(resolve, 250));
              }
            }
          } else await this.hooks.stopHost();
          this.temporaryAgent = undefined;
        } catch (error) {
          if (host?.ownership === 'owned' && !this.hooks.host()) {
            const after = await this.service('status');
            if (!after.installed && !after.running) {
              await this.hooks.startHost(previousAgent);
              this.connected();
            }
          }
          throw error;
        }
        return {type:'done',message:'后台服务操作已完成'};
      }
      case 'startHost':
        if (this.hooks.host()) throw new Error('请先停止当前 Bridge，再选择临时运行的 Bot。');
        await this.hooks.startHost(request.bot);
        this.connected();
        this.temporaryAgent = request.bot;
        return {type:'done',message:request.bot?'临时 Bot 已启动，默认选择保持不变':'Bridge 已启动'};
      case 'stopHost':
        if (this.hooks.host()?.ownership === 'attached') throw new Error('此进程由外部服务管理，请使用停止后台服务。');
        await this.hooks.stopHost();
        this.temporaryAgent = undefined;
        return {type:'done',message:'Bridge 已停止'};
      case 'logs': return {type:'logs',text:await recentLogs(this.connected())};
      case 'checkCoreUpdate': return {type:'coreUpdate',distribution:await this.distribution(),...z.object({current:z.string(),latest:z.string().nullable(),hasUpdate:z.boolean(),dev:z.boolean()}).parse(await this.json('/api/update/check'))};
      case 'applyCoreUpdate':
        if (this.connected().ownership !== 'attached' || (await this.distribution()).kind !== 'global-npm') throw new Error('内置 Core 随桌面应用更新。全局 CLI 更新仅适用于外部服务。');
        await this.json('/api/update','POST');
        return {type:'done',message:'外部 Core 更新已开始，可查看进度。桌面应用版本不受此操作影响。'};
      case 'coreUpdateStatus': return {type:'coreUpdateStatus',status:coreUpdateStatusSchema.parse(await this.json('/api/update/status'))};
      case 'openReleases':
        if (!this.hooks.openReleases) throw new Error('发布页入口不可用。');
        await this.hooks.openReleases();
        return {type:'done',message:'已打开官方发布页'};
      case 'checkDesktopUpdate': return {type:'desktopUpdate',update:await this.hooks.updater.check()};
      case 'installDesktopUpdate': return {type:'desktopUpdate',update:await this.hooks.updater.install()};
    }
  }
}
