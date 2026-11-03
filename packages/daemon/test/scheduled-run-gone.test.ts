import { deferred, fake, human, job, setup, thread, until } from './helpers/scheduled-run';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import { addProject, listProjects } from '../src/project/registry';

// T2 做法: a turn that fails, or is about to start, after its session went is settled by why it went. A settings change's
// eviction skips a scheduled turn and asks a person to resend, as the queue's drop does; the shutdown interrupts a scheduled
// turn and keeps a person's for redelivery. Neither is a counted failure, nor answered with ❌.
const dropped = vi.hoisted(() => ({ appendSync: vi.fn() }));
vi.mock('../src/bot/restart-dropped', async (original) => ({
  ...await original<object>(), createDroppedReplies: () => ({ start() {}, saveSync() {}, appendSync: dropped.appendSync }),
}));

let current: Awaited<ReturnType<typeof setup>> | undefined;
const getSession = fake.getSession.getMockImplementation()!;
afterEach(async () => {
  await current?.orchestrator.shutdown();
  current = undefined;
  fake.getSession.mockImplementation(getSession);
});
/** setPermissionMode finds the group in the registry, which lasts as long as the file's HOME: bound once. */
const bound = async () => { if (!(await listProjects()).some(p => p.name === 'test')) await addProject(fake.project as never); };
const CLOSED: AgentEvent = { type: 'error', message: 'app-server client closed', willRetry: false };
const SKIPPED = { status: 'skipped', reason: 'updating' };
const SHUTDOWN = { status: 'interrupted', by: 'shutdown' };
const sent = () => fake.send.mock.calls.map(([, input]) => (input as { markdown?: string }).markdown ?? '');
const evict = () => expect(current!.orchestrator.adminExecute({ kind: 'setPermissionMode', project: 'test', mode: 'full' })).resolves.toEqual({ kind: 'done' });
const stop = (card: string) => current!.orchestrator.dispatcher.handle(
  { messageId: card, chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: 'run.stop', m: card } } } as never);

/** The group's session, which a settings change or the shutdown closes: dead after, its turns end with the closed client's
 * error, and so does a turn started on it (as Codex's turn/start does); injecting context into it rejects. */
async function session() {
  current = await setup('single', { droppedFile: 'dropped.json', preferences: { pendingPolicy: 'queue' } });
  const run = thread();
  fake.backend.resumeThread.mockResolvedValue(run.t);
  run.t.close.mockImplementation(async () => {
    run.t.isAlive = () => false;
    run.turns.forEach((_, i) => run.end(CLOSED, i));
  });
  const runStreamed = run.t.runStreamed.bind(run.t);
  run.t.runStreamed = (input) => {
    const started = runStreamed(input);
    if (!run.t.isAlive()) run.end(CLOSED, run.turns.length - 1);
    return started;
  };
  run.t.injectContext.mockImplementation(async () => { if (!run.t.isAlive()) throw new Error('app-server client closed'); });
  fake.listSessions.mockResolvedValue([{ threadId: 'chat', chatId: 'chat' }]);
  await bound();
  return run;
}

