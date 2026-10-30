import type { ScheduledTaskView } from '@vonvon/protocol';

export type StoredTask = Omit<ScheduledTaskView, 'nextRunAt' | 'running' | 'describe' | 'botId'> & {
  cursor: number;
  inflight?: { runId: string; slot: number; trigger: 'schedule' | 'catchUp' | 'manual'; startedAt: number; revision: string };
  noticePending?: true;           // 自动暂停的那条群消息还没发出去，下次 tick 再试
  noticeSince?: number;           // 这次自动暂停的时刻；24 小时窗口和清 noticePending 都认它，不认 updatedAt
};

export type ScheduledJob = { task: StoredTask; runId: string; slot: number; trigger: 'schedule' | 'catchUp' | 'manual'; nth: number; late: boolean };
export type ScheduledOutcome =
  | { status: 'done'; excerpt: string; messageId?: string; topicId?: string; link?: string; durationMs: number }           // link：结算时解析的飞书链接，不是网址的不记
  | { status: 'failed'; error: string; messageId?: string; topicId?: string; link?: string; durationMs: number; counts: boolean } // counts=false：飞书连不上、一张卡都没发出去，不计入连续失败
  | { status: 'skipped'; reason: 'disabled' | 'updating' | 'held' }                                                 // 运行前的门没过，不出声
  | { status: 'interrupted'; by: 'shutdown' | 'user'; messageId?: string; topicId?: string; link?: string };         // 崩溃的 interrupted 由调度器在启动时写，by: 'crash'
/** 一次定时运行在 orchestrator 里的回执。orchestrator 的每条丢弃路径都要调 settle，所以它幂等：第一次算数。 */
export interface ScheduledHook {
  job: ScheduledJob;
  /** 这一轮所有消息和卡片的落点，替代合成消息的 id：main 用 message.create，不引用；topic 用 reply 到 anchor、reply_in_thread */
  target: { kind: 'main' } | { kind: 'topic'; anchor: string };
  started(info: { messageId?: string; topicId?: string }): void;
  settle(outcome: ScheduledOutcome): void;
}
