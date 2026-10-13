import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { encodeCommand, ReceiptParser, type HolderCommand, type HolderReceipt } from '../../../src/provider/process/holder-protocol';

export const HOLDER_SOURCE = fileURLToPath(new URL('../../../native/holder/holder.c', import.meta.url));
export const CC_FLAGS = ['-std=c11', '-D_DEFAULT_SOURCE', '-D_DARWIN_C_SOURCE', '-Wall', '-Wextra', '-Werror', '-O2'];

export interface HolderBinary { path: string; dispose(): void }

/** Compiles holder.c once with the runner's cc. A missing cc on POSIX is a failure, not a skip: the contract says every CI runner has one. */
export function compileHolder(): HolderBinary {
  const dir = mkdtempSync(join(tmpdir(), 'vonvon-holder-'));
  const path = join(dir, 'vonvon-holder');
  try {
    execFileSync('cc', [...CC_FLAGS, HOLDER_SOURCE, '-o', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error);
    throw new Error(`cannot compile holder.c with cc: ${detail}`);
  }
  return { path, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null };
type Kind = HolderReceipt['kind'];
type Of<K extends Kind> = Extract<HolderReceipt, { kind: K }>;

/** One holder process with the six pipe slots, driven through PR 5's encoder and parser. */
export class HolderDriver {
  readonly child: ChildProcess;
  readonly exit: Promise<Exit>;
  readonly log: string[] = [];
  readonly providerOut: Buffer[] = [];
  readonly providerErr: Buffer[] = [];
  private readonly parser = new ReceiptParser();
  private readonly unread: HolderReceipt[] = [];
  private readonly waiters: Array<() => void> = [];
  private malformed: string | undefined;

  constructor(binary: string) {
    this.child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
    this.exit = once(this.child, 'exit').then(([code, signal]) => ({ code: code as number | null, signal: signal as NodeJS.Signals | null }));
    this.exit.catch(() => undefined);
    (this.child.stdout as Readable).on('data', (chunk: Buffer) => {
      for (const line of this.parser.push(chunk)) {
        if (line.kind === 'malformed') this.malformed ??= line.line;
        else this.unread.push(line);
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    (this.child.stderr as Readable).on('data', (chunk: Buffer) => this.log.push(chunk.toString()));
    this.slot(4).on('data', (chunk: Buffer) => this.providerOut.push(chunk));
    this.slot(5).on('data', (chunk: Buffer) => this.providerErr.push(chunk));
    this.child.on('exit', () => { for (const wake of this.waiters.splice(0)) wake(); });
    this.commands.on('error', () => { /* a command written after the holder exited is the daemon's unknown, not a test crash */ });
  }

  get commands(): Writable { return this.child.stdin as Writable; }
  slot(n: 3): Writable;
  slot(n: 4 | 5): Readable;
  slot(n: 3 | 4 | 5): Readable | Writable {
    // Node types stdio as a five-tuple; the sixth slot exists at runtime because spawn got six 'pipe' entries.
    const stdio = this.child.stdio as unknown as ReadonlyArray<Readable | Writable | null>;
    const stream = stdio[n];
    if (!stream) throw new Error(`holder slot ${n} is not a pipe`);
    return stream;
  }

  send(command: HolderCommand): void { this.commands.write(encodeCommand(command)); }

  /** The daemon-death signal: EOF on slot 0. */
  closeCommands(): void { this.commands.end(); }

  /** Takes the first unread receipt of this kind, waiting for it; receipts of other kinds stay for later takes. */
  async take<K extends Kind>(kind: K, timeoutMs = 10_000): Promise<Of<K>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.malformed !== undefined) throw new Error(`holder wrote a malformed receipt: ${JSON.stringify(this.malformed)}`);
      const at = this.unread.findIndex(receipt => receipt.kind === kind);
      if (at !== -1) return this.unread.splice(at, 1)[0] as Of<K>;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`holder exited (${this.child.exitCode ?? this.child.signalCode}) before writing ${kind}; unread: ${JSON.stringify(this.unread)}; log: ${this.log.join('')}`);
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${kind} receipt within ${timeoutMs} ms; unread: ${JSON.stringify(this.unread)}; log: ${this.log.join('')}`);
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
  }

  /** Every receipt seen so far of this kind, without consuming any; for absence assertions. */
  peek<K extends Kind>(kind: K): Of<K>[] { return this.unread.filter((receipt): receipt is Of<K> => receipt.kind === kind); }

  async providerStdout(predicate: (text: string) => boolean, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const text = Buffer.concat(this.providerOut).toString();
      if (predicate(text)) return text;
      if (Date.now() > deadline) throw new Error(`provider stdout never matched; got ${JSON.stringify(text)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }

  async dispose(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL');
      await this.exit;
    }
  }
}
