import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/logger';
import { KILL_CONFIRM_MS, TERM_WAIT_MS, type ExitFact, type OwnedProcess, type ProcessFact, type SignalResult } from '../engines/engine';
import type { Os, ProviderId, UnconfirmedReason } from '../model';
import type { Refusal } from '../policy/enforcement';
import { refusalMessage } from '../policy/messages.zh';
import { EXIT_HOLD_START, stepExitHold, type ExitHoldState } from './exit-hold';
import { spawnPosixHolder, type HolderChannel } from './holder-channel';
import { newNonce, validateSignalReceipt, type CommandName, type HolderCommand, type Nonce, type ReceiptLine, type Rung } from './holder-protocol';
import { hostBootMs, readStartToken } from './identity';
import {
  advance, legacyExpired, ownershipOf, readLedger, readLegacy, writeLedger,
  type Evidence, type HostPlatform, type LedgerRecord, type Ownership, type Probe, type ReservationId, type Stage,
} from './ledger';
import { windowsCommandLine } from './windows-command-line';
import { probeWindowsJob } from './windows-job-probe';
import { newPipeName, spawnWindowsSupervisor } from './windows-supervisor';

/** Policy figure: how often an unconfirmed record resumes its continuation. */
export const RETRY_TAIL_MS = 5000;
const DEFAULT_SPAWN_DEADLINE_MS = 60_000;

/** What the holder currently holds. `lost` also covers a record recovered from an earlier boot, which no channel reaches. */
export type Identity = 'retained' | 'reaped' | 'lost';
/**
 * How far the physical cleanup got. `receipted`: a validated final `kill` receipt exists but the exit is not observed yet.
 * `observed`: both exist, so the reap is due. `probed`: the probe answered empty.
 */
export type Phase = 'signalling' | 'receipted' | 'observed' | 'reaped' | 'probed';
export type Step = { send: 'kill' | 'reap' | 'probe' } | { probe: 'daemon' } | { wait: true } | { done: 'gone' };

const STEPS: Record<Identity, Record<Phase, Step>> = {
  retained: { signalling: { send: 'kill' }, receipted: { wait: true }, observed: { send: 'reap' }, reaped: { send: 'probe' }, probed: { done: 'gone' } },
  reaped: { signalling: { send: 'probe' }, receipted: { send: 'probe' }, observed: { send: 'probe' }, reaped: { send: 'probe' }, probed: { done: 'gone' } },
  lost: { signalling: { probe: 'daemon' }, receipted: { probe: 'daemon' }, observed: { probe: 'daemon' }, reaped: { probe: 'daemon' }, probed: { done: 'gone' } },
};

/** The continuation of providers.md *terminateTree then killTree*: the next action is a function of identity and phase alone. */
export const nextStep = (state: { identity: Identity; phase: Phase }): Step => STEPS[state.identity][state.phase];

export interface SpawnSpec { file: string; args: string[]; env: Record<string, string>; cwd?: string; shim?: boolean }
export interface RecordSnapshot {
  id: ReservationId; providerId: ProviderId; sessionId?: string; stage: Stage; ownership: Ownership;
  holderPid?: number; providerPid?: number; jobName?: string; unconfirmed?: UnconfirmedReason;
}
export interface SweepReport { gone: number; unknown: number; inert: number; legacy: number }
export interface ProcessHostOptions {
  dataDir: string;
  daemonBootId: string;
  platform: HostPlatform;
  /** The compiled `vonvon-holder`; the packaged path when absent. POSIX only. */
  holderPath?: string;
  spawnDeadlineMs?: number;
}

export class AdmissionRefused extends Error {
  constructor(readonly refusal: Refusal) { super(refusal.message); }
}

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void; settled: boolean }
function deferred<T>(): Deferred<T> {
  const d = { settled: false } as Deferred<T>;
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = value => { d.settled = true; resolve(value); };
    d.reject = error => { d.settled = true; reject(error); };
  });
  d.promise.catch(() => undefined);
  return d;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms).unref());

