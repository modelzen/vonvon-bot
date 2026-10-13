import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '../../src/core/logger';
import { KILL_CONFIRM_MS, TERM_WAIT_MS, type StopProfile } from '../../src/provider/engines/engine';
import type { ItemId, RunEvent, StepId, SubagentId, SubagentState, TurnId } from '../../src/provider/model';
import { RunChannel } from '../../src/provider/runtime/run-channel';
import { fakeProcess, fakeSession, type FakeProcessScript } from './fixtures/fake-process';

const claude: StopProfile = { needsTurnId: false, openWaitMs: 0, graceMs: 3000 };
const turnId = 'turn-1' as TurnId;
const childId = 'child-1' as SubagentId;
const child = (): SubagentState => ({ id: childId, status: 'running', task: 'Investigate', startedAt: 0, stepCount: 0, recentSteps: [] });

function channel(script: FakeProcessScript = {}, opts: { subagentStop?: boolean } = {}) {
  const process = fakeProcess(script);
  const session = fakeSession(process, opts);
  const run = new RunChannel({ id: 'run-1', providerSessionId: 'session-1', profile: claude, session });
  let settled = false;
  void run.outcome.then(() => { settled = true; });
  return { run, process, session, settled: () => settled };
}

async function drain(run: RunChannel): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

const types = (events: RunEvent[]) => events.map(event => event.type);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RunChannel: one outcome, last', () => {
  it('drops and counts pushes after a verdict', async () => {
    const { run } = channel();
    run.sink.emit({ type: 'started', turnId });
    run.sink.verdict({ kind: 'completed' });
    run.sink.verdict({ kind: 'failed', failure: { kind: 'refused' } });
    run.sink.emit({ type: 'provider-message', level: 'warn', text: 'too late' });
    run.sink.frame();
    expect(types(await drain(run))).toEqual(['session', 'started', 'outcome']);
    expect(await run.outcome).toEqual({ state: 'completed' });
    expect(run.droppedAfterEnd).toBe(3);
  });

  it('keeps the first of a verdict and an exit fact that race', async () => {
    const a = channel();
    a.run.sink.verdict({ kind: 'completed' });
    a.process.publish({ kind: 'exit', exit: { observed: 'parent', code: 0, signal: null } });
    expect(await drain(a.run)).toEqual([{ type: 'session', providerSessionId: 'session-1' }, { type: 'outcome', outcome: { state: 'completed' } }]);

    const b = channel();
    b.process.publish({ kind: 'exit', exit: { observed: 'parent', code: 1, signal: null } });
    b.run.sink.verdict({ kind: 'completed' });
    expect((await drain(b.run)).filter(event => event.type === 'outcome')).toEqual([
      { type: 'outcome', outcome: { state: 'failed', failure: { kind: 'process-exit', code: 1, signal: null } } },
    ]);
  });

  it('settles from an exit fact replayed at construction and unsubscribes', async () => {
    const process = fakeProcess();
    process.publish({ kind: 'exit', exit: { observed: 'containment' } });
    const run = new RunChannel({ id: 'run-1', providerSessionId: 'session-1', profile: claude, session: fakeSession(process) });
    expect(await run.outcome).toEqual({ state: 'failed', failure: { kind: 'process-exit', code: null, signal: null } });
    expect(process.listeners, 'unsubscribed though watch() had not returned').toBe(0);
  });

  it('settles transport loss while running as failed transport-lost', async () => {
    const { run, process } = channel();
    run.sink.emit({ type: 'started', turnId });
    process.publish({ kind: 'transport-lost' });
    expect(await run.outcome).toEqual({ state: 'failed', failure: { kind: 'transport-lost' } });
  });
});

