import { describe, expect, it } from 'vitest';
import { RunRender } from '../src/card/run-render';
import type { AgentEvent } from '../src/agent/types';
import { finalizeIfRunning, initialState, markIdleTimeout, markInterrupted, reduce } from '../src/card/run-state';

const start = (id = 'a'): Extract<AgentEvent, { type: 'subagent_start' }> => ({ type: 'subagent_start', id, name: '助手', task: '任'.repeat(121), stoppable: true });
const step = (stepId: string, status: 'running' | 'done' | 'failed' = 'running'): AgentEvent =>
  ({ type: 'subagent_step', id: 'a', stepId, title: '读取 x', status });
const status = (value: 'running' | 'completed' | 'failed' | 'stopped'): AgentEvent =>
  ({ type: 'subagent_status', id: 'a', status: value, result: '果'.repeat(601) });
const running = () => reduce(initialState, start());

describe('subagent run state', () => {
  it('starts once, caps task and result, and preserves parent identity', () => {
    const state = reduce(initialState, { ...start(), type: 'subagent_start', parentId: 'parent' });
    expect(reduce(state, start())).toBe(state);
    expect(state.subagents[0]).toMatchObject({ id: 'a', parentId: 'parent', task: '任'.repeat(120), stoppable: true });
    expect(reduce(state, status('completed')).subagents[0]?.result).toHaveLength(600);
  });

  it('retains all running and terminal identities beyond 64 rows', () => {
    let state = running();
    for (let i = 1; i < 64; i++) state = reduce(state, start(String(i)));
    state = reduce(state, start('overflow'));
    expect(state.subagents).toHaveLength(65);
    state = reduce(state, status('completed'));
    state = reduce(state, start('new'));
    expect(state.subagents).toHaveLength(66);
    expect(state.subagents.map(row => row.id)).toEqual(['a', ...Array.from({ length: 63 }, (_, i) => String(i + 1)), 'overflow', 'new']);
  });

  it('pairs identical titles by stepId, deduplicates starts, and keeps five recent steps', () => {
    let state = reduce(reduce(running(), step('first')), step('second'));
    state = reduce(reduce(state, step('second')), step('second', 'done'));
    expect(state.subagents[0]?.steps.map(value => value.status)).toEqual(['running', 'done']);
    for (let i = 0; i < 5; i++) state = reduce(state, step(String(i)));
    state = reduce(state, step('first', 'failed'));
    state = reduce(state, step('4', 'failed'));
    expect(state.subagents[0]?.steps.map(value => value.stepId)).toEqual(['0', '1', '2', '3', '4']);
    expect(state.subagents[0]?.steps[4]?.status).toBe('failed');
  });

  it('keeps a child tool presentation after its completion event has no metadata', () => {
    let state = reduce(running(), { type: 'subagent_step', id: 'a', stepId: 'command',
      title: 'pwd', status: 'running', kind: 'command', detail: '/repo' });
    state = reduce(state, { type: 'subagent_step', id: 'a', stepId: 'command', title: '', status: 'done' });
    expect(state.subagents[0]?.steps[0]).toEqual({
      stepId: 'command', title: 'pwd', status: 'done', kind: 'command', detail: '/repo',
    });
  });

  it('resumes completed rows, while failed and stopped rows remain terminal', () => {
    expect(reduce(reduce(running(), status('completed')), status('running')).subagents[0]?.status).toBe('running');
    for (const terminal of ['failed', 'stopped'] as const) {
      const state = reduce(running(), status(terminal));
      expect(reduce(state, status('running')).subagents[0]?.status).toBe(terminal);
      expect(reduce(state, status('completed')).subagents[0]?.status).toBe(terminal);
      expect(reduce(reduce(running(), status('completed')), status(terminal)).subagents[0]?.status).toBe(terminal);
    }
  });

  it('closes running rows on interruption, watchdog, fatal error and premature stream end', () => {
    const state = reduce(running(), start('other'));
    const completed = reduce(state, status('completed'));
    expect(markInterrupted(completed).subagents.map(row => row.status)).toEqual(['completed', 'stopped']);
    expect(markIdleTimeout(state, 30).subagents[0]?.status).toBe('stopped');
    expect(finalizeIfRunning(state).subagents[0]?.status).toBe('failed');
    expect(reduce(state, { type: 'error', message: '失败', willRetry: false }).subagents[0]?.status).toBe('failed');
    expect(reduce(state, { type: 'error', message: '重试', willRetry: true }).subagents[0]?.status).toBe('running');
  });

  it('leaves children running on done and leaves an already done card alone', () => {
    const done = reduce(running(), { type: 'done', turnId: 'turn' });
    expect(done.subagents[0]?.status).toBe('running');
    expect(finalizeIfRunning(done)).toBe(done);
  });

  it('ignores unknown ids and accepts persisted state without subagents', () => {
    expect(reduce(initialState, step('unknown')).subagents).toEqual([]);
    expect(reduce(initialState, status('failed')).subagents).toEqual([]);
    const legacy = { ...initialState };
    Reflect.deleteProperty(legacy, 'subagents');
    expect(reduce(legacy, start()).subagents).toHaveLength(1);
  });
});

it('timestamps a new child with zero total steps', () => {
  expect(reduce(initialState, start(), 1000).subagents[0]).toMatchObject({ startedAt: 1000, stepCount: 0 });
});
it('counts seven started steps while retaining only the latest five', () => {
  let state = reduce(initialState, start(), 1000);
  for (let i = 0; i < 7; i++) state = reduce(state, step(String(i)), 2000);
  expect(state.subagents[0]?.stepCount).toBe(7); expect(state.subagents[0]?.steps).toHaveLength(5);
});
it('timestamps completion and clears its end on resume without resetting its start', () => {
  const done = reduce(reduce(initialState, start(), 1000), status('completed'), 5000);
  expect(done.subagents[0]?.endedAt).toBe(5000);
  expect(reduce(done, status('running'), 6000).subagents[0]).toMatchObject({ startedAt: 1000, endedAt: undefined });
});
it('marks waiting children without ending the parent or retaining its old footer', () => {
  expect(reduce({ ...initialState, footer: 'thinking' }, { type: 'awaiting_subagents' }))
    .toMatchObject({ awaitingSubagents: true, footer: null, terminal: 'running' });
});
it('timestamps interruption when closing running children', () => {
  expect(markInterrupted(reduce(initialState, start(), 1000), 7000).subagents[0]).toMatchObject({ status: 'stopped', endedAt: 7000 });
});
it('seeds child rows only into an empty render', () => {
  const rows = reduce(initialState, start(), 1000).subagents, render = new RunRender();
  render.seedSubagents(rows); render.seedSubagents([]); expect(render.snapshot().subagents).toBe(rows);
});