interface Issued { command: CommandName; resolve?: (result: SignalResult) => void }

/** The host's runtime state for one ledger record. The record is the durable part; everything else is this boot's knowledge. */
interface RecordState {
  record: LedgerRecord;
  channel?: HolderChannel;
  identity: Identity;
  phase: Phase;
  exit?: ExitFact;
  probe?: Probe;
  /** The holder exited under this daemon, or its pid read absent or another start token. */
  sealed: boolean;
  /** `launch-failed`, `cancelled`, `job-collision`, or holder exit 10 or 11: a trusted no-provider fact. */
  noProvider: boolean;
  refused: boolean;
  unconfirmed?: UnconfirmedReason;
  /** Set by `end`, `closeAll`, `term`, or `kill`: a `created` after it earns no `go`. */
  latched: boolean;
  issued: Map<Nonce, Issued>;
  launchNonce?: Nonce;
  /** The continuation command awaiting its receipt; the tail clears it and resends with a fresh nonce. */
  pending?: Nonce;
  probing: boolean;
  ending?: Promise<void>;
  tail?: NodeJS.Timeout;
  spawnTimer?: NodeJS.Timeout;
  ready: Deferred<void>;
  retired: Deferred<void>;
  exitObserved: Deferred<void>;
  hold: ExitHoldState;
  holdTimer?: NodeJS.Timeout;
  facts: ProcessFact[];
  watchers: Set<(fact: ProcessFact) => void>;
}

function newState(record: LedgerRecord, channel?: HolderChannel): RecordState {
  return {
    record, channel, identity: channel ? 'retained' : 'lost', phase: 'signalling', sealed: false, noProvider: false, refused: false,
    latched: false, issued: new Map(), probing: false, ready: deferred(), retired: deferred(), exitObserved: deferred(),
    hold: EXIT_HOLD_START, facts: [], watchers: new Set(),
  };
}

function evidenceOf(s: RecordState): Evidence {
  if (s.noProvider) return { kind: 'no-provider' };
  switch (s.identity) {
    case 'retained': return { kind: 'retained' };
    case 'reaped': return { kind: 'reaped', probe: s.probe ?? 'unknown' };
    case 'lost': return s.sealed ? { kind: 'sealed', probe: s.probe ?? 'none' } : { kind: 'unsealed' };
  }
}

function unconfirmedReason(s: RecordState): UnconfirmedReason {
  if (s.refused) return 'signal-refused';
  if (!s.exit) return 'no-exit';
  return s.probe === 'live' ? 'children-alive' : 'tree-unknown';
}

const posixGroupProbe = (pid: number): Probe => {
  try { process.kill(-pid, 0); return 'live'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'empty' : 'unknown'; }
};

export function defaultHolderPath(): string {
  return fileURLToPath(new URL(`./native/${process.platform}-${process.arch}/vonvon-holder`, import.meta.url));
}

/** A single-use authorization: one `spawn` or one `release`. */
export class Reservation {
  constructor(private readonly host: ProcessHost, readonly id: ReservationId) {}
  spawn(spec: SpawnSpec): HostedProcess { return this.host.launch(this.id, spec); }
  release(): Promise<void> { return this.host.end(this.id); }
}

export class HostedProcess implements OwnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Resolves at `running`; rejects with `launch-failed`, `cancelled`, `holder-lost`, or `holder-not-ready`. */
  readonly ready: Promise<void>;
  constructor(private readonly host: ProcessHost, readonly id: ReservationId, channel: HolderChannel, ready: Promise<void>) {
    this.stdin = channel.stdin; this.stdout = channel.stdout; this.stderr = channel.stderr; this.ready = ready;
  }
  term(): Promise<SignalResult> { return this.host.signal(this.id, 'term', TERM_WAIT_MS); }
  kill(): Promise<SignalResult> { return this.host.signal(this.id, 'kill', KILL_CONFIRM_MS); }
  watch(listener: (fact: ProcessFact) => void): () => void { return this.host.watch(this.id, listener); }
  end(): Promise<void> { return this.host.end(this.id); }
}

