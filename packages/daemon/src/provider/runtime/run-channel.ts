import type { Outcome, RunEvent, Step, StopBy, SubagentId, SubagentState, TodoItem, TurnId } from '../model';
import type { EngineSession, ProcessFact, SignalResult, SignalSink, StopProfile } from '../engines/engine';
import { log } from '../../core/logger';
import { SubagentLedger } from './subagent-ledger';
import { TodoTracker } from './todo-tracker';
import { deadlineOf, stepTurn, type Effect, type TurnInput, type TurnState } from './turn-machine';

export interface RunChannelOptions {
  id: string;
  providerSessionId: string;
  profile: StopProfile;
  session: Pick<EngineSession, 'interrupt' | 'stopSubagent' | 'process'>;
}

/** One run: the turn machine, its effects, its one timer, the ledgers, and exactly one outcome, last. */
export class RunChannel {
  readonly id: string;
  readonly sink: SignalSink;
  /** Resolves with the one outcome when it is appended. Never rejects. */
  readonly outcome: Promise<Outcome>;

  private state: TurnState = { phase: 'opening' };
  private readonly ledger = new SubagentLedger();
  private readonly todos = new TodoTracker();
  private readonly queue: RunEvent[] = [];
  private readonly waiters: (() => void)[] = [];
  private timer: NodeJS.Timeout | undefined;
  private unwatch: (() => void) | undefined;
  private activity = Date.now();
  private dropped = 0;
  private resolveOutcome: (outcome: Outcome) => void = () => undefined;

  constructor(private readonly options: RunChannelOptions) {
    this.id = options.id;
    this.outcome = new Promise(resolve => { this.resolveOutcome = resolve; });
    this.sink = {
      frame: () => this.frame(),
      emit: event => this.emit(event),
      verdict: verdict => {
        if (this.state.phase === 'settled') this.dropped++;
        else this.input({ kind: 'verdict', verdict });
      },
    };
    this.append({ type: 'session', providerSessionId: options.providerSessionId });
    // watch() replays a past fact synchronously and may settle this run before it returns, when finish() has
    // nothing to unsubscribe yet. So the subscription is the last statement and is undone here in that case.
    const unwatch = options.session.process.watch(fact => this.onProcessFact(fact));
    if (this.state.phase === 'settled') unwatch();
    else this.unwatch = unwatch;
  }

  get events(): AsyncIterable<RunEvent> { return this.read(); }
  get droppedAfterEnd(): number { return this.dropped; }

  /** Starts the ladder once; every call resolves with the same outcome. */
  stop(by: StopBy): Promise<Outcome> {
    this.input({ kind: 'stop', by });
    return this.outcome;
  }

  turnId(): TurnId | undefined { return this.state.phase === 'opening' ? undefined : this.state.turnId; }
  lastActivity(): number { return this.activity; }
  subagents(): { list(): SubagentState[]; history(id: SubagentId): { steps: Step[]; truncated: boolean } | undefined } {
    return { list: () => this.ledger.list(), history: id => this.ledger.history(id) };
  }
  todo(): TodoItem[] | null { return this.todos.list(); }

  private input(input: TurnInput): void {
    if (this.state.phase === 'settled') return;
    const { state, effects } = stepTurn(this.state, input, this.options.profile, Date.now());
    this.state = state;
    for (const effect of effects) this.execute(effect);
    if (state.phase === 'settled') this.finish(state.outcome);
    else this.rearm();
  }

  private execute(effect: Effect): void {
    const { session } = this.options;
    switch (effect.kind) {
      case 'stop-subagents':
        if (!session.stopSubagent) return;
        for (const agent of this.ledger.list()) {
          if (agent.status !== 'running') continue;
          session.stopSubagent(agent.id).catch(error => log.warn('provider', 'stop-subagent-failed', { run: this.id, error: String(error) }));
        }
        return;
      case 'interrupt':
        session.interrupt(effect.turnId).catch(error => log.warn('provider', 'interrupt-failed', { run: this.id, error: String(error) }));
        return;
      case 'term-tree':
        void session.process.term().then(result => this.receipt('term', result));
        return;
      case 'kill-tree':
        void session.process.kill().then(result => this.receipt('kill', result));
        return;
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  }

  private receipt(rung: 'term' | 'kill', result: SignalResult): void {
    if (result !== 'sent') log.info('provider', 'signal-receipt', { run: this.id, rung, result });
    this.input({ kind: 'signal', rung, result });
  }

  private rearm(): void {
    clearTimeout(this.timer);
    const at = deadlineOf(this.state);
    this.timer = at === undefined ? undefined : setTimeout(() => this.input({ kind: 'tick' }), Math.max(0, at - Date.now()));
  }

  private onProcessFact(fact: ProcessFact): void {
    if (fact.kind === 'transport-lost' && this.state.phase === 'stopping') log.info('provider', 'transport-lost-while-stopping', { run: this.id });
    this.input(fact.kind === 'exit' ? { kind: 'exit', exit: fact.exit } : { kind: 'transport-lost' });
  }

  private frame(): void {
    if (this.state.phase === 'settled') this.dropped++;
    else this.activity = Date.now();
  }

  private emit(event: Exclude<RunEvent, { type: 'outcome' }>): void {
    if (this.state.phase === 'settled') { this.dropped++; return; }
    switch (event.type) {
      case 'session':
        return;
      case 'started': {
        const known = this.turnId();
        if (known === undefined) {
          this.append(event);
          this.input({ kind: 'started', turnId: event.turnId });
        } else if (known !== event.turnId) {
          log.warn('provider', 'duplicate-started', { run: this.id, expected: known, received: event.turnId });
        }
        return;
      }
      case 'subagent': {
        const agent = this.ledger.upsert(event.agent);
        if (agent) this.append({ type: 'subagent', agent });
        return;
      }
      case 'step': {
        if (event.lane.kind === 'main') { this.append(event); return; }
        const agent = this.ledger.recordStep(event.lane.id, event.step);
        if (agent) this.append({ type: 'subagent', agent });
        return;
      }
      case 'todo':
        this.append({ type: 'todo', items: this.todos.replace(event.items) });
        return;
      default:
        this.append(event);
    }
  }

  private finish(outcome: Outcome): void {
    clearTimeout(this.timer);
    this.unwatch?.();
    for (const agent of this.ledger.finishRunning(Date.now())) this.append({ type: 'subagent', agent });
    this.append({ type: 'outcome', outcome });
    this.resolveOutcome(outcome);
  }

  private append(event: RunEvent): void {
    this.queue.push(structuredClone(event));
    for (const wake of this.waiters.splice(0)) wake();
  }

  private async *read(): AsyncGenerator<RunEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next) {
        yield next;
        if (next.type === 'outcome') return;
      } else if (this.state.phase === 'settled') {
        return;
      } else {
        await new Promise<void>(resolve => this.waiters.push(resolve));
      }
    }
  }
}