describe('a queued turn whose session went before it started', () => {
  // When: in the run's awaits before the turn, or as its context update is injected (Codex's thread/inject_items on the
  // closed client; a role or supplement edit gives the turn one).
  it.each([
    ['a settings change', 'scheduled', 'in the awaits before it'],
    ['a settings change', 'scheduled', 'as its context was injected'],
    ['a settings change', 'person', 'in the awaits before it'],
    ['a settings change', 'person', 'as its context was injected'],
    ['the shutdown', 'scheduled', 'in the awaits before it'],
    ['the shutdown', 'scheduled', 'as its context was injected'],
    ['the shutdown', 'person', 'in the awaits before it'],
    ['the shutdown', 'person', 'as its context was injected'],
  ] as const)('closed by %s, a %s turn, %s: theirs, not a failure', async (by, who, when) => {
    const run = await session();
    if (when === 'as its context was injected') fake.contextUpdate = '（本群的角色改了）';
    // Holds the run's first read of the session record after the first turn's final card: the queued turn's, at the loop's top.
    const hold = deferred<void>();
    let armed = false;
    let held = false;
    fake.final.mockImplementationOnce(async () => { armed = true; return true; });
    fake.getSession.mockImplementation(async (key: string) => {
      if (armed && !held && (new Error().stack ?? '').includes('launchRun')) { held = true; await hold.promise; }
      return getSession(key);
    });
    await current!.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const msg = human('排一条');
    const result = who === 'scheduled' ? current!.runScheduled(job()) : undefined;
    if (who === 'person') await current!.orchestrator.onMessage(msg);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    run.turns[0]!.resolve();
    await until(() => expect(held).toBe(true));
    const closing = by === 'the shutdown' ? current!.orchestrator.shutdown() : evict();
    if (by === 'a settings change') await closing;
    await until(() => expect(run.t.close).toHaveBeenCalledOnce());
    hold.resolve();
    if (result) await expect(result).resolves.toMatchObject(by === 'the shutdown' ? SHUTDOWN : SKIPPED);
    await closing;
    if (who === 'person' && by === 'a settings change') await until(() => expect(sent()).toContain('⚠️ 1 条排队消息已丢弃，请重发。'));
    if (who === 'person' && by === 'the shutdown') expect(dropped.appendSync).toHaveBeenCalledWith(expect.objectContaining({ messageId: msg.messageId }));
    expect(sent().filter(text => text.startsWith('❌'))).toEqual([]);
    expect(run.consumed).toHaveLength(1);
  });
});

describe('a scheduled turn that is its session\'s first', () => {
  // A person's first turn evicted there still runs (scheduled-run-failure).
  it('whose session a settings change closed while it was prepared: skipped, not run on the closed thread', async () => {
    const run = await session();
    // Holds the turn's own read of the session record (beside resolveThread's), so the turn is still being prepared.
    const hold = deferred<void>();
    let held = false;
    fake.getSession.mockImplementation(async (key: string) => {
      const stack = new Error().stack ?? '';
      if (stack.includes('startReservedRun') && !stack.includes('resolveThread')) { held = true; await hold.promise; }
      return getSession(key);
    });
    const result = current!.runScheduled(job());
    await until(() => expect(held).toBe(true));
    await evict();
    await until(() => expect(run.t.close).toHaveBeenCalledOnce());
    hold.resolve();
    await expect(result).resolves.toEqual(SKIPPED);
    expect(run.consumed).toHaveLength(0);
  });
});

describe('a scheduled turn whose session went while it ran', () => {
  it('closed by a settings change: skipped, not a failure', async () => {
    const run = await session();
    const result = current!.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    await evict();
    await expect(result).resolves.toEqual(SKIPPED);
  });

  // The shutdown stops the turns it finds running; one whose card is still being created has nothing to stop yet.
  it('closed by the shutdown before it could be stopped: interrupted by the shutdown, not a failure', async () => {
    const run = await session();
    const card = deferred<string>();
    fake.createCard.mockImplementationOnce(() => card.promise);
    const result = current!.runScheduled(job());
    await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
    const closing = current!.orchestrator.shutdown();
    await until(() => expect(run.t.close).toHaveBeenCalled());
    card.resolve('card');
    await expect(result).resolves.toMatchObject(SHUTDOWN);
    await closing;
  });
});

describe('a scheduled turn that failed on its own', () => {
  // Its session was there as its events ended: what stops the bot or changes the group while its result is delivered
  // does not make the failure theirs.
  it.each(['the shutdown', 'a settings change'] as const)('and %s while its final card was updated: a counted failure', async (by) => {
    const run = await session();
    const hold = deferred<boolean>();
    fake.final.mockImplementationOnce(() => hold.promise);
    const result = current!.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    run.end({ type: 'error', message: 'model overloaded', willRetry: false });
    await until(() => expect(fake.final).toHaveBeenCalledOnce());
    const closing = by === 'the shutdown' ? current!.orchestrator.shutdown() : evict();
    if (by === 'a settings change') await closing;
    await until(() => expect(run.t.close).toHaveBeenCalled());
    hold.resolve(true);
    await expect(result).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('model overloaded'), counts: true });
    await closing;
  });
});

