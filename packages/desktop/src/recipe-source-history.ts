import { closeSync, openSync } from 'node:fs';
import { agentIdSchema, groupIdSchema, recipeBinary32Schema } from '@vonvon/protocol';
import { z } from 'zod';
import { DatabaseSync } from 'node:sqlite';
import { invalidAuthoring } from './recipe-authoring-cloud.js';

export interface HistoryTarget {
  accountId: string;
  deviceId: string;
  deviceKey: string;
  botId: string;
}

const targetFields = z.tuple([z.string().uuid(), recipeBinary32Schema, agentIdSchema]);

function targetKey(target: HistoryTarget) {
  return JSON.stringify([target.deviceId, target.deviceKey, target.botId]);
}

export class SourceHistory {
  private connection?: DatabaseSync;
  constructor(private readonly path?: string) {}

  private db() {
    if (this.connection) return this.connection;
    if (this.path) closeSync(openSync(this.path, 'a', 0o600));
    const db = new DatabaseSync(this.path ?? ':memory:');
    try {
      db.exec(`
        pragma synchronous = EXTRA;
        pragma fullfsync = ON;
        pragma max_page_count = 8192;
        create table if not exists source_intents (
          account text not null, operation text not null, target text not null, source text not null,
          primary key (account, operation)
        ) without rowid;
        create table if not exists source_groups (
          account text not null, operation text not null, group_id text not null,
          primary key (account, operation)
        ) without rowid;
        create index if not exists source_history on source_intents (account, target, source, operation);
      `);
      this.connection = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() {
    this.connection?.close();
    this.connection = undefined;
  }

  private find(target: HistoryTarget, operation: string) {
    return this.db().prepare('select target, source from source_intents where account = ? and operation = ?')
      .get(target.accountId, operation);
  }

  source(target: HistoryTarget, operation: string) {
    const row = this.find(target, operation);
    if (!row) return undefined;
    if (row.target !== targetKey(target) || typeof row.source !== 'string') throw invalidAuthoring();
    return row.source;
  }

  locator(accountId: string, operation: string) {
    const row = this.db().prepare(`
      select target, source, group_id from source_intents left join source_groups using (account, operation)
      where account = ? and operation = ?
    `).get(accountId, operation);
    if (!row) return;
    if (typeof row.target !== 'string' || typeof row.source !== 'string') throw invalidAuthoring();
    const [deviceId, deviceKey, botId] = targetFields.parse(JSON.parse(row.target));
    return {deviceId, deviceKey, botId, identity: row.source,
      groupId: row.group_id === null ? undefined : groupIdSchema.parse(row.group_id)};
  }

  remember(target: HistoryTarget, operation: string, source: string, groupId?: string) {
    this.db().prepare('insert into source_intents values (?, ?, ?, ?) on conflict (account, operation) do nothing')
      .run(target.accountId, operation, targetKey(target), source);
    if (this.source(target, operation) !== source) throw invalidAuthoring();
    if (groupId === undefined) return;
    const db = this.db();
    db.prepare('insert into source_groups values (?, ?, ?) on conflict (account, operation) do nothing')
      .run(target.accountId, operation, groupId);
    const saved = db.prepare('select group_id from source_groups where account = ? and operation = ?')
      .get(target.accountId, operation);
    if (saved?.group_id !== groupId) throw invalidAuthoring();
  }

  operations(target:HistoryTarget){
    return this.db().prepare(`
      select operation, source, group_id from source_intents left join source_groups using(account, operation)
      where account = ? and target = ? order by operation desc limit 8192
    `).all(target.accountId,targetKey(target)).map(row=>({operationId:z.string().uuid().parse(row.operation),identity:z.string().regex(/^[a-f0-9]{64}$/).parse(row.source),
      groupId:row.group_id===null?undefined:groupIdSchema.parse(row.group_id)}));
  }

  page(target: HistoryTarget, source: string, before?: string) {
    if (before && this.source(target, before) !== source) throw invalidAuthoring();
    const rows = this.db().prepare(
      'select operation from source_intents where account = ? and target = ? and source = ? and operation < ? order by operation desc limit 33',
    ).all(target.accountId, targetKey(target), source, before ?? 'z');
    const ids = rows.slice(0,32).map(row => String(row.operation));
    return {ids, nextCursor: rows.length > 32 ? ids[31]! : null};
  }
}
