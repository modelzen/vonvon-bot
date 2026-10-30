import { fake, human, job, setup, thread, until } from './helpers/scheduled-run';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRunCard, type RunCardState } from '../src/card/run-card';
import { initialState, type RunState } from '../src/card/run-state';
import { scheduledLabel } from '../src/bot/context-weave';

// 总设计 7.3: the small top line on a scheduled run's progress and final card; an empty one is kept as it is.
const text = (card: unknown): string => JSON.stringify(card);
const rs = (terminal: RunState['terminal']): RunState => ({ ...initialState, terminal, startedAt: 1,
  blocks: [{ kind: 'text', id: 'a', content: '今天的日报', streaming: terminal === 'running' }] as RunState['blocks'] });

describe('the label line', () => {
  it.each(['running', 'done'] as const)('heads the %s card, and the rest of the card is as it was', terminal => {
    const plain: RunCardState = { rs: rs(terminal), cardKey: 'card' };
    const labeled = buildRunCard({ ...plain, label: '⏰ 定时任务「日报」' }) as { body: { elements: unknown[] } };
    const before = buildRunCard(plain) as { body: { elements: unknown[] } };
    expect(text(labeled.body.elements[0])).toContain('⏰ 定时任务「日报」');
    expect(labeled.body.elements.slice(1)).toEqual(before.body.elements);
  });
  it('says a catch-up\'s planned time and a manual run, in the task\'s zone', () => {
    expect(scheduledLabel(job())).toBe('⏰ 定时任务「日报」');
    expect(scheduledLabel(job({ timeZone: 'Asia/Shanghai' }, { trigger: 'catchUp' }))).toBe('⏰ 定时任务「日报」 · 原定 17:00');
    expect(scheduledLabel(job({}, { trigger: 'manual' }))).toBe('⏰ 定时任务「日报」 · 手动运行');
  });
});

describe('a scheduled run\'s card', () => {
  let current: Awaited<ReturnType<typeof setup>> | undefined;
  afterEach(async () => { await current?.orchestrator.shutdown(); current = undefined; });

  it('carries the label from the first frame to the last; an empty answer in a smart group keeps its card', async () => {
    current = await setup('smart');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = current.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(text(fake.createCard.mock.calls[0]![2])).toContain('⏰ 定时任务「日报」');
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done', excerpt: '', messageId: 'card' });
    const final = text(fake.final.mock.calls.at(-1)![1]);
    expect(final).toContain('⏰ 定时任务「日报」');
    expect(final).toContain('（未返回内容）');
    expect(fake.log.info).not.toHaveBeenCalledWith('card', 'empty-deleted', expect.anything());
  });

  it('has no 🔔 when the group reminds on request: a scheduled turn has nobody to remind', async () => {
    current = await setup('single', { preferences: { completionReminder: { mode: 'manual' } } });
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('有人在'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(text(fake.createCard.mock.calls[0]![2])).toContain('完成后提醒我');
    run.turns[0]!.resolve();
    const result = current.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(text(fake.createCard.mock.calls[1]![2])).not.toContain('完成后提醒我');
    run.turns[1]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });

  it.each([
    ['links its card in the record as outbound-files does', { data: { items: [{ message_id: 'card', chat_id: 'chat', message_position: '42' }] } },
      'https://applink.feishu.cn/client/chat/open?openChatId=chat&position=42'],
    ['leaves no link when the card is gone', { data: { items: [{ message_id: 'card', deleted: true, message_position: '42' }] } }, undefined],
    ['leaves no link when the lookup fails', new Error('feishu down'), undefined],
  ] as const)('%s', async (_name, reply, link) => {
    current = await setup('single');
    if (reply instanceof Error) fake.messageGet.mockRejectedValue(reply); else fake.messageGet.mockResolvedValue(reply);
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = current.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'done', messageId: 'card' });
    expect((outcome as { link?: string }).link).toBe(link);
    expect(fake.messageGet).toHaveBeenCalledWith({ path: { message_id: 'card' } });
  });
});
