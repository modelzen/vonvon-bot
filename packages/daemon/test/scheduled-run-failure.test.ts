import { deferred, fake, human, job, setup, SLOT, thread, until } from './helpers/scheduled-run';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import type { ScheduledJob } from '../src/bot/schedule/types';
import type { AppConfig } from '../src/config/schema';
import { addProject, listProjects } from '../src/project/registry';

// T2 4.1 第 7 条、4.2: a scheduled turn that fails offers no 🔁 重试 (its next run, if it has one, is the retry), and one queued behind
// a turn that died fails with it; only a ⏹ is the user's, and a settings change's eviction the group's.
const idle = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock('../src/config/schema', async (original) => {
  const schema = await original<typeof import('../src/config/schema')>();
  return { ...schema, getRunIdleTimeoutMs: (cfg: AppConfig) => idle.ms ?? schema.getRunIdleTimeoutMs(cfg) };
});
const NETWORK: AgentEvent = { type: 'error', message: 'stream disconnected', willRetry: false, kind: 'network' };

let current: Awaited<ReturnType<typeof setup>> | undefined;
const getSession = fake.getSession.getMockImplementation()!;
afterEach(async () => {
  idle.ms = undefined;
  await current?.orchestrator.shutdown();
  current = undefined;
  fake.getSession.mockImplementation(getSession);
});
const finalCard = () => JSON.stringify(fake.final.mock.calls.at(-1)![1]);
type Orchestrator = Awaited<ReturnType<typeof setup>>['orchestrator'];
/** setPermissionMode finds the group in the registry, which lasts as long as the file's HOME: bound once. */
const bound = async () => { if (!(await listProjects()).some(p => p.name === 'test')) await addProject(fake.project as never); };
/** The run's task in the bot's schedules.json, as the scheduler claimed it; the orchestrator's store reads it at its first request. */
async function stored(o: Orchestrator, scheduled: ScheduledJob): Promise<ScheduledJob> {
  const file = (await import('../src/config/paths')).botPaths('app').schedulesFile;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [scheduled.task] }));
  await o.schedule('cli', { action: 'listBot' });
  return scheduled;
}
const ASK: AgentEvent = { type: 'ask', request: { id: 'q1', kind: 'confirmation', title: '继续吗', detail: '要改文件', acceptedConsequence: '改', declinedConsequence: '不改' } };

