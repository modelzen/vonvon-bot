import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../../server/atomic-file';

export const ownedPidSchema = z.object({
  pid: z.number().int().positive().max(0x7fffffff),
  startedAtMs: z.number().finite().positive(),
  daemonBootId: z.string().min(1),
  providerId: z.enum(['codex', 'claude']),
  sessionId: z.string().min(1),
}).strict();

export type OwnedPidRecord = z.infer<typeof ownedPidSchema>;
const recordsSchema = z.array(ownedPidSchema);
const writers = new Map<string, Promise<unknown>>();

export class ProcessLedgerError extends Error {}

export function sameRecord(left: OwnedPidRecord, right: OwnedPidRecord): boolean {
  return left.pid === right.pid && left.startedAtMs === right.startedAtMs
    && left.daemonBootId === right.daemonBootId && left.providerId === right.providerId
    && left.sessionId === right.sessionId;
}

export class OwnedPidLedger {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = resolve(dataDir, 'owned-pids.json');
  }

  read(): Promise<OwnedPidRecord[]> {
    return this.serial(() => this.load());
  }

  add(record: OwnedPidRecord): Promise<void> {
    const parsed = ownedPidSchema.parse(record);
    return this.serial(async () => {
      const records = await this.load();
      if (records.some(existing => sameRecord(existing, parsed))) return;
      if (records.some(existing => existing.pid === parsed.pid)) {
        throw new ProcessLedgerError(`PID ${parsed.pid} already has an ownership record`);
      }
      await writeFileAtomic(this.path, JSON.stringify([...records, parsed]) + '\n');
    });
  }

  remove(record: OwnedPidRecord): Promise<void> {
    return this.serial(async () => {
      const records = await this.load();
      const remaining = records.filter(existing => !sameRecord(existing, record));
      if (remaining.length !== records.length) {
        await writeFileAtomic(this.path, JSON.stringify(remaining) + '\n');
      }
    });
  }

  private async load(): Promise<OwnedPidRecord[]> {
    let contents: string;
    try { contents = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    try {
      const records = recordsSchema.parse(JSON.parse(contents));
      if (new Set(records.map(record => record.pid)).size !== records.length) {
        throw new Error('Duplicate PID records');
      }
      return records;
    } catch (cause) {
      throw new ProcessLedgerError('Invalid owned-pids.json; ownership evidence was preserved', { cause });
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = writers.get(this.path) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    writers.set(this.path, next);
    const release = (): void => { if (writers.get(this.path) === next) writers.delete(this.path); };
    void next.then(release, release);
    return next;
  }
}
