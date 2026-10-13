import { randomUUID } from 'node:crypto';
import type { SignalResult } from '../engines/engine';
import type { HostPlatform } from './ledger';

export type Nonce = string;
export type Rung = 'term' | 'kill';
export type HolderCommand =
  | { command: 'launch'; nonce: Nonce; file: string; args: readonly string[]; env: Readonly<Record<string, string>>; cwd?: string }
  | { command: 'go' | 'abandon' | Rung | 'reap' | 'probe' | 'exit'; nonce: Nonce };
export type CommandName = HolderCommand['command'];
export type RefusalReason = number | 'reaped' | 'not-launched' | 'already-created' | 'already-sent' | 'cancelled';

export type HolderReceipt =
  | { kind: 'hello'; version: number }
  | { kind: 'created'; nonce: Nonce; pid: number }
  | { kind: 'ready'; nonce: Nonce; pid?: number }
  | { kind: 'cancelled'; nonce: Nonce }
  | { kind: 'launch-failed'; nonce: Nonce; step?: string; errno: number }
  | { kind: 'job-collision'; nonce: Nonce }
  | { kind: 'sent'; rung: Rung; nonce: Nonce }
  | { kind: 'accepted'; rung: Rung; nonce: Nonce }
  | { kind: 'refused'; command: CommandName; nonce: Nonce; reason: RefusalReason }
  | { kind: 'reaped' | 'not-ready' | 'empty' | 'live'; nonce: Nonce }
  | { kind: 'probe-unknown'; nonce: Nonce; errno: number }
  | { kind: 'provider-exit'; code: number | null; signal: string | null };
export type ReceiptLine = HolderReceipt | { kind: 'malformed'; line: string };

const NONCE = /^[A-Za-z0-9-]{1,32}$/;
const DECIMAL = /^\d+$/;
const COMMANDS: readonly string[] = ['launch', 'go', 'abandon', 'term', 'kill', 'reap', 'probe', 'exit'];
const REFUSALS: readonly string[] = ['reaped', 'not-launched', 'already-created', 'already-sent', 'cancelled'] satisfies RefusalReason[];

export const newNonce = (): Nonce => randomUUID().replaceAll('-', '');

const isNonce = (value: string | undefined): value is Nonce => value !== undefined && NONCE.test(value);
const decimal = (value: string | undefined): number | undefined => value !== undefined && DECIMAL.test(value) ? Number(value) : undefined;
const isRung = (value: string | undefined): value is Rung => value === 'term' || value === 'kill';
const isRefusal = (value: string): value is Exclude<RefusalReason, number> => REFUSALS.includes(value);
const isCommand = (value: string | undefined): value is CommandName => value !== undefined && COMMANDS.includes(value);

function nonceOnly<K extends 'cancelled' | 'job-collision' | 'reaped' | 'not-ready' | 'empty' | 'live'>(kind: K) {
  return (fields: string[]) => fields.length === 1 && isNonce(fields[0]) ? { kind, nonce: fields[0] } : undefined;
}

