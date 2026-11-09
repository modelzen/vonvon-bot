import {renderCompletionTemplate, type CompletionTemplateValues} from '@vonvon/protocol';
import type { CompletionReminderOutcome } from '../config/schema';

/** Payload inputs for the extra Feishu reply emitted after a run card settles. */
export interface CompletionReminderPost {
  requesterOpenId: string;
  outcome: Extract<CompletionReminderOutcome, 'done' | 'error' | 'idle_timeout'>;
  elapsedMs: number;
  /** Short, user-authored task summary. Empty/whitespace falls back to “本轮任务”. */
  summary?: string;
  /** False when the terminal CardKit update exhausted its retries. */
  cardUpdated: boolean;
  /** Validated local plain-text layout; null/missing uses the original format. */
  template?: string | null;
}

/** Human-readable wall-clock duration, rounded down to whole seconds. */
export function formatCompletionElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} 秒`);
  return parts.join(' ');
}

/**
 * Build a native Feishu `post` body. The requester is a structured `at` node,
 * not markdown text, so this extra reply enters Feishu's real mention/message
 * notification path; another bot is @-ed the same way, which wakes it and shows
 * in the message list (s27a step 0). An id that is not an open_id (`ou_`), as an
 * app sender's id in an event may be, gets no `at` node, only the two lines
 * (s27a-0). The returned value is ready for `im.v1.message.reply`'s `content` field.
 */
export function buildCompletionReminderContent(input: CompletionReminderPost): string {
  const task = compactSummary(input.summary);
  const elapsed = formatCompletionElapsed(input.elapsedMs);
  const detail = input.cardUpdated
    ? input.outcome === 'done'
      ? '结果在上方卡片。'
      : '详情在上方卡片。'
    : '最终卡片更新失败，请查看上方流式内容或重新发起任务。';

  const values:CompletionTemplateValues={task,elapsed,detail,
    icon:input.outcome==='done'?'✅':input.outcome==='idle_timeout'?'⏱':'⚠️',
    status:input.outcome==='done'?'已完成':input.outcome==='idle_timeout'?'响应超时':'执行失败',
    durationLabel:input.outcome==='idle_timeout'?'等待':'用时'};
  let rendered:string;
  try {rendered=renderCompletionTemplate(input.template,values);}
  catch {rendered=renderCompletionTemplate(null,values);}
  // A terminal CardKit failure must always explain where the partial answer is,
  // even if a valid custom layout intentionally omitted {{detail}}.
  if (!input.cardUpdated && !rendered.includes(detail)) rendered+=`\n${detail}`;
  const lines=rendered.replaceAll('\r\n','\n').split('\n');

  const at = input.requesterOpenId.startsWith('ou_');
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: lines.map((line,index)=>index===0 ? [
        ...(at ? [{ tag: 'at', user_id: input.requesterOpenId }] : []),
        {tag:'text',text:at ? ` ${line}` : line},
      ] : [{tag:'text',text:line}]),
    },
  });
}

function compactSummary(summary?: string): string {
  const clean = (summary ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return '本轮任务';
  return clean.length > 32 ? `${clean.slice(0, 31)}…` : clean;
}
