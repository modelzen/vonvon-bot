import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  agentIdSchema,
  groupIdSchema,
  recipeBinary32Schema,
  viewIdSchema,
  type AuthoringOperation,
  type AuthoringReconciliation,
} from '@vonvon/protocol';
import { AuthoringError, invalidAuthoring } from './recipe-authoring-cloud.js';

const uuid = z.string().uuid();
const record = z
  .object({
    accountId: uuid,
    viewId: viewIdSchema,
    deviceId: uuid,
    deviceKey: recipeBinary32Schema,
    botId: agentIdSchema,
    operationId: uuid,
    purpose: z.enum(['prepareDraft', 'editDraft']),
    targetPublicKey: recipeBinary32Schema,
    nonceCommitment: recipeBinary32Schema,
    groupId: groupIdSchema.optional(),
    draftId: uuid.optional(),
    baseRevision: z.number().int().positive().optional(),
    createdAt: z.number().int().nonnegative(),
    cancelling: z.boolean(),
  })
  .strict();
const file = z.object({ version: z.literal(1), rows: z.array(record).max(1024) }).strict();
type Binding = Pick<z.infer<typeof record>, 'accountId' | 'viewId' | 'deviceId' | 'deviceKey' | 'botId'>;
type Row = z.infer<typeof record>;
export class AuthoringJournal {
  private rows?: Row[];
  constructor(private readonly path?: string) {}
  private all() {
    if (this.rows) return this.rows;
    try {
      if (this.path && statSync(this.path).size > 1024 * 1024) throw invalidAuthoring();
      this.rows = this.path ? file.parse(JSON.parse(readFileSync(this.path, 'utf8'))).rows : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AuthoringError('无法读取私人草稿操作记录。');
      this.rows = [];
    }
    return this.rows;
  }
  checkReconciliation(binding: Binding, recovery: AuthoringReconciliation) {
    if (recovery.purpose === 'prepareDraft' ? recovery.draftId || recovery.baseRevision : !recovery.draftId || !recovery.baseRevision)
      throw invalidAuthoring();
    const prior = this.all().find(row => row.operationId === recovery.operationId);
    if (!prior) return; // Revoked before first Main observation: verify against the authenticated daemon and cloud registration.
    const { operationId, purpose, targetPublicKey, nonceCommitment, draftId, baseRevision, createdAt } = recovery;
    const identity = { ...binding, operationId, purpose, targetPublicKey, nonceCommitment, draftId, baseRevision, createdAt };
    if (Object.entries(identity).some(([key,value]) => prior[key as keyof Row] !== value)) throw invalidAuthoring();
  }
  observe(binding: Binding, op: AuthoringOperation, cancel = false) {
    if (
      op.purpose === 'prepareDraft'
        ? !op.groupId || op.draftId || op.baseRevision
        : !op.draftId || !op.baseRevision || op.groupId
    )
      throw invalidAuthoring();
    const { operationId, purpose, groupId, draftId, baseRevision, targetPublicKey, nonceCommitment, createdAt } = op;
    const identity = {
      ...binding,
      operationId,
      purpose,
      groupId,
      draftId,
      baseRevision,
      targetPublicKey,
      nonceCommitment,
      createdAt,
    };
    const rows = this.all(),
      prior = rows.find((row) => row.operationId === operationId);
    if (
      prior &&
      Object.keys(identity).some(
        (key) => prior[key as keyof typeof identity] !== identity[key as keyof typeof identity],
      )
    )
      throw invalidAuthoring();
    if (prior && (!cancel || prior.cancelling)) return prior;
    const next = record.parse({ ...identity, cancelling: cancel });
    // An operation cannot be registered or resumed after the seven-day receipt retention horizon.
    const cutoff = Date.now() - 9 * 86400_000;
    this.write([...rows.filter((row) => row.operationId !== operationId && row.createdAt >= cutoff), next]);
    return next;
  }
  private write(rows: Row[]) {
    const content = JSON.stringify(file.parse({ version: 1, rows }));
    if (this.path) {
      const tmp = this.path + '.' + randomUUID() + '.tmp';
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        try {
          writeFileSync(fd, content);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(tmp, this.path);
        if (process.platform !== 'win32') {
          const parent = openSync(dirname(this.path), 'r');
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        }
      } catch (error) {
        this.rows = undefined;
        try {
          unlinkSync(tmp);
        } catch {}
        throw error;
      }
    }
    this.rows = rows;
  }
}
