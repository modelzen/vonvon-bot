import { z } from 'zod';
import type { AgentToolReply } from '../types';
import type { AgentPlace } from './registry';

export interface ToolContext {
  signal: AbortSignal;
  place: AgentPlace;
  turn?: { id: number; requesterOpenId: string; role: 'owner' | 'admin'; triggerMessageId: string };
  /** Call guard synchronously immediately before the write becomes effective, with no await between. */
  commit?<T>(write: (guard: CommitGuard) => Promise<T>): Promise<T>;
}
export type CommitGuard = () => void;
export interface AgentTool {
  name: string;
  class: 'read' | 'settings';
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
