import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { agentIdSchema, groupIdSchema, recipeBinary32Schema, viewIdSchema } from '@vonvon/protocol';

const uuid = z.string().uuid();
const operation = z
  .object({ id: uuid, commitment: recipeBinary32Schema, sha: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
const base = {
  id: uuid,
  accountId: uuid,
  deviceId: uuid,
  viewId: viewIdSchema,
  pk: recipeBinary32Schema,
  botId: agentIdSchema,
  recipeId: uuid,
  versionId: uuid,
  createdAt: z.number().int(),
  fromJoin: z.boolean(),
};
const rowSchema = z.discriminatedUnion('stage', [
  z.object({ ...base, stage: z.literal('joining'), bindId: groupIdSchema.optional() }).strict(),
  z.object({ ...base, stage: z.literal('group'), groupId: groupIdSchema }).strict(),
  z
    .object({
      ...base,
      stage: z.literal('operation'),
      groupId: groupIdSchema,
      operation,
      action: z.enum(['reviewed', 'confirm', 'cancel']),
    })
    .strict(),
  z
    .object({ ...base, stage: z.literal('done'), groupId: groupIdSchema, outcome: z.enum(['applied', 'rejected']) })
    .strict(),
]);
export type RecipeJournalRow = z.infer<typeof rowSchema>;
export type RecipeOperationRef = z.infer<typeof operation>;
const fileSchema = z.object({ v: z.literal(1), rows: z.array(rowSchema).max(64) }).strict();
export class RecipeJournal {
  private rows: RecipeJournalRow[] | undefined;
  constructor(private readonly path?: string) {}
  all(): readonly RecipeJournalRow[] {
    if (!this.rows) {
      try {
        if (this.path && statSync(this.path).size > 128 * 1024) throw new Error();
        this.rows = this.path ? fileSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))).rows : [];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取安装记录');
        this.rows = [];
      }
    }
    return this.rows;
  }
  save(row: RecipeJournalRow) {
    this.write([...this.all().filter((r) => r.id !== row.id), rowSchema.parse(row)]);
  }
  remove(id: string) {
    this.write(this.all().filter((r) => r.id !== id));
  }
  private write(rows: RecipeJournalRow[]) {
    const file = fileSchema.parse({ v: 1, rows });
    if (this.path) {
      const temp = this.path + '.' + randomUUID() + '.tmp';
      const fd = openSync(temp, 'wx', 0o600);
      try {
        try {
          writeFileSync(fd, JSON.stringify(file));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, this.path);
        if (process.platform !== 'win32') {
          const dir = openSync(dirname(this.path), 'r');
          try {
            fsyncSync(dir);
          } finally {
            closeSync(dir);
          }
        }
      } catch (error) {
        this.rows = undefined;
        try {
          unlinkSync(temp);
        } catch {}
        throw error;
      }
    }
    this.rows = file.rows;
  }
}
