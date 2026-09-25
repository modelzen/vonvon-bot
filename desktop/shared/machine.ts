import {z} from 'zod';

export const machineRequestSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('status')}),
  z.object({type:z.literal('service'), action:z.enum(['install','start','stop','uninstall'])}),
  z.object({type:z.literal('startHost'), bot:z.string().regex(/^cli_[a-zA-Z0-9]+$/).optional()}),
  z.object({type:z.literal('stopHost')}),
  z.object({type:z.literal('logs')}),
  z.object({type:z.literal('checkCoreUpdate')}),
  z.object({type:z.literal('applyCoreUpdate')}),
  z.object({type:z.literal('coreUpdateStatus')}),
  z.object({type:z.literal('checkDesktopUpdate')}),
  z.object({type:z.literal('installDesktopUpdate')}),
]);
export type MachineRequest = z.infer<typeof machineRequestSchema>;
export const serviceStatusSchema = z.object({platformName:z.string(),installed:z.boolean(),running:z.boolean(),servicePath:z.string(),stdoutPath:z.string(),stderrPath:z.string(),pid:z.string().optional(),lastExit:z.string().optional()});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type DesktopUpdate = {state:'current'|'available'|'unavailable'|'downloaded';current:string;latest?:string;message:string};
export type MachineReply =
 | {type:'status';service:ServiceStatus;host:{ownership:'owned'|'attached';pid:number}|null;temporaryAgent?:string}
 | {type:'done';message:string}
 | {type:'logs';text:string}
 | {type:'coreUpdate';current:string;latest:string|null;hasUpdate:boolean;dev:boolean}
 | {type:'coreUpdateStatus';status:unknown}
 | {type:'desktopUpdate';update:DesktopUpdate};
export type MachineRequestHandler = (request:MachineRequest)=>Promise<MachineReply>;