describe('a scheduled turn that fails', () => {
  const NEXT = '连不上模型服务，可能是网络断了，或者服务暂时不可用。下一次定时运行会再试；也可以在任务里手动运行。';
  const NO_NEXT = '连不上模型服务，可能是网络断了，或者服务暂时不可用。可以在任务里手动运行。';
  // Only a scheduled run of an active task with a next slot, short of the auto-pause, has a next run to promise.
  it.each([
    ['a daily task', () => job(), NEXT],
    ['a once task', () => job({ spec: { kind: 'once', at: SLOT } }), NO_NEXT],
    ['a manual run of a paused task', () => job({ state: 'paused', pausedReason: 'manual' }, { trigger: 'manual' }), NO_NEXT],
    ['a manual run of an active daily task', () => job({}, { trigger: 'manual' }), NO_NEXT],
    ['the tenth failure in a row, which pauses it', () => job({ counts: { runs: 9, missed: 0, skipped: 0, consecutiveFailures: 9 } }), NO_NEXT],
  ] as const)('on the network, %s: its final card has no 重试, and says what comes next', async (_name, scheduled, advice) => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = current.runScheduled(await stored(current.orchestrator, scheduled()));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.end(NETWORK);
    await expect(result).resolves.toMatchObject({ status: 'failed', error: '网络失败：stream disconnected', counts: true, messageId: 'card' });
    expect(finalCard()).toContain('网络失败');
    expect(finalCard()).not.toContain('run.retry');
    expect(finalCard()).toContain(advice);
    if (advice === NO_NEXT) expect(finalCard()).not.toContain('下一次定时运行');
    expect(finalCard()).not.toContain('重发本条消息');
  });

  // The promise is read from the task as it is when the run ends, not as it was claimed.
  it.each([
    ['paused', (o: Orchestrator) => o.schedule('cli', { action: 'pause', chatId: 'chat', taskId: 'st_00000000000000a1' })],
    ['deleted', (o: Orchestrator) => o.schedule('cli', { action: 'delete', chatId: 'chat', taskId: 'st_00000000000000a1', revision: 'r1' })],
  ] as const)('on the network, a daily task %s during the run: no next run is promised', async (_name, change) => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = current.runScheduled(await stored(current.orchestrator, job()));
    await until(() => expect(run.consumed).toHaveLength(1));
    await expect(change(current.orchestrator)).resolves.not.toMatchObject({ kind: 'refused' });
    run.end(NETWORK);
    await expect(result).resolves.toMatchObject({ status: 'failed', counts: true });
    expect(finalCard()).toContain(NO_NEXT);
    expect(finalCard()).not.toContain('下一次定时运行');
  });

  it('idle until the watchdog stops it: its final card has no 重试', async () => {
    idle.ms = 300;
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = current.runScheduled(job());
    await expect(result).resolves.toMatchObject({ status: 'failed', error: expect.stringContaining('没有输出，已自动停止'), messageId: 'card' });
    expect(finalCard()).toContain('没有输出');
    expect(finalCard()).not.toContain('run.retry');
  });

  it('stopped by its own ask fault: failed and counted, not stopped by the user', async () => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    run.t.abort.mockImplementation(async () => { run.turns[0]!.resolve(); return undefined; });
    const result = current.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    // The fake turn has no respondToAsk: the ask coordinator faults and stops it.
    run.emit(ASK);
    await expect(result).resolves.toMatchObject({ status: 'failed', error: '提问出错', counts: true, messageId: 'card' });
  });

  // A turn a ⏹ or the shutdown stopped answers a late ask "unavailable": that answer failing too did not stop it.
  it.each([
    ['the shutdown', { status: 'interrupted', by: 'shutdown' }, (o: Orchestrator) => o.shutdown()],
    ['a ⏹', { status: 'interrupted', by: 'user' }, (o: Orchestrator) => o.dispatcher.handle(
      { messageId: 'card', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: 'run.stop', m: 'card' } } } as never)],
  ] as const)('stopped by %s, then a late ask whose answer fails: interrupted, not failed', async (_name, outcome, stop) => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const respondToAsk = vi.fn(async (..._args: unknown[]) => { throw new Error('turn already over'); });
    const runStreamed = run.t.runStreamed.bind(run.t);
    run.t.runStreamed = (input) => Object.assign(runStreamed(input), { respondToAsk });
    // The stop's turn/interrupt: the agent asks once more as the turn ends.
    run.t.abort.mockImplementation(async () => { run.emit(ASK); run.turns[0]!.resolve(); return undefined; });
    const result = current.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    await stop(current.orchestrator);
    await expect(result).resolves.toMatchObject(outcome);
    expect(respondToAsk).toHaveBeenCalledWith('q1', { kind: 'unanswered', reason: 'unavailable' });
  });
});

