import { EventEmitter } from 'node:events';
import { constants } from 'node:os';
import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { ExitFact, ProcessFact } from '../engines/engine';
import type { HostedProcess, SpawnSpec } from './process-host';

export type HolderProcessErrorCode = 'transport-lost' | 'holder-lost' | 'launch-failed' | 'holder-not-ready' | 'cancelled';

export class HolderProcessError extends Error {
  constructor(readonly code: HolderProcessErrorCode) {
    super(code);
    this.name = 'HolderProcessError';
  }
}

type Raised = { ready: []; exit: [code: number | null, signal: NodeJS.Signals | null]; error: [error: HolderProcessError] };
type RaisedEvent = keyof Raised;

export function specOf(options: SpawnOptions): SpawnSpec {
  const env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  return { file: options.command, args: options.args, env, cwd: options.cwd };
}

const isSignal = (name: string): name is NodeJS.Signals => Object.hasOwn(constants.signals, name);

/** Holds the reservation id, never a pid, so a `kill()` after the record settled returns false and cannot reach whatever process the host spawns next. */
export class HolderProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly ready: Promise<void>;
  private exit?: ExitFact;
  private queued = false;
  private readonly raised = new Set<RaisedEvent>();
  private readonly awaitingListener = new Map<RaisedEvent, unknown[]>();

  constructor(private readonly hosted: HostedProcess, signal?: AbortSignal) {
    super();
    this.stdin = hosted.stdin;
    this.stdout = hosted.stdout;
    this.ready = hosted.ready;
    hosted.ready.then(
      () => this.raiseOnce('ready'),
      (error: unknown) => this.raiseOnce('error', error instanceof HolderProcessError ? error : new HolderProcessError('holder-lost')),
    );
    void hosted.holderLost.then(() => this.raiseOnce('error', new HolderProcessError('holder-lost')));
    hosted.watch(fact => this.onFact(fact));
    if (signal?.aborted) this.kill('SIGTERM');
    else signal?.addEventListener('abort', () => this.kill('SIGTERM'), { once: true });
  }

  get killed(): boolean { return this.queued; }
  get exitCode(): number | null { return this.exit?.observed === 'parent' ? this.exit.code : null; }
  get signalCode(): NodeJS.Signals | null {
    const signal = this.exit?.observed === 'parent' ? this.exit.signal : null;
    return signal !== null && isSignal(signal) ? signal : null;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const queued = this.hosted.request(signal === 'SIGKILL' ? 'kill' : 'term');
    this.queued ||= queued;
    return queued;
  }

  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    super.on(event, listener);
    this.replay(event);
    return this;
  }

  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    super.once(event, listener);
    this.replay(event);
    return this;
  }

  private onFact(fact: ProcessFact): void {
    if (fact.kind === 'transport-lost') { this.raiseOnce('error', new HolderProcessError('transport-lost')); return; }
    this.exit = fact.exit;
    this.raiseOnce('exit', this.exitCode, this.signalCode);
    // The SDK sends nothing after an exit, so end the record here to reap the group's survivors and settle the proof.
    void this.hosted.end();
  }

  private raiseOnce<E extends RaisedEvent>(event: E, ...args: Raised[E]): void {
    if (this.raised.has(event)) return;
    this.raised.add(event);
    if (this.listenerCount(event) > 0) this.emit(event, ...args);
    else this.awaitingListener.set(event, args);
  }

  private replay(event: string | symbol): void {
    const args = this.awaitingListener.get(event as RaisedEvent);
    if (!args) return;
    this.awaitingListener.delete(event as RaisedEvent);
    this.emit(event, ...args);
  }
}