describe('RunChannel: the stop ladder against the process port', () => {
  it('settles a silent process unconfirmed exactly at the bound, with one term and one kill', async () => {
    const { run, process, session, settled } = channel({ term: 'silent', kill: 'silent' });
    run.sink.emit({ type: 'started', turnId });
    const stopped = run.stop('user');
    expect(session.interrupts).toEqual([turnId]);
    await vi.advanceTimersByTimeAsync(3000 + TERM_WAIT_MS + KILL_CONFIRM_MS - 1);
    expect(settled(), 'not before the bound').toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await stopped).toEqual({ state: 'interrupted', by: 'user', tree: 'unconfirmed' });
    expect(process.calls).toEqual(['term', 'kill']);
    expect(process.listeners, 'unsubscribed at settlement').toBe(0);
    expect(vi.getTimerCount(), 'no timer left').toBe(0);
  });

  it.each([['sent', 'signalled'], ['accepted', 'live'], ['refused', 'live']] as const)('settles a cancel after term receipt %s as %s', async (receipt, tree) => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { run } = channel({ term: receipt });
    run.sink.emit({ type: 'started', turnId });
    const stopped = run.stop('watchdog');
    await vi.advanceTimersByTimeAsync(3001);
    run.sink.verdict({ kind: 'cancelled' });
    expect(await stopped).toEqual({ state: 'interrupted', by: 'watchdog', tree });
    expect(info.mock.calls.some(call => call[1] === 'signal-receipt'), 'only a non-sent receipt is logged').toBe(receipt !== 'sent');
  });

  it('settles exited when the tree exits after term, and ignores the late receipt', async () => {
    const { run } = channel({ receiptDelayMs: 500, exitOn: { call: 'term', afterMs: 100, exit: { observed: 'parent', code: null, signal: 'SIGTERM' } } });
    run.sink.emit({ type: 'started', turnId });
    const stopped = run.stop('user');
    await vi.advanceTimersByTimeAsync(3100);
    expect(await stopped).toEqual({ state: 'interrupted', by: 'user', tree: 'exited' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(types(await drain(run)).filter(type => type === 'outcome')).toEqual(['outcome']);
  });

  it('logs transport loss while stopping and keeps climbing the ladder', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => undefined);
    const { run, process } = channel({ term: 'silent', kill: 'silent' });
    const stopped = run.stop('user');
    process.publish({ kind: 'transport-lost' });
    expect(info).toHaveBeenCalledWith('provider', 'transport-lost-while-stopping', { run: 'run-1' });
    await vi.advanceTimersByTimeAsync(3000 + TERM_WAIT_MS + KILL_CONFIRM_MS);
    expect(await stopped).toEqual({ state: 'interrupted', by: 'user', tree: 'unconfirmed' });
  });

  it.each(['stopSubagent', 'interrupt'] as const)('runs no stale effect, timer, or second outcome after a synchronous %s settles the run', async settles => {
    const process = fakeProcess();
    const interrupts: (TurnId | undefined)[] = [];
    const run: RunChannel = new RunChannel({ id: 'run-1', providerSessionId: 'session-1', profile: claude, session: {
      process,
      interrupt: async id => { interrupts.push(id); if (settles === 'interrupt') run.sink.verdict({ kind: 'completed' }); },
      stopSubagent: async () => { if (settles === 'stopSubagent') run.sink.verdict({ kind: 'completed' }); },
    } });
    run.sink.emit({ type: 'subagent', agent: child() });
    run.sink.emit({ type: 'started', turnId });
    expect(await run.stop('user')).toEqual({ state: 'completed' });
    expect(interrupts, 'an interrupt queued behind the settling callback is not sent').toEqual(settles === 'interrupt' ? [turnId] : []);
    expect(types(await drain(run))).toEqual(['session', 'subagent', 'started', 'subagent', 'outcome']);
    expect(vi.getTimerCount(), 'no timer armed after settlement').toBe(0);
  });

  it.each([[false, ['term', 'kill']], [true, ['term']]] as const)('replays overdue rungs on a late tick, stopping once a synchronous exit settles (%s)', async (exitOnTerm, calls) => {
    const process = fakeProcess({ term: 'silent', kill: 'silent' });
    const term = () => {
      if (exitOnTerm) process.publish({ kind: 'exit', exit: { observed: 'parent', code: null, signal: 'SIGTERM' } });
      return process.term();
    };
    const run = new RunChannel({ id: 'run-1', providerSessionId: 'session-1', profile: claude, session: fakeSession({ ...process, term }) });
    run.sink.emit({ type: 'started', turnId });
    void run.stop('user');
    vi.setSystemTime(Date.now() + 2000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(process.calls).toEqual(calls);
    if (exitOnTerm) expect(await run.outcome).toEqual({ state: 'interrupted', by: 'user', tree: 'exited' });
  });

  it.each([true, false])('stops each running subagent iff the engine can (%s)', async subagentStop => {
    const { run, session } = channel({}, { subagentStop });
    run.sink.emit({ type: 'subagent', agent: child() });
    run.sink.emit({ type: 'subagent', agent: { ...child(), id: 'child-2' as SubagentId, status: 'completed' } });
    void run.stop('user');
    expect(session.stopped).toEqual(subagentStop ? [childId] : []);
  });
});

