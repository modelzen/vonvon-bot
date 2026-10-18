import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';

export class ProviderProcessCleanupError extends Error {}
/** Process group is gone; the only reported failure is its nonzero exit status. */
export class ProviderProcessExitError extends ProviderProcessCleanupError {}

const ownedProcesses = new Set<OwnedProviderProcess>();
let accepting = true;
let registryClose: Promise<void> | undefined;

export function closeOwnedProviderProcesses(): Promise<void> {
  if (registryClose) return registryClose;
  accepting = false;
  registryClose = Promise.allSettled([...ownedProcesses].map(process => process.close())).then(results => {
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Provider process cleanup failed');
  });
  return registryClose;
}

export function unconfirmedProviderPids(): number[] {
  return [...ownedProcesses].flatMap(process => process.unconfirmedPid === undefined ? [] : [process.unconfirmedPid]);
}

type Exit = { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const hasCode = (error: unknown, code: string): boolean => error instanceof Error && 'code' in error && error.code === code;

export class OwnedProviderProcess {
  readonly child: ChildProcess;
  private readonly pid: number | undefined;
  readonly exited: Promise<Exit>;
  private directExit: Exit | undefined;
  private groupGone = false;
  private unconfirmed = false;
  /** set before our SIGTERM: a child that handles it and exits 143 (the Claude CLI does) stopped as asked */
  private terminating = false;
  private readonly errors = new Map<string, unknown>();
  private readonly closed: Promise<void>;
  private closing: Promise<void> | undefined;

  constructor(command: string, args: string[], options: SpawnOptions, private readonly provider = 'Codex') {
    if (!accepting) throw new Error(`${this.provider} process registry is closed`);
    this.child = spawnProcess(command, args, { ...options, detached: true });
    this.pid = this.child.pid;
    this.closed = new Promise(resolve => this.child.once('close', () => resolve()));
    this.exited = new Promise((resolve, reject) => {
      this.child.once('exit', (code, signal) => {
        this.directExit = { kind: 'exit', code, signal };
        const askedToStop = this.terminating || this.child.killed;
        if (code !== null && code !== 0 && !(askedToStop && code === 143)) this.record('exit', new Error(`${this.provider} child exited with code ${code}`));
        resolve(this.directExit);
      });
      this.child.on('error', error => {
        if (this.pid === undefined) reject(error);
        else this.record('process', error);
      });
    });
    void this.exited.catch(() => undefined);
    if (this.pid !== undefined) ownedProcesses.add(this);
  }

  get unconfirmedPid(): number | undefined {
    return this.unconfirmed ? this.pid : undefined;
  }

  close(graceMs = 4000): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.stop(graceMs);
    void this.closing.then(() => ownedProcesses.delete(this), () => ownedProcesses.delete(this));
    return this.closing;
  }

  private record(kind: string, error: unknown): void {
    if (!this.errors.has(kind)) this.errors.set(kind, error);
  }

  private signalGroup(signal: NodeJS.Signals | 0): void {
    if (this.groupGone || this.pid === undefined) return;
    try { process.kill(-this.pid, signal); }
    catch (error) {
      if (hasCode(error, 'ESRCH')) this.groupGone = true;
      else if (!(signal === 0 && hasCode(error, 'EPERM'))) this.record(`signal-${signal}`, error);
    }
  }

  private deathConfirmed(): boolean {
    this.signalGroup(0);
    return this.directExit !== undefined && this.groupGone;
  }

  private async waitForDeath(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!this.deathConfirmed()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(25, remaining));
    }
    return true;
  }

  private killGroup(): void {
    this.signalGroup(0);
    if (this.groupGone) return;
    this.record('forced', new Error(`${this.provider} process group required SIGKILL`));
    this.signalGroup('SIGKILL');
  }

  private async stop(graceMs: number): Promise<void> {
    if (this.pid === undefined) return;
    this.terminating = true;
    this.signalGroup('SIGTERM');
    if (!await this.waitForDeath(Math.min(Math.max(0, graceMs), 4000))) {
      this.killGroup();
      await this.waitForDeath(2000);
    }
    while (!this.deathConfirmed()) {
      this.unconfirmed = true;
      this.killGroup();
      await sleep(1000);
    }
    this.unconfirmed = false;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.closed, new Promise<void>(resolve => {
        timer = setTimeout(() => {
          this.record('pipes', new Error(`${this.provider} child pipes did not close`));
          resolve();
        }, 500);
      })]);
    } finally { clearTimeout(timer); }
    if (this.errors.size) {
      const Failure = this.errors.size === 1 && this.errors.has('exit') ? ProviderProcessExitError : ProviderProcessCleanupError;
      throw new Failure(`${this.provider} 子进程树已退出，但清理失败`, {
        cause: new AggregateError(this.errors.values(), 'Provider cleanup errors'),
      });
    }
  }
}