export class ProcessHost {
  private readonly states = new Map<ReservationId, RecordState>();
  private readonly ledgerPath: string;
  private readonly legacyPath: string;
  private readonly unreadable: unknown;
  private closing = false;
  private readonly platform: HostPlatform;
  private readonly spawnDeadlineMs: number;

  constructor(private readonly options: ProcessHostOptions) {
    this.platform = options.platform;
    this.spawnDeadlineMs = options.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS;
    this.ledgerPath = join(options.dataDir, 'process-owners.json');
    this.legacyPath = join(options.dataDir, 'owned-pids.json');
    const read = readLedger(this.ledgerPath);
    if (read.kind === 'unreadable') {
      this.unreadable = read.error;
      log.warn('process-host', 'ledger-unreadable', { path: this.ledgerPath, error: String(read.error) });
    } else if (read.kind === 'ok') {
      for (const record of read.records) this.states.set(record.id, newState(record));
    }
  }

  /** POSIX: the holder binary is executable. Windows: 10 or Server 2016 for `PROC_THREAD_ATTRIBUTE_JOB_LIST`. The manifest check waits for packaging. */
  available(): boolean {
    if (this.platform === 'win32') return Number(release().split('.')[0]) >= 10;
    try { accessSync(this.options.holderPath ?? defaultHolderPath(), constants.X_OK); return true; }
    catch { return false; }
  }

  /** The admission rule: refused while the ledger is unreadable, any record is `unknown`, or the host is closing. */
  admission(providerId: ProviderId): Refusal | undefined {
    const blocked = this.unreadable !== undefined || this.closing || [...this.states.values()].some(s => this.ownership(s) === 'unknown');
    if (!blocked) return undefined;
    // The owned-work-unverified text reads neither the tier nor the OS; the runtime's own refusal carries the real context in V6b.
    return refusalMessage('owned-work-unverified', { provider: providerId, os: process.platform as Os, tier: 'qa' });
  }

  async reserve(providerId: ProviderId, sessionId?: string): Promise<Reservation | Refusal> {
    const refusal = this.admission(providerId);
    if (refusal) return refusal;
    const id = randomUUID();
    const control = this.platform === 'win32' ? { pipe: newPipeName(), jobName: `Local\\vonvon-${id}` } : undefined;
    const intent: LedgerRecord = { id, daemonBootId: this.options.daemonBootId, providerId, sessionId, stage: 'intent', control };
    const s = newState(intent);
    this.states.set(id, s);
    this.write();
    let channel: HolderChannel;
    try {
      channel = control
        ? await spawnWindowsSupervisor({ jobName: control.jobName, pipeName: control.pipe, logPath: this.holderLogPath(id), spawnDeadlineMs: this.spawnDeadlineMs })
        : await spawnPosixHolder(this.options.holderPath ?? defaultHolderPath(), { helloTimeoutMs: this.spawnDeadlineMs });
    } catch (error) {
      // The channel helpers kill their child and await its exit before rejecting, so no process exists behind this record.
      this.states.delete(id);
      this.write();
      throw error;
    }
    s.channel = channel;
    s.identity = 'retained';
    const born: LedgerRecord = {
      ...intent, stage: 'born', holder: { pid: channel.holderPid, start: channel.start },
      control: control && { ...control, osSession: channel.osSession },
    };
    s.record = advance(intent, born, this.platform);
    this.write();
    channel.onReceipt(line => this.onReceipt(s, line));
    channel.stderr.on('data', (chunk: Buffer) => log.info('process-host', 'holder-log', { id, text: chunk.toString().trimEnd() }));
    channel.stdout.once('end', () => this.feedHold(s, { kind: 'eof' }));
    void channel.exited.then(exit => this.onHolderExit(s, exit.code));
    return new Reservation(this, id);
  }

