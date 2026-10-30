import { fake, human, job, setup, thread, until } from './helpers/scheduled-run';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { addProject } from '../src/project/registry';

// T2 4.1 第 7 条、4.2: a scheduled turn that fails offers no 🔁 重试 (its next run is the retry), and one queued behind
// a turn that died fails with it; only a ⏹ is the user's, and a settings change's eviction the group's.
const idle = vi.hoisted(() => ({ ms: undefined as number | undefined }));
vi.mock('../src/config/schema', async (original) => {
  const schema = await original<typeof import('../src/config/schema')>();
  return { ...schema, getRunIdleTimeoutMs: (cfg: AppConfig) => idle.ms ?? schema.getRunIdleTimeoutMs(cfg) };
});
const NETWORK: AgentEvent = { type: 'error', message: 'stream disconnected', willRetry: false, kind: 'network' };

let current: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => { idle.ms = undefined; await current?.orchestrator.shutdown(); current = undefined; });
const finalCard = () => JSON.stringify(fake.final.mock.calls.at(-1)![1]);
type Orchestrator = Awaited<ReturnType<typeof setup>>['orchestrator'];

describe('a scheduled turn that fails', () => {
  it('on the network: its final card has no 重试, and says the next run tries again', async () => {
    current = await setup('single');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const result = current.runScheduled(job());
    await until(() => expect(run.consumed).toHaveLength(1));
    run.end(NETWORK);
    await expect(result).resolves.toMatchObject({ status: 'failed', error: '网络失败：stream disconnected', counts: true, messageId: 'card' });
    expect(finalCard()).toContain('网络失败');
    expect(finalCard()).not.toContain('run.retry');
    expect(finalCard()).toContain('下一次定时运行会再试；也可以在任务里手动运行。');
    expect(finalCard()).not.toContain('重发本条消息');
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
      run.emit({ type: 'ask', request: { id: 'q1', kind: 'confirmation', title: '继续吗', detail: '要改文件', acceptedConsequence: '改', declinedConsequence: '不改' } });
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
    await addProject(fake.project as never);
    await current.orchestrator.onMessage(human('先跑这个'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const result = current.runScheduled(job());
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    await expect(current.orchestrator.adminExecute({ kind: 'setPermissionMode', project: 'test', mode: 'full' })).resolves.toEqual({ kind: 'done' });
    await expect(result).resolves.toEqual({ status: 'skipped', reason: 'updating' });
    expect(run.consumed).toHaveLength(1);
  });
});
