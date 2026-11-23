import { createHash } from 'node:crypto';
import { chmodSync, closeSync, openSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { agentIdSchema, groupIdSchema, recipeBinary32Schema, sourceHistoryEntrySchema, type SourceHistoryEntry } from '@vonvon/protocol';
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
const uuid = z.string().uuid();
const historyTargetSchema = z.object({accountId:uuid,deviceId:uuid,deviceKey:recipeBinary32Schema,botId:agentIdSchema});
const publishedEntrySchema = sourceHistoryEntrySchema.options[1];
const publishedRowSchema = z.object({account:uuid,operation:uuid,target:z.string().max(256),body:z.string().max(16384),body_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const historyParentSchema = z.object({recipeId:uuid,versionId:uuid}).strict();
const parentRowSchema = z.object({account:uuid,target:z.string().max(256),version_id:uuid,body:z.string().max(1024),body_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type PublishedEntry = Extract<SourceHistoryEntry,{state:'published'}>;
type HistoryParent = z.infer<typeof historyParentSchema>;
const sha = (value:string) => createHash('sha256').update(value).digest('hex');

function targetKey(target: HistoryTarget) {
  return JSON.stringify([target.deviceId, target.deviceKey, target.botId]);
}

export class SourceHistory {
  private connection?: DatabaseSync;
  constructor(private readonly path?: string) {}

  private db() {
    if (this.connection) return this.connection;
    if (this.path) {closeSync(openSync(this.path, 'a', 0o600));chmodSync(this.path,0o600);}
    const db = new DatabaseSync(this.path ?? ':memory:');
    try {
      db.exec(`
        pragma synchronous = EXTRA;
        pragma fullfsync = ON;
        pragma busy_timeout = 5000;
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
        create table if not exists local_source_intents (
          account text not null, operation text not null, target text not null,
          primary key (account, operation)
        ) without rowid;
        create table if not exists source_publications (
          account text not null, operation text not null, target text not null, body text not null, body_sha256 text not null,
          primary key (account, operation)
        ) without rowid;
        create table if not exists verified_source_parents (
          account text not null, target text not null, version_id text not null, body text not null, body_sha256 text not null,
          primary key (account, target, version_id)
        ) without rowid;
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

  private transaction<T>(run:()=>T):T {
    const db=this.db();db.exec('BEGIN IMMEDIATE');
    try{const result=run();db.exec('COMMIT');return result;}
    catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
  }

  private checkTargets(target:HistoryTarget,operation:string) {
    const db=this.db(),key=targetKey(target),source=this.find(target,operation);
    const local=db.prepare('select target from local_source_intents where account=? and operation=?').get(target.accountId,operation);
    const published=db.prepare('select target from source_publications where account=? and operation=?').get(target.accountId,operation);
    if([source,local,published].some(row=>row&&row.target!==key)||published&&!local)throw invalidAuthoring();
    return Boolean(local);
  }

  markLocal(raw:HistoryTarget,operationId:string):void {
    const target=historyTargetSchema.parse(raw),operation=uuid.parse(operationId);
    this.transaction(()=>{
      this.checkTargets(target,operation);
      this.db().prepare('insert into local_source_intents values (?,?,?) on conflict(account,operation) do nothing').run(target.accountId,operation,targetKey(target));
    });
  }

  isLocal(raw:HistoryTarget,operationId:string):boolean {
    const target=historyTargetSchema.parse(raw);return this.checkTargets(target,uuid.parse(operationId));
  }

  publication(raw:HistoryTarget,operationId:string):PublishedEntry|undefined {
    const target=historyTargetSchema.parse(raw),operation=uuid.parse(operationId);
    this.checkTargets(target,operation);
    const rawRow=this.db().prepare('select * from source_publications where account=? and operation=?').get(target.accountId,operation);
    if(!rawRow)return;
    const row=publishedRowSchema.parse(rawRow);
    if(row.account!==target.accountId||row.operation!==operation||row.target!==targetKey(target)||Buffer.byteLength(row.body)>16384||sha(row.body)!==row.body_sha256)throw invalidAuthoring();
    const entry=publishedEntrySchema.parse(JSON.parse(row.body));
    if(entry.operationId!==operation)throw invalidAuthoring();
    return entry;
  }

  rememberPublication(raw:HistoryTarget,value:PublishedEntry):void {
    const target=historyTargetSchema.parse(raw),entry=publishedEntrySchema.parse(value),operation=entry.operationId;
    this.transaction(()=>{
      const previous=this.publication(target,operation);
      if(previous&&!isDeepStrictEqual(previous,entry))throw invalidAuthoring();
      this.db().prepare('insert into local_source_intents values (?,?,?) on conflict(account,operation) do nothing').run(target.accountId,operation,targetKey(target));
      if(!previous){
        const body=JSON.stringify(entry);
        this.db().prepare('insert into source_publications values (?,?,?,?,?)').run(target.accountId,operation,targetKey(target),body,sha(body));
      }
    });
  }

  parent(raw:HistoryTarget,versionId:string):HistoryParent|undefined {
    const target=historyTargetSchema.parse(raw),version=uuid.parse(versionId),key=targetKey(target);
    const rawRow=this.db().prepare('select * from verified_source_parents where account=? and target=? and version_id=?').get(target.accountId,key,version);
    if(!rawRow)return;
    const row=parentRowSchema.parse(rawRow);
    if(row.account!==target.accountId||row.target!==key||row.version_id!==version||sha(row.body)!==row.body_sha256)throw invalidAuthoring();
    const parent=historyParentSchema.parse(JSON.parse(row.body));
    if(parent.versionId!==version)throw invalidAuthoring();
    return parent;
  }

  rememberParent(raw:HistoryTarget,value:HistoryParent):void {
    const target=historyTargetSchema.parse(raw),parent=historyParentSchema.parse(value);
    this.transaction(()=>{
      const previous=this.parent(target,parent.versionId);
      if(previous){if(!isDeepStrictEqual(previous,parent))throw invalidAuthoring();return;}
      const body=JSON.stringify(parent);
      this.db().prepare('insert into verified_source_parents values (?,?,?,?,?)').run(target.accountId,targetKey(target),parent.versionId,body,sha(body));
    });
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
    this.transaction(()=>{
      this.checkTargets(target,operation);
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
    });
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
