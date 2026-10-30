import { describe, expect, it } from 'vitest';
import { scheduledHeader, scheduledOpening, scheduledRootText } from '../src/bot/context-weave';
import type { ScheduledJob, StoredTask } from '../src/bot/schedule/types';

// 总设计 7.2, verbatim: the fixed context a scheduled run starts with. Times in the task's zone.
const Z = 'Asia/Shanghai';
const at = (day: number, hh: number, mm: number): number => Date.UTC(2026, 9, day, hh - 8, mm); // Shanghai wall clock
const NOBODY = '现在没有人在场：不要提问，不要等人确认；能定的自己定，做不了的直接写出来。';
function job(trigger: ScheduledJob['trigger'] = 'schedule', task: Partial<StoredTask> = {}, startedAt = at(30, 9, 0)): ScheduledJob {
  return {
    task: {
      id: 'st_00000000000000a1', chatId: 'oc_a', revision: 'r', name: '日报', instruction: '汇总昨天的进展', timeZone: Z,
      spec: { kind: 'weekly', days: [1, 2, 3, 4, 5], time: '09:00' }, placement: { kind: 'follow' }, state: 'active',
      createdBy: { via: 'chat', name: '张三', text: '每个工作日早上九点发日报' }, createdAt: at(30, 10, 0) - 86_400_000, updatedAt: 0, cursor: 0,
      counts: { runs: 2, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [],
      inflight: { runId: 'run', slot: at(30, 9, 0), trigger, startedAt, revision: 'r' }, ...task,
    },
    runId: 'run', slot: at(30, 9, 0), trigger, nth: 3, late: trigger === 'catchUp',
  };
}

describe('the header of a run in an existing session', () => {
  it('a scheduled run, then the task', () => {
    expect(scheduledHeader(job(), Z, false)).toBe(`（定时任务「日报」· 每个工作日 09:00 · 第 3 次。${NOBODY}）\n汇总昨天的进展`);
  });
  it.each([
    ['a catch-up', job('catchUp', {}, at(30, 9, 7)), false, ' · 原定 09:00，09:07 开始'],
    ['a manual run', job('manual'), false, ' · 手动运行'],
    ['a topic that is gone', job(), true, ' · 原话题找不到了，这次发在这里'],
  ] as const)('%s', (_name, run, fallback, note) => {
    expect(scheduledHeader(run, Z, fallback).split('\n')[0]).toBe(`（定时任务「日报」· 每个工作日 09:00 · 第 3 次${note}。${NOBODY}）`);
  });
  it('names the task\'s zone when the daemon is in another', () => {
    expect(scheduledHeader(job(), 'UTC', false)).toContain('· 每个工作日 09:00（Asia/Shanghai） · 第 3 次');
  });
});

describe('the opening of a new hidden session', () => {
  it('the task, who made it and what they said, and the last result with its link', () => {
    const last = { at: at(29, 9, 0), status: 'done' as const, excerpt: '昨天完成了三件事', messageId: 'om_1', link: 'https://applink.feishu.cn/x' };
    expect(scheduledOpening(job('schedule', { lastResult: last }), Z, false)).toBe([
      `（定时任务「日报」· 每个工作日 09:00 · 第 3 次。${NOBODY}）`,
      '任务内容：汇总昨天的进展',
      '由 张三 在 2026-10-29 10:00 创建，原话："每个工作日早上九点发日报"',
      '上次结果（2026-10-29 09:00，完成）：昨天完成了三件事',
      'https://applink.feishu.cn/x',
    ].join('\n'));
  });
  it('no last result: no such part; a creator without a name goes by where the task was made', () => {
    for (const [via, who] of [['chat', '群成员'], ['desktop', '桌面端'], ['cli', '终端']] as const) {
      const text = scheduledOpening(job('schedule', { createdBy: { via } }), Z, false);
      expect(text.split('\n')).toHaveLength(3);
      expect(text).toContain(`由 ${who} 在 2026-10-29 10:00 创建`);
      expect(text).not.toContain('原话');
    }
  });
  it('without a link, says where the last card is', () => {
    const last = { at: at(29, 9, 0), status: 'failed' as const, excerpt: '失败：超时', messageId: 'om_2' };
    const inTopic = { runId: 'r0', slot: 0, trigger: 'schedule' as const, status: 'failed' as const, messageId: 'om_2', topicId: 'omt_1' };
    expect(scheduledOpening(job('schedule', { lastResult: last }), Z, false).split('\n').slice(-2)).toEqual(['上次结果（2026-10-29 09:00，失败）：失败：超时', '（在本群主区）']);
    expect(scheduledOpening(job('schedule', { lastResult: last, recent: [inTopic] }), Z, false).split('\n').at(-1)).toBe('（在本群的话题里）');
  });
  it('the topic\'s root message', () => {
    expect(scheduledRootText(job())).toBe('⏰ 定时任务「日报」· 第 3 次');
    expect(scheduledRootText(job('catchUp', {}, at(30, 9, 7)))).toBe('⏰ 定时任务「日报」· 第 3 次 · 原定 09:00，09:07 开始');
  });
});
