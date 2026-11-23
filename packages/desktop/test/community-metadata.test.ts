import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,newRichMetadataRequestId,type AccountStatus,type RecipeRichContent,
  type RichMetadataRequest} from '@vonvon/protocol';
import {communityRequest} from '../src/community-api';
import {MetadataJournal} from '../src/community-metadata-journal';
import type {NativeAccount} from '../src/account-session';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

function fixture(){
  const accountId=randomUUID(),draftId=randomUUID(),sourceIntentId=randomUUID(),objectId=randomUUID();
  const raw=JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')) as RecipeRichContent;
  delete raw.finalLogo;raw.memories=[];raw.parts=[];
  const doc=canonicalizeRichRecipeContent(raw),hash=sha(doc.canonicalUTF8);
  const request:RichMetadataRequest={type:'saveRichDraftMetadata',accountId,draftId,requestId:newRichMetadataRequestId(),
    revision:1,baseManifestSha256:hash,public:{name:'新名称',summary:'介绍',overview:'完整说明',version:'1',access:'coded'},logo:{kind:'keep'}};
  const manifest=(objectId:string,bytes:Uint8Array)=>({kind:'manifest',objectId,bytes:bytes.byteLength,sha256:sha(bytes),mediaType:'application/json'});
  let current:AccountStatus={kind:'signedIn',accountId,displayName:'Owner',provider:'github',persistence:'memory'};
  let receipt:{requestId:string;draftId:string;revision:number;manifestSha256:string}|undefined;
  let commitBody:string|undefined, staged:ReturnType<typeof manifest>|undefined;
  let readRevision:number|undefined, useOriginal=false, uploaded:Uint8Array|undefined, waitOnCommit:(()=>Promise<void>)|undefined;
  let loseResponse=false, expire=false,onCommit:(()=>void)|undefined;
  const calls:string[]=[],listeners=new Set<(s:AccountStatus)=>void>();
  const switchAccount=()=>{current={kind:'signedOut'};for(const l of listeners)l(current);};
  const account:NativeAccount={status:()=>current,onStatus:l=>{listeners.add(l);return ()=>{listeners.delete(l);};},
    login:async()=>current,logout:async()=>current,cancelLogin:async()=>current,dispose:async()=>{},
    async request(id,path,init,beforeSend){
      expect(id).toBe(accountId);beforeSend?.();calls.push(path);
      if(path.endsWith('/metadata')){
        const body=JSON.parse(String(init?.body)) as {baseCanonical?:string;close?:true};
        if(body.baseCanonical){
          if(commitBody)expect(init?.body).toBe(commitBody);
          commitBody=String(init?.body);
          receipt={requestId:request.requestId,draftId,revision:2,manifestSha256:staged!.sha256};
          onCommit?.();
          await waitOnCommit?.();
          if(loseResponse){loseResponse=false;throw new Error('connection reset after commit');}
        }
        if(expire)return Response.json({error:{code:'operation_expired'}},{status:410});
        return Response.json(receipt?{status:'committed',receipt}:{status:'pending'});
      }
      if(path.endsWith('/reserve'))return Response.json({});
      if(path.endsWith('/members/65')){uploaded=init!.body as Uint8Array;staged=manifest(randomUUID(),uploaded);return Response.json(staged);}
      if(staged && uploaded && path.endsWith('/objects/'+staged.objectId))return new Response(uploaded);
      if(path==='/v2/drafts/'+draftId && receipt && readRevision && !useOriginal)return Response.json({
        format:'rich-v2',draftId,recipeId:null,revision:readRevision,access:request.public.access,sourceIntentId,manifest:staged,
        logicalBytes:uploaded!.byteLength,retainedCandidateBytes:0,sourceManifest:null});
      if(path.endsWith('/objects/'+objectId))return new Response(doc.canonicalUTF8);
      if(path==='/v2/drafts/'+draftId)return receipt && !readRevision?Response.json({error:{code:'not_found'}},{status:404}):Response.json({
        format:'rich-v2',draftId,recipeId:null,revision:receipt?(readRevision??1):1,access:'direct',sourceIntentId,manifest:manifest(objectId,doc.canonicalUTF8),
        logicalBytes:doc.logicalBytes,retainedCandidateBytes:0,sourceManifest:null});
      throw new Error('unexpected route '+path);
    }};
  return {account,request,calls,lose:()=>{loseResponse=true;},expire:()=>{expire=true;},switchOnCommit:()=>{onCommit=switchAccount;},
    receipt:()=>receipt,fresh:(revision=2,original=false)=>{readRevision=revision;useOriginal=original;},waitCommit:(wait:()=>Promise<void>)=>{waitOnCommit=wait;},restore:()=>{current={kind:'signedIn',accountId,displayName:'Owner',provider:'github',persistence:'memory'};}};
}
it('restarts Main and replays the journaled commit before any draft or upload, preserving a receipt after reload fails',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'metadata-main-'));
  try{
    f.lose();
    expect(await communityRequest(f.account,f.request,new MetadataJournal(dir))).toEqual({status:'uncertain'});
    f.calls.length=0;
    expect(await communityRequest(f.account,{...f.request,public:{...f.request.public,name:'other'}},new MetadataJournal(dir)))
      .toEqual({status:'rejected',code:'conflict'});
    expect(f.calls).toEqual([]);
    expect(await communityRequest(f.account,f.request,new MetadataJournal(dir))).toEqual({status:'committed',receipt:f.receipt()});
    expect(f.calls).toEqual(['/v2/drafts/'+f.request.draftId+'/metadata','/v2/drafts/'+f.request.draftId]);
  }finally{rmSync(dir,{force:true,recursive:true});}
});
it('reconciles the previous save before a different renderer request and preserves the new input',async()=>{
  const f=fixture(),journal=new MetadataJournal();f.lose();
  expect(await communityRequest(f.account,f.request,journal)).toEqual({status:'uncertain'});
  f.calls.length=0;
  const different={...f.request,requestId:newRichMetadataRequestId(),public:{...f.request.public,name:'新输入'}};
  expect(await communityRequest(f.account,different,journal)).toEqual({status:'rejected',code:'conflict'});
  expect(f.calls.every(p=>!p.includes('/objects/'))).toBe(true);
});
it('keeps the original journal across logout with an unknown commit and sends nothing with the other identity',async()=>{
  const f=fixture(),journal=new MetadataJournal();
  f.lose();f.switchOnCommit();
  expect(await communityRequest(f.account,f.request,journal)).toEqual({status:'uncertain'});
  f.calls.length=0;
  expect(await communityRequest(f.account,f.request,journal)).toEqual({status:'uncertain'});expect(f.calls).toEqual([]);
  f.restore();
  expect(await communityRequest(f.account,f.request,journal)).toEqual({status:'committed',receipt:f.receipt()});
});
it('returns an expired intent and refuses malformed replacement bytes before starting a package',async()=>{
  const f=fixture(),journal=new MetadataJournal();f.expire();
  expect(await communityRequest(f.account,f.request,journal)).toEqual({status:'rejected',code:'operation_expired'});
  f.calls.length=0;
  expect(await communityRequest(f.account,{...f.request,logo:{kind:'replace',base64:'AB==' }},journal)).toEqual({status:'rejected',code:'invalid_input'});
  expect(f.calls).toEqual([]);
});

