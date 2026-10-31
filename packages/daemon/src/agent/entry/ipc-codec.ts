import { z } from 'zod';
import type { AgentToolReply } from '../types';

const toolReply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum(['not-ready', 'revoked', 'unknown-tool', 'refused', 'bad-args', 'busy', 'timeout', 'failed']),
    reason: z.enum(['not-dm', 'not-human-turn', 'not-admin', 'switch-off', 'turn-ended', 'unknown-origin', 'not-group', 'no-human-create', 'scheduled-run-scope']).optional(),
    message: z.string(),
  }).strict(),
]);
const listReply = z.object({
  ok: z.literal(true),
  tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) }).strict()),
}).strict();
const ipcReply = z.union([z.object({ unauthorized: z.literal(true) }).strict(), toolReply, listReply]);
export type AgentCallReply = AgentToolReply | z.infer<typeof listReply>;
export function toIpcReply(reply: AgentCallReply | 'unauthorized') {
  return reply === 'unauthorized' ? { unauthorized: true } : reply;
}
export function fromIpcReply(wire: unknown): AgentCallReply | 'unauthorized' {
  const reply = ipcReply.parse(wire);
  return 'unauthorized' in reply ? 'unauthorized' : reply;
}
