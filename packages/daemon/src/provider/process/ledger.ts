import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { z } from 'zod';
import type { ProviderId } from '../model';

export type ReservationId = string;
export type StartToken = string & { readonly __brand: 'StartToken' };
export interface HolderIdentity { pid: number; start?: StartToken }
export type WindowsControl = { pipe: string; jobName: string; osSession?: number };
export type LedgerRecord = { id: ReservationId; daemonBootId: string; providerId: ProviderId; sessionId?: string; control?: WindowsControl } & (
  | { stage: 'intent' }
  | { stage: 'born'; holder: HolderIdentity }
  | { stage: 'attempting'; holder: HolderIdentity }
  | { stage: 'launched'; holder: HolderIdentity; provider: { pid: number } }
  | { stage: 'running'; holder: HolderIdentity; provider: { pid: number } }
);
export type Stage = LedgerRecord['stage'];
export type Ownership = 'inert' | 'bound' | 'unknown' | 'gone';
export type HostPlatform = 'posix' | 'win32';

export const startToken = (value: string): StartToken => value as StartToken;

const NEXT_STAGE: Record<HostPlatform, Partial<Record<Stage, Stage>>> = {
  posix: { intent: 'born', born: 'attempting', attempting: 'launched', launched: 'running' },
  win32: { intent: 'born', born: 'attempting', attempting: 'running' },
};

export function advance(record: LedgerRecord, next: LedgerRecord, platform: HostPlatform): LedgerRecord {
  if (next.id !== record.id || NEXT_STAGE[platform][record.stage] !== next.stage) {
    throw new Error(`illegal ledger transition ${record.stage} -> ${next.stage} on ${platform} for ${record.id}`);
  }
  return next;
}

export type Probe = 'empty' | 'live' | 'unknown';
/** What the host knows about a record's holder right now. Sealed means the launcher can create nothing more. */
export type Evidence =
  | { kind: 'retained' }                            // this daemon's channel is open and the holder still retains the provider
  | { kind: 'reaped'; probe: Probe }                // this daemon's holder is alive but has reaped the provider
  | { kind: 'no-provider' }                         // launch-failed or never-launched, receipted and observed by this daemon
  | { kind: 'sealed'; probe: Probe | 'none' }        // holder exited, or its pid reads absent or carries another start token
  | { kind: 'unsealed' };                           // holder alive without a channel to this daemon, or its identity is unreadable

export function ownershipOf(record: LedgerRecord, evidence: Evidence, platform: HostPlatform): Ownership {
  if (record.stage === 'intent' || record.stage === 'born') return 'inert';
  switch (evidence.kind) {
    case 'retained': return 'bound';
    case 'no-provider': return 'gone';
    case 'unsealed': return 'unknown';
    case 'reaped': return record.stage === 'running' && evidence.probe === 'empty' ? 'gone' : 'unknown';
    case 'sealed':
      // A POSIX holder sealed before `launched` was durable never wrote GO, so its child could only cancel.
      if (record.stage === 'attempting' && platform === 'posix') return 'gone';
      return evidence.probe === 'empty' ? 'gone' : 'unknown';
  }
}

const pid = z.number().int().positive();
const holder = z.strictObject({ pid, start: z.string().min(1).transform(startToken).optional() });
const base = {
  id: z.string().min(1),
  daemonBootId: z.string().min(1),
  providerId: z.enum(['codex', 'claude']),
  sessionId: z.string().optional(),
  control: z.strictObject({ pipe: z.string().min(1), jobName: z.string().min(1), osSession: z.number().int().nonnegative().optional() }).optional(),
};
const recordSchema = z.discriminatedUnion('stage', [
  z.strictObject({ ...base, stage: z.literal('intent') }),
  z.strictObject({ ...base, stage: z.literal('born'), holder }),
  z.strictObject({ ...base, stage: z.literal('attempting'), holder }),
  z.strictObject({ ...base, stage: z.literal('launched'), holder, provider: z.strictObject({ pid }) }),
  z.strictObject({ ...base, stage: z.literal('running'), holder, provider: z.strictObject({ pid }) }),
]);
const fileSchema = z.strictObject({ version: z.literal(1), records: z.array(recordSchema) })
  .refine(file => new Set(file.records.map(record => record.id)).size === file.records.length, 'duplicate reservation id');

export type LedgerRead = { kind: 'ok'; records: LedgerRecord[] } | { kind: 'missing' } | { kind: 'unreadable'; error: unknown };

/** Any record that does not parse makes the whole file unreadable; the caller must never rewrite it. */
export function readLedger(path: string): LedgerRead {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if (isErrno(error, 'ENOENT')) return { kind: 'missing' };
    return { kind: 'unreadable', error };
  }
  try {
    return { kind: 'ok', records: fileSchema.parse(JSON.parse(text)).records };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

export function writeLedger(path: string, records: readonly LedgerRecord[]): void {
  if (records.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  const fd = openSync(temporary, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify({ version: 1, records }) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temporary, path);
}

/** A record of #117's `owned-pids.json`. Never signalled and never compared with a start token. */
export interface LegacyRecord { pid: number; startedAtMs: number; daemonBootId: string; providerId: string; sessionId: string }

const legacySchema = z.object({ pid, startedAtMs: z.number().finite(), daemonBootId: z.string(), providerId: z.string(), sessionId: z.string() });

export function readLegacy(path: string): LegacyRecord[] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return []; }
  if (!Array.isArray(value)) return [];
  return value.flatMap(entry => {
    const parsed = legacySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

export const legacyExpired = (record: LegacyRecord, hostBootMs: number): boolean => hostBootMs > record.startedAtMs;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
