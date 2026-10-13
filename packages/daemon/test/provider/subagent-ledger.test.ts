import { describe, expect, it } from 'vitest';
import type { Step, StepId, SubagentId, SubagentState } from '../../src/provider/model';
import { SubagentLedger } from '../../src/provider/runtime/subagent-ledger';

function agent(id: number, changes: Partial<SubagentState> = {}): SubagentState {
  return {
    id: `agent-${id}` as SubagentId,
    status: 'running',
    task: 'Investigate',
    startedAt: 10,
    stepCount: 0,
    recentSteps: [],
    ...changes,
  };
}

function step(id: number, status: Step['status'] = 'running'): Step {
  return {
    id: `step-${id}` as StepId,
    title: `Step ${id}`,
    status,
    detail: { type: 'other', toolName: 'tool', input: { nested: { value: id } } },
  };
}

function changeNestedInput(detail: Step['detail'] | undefined, next: number): void {
  const value = detail?.type === 'other' ? detail.input : undefined;
  if (typeof value !== 'object' || value === null || !('nested' in value)) throw new Error('missing nested input');
  const nested = value.nested;
  if (typeof nested !== 'object' || nested === null || !('value' in nested) || typeof nested.value !== 'number') {
    throw new Error('missing nested value');
  }
  nested.value = next;
}

