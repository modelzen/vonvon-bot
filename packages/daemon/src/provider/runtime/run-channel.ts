import type { Outcome, RunEvent, SubagentId } from '../model';
import type { SignalSink, StopProfile, TurnVerdict } from '../engines/engine';
import { log } from '../../core/logger';
import { SubagentLedger } from './subagent-ledger';
import { TodoTracker } from './todo-tracker';
import { stepTurn, type Effect, type TurnInput, type TurnState } from './turn-machine';

type SignalEvent = Exclude<RunEvent, { type: 'outcome' }>;
type MainTimelineEvent = Extract<RunEvent, { type: 'text' | 'text-final' | 'step' }>;

export interface RunChannelOptions {
  providerSessionId: string;
  profile: StopProfile;
  onFrame: () => void;
  now: () => number;
  /** The runtime executes stop, timer, and process effects; outcome is appended by this channel. */
  onEffects: (effects: Exclude<Effect, { kind: 'outcome' }>[]) => void;
}

export class RunChannel {
  private readonly queue: RunEvent[] = [];
  private readonly history: RunEvent[] = [];
  private readonly waiters: (() => void)[] = [];
  private readonly ledger = new SubagentLedger();
  private readonly todos = new TodoTracker();
  private state: TurnState = { phase: 'opening' };
  private dropped = 0;
  readonly sink: SignalSink;

  constructor(private readonly options: RunChannelOptions) {
    this.append({ type: 'session', providerSessionId: options.providerSessionId });
    this.sink = {
      frame: () => {
        if (!this.isOpen) { this.dropped++; return; }
        this.options.onFrame();
      },
      emit: event => this.emit(event),
      verdict: verdict => this.verdict(verdict),
    };
  }

  get isOpen(): boolean { return this.state.phase !== 'settled'; }
  get droppedAfterEnd(): number { return this.dropped; }
  get turnState(): TurnState { return structuredClone(this.state); }
  get subagents(): ReturnType<SubagentLedger['list']> { return this.ledger.list(); }
  get todoItems(): ReturnType<TodoTracker['list']> { return this.todos.list(); }

  subagentHistory(id: SubagentId): ReturnType<SubagentLedger['history']> {
    return this.ledger.history(id);
  }

  snapshot(): RunEvent[] { return structuredClone(this.history); }

  mainTimeline(): MainTimelineEvent[] {
    return this.history.flatMap(event =>
      (event.type === 'text' || event.type === 'text-final' || event.type === 'step') && event.lane.kind === 'main'
        ? [structuredClone(event)] : []);
  }

  get events(): AsyncIterable<RunEvent> {
    return this.readEvents();
  }

  input(input: TurnInput): Effect[] {
    if (!this.isOpen) { this.dropped++; return []; }
    const result = stepTurn(this.state, input, this.options.profile, this.options.now());
    this.state = result.state;
    const external: Exclude<Effect, { kind: 'outcome' }>[] = [];
    for (const effect of result.effects) {
      if (effect.kind === 'outcome') this.finish(effect.outcome);
      else external.push(effect);
    }
    if (external.length) this.options.onEffects(external);
    return result.effects;
  }

  exit(code: number | null, signal: string | null): void {
    this.input({ kind: 'exit', code, signal });
  }

  providerError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.verdict({ kind: 'failed', failure: { kind: 'provider-error', message } });
  }

  private verdict(verdict: TurnVerdict): void {
    this.input({ kind: 'verdict', verdict });
  }

  private emit(event: SignalEvent): void {
    if (!this.isOpen) { this.dropped++; return; }
    if (event.type === 'session') return;
    if (event.type === 'started') {
      const previousTurnId = this.state.turnId;
      if (previousTurnId !== undefined) {
        if (previousTurnId !== event.turnId) {
          log.warn('provider', 'duplicate-started', { expected: previousTurnId, received: event.turnId });
        }
        return;
      }
      this.input({ kind: 'started', turnId: event.turnId });
      if (!this.isOpen) return;
    }
    if (event.type === 'subagent') {
      const agent = this.ledger.upsert(event.agent);
      if (agent) this.append({ type: 'subagent', agent });
      return;
    }
    if (event.type === 'step' && event.lane.kind === 'subagent') {
      const agent = this.ledger.recordStep(event.lane.id, event.step);
      if (agent) this.append({ type: 'subagent', agent });
    }
    if (event.type === 'todo') {
      this.append({ type: 'todo', items: this.todos.replace(event.items) });
      return;
    }
    this.append(event);
  }

  private finish(outcome: Outcome): void {
    for (const agent of this.ledger.finishRunning(this.options.now())) {
      this.append({ type: 'subagent', agent });
    }
    this.append({ type: 'outcome', outcome });
    this.wake();
  }

  private append(event: RunEvent): void {
    const detached = structuredClone(event);
    this.history.push(detached);
    this.queue.push(structuredClone(detached));
    this.wake();
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  private async *readEvents(): AsyncGenerator<RunEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        if (next.type === 'outcome') return;
      } else if (!this.isOpen) {
        return;
      } else {
        await new Promise<void>(resolve => this.waiters.push(resolve));
      }
    }
  }
}