describe('a first turn that waited for the only run slot, stopped before it took its queue card over', () => {
  /** The one slot held by a person's turn in a topic; the main session's next run waits for it with a queue card. */
  async function oneSlot() {
    current = await setup('single', { droppedFile: 'dropped.json', preferences: { maxConcurrentRuns: 1 } });
    const busy = thread(), waiting = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(busy.t).mockResolvedValue(waiting.t);
    fake.createCard.mockResolvedValueOnce('card-busy').mockResolvedValueOnce('card-waiting');
    fake.listSessions.mockResolvedValue([{ threadId: 'chat', chatId: 'chat' }]);
    await bound();
    await current.orchestrator.onMessage(human('占着唯一的槽', 'topic-busy'));
    await until(() => expect(busy.consumed).toHaveLength(1));
    return { busy, waiting };
  }
  /** The updates of the queue card: those of the stream that created it, the second card created. */
  const queueCard = () => {
    const stream = fake.createCard.mock.contexts[1];
    return fake.final.mock.calls.filter((_, i) => fake.final.mock.contexts[i] === stream).map(([, card]) => JSON.stringify(card));
  };

  it('a scheduled turn whose session a settings change closed: its queue card is cancelled, and its ⏹ is gone', async () => {
    const { busy, waiting } = await oneSlot();
    const result = current!.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'run-queued', expect.anything()));
    await until(() => expect(queueCard()).toHaveLength(1));
    await evict();
    expect(waiting.t.close).toHaveBeenCalledOnce();
    busy.turns[0]!.resolve();
    await expect(result).resolves.toEqual(SKIPPED);
    await until(() => expect(queueCard()).toHaveLength(2));
    expect(queueCard()[1]).toContain('已取消排队');
    expect(queueCard()[1]).not.toContain('run.stop');
    expect(waiting.consumed).toHaveLength(0);
    // Not a stop target any more: the tap says the card is over.
    await stop('card-waiting');
    expect(fake.log.info).toHaveBeenCalledWith('card', 'action', expect.objectContaining({ actionId: 'run.stop', orphan: true }));
  });

  it('a person\'s, the shutdown starting as its context was injected: its queue card says the bot stopped', async () => {
    const { busy, waiting } = await oneSlot();
    const msg = human('等槽');
    await current!.orchestrator.onMessage(msg);
    await until(() => expect(queueCard()).toHaveLength(1));
    fake.contextUpdate = '（本群的角色改了）';
    const inject = deferred<undefined>();
    waiting.t.injectContext.mockImplementationOnce(() => inject.promise);
    busy.turns[0]!.resolve();
    await until(() => expect(waiting.t.injectContext).toHaveBeenCalledOnce());
    const closing = current!.orchestrator.shutdown();
    inject.resolve(undefined);
    await closing;
    expect(dropped.appendSync).toHaveBeenCalledOnce();
    expect(dropped.appendSync).toHaveBeenCalledWith(expect.objectContaining({ messageId: msg.messageId }));
    expect(queueCard()).toHaveLength(2);
    expect(queueCard()[1]).toContain('bot 停止运行了');
    expect(queueCard()[1]).not.toContain('run.stop');
    expect(waiting.consumed).toHaveLength(0);
  });
});