  /** `reserve`, `spawn`, then `await ready`, for engines that own their command. */
  async spawn(providerId: ProviderId, sessionId: string | undefined, spec: SpawnSpec): Promise<HostedProcess> {
    const reservation = await this.reserve(providerId, sessionId);
    if (!(reservation instanceof Reservation)) throw new AdmissionRefused(reservation);
    const hosted = reservation.spawn(spec);
    await hosted.ready;
    return hosted;
  }

  /** Synchronous: writes `attempting`, queues `launch`, and returns the facade. Rechecks admission and the closing state first. */
  launch(id: ReservationId, spec: SpawnSpec): HostedProcess {
    const s = this.states.get(id);
    if (!s || !s.channel || s.record.stage !== 'born') throw new Error(`reservation ${id} is not an unused reservation`);
    const refusal = this.admission(s.record.providerId);
    if (refusal) {
      void this.end(id);
      throw new AdmissionRefused(refusal);
    }
    s.record = advance(s.record, { ...s.record, stage: 'attempting' }, this.platform);
    this.write();
    const nonce = newNonce();
    s.launchNonce = nonce;
    s.issued.set(nonce, { command: 'launch' });
    const command: HolderCommand = this.platform === 'win32'
      ? { command: 'launch', nonce, file: spec.file, args: [windowsCommandLine(spec.file, spec.args, { shim: spec.shim === true })], env: spec.env, cwd: spec.cwd }
      : { command: 'launch', nonce, file: spec.file, args: spec.args, env: spec.env, cwd: spec.cwd };
    s.channel.send(command);
    log.info('process-host', 'launch', { id, file: spec.file });
    s.spawnTimer = setTimeout(() => { if (!s.ready.settled) s.ready.reject(new Error('holder-not-ready')); }, this.spawnDeadlineMs);
    s.spawnTimer.unref();
    return new HostedProcess(this, id, s.channel, s.ready.promise);
  }

  /** One rung with a fresh nonce; resolves with the validated receipt or `unknown` at the deadline. Never rejects. */
  signal(id: ReservationId, rung: Rung, deadlineMs: number): Promise<SignalResult> {
    const s = this.states.get(id);
    if (!s?.channel) return Promise.resolve('unknown');
    s.latched = true;
    const result = this.issue(s, rung, deadlineMs);
    if (rung === 'kill') s.ending ??= this.continueEnd(s);
    return result;
  }

  private issue(s: RecordState, rung: Rung, deadlineMs: number): Promise<SignalResult> {
    return new Promise<SignalResult>(resolve => {
      const nonce = newNonce();
      const timer = setTimeout(() => resolve('unknown'), deadlineMs);
      timer.unref();
      s.issued.set(nonce, { command: rung, resolve: result => { clearTimeout(timer); resolve(result); } });
      if (rung === 'kill') s.pending = nonce;
      if (!s.channel?.send({ command: rung, nonce })) { clearTimeout(timer); resolve('unknown'); }
    });
  }

  watch(id: ReservationId, listener: (fact: ProcessFact) => void): () => void {
    const s = this.states.get(id);
    if (!s) return () => undefined;
    for (const fact of s.facts) listener(fact);
    s.watchers.add(listener);
    return () => { s.watchers.delete(listener); };
  }

  /** The host-owned termination of one record: idempotent and joinable. Resolves when the record is gone or handed to the tail. */
  end(id: ReservationId): Promise<void> {
    const s = this.states.get(id);
    if (!s) return Promise.resolve();
    s.latched = true;
    s.ending ??= this.runEnd(s);
    return s.ending;
  }

  private async runEnd(s: RecordState): Promise<void> {
    if (!s.channel) { this.startTail(s); return; }
    if (s.record.stage === 'born') {
      this.sendPlain(s, 'abandon');
      await Promise.race([s.retired.promise, s.channel.exited]);
      return;
    }
    void this.issue(s, 'term', TERM_WAIT_MS);
    // The term wait is cut short by an observed exit: the kill rung then settles what the exit left behind.
    await Promise.race([sleep(TERM_WAIT_MS), s.retired.promise, s.exitObserved.promise]);
    if (s.retired.settled) return;
    await this.continueEnd(s);
  }

