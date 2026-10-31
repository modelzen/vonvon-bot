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
    expect(run.t.close).toHaveBeenCalledOnce();
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
    expect(run.t.close).toHaveBeenCalledOnce();
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
    expect(run.t.close).toHaveBeenCalled();
    card.resolve('card');
    await expect(result).resolves.toMatchObject(SHUTDOWN);
    await closing;
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
});
