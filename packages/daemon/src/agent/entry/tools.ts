import { z } from 'zod';
import type { AgentToolReply } from '../types';
import type { MemoryTurn } from '../../bot/memory-authority';
import type { AgentPlace } from './registry';

export interface ToolContext {
  signal: AbortSignal;
  notAfter: number;
  admin?: boolean;
  readonly writeRefusal?: Extract<AgentToolReply, { ok: false }>;
  place: AgentPlace;
  turn?: { id: number; requesterOpenId: string; role: 'owner' | 'admin' | 'member' | 'bot'; triggerMessageId: string };
  /** memory 类工具：这一轮对记忆的事实，每次调用现取（提交点前的 commit guard 里再取一次） */
  memoryTurn?(): MemoryTurn | undefined;
  /** memory 类工具：占一个这一轮的 Bot 记忆写入名额（一轮一条），占不到返回 false；没写成时放回 */
  reserveBotWrite?(): boolean;
  releaseBotWrite?(): void;
  /** Call guard synchronously immediately before the write becomes effective, with no await between. */
  commit?<T>(write: (guard: CommitGuard) => Promise<T>): Promise<T>;
}
export type CommitGuard = () => void;
export interface AgentTool {
  name: string;
  class: 'read' | 'settings' | 'memory';
  description: string;
  input: z.ZodObject;
  run(args: unknown, ctx: ToolContext): Promise<unknown>;
}
export type AgentToolSpec = Pick<AgentTool, 'name' | 'description' | 'input'>;
export class ToolRefusal extends Error {
  constructor(readonly reply: Extract<AgentToolReply, { ok: false }>) {
    super(reply.message);
  }
}
export const sessionInfoTool: AgentTool = {
  name: 'session_info',
  class: 'read',
  description: '查这条会话在 vonvon 里属于哪里，以及这一轮能不能改 vonvon 的设置。要改设置之前先调它；平时不用调。',
  input: z.object({}).strict(),
  async run() { throw new Error('session_info is evaluated by the registry'); },
};
