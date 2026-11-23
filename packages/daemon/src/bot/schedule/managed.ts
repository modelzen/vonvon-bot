import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { dirname } from 'node:path';
import { syncDirectory } from '../../config/bot-namespace';
import { writeFileAtomic } from '../../server/atomic-file';
import type { StoredTask } from './types';

export interface ManagedTaskDefinition {
  itemId: string;
  task: StoredTask;
  contract: string;
}
interface RecordEntry {
  installation: string;
  generation: string;
  itemId: string;
  contract: string;
  consent?: string;
  task: StoredTask;
}
const rowSchema = z
  .object({
    installation: z.string().uuid(),
    generation: z.string().uuid(),
    itemId: z.string().uuid(),
    contract: z.string().regex(/^[0-9a-f]{64}$/),
    consent: z.string().optional(),
    task: z.unknown(),
  })
  .strict();
export const managedId = (install: string, item: string) =>
  'rt_' +
  createHash('sha256')
    .update(install + ':' + item)
    .digest('hex')
    .slice(0, 32);
export interface ManagedPointer {
  installation: string;
  generation: string;
  context: string;
}
export class ManagedTasks {
  private records: RecordEntry[] = [];
  constructor(
    private readonly file: () => string,
    private readonly active: (chat: string) => ManagedPointer | undefined,
    private readonly parse: (input: unknown) => StoredTask,
  ) {}
  async load() {
    let raw: string;
    try {
      raw = await readFile(this.file(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const rows = z
      .object({ v: z.literal(1), records: z.array(rowSchema).max(4096) })
      .strict()
      .parse(JSON.parse(raw));
    this.records = rows.records.map((rec) => ({ ...rec, task: this.parse(rec.task) }));
    for (const rec of this.records)
      if (rec.task.id !== managedId(rec.installation, rec.itemId)) throw new Error('配方任务记录损坏');
  }
  private async save(rows: RecordEntry[]) {
    if (rows.length > 4096) throw new Error('本机配方任务记录已满');
    await writeFileAtomic(this.file(), JSON.stringify({ v: 1, records: rows }), { durable: true });
    await syncDirectory(dirname(this.file()));
    this.records = rows;
  }
  private visible(row: RecordEntry) {
    const ref = this.active(row.task.chatId);
    return ref?.installation === row.installation && ref.generation === row.generation;
  }
  private context(row: RecordEntry) {
    return JSON.stringify([row.contract, this.active(row.task.chatId)?.context]);
  }
  private view(row: RecordEntry): StoredTask {
    const task = structuredClone(row.task);
    if (task.state === 'active' && row.consent !== this.context(row)) {
      task.state = 'paused';
      task.pausedReason = 'manual';
    }
    return task;
  }
  all(): StoredTask[] {
    return this.records.filter((row) => this.visible(row)).map((row) => this.view(row));
  }
  async stage(installation: string, generation: string, definitions: ManagedTaskDefinition[]) {
    const old = this.records.filter((row) => row.installation === installation && this.visible(row));
    if (this.records.some((row) => row.installation === installation && row.generation === generation)) {
      const held = this.records.filter((row) => row.installation === installation && row.generation === generation);
      if (
        held.length !== definitions.length ||
        definitions.some((d) => !held.some((r) => r.itemId === d.itemId && r.contract === d.contract))
      )
        throw new Error('配方任务代次冲突');
      return;
    }
    const added = definitions.map(({ itemId, task, contract }): RecordEntry => {
      const prev = old.find((row) => row.itemId === itemId);
      const result = this.parse({
        ...task,
        id: managedId(installation, itemId),
        state: 'paused',
        pausedReason: 'manual',
        ...(prev ? { counts: prev.task.counts, recent: prev.task.recent, lastResult: prev.task.lastResult } : {}),
      });
      const same = prev && contract === prev.contract;
      if (same)
        Object.assign(result, {
          state: prev.task.state,
          pausedReason: prev.task.pausedReason,
          createdBy: prev.task.createdBy,
          timeZone: prev.task.timeZone,
          cursor: prev.task.cursor,
          spec: prev.task.spec,
        });
      return {
        installation,
        generation,
        itemId,
        contract,
        task: result,
        ...(same && prev.consent ? { consent: prev.consent } : {}),
      };
    });
    await this.save([...this.records, ...added]);
  }
  async consent(id: string, expected: string, choices: { actor: string; timeZone: string }, now: number) {
    const rows = structuredClone(this.records),
      row = rows.find((r) => r.task.id === id && this.visible(r));
    if (!row || this.context(row) !== expected) throw new Error('任务条件已改变，请重新确认');
    const zone = new Intl.DateTimeFormat('en', { timeZone: choices.timeZone }).resolvedOptions().timeZone;
    row.task = this.parse({
      ...row.task,
      timeZone: zone,
      createdBy: { via: 'desktop', openId: choices.actor, role: 'admin' },
      state: 'active',
      pausedReason: undefined,
      cursor: now,
    });
    row.consent = expected;
    await this.save(rows);
  }
  review(id: string) {
    const row = this.records.find((r) => r.task.id === id && this.visible(r));
    return row ? this.context(row) : undefined;
  }
  async persist(visible: StoredTask[]) {
    const byId = new Map(visible.map((task) => [task.id, task]));
    const rows = this.records.map((row) => {
      if (!this.visible(row)) return row;
      const task = byId.get(row.task.id);
      if (!task) throw new Error('请通过配方管理已有任务');
      if (task.state === 'active' && row.consent !== this.context(row)) throw new Error('请先为配方任务确认本机运行条件');
      const keys = ['id', 'name', 'instruction', 'createdBy', 'timeZone', 'placement', 'spec', 'chatId'] as const;
      if (keys.some((key) => JSON.stringify(task[key]) !== JSON.stringify(row.task[key])))
        throw new Error('请通过配方管理已有任务');
      return { ...row, task: this.parse(task) };
    });
    await this.save(rows);
  }
}
