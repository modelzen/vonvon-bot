import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { quotedId } from './baselines';
import { extractMessageText } from './context-weave';
import type { RecentLine } from './recent-lines';

/** Signals decide when to judge; only the judgement decides whether to answer. */
export type Salience =
  | { kind: 'at-me' }
  | { kind: 'quote-me'; by: 'quote' | 'root' }
  | { kind: 'name' }
  | { kind: 'plain'; partial?: true };

export const COMMON_NAMES: ReadonlySet<string> = new Set([
  'bot', 'robot', 'ai', 'assistant', 'helper', 'test', 'dev', 'admin',
  '助手', '小助手', '机器人', '测试', '客服', '管理员',
]);

export interface SalienceDeps {
  botName: string | undefined;
  quoted(msg: NormalizedMessage): RecentLine | undefined;
  lookup(messageId: string): Promise<{ from: 'self' | 'bot' | 'user' } | undefined>;
  rootFrom(chatId: string, threadId: string, rootId: string): Promise<'self' | 'other' | undefined>;
}

export function bareText(msg: NormalizedMessage): string {
  const raw: unknown = msg.raw;
  if (!raw || typeof raw !== 'object' || !('message' in raw)) return msg.content;
  const event = raw.message;
  if (!event || typeof event !== 'object' || !('content' in event) || typeof event.content !== 'string') return msg.content;
  const type = 'message_type' in event && typeof event.message_type === 'string' ? event.message_type : undefined;
  return extractMessageText(type, event.content, undefined, msg.mentions.map((m) => m.key).filter((k): k is string => Boolean(k)));
}

export function nameCalled(bare: string, botName: string | undefined): 'full' | 'partial' | 'none' {
  const name = botName?.trim() ?? '';
  if (!name || COMMON_NAMES.has(name.toLowerCase())) return 'none';
  if (/^[\x20-\x7e]+$/.test(name)) {
    if (name.length < 3) return 'none';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(bare) ? 'full' : 'none';
  }
  const chars = [...name];
  if (chars.length < 2) return 'none';
  if (bare.includes(name)) return 'full';
  return chars.length > 2 && bare.includes(chars.slice(0, 2).join('')) ? 'partial' : 'none';
}

export async function smartSalience(msg: NormalizedMessage, deps: SalienceDeps): Promise<Salience> {
  if (msg.mentionedBot) return { kind: 'at-me' };
  const q = quotedId(msg);
  if (q) {
    const line = deps.quoted(msg);
    const from = line?.from ?? (await deps.lookup(q).catch(() => undefined))?.from;
    if (from === 'self') return { kind: 'quote-me', by: 'quote' };
  }
  if (msg.threadId && !q && msg.rootId && msg.rootId !== msg.messageId) {
    const root = await deps.rootFrom(msg.chatId, msg.threadId, msg.rootId).catch(() => undefined);
    if (root === 'self') return { kind: 'quote-me', by: 'root' };
  }
  const called = nameCalled(bareText(msg), deps.botName);
  return called === 'full' ? { kind: 'name' } : called === 'partial' ? { kind: 'plain', partial: true } : { kind: 'plain' };
}
