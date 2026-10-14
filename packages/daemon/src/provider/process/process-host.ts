import { randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'node:url';
import { log } from '../../core/logger';
import { KILL_CONFIRM_MS, TERM_WAIT_MS, type ExitFact, type OwnedProcess, type ProcessFact, type SignalResult } from '../engines/engine';
import type { ProviderId, UnconfirmedReason } from '../model';
import type { Refusal } from '../policy/enforcement';
import { ownedWorkUnverified } from '../policy/messages.zh';
import { HolderProcess, HolderProcessError, specOf, type AdoptExtras } from './holder-process';
import { EXIT_HOLD_START, stepExitHold, type ExitHoldInput, type ExitHoldState } from './exit-hold';
import { spawnPosixHolder, type HolderChannel } from './holder-channel';
import { newNonce, validateSignalReceipt, type CommandName, type Nonce, type ReceiptLine, type Rung } from './holder-protocol';
import { hostBootMs, readStartToken, type StartRead } from './identity';
import {
  advance, legacyExpired, ownershipOf, readLedger, readLegacy, writeLedger,
  type Evidence, type HostPlatform, type LedgerRecord, type Ownership, type Probe, type ReservationId, type Stage, type StartToken,
} from './ledger';
import { windowsCommandLine } from './windows-command-line';
import { probeWindowsJob } from './windows-job-probe';
import { newPipeName, spawnWindowsSupervisor } from './windows-supervisor';

export const RETRY_TAIL_MS = 5000;
export const ADMIT_WAIT_MS = 2000;
const ADMIT_POLL_MS = 25;
const LEDGER_FILE = 'process-owners.json';
const DEFAULT_SPAWN_DEADLINE_MS = 60_000;

export type Identity = 'retained' | 'reaped' | 'lost';
export type Phase = 'signalling' | 'receipted' | 'reapable' | 'reaped' | 'probed';
export type Step = { send: 'kill' | 'reap' | 'probe' } | { probe: 'daemon' } | { wait: true } | { done: 'gone' };

const STEPS: Record<Identity, Record<Phase, Step>> = {
  retained: { signalling: { send: 'kill' }, receipted: { wait: true }, reapable: { send: 'reap' }, reaped: { send: 'probe' }, probed: { done: 'gone' } },
  reaped: { signalling: { send: 'probe' }, receipted: { send: 'probe' }, reapable: { send: 'probe' }, reaped: { send: 'probe' }, probed: { done: 'gone' } },
  lost: { signalling: { probe: 'daemon' }, receipted: { probe: 'daemon' }, reapable: { probe: 'daemon' }, reaped: { probe: 'daemon' }, probed: { done: 'gone' } },
};

export const nextStep = (state: { identity: Identity; phase: Phase }): Step => STEPS[state.identity][state.phase];

export interface SpawnSpec { file: string; args: string[]; env: Record<string, string>; cwd?: string; shim?: boolean }
export interface RecordSnapshot {
  id: ReservationId; providerId: ProviderId; sessionId?: string; stage: Stage; ownership: Ownership;
  holderPid?: number; providerPid?: number; jobName?: string; unconfirmed?: UnconfirmedReason;
}
export interface SweepReport { gone: number; unknown: number; inert: number; legacy: number }
export type ProcessHostOptions = { dataDir: string; daemonBootId: string; spawnDeadlineMs?: number } & (
  | { platform: 'posix'; holderPath: string }
  | { platform: 'win32' }
);

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

interface RecordState {
  record: LedgerRecord;
  channel?: HolderChannel;
  identity: Identity;
  phase: Phase;
  exit?: ExitFact;
  probe?: Probe;
  /** The launcher can create nothing more: the holder exited under this daemon, or its pid reads absent or another start token. */
  sealed: boolean;
  noProvider: boolean;
  refused: boolean;
  unconfirmed?: UnconfirmedReason;
  endRequested: boolean;
  /** Resolves once `reserve` has a channel or has given up; `end` during setup waits for it. */
  setup?: Deferred<void>;
  /** A stage reached in memory that the ledger never recorded; ownership is then no better than unknown. */
  undurable: boolean;
  /** Set after the term wait or by the facade's kill(): only then may the signalling step send kill. */
  killDue: boolean;
  issued: Map<Nonce, Issued>;
  pending?: Nonce;
  probing: boolean;
  ending?: Promise<void>;
  tail?: NodeJS.Timeout;
  spawnTimer?: NodeJS.Timeout;
  ready: Deferred<void>;
  retired: Deferred<void>;
  exitObserved: Deferred<void>;
  holderLost: Deferred<void>;
  hold: ExitHoldState;
  holdTimer?: NodeJS.Timeout;
  facts: ProcessFact[];
  watchers: Set<(fact: ProcessFact) => void>;
}

function newState(record: LedgerRecord): RecordState {
  return {
    record, identity: 'lost', phase: 'signalling', sealed: false, noProvider: false, refused: false, endRequested: false, killDue: false, undurable: false,
    issued: new Map(), probing: false, ready: deferred(), retired: deferred(), exitObserved: deferred(), holderLost: deferred(),
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

const holderProvenGone = (read: StartRead, recorded: StartToken | undefined): boolean =>
  read === 'absent' || (read !== 'unreadable' && recorded !== undefined && read !== recorded);

const posixGroupProbe = (pid: number): Probe => {
  try { process.kill(-pid, 0); return 'live'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'empty' : 'unknown'; }
};

/** `held`: seen from outside the daemon, the record's holder is alive with its recorded start token, so a running daemon may still own it. */
export type OutsideOwnership = Ownership | 'held';
export interface InspectedRecord {
  id: ReservationId; providerId: ProviderId; sessionId?: string; stage: Stage; ownership: OutsideOwnership; holderPid?: number; providerPid?: number;
}
export type LedgerInspection =
  | { kind: 'missing'; path: string }
  | { kind: 'unreadable'; path: string; error: string }
  | { kind: 'ok'; path: string; records: InspectedRecord[] };

export async function inspectLedger(dataDir: string, platform: HostPlatform): Promise<LedgerInspection> {
  const path = join(dataDir, LEDGER_FILE);
  const read = readLedger(path);
  if (read.kind === 'missing') return { kind: 'missing', path };
  if (read.kind === 'unreadable') return { kind: 'unreadable', path, error: String(read.error) };
  const records = await Promise.all(read.records.map(async (r): Promise<InspectedRecord> => ({
    id: r.id, providerId: r.providerId, sessionId: r.sessionId, stage: r.stage, ownership: await outsideOwnership(r, platform),
    holderPid: 'holder' in r ? r.holder.pid : undefined, providerPid: 'provider' in r ? r.provider.pid : undefined,
  })));
  return { kind: 'ok', path, records };
}

async function outsideOwnership(r: LedgerRecord, platform: HostPlatform): Promise<OutsideOwnership> {
  if (r.stage === 'intent') return ownershipOf(r, { kind: 'unsealed' }, platform);
  const read = await readStartToken(r.holder.pid);
  if (!holderProvenGone(read, r.holder.start)) {
    const ownership = ownershipOf(r, { kind: 'unsealed' }, platform);
    return ownership === 'unknown' && r.holder.start !== undefined && read === r.holder.start ? 'held' : ownership;
  }
  return ownershipOf(r, await sealedEvidence(r, platform), platform);
}

async function sealedEvidence(r: Exclude<LedgerRecord, { stage: 'intent' }>, platform: HostPlatform): Promise<Evidence> {
  if (r.stage === 'born') return { kind: 'sealed', probe: 'none' };
  if (platform === 'posix') return { kind: 'sealed', probe: 'provider' in r ? posixGroupProbe(r.provider.pid) : 'none' };
  const osSession = r.control?.osSession;
  return { kind: 'sealed', probe: r.control && osSession !== undefined ? (await probeWindowsJob({ ...r.control, osSession })).probe : 'none' };
}

export function defaultHolderPath(): string {
  return fileURLToPath(new URL(`./native/${process.platform}-${process.arch}/vonvon-holder`, import.meta.url));
}

export class Reservation {
  constructor(private readonly host: ProcessHost, readonly id: ReservationId) {}
  spawn(spec: SpawnSpec): HostedProcess { return this.host.launch(this.id, spec); }
  /** An already-aborted signal never launches: the reservation is released and the facade raises `cancelled`. */
  adopt(options: SpawnOptions, extras?: AdoptExtras): HolderProcess {
    if (options.signal.aborted) return new HolderProcess(this.host.cancel(this.id), undefined, extras);
    return new HolderProcess(this.spawn(specOf(options)), options.signal, extras);
  }
  release(): Promise<void> { return this.host.end(this.id); }
}

export class HostedProcess implements OwnedProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Rejects with a `HolderProcessError` (`launch-failed`, `cancelled`, `holder-lost`, `holder-not-ready`), or with the ledger error when `attempting` was not made durable. */
  readonly ready: Promise<void>;
  /** Resolves when the holder exits before an exit fact and with a provider launched. */
  readonly holderLost: Promise<void>;
  constructor(private readonly host: ProcessHost, readonly id: ReservationId, channel: HolderChannel, ready: Promise<void>, holderLost: Promise<void>) {
    this.stdin = channel.stdin; this.stdout = channel.stdout; this.stderr = channel.stderr; this.ready = ready; this.holderLost = holderLost;
  }
  term(): Promise<SignalResult> { return this.host.signal(this.id, 'term', TERM_WAIT_MS); }
  kill(): Promise<SignalResult> { return this.host.signal(this.id, 'kill', KILL_CONFIRM_MS); }
  watch(listener: (fact: ProcessFact) => void): () => void { return this.host.watch(this.id, listener); }
  end(): Promise<void> { return this.host.end(this.id); }
  request(rung: Rung): boolean { return this.host.request(this.id, rung); }
}

export class ProcessHost {
  private readonly states = new Map<ReservationId, RecordState>();
  private readonly ledgerPath: string;
  private readonly legacyPath: string;
  private readonly unreadable: unknown;
  private closing = false;
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly platform: HostPlatform;
  private readonly spawnDeadlineMs: number;

  constructor(private readonly options: ProcessHostOptions) {
    this.platform = options.platform;
    this.spawnDeadlineMs = options.spawnDeadlineMs ?? DEFAULT_SPAWN_DEADLINE_MS;
    this.ledgerPath = join(options.dataDir, LEDGER_FILE);
    this.legacyPath = join(options.dataDir, 'owned-pids.json');
    const read = readLedger(this.ledgerPath);
    if (read.kind === 'unreadable') {
      this.unreadable = read.error;
      log.warn('process-host', 'ledger-unreadable', { path: this.ledgerPath, error: String(read.error) });
    } else if (read.kind === 'ok') {
      for (const record of read.records) this.states.set(record.id, newState(record));
    }
  }

  /** `PROC_THREAD_ATTRIBUTE_JOB_LIST` needs Windows 10 or Server 2016. The binary manifest check waits for packaging. */
  available(): boolean {
    if (this.options.platform === 'win32') return Number(release().split('.')[0]) >= 10;
    try { accessSync(this.options.holderPath, constants.X_OK); return true; }
    catch { return false; }
  }

  admission(): Refusal | undefined {
    const blocked = this.unreadable !== undefined || [...this.states.values()].some(s => this.ownership(s) === 'unknown');
    return blocked ? ownedWorkUnverified() : undefined;
  }

  /** `admission()` once the unknown records this process is still ending have settled, for at most `timeoutMs`. Any other unknown record refuses at once. */
  async admit(timeoutMs = ADMIT_WAIT_MS): Promise<Refusal | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const unknown = [...this.states.values()].filter(s => this.ownership(s) === 'unknown');
      const settling = unknown.filter(s => this.endingInFlight(s));
      if (settling.length === 0 || settling.length < unknown.length || this.unreadable !== undefined || Date.now() >= deadline) return this.admission();
      await Promise.race([...settling.map(s => s.retired.promise), sleep(ADMIT_POLL_MS)]);
    }
  }

  private endingInFlight(s: RecordState): boolean {
    return !s.retired.settled && s.unconfirmed === undefined && (s.probing || (s.identity !== 'lost' && (s.ending !== undefined || s.pending !== undefined)));
  }

  /** Rejects once `closeAll` has started, and when the `intent` record cannot be made durable; nothing is spawned in either case. */
  async reserve(providerId: ProviderId, sessionId?: string): Promise<Reservation | Refusal> {
    if (this.closing) throw new Error('process host is closing');
    const refusal = this.admission();
    if (refusal) return refusal;
    const id = randomUUID();
    const control = this.platform === 'win32' ? { pipe: newPipeName(), jobName: `Local\\vonvon-${id}` } : undefined;
    const intent: LedgerRecord = { id, daemonBootId: this.options.daemonBootId, providerId, sessionId, stage: 'intent', control };
    const s = newState(intent);
    s.setup = deferred();
    this.states.set(id, s);
    try { this.persist(); }
    catch (error) { this.states.delete(id); s.setup.resolve(); throw error; }
    const setup = this.setUp(s, control);
    this.inflight.add(setup);
    try { return await setup; }
    finally { this.inflight.delete(setup); s.setup.resolve(); }
  }

  private async setUp(s: RecordState, control: { pipe: string; jobName: string } | undefined): Promise<Reservation> {
    const id = s.record.id;
    let channel: HolderChannel;
    try {
      channel = this.options.platform === 'win32'
        ? await spawnWindowsSupervisor({ jobName: (control as { jobName: string }).jobName, pipeName: control?.pipe, logPath: this.holderLogPath(id), spawnDeadlineMs: this.spawnDeadlineMs })
        : await spawnPosixHolder(this.options.holderPath);
    } catch (error) {
      this.states.delete(id);
      this.persistOrLog();
      throw error;
    }
    s.channel = channel;
    s.identity = 'retained';
    channel.onReceipt(line => this.onReceipt(s, line));
    channel.stdout.once('end', () => this.feedHold(s, { kind: 'eof' }));
    void Promise.all([channel.exited, channel.closed]).then(([exit]) => this.onHolderExit(s, exit.code));
    if (this.closing || s.endRequested) {
      await this.abandon(s);
      throw new Error('process host is closing');
    }
    const born: LedgerRecord = {
      ...s.record, stage: 'born', holder: { pid: channel.holderPid, start: channel.start },
      control: control && { ...control, osSession: channel.osSession },
    };
    try { this.persistAdvance(s, born); }
    catch (error) {
      await this.abandon(s);
      throw error;
    }
    return new Reservation(this, id);
  }

  /** Ends an inert holder: `abandon`, then its exit, which retires the record. Bounded, so a wedged holder cannot hang the caller. */
  private async abandon(s: RecordState): Promise<void> {
    s.endRequested = true;
    this.sendPlain(s, 'abandon');
    await Promise.race([s.retired.promise, s.channel?.exited, sleep(KILL_CONFIRM_MS)]);
  }

  async spawn(providerId: ProviderId, sessionId: string | undefined, spec: SpawnSpec): Promise<HostedProcess> {
    const reservation = await this.reserve(providerId, sessionId);
    if (!(reservation instanceof Reservation)) throw new AdmissionRefused(reservation);
    const hosted = reservation.spawn(spec);
    try { await hosted.ready; }
    catch (error) { await this.end(reservation.id); throw error; }
    return hosted;
  }

  launch(id: ReservationId, spec: SpawnSpec): HostedProcess {
    const s = this.states.get(id);
    if (!s || !s.channel || s.record.stage !== 'born' || s.endRequested) throw new Error(`reservation ${id} is not an unused reservation`);
    if (this.closing) { void this.end(id); throw new Error('process host is closing'); }
    const refusal = this.admission();
    if (refusal) {
      void this.end(id);
      throw new AdmissionRefused(refusal);
    }
    try { this.persistAdvance(s, { ...s.record, stage: 'attempting' }); }
    catch (error) {
      // No launch without a durable `attempting`: the holder is abandoned and the facade's ready carries the reason.
      log.fail('process-host', error, { id, stage: 'attempting' });
      s.ready.reject(error instanceof Error ? error : new Error(String(error)));
      void this.end(id);
      return new HostedProcess(this, id, s.channel, s.ready.promise, s.holderLost.promise);
    }
    const nonce = newNonce();
    s.issued.set(nonce, { command: 'launch' });
    const args = this.platform === 'win32' ? [windowsCommandLine(spec.file, spec.args, { shim: spec.shim === true })] : spec.args;
    // A shim's command line starts with cmd.exe, so cmd.exe is the application CreateProcessW runs.
    const file = this.platform === 'win32' && spec.shim ? process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe' : spec.file;
    s.channel.send({ command: 'launch', nonce, file, args, env: spec.env, cwd: spec.cwd });
    log.info('process-host', 'launch', { id, file: spec.file });
    s.spawnTimer = setTimeout(() => { if (!s.ready.settled) s.ready.reject(new HolderProcessError('holder-not-ready')); }, this.spawnDeadlineMs);
    s.spawnTimer.unref();
    return new HostedProcess(this, id, s.channel, s.ready.promise, s.holderLost.promise);
  }

  /** Releases an unused reservation in place of a launch; the handle's `ready` rejects `cancelled`. */
  cancel(id: ReservationId): HostedProcess {
    const s = this.states.get(id);
    if (!s || !s.channel || s.record.stage !== 'born' || s.endRequested) throw new Error(`reservation ${id} is not an unused reservation`);
    s.ready.reject(new HolderProcessError('cancelled'));
    void this.end(id);
    return new HostedProcess(this, id, s.channel, s.ready.promise, s.holderLost.promise);
  }

  signal(id: ReservationId, rung: Rung, deadlineMs: number): Promise<SignalResult> {
    const s = this.states.get(id);
    if (!s?.channel) return Promise.resolve('unknown');
    s.endRequested = true;
    if (rung === 'kill') s.killDue = true;
    const { result } = this.issue(s, rung, deadlineMs);
    if (rung === 'kill') s.ending ??= this.continueEnd(s);
    return result;
  }

  /** Queues `rung` and joins `end`. False once the record is retired or the channel is closed. */
  request(id: ReservationId, rung: Rung): boolean {
    const s = this.states.get(id);
    if (!s?.channel || s.record.stage === 'intent' || s.record.stage === 'born') return false;
    s.endRequested = true;
    if (rung === 'kill') s.killDue = true;
    const { queued } = this.issue(s, rung, rung === 'kill' ? KILL_CONFIRM_MS : TERM_WAIT_MS);
    s.ending ??= rung === 'kill' ? this.continueEnd(s) : this.afterTerm(s);
    return queued;
  }

  private issue(s: RecordState, rung: Rung, deadlineMs: number): { queued: boolean; result: Promise<SignalResult> } {
    let queued = false;
    const result = new Promise<SignalResult>(resolve => {
      const nonce = newNonce();
      const timer = setTimeout(() => { resolve('unknown'); s.issued.set(nonce, { command: rung }); }, deadlineMs);
      timer.unref();
      s.issued.set(nonce, { command: rung, resolve: result => { clearTimeout(timer); resolve(result); } });
      if (rung === 'kill') s.pending = nonce;
      queued = s.channel?.send({ command: rung, nonce }) ?? false;
      if (!queued) { clearTimeout(timer); resolve('unknown'); }
    });
    return { queued, result };
  }

  watch(id: ReservationId, listener: (fact: ProcessFact) => void): () => void {
    const s = this.states.get(id);
    if (!s) return () => undefined;
    for (const fact of s.facts) listener(fact);
    s.watchers.add(listener);
    return () => { s.watchers.delete(listener); };
  }

  end(id: ReservationId): Promise<void> {
    const s = this.states.get(id);
    if (!s) return Promise.resolve();
    s.endRequested = true;
    s.ending ??= this.runEnd(s);
    return s.ending;
  }

  private async runEnd(s: RecordState): Promise<void> {
    await s.setup?.promise;
    if (s.retired.settled) return;
    if (!s.channel) { this.startTail(s); return; }
    if (s.record.stage === 'born' || s.record.stage === 'intent') { await this.abandon(s); return; }
    void this.issue(s, 'term', TERM_WAIT_MS);
    await this.afterTerm(s);
  }

  private async afterTerm(s: RecordState): Promise<void> {
    // An exit observed before the end was asked for says nothing about the survivors, which still get the term wait.
    const waits = [sleep(TERM_WAIT_MS), s.retired.promise];
    await Promise.race(s.exitObserved.settled ? waits : [...waits, s.exitObserved.promise]);
    if (s.retired.settled) return;
    await this.continueEnd(s);
  }

  private async continueEnd(s: RecordState): Promise<void> {
    if (s.retired.settled) return;
    s.killDue = true;
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

  /** Latches closing, waits for reservations still setting up, then ends every record. */
  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.inflight]);
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

  async sweepOrphans(): Promise<SweepReport> {
    const report: SweepReport = { gone: 0, unknown: 0, inert: 0, legacy: this.sweepLegacy() };
    for (const s of [...this.states.values()]) {
      if (s.identity !== 'lost') continue;
      await this.recover(s);
      if (s.retired.settled) { report.gone += 1; continue; }
      const ownership = this.ownership(s);
      if (ownership === 'inert') report.inert += 1;
      else report.unknown += 1;
      this.startTail(s);
    }
    log.info('process-host', 'sweep', { ...report });
    return report;
  }

  private ownership(s: RecordState): Ownership {
    const ownership = ownershipOf(s.record, evidenceOf(s), this.platform);
    return s.undurable && ownership === 'bound' ? 'unknown' : ownership;
  }

  /** Writes every record, with `next` in place of its record when given. Throws when the disk did not take it. */
  private persist(next?: LedgerRecord): void {
    if (this.unreadable !== undefined) throw new Error(`process-owners.json is unreadable and is never rewritten: ${this.ledgerPath}`);
    writeLedger(this.ledgerPath, [...this.states.values()].map(s => (next && s.record.id === next.id ? next : s.record)));
  }

  /** A stage is reached in memory only after the disk holds it, so no operation ever runs ahead of the durable record. */
  private persistAdvance(s: RecordState, next: LedgerRecord): void {
    const advanced = advance(s.record, next, this.platform);
    this.persist(advanced);
    s.record = advanced;
  }

  /** For removals: a failure leaves an older record on disk, which recovery reads conservatively, so it is logged. */
  private persistOrLog(): void {
    try { this.persist(); }
    catch (error) { log.fail('process-host', error, { path: this.ledgerPath }); }
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

  /** Retires the record when its ownership says so. Returns whether it is still owned. */
  private settle(s: RecordState): boolean {
    if (s.retired.settled) return false;
    const ownership = this.ownership(s);
    if (ownership === 'gone' || (ownership === 'inert' && s.sealed)) { this.retire(s, ownership); return false; }
    if (ownership === 'unknown') this.startTail(s);
    return true;
  }

  /** Sends the continuation's next holder command. The daemon's own probe of a lost identity runs only from `recover`. */
  private drive(s: RecordState): void {
    if (s.pending !== undefined || s.retired.settled || !(s.endRequested || s.identity === 'reaped')) return;
    const step = nextStep(s);
    if (!('send' in step)) return;
    if (step.send === 'kill') { if (s.killDue) void this.issue(s, 'kill', KILL_CONFIRM_MS); }
    else s.pending = this.sendPlain(s, step.send);
  }

  private async probeByDaemon(s: RecordState): Promise<void> {
    if (s.probing || !s.sealed) return;
    const r = s.record;
    s.probing = true;
    try {
      if (this.platform === 'win32') {
        if (r.control?.osSession !== undefined) {
          const result = await probeWindowsJob({ ...r.control, osSession: r.control.osSession });
          s.probe = result.probe;
          if (result.probe === 'unknown') log.warn('process-host', 'job-probe-unknown', { id: r.id, jobName: r.control.jobName, ...result });
        } else log.warn('process-host', 'job-probe-skipped', { id: r.id, reason: 'no osSession' });
      }
      else if ('provider' in r) s.probe = posixGroupProbe(r.provider.pid);
    } finally { s.probing = false; }
    if (s.probe === 'empty') {
      s.phase = 'probed';
      if (!s.exit) this.observeExit(s, { observed: 'containment' });
    }
    this.settle(s);
  }

  /** providers.md *Recovery* for one record this daemon has no channel to, or whose holder is gone. */
  private async recover(s: RecordState): Promise<void> {
    const r = s.record;
    if (r.stage === 'intent') { this.retire(s, 'inert'); return; }
    if (!s.sealed) {
      const read = await readStartToken(r.holder.pid);
      s.sealed = holderProvenGone(read, r.holder.start);
      log.info('process-host', 'recover-identity', { id: r.id, stage: r.stage, pid: r.holder.pid, recorded: r.holder.start, read, sealed: s.sealed });
    }
    if (s.sealed && r.stage !== 'born') await this.probeByDaemon(s);
    else this.settle(s);
  }

  private startTail(s: RecordState): void {
    if (s.tail || s.retired.settled) return;
    s.tail = setInterval(() => {
      s.pending = undefined;
      if (s.identity === 'lost') void this.recover(s);
      else this.drive(s);
    }, RETRY_TAIL_MS);
    s.tail.unref();
  }

  private retire(s: RecordState, ownership: Ownership): void {
    for (const timer of [s.tail, s.spawnTimer, s.holdTimer]) clearTimeout(timer);
    if (ownership === 'gone' && !s.noProvider && s.identity !== 'lost') this.sendPlain(s, 'exit');
    this.states.delete(s.record.id);
    this.persistOrLog();
    s.retired.resolve();
    if (!s.ready.settled) s.ready.reject(new HolderProcessError(s.noProvider ? 'launch-failed' : 'holder-lost'));
    log.info('process-host', 'retired', { id: s.record.id, stage: s.record.stage, ownership });
  }

  private observeExit(s: RecordState, exit: ExitFact): void {
    if (s.exit) return;
    s.exit = exit;
    if (s.phase === 'receipted') s.phase = 'reapable';
    s.exitObserved.resolve();
    this.feedHold(s, { kind: 'exit', exit });
  }

  private feedHold(s: RecordState, input: ExitHoldInput): void {
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
    if (!s.ready.settled) s.ready.reject(new HolderProcessError(s.noProvider ? 'launch-failed' : 'holder-lost'));
    if (s.noProvider || !('provider' in s.record)) this.settle(s);
    else void this.probeByDaemon(s);
    if (!s.exit && !s.noProvider && 'provider' in s.record) s.holderLost.resolve();
  }

  private onReceipt(s: RecordState, line: ReceiptLine): void {
    if (line.kind === 'malformed') { log.warn('process-host', 'malformed-receipt', { id: s.record.id, line: line.line }); return; }
    if (s.identity === 'lost') return;
    if (line.kind === 'provider-exit') {
      this.observeExit(s, { observed: 'parent', code: line.code, signal: line.signal });
      if (this.settle(s)) this.drive(s);
      return;
    }
    if (line.kind === 'hello') return;
    const issued = s.issued.get(line.nonce);
    if (!issued) { log.warn('process-host', 'unmatched-receipt', { id: s.record.id, line }); return; }
    if (line.kind !== 'created') s.issued.delete(line.nonce);
    const r = s.record;
    switch (line.kind) {
      case 'created':
        if (this.platform === 'posix' && r.stage === 'attempting') {
          try { this.persistAdvance(s, { ...r, stage: 'launched', provider: { pid: line.pid } }); }
          catch (error) {
            // No GO without a durable `launched`: abandon closes the go pipe unwritten, so the child cancels.
            log.fail('process-host', error, { id: r.id, stage: 'launched' });
            void this.abandon(s);
            return;
          }
          if (!s.endRequested) this.sendPlain(s, 'go');
        }
        return;
      case 'ready': {
        const pid = this.platform === 'win32' ? line.pid : 'provider' in r ? r.provider.pid : undefined;
        if (pid === undefined || (r.stage !== 'launched' && r.stage !== 'attempting')) return;
        const running: LedgerRecord = { ...r, stage: 'running', holder: r.holder, provider: { pid } };
        try { this.persistAdvance(s, running); }
        catch (error) {
          // The provider already runs. The disk keeps the earlier stage, which recovery reads conservatively; in memory the record is unknown until it ends.
          s.record = advance(r, running, this.platform);
          s.undurable = true;
          log.fail('process-host', error, { id: r.id, stage: 'running' });
        }
        clearTimeout(s.spawnTimer);
        s.ready.resolve();
        if (this.settle(s)) this.drive(s);
        return;
      }
      case 'cancelled': case 'launch-failed': case 'job-collision':
        s.noProvider = true;
        if (!s.ready.settled) s.ready.reject(new HolderProcessError(line.kind === 'cancelled' ? 'cancelled' : 'launch-failed'));
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
          if (s.phase === 'signalling') s.phase = s.exit ? 'reapable' : 'receipted';
          if (line.nonce === s.pending) s.pending = undefined;
        }
        if (this.settle(s)) this.drive(s);
        return;
      }
      case 'reaped':
        s.identity = 'reaped';
        s.phase = 'reaped';
        s.pending = undefined;
        if (this.settle(s)) this.drive(s);
        return;
      case 'not-ready':
        s.pending = undefined;
        return;
      case 'empty': case 'live': case 'probe-unknown':
        s.probe = line.kind === 'empty' ? 'empty' : line.kind === 'live' ? 'live' : 'unknown';
        s.pending = undefined;
        if (s.probe === 'empty' && s.identity === 'reaped') s.phase = 'probed';
        if (this.settle(s)) this.drive(s);
        return;
    }
  }

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
