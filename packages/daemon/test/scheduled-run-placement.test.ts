import { fake, cardOpts, deferred, human, job, setup, thread, topics, until } from './helpers/scheduled-run';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectRevision } from '../src/admin/collaboration';

// T2 4.1 第 2 到 4 条、总设计 7.1: where a scheduled run goes, and that it never steers nor is steered into.
const spy = vi.hoisted(() => ({ judge: vi.fn() }));
vi.mock('../src/judge/judge', async (original) => ({
  ...await original<object>(), createJudge: () => ({ judge: spy.judge, warm() {}, shutdown: async () => {} }),
}));

let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await current?.orchestrator.shutdown(); current = undefined; });
async function start(kind: 'single' | 'multi' | 'smart', preferences?: NonNullable<Parameters<typeof setup>[1]>['preferences']) {
  current = await setup(kind, { preferences });
  return current;
}

describe('a scheduled run in the main session', () => {
  it.each(['single', 'smart'] as const)('a %s group: a new main-area card, the chat key, no judge, no reaction, no reminder', async kind => {
    // Reminded after every run, a person's turn included: a scheduled turn has nobody to remind.
    const { orchestrator, channel, runScheduled } = await start(kind, { completionReminder: { mode: 'always' } });
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.getSession).toHaveBeenCalledWith('chat');
    expect(run.consumed[0]!.text).toContain('（定时任务「日报」· 每天 09:00 · 第 1 次。现在没有人在场');
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done', messageId: 'card' });
    expect(cardOpts()).toEqual({ replyTo: '', replyInThread: false });
    expect(fake.send).not.toHaveBeenCalled(); // no root message
    expect(fake.reply).not.toHaveBeenCalled(); // no completion reminder
    expect(channel.rawClient.im.v1.messageReaction.create).not.toHaveBeenCalled();
    expect(spy.judge).not.toHaveBeenCalled();
    void orchestrator;
  });

  it('queues behind a person\'s turn without steering, and its card quotes neither the person nor the card before', async () => {
    const { orchestrator, runScheduled } = await start('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await orchestrator.onMessage(human('先帮我看看这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('定时任务「日报」');
    run.turns[1]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done' });
    expect(cardOpts(1)).toEqual({ replyTo: '', replyInThread: false });
  });

  it('a person\'s message during the scheduled turn queues instead of steering into it', async () => {
    const { orchestrator, runScheduled } = await start('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    await orchestrator.onMessage(human('插一句'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done' });
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('插一句');
    run.turns[1]!.resolve();
  });
});

describe('a scheduled run in a new topic', () => {
  it.each([
    ['a multi group, follow', 'multi', false, 'follow'],
    ['a topic group, follow', 'single', true, 'follow'],
    ['a single group, newTopic', 'single', false, 'newTopic'],
  ] as const)('%s: a text root first, then the card in thread under it', async (_name, kind, topicGroup, placement) => {
    const { runScheduled } = await start(kind);
    fake.topicGroup = topicGroup;
    const run = thread();
    fake.backend.startThread.mockResolvedValue(run.t);
    const result = runScheduled(job({ placement: { kind: placement } }, { nth: 3 }));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.send).toHaveBeenCalledWith('chat', { text: '⏰ 定时任务「日报」· 第 3 次' });
    expect(cardOpts()).toEqual({ replyTo: 'root', replyInThread: true });
    expect(run.consumed[0]!.text).toContain('任务内容：写今天的日报');
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done', messageId: 'card', topicId: 'topic-new' });
    expect(topics.note).toHaveBeenCalledOnce();
    expect(topics.note).toHaveBeenCalledWith('chat', expect.objectContaining({ topicId: 'topic-new', from: { kind: 'self' }, first: expect.objectContaining({ id: 'root' }) }));
  });

  it('a task named with an <at> tag: its root message @-s nobody', async () => {
    const { runScheduled } = await start('multi');
    const run = thread();
    fake.backend.startThread.mockResolvedValue(run.t);
    const result = runScheduled(job({ name: '<at user_id="all"></at>' }));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.send).toHaveBeenCalledWith('chat', { text: '⏰ 定时任务「@所有人」· 第 1 次' });
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('<at');
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });
});

describe('a scheduled run back in its topic', () => {
  it('replies in thread under the topic\'s latest message', async () => {
    const { runScheduled } = await start('multi');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = runScheduled(job({ placement: { kind: 'topic', topicId: 'topic-old' } }));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(fake.topicList).toHaveBeenCalledWith({ params: expect.objectContaining({ container_id_type: 'thread', container_id: 'topic-old' }) });
    expect(cardOpts()).toEqual({ replyTo: 'anchor', replyInThread: true });
    expect(fake.send).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done', topicId: 'topic-old' });
  });

  it('a topic that cannot be found sends the run where the group would, and says so', async () => {
    const { runScheduled } = await start('single');
    fake.topicList.mockRejectedValueOnce(new Error('gone'));
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = runScheduled(job({ placement: { kind: 'topic', topicId: 'topic-old' } }));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('第 1 次 · 原话题找不到了，这次发在这里。');
    expect(cardOpts()).toEqual({ replyTo: '', replyInThread: false });
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });
});

describe('a group that changes while the run is placed', () => {
  // The chat's mode is asked of Feishu before the run starts; what changes meanwhile is not run with.
  async function placing() {
    const started = await start('single');
    const chat = deferred<unknown>();
    fake.chatGet.mockImplementationOnce(() => chat.promise);
    const result = started.runScheduled(job());
    await until(() => expect(fake.chatGet).toHaveBeenCalled());
    return { ...started, result, answer: (mode = 'group') => chat.resolve({ code: 0, data: { chat_mode: mode } }) };
  }

  const disable = () => { fake.project = { ...fake.project, enabled: false }; };
  it.each([
    ['disabled', disable, 'group'],
    ['unbound', () => { fake.project = undefined; }, 'group'],
    ['edited', () => { fake.project = { ...fake.project, cwd: '/elsewhere' }; }, 'group'],
    ['disabled in a topic group', disable, 'topic'],
  ] as const)('%s meanwhile: skipped, no session, no card, not a word', async (_name, change, mode) => {
    const { result, answer } = await placing();
    change();
    answer(mode);
    await expect(result).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(fake.backend.startThread).not.toHaveBeenCalled();
    expect(fake.createCard).not.toHaveBeenCalled();
    expect(fake.send).not.toHaveBeenCalled();
  });

  it('a desktop edit of the group meanwhile is refused, as during a message\'s intake', async () => {
    const { orchestrator, result, answer } = await placing();
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await expect(orchestrator.collaboration({ action: 'editProject', projectName: 'test', chatId: 'chat',
      expectedRevision: projectRevision(fake.project as never), enabled: false })).rejects.toThrow('Agent 正在执行任务');
    answer();
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done' });
  });
});
