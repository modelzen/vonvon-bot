import { fake, human, setup, thread, until } from './helpers/scheduled-run';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultCardDisplay } from '@vonvon/protocol';

const display = (streamText = false) => ({ ...defaultCardDisplay(), reply: { streamText, collapseAfterRun: true } });
const json = (value: unknown) => JSON.stringify(value);

describe('completion-only run delivery', () => {
  let current: Awaited<ReturnType<typeof setup>> | undefined;
  afterEach(async () => { await current?.orchestrator.shutdown(); current = undefined; });

  it.each([
    ['single', undefined], ['multi', 'topic-old'], ['multi', undefined],
  ] as const)('defers the carrier in %s / %s until completion', async (kind, topic) => {
    current = await setup(kind, { preferences: { cardDisplay: display() } });
    fake.project!.presentation = { cardDisplay: display() };
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('请回答', topic));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.emit({ type: 'text_delta', itemId: 'progress', delta: '先检查材料' });
    run.emit({ type: 'text_delta', itemId: 'answer', delta: '最终答案' });
    // Allow the consumer and live clock to run while the backend remains pending.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(fake.createCard).not.toHaveBeenCalled();
    expect(fake.stream).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalled());
    expect(fake.createCard).toHaveBeenCalledTimes(1);
    const first = json(fake.createCard.mock.calls[0]![2]);
    expect(first).toContain('最终答案');
    expect(first).toContain('先检查材料'); // Existing terminal process configuration is preserved.
    expect(first).not.toContain('"streaming_mode":true');
  });

  it('accepts steering without creating an intermediate card', async () => {
    current = await setup('single');
    fake.project!.presentation = { cardDisplay: display() };
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('请回答'));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.emit({ type: 'text_delta', itemId: 'before-steer', delta: '旧过程' });
    const steer = human('再补充一个要求');
    await current.orchestrator.onMessage(steer);
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fake.createCard).not.toHaveBeenCalled();
    run.say('包含补充的最终答案');
    run.turns[0]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalled());
    expect(fake.createCard).toHaveBeenCalledTimes(1);
    expect(json(fake.createCard.mock.calls[0]![2])).toContain('包含补充的最终答案');
    expect(json(fake.createCard.mock.calls[0]![2])).not.toContain('旧过程');
    expect(fake.createCard.mock.calls[0]![3]).toMatchObject({ replyTo: steer.messageId });
  });

  it.each([false, true])('keeps an empty goal turn lazy (thinking only: %s)', async thinking => {
    current = await setup('single');
    fake.project!.presentation = { cardDisplay: display() };
    const run = thread();
    Object.assign(run.t, {
      runGoal: () => run.t.runStreamed({ text: 'goal' }),
      clearGoal: vi.fn(async () => undefined),
    });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('/goal 完成任务'));
    await until(() => expect(run.consumed).toHaveLength(1));
    if (thinking) run.emit({ type: 'thinking', itemId: 'thinking', text: '仅思考，没有结果' });
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'goal-final', expect.anything()));
    expect(fake.createCard).not.toHaveBeenCalled();
    expect(fake.final).not.toHaveBeenCalled();
  });

  it('keeps streaming delivery enabled when configured', async () => {
    current = await setup('single', { preferences: { cardDisplay: display(true) } });
    fake.project!.presentation = { cardDisplay: display(true) };
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('请回答'));
    await until(() => expect(fake.createCard).toHaveBeenCalledTimes(1));
    expect(run.turns).toHaveLength(1);
    run.turns[0]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalled());
  });

  it('delivers a terminal failure without ever creating a progress carrier', async () => {
    current = await setup('single', { preferences: { cardDisplay: display() } });
    fake.project!.presentation = { cardDisplay: display() };
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('请回答'));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.createCard).not.toHaveBeenCalled();
    run.end({ type: 'error', message: '测试失败', willRetry: false });
    await until(() => expect(fake.final).toHaveBeenCalled());
    expect(fake.createCard).toHaveBeenCalledTimes(1);
    expect(json(fake.createCard.mock.calls[0]![2])).toContain('测试失败');
  });
});
