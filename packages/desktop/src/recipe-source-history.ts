import { closeSync, openSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { invalidAuthoring } from './recipe-authoring-cloud.js';

export interface HistoryTarget {
  accountId: string;
  deviceId: string;
  deviceKey: string;
  botId: string;
}

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

  remember(target: HistoryTarget, operation: string, source: string) {
    this.db().prepare('insert into source_intents values (?, ?, ?, ?) on conflict (account, operation) do nothing')
      .run(target.accountId, operation, targetKey(target), source);
    if (this.source(target, operation) !== source) throw invalidAuthoring();
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
