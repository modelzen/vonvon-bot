import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import {machineRequestSchema, serviceStatusSchema, coreUpdateStatusSchema, type MachineRequest, type MachineReply} from '../shared/machine';
import type {HostHandle, HostRuntime} from './host';
import {recentLogs} from './logs';
import type {DesktopUpdater} from './updates';

const exec = promisify(execFile);
export interface MachineHooks {
  runtime:HostRuntime;
  host():HostHandle|undefined;
  stopHost():Promise<void>;
  startHost(bot?:string):Promise<void>;
  updater:DesktopUpdater;
  serviceCommand?:(action:'status'|'install'|'start'|'stop'|'uninstall')=>Promise<unknown>;
}
export class MachineService {
  private lane:Promise<unknown> = Promise.resolve();
  private temporaryAgent?:string;
  constructor(private readonly hooks:MachineHooks) {}
  request(input:MachineRequest):Promise<MachineReply> {
    const request = machineRequestSchema.parse(input);
    const next = this.lane.then(()=>this.perform(request));
    this.lane = next.catch(()=>{});
    return next;
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
  private async perform(request:MachineRequest):Promise<MachineReply> {
    switch(request.type) {
      case 'status': {
        const host = this.hooks.host();
        return {type:'status',service:await this.service('status'),host:host ? {ownership:host.ownership,pid:host.pid}:null,temporaryAgent:this.temporaryAgent};
      }
      case 'service': {
        const host = this.hooks.host();
        if (host?.ownership === 'attached' && (request.action === 'stop' || request.action === 'uninstall')) {
          const service = await this.service('status');
          if (!service.running || Number(service.pid) !== host.pid) throw new Error('当前 Bridge 不属于已识别的后台服务，不能从这里停止。');
        }
        if (host?.ownership === 'owned') await this.hooks.stopHost();
        if (host?.ownership === 'attached' && (request.action === 'install' || request.action === 'start')) throw new Error('外部 Bridge 正在运行，请先停止后切换服务。');
        await this.service(request.action);
        this.temporaryAgent = undefined;
        if (request.action === 'install' || request.action === 'start') await this.hooks.startHost();
        else await this.hooks.stopHost();
        return {type:'done',message:'后台服务操作已完成'};
      }
      case 'startHost':
        if (this.hooks.host()) throw new Error('请先停止当前 Bridge，再选择临时运行的 Agent。');
        await this.hooks.startHost(request.bot);
        this.temporaryAgent = request.bot;
        return {type:'done',message:request.bot?'临时 Agent 已启动，默认选择保持不变':'Bridge 已启动'};
      case 'stopHost':
        if (this.hooks.host()?.ownership === 'attached') throw new Error('此进程由外部服务管理，请使用停止后台服务。');
        await this.hooks.stopHost();
        this.temporaryAgent = undefined;
        return {type:'done',message:'Bridge 已停止'};
      case 'logs': return {type:'logs',text:await recentLogs(this.connected())};
      case 'checkCoreUpdate': return {type:'coreUpdate',...z.object({current:z.string(),latest:z.string().nullable(),hasUpdate:z.boolean(),dev:z.boolean()}).parse(await this.json('/api/update/check'))};
      case 'applyCoreUpdate':
        if (this.connected().ownership !== 'attached') throw new Error('内置 Core 随桌面应用更新。全局 CLI 更新仅适用于外部服务。');
        await this.json('/api/update','POST');
        return {type:'done',message:'外部 Core 更新已开始，可查看进度。桌面应用版本不受此操作影响。'};
      case 'coreUpdateStatus': return {type:'coreUpdateStatus',status:coreUpdateStatusSchema.parse(await this.json('/api/update/status'))};
      case 'checkDesktopUpdate': return {type:'desktopUpdate',update:await this.hooks.updater.check()};
      case 'installDesktopUpdate': return {type:'desktopUpdate',update:await this.hooks.updater.install()};
    }
  }
}
