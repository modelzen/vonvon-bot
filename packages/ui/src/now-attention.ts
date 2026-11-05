import type {Agent, Membership} from '@vonvon/protocol';
import {communicationModes} from './settings/ConversationSlider';

export type NowAttention = {
  label: string;
  description: string;
  level?: number;
  score?: number;
  budgetNote?: string;
  tone: 'focus' | 'watch' | 'idle' | 'paused' | 'unknown' | 'mode';
  showMeter: boolean;
};

const intervalText = (ms: number) => ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${ms / 1000} 秒`;

/** The badge and group detail share one live, group-wide reading. */
export function nowGroupAttention(agent: Agent, member: Membership, connected: boolean, stale: boolean, now: number, groupModel = false): NowAttention {
  const smart = member.conversation === 'smart';
  const unknown = (label: string, description: string): NowAttention => ({label, description, tone: 'unknown', showMeter: smart});
  if (agent.id !== member.agentId) return unknown('待更新', '暂无注意力状态。');
  if (!agent.enabled) return unknown('已停用', 'Bot 未运行，暂停注意力判断。');
  if (!connected) return unknown('已断开', '连接恢复后更新注意力状态。');
  if (stale || member.stale || agent.readError) return unknown('待更新', '群状态暂不可读。');
  if (!agent.running) return unknown('未运行', 'Bot 未运行，暂停注意力判断。');
  if (agent.connection !== 'connected') return unknown('已断开', '连接恢复后更新注意力状态。');
  if (member.enabled === false) return unknown('已停用', '本群已停用，暂停注意力判断。');
  if (member.enabled === undefined) return unknown('待更新', '群状态暂不可读。');
  if (!smart) {
    const mode = communicationModes.find(item => item.value === member.conversation)!;
    return {label: mode.label, description: mode.description, tone: 'mode', showMeter: false};
  }
  if (!agent.diagnostics?.attention) return unknown('待更新', '当前版本未提供注意力状态。');
  const state = agent.diagnostics.attention.find(item => item.groupId === member.groupId);
  const budget = state?.budget;
  if (budget && budget.until <= now) return unknown('待更新', '正在等待新的注意力状态。');
  if ((!state && !groupModel) || (state && !state.group)) return unknown('待更新', '请更新后台服务，以查看统一的群注意力。');
  const score = state?.group?.score ?? 10;
  const interval = state?.group?.intervalMs ?? 300_000;
  const budgetNote = budget?.kind === 'named-only'
    ? '判断额度暂满；仅真人 @、引用或回复 Bot 发起的话题根消息仍会判断。'
    : budget?.kind === 'no-glance' ? '判断额度暂满，普通消息的批量查看暂缓；真人直接找它及短期接续消息仍会判断。' : undefined;
  const description = score === 10
    ? '近期较少参与讨论。安静后有新消息时，约 20 秒看第一批；持续聊天按低频节奏合批查看。'
    : score === 100 ? '刚参与讨论，普通消息短暂合批后判断；明确找它或短期接续的消息优先。'
    : `有新消息时攒一批再看 · 当前间隔 ${intervalText(interval)}。`;
  return {
    score, level: score / 25, showMeter: true,
    label: budget ? budget.kind === 'named-only' ? '仅处理真人直接找它' : '普通查看暂缓' : score === 100 ? '专注中' : score === 10 ? '低度留意' : '留意中',
    description: budgetNote ? `${description} ${budgetNote}` : description,
    budgetNote,
    tone: budget ? 'paused' : score === 100 ? 'focus' : score === 10 ? 'idle' : 'watch',
  };
}

export function nowAttentionSummary(readings: readonly NowAttention[], count: number): string {
  const focus = readings.filter(reading => reading.tone === 'focus').length;
  const watch = readings.filter(reading => reading.tone === 'watch').length;
  if (focus && watch) return `专注 ${focus} · 留意 ${watch}`;
  if (focus) return `专注 ${focus} 群`;
  if (watch) return `留意 ${watch} 群`;
  return `${count} 个群`;
}