it('releases the draft journal when a recovery probe finds the ID belongs to another immutable binding',async()=>{
  const f=fixture(),journal=new MetadataJournal();
  const key=journal.key(f.request.accountId,f.request.draftId);
  journal.write(key,{request:f.request});
  let closed=false;
  f.account.request=async(_id,path,init)=>{
    expect(path).toBe('/v2/drafts/'+f.request.draftId+'/metadata');
    if(JSON.parse(String(init?.body)).close)closed=true;
    return Response.json({error:{code:'conflict'}},{status:409});
  };
  expect(await communityRequest(f.account,f.request,journal)).toEqual({status:'rejected',code:'conflict'});
  expect(closed).toBe(true);expect(journal.read(key)).toBeUndefined();
});

it('recovers a restarted renderer from only account and draft while preserving the old receipt when reads fail',async()=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'metadata-recover-'));
  try{
    f.lose();
    expect(await communityRequest(f.account,f.request,new MetadataJournal(dir))).toEqual({status:'uncertain'});
    f.calls.length=0;
    expect(await communityRequest(f.account,{type:'recoverRichDraftMetadata',accountId:f.request.accountId,draftId:f.request.draftId},new MetadataJournal(dir)))
      .toEqual({status:'committed',receipt:f.receipt()});
    expect(f.calls).toEqual(['/v2/drafts/'+f.request.draftId+'/metadata','/v2/drafts/'+f.request.draftId]);
  }finally{rmSync(dir,{force:true,recursive:true});}
});
it('waits for an in-flight save to clear then reads its current draft instead of returning a stale initial draft',async()=>{
  const f=fixture(),journal=new MetadataJournal();f.fresh();
  let release!:()=>void, entered!:()=>void;
  const waiting=new Promise<void>(done=>{entered=done;});
  f.waitCommit(async()=>{entered();await new Promise<void>(done=>{release=done;});});
  const saving=communityRequest(f.account,f.request,journal);await waiting;
  const recovering=communityRequest(f.account,{type:'recoverRichDraftMetadata',accountId:f.request.accountId,draftId:f.request.draftId},journal);
  release();expect((await saving).status).toBe('committed');
  expect(await recovering).toMatchObject({status:'current',draft:{revision:2,public:{name:f.request.public.name}}});
  expect(f.calls.filter(path=>path.endsWith('/metadata'))).toHaveLength(2);
});
it('reads a current rich draft without a pending save and refuses recovery under another account',async()=>{
  const f=fixture(),journal=new MetadataJournal();
  const command={type:'recoverRichDraftMetadata',accountId:f.request.accountId,draftId:f.request.draftId} as const;
  expect(await communityRequest(f.account,command,journal)).toMatchObject({status:'current',draft:{revision:1}});
  f.switchOnCommit();f.lose();expect((await communityRequest(f.account,f.request,journal)).status).toBe('uncertain');
  f.calls.length=0;expect(await communityRequest(f.account,command,journal)).toEqual({status:'uncertain'});expect(f.calls).toEqual([]);
  f.restore();expect(await communityRequest(f.account,command,journal)).toEqual({status:'committed',receipt:f.receipt()});
});
it('retains the exact recoverable receipt when clearing the local journal fails',async()=>{
  const f=fixture();f.fresh();
  class InterruptedClear extends MetadataJournal {
    fail=true;
    override clear(key:string){if(this.fail){this.fail=false;throw new Error('local clear interrupted');}super.clear(key);}
  }
  const journal=new InterruptedClear();
  expect(await communityRequest(f.account,f.request,journal)).toMatchObject({status:'committed',draft:{revision:2}});
  expect(journal.read(journal.key(f.request.accountId,f.request.draftId))).toBeDefined();f.calls.length=0;
  const command={type:'recoverRichDraftMetadata',accountId:f.request.accountId,draftId:f.request.draftId} as const;
  expect(await communityRequest(f.account,command,journal)).toMatchObject({status:'committed',draft:{revision:2}});
  expect(f.calls.some(path=>path.endsWith('/metadata'))).toBe(false);
  expect(journal.read(journal.key(f.request.accountId,f.request.draftId))).toBeUndefined();
});

