import type { ExitFact, OwnedProcess, ProcessFact, SignalResult } from '../../../src/provider/engines/engine';
import type { SubagentId, TurnId } from '../../../src/provider/model';

/** 'silent' never answers, like a holder whose channel is gone. exitOn: the call after which the provider exits. */
export interface FakeProcessScript {
  term?: SignalResult | 'silent';
  kill?: SignalResult | 'silent';
  exitOn?: { call: 'term' | 'kill'; afterMs: number; exit: ExitFact };
  receiptDelayMs?: number;
}

export interface FakeProcess extends OwnedProcess {
  readonly calls: ('term' | 'kill')[];
  readonly listeners: number;
  publish(fact: ProcessFact): void;
}

/** An in-memory OwnedProcess on vitest fake timers. It fakes the runtime's port only, not ProcessHost. */
export function fakeProcess(script: FakeProcessScript = {}): FakeProcess {
  const facts: ProcessFact[] = [];
  const listeners = new Set<(fact: ProcessFact) => void>();
  const calls: ('term' | 'kill')[] = [];

  const publish = (fact: ProcessFact) => {
    if (facts.some(f => f.kind === 'exit' || f.kind === fact.kind)) return;
    facts.push(fact);
    for (const listener of [...listeners]) listener(fact);
  };

  const call = (kind: 'term' | 'kill'): Promise<SignalResult> => {
    calls.push(kind);
    const { exitOn } = script;
    if (exitOn?.call === kind) setTimeout(() => publish({ kind: 'exit', exit: exitOn.exit }), exitOn.afterMs);
    const receipt = script[kind] ?? 'sent';
    return new Promise(resolve => { if (receipt !== 'silent') setTimeout(() => resolve(receipt), script.receiptDelayMs ?? 0); });
  };

  return {
    calls,
    get listeners() { return listeners.size; },
    publish,
    term: () => call('term'),
    kill: () => call('kill'),
    watch(listener) {
      for (const fact of facts) listener(fact);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** The engine half a RunChannel needs, recording interrupts and subagent stops. */
export function fakeSession(process: OwnedProcess, opts: { subagentStop?: boolean } = {}) {
  const interrupts: (TurnId | undefined)[] = [];
  const stopped: SubagentId[] = [];
  return {
    process,
    interrupts,
    stopped,
    interrupt: async (id: TurnId | undefined) => { interrupts.push(id); },
    stopSubagent: opts.subagentStop ? async (id: SubagentId) => { stopped.push(id); } : undefined,
  };
}