describe('a person\'s first turn whose session the shutdown closed before it started', () => {
  // The run's awaits before the turn: here, as its context update is injected.
  it.each([
    ['the update went in', false],
    ['the update failed on the closed client', true],
  ] as const)('%s: kept for redelivery, not run on the closed thread', async (_name, rejects) => {
    const run = await session();
    fake.contextUpdate = '（本群的角色改了）';
    const inject = deferred<undefined>();
    run.t.injectContext.mockImplementationOnce(() => inject.promise);
    const msg = human('先跑这个');
    await current!.orchestrator.onMessage(msg);
    await until(() => expect(run.t.injectContext).toHaveBeenCalledOnce());
    const closing = current!.orchestrator.shutdown();
    if (rejects) inject.reject(new Error('app-server client closed'));
    else inject.resolve(undefined);
    await closing;
    expect(dropped.appendSync).toHaveBeenCalledWith(expect.objectContaining({ messageId: msg.messageId }));
    expect(sent().filter(text => text.startsWith('❌'))).toEqual([]);
    expect(run.consumed).toHaveLength(0);
  });
});

describe('a first turn still being prepared when the shutdown started', () => {
  // Its session could not be had any more: Codex's client pool is closed.
  it.each(['scheduled', 'person'] as const)('a %s turn whose session could not be resumed: theirs, not a failure', async (who) => {
    current = await setup('single', { droppedFile: 'dropped.json' });
    const resume = deferred<never>();
    fake.backend.resumeThread.mockImplementation(() => resume.promise);
    fake.backend.startThread.mockRejectedValue(new Error('Codex client pool is closed'));
    const msg = human('先跑这个');
    const result = who === 'scheduled' ? current.runScheduled(job()) : undefined;
    if (who === 'person') await current.orchestrator.onMessage(msg);
    await until(() => expect(fake.backend.resumeThread).toHaveBeenCalledOnce());
    const closing = current.orchestrator.shutdown();
    resume.reject(new Error('Codex client pool is closed'));
    await closing;
    if (result) await expect(result).resolves.toEqual(SHUTDOWN);
    else expect(dropped.appendSync).toHaveBeenCalledWith(expect.objectContaining({ messageId: msg.messageId }));
    expect(sent().filter(text => text.startsWith('❌'))).toEqual([]);
  });

  it('a scheduled run in a new topic whose thread could not be started: the shutdown\'s, not a failure', async () => {
    current = await setup('multi', { droppedFile: 'dropped.json' });
    const start = deferred<never>();
    fake.backend.startThread.mockImplementation(() => start.promise);
    const result = current.runScheduled(job({ placement: { kind: 'newTopic' } }));
    await until(() => expect(fake.backend.startThread).toHaveBeenCalledOnce());
    const closing = current.orchestrator.shutdown();
    start.reject(new Error('Codex client pool is closed'));
    await closing;
    await expect(result).resolves.toEqual(SHUTDOWN);
    expect(sent().filter(text => text.startsWith('❌'))).toEqual([]);
  });

  // The run's first await reads the group; a slot is free, so the turn never waits for one (collectLost has nothing).
  it('a person\'s turn, the shutdown starting as its run read the group: kept for redelivery once, nothing sent', async () => {
    current = await setup('single', { droppedFile: 'dropped.json' });
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const group = fake.project;
    let closing: Promise<void> | undefined;
    Object.defineProperty(fake, 'project', { configurable: true, get: () => {
      if (!closing && (new Error().stack ?? '').includes('launchRun')) closing = current!.orchestrator.shutdown();
      return group;
    } });
    try {
      const msg = human('先跑这个');
      await current.orchestrator.onMessage(msg);
      await until(() => expect(closing).toBeDefined());
      await closing;
      expect(dropped.appendSync).toHaveBeenCalledOnce();
      expect(dropped.appendSync).toHaveBeenCalledWith(expect.objectContaining({ messageId: msg.messageId }));
      expect(fake.send).not.toHaveBeenCalled();
      expect(run.consumed).toHaveLength(0);
    } finally {
      Object.defineProperty(fake, 'project', { value: group, writable: true, configurable: true, enumerable: true });
    }
  });
});