it.each([2,3])('holds the committed floor across Main restarts until a verified r%i read',async(revision)=>{
  const f=fixture(),dir=mkdtempSync(join(tmpdir(),'metadata-floor-'));
  const command={type:'recoverRichDraftMetadata',accountId:f.request.accountId,draftId:f.request.draftId} as const;
  const restart=()=>new MetadataJournal(dir);
  const key=restart().key(command.accountId,command.draftId);
  try{
    expect(await communityRequest(f.account,f.request,restart())).toEqual({status:'committed',receipt:f.receipt()});
    const row=restart().read(key);
    expect(row).toMatchObject({request:f.request,receipt:f.receipt()});
    f.expire();f.calls.length=0;
    for(const staleRevision of [1,2]){
      f.fresh(staleRevision,true);
      expect(await communityRequest(f.account,command,restart())).toEqual({status:'committed',receipt:f.receipt()});
      expect(restart().read(key)).toEqual(row);
    }
    f.fresh(revision,revision>2);
    expect(await communityRequest(f.account,command,restart())).toMatchObject({status:'committed',receipt:f.receipt(),draft:{revision}});
    expect(f.calls.some(path=>path.endsWith('/metadata'))).toBe(false);
    expect(restart().read(key)).toBeUndefined();
  }finally{rmSync(dir,{force:true,recursive:true});}
});
