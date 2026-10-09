import { z } from 'zod';
import {agentIdSchema,groupIdSchema,membershipIdSchema,permissionSchema,type DesktopSnapshot,type Agent,type Membership,type Group} from '../shared/bridge';

const avatarSchema = z.string().max(350_000).refine(value => /^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+={0,2}$/.test(value));
export const projectSchema = z.object({name:z.string(),chatId:groupIdSchema,avatarDataUrl:avatarSchema.optional().catch(undefined),cwd:z.string(),kind:z.enum(['multi','single']),noMention:z.boolean(),mode:permissionSchema,guestMode:permissionSchema,network:z.boolean(),backend:z.string()});
export const stateSchema = z.object({version:z.string(),generatedAt:z.number(),bots:z.array(z.object({appId:agentIdSchema,name:z.string(),botName:z.string().optional(),avatarDataUrl:avatarSchema.optional().catch(undefined),active:z.boolean(),running:z.boolean(),connection:z.string().optional(),projects:z.array(projectSchema),projectsError:z.string().optional()}))});
export type CoreState = z.infer<typeof stateSchema>;
export function projectState(state:CoreState, previous:DesktopSnapshot, pending:ReadonlySet<string>) {
  const agents:Agent[] = [];
  const memberships:Membership[] = [];
  for (const bot of state.bots) {
    const duplicate = new Set(bot.projects.map(project=>project.chatId)).size!==bot.projects.length;
    const readError = bot.projectsError ?? (duplicate ? '同一个 Bot 存在冲突的群绑定，请在内核中修复。' : undefined);
    agents.push({id:bot.appId,name:bot.botName || bot.name,...(bot.avatarDataUrl?{avatarDataUrl:bot.avatarDataUrl}:{}),enabled:bot.active,running:bot.running,connection:bot.connection ?? (bot.running ? 'unknown' : 'disconnected'),activation:pending.has(bot.appId)||bot.active!==bot.running?'restartRequired':'active',...(readError?{readError}:{})});
    if (readError) {
      memberships.push(...previous.memberships.filter(member=>member.agentId===bot.appId).map(member=>({...member,stale:true})));
      continue;
    }
    for (const project of bot.projects) memberships.push({id:membershipIdSchema.parse(JSON.stringify([bot.appId,project.chatId])),agentId:bot.appId,groupId:project.chatId,name:project.name,...(project.avatarDataUrl?{avatarDataUrl:project.avatarDataUrl}:{}),directory:project.cwd,backend:project.backend,conversation:project.kind==='multi'?'threads':'shared',response:project.noMention?'all':'mention',permission:{administrator:project.mode,member:project.guestMode,network:project.network},stale:false});
  }
  const groups = new Map<string, Group>();
  for (const member of memberships) {
    const avatarDataUrl = member.avatarDataUrl ?? groups.get(member.groupId)?.avatarDataUrl;
    groups.set(member.groupId, {id:member.groupId,name:member.name,...(avatarDataUrl?{avatarDataUrl}:{})});
  }
  return {agents,memberships,groups:[...groups.values()],stale:agents.some(agent=>!!agent.readError)};
}

export class CoreError extends Error {
  constructor(readonly code:string,message:string) {super(message);}
}
export async function readJson(response:Response):Promise<unknown> {
  const body = await response.text();
  if (body.length > 4_000_000) throw new CoreError('invalid-response','内核响应过大。');
  let data:unknown;
  try {data = JSON.parse(body);} catch {throw new CoreError('invalid-response',`内核返回了无法解析的响应 (${response.status})。`);}
  if (!response.ok) {
    const error=z.object({message:z.string().optional(),error:z.string().optional()}).safeParse(data);
    throw new CoreError(response.status===404||response.status===501?'unsupported':`http-${response.status}`,error.success?(error.data.message??(response.status===404||response.status===501?'当前 Bridge 版本不支持此操作，请更新内核后重试。':error.data.error??`内核请求失败 (${response.status})。`)):`内核请求失败 (${response.status})。`);
  }
  return data;
}
export function messageOf(error:unknown):string { return error instanceof Error ? error.message : '操作失败，请刷新状态后重试。'; }
