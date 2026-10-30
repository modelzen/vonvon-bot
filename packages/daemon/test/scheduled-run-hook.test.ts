import { fake, human, job, setup, thread, until } from './helpers/scheduled-run';
import { afterEach, describe, expect, it, vi } from 'vitest';

// T2 4.1 第 5 条、4.2: every way a scheduled turn ends or is dropped settles it once, with the right outcome.
const spy = vi.hoisted(() => ({ saveSync: vi.fn() }));
vi.mock('../src/bot/restart-dropped', async (original) => ({
  ...await original<object>(), createDroppedReplies: () => ({ start() {}, saveSync: spy.saveSync, appendSync() {} }),
}));
let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { await current?.orchestrator.shutdown(); current = undefined; });
async function start(kind: 'single' | 'multi' = 'single', droppedFile?: string) {
  current = await setup(kind, { droppedFile });
  const run = thread();
  fake.backend.resumeThread.mockResolvedValue(run.t);
  return { ...current, run };
}
const stop = (card = 'card') => current!.orchestrator.dispatcher.handle(
  { messageId: card, chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: 'run.stop', m: card } } } as never);

describe('a scheduled turn that runs', () => {
  it('settles done with the final text\'s first 500 characters and its card', async () => {
    const { runScheduled, run } = await start();
    const result = runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    run.say('甲'.repeat(600));
    run.turns[0]!.resolve();
    const outcome = await result;
    expect(outcome).toMatchObject({ status: 'done', messageId: 'card', durationMs: expect.any(Number) });
    expect(outcome.status === 'done' && outcome.excerpt).toBe('甲'.repeat(500));
  });

  it('behind a person: its own text, settled as it ends while the next person\'s turn runs', async () => {
    const { orchestrator, runScheduled, run } = await start();
    await orchestrator.onMessage(human('第一个人'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    run.say('真人的回答', 0);
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    await orchestrator.onMessage(human('第二个人'));
    await until(() => expect(fake.log.info.mock.calls.filter(([, event]) => event === 'queued')).toHaveLength(2));
    run.say('定时的回答', 1);
    run.turns[1]!.resolve();
    await expect(result).resolves.toMatchObject({ status: 'done', excerpt: '定时的回答' });
    await until(() => expect(run.consumed).toHaveLength(3));
    expect(run.consumed[2]!.text).toContain('第二个人');
    run.turns[2]!.resolve();
  });

  it('a backend failure counts; a Feishu that cannot be reached before any card does not', async () => {
    const { runScheduled, run } = await start();
    const failed = runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.reject(new Error('backend crashed'));
    await expect(failed).resolves.toMatchObject({ status: 'failed', error: 'backend crashed', counts: true, messageId: 'card' });
    fake.createCard.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(runScheduled(job())).resolves.toMatchObject({ status: 'failed', counts: false });
    expect(fake.send).toHaveBeenLastCalledWith('chat', { markdown: expect.stringContaining('ECONNREFUSED') }, { replyTo: '', replyInThread: false });
  });

  it('the stop button settles it interrupted by the user; the shutdown after it changes nothing', async () => {
    const { orchestrator, runScheduled, run } = await start();
    run.t.abort.mockImplementation(async () => { run.turns[0]!.resolve(); return undefined; });
    const result = runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    await stop();
    await expect(result).resolves.toMatchObject({ status: 'interrupted', by: 'user', messageId: 'card' });
    await orchestrator.shutdown();
    await expect(result).resolves.toMatchObject({ by: 'user' });
  });
});

describe('a scheduled turn dropped before it runs', () => {
  it('a shutdown settles a running one and a queued one, waits on neither, and keeps neither for a reply', async () => {
    const { orchestrator, runScheduled, run } = await start('single', 'dropped.json');
    const running = runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    await orchestrator.onMessage(human('排队的人'));
    const queued = runScheduled(job({ id: 'st_00000000000000a2' }));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 2 }));
    await orchestrator.shutdown();
    await expect(running).resolves.toMatchObject({ status: 'interrupted', by: 'shutdown', messageId: 'card' });
    await expect(queued).resolves.toEqual({ status: 'interrupted', by: 'shutdown' });
    const kept = JSON.stringify(spy.saveSync.mock.calls[0]![0]);
    expect(kept).toContain('msg-');
    expect(kept).not.toContain('vsched_');
    await expect(runScheduled(job())).resolves.toEqual({ status: 'interrupted', by: 'shutdown' });
  });

  it('queued behind a turn that failed: a counted failure that took no time, and nobody is asked to resend it', async () => {
    const { orchestrator, runScheduled, run } = await start();
    await orchestrator.onMessage(human('会失败的一轮'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    run.turns[0]!.reject(new Error('backend crashed'));
    await expect(result).resolves.toEqual({ status: 'failed', error: '前一轮出错', durationMs: 0, counts: true });
    await until(() => expect(fake.send).toHaveBeenCalledWith('chat', { markdown: '❌ backend crashed' }, expect.anything()));
  });

  it('a group that changed since the gate: skipped, without a word', async () => {
    const { runScheduled } = await start();
    fake.project = { ...fake.project, enabled: false };
    await expect(runScheduled(job())).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.createCard).not.toHaveBeenCalled();
  });

  it('a /goal holding the session: skipped, without the goal-busy reply', async () => {
    const { orchestrator, runScheduled, run } = await start();
    fake.backend.resumeThread.mockResolvedValue({ ...run.t, runGoal: () => run.t.runStreamed({ text: 'goal' }), clearGoal: vi.fn(async () => undefined) });
    await orchestrator.onMessage(human('/goal 写完周报'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await expect(runScheduled(job())).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('目标运行中');
    run.turns[0]!.resolve();
  });

  it('held by a /new it came before: skipped, without the before-new reply', async () => {
    const { orchestrator, runScheduled } = await start();
    let swap!: (t: unknown) => void;
    fake.backend.startThread.mockImplementationOnce(() => new Promise(resolve => { swap = resolve; }));
    await orchestrator.onMessage({ ...human('/new'), createTime: Date.now() + 60_000 });
    await until(() => expect(fake.backend.startThread).toHaveBeenCalled());
    const result = runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'deferred', expect.anything()));
    swap(thread().t);
    await expect(result).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('之前发的');
  });
});
