import { describe, expect, it } from 'vitest';
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

  it('caps rows at 64, retaining running rows and evicting the oldest terminal row', () => {
    let state = running();
    for (let i = 1; i < 64; i++) state = reduce(state, start(String(i)));
    expect(reduce(state, start('overflow'))).toBe(state);
    state = reduce(state, status('completed'));
    state = reduce(state, start('new'));
    expect(state.subagents).toHaveLength(64);
    expect(state.subagents.map(row => row.id)).toEqual([...Array.from({ length: 63 }, (_, i) => String(i + 1)), 'new']);
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
