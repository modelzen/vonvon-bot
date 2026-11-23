import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {afterEach, expect, it} from 'vitest';
import type {SourceHistoryEntry} from '@vonvon/protocol';
import {SourceHistory,type HistoryTarget} from '../src/recipe-source-history';

const dirs: string[] = [],histories:SourceHistory[]=[];
afterEach(() => {for(const history of histories.splice(0))history.close();for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
function open(path:string){const history=new SourceHistory(path);histories.push(history);return history;}
function localFixture(){
  const dir=mkdtempSync(join(tmpdir(),'source-local-history-'));dirs.push(dir);
  const path=join(dir,'source.sqlite'),history=open(path),operationId=randomUUID();
  const target:HistoryTarget={accountId:randomUUID(),deviceId:randomUUID(),deviceKey:Buffer.alloc(32,1).toString('base64url'),botId:'cli_source_history'};
  const entry:Extract<SourceHistoryEntry,{state:'published'}>={state:'published',operationId,draftId:randomUUID(),recipeId:randomUUID(),versionId:randomUUID(),name:'本地发布的配方',version:'1.2',revision:3};
  return {path,history,target,operationId,entry};
}

it('preserves every committed intent across restart, paginates in UUID order, and separates identities', () => {
  const dir = mkdtempSync(join(tmpdir(),'source-history-'));
  dirs.push(dir);
  const path = join(dir,'source.sqlite');
  const target = {accountId:'A',deviceId:'device',deviceKey:'original-key',botId:'bot'};
  const history = new SourceHistory(path);
  const ids = Array.from({length:36},(_,i) => '00000000-0000-7000-8000-'+String(i).padStart(12,'0'));
  for (const id of ids) history.remember(target,id,'original-binding');
  history.remember(target,ids[0]!,'original-binding');
  expect(() => history.remember(target,ids[0]!,'new-registration')).toThrow();
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  history.close();
  const reopened = new SourceHistory(path);
  const first = reopened.page(target,'original-binding');
  expect(first.ids).toHaveLength(32);
  expect(first.nextCursor).toBe(ids[4]);
  const second = reopened.page(target,'original-binding',first.nextCursor!);
  expect([...first.ids,...second.ids]).toEqual([...ids].reverse());
  expect(second.nextCursor).toBeNull();
  expect(reopened.page(target,'new-binding').ids).toEqual([]);
  for (const otherTarget of [{...target,accountId:'B'}, {...target,deviceKey:'new-key'}, {...target,botId:'other-bot'}]) {
    expect(reopened.page(otherTarget,'original-binding').ids).toEqual([]);
    expect(() => reopened.page(otherTarget,'original-binding',first.nextCursor!)).toThrow();
  }
  reopened.close();
});

it('permanently classifies pending and cancelled local intents without requiring a draft, receipt or history row',()=>{
  const f=localFixture(),cancelled=randomUUID();
  expect(f.history.isLocal(f.target,f.operationId)).toBe(false);
  for(const id of [f.operationId,cancelled]){f.history.markLocal(f.target,id);f.history.markLocal(f.target,id);}
  f.history.close();
  const restored=open(f.path);
  for(const id of [f.operationId,cancelled]){
    expect(restored.isLocal(f.target,id)).toBe(true);
    expect(restored.source(f.target,id)).toBeUndefined();
    expect(restored.publication(f.target,id)).toBeUndefined();
  }
  expect(restored.page(f.target,'a'.repeat(64))).toEqual({ids:[],nextCursor:null});
});

it('keeps legacy pagination and source locators while classifying local and legacy intents independently',()=>{
  const f=localFixture(),legacy=randomUUID(),identity='d'.repeat(64),groupId='oc_history';
  for(const id of [f.operationId,legacy])f.history.remember(f.target,id,identity,groupId);
  f.history.markLocal(f.target,f.operationId);f.history.close();
  const restored=open(f.path);
  expect(restored.isLocal(f.target,f.operationId)).toBe(true);expect(restored.isLocal(f.target,legacy)).toBe(false);
  expect(restored.page(f.target,identity).ids).toEqual([f.operationId,legacy].sort().reverse());
  expect(restored.locator(f.target.accountId,f.operationId)).toEqual({deviceId:f.target.deviceId,deviceKey:f.target.deviceKey,botId:f.target.botId,identity,groupId});
  expect(restored.operations(f.target).map(row=>row.operationId)).toEqual([f.operationId,legacy].sort().reverse());
});

it('keeps local markers and publication records isolated by account and fails closed on changed device, key or Bot',()=>{
  const f=localFixture();f.history.rememberPublication(f.target,f.entry);
  const other={...f.target,accountId:randomUUID()};
  expect(f.history.isLocal(other,f.operationId)).toBe(false);expect(f.history.publication(other,f.operationId)).toBeUndefined();
  const otherEntry={...f.entry,name:'另一个账号的独立发布'};f.history.rememberPublication(other,otherEntry);
  expect(f.history.publication(other,f.operationId)).toEqual(otherEntry);expect(f.history.publication(f.target,f.operationId)).toEqual(f.entry);
  for(const changed of [{...f.target,deviceId:randomUUID()},{...f.target,deviceKey:Buffer.alloc(32,9).toString('base64url')},{...f.target,botId:'cli_wrong_source'}]){
    expect(()=>f.history.isLocal(changed,f.operationId)).toThrow();expect(()=>f.history.markLocal(changed,f.operationId)).toThrow();
    expect(()=>f.history.publication(changed,f.operationId)).toThrow();expect(()=>f.history.rememberPublication(changed,f.entry)).toThrow();
  }
  expect(f.history.publication(f.target,f.operationId)).toEqual(f.entry);
});

it('rejects a changed target even for an unmarked legacy intent and never publishes partial local classification',()=>{
  const f=localFixture();f.history.remember(f.target,f.operationId,'d'.repeat(64));
  const wrong={...f.target,deviceId:randomUUID()};
  expect(()=>f.history.isLocal(wrong,f.operationId)).toThrow();expect(()=>f.history.markLocal(wrong,f.operationId)).toThrow();
  expect(()=>f.history.rememberPublication(wrong,f.entry)).toThrow();
  expect(f.history.isLocal(f.target,f.operationId)).toBe(false);expect(f.history.publication(f.target,f.operationId)).toBeUndefined();
});

it('persists the exact published version and marks it local without relying on a retained draft',()=>{
  const f=localFixture();f.history.rememberPublication(f.target,f.entry);f.history.rememberPublication(f.target,{...f.entry});
  expect(f.history.isLocal(f.target,f.operationId)).toBe(true);f.history.close();
  const restored=open(f.path);expect(restored.publication(f.target,f.operationId)).toEqual(f.entry);
  restored.rememberPublication(f.target,{...f.entry});expect(restored.publication(f.target,f.operationId)).toEqual(f.entry);
});

it('rolls back the local marker when the publication write fails and permits the exact retry',()=>{
  const f=localFixture();expect(f.history.isLocal(f.target,f.operationId)).toBe(false);f.history.close();
  const rejecting=new DatabaseSync(f.path);
  try{rejecting.exec("create trigger reject_publication before insert on source_publications begin select raise(abort,'test publication write failure'); end;");}
  finally{rejecting.close();}
  expect(()=>f.history.rememberPublication(f.target,f.entry)).toThrow();
  expect(f.history.isLocal(f.target,f.operationId)).toBe(false);expect(f.history.publication(f.target,f.operationId)).toBeUndefined();f.history.close();
  const repaired=new DatabaseSync(f.path);try{repaired.exec('drop trigger reject_publication');}finally{repaired.close();}
  f.history.rememberPublication(f.target,f.entry);expect(f.history.isLocal(f.target,f.operationId)).toBe(true);
  expect(f.history.publication(f.target,f.operationId)).toEqual(f.entry);
});

it.each(['name','versionId','revision'] as const)('refuses changed published %s under the same operation without replacing the first result',field=>{
  const f=localFixture();f.history.rememberPublication(f.target,f.entry);
  const changed={...f.entry};
  if(field==='name')changed.name='被替换的发布名称';if(field==='versionId')changed.versionId=randomUUID();if(field==='revision')changed.revision++;
  expect(()=>f.history.rememberPublication(f.target,changed)).toThrow();expect(f.history.publication(f.target,f.operationId)).toEqual(f.entry);
});

it.each(['hash','schema','operation'] as const)('refuses a corrupted published %s after restart instead of treating it as missing history',kind=>{
  const f=localFixture();f.history.rememberPublication(f.target,f.entry);f.history.close();
  const db=new DatabaseSync(f.path);
  try{
    let body:string;
    if(kind==='schema'){const {name:_name,...missing}=f.entry;body=JSON.stringify(missing);}
    else body=JSON.stringify({...f.entry,...(kind==='operation'?{operationId:randomUUID()}:{name:'篡改的正文'})});
    if(kind==='hash')db.prepare('update source_publications set body=? where account=? and operation=?').run(body,f.target.accountId,f.operationId);
    else db.prepare('update source_publications set body=?,body_sha256=? where account=? and operation=?').run(body,createHash('sha256').update(body).digest('hex'),f.target.accountId,f.operationId);
  }finally{db.close();}
  const restored=open(f.path);
  expect(()=>restored.publication(f.target,f.operationId)).toThrow();expect(()=>restored.rememberPublication(f.target,f.entry)).toThrow();
});

it('prevents later source-history writes from moving an already-local operation to another target',()=>{
  const f=localFixture();f.history.markLocal(f.target,f.operationId);
  expect(()=>f.history.remember({...f.target,deviceId:randomUUID()},f.operationId,'d'.repeat(64))).toThrow();
  expect(f.history.source(f.target,f.operationId)).toBeUndefined();expect(f.history.isLocal(f.target,f.operationId)).toBe(true);
});

it('keeps the shared SQLite file private when reopening an existing local history database',()=>{
  const f=localFixture();f.history.markLocal(f.target,f.operationId);f.history.close();chmodSync(f.path,0o644);
  expect(open(f.path).isLocal(f.target,f.operationId)).toBe(true);
  if(process.platform!=='win32')expect(statSync(f.path).mode&0o777).toBe(0o600);
});

it('persists an exact verified parent across restart without changing published history or local classifications',()=>{
  const f=localFixture(),parent={recipeId:f.entry.recipeId,versionId:f.entry.versionId};
  f.history.rememberPublication(f.target,f.entry);f.history.rememberParent(f.target,parent);f.history.close();
  const restored=open(f.path);
  expect(restored.parent(f.target,parent.versionId)).toEqual(parent);expect(restored.parent(f.target,randomUUID())).toBeUndefined();
  expect(restored.publication(f.target,f.operationId)).toEqual(f.entry);expect(restored.isLocal(f.target,f.operationId)).toBe(true);
  expect(restored.isLocal(f.target,randomUUID())).toBe(false);
});

it('isolates a verified parent by account, device, device key and Bot scope',()=>{
  const f=localFixture(),parent={recipeId:f.entry.recipeId,versionId:f.entry.versionId};f.history.rememberParent(f.target,parent);
  const others=[{...f.target,accountId:randomUUID()},{...f.target,deviceId:randomUUID()},
    {...f.target,deviceKey:Buffer.alloc(32,7).toString('base64url')},{...f.target,botId:'cli_other_parent'}];
  for(const other of others){
    expect(f.history.parent(other,parent.versionId)).toBeUndefined();f.history.rememberParent(other,parent);
    expect(f.history.parent(other,parent.versionId)).toEqual(parent);
  }
  expect(f.history.parent(f.target,parent.versionId)).toEqual(parent);
});

it('replays an identical verified parent and rejects replacing its recipe under the same version',()=>{
  const f=localFixture(),parent={recipeId:f.entry.recipeId,versionId:f.entry.versionId};f.history.rememberParent(f.target,parent);
  f.history.rememberParent(f.target,{versionId:parent.versionId,recipeId:parent.recipeId});
  expect(()=>f.history.rememberParent(f.target,{...parent,recipeId:randomUUID()})).toThrow();f.history.close();
  expect(open(f.path).parent(f.target,parent.versionId)).toEqual(parent);
});

it.each(['hash','schema','version'] as const)('rejects a corrupted verified parent %s without replacing it after restart',kind=>{
  const f=localFixture(),parent={recipeId:f.entry.recipeId,versionId:f.entry.versionId};f.history.rememberParent(f.target,parent);f.history.close();
  const db=new DatabaseSync(f.path);
  try{
    const body=JSON.stringify(kind==='schema'?{versionId:parent.versionId}:kind==='version'?{...parent,versionId:randomUUID()}:{...parent,recipeId:randomUUID()});
    if(kind==='hash')db.prepare('update verified_source_parents set body=? where account=? and version_id=?').run(body,f.target.accountId,parent.versionId);
    else db.prepare('update verified_source_parents set body=?,body_sha256=? where account=? and version_id=?').run(body,createHash('sha256').update(body).digest('hex'),f.target.accountId,parent.versionId);
  }finally{db.close();}
  const restored=open(f.path);
  expect(()=>restored.parent(f.target,parent.versionId)).toThrow();expect(()=>restored.rememberParent(f.target,parent)).toThrow();
});

it('rejects malformed verified parent identifiers before saving any mapping',()=>{
  const f=localFixture(),versionId=randomUUID();
  expect(()=>f.history.rememberParent(f.target,{recipeId:'not-a-recipe-id',versionId})).toThrow();
  expect(f.history.parent(f.target,versionId)).toBeUndefined();expect(()=>f.history.parent(f.target,'not-a-version-id')).toThrow();
});