describe('a scheduled turn queued behind a person\'s', () => {
  const FAILED = { status: 'failed', error: '前一轮出错', durationMs: 0, counts: true };
  it.each([
    ['whose process died', undefined, (run: ReturnType<typeof thread>) => { run.t.isAlive = () => false; run.turns[0]!.resolve(); }],
    ['the watchdog stopped', 300, () => undefined],
    ['whose /compact killed the process', undefined, async (run: ReturnType<typeof thread>, o: Orchestrator) => {
      Object.assign(run.t, { compact: async () => { run.t.isAlive = () => false; return {}; } });
      await o.onMessage(human('/compact'));
      await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'compact-queued', expect.anything()));
      run.turns[0]!.resolve();
    }],
    ['stopped by an ask fault, not a ⏹', undefined, (run: ReturnType<typeof thread>) => {
      run.t.abort.mockImplementation(async () => { run.turns[0]!.resolve(); return undefined; });
      // The fake turn has no respondToAsk: the ask coordinator faults and stops it.
      run.emit(ASK);
    }],
  ] as const)('%s: failed, not stopped by the user', async (_name, idleMs, end) => {
    idle.ms = idleMs;
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    await current.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = current.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    await end(run, current.orchestrator);
    await expect(result).resolves.toEqual(FAILED);
    expect(run.consumed).toHaveLength(1);
  });

  it('that the user stopped: interrupted by the user', async () => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    run.t.abort.mockImplementation(async () => { run.turns[0]!.resolve(); return undefined; });
    await current.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = current.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    await current.orchestrator.dispatcher.handle(
      { messageId: 'card', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: 'run.stop', m: 'card' } } } as never);
    await expect(result).resolves.toEqual({ status: 'interrupted', by: 'user' });
  });

  it('whose session a settings change closed: skipped, the group changed', async () => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    // Closing the thread ends its turn as a process that died does.
    run.t.close.mockImplementation(async () => { run.t.isAlive = () => false; run.turns[0]!.resolve(); });
    fake.listSessions.mockResolvedValue([{ threadId: 'chat', chatId: 'chat' }]);
    await bound();
    await current.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = current.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    await expect(current.orchestrator.adminExecute({ kind: 'setPermissionMode', project: 'test', mode: 'full' })).resolves.toEqual({ kind: 'done' });
    await expect(result).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(run.consumed).toHaveLength(1);
  });

  // procDead is read before the person's final card goes out: a settings change while it goes out closes the thread all
  // the same, and the turn queued behind does not run on it.
  it('whose session a settings change closed while its final card went out: skipped, not run on the closed thread', async () => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    run.t.close.mockImplementation(async () => { run.t.isAlive = () => false; });
    const runStreamed = run.t.runStreamed.bind(run.t);
    run.t.runStreamed = (input) => {
      if (!run.t.isAlive()) throw new Error('thread closed');
      return runStreamed(input);
    };
    fake.listSessions.mockResolvedValue([{ threadId: 'chat', chatId: 'chat' }]);
    await bound();
    const hold = deferred<boolean>();
    fake.final.mockImplementationOnce(() => hold.promise);
    await current.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalledOnce());
    const result = current.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    await expect(current.orchestrator.adminExecute({ kind: 'setPermissionMode', project: 'test', mode: 'full' })).resolves.toEqual({ kind: 'done' });
    expect(run.t.close).toHaveBeenCalledOnce();
    hold.resolve(true);
    await expect(result).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(run.consumed).toHaveLength(1);
  });

  // The person's turn holds the session but has no thread yet: a settings change in that window closes the thread all
  // the same. On a real backend the closed thread may also throw when the turn starts.
  it.each([
    ['ends as a process that died', false],
    ['throws as the turn starts', true],
  ])('whose session a settings change closed while the turn was being prepared, and the turn %s: skipped', async (_name, throws) => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    run.t.close.mockImplementation(async () => { run.t.isAlive = () => false; });
    const runStreamed = run.t.runStreamed.bind(run.t);
    run.t.runStreamed = (input) => {
      if (throws && !run.t.isAlive()) throw new Error('thread closed');
      return runStreamed(input);
    };
    fake.listSessions.mockResolvedValue([{ threadId: 'chat', chatId: 'chat' }]);
    await bound();
    // Holds the turn's own read of the session record (beside resolveThread's), so the turn is still being prepared.
    const hold = deferred<void>();
    let held = false;
    fake.getSession.mockImplementation(async (key: string) => {
      const stack = new Error().stack ?? '';
      if (stack.includes('startReservedRun') && !stack.includes('resolveThread')) { held = true; await hold.promise; }
      return getSession(key);
    });
    await current.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('agent', 'resume-ok', expect.anything()));
    const result = current.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    await expect(current.orchestrator.adminExecute({ kind: 'setPermissionMode', project: 'test', mode: 'full' })).resolves.toEqual({ kind: 'done' });
    expect(held).toBe(true);
    expect(run.t.close).toHaveBeenCalledOnce();
    expect(run.consumed).toHaveLength(0);
    hold.resolve();
    if (!throws) {
      await until(() => expect(run.consumed).toHaveLength(1));
      run.turns[0]!.resolve();
    }
    await expect(result).resolves.toEqual({ status: 'skipped', reason: 'updating' });
  });
});
