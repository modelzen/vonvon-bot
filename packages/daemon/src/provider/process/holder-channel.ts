import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { encodeCommand, ReceiptParser, type HolderCommand, type ReceiptLine } from './holder-protocol';
import { readStartToken } from './identity';
import type { HostPlatform, StartToken } from './ledger';

export type HolderExit = { code: number | null; signal: NodeJS.Signals | null };

/**
 * One command-and-receipt channel to a holder, the same shape over the POSIX `vonvon-holder` and the Windows supervisor.
 * It carries bytes and parsed lines only; the reservation, the ledger, and the facade sit above it in 6c.
 */
export interface HolderChannel {
  readonly platform: HostPlatform;
  readonly holderPid: number;
  /** Absent when the identity reader failed (POSIX) or the hello carried none (never on Windows). */
  readonly start?: StartToken;
  /** From the supervisor's hello; absent on POSIX. */
  readonly osSession?: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Queues a command. `false` once the channel is closed, which is the facade's `unknown`, never a throw. */
  send(command: HolderCommand): boolean;
  /** Every parsed receipt line, malformed ones included so the host can log them. Returns the unsubscribe. */
  onReceipt(listener: (line: ReceiptLine) => void): () => void;
  /** The receipt stream reached EOF: the holder closed its end or died. */
  readonly closed: Promise<void>;
  readonly exited: Promise<HolderExit>;
}

interface ChannelParts {
  platform: HostPlatform;
  child: ChildProcess;
  commands: Writable;
  receipts: Readable;
  stdio: { stdin: Writable; stdout: Readable; stderr: Readable };
  start?: StartToken;
  osSession?: number;
}

export const POSIX_HOLDER_HELLO_VERSION = 1;
const DEFAULT_HELLO_MS = 10_000;

export function channelOver(parts: ChannelParts): HolderChannel {
  const listeners = new Set<(line: ReceiptLine) => void>();
  const parser = new ReceiptParser();
  let open = true;
  parts.receipts.on('data', (chunk: Buffer) => {
    for (const line of parser.push(chunk)) for (const listener of listeners) listener(line);
  });
  const closed = new Promise<void>(resolve => parts.receipts.once('end', resolve)).then(() => { open = false; });
  parts.receipts.once('close', () => { open = false; });
  parts.commands.on('error', () => { open = false; });
  return {
    platform: parts.platform,
    holderPid: parts.child.pid ?? 0,
    start: parts.start,
    osSession: parts.osSession,
    ...parts.stdio,
    send: command => {
      if (!open || parts.commands.destroyed || parts.commands.writableEnded) return false;
      parts.commands.write(encodeCommand(command));
      return true;
    },
    onReceipt: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    closed,
    exited: exitOf(parts.child),
  };
}

export function exitOf(child: ChildProcess): Promise<HolderExit> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}

/** The first receipt line on a fresh channel, or `eof` when the holder closes first, or `timeout`. */
export function firstReceipt(channel: HolderChannel, timeoutMs: number): Promise<ReceiptLine | 'eof' | 'timeout'> {
  return new Promise(resolve => {
    const done = (result: ReceiptLine | 'eof' | 'timeout') => { clearTimeout(timer); off(); resolve(result); };
    const off = channel.onReceipt(done);
    const timer = setTimeout(() => done('timeout'), timeoutMs);
    void channel.closed.then(() => done('eof'));
  });
}

export async function killAndReject(child: ChildProcess, message: string): Promise<never> {
  child.kill('SIGKILL');
  await exitOf(child);
  throw new Error(message);
}

/**
 * Spawns `vonvon-holder` with the six pipe slots of the contract and waits for `hello vonvon-holder 1`.
 * Anything else on slot 1 first, or silence past the deadline, kills the holder and rejects.
 */
export async function spawnPosixHolder(binaryPath: string, options: { helloTimeoutMs?: number } = {}): Promise<HolderChannel> {
  const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'], detached: true });
  const commands = child.stdin as Writable;
  const receipts = child.stdout as Readable;
  commands.on('error', () => { /* a command written after the holder exited is `unknown`, not a crash */ });
  const stdio = child.stdio as unknown as ReadonlyArray<Readable | Writable | null>;
  const [stdin, stdout, stderr] = [stdio[3] as Writable, stdio[4] as Readable, stdio[5] as Readable];
  const read = child.pid === undefined ? 'unreadable' : readStartToken(child.pid);
  const channel = channelOver({ platform: 'posix', child, commands, receipts, stdio: { stdin, stdout, stderr } });
  const hello = await firstReceipt(channel, options.helloTimeoutMs ?? DEFAULT_HELLO_MS);
  if (hello === 'eof' || hello === 'timeout') return killAndReject(child, `vonvon-holder ${binaryPath}: no hello (${hello})`);
  if (hello.kind !== 'hello' || hello.version !== POSIX_HOLDER_HELLO_VERSION) {
    return killAndReject(child, `vonvon-holder ${binaryPath}: unexpected first receipt ${JSON.stringify(hello)}`);
  }
  const token = await read;
  return token === 'absent' || token === 'unreadable' ? channel : { ...channel, start: token };
}
