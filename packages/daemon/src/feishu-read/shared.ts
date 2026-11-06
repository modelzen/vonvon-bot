import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { TOOL_RESULT_BYTES } from '../agent/entry/tools';
import { sanitizeContext } from '../bot/context-weave';
import { withDeadline } from '../bot/names';
import type { TenantBrand } from '../config/schema';
import { FeishuReadRefused, readableFailure, refusalOf, type DenialContext, type ReadArea } from './denial';

export interface ReadDeps {
  channel: LarkChannel;
  app: { id: string; tenant: TenantBrand };
}

/** What a result's content may take, leaving room for the fields around it under the registry's limit. */
export const RESULT_BUDGET = TOOL_RESULT_BYTES - 16 * 1024;
/** One Feishu call; the SDK's have no timeout. */
const CALL_MS = 20_000;

export const denialContext = (deps: ReadDeps): DenialContext => ({ app: deps.app, botName: () => deps.channel.botIdentity?.name || 'Bot' });
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
/** Feishu's text as a result carries it: multi-line, whole, through the one sanitizing boundary. */
export const cleanText = (text: string): string => sanitizeContext(text, Infinity, false);

/** One call to Feishu; a failure, a non-zero code or no answer in time comes out as a {@link FeishuReadRefused}. */
export async function ask<T extends object>(deps: ReadDeps, area: ReadArea, call: () => Promise<T>, ms = CALL_MS): Promise<T> {
  let answer: T | undefined;
  try {
    answer = await withDeadline(call(), ms, `feishu-read-${area}`);
  } catch (failure) {
    throw refusalOf(denialContext(deps), area, await readableFailure(failure));
  }
  if (!answer) throw new FeishuReadRefused('飞书这一步超时了，稍后再试。', 'no-answer');
  const { code } = answer as { code?: unknown };
  if (typeof code === 'number' && code !== 0) throw refusalOf(denialContext(deps), area, answer);
  return answer;
}

/**
 * The part of `text` from `from` that fits the budget as JSON, which is what the registry measures, and where the next
 * part starts. Never between the two halves of an emoji.
 */
export function sliceText(text: string, from: number, budget = RESULT_BUDGET): { text: string; next?: number } {
  let end = Math.min(text.length, from + budget);
  while (end > from && jsonBytes(text.slice(from, end)) > budget) end = from + Math.floor((end - from) * 0.8);
  const code = text.charCodeAt(end - 1);
  if (end < text.length && end - from > 1 && code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(from, end), ...(end < text.length ? { next: end } : {}) };
}

/** A paged text's cursor: an offset, with nothing else in it. */
export function textOffset(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FeishuReadRefused('cursor 不对：用上一次结果里的 cursor，原样传回来。');
  return offset;
}