describe('SubagentLedger', () => {
  it('caps the roster at 64 without losing or blocking existing agents', () => {
    const ledger = new SubagentLedger();
    for (let id = 0; id < 64; id++) expect(ledger.upsert(agent(id))).toBeDefined();
    expect(ledger.upsert(agent(64))).toBeUndefined();
    expect(ledger.list()).toHaveLength(64);
    expect(ledger.upsert(agent(0, { status: 'completed', endedAt: 20 }))).toMatchObject({ status: 'completed' });
    expect(ledger.list()).toHaveLength(64);
    expect(ledger.history(agent(64).id)).toBeUndefined();
  });

  it('bounds task, result, and recent steps while retaining native stepCount', () => {
    const ledger = new SubagentLedger();
    const initial = agent(1, {
      task: 't'.repeat(121), result: 'r'.repeat(601), stepCount: 42,
      recentSteps: Array.from({ length: 7 }, (_, id) => step(id)),
    });
    const state = ledger.upsert(initial);
    expect(state?.task).toHaveLength(120);
    expect(state?.result).toHaveLength(600);
    expect(state?.stepCount).toBe(42);
    expect(state?.recentSteps.map(item => item.id)).toEqual([2, 3, 4, 5, 6].map(id => step(id).id));
    expect(ledger.history(initial.id)?.steps).toHaveLength(7);
  });

  it('upserts retained steps by id, keeps order, and drops the oldest at 200', () => {
    const ledger = new SubagentLedger();
    const id = agent(1).id;
    ledger.upsert(agent(1));
    for (let index = 0; index < 200; index++) ledger.recordStep(id, step(index));
    expect(ledger.recordStep(id, step(0, 'ok'))?.stepCount).toBe(200);
    expect(ledger.history(id)?.steps[0]).toMatchObject({ id: step(0).id, status: 'ok' });
    expect(ledger.history(id)?.truncated).toBe(false);

    expect(ledger.recordStep(id, step(200))?.stepCount).toBe(201);
    const history = ledger.history(id);
    expect(history?.steps).toHaveLength(200);
    expect(history?.steps[0]?.id).toBe(step(1).id);
    expect(history?.steps.at(-1)?.id).toBe(step(200).id);
    expect(history?.truncated).toBe(true);
    expect(ledger.list()[0]?.recentSteps.map(item => item.id))
      .toEqual([196, 197, 198, 199, 200].map(index => step(index).id));
    ledger.recordStep(id, step(200, 'failed'));
    expect(ledger.list()[0]?.stepCount).toBe(201);
    expect(ledger.history(id)?.truncated).toBe(true);
  });

  it.each(['recordStep', 'upsert'])('does not add delayed %s details to a native total', source => {
    const ledger = new SubagentLedger();
    const id = agent(1).id;
    expect(ledger.upsert(agent(1, { stepCount: 1 }))?.stepCount).toBe(1);

    const detailed = agent(1, { stepCount: 1, recentSteps: [step(1)] });
    const received = source === 'recordStep'
      ? ledger.recordStep(id, step(1))
      : ledger.upsert(detailed);
    expect(received?.stepCount).toBe(1);
    expect(received?.recentSteps).toEqual([step(1)]);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(ledger.upsert(detailed)?.stepCount).toBe(1);
      expect(ledger.recordStep(id, step(1, 'ok'))?.stepCount).toBe(1);
    }
    expect(ledger.history(id)?.steps).toEqual([step(1, 'ok')]);
  });

  it.each(['recordStep', 'upsert'])('reconciles a native total after %s details arrive first', source => {
    const ledger = new SubagentLedger();
    const id = agent(1).id;
    ledger.upsert(agent(1));
    const received = source === 'recordStep'
      ? ledger.recordStep(id, step(1))
      : ledger.upsert(agent(1, { recentSteps: [step(1)] }));
    expect(received?.stepCount).toBe(1);
    expect(ledger.upsert(agent(1, { stepCount: 1 }))?.stepCount).toBe(1);
    for (let repeat = 0; repeat < 3; repeat++) {
      expect(ledger.upsert(agent(1, { stepCount: 1, recentSteps: [step(1)] }))?.stepCount).toBe(1);
    }
    expect(ledger.history(id)?.steps).toEqual([step(1)]);
    expect(ledger.recordStep(id, step(2))?.stepCount).toBe(2);
  });

  it('keeps native floor jumps separate from accumulated observations', () => {
    const ledger = new SubagentLedger();
    const id = agent(1).id;
    ledger.upsert(agent(1, { stepCount: 1, recentSteps: [step(1)] }));
    expect(ledger.recordStep(id, step(2))?.stepCount).toBe(2);
    expect(ledger.upsert(agent(1, { stepCount: 6 }))?.stepCount).toBe(6);
    expect(ledger.recordStep(id, step(3))?.stepCount).toBe(6);
    expect(ledger.upsert(agent(1, { stepCount: 6, recentSteps: [step(3), step(4)] }))?.stepCount).toBe(6);
    expect(ledger.upsert(agent(1, { stepCount: 2, recentSteps: [step(4), step(5)] }))?.stepCount).toBe(6);
    expect(ledger.recordStep(id, step(6))?.stepCount).toBe(6);
    expect(ledger.recordStep(id, step(7))?.stepCount).toBe(7);
    expect(ledger.upsert(agent(1, { stepCount: 6, recentSteps: [step(7)] }))?.stepCount).toBe(7);
    expect(ledger.history(id)?.steps).toEqual([1, 2, 3, 4, 5, 6, 7].map(index => step(index)));
    expect(ledger.list()[0]?.recentSteps).toEqual([3, 4, 5, 6, 7].map(index => step(index)));
  });

  it('returns detached state and history including nested step detail', () => {
    const ledger = new SubagentLedger();
    const incoming = agent(1, { recentSteps: [step(1)] });
    changeNestedInput(ledger.upsert(incoming)?.recentSteps[0]?.detail, -2);
    changeNestedInput(incoming.recentSteps[0]?.detail, -1);
    changeNestedInput(ledger.list()[0]?.recentSteps[0]?.detail, -3);
    changeNestedInput(ledger.history(incoming.id)?.steps[0]?.detail, -4);
    expect(ledger.list()[0]?.recentSteps[0]?.detail).toEqual(step(1).detail);
    expect(ledger.history(incoming.id)?.steps[0]?.detail).toEqual(step(1).detail);
  });

  it('settles running agents once and leaves completed or failed agents alone', () => {
    const ledger = new SubagentLedger();
    ledger.upsert(agent(1));
    ledger.upsert(agent(2, { status: 'completed', endedAt: 15 }));
    ledger.upsert(agent(3, { status: 'failed', endedAt: 15 }));
    const settled = ledger.finishRunning(20);
    expect(settled).toEqual([expect.objectContaining({ id: agent(1).id, status: 'interrupted', endedAt: 20 })]);
    const settledAgent = settled[0];
    if (!settledAgent) throw new Error('expected settled agent');
    settledAgent.task = 'changed';
    expect(ledger.list().map(item => item.status)).toEqual(['interrupted', 'completed', 'failed']);
    expect(ledger.list()[0]?.task).toBe('Investigate');
    expect(ledger.finishRunning(30)).toEqual([]);
  });
});
