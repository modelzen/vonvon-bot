import { usageShareSectionSchema, type AdminReply, type CollaborationReply, type JudgeUsageDay, type UsageShareSection } from '@vonvon/protocol';
import { badArgs } from '../command-error';
import { localTime, print, printable, want, withDaemon, type Daemon, type Io } from '../daemon-client';
import { answer, groupAt, type GroupOptions } from './session';

/**
 * `vonvon usage …` (cli-4-sessions 4.2 第 10–12 条): the web page's 用量 page. The plan's quota is the account's, so
 * `show` and `judge` take no group and no running bot; `share` posts a card in a group, through its bot.
 */
type Usage = Extract<CollaborationReply, { kind: 'usage' }>['data'];
type Window = { usedPercent: number; windowSeconds?: number; resetAt?: number };

/** The web page's names for a quota window (UsageContent `usageWindowLabel`): 5 小时限额, 7 天限额. */
function windowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds % 86400 === 0) return `${seconds / 86400} 天限额`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时限额`;
  return `${Math.round(seconds / 60)} 分钟限额`;
}
/** `resetAt` is in seconds, as the provider sends it. */
const windowValue = (window: Window | undefined): string => window
  ? `已用 ${Math.round(window.usedPercent)}%${window.resetAt ? ` · ${localTime(window.resetAt * 1000)} 重置` : ''}`
  : '暂不可用';
const amount = (value: number | undefined): string => value === undefined ? '未提供' : value.toLocaleString('en-US');

function usageLines(data: Usage): string[] {
  const { usage, profile } = data;
  const lines = [`Codex 账号：${printable(profile.displayName ?? '') || '当前账号'}${usage.planType ? ` · 套餐 ${usage.planType}` : ''}（所有 Bot 共用）`];
  lines.push(`${windowLabel(usage.main.primary?.windowSeconds, '主要限额')}：${windowValue(usage.main.primary)}`);
  lines.push(`${windowLabel(usage.main.secondary?.windowSeconds, '额外限额')}：${windowValue(usage.main.secondary)}`);
  for (const extra of usage.extras) lines.push(`${printable(extra.name ?? '') || '额外限额'}：${windowValue(extra.primary)}；${windowValue(extra.secondary)}`);
  lines.push(`累计 Token：${amount(profile.lifetimeTokens)}`);
  lines.push(`连续活跃：${profile.currentStreakDays === undefined ? '未提供' : `${profile.currentStreakDays} 天`}`);
  lines.push(`读取于 ${localTime(usage.fetchedAt)}`);
  return lines;
}

/** `--refresh` is the web page's 刷新 (force: the daemon reads the account again instead of its cache). The account is
 * read over the network, so the Feishu tier; a read that times out is exit 3. */
export async function runUsageShow(options: { refresh?: boolean }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const data = await daemon(async call => answer('读取用量', await call('读取用量', c => c.collaboration({ action: 'usage', force: Boolean(options.refresh) }), { feishu: true }), 'usage').data);
  print(io, usageLines(data), { data });
}

const SECTIONS = usageShareSectionSchema.options;
/** `--sections stats,plan`: checked before connecting; none means the daemon's default, the whole card. */
export function parseSections(raw: string | undefined): UsageShareSection[] | undefined {
  if (raw === undefined) return undefined;
  const words = raw.split(',').map(word => word.trim()).filter(Boolean);
  const wrong = words.filter(word => !(SECTIONS as readonly string[]).includes(word));
  if (!words.length || wrong.length) throw badArgs(`--sections 只能是 ${SECTIONS.join('、')}，用逗号分开${wrong.length ? `；不认识 ${wrong.join('、')}` : ''}。`);
  return [...new Set(words as UsageShareSection[])];
}

/** 分享到群: a usage card in the group, as the web page's 生成分享卡. */
export async function runUsageShare(options: GroupOptions & { sections?: string }, io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const sections = parseSections(options.sections);
  const { name, reply } = await daemon(async call => {
    const at = await groupAt(call, options);
    const sent = await call('分享用量', c => c.collaboration({ action: 'shareUsage', ...at.target, ...sections ? { sections } : {} }), { feishu: true, unknown: '卡片可能已经发出，去群里看一眼。' });
    return { name: at.membership.name, reply: answer('分享用量', sent, 'applied') };
  });
  print(io, [`已在「${name}」生成可转发的用量卡片。`], { ...reply.messageId ? { messageId: reply.messageId } : {} });
}

type JudgeUsage = Extract<AdminReply, { kind: 'judgeUsage' }>;
/** The web page's names (JudgeUsage `sourcesText`): TypeSafe's decision model is Jev. */
const sourceLabel = (source: JudgeUsageDay['sources'][number]): string => source.kind === 'decision' && source.id === 'typesafe' ? 'Jev' : printable(source.label);

/** Today, then each day with judgements, newest first as the daemon sends them; under each its sources and bots. */
function judgeLines(view: JudgeUsage): string[] {
  const lines: string[] = [];
  const days = view.days.filter((day, index) => index === 0 || day.total > 0);
  for (const day of days) {
    lines.push(`${day.date}  共 ${day.total} 次`);
    for (const source of day.sources) lines.push(`  ${source.kind === 'llm' ? '语言模型' : '决策模型'} ${sourceLabel(source)}  ${source.count} 次`);
    for (const bot of day.bots) lines.push(`  ${printable(bot.agentName)}（${bot.agentId}）  ${bot.count} 次`);
  }
  if (view.days.every(day => day.total === 0) && !view.unreadBots && !view.botsUnreadable) lines.push('最近 14 天没有判断。只有智能群会判断。');
  if (view.unreadBots > 0) lines.push(`有 ${view.unreadBots} 个 Bot 的记录读不了（vonvon daemon logs 里的 judge usage-unreadable）。`);
  if (view.botsUnreadable) lines.push('Bot 列表读不了，判断次数都没算进来（vonvon daemon logs 里的 judge usage-bots-unreadable）。');
  return lines;
}

/** 智能模式的判断次数 (the decision model's use): the last 14 days by this computer's date. */
export async function runUsageJudge(io: Io, daemon: Daemon = withDaemon): Promise<void> {
  const view = await daemon(async call => want('读取判断次数', await call('读取判断次数', c => c.admin({ type: 'judgeUsage' })), 'judgeUsage'));
  const { kind: _kind, ...json } = view;
  print(io, judgeLines(view), json);
}
