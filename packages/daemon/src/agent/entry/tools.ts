import { z } from 'zod';
import type { AgentToolReply } from '../types';
import type { MemoryTurn } from '../../bot/memory-authority';
import type { ScheduleRequest } from '@vonvon/protocol';
import type { ScheduleActor } from '../../admin/schedule-commands';
import type { AgentPlace, TurnWhere } from './registry';

export interface ToolContext {
  resourceCaller?:()=>import('../../recipe/resource-context').ResourceCaller|undefined;
  codeSource?: (name:import('../../release-code/connection').ReleaseCodeTool,args:Record<string,unknown>)=>Promise<string>;
  feedback?: (args: Parameters<import('./feedback-tool').FeedbackSource['prepare']>[0]) => Promise<unknown>;
  signal: AbortSignal;
  notAfter: number;
  admin?: boolean;
  readonly writeRefusal?: Extract<AgentToolReply, { ok: false }>;
  place: AgentPlace;
  /** The session's id, which its token in the host names: what a read through another Bot shows the host (dm-agent 7.3). */
  sessionId?: string;
  turn?: { id: number; requesterOpenId: string; role: 'owner' | 'admin' | 'member' | 'bot'; triggerMessageId: string };
  /** memory 类工具：这一轮对记忆的事实，每次调用现取（提交点前的 commit guard 里再取一次） */
  memoryTurn?(): MemoryTurn | undefined;
  /** memory 类工具：占一个这一轮的 Bot 记忆写入名额（一轮一条），占不到返回 false；没写成时放回 */
  reserveBotWrite?(): boolean;
  releaseBotWrite?(): void;
  /** Call guard synchronously immediately before the write becomes effective, with no await between. */
  commit?<T>(write: (guard: CommitGuard) => Promise<T>): Promise<T>;
  /** schedule 类工具：这一轮的 actor、位置和有没有被别人插过话，调用时现取（bot 开的话题认领后才有 id，总设计第 10 节） */
  schedule?(): { actor: Exclude<ScheduleActor, { kind: 'local' }>; where: TurnWhere; steered: boolean };
}
export type CommitGuard = () => void;
/** The most a tool's result may take as JSON; the registry answers a bigger one with 结果太大. */
export const TOOL_RESULT_BYTES = 256 * 1024;
export interface AgentTool {
  name: string;
  /**
   * `document`: the document column of dm-agent 7.2, the Feishu tools a comment's session gets too. `feishu-api`: the
   * private chat's generic tool (7.6), kept to an administrator's turn or task by the registry.
   */
  class: 'read' | 'settings' | 'memory' | 'schedule' | 'document' | 'feishu-api' | 'feedback' | 'release-code' | 'resource';
  /** `document` 类：这个工具改东西，所有位置都要这一轮还在（registry 的 authorizeFeishu） */
  writes?: boolean;
  /** Where it is listed and may be called, besides what its class allows; everywhere its class allows when absent. */
  places?: readonly AgentPlace['kind'][];
  /** schedule 类：对应命令核的哪个动作，登记表按它查 3.13 的角色表 */
  action?: ScheduleRequest['action'];
  description: string;
  input: z.ZodObject;
  /** The input in a private chat, where it may name another Bot (dm-agent 7.3); `input` everywhere else. */
  dmInput?: z.ZodObject;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}
export type AgentToolSpec = Pick<AgentTool, 'name' | 'description' | 'input'>;
export class ToolRefusal extends Error {
  constructor(readonly reply: Extract<AgentToolReply, { ok: false }>) {
    super(reply.message);
  }
}
/** What the model reads back: a text result as it is (a schedule tool's line and JSON), any other result as JSON. */
export function toolReplyText(reply: AgentToolReply): string {
  return !reply.ok ? reply.message : typeof reply.result === 'string' ? reply.result : JSON.stringify(reply.result);
}
export const sessionInfoTool: AgentTool = {
  name: 'session_info',
  class: 'read',
  description: '查这条会话在 vonvon 里属于哪里（群、私聊还是文档评论），以及现在这一轮是不是有人发消息触发的；私聊里还回这一轮能不能用 vonvon 命令行改设置。平时不用调。',
  input: z.object({}).strict(),
  async run() { throw new Error('session_info is evaluated by the registry'); },
};