const PARSERS: Record<string, (fields: string[]) => HolderReceipt | undefined> = {
  hello: ([name, version, ...rest]) => {
    const parsed = decimal(version);
    return name === 'vonvon-holder' && parsed !== undefined && rest.length === 0 ? { kind: 'hello', version: parsed } : undefined;
  },
  created: ([nonce, pid, ...rest]) => {
    const parsed = decimal(pid);
    return isNonce(nonce) && parsed !== undefined && rest.length === 0 ? { kind: 'created', nonce, pid: parsed } : undefined;
  },
  ready: ([nonce, pid, ...rest]) => {
    if (!isNonce(nonce) || rest.length > 0) return undefined;
    if (pid === undefined) return { kind: 'ready', nonce };
    const parsed = decimal(pid);
    return parsed === undefined ? undefined : { kind: 'ready', nonce, pid: parsed };
  },
  'launch-failed': fields => {
    const [nonce, ...tail] = fields;
    const errno = decimal(tail.at(-1));
    if (!isNonce(nonce) || errno === undefined) return undefined;
    if (tail.length === 1) return { kind: 'launch-failed', nonce, errno };
    const step = tail[0];
    return tail.length === 2 && step && /^[A-Za-z0-9_-]+$/.test(step) ? { kind: 'launch-failed', nonce, step, errno } : undefined;
  },
  sent: ([rung, nonce, ...rest]) => isRung(rung) && isNonce(nonce) && rest.length === 0 ? { kind: 'sent', rung, nonce } : undefined,
  accepted: ([rung, nonce, ...rest]) => isRung(rung) && isNonce(nonce) && rest.length === 0 ? { kind: 'accepted', rung, nonce } : undefined,
  refused: ([command, nonce, reason, ...rest]) => {
    if (!isCommand(command) || !isNonce(nonce) || reason === undefined || rest.length > 0) return undefined;
    const errno = decimal(reason);
    if (errno !== undefined) return { kind: 'refused', command, nonce, reason: errno };
    return isRefusal(reason) ? { kind: 'refused', command, nonce, reason } : undefined;
  },
  'probe-unknown': ([nonce, errno, ...rest]) => {
    const parsed = decimal(errno);
    return isNonce(nonce) && parsed !== undefined && rest.length === 0 ? { kind: 'probe-unknown', nonce, errno: parsed } : undefined;
  },
  'provider-exit': ([code, signal, ...rest]) => {
    const parsedCode = code === '-' ? null : decimal(code);
    const parsedSignal = signal === '-' ? null : signal !== undefined && /^SIG[A-Z0-9]+$/.test(signal) ? signal : undefined;
    return parsedCode !== undefined && parsedSignal !== undefined && rest.length === 0
      ? { kind: 'provider-exit', code: parsedCode, signal: parsedSignal } : undefined;
  },
  cancelled: nonceOnly('cancelled'),
  'job-collision': nonceOnly('job-collision'),
  reaped: nonceOnly('reaped'),
  'not-ready': nonceOnly('not-ready'),
  empty: nonceOnly('empty'),
  live: nonceOnly('live'),
};

export function parseReceipt(line: string): ReceiptLine {
  const [keyword, ...fields] = line.split(' ');
  const parser = /^[\x20-\x7e]+$/.test(line) && keyword !== undefined && Object.hasOwn(PARSERS, keyword) ? PARSERS[keyword] : undefined;
  return parser?.(fields) ?? { kind: 'malformed', line };
}

/** Splits the receipt stream into lines across chunk boundaries. */
export class ReceiptParser {
  private pending = Buffer.alloc(0);

  push(chunk: Buffer): ReceiptLine[] {
    let buffer = Buffer.concat([this.pending, chunk]);
    const lines: ReceiptLine[] = [];
    for (let end = buffer.indexOf(0x0a); end !== -1; end = buffer.indexOf(0x0a)) {
      lines.push(parseReceipt(buffer.subarray(0, end).toString('latin1')));
      buffer = buffer.subarray(end + 1);
    }
    this.pending = buffer;
    return lines;
  }
}

function frame(value: string): Buffer {
  if (value.includes('\0')) throw new Error('a launch field cannot contain NUL');
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([Buffer.from(`${bytes.length}\n`), bytes]);
}

export function encodeCommand(command: HolderCommand): Buffer {
  if (!isNonce(command.nonce)) throw new Error(`invalid nonce: ${command.nonce}`);
  const head = Buffer.from(`${command.command} ${command.nonce}\n`);
  if (command.command !== 'launch') return head;
  const env = Object.entries(command.env).map(([key, value]) => {
    if (key === '' || key.includes('=')) throw new Error(`invalid environment key: ${key}`);
    return frame(`${key}=${value}`);
  });
  return Buffer.concat([
    head, frame(command.file),
    Buffer.from(`${command.args.length}\n`), ...command.args.map(frame),
    Buffer.from(`${env.length}\n`), ...env,
    frame(command.cwd ?? ''),
  ]);
}

/** The signal truth for an issued term or kill. undefined means drop the receipt: it answers some other command. */
export function validateSignalReceipt(issued: { command: Rung; nonce: Nonce }, receipt: ReceiptLine, platform: HostPlatform): SignalResult | undefined {
  switch (receipt.kind) {
    case 'sent':
      return receipt.rung === issued.command && receipt.nonce === issued.nonce ? 'sent' : undefined;
    case 'refused':
      return receipt.command === issued.command && receipt.nonce === issued.nonce ? 'refused' : undefined;
    case 'accepted':
      return platform === 'win32' && receipt.rung === 'term' && issued.command === 'term' && receipt.nonce === issued.nonce ? 'accepted' : undefined;
    default:
      return undefined;
  }
}
