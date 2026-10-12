import { describe, expect, it, vi } from 'vitest';
import { log } from '../../src/core/logger';
import type { ItemId, RunEvent, StepId, SubagentId, SubagentState, TurnId } from '../../src/provider/model';
import { RunChannel } from '../../src/provider/runtime/run-channel';

const profile = { needsTurnId: true, openWaitMs: 5000, graceMs: 5000 };
const childId = 'child-1' as SubagentId;
const turnId = 'turn-1' as TurnId;

function channel() {
  const frames: number[] = [];
  const effects: string[] = [];
  let now = 100;
  const run = new RunChannel({
    providerSessionId: 'session-1', profile,
    now: () => now,
    onFrame: () => frames.push(now),
    onEffects: items => effects.push(...items.map(item => item.kind)),
  });
  return { run, frames, effects, clock: (value: number) => { now = value; } };
}

function child(): SubagentState {
  return { id: childId, status: 'running', task: 'Investigate', startedAt: 90, stepCount: 0, recentSteps: [] };
}

describe('RunChannel', () => {
  it('logs and ignores a conflicting second started frame', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const { run } = channel();
      run.sink.emit({ type: 'started', turnId });
      run.sink.emit({ type: 'started', turnId: 'other-turn' as TurnId });
      expect(run.turnState.turnId).toBe('turn-1');
      expect(run.snapshot().filter(event => event.type === 'started')).toEqual([{ type: 'started', turnId: 'turn-1' }]);
      expect(warn).toHaveBeenCalledWith('provider', 'duplicate-started', { expected: 'turn-1', received: 'other-turn' });
    } finally {
      warn.mockRestore();
    }
  });

  it('wakes a waiting iterator and ends it after the final event', async () => {
    const { run } = channel();
    const reader = run.events[Symbol.asyncIterator]();
    expect(await reader.next()).toEqual({ value: { type: 'session', providerSessionId: 'session-1' }, done: false });
    const waiting = reader.next();
    run.sink.emit({ type: 'provider-message', level: 'info', text: 'live' });
    expect(await waiting).toEqual({ value: { type: 'provider-message', level: 'info', text: 'live' }, done: false });
    run.sink.verdict({ kind: 'completed' });
    expect(await reader.next()).toEqual({ value: { type: 'outcome', outcome: { state: 'completed' } }, done: false });
    expect(await reader.next()).toEqual({ value: undefined, done: true });
  });

  it('keeps the session first and finalizes the child before exactly one last outcome', async () => {
    const { run, frames } = channel();
    run.sink.frame();
    run.sink.emit({ type: 'started', turnId });
    run.sink.emit({ type: 'subagent', agent: child() });
    run.sink.verdict({ kind: 'completed' });
    run.exit(1, null);
    run.providerError(new Error('too late'));
    run.sink.emit({ type: 'provider-message', level: 'warn', text: 'too late' });
    run.sink.frame();

    const events: RunEvent[] = [];
    for await (const event of run.events) events.push(event);
    expect(events.map(event => event.type)).toEqual(['session', 'started', 'subagent', 'subagent', 'outcome']);
    expect(events[3]).toMatchObject({ type: 'subagent', agent: { id: childId, status: 'interrupted', endedAt: 100 } });
    expect(events[4]).toEqual({ type: 'outcome', outcome: { state: 'completed' } });
    expect(run.droppedAfterEnd).toBe(4);
    expect(frames).toEqual([100]);
  });

  it('routes stop and exit through the turn machine and preserves stop ownership', () => {
    const { run, effects, clock } = channel();
    run.sink.emit({ type: 'started', turnId });
    expect(run.input({ kind: 'stop', by: 'watchdog' }).map(item => item.kind)).toEqual(['stop-subagents', 'interrupt', 'arm']);
    clock(5100);
    run.input({ kind: 'tick' });
    run.exit(null, 'SIGTERM');
    run.sink.verdict({ kind: 'completed' });
    expect(effects).toEqual(['stop-subagents', 'interrupt', 'arm', 'term-tree', 'arm']);
    expect(run.snapshot().at(-1)).toEqual({ type: 'outcome', outcome: { state: 'interrupted', by: 'watchdog', forced: true } });
    expect(run.snapshot().filter(event => event.type === 'outcome')).toHaveLength(1);
  });

  it('keeps child text and steps in the stream but away from the main timeline', () => {
    const { run } = channel();
    run.sink.emit({ type: 'subagent', agent: child() });
    run.sink.emit({ type: 'text', lane: { kind: 'subagent', id: childId }, itemId: 'child-text' as ItemId, channel: 'answer', delta: 'child result' });
    run.sink.emit({ type: 'step', lane: { kind: 'subagent', id: childId }, step: { id: 'child-step' as StepId, title: 'Read', status: 'ok', detail: { type: 'read', path: '/tmp/a' } } });
    run.sink.emit({ type: 'text', lane: { kind: 'main' }, itemId: 'answer' as ItemId, channel: 'answer', delta: 'main answer' });
    run.sink.emit({ type: 'todo', items: [{ text: 'write answer', status: 'in_progress' }] });
    run.sink.verdict({ kind: 'completed' });

    expect(run.mainTimeline()).toEqual([{ type: 'text', lane: { kind: 'main' }, itemId: 'answer', channel: 'answer', delta: 'main answer' }]);
    expect(run.snapshot().map(event => event.type)).toEqual(['session', 'subagent', 'text', 'subagent', 'step', 'text', 'todo', 'subagent', 'outcome']);
    expect(run.subagents[0]).toMatchObject({ status: 'interrupted', stepCount: 1, recentSteps: [{ title: 'Read' }] });
    expect(run.subagentHistory(childId)?.steps.map(step => step.title)).toEqual(['Read']);
    expect(run.todoItems).toEqual([{ text: 'write answer', status: 'in_progress' }]);
  });

  it('detaches event snapshots from mutable engine payloads and caller edits', () => {
    const { run } = channel();
    const agent = child();
    run.sink.emit({ type: 'subagent', agent });
    agent.task = 'changed';
    const snapshot = run.snapshot();
    const event = snapshot[1];
    if (event?.type !== 'subagent') throw new Error('missing subagent event');
    event.agent.task = 'edited snapshot';
    expect(run.snapshot()[1]).toMatchObject({ type: 'subagent', agent: { task: 'Investigate' } });
  });

  it('maps provider rejection to one failed outcome and drops late pushes', () => {
    const { run } = channel();
    run.providerError(new Error('transport failed'));
    run.sink.verdict({ kind: 'completed' });
    expect(run.snapshot()).toEqual([
      { type: 'session', providerSessionId: 'session-1' },
      { type: 'outcome', outcome: { state: 'failed', failure: { kind: 'provider-error', message: 'transport failed' } } },
    ]);
    expect(run.droppedAfterEnd).toBe(1);
  });
});