  /** From the kill rung on: wait `KILL_CONFIRM_MS` for `gone`, else record the reason and hand the record to the tail. */
  private async continueEnd(s: RecordState): Promise<void> {
    if (s.retired.settled) return;
    this.drive(s);
    await Promise.race([s.retired.promise, sleep(KILL_CONFIRM_MS)]);
    if (s.retired.settled) return;
    s.unconfirmed = unconfirmedReason(s);
    log.warn('process-host', 'unconfirmed', { id: s.record.id, reason: s.unconfirmed, identity: s.identity, phase: s.phase });
    this.startTail(s);
  }

  owesWork(): boolean {
    return [...this.states.values()].some(s => { const o = this.ownership(s); return o === 'bound' || o === 'unknown'; });
  }

  /** Releases every unused reservation and ends every record; resolves when each is gone or handed to the tail. */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.states.keys()].map(id => this.end(id)));
  }

  snapshot(): RecordSnapshot[] {
    return [...this.states.values()].map(s => {
      const r = s.record;
      return {
        id: r.id, providerId: r.providerId, sessionId: r.sessionId, stage: r.stage, ownership: this.ownership(s),
        holderPid: 'holder' in r ? r.holder.pid : undefined, providerPid: 'provider' in r ? r.provider.pid : undefined,
        jobName: r.control?.jobName, unconfirmed: s.unconfirmed,
      };
    });
  }

  /** providers.md *Recovery*: resolves every record this daemon has no channel to, and the legacy file. */
  async sweepOrphans(): Promise<SweepReport> {
    const report: SweepReport = { gone: 0, unknown: 0, inert: 0, legacy: this.sweepLegacy() };
    for (const s of [...this.states.values()]) {
      if (s.identity !== 'lost') continue;
      await this.recover(s);
      if (s.retired.settled) { report.gone += 1; continue; }
      const ownership = this.ownership(s);
      if (ownership === 'inert') report.inert += 1;
      else { report.unknown += 1; this.startTail(s); }
    }
    log.info('process-host', 'sweep', { ...report });
    return report;
  }

  /** Closes every command channel without ending anything, as the daemon's death would. For tests only. */
  simulateDaemonDeath(): void {
    for (const s of this.states.values()) {
      for (const timer of [s.tail, s.spawnTimer, s.holdTimer]) clearTimeout(timer);
      s.retired.resolve();
      s.channel?.close();
    }
    this.states.clear();
  }

  private ownership(s: RecordState): Ownership { return ownershipOf(s.record, evidenceOf(s), this.platform); }

  private write(): void {
    if (this.unreadable !== undefined) throw new Error(`process-owners.json is unreadable and is never rewritten: ${this.ledgerPath}`);
    writeLedger(this.ledgerPath, [...this.states.values()].map(s => s.record));
  }

  private holderLogPath(id: ReservationId): string {
    const dir = join(this.options.dataDir, 'holder-logs');
    mkdirSync(dir, { recursive: true });
    return join(dir, `${id}.log`);
  }

  private sendPlain(s: RecordState, command: Exclude<CommandName, 'launch' | Rung>): Nonce | undefined {
    const nonce = newNonce();
    s.issued.set(nonce, { command });
    return s.channel?.send({ command, nonce }) ? nonce : undefined;
  }

  /** Every state change ends here: retire a record whose ownership says so, else take the continuation's next step. */
  private settle(s: RecordState): void {
    if (s.retired.settled) return;
    const ownership = this.ownership(s);
    if (ownership === 'gone' || (ownership === 'inert' && s.sealed)) { this.retire(s, ownership); return; }
    // A lost identity is re-probed only by the tail and by sweepOrphans: a synchronous re-probe here would spin.
    if (s.identity === 'lost') { if (ownership === 'unknown') this.startTail(s); return; }
    if (s.latched || s.identity === 'reaped') this.drive(s);
  }

  private drive(s: RecordState): void {
    if (s.pending !== undefined || s.retired.settled) return;
    const step = nextStep(s);
    if ('send' in step) {
      if (step.send === 'kill') void this.issue(s, 'kill', KILL_CONFIRM_MS);
      else s.pending = this.sendPlain(s, step.send);
    } else if ('probe' in step) {
      void this.probeByDaemon(s);
    }
  }

  private async probeByDaemon(s: RecordState): Promise<void> {
    if (s.probing || !s.sealed) return;
    const r = s.record;
    s.probing = true;
    try {
      if (this.platform === 'win32') { if (r.control) s.probe = await probeWindowsJob(r.control); }
      else if ('provider' in r) s.probe = posixGroupProbe(r.provider.pid);
    } finally { s.probing = false; }
    if (s.probe === 'empty') {
      s.phase = 'probed';
      if (!s.exit) this.observeExit(s, { observed: 'containment' });
    }
    this.settle(s);
  }

  /** Seals a recovered or lost record through the identity reader, probes its containment, and settles it. */
  private async recover(s: RecordState): Promise<void> {
    const r = s.record;
    if (r.stage === 'intent') { this.retire(s, 'inert'); return; }
    if (!s.sealed) {
      const read = await readStartToken(r.holder.pid);
      s.sealed = read === 'absent' || (read !== 'unreadable' && r.holder.start !== undefined && read !== r.holder.start);
      if (!s.sealed && r.stage === 'born') log.info('process-host', 'inert-holder', { id: r.id, pid: r.holder.pid, start: read });
    }
    if (s.sealed && r.stage !== 'born') await this.probeByDaemon(s);
    else this.settle(s);
  }

  private startTail(s: RecordState): void {
    if (s.tail || s.retired.settled) return;
    s.tail = setInterval(() => {
      s.pending = undefined;
      if (s.channel) this.drive(s);
      else void this.recover(s);
    }, RETRY_TAIL_MS);
    s.tail.unref();
  }

  private retire(s: RecordState, ownership: Ownership): void {
    for (const timer of [s.tail, s.spawnTimer, s.holdTimer]) clearTimeout(timer);
    if (ownership === 'gone' && !s.noProvider && s.identity !== 'lost') this.sendPlain(s, 'exit');
    this.states.delete(s.record.id);
    this.write();
    s.retired.resolve();
    if (!s.ready.settled) s.ready.reject(new Error(s.noProvider ? 'launch-failed' : 'holder-lost'));
    log.info('process-host', 'retired', { id: s.record.id, stage: s.record.stage, ownership });
  }

  private observeExit(s: RecordState, exit: ExitFact): void {
    if (s.exit) return;
    s.exit = exit;
    if (s.phase === 'receipted') s.phase = 'observed';
    s.exitObserved.resolve();
    this.feedHold(s, { kind: 'exit', exit });
  }

  private feedHold(s: RecordState, input: { kind: 'eof' } | { kind: 'exit'; exit: ExitFact } | { kind: 'tick' }): void {
    const step = stepExitHold(s.hold, input, Date.now());
    s.hold = step.state;
    for (const fact of step.facts) { s.facts.push(fact); for (const watcher of s.watchers) watcher(fact); }
    clearTimeout(s.holdTimer);
    if (step.deadline !== undefined) {
      s.holdTimer = setTimeout(() => this.feedHold(s, { kind: 'tick' }), Math.max(0, step.deadline - Date.now()));
      s.holdTimer.unref();
    }
  }

  private onHolderExit(s: RecordState, code: number | null): void {
    if (s.retired.settled) return;
    s.identity = 'lost';
    s.sealed = true;
    s.pending = undefined;
    if (code === 10 || code === 11) s.noProvider = true;
    log.info('process-host', 'holder-exit', { id: s.record.id, code, stage: s.record.stage });
    if (!s.ready.settled) s.ready.reject(new Error(s.noProvider ? 'launch-failed' : 'holder-lost'));
    if (s.noProvider || !('provider' in s.record)) this.settle(s);
    else void this.probeByDaemon(s);
  }

  private onReceipt(s: RecordState, line: ReceiptLine): void {
    if (line.kind === 'malformed') { log.warn('process-host', 'malformed-receipt', { id: s.record.id, line: line.line }); return; }
    if (line.kind === 'provider-exit') { this.observeExit(s, { observed: 'parent', code: line.code, signal: line.signal }); this.settle(s); return; }
    if (line.kind === 'hello') return;
    const issued = s.issued.get(line.nonce);
    if (!issued) { log.warn('process-host', 'unmatched-receipt', { id: s.record.id, line }); return; }
    const r = s.record;
    switch (line.kind) {
      case 'created':
        if (this.platform === 'posix' && r.stage === 'attempting') {
          s.record = advance(r, { ...r, stage: 'launched', provider: { pid: line.pid } }, this.platform);
          this.write();
          if (!s.latched) this.sendPlain(s, 'go');
        }
        return;
      case 'ready': {
        const pid = this.platform === 'win32' ? line.pid : 'provider' in r ? r.provider.pid : undefined;
        if (pid === undefined || (r.stage !== 'launched' && r.stage !== 'attempting')) return;
        s.record = advance(r, { ...r, stage: 'running', holder: r.holder, provider: { pid } }, this.platform);
        this.write();
        clearTimeout(s.spawnTimer);
        s.ready.resolve();
        this.settle(s);
        return;
      }
      case 'cancelled': case 'launch-failed': case 'job-collision':
        s.noProvider = true;
        if (!s.ready.settled) s.ready.reject(new Error(line.kind === 'cancelled' ? 'cancelled' : 'launch-failed'));
        this.settle(s);
        return;
      case 'sent': case 'accepted': case 'refused': {
        if (issued.command !== 'term' && issued.command !== 'kill') {
          if (line.kind === 'refused' && line.nonce === s.pending) s.pending = undefined;
          return;
        }
        const result = validateSignalReceipt({ command: issued.command, nonce: line.nonce }, line, this.platform);
        if (result === undefined) { log.warn('process-host', 'dropped-receipt', { id: r.id, line }); return; }
        issued.resolve?.(result);
        if (line.kind === 'refused' && line.reason === 'reaped') s.identity = 'reaped';
        if (issued.command === 'kill') {
          s.refused = result === 'refused';
          if (s.phase === 'signalling') s.phase = s.exit ? 'observed' : 'receipted';
          if (line.nonce === s.pending) s.pending = undefined;
        }
        this.settle(s);
        return;
      }
      case 'reaped':
        s.identity = 'reaped';
        s.phase = 'reaped';
        s.pending = undefined;
        this.settle(s);
        return;
      case 'not-ready':
        s.pending = undefined;
        return;
      case 'empty': case 'live': case 'probe-unknown':
        s.probe = line.kind === 'empty' ? 'empty' : line.kind === 'live' ? 'live' : 'unknown';
        s.pending = undefined;
        if (s.probe === 'empty' && s.identity === 'reaped') s.phase = 'probed';
        this.settle(s);
        return;
    }
  }

  /** `owned-pids.json` from unreleased #117 builds: listed until the host rebooted past `startedAtMs`, then removed. */
  private sweepLegacy(): number {
    const records = readLegacy(this.legacyPath);
    if (records.length === 0) return 0;
    const boot = hostBootMs();
    const kept = records.filter(record => !legacyExpired(record, boot));
    if (kept.length !== records.length) {
      if (kept.length === 0) rmSync(this.legacyPath, { force: true });
      else writeFileSync(this.legacyPath, JSON.stringify(kept));
    }
    for (const record of kept) log.info('process-host', 'legacy-record', { pid: record.pid, startedAtMs: record.startedAtMs, providerId: record.providerId });
    return kept.length;
  }
}
