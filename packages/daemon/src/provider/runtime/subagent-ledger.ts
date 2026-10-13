import type { ItemId, Step, SubagentId, SubagentState } from '../model';

const MAX_AGENTS = 64;
const MAX_RECENT_STEPS = 5;
const MAX_HISTORY_STEPS = 200;
const MAX_TASK_CHARS = 120;
const MAX_RESULT_CHARS = 600;

interface Entry {
  state: SubagentState;
  steps: Step[];
  truncated: boolean;
  observedStepCount: number;
  nativeStepCount: number;
  answerItem?: ItemId;
}

export class SubagentLedger {
  private readonly entries = new Map<SubagentId, Entry>();

  upsert(agent: SubagentState): SubagentState | undefined {
    const entry = this.entries.get(agent.id);
    if (!entry && this.entries.size === MAX_AGENTS) return undefined;

    const steps = entry?.steps ?? [];
    let truncated = entry?.truncated ?? false;
    let observedStepCount = entry?.observedStepCount ?? 0;
    const nativeStepCount = Math.max(entry?.nativeStepCount ?? 0, agent.stepCount);
    for (const step of agent.recentSteps) {
      const added = this.upsertStep(steps, step);
      if (added) observedStepCount++;
      if (steps.length > MAX_HISTORY_STEPS) {
        steps.shift();
        truncated = true;
      }
    }
    const result = agent.result ?? entry?.state.result;
    const state: SubagentState = {
      ...structuredClone(agent),
      task: agent.task.slice(0, MAX_TASK_CHARS),
      stepCount: Math.max(observedStepCount, nativeStepCount),
      recentSteps: structuredClone(steps.slice(-MAX_RECENT_STEPS)),
      ...(result === undefined ? {} : { result: result.slice(0, MAX_RESULT_CHARS) }),
    };
    this.entries.set(agent.id, { state, steps, truncated, observedStepCount, nativeStepCount, answerItem: entry?.answerItem });
    return structuredClone(state);
  }

  recordStep(id: SubagentId, step: Step): SubagentState | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const added = this.upsertStep(entry.steps, step);
    if (added) entry.observedStepCount++;
    entry.state.stepCount = Math.max(entry.observedStepCount, entry.nativeStepCount);
    if (entry.steps.length > MAX_HISTORY_STEPS) {
      entry.steps.shift();
      entry.truncated = true;
    }
    entry.state.recentSteps = structuredClone(entry.steps.slice(-MAX_RECENT_STEPS));
    return structuredClone(entry.state);
  }

  /** The row's result is the subagent's latest answer item: its deltas append, its final text replaces. */
  recordAnswer(id: SubagentId, itemId: ItemId, text: string, final: boolean): SubagentState | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const before = entry.answerItem === itemId && !final ? entry.state.result ?? '' : '';
    entry.answerItem = itemId;
    entry.state.result = (before + text).slice(0, MAX_RESULT_CHARS);
    return structuredClone(entry.state);
  }

  list(): SubagentState[] {
    return [...this.entries.values()].map(entry => structuredClone(entry.state));
  }

  history(id: SubagentId): { steps: Step[]; truncated: boolean } | undefined {
    const entry = this.entries.get(id);
    return entry && { steps: structuredClone(entry.steps), truncated: entry.truncated };
  }

  finishRunning(endedAt: number): SubagentState[] {
    const settled: SubagentState[] = [];
    for (const entry of this.entries.values()) {
      if (entry.state.status !== 'running') continue;
      entry.state = { ...entry.state, status: 'interrupted', endedAt };
      settled.push(structuredClone(entry.state));
    }
    return settled;
  }

  private upsertStep(steps: Step[], step: Step): boolean {
    const index = steps.findIndex(existing => existing.id === step.id);
    if (index >= 0) {
      steps[index] = structuredClone(step);
      return false;
    }
    steps.push(structuredClone(step));
    return true;
  }
}
