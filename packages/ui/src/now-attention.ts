import type {Agent, Membership} from '@vonvon/protocol';
import {communicationModes} from './settings/ConversationSlider';

export type NowAttention = {
  label: string;
  description: string;
  level?: number;
  tone: 'focus' | 'watch' | 'idle' | 'paused' | 'unknown' | 'mode';
  showMeter: boolean;
};

const watchLevels: Readonly<Record<number, number>> = {60_000: 3, 180_000: 2, 300_000: 1};
const intervalText = (ms: number) => ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${ms / 1000} 秒`;

/** Group-level display of existing attention; no new scoring or reply prediction. */
export function nowGroupAttention(agent: Agent, member: Membership, connected: boolean, stale: boolean, now: number): NowAttention {
  const smart = member.conversation === 'smart';
  const unknown = (label: string, description: string): NowAttention => ({label, description, tone: 'unknown', showMeter: smart});
  if (agent.id !== member.agentId) return unknown('待更新', '暂无关注状态。');
  if (!agent.enabled) return unknown('已停用', 'Bot 未运行，暂停关注。');
  if (!connected) return unknown('已断开', '连接恢复后更新关注状态。');
  if (stale || member.stale || agent.readError) return unknown('待更新', '群状态暂不可读。');
  if (!agent.running) return unknown('未运行', 'Bot 未运行，暂停关注。');
  if (agent.connection !== 'connected') return unknown('已断开', '连接恢复后更新关注状态。');
  if (member.enabled === false) return unknown('已停用', '本群已停用，暂停关注。');
  if (member.enabled === undefined) return unknown('待更新', '群状态暂不可读。');
  if (!smart) {
    const mode = communicationModes.find(item => item.value === member.conversation)!;
    return {label: mode.label, description: mode.description, tone: 'mode', showMeter: false};
  }
  if (!agent.diagnostics?.attention) return unknown('待更新', '当前版本未提供关注状态。');
  const state = agent.diagnostics.attention.find(item => item.groupId === member.groupId);
  const budget = state?.budget;
  if (budget && budget.until <= now) return unknown('待更新', '正在等待新的关注状态。');
  if (budget?.kind === 'named-only') return {label: '暂缓关注', description: '判断额度暂满；真人 @、引用或回复 Bot 发起的话题根消息仍会判断。', level: 0, tone: 'paused', showMeter: true};
  const paused = budget?.kind === 'no-glance';
  const focus = state?.main?.mode === 'focus' || (state?.focusedTopics ?? 0) > 0;
  if (focus) return {label: '专注中', description: `${state?.main?.mode === 'focus' ? '新消息到达就判断是否接话。' : '正在跟进群里的部分讨论。'}${paused ? '其他位置暂缓查看，等待判断额度恢复。' : ''}`, level: 4, tone: 'focus', showMeter: true};
  if (paused) return {label: '暂缓留意', description: '判断额度暂满，恢复后继续查看；真人直接找它的消息仍会判断。', level: 0, tone: 'paused', showMeter: true};
  if (state?.main?.mode === 'watch') return {label: '留意中', description: `攒一批消息再看 · 当前间隔 ${intervalText(state.main.intervalMs)}`, level: watchLevels[state.main.intervalMs], tone: 'watch', showMeter: true};
  // Topic intervals are deliberately absent from the group snapshot. Keep the
  // label, but do not invent a meter level from the topic count.
  if ((state?.watchedTopics ?? 0) > 0) return {label: '留意中', description: '正在留意群内讨论，收到新消息后按当前节奏查看。', tone: 'watch', showMeter: true};
  return {label: '待互动', description: '收到新消息后，关注状态自动更新。', level: 0, tone: 'idle', showMeter: true};
}

export function nowAttentionSummary(readings: readonly NowAttention[], count: number): string {
  const focus = readings.filter(reading => reading.tone === 'focus').length;
  const watch = readings.filter(reading => reading.tone === 'watch').length;
  if (focus && watch) return `专注 ${focus} · 留意 ${watch}`;
  if (focus) return `专注 ${focus} 群`;
  if (watch) return `留意 ${watch} 群`;
  return `${count} 个群`;
}