describe('RunChannel: events and ledgers', () => {
  it('logs and ignores a conflicting second started', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    const { run } = channel();
    run.sink.emit({ type: 'started', turnId });
    run.sink.emit({ type: 'started', turnId: 'other' as TurnId });
    expect(run.turnId()).toBe(turnId);
    expect(warn).toHaveBeenCalledWith('provider', 'duplicate-started', { run: 'run-1', expected: turnId, received: 'other' });
  });

  it('wakes a waiting reader and ends it after the outcome', async () => {
    const { run } = channel();
    const reader = run.events[Symbol.asyncIterator]();
    expect((await reader.next()).value).toEqual({ type: 'session', providerSessionId: 'session-1' });
    const waiting = reader.next();
    run.sink.emit({ type: 'provider-message', level: 'info', text: 'live' });
    expect((await waiting).value).toEqual({ type: 'provider-message', level: 'info', text: 'live' });
    run.sink.verdict({ kind: 'completed' });
    expect((await reader.next()).value).toEqual({ type: 'outcome', outcome: { state: 'completed' } });
    expect(await reader.next()).toEqual({ value: undefined, done: true });
  });

  it('folds subagent steps and todos, and settles running subagents before the outcome', async () => {
    const { run } = channel();
    run.sink.frame();
    run.sink.emit({ type: 'subagent', agent: child() });
    run.sink.emit({ type: 'step', lane: { kind: 'subagent', id: childId }, step: { id: 'step-1' as StepId, title: 'Read', status: 'ok', detail: { type: 'read', path: '/tmp/a' } } });
    run.sink.emit({ type: 'text', lane: { kind: 'main' }, itemId: 'answer' as ItemId, channel: 'answer', delta: 'done' });
    run.sink.emit({ type: 'todo', items: [{ text: 'write answer', status: 'in_progress' }] });
    run.sink.verdict({ kind: 'completed' });
    const events = await drain(run);
    expect(types(events), 'a subagent step folds into its row and a todo is never a step').toEqual(['session', 'subagent', 'subagent', 'text', 'todo', 'subagent', 'outcome']);
    expect(events.at(-2)).toMatchObject({ type: 'subagent', agent: { id: childId, status: 'interrupted', stepCount: 1 } });
    expect(run.subagents().history(childId)?.steps.map(step => step.title)).toEqual(['Read']);
    expect(run.todo()).toEqual([{ text: 'write answer', status: 'in_progress' }]);
  });

  it('folds subagent answer text into its row result, drops its reasoning, and keeps both out of the answer', async () => {
    const { run } = channel();
    const lane = { kind: 'subagent', id: childId } as const;
    const main = { type: 'text', lane: { kind: 'main' }, itemId: 'answer' as ItemId, channel: 'answer', delta: 'main answer' } as const;
    run.sink.emit({ type: 'subagent', agent: child() });
    run.sink.emit({ type: 'text', lane, itemId: 'c1' as ItemId, channel: 'answer', delta: 'CHILD-' });
    run.sink.emit({ type: 'text', lane, itemId: 'c1' as ItemId, channel: 'reasoning', delta: 'THINKING' });
    run.sink.emit({ type: 'text', lane, itemId: 'c1' as ItemId, channel: 'answer', delta: 'ONLY' });
    run.sink.emit({ type: 'text', lane: { kind: 'subagent', id: 'ghost' as SubagentId }, itemId: 'g' as ItemId, channel: 'answer', delta: 'GHOST' });
    run.sink.emit(main);
    expect(run.subagents().list()[0]?.result).toBe('CHILD-ONLY');
    run.sink.emit({ type: 'subagent', agent: { ...child(), status: 'completed' } });
    expect(run.subagents().list()[0]?.result, 'a roster update without a result keeps the folded text').toBe('CHILD-ONLY');
    run.sink.emit({ type: 'text', lane, itemId: 'c2' as ItemId, channel: 'answer', delta: 'final ' });
    expect(run.subagents().list()[0]?.result, 'a new answer item starts over').toBe('final ');
    run.sink.emit({ type: 'text-final', lane, itemId: 'c2' as ItemId, channel: 'answer', text: 'final report' });
    run.sink.verdict({ kind: 'completed' });
    run.sink.emit({ type: 'text', lane, itemId: 'c2' as ItemId, channel: 'answer', delta: ' late' });
    const events = await drain(run);
    expect(events.filter(event => event.type === 'text' || event.type === 'text-final')).toEqual([main]);
    expect(JSON.stringify(events)).not.toMatch(/THINKING|GHOST/);
    expect(events.at(-2)).toMatchObject({ type: 'subagent', agent: { status: 'completed', result: 'final report' } });
    expect(run.subagents().list()[0]?.result).toBe('final report');
    expect(run.droppedAfterEnd).toBe(1);
  });

  it('detaches queued events from the engine payload', async () => {
    const { run } = channel();
    const agent = child();
    run.sink.emit({ type: 'subagent', agent });
    agent.task = 'changed';
    run.sink.verdict({ kind: 'completed' });
    expect((await drain(run))[1]).toMatchObject({ type: 'subagent', agent: { task: 'Investigate' } });
  });
});
