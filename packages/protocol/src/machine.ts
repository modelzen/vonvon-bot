import {z} from 'zod';
import {agentIdSchema, serviceStateSchema} from './domain.js';

export const machineRequestSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('status')}),
  z.object({type:z.literal('repairCli')}),
  z.object({type:z.literal('service'), action:z.enum(['install','start','stop','uninstall'])}),
  /** Remembers that the user chose a detached daemon over the login-time service, so the checklist stops asking. */
  z.object({type:z.literal('setServiceSkipped'), skipped:z.boolean()}),
  z.object({type:z.literal('startHost'), bot:agentIdSchema.unwrap().optional()}),
  z.object({type:z.literal('stopHost')}),
  z.object({type:z.literal('logs')}),
  z.object({type:z.literal('checkCoreUpdate')}),
  z.object({type:z.literal('applyCoreUpdate')}),
  z.object({type:z.literal('coreUpdateStatus')}),
  z.object({type:z.literal('checkDesktopUpdate')}),
  z.object({type:z.literal('openReleases')}),
  z.object({type:z.literal('installDesktopUpdate')}),
]);
export type MachineRequest = z.infer<typeof machineRequestSchema>;
export const serviceStatusSchema = z.object({platformName:z.string(),installed:z.boolean(),running:z.boolean(),servicePath:z.string(),stdoutPath:z.string(),stderrPath:z.string(),pid:z.string().optional(),lastExit:z.string().optional(),state:serviceStateSchema.optional(),detail:z.string().optional(),name:z.string().optional()});
export const coreUpdateStatusSchema = z.object({phase:z.enum(['installing','restarting','done','error']),ok:z.boolean().optional(),message:z.string().optional(),from:z.string().optional(),to:z.string().optional(),at:z.number()}).nullable();
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export const desktopUpdateSchema = z.object({state:z.enum(['current','available','unavailable','downloaded']),current:z.string(),latest:z.string().optional(),message:z.string()});
export type DesktopUpdate = z.infer<typeof desktopUpdateSchema>;
export const machineReplySchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('status'),service:serviceStatusSchema,host:z.object({ownership:z.enum(['owned','attached']),pid:z.number()}).nullable(),temporaryAgent:z.string().optional(),cli:z.union([z.object({kind:z.literal('ready'),bin:z.string(),message:z.string()}),z.object({kind:z.literal('error'),message:z.string()})])}),
  z.object({type:z.literal('done'),message:z.string()}),
  z.object({type:z.literal('logs'),text:z.string()}),
  z.object({type:z.literal('coreUpdate'),distribution:z.object({kind:z.enum(['global-npm','bundled','development','unknown']),cliPath:z.string()}),current:z.string(),latest:z.string().nullable(),hasUpdate:z.boolean(),dev:z.boolean()}),
  z.object({type:z.literal('coreUpdateStatus'),status:coreUpdateStatusSchema}),
  z.object({type:z.literal('desktopUpdate'),update:desktopUpdateSchema}),
]);
export type MachineReply = z.infer<typeof machineReplySchema>;
export type MachineRequestHandler = (request:MachineRequest)=>Promise<MachineReply>;
