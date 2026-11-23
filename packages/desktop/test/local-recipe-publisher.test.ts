import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {createServer,type IncomingMessage} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {afterEach,expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,creatorSnapshotSchema,groupIdSchema,recipeRichContentSchema,type AccountStatus,type RecipeRichPartDescriptor,type RichFreezeInput} from '@vonvon/protocol';
import {LocalRecipePublisher,type LocalRecipePossessionRequest} from '../src/local-recipe-publisher';
import type {LocalRecipeDraftRecord} from '../src/local-recipe-drafts';
import type {NativeAccount} from '../src/account-session';
import {creatorAssociationSchema,creatorSha,creatorSnapshotDigest,type CreatorCommandRecord} from '../src/recipe-creator-journal';
import {freezeSnapshot,richWireBytes} from '../../../services/recipe-api/src/rich-document.mjs';
// @ts-expect-error Real server proof generation is intentionally exercised across HTTP.
import {richMaterial} from '../../../services/recipe-api/src/rich-proof.mjs';
// @ts-expect-error The real bounded service decoder normalizes publication logos.
import {normalizeLogo} from '../../../services/recipe-api/src/logo.mjs';

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function member(text:string){
  const bytes=Buffer.from(text),descriptor:RecipeRichPartDescriptor={kind:'text',objectId:randomUUID(),sha256:sha(bytes),bytes:bytes.length,mediaType:'text/plain;charset=utf-8'};
  return {descriptor,base64:bytes.toString('base64')};
}
function fixture(legacy=false){
  const accountId=randomUUID(),draftId=randomUUID(),preparationId=randomUUID();
  const association=creatorAssociationSchema.parse({accountId,viewId:'local',deviceId:randomUUID(),deviceKey:Buffer.alloc(32,1).toString('base64url'),
    botId:'cli_local_publisher',binding:randomUUID(),scope:'c'.repeat(64)});
  const content=recipeRichContentSchema.parse(JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')));
  delete content.finalLogo;content.memories=[];content.tasks=[];content.rules=[];content.setup=[];
  const selected=member('---\ndescription: 当前选中的说明\n---\nPRIVATE SELECTED SKILL'),second=member('Only the selected reference.'),unselected=member('UNSELECTED SOURCE NEVER UPLOADED');
  const file=(m:typeof selected,name:string)=>({itemId:randomUUID(),originId:randomUUID(),name,use:name==='SKILL.md'?'skillDescription' as const:'reference' as const,text:{kind:'part' as const,objectId:m.descriptor.objectId}});
  const entry=file(selected,'SKILL.md'),reference=file(second,'reference.txt');
  content.files=[entry,reference];content.skills=[{itemId:randomUUID(),originId:randomUUID(),name:'current-skill',entryFileId:entry.itemId,fileIds:[entry.itemId,reference.itemId]}];content.parts=[selected.descriptor,second.descriptor];
  const doc=canonicalizeRichRecipeContent(content),publicInfo={name:doc.content.public.name.value,summary:doc.content.public.summary.value,overview:doc.content.public.overview.value,version:'1.0',access:'coded' as const};
  let record:LocalRecipeDraftRecord={association,work:{draftId,source:{preparationId,groupId:groupIdSchema.parse('oc_local_publisher'),identity:'d'.repeat(64)}},
    draft:{format:'rich-v2',draftId,recipeId:null,revision:3,sourceIntentId:preparationId,public:publicInfo,rich:{content:doc.content,canonical:Buffer.from(doc.canonicalUTF8).toString('base64url'),
      texts:{[selected.descriptor.objectId]:Buffer.from(selected.base64,'base64').toString('utf8'),[second.descriptor.objectId]:Buffer.from(second.base64,'base64').toString('utf8')}}},
    origins:[...Object.values(content.public),content.role!,...content.skills,...content.files].map(item=>({itemId:item.itemId,source:{kind:'accountClaim'}})),
    selected:[entry.itemId],members:[selected,second,unselected]};
  const source=structuredClone(content);source.files=[{...entry,text:{kind:'part',objectId:unselected.descriptor.objectId}}];source.skills=[{...content.skills[0]!,fileIds:[entry.itemId]}];source.parts=[unselected.descriptor];
  record.sourceCanonical=Buffer.from(canonicalizeRichRecipeContent(source).canonicalUTF8).toString('base64url');
  if(legacy)record={association,work:{draftId,source:null},draft:{draftId,recipeId:null,revision:3,public:publicInfo,config:{role:'Only locally saved role.'}},members:[]};
  const snapshot=creatorSnapshotSchema.parse({work:record.work,format:legacy?'role-v1':'rich-v2',recipeId:null,parent:null,revision:3,public:record.draft.public,
    contentSha256:legacy?sha('{"role":"Only locally saved role."}'):sha(doc.canonicalUTF8),parts:legacy?[]:content.parts,sections:[{title:'完整内容',pageHashes:[sha('review')]}]});
  const requestId=randomUUID();
  const row:CreatorCommandRecord={association,id:requestId,command:{kind:'publish',snapshot,snapshotDigest:creatorSnapshotDigest(snapshot)},grant:{approval:'a'.repeat(64),expiresAt:Date.now()+300000,
    confirmation:{kind:'app',confirmationId:randomUUID()}},request:{type:'publishDraft',accountId,requestId,draftId,revision:3,...(!legacy&&{format:'rich-v2',canonical:record.draft.format==='rich-v2'?record.draft.rich.canonical:''})},phase:'frozen'};
  return {record,row,selected,unselected};
}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);}
async function harness(f=fixture()){
  const root=mkdtempSync(join(tmpdir(),'vv-local-publish-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
  const {row,record}=f,accountId=row.association.accountId,remoteDraftId=randomUUID(),recipeId=row.destination===null?remoteDraftId:row.destination?.recipeId??record.draft.recipeId??randomUUID(),versionId=randomUUID(),firstCodeId=randomUUID();
  type Capability={binding:Record<string,unknown>;hash:Buffer;ticket:Buffer};
  let operation:Record<string,unknown>|undefined,status='registered',frozen:ReturnType<typeof canonicalizeRichRecipeContent>|undefined,manifestId:string|undefined,published=false;
  const caps=new Map<string,Capability>(),uploads=new Map<number,{bytes:Buffer;descriptor:Record<string,unknown>}>();
  const calls:Array<{method:string;path:string;payload?:unknown;authorization?:string}>=[];
  let losePublish=false,loseAccept=false,revokeAt:string|undefined,corruptFreeze:string|undefined,deniedSource=false,receiptStatus:number|undefined;
  let revoked=false;const lease=new AbortController();
  let state:AccountStatus={kind:'signedIn',accountId,displayName:'作者',provider:'google',persistence:'memory'};
  const server=createServer(async(req,res)=>{
    try{
      const path=req.url!,bytes=await body(req),payload=bytes.length&&req.headers['content-type']==='application/json'?JSON.parse(bytes.toString()):undefined;
      calls.push({method:req.method!,path,payload,authorization:req.headers.authorization});
      const send=(value:unknown,code=200)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(value));};
      if(revokeAt&&path.includes(revokeAt))revoked=true;
      if(path.includes('/receipts/publications/')){
        if(published&&receiptStatus)return send({error:{code:receiptStatus===401?'unauthorized':'forbidden'}},receiptStatus);
        if(!published)return send({status:'unknown'});
        const q=new URL(path,'http://local').searchParams;
        return send({status:'committed',receipt:{requestId:row.id,format:record.draft.format??'role-v1',draftId:q.get('draftId'),draftRevision:1,
          recipeId,versionId,revision:1,public:record.draft.public,firstCodeId}});
      }
      if(path==='/v1/drafts'){
        if(!payload||'canonical'in payload)throw Error('legacy save');
        return send({draftId:req.headers['idempotency-key'],recipeId:null,revision:1,public:payload.public,config:payload.config});
      }
      if(path.endsWith('/publish')){
        expect(req.headers['idempotency-key']).toBe(row.id);expect(req.headers['if-match']).toBe('"1"');
        if(record.draft.format==='rich-v2')expect(payload.canonical).toBe(Buffer.from(frozen!.canonicalUTF8).toString('base64url'));
        published=true;if(losePublish){losePublish=false;return send({error:{code:'simulated_reply_loss'}},503);}
        return send({recipeId,versionId,revision:1,public:record.draft.public});
      }
      if(path.endsWith('/source-items')){
        if(deniedSource)return send({error:{code:'source_unavailable'}},403);
        const versionId=path.split('/')[3];
        return send({versionId,authorId:accountId,access:'coded',items:(record.origins??[]).flatMap(origin=>origin.source.kind==='releaseItem'?[{itemId:origin.source.itemId,kind:'file',baselineSha256:origin.source.baselineSha256}]:[])});
      }
      if(path.endsWith('/recovery')){
        if(!operation)return send({error:{code:'not_found'}},404);
        if(status==='accepted')return send({format:'rich-v2',operationId:operation.operationId,status:'accepted',stateRevision:3,draftId:remoteDraftId,revision:1,manifestId,packageId:operation.operationId});
        return send({...operation,status,stateRevision:status==='dispatched'?2:1,operationDeadline:Date.now()+3600000});
      }
      if(path.endsWith('/register')){
        operation={...payload,operationId:path.split('/')[3],accountId};
        return send({...operation,destinationDraftId:remoteDraftId});
      }
      if(path.endsWith('/authorize')){
        const binding={...operation,status:payload.stage==='dispatch'?'registered':'dispatched',stage:payload.stage,stateRevision:payload.stateRevision,
          operationDeadline:Date.now()+3600000,payloadDigest:payload.payloadDigest,...(payload.stage==='accept'&&{sourceReviewSha256:sha(richWireBytes(lastFreezeRequest))})};
        const material=richMaterial({...binding,deadline:Date.now()+300000});
        const complete={...binding,serverPublicKey:material.key.toString('base64url'),ticket:material.ticket.toString('base64url'),deadline:Date.now()+299000};
        // richMaterial binds the exact deadline too.
        const exact=richMaterial(complete);complete.serverPublicKey=exact.key.toString('base64url');complete.ticket=exact.ticket.toString('base64url');
        caps.set(payload.stage,{binding:complete,hash:exact.hash,ticket:exact.ticket});return send(complete);
      }
      if(path.endsWith('/dispatch')||path.endsWith('/accept')){
        expect(req.headers.authorization).toBeUndefined();
        const stage=path.endsWith('/dispatch')?'dispatch':'accept',cap=caps.get(stage)!;
        expect(sha(Buffer.from(payload.proof,'base64url'))).toBe(cap.hash.toString('hex'));
        expect(payload.ticket).toBe(cap.ticket.toString('base64url'));expect(createHash('sha256').update(Buffer.from(payload.nonce,'base64url')).digest('base64url')).toBe(operation!.nonceCommitment);
        if(stage==='dispatch'){status='dispatched';return send({format:'rich-v2',operationId:operation!.operationId,status,stateRevision:2});}
        status='accepted';manifestId=payload.manifestId;
        if(loseAccept){loseAccept=false;return send({error:{code:'simulated_reply_loss'}},503);}
        return send({format:'rich-v2',operationId:operation!.operationId,status,stateRevision:3,draftId:remoteDraftId,revision:1,manifestId,packageId:operation!.operationId});
      }
      if(path.endsWith('/reserve'))return send({});
      if(path.includes('/members/')){
        const ordinal=Number(path.split('/').at(-1)),kind=req.headers['x-recipe-kind'];
        expect(bytes.length).toBe(Number(req.headers['content-length']));expect(sha(bytes)).toBe(req.headers['x-recipe-sha256']);
        let existing=uploads.get(ordinal);
        if(!existing){
          const normalized=kind==='finalLogo'?Buffer.from(await normalizeLogo(bytes)):bytes;
          const descriptor={objectId:randomUUID(),kind,sha256:sha(normalized),bytes:normalized.length,...(kind==='text'?{mediaType:'text/plain;charset=utf-8'}:kind==='finalLogo'?{mediaType:'image/webp'}:{mediaType:'application/json'})};
          existing={bytes,descriptor};uploads.set(ordinal,existing);
        }else expect(existing.bytes.equals(bytes)).toBe(true);
        return send(existing.descriptor);
      }
      if(path.endsWith('/freeze')){
        lastFreezeRequest=payload;
        if(payload.logoUpload){expect(payload.logoUpload.packageId).toBe(operation!.operationId);expect(payload.logoUpload.inputSha256).toBe(reqLogoHash());}
        const prior=new Map();
        if(record.draft.format==='rich-v2'&&record.parent?.versionId===payload.sourceVersionId){
          for(const file of record.draft.rich.content.files){
            const edge=record.origins?.find(origin=>origin.itemId===file.itemId)?.source;
            if(edge?.kind==='releaseItem')prior.set(edge.itemId,{kind:'file',itemId:edge.itemId,originId:file.originId,baselineSha256:edge.baselineSha256});
          }
        }
        const result=freezeSnapshot(payload,Buffer.alloc(32,8),prior);
        if(corruptFreeze==='name')result.content.skills[0].name='different skill';
        if(corruptFreeze==='entry')result.content.skills[0].entryFileId=result.content.skills[0].fileIds[1];
        if(corruptFreeze==='order')result.content.skills[0].fileIds.reverse();
        if(corruptFreeze==='role'&&result.content.role)result.content.role.text={kind:'inline',value:'unapproved body'};
        frozen=canonicalizeRichRecipeContent(result.content);
        const wire=richWireBytes({format:'rich-v2',purpose:'prepareDraft',sourceIntentId:operation!.operationId,content:frozen.content});
        return send({format:'rich-v2',destinationDraftId:remoteDraftId,canonical:Buffer.from(frozen.canonicalUTF8).toString('base64url'),contentSha256:sha(frozen.canonicalUTF8),
          logicalBytes:frozen.logicalBytes,payload:wire.toString('base64url'),payloadDigest:sha(wire),sourceReviewSha256:sha(richWireBytes(payload))});
      }
      throw Error('unexpected route '+path);
    }catch(error){res.writeHead(500);res.end(JSON.stringify({error:{code:String(error)}}));}
  });
  const reqLogoHash=()=>{const logo=record.members.find(m=>m.descriptor.kind==='finalLogo');return logo?.descriptor.sha256;};
  let lastFreezeRequest:RichFreezeInput|undefined;
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  cleanup.push(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address();if(!address||typeof address==='string')throw Error('address');const origin='http://127.0.0.1:'+address.port;
  const check=async()=>{await Promise.resolve();if(revoked)throw Error('revoked');};
  const native:NativeAccount={lease:()=>lease.signal,status:()=>state,onStatus:()=>()=>{},login:async()=>state,cancelLogin:async()=>state,logout:async()=>state,dispose:async()=>{},
    recipeLink:(r,v)=>`https://vonvon.cc/recipes/${r}/versions/${v}`,request:async(id,path,init={},beforeSend)=>{
      await beforeSend?.();await check();if(id!==accountId)throw Error('wrong account');return fetch(origin+path,{...init,headers:{...Object.fromEntries(new Headers(init.headers)),authorization:'Bearer account'},redirect:'error'});
    }};
  const possession:LocalRecipePossessionRequest=async(id,path,init,beforeSend)=>{await beforeSend();await check();if(id!==accountId)throw Error('wrong account');return fetch(origin+path,init);};
  const publisher=new LocalRecipePublisher(root,possession);cleanup.push(()=>publisher.close());
  return {...f,publisher,root,account:native,possession,calls,uploads,remoteDraftId,recipeId,versionId,firstCodeId,check,
    frozen:()=>frozen,lastRequest:()=>lastFreezeRequest,losePublish:()=>{losePublish=true;},loseAccept:()=>{loseAccept=true;},revokeAt:(s:string)=>{revokeAt=s;},
    receiptStatus:(status:number|undefined)=>{receiptStatus=status;},corrupt:(s:string)=>{corruptFreeze=s;},denySource:()=>{deniedSource=true;},revoke:()=>{revoked=true;},logout:()=>{lease.abort();state={kind:'signedOut'};}};
}

it('performs zero requests before explicit publish, then sends only current members with strict frozen verification',async()=>{
  const h=await harness();expect(h.publisher.has(h.row.association.accountId,h.row.id)).toBe(false);
  expect(await h.publisher.receipt(h.account,h.row,h.check)).toBeUndefined();expect(h.calls).toEqual([]);
  const result=await h.publisher.publish(h.account,h.row,h.record,h.check);
  expect(result).toMatchObject({kind:'published',draftId:h.record.draft.draftId,draftRevision:3,target:{recipeId:h.recipeId,versionId:h.versionId}});
  expect(h.calls.map(c=>c.path.split('/').at(-1)?.split('?')[0])).toEqual(['recovery','register','authorize','dispatch','reserve','0','1','freeze','65','authorize','accept','publish',h.row.id]);
  expect([...h.uploads.values()].some(u=>u.bytes.includes('UNSELECTED SOURCE'))).toBe(false);
  expect(h.lastRequest()).not.toHaveProperty('sourceCanonical');expect(h.lastRequest()).not.toHaveProperty('candidates');
  const writes=h.calls.filter(c=>c.method!=='GET').length;
  expect(await h.publisher.publish(h.account,h.row,h.record,h.check)).toEqual(result);
  expect(h.calls.filter(c=>c.method!=='GET')).toHaveLength(writes);
  expect(statSync(join(h.root,'publications.sqlite')).mode&0o777).toBe(0o600);
});

it.each(['name','entry','order','role'])('rejects changed %s in a server snapshot before any accept or publish',async change=>{
  const h=await harness();h.corrupt(change);
  await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  expect(h.calls.some(c=>c.path.endsWith('/accept')||c.path.endsWith('/publish'))).toBe(false);
});

it('recovers a lost publication reply from the durable exact receipt without uploading or publishing again',async()=>{
  const h=await harness();h.losePublish();
  await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  const before=h.calls.length;h.publisher.close();const reopened=new LocalRecipePublisher(h.root,h.possession);cleanup.push(()=>reopened.close());
  const result=await reopened.receipt(h.account,h.row,h.check);
  expect(result).toMatchObject({kind:'published',draftId:h.record.draft.draftId,draftRevision:3});
  expect(h.calls.slice(before).every(c=>c.method==='GET'&&c.path.includes('/receipts/publications/'))).toBe(true);
  expect(await reopened.publish(h.account,h.row,h.record,h.check)).toEqual(result);
  expect(h.calls.filter(c=>c.path.endsWith('/publish'))).toHaveLength(1);
  expect(new Set(h.calls.filter(c=>c.path.endsWith('/register')).map(c=>c.path))).toHaveLength(1);
});

it.each([401,403])('keeps a successful publication unresolved after receipt HTTP %s and recovers read-only after approval expiry',async status=>{
  const h=await harness();h.receiptStatus(status);
  await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow('回执');
  expect(h.calls.filter(call=>call.path.endsWith('/publish'))).toHaveLength(1);
  const before=h.calls.length;h.receiptStatus(undefined);
  const expired={...h.row,grant:{...h.row.grant,expiresAt:Date.now()-1}};
  expect(await h.publisher.receipt(h.account,expired,h.check)).toMatchObject({kind:'published',draftId:h.record.draft.draftId,draftRevision:3});
  expect(h.calls.slice(before).every(call=>call.method==='GET'&&call.path.includes('/receipts/publications/'))).toBe(true);
  await expect(h.publisher.publish(h.account,expired,h.record,h.check)).rejects.toThrow();
  expect(h.calls.filter(call=>call.path.endsWith('/publish'))).toHaveLength(1);
});

it('recovers a lost accept reply with the original operation and frozen canonical',async()=>{
  const h=await harness();h.loseAccept();await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  const before=h.calls.length,result=await h.publisher.publish(h.account,h.row,h.record,h.check);
  expect(result?.kind).toBe('published');expect(h.calls.filter(c=>c.path.endsWith('/accept'))).toHaveLength(1);
  expect(h.calls.slice(before).some(c=>c.path.includes('/members/')||c.path.endsWith('/freeze')||c.path.endsWith('/register'))).toBe(false);
});

it('resumes the same publication after a fresh explicit confirmation without registering or uploading again',async()=>{
  const h=await harness();h.loseAccept();
  await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  const before=h.calls.length,row={...h.row,grant:{approval:'b'.repeat(64),expiresAt:Date.now()+300000,
    confirmation:{kind:'feishu-card' as const}}};
  const result=await h.publisher.publish(h.account,row,h.record,h.check);
  expect(result?.kind).toBe('published');
  expect(h.calls.filter(c=>c.path.endsWith('/register'))).toHaveLength(1);
  expect(h.calls.filter(c=>c.path.endsWith('/accept'))).toHaveLength(1);
  expect(h.calls.slice(before).some(c=>c.path.includes('/members/')||c.path.endsWith('/freeze')||c.path.endsWith('/register'))).toBe(false);
});

it('rejects changed summary, origin evidence, bytes and account before sending any request',async()=>{
  for(const change of ['summary','origin','bytes','account']){
    const h=await harness(),record=structuredClone(h.record);
    if(change==='summary')record.draft.public.summary='changed';
    if(change==='origin')record.origins=[];
    if(change==='bytes')record.members[0]!.base64=Buffer.from('changed').toString('base64');
    if(change==='account')record.association.accountId=randomUUID();
    await expect(h.publisher.publish(h.account,h.row,record,h.check)).rejects.toThrow();expect(h.calls).toEqual([]);
  }
});

it('checks source release permissions before uploading and refuses changed evidence on same-request retry',async()=>{
  const f=fixture();
  if(f.record.draft.format!=='rich-v2'||!f.record.origins)throw Error('fixture');
  const fileId=f.record.draft.rich.content.files[0]!.itemId,entry=f.record.origins.find(o=>o.itemId===fileId)!;
  entry.source={kind:'releaseItem',versionId:randomUUID(),itemId:randomUUID(),baselineSha256:'b'.repeat(64)};
  const h=await harness(f);h.denySource();await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  expect(h.calls.some(c=>c.path.includes('/members/'))).toBe(false);
  const changed=structuredClone(h.record);changed.origins![0]!.source={kind:'accountClaim'};
  changed.selected=[randomUUID()];const before=h.calls.length;
  await expect(h.publisher.publish(h.account,h.row,changed,h.check)).rejects.toThrow();expect(h.calls).toHaveLength(before);
});

it.each(['/register','/authorize','/members/','/freeze'])('awaits revocation after %s and emits no late follow-up write',async step=>{
  const h=await harness();h.revokeAt(step);
  await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow('revoked');
  const before=h.calls.length;await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow('revoked');expect(h.calls).toHaveLength(before);
  expect(h.calls.some(c=>c.path.endsWith('/publish'))).toBe(false);
});

it('keeps receipt lookup read-only after approval expiry and refuses any resumed upload',async()=>{
  const h=await harness();h.losePublish();await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  const now=Date.now(),original=Date.now;Date.now=()=>now+400000;
  try{
    const before=h.calls.length;expect((await h.publisher.receipt(h.account,h.row,h.check))?.kind).toBe('published');
    await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
    expect(h.calls.slice(before).every(c=>c.method==='GET')).toBe(true);
  }finally{Date.now=original;}
});

it('refuses a stale publication after the same account gets a new lease during permission checking',async()=>{
  const h=await harness(),original=h.account.lease!(h.row.association.accountId)!;
  let active=original;
  const account={...h.account,lease:()=>active};
  await expect(h.publisher.publish(account,h.row,h.record,async()=>{
    await Promise.resolve();active=new AbortController().signal;
  })).rejects.toThrow();
  expect(original.aborted).toBe(false);
  expect(h.calls).toEqual([]);
  expect(h.publisher.has(h.row.association.accountId,h.row.id)).toBe(false);
});

it('stages legacy role bytes only after confirmation and maps the remote revision back to the local draft',async()=>{
  const h=await harness(fixture(true));expect(await h.publisher.receipt(h.account,h.row,h.check)).toBeUndefined();expect(h.calls).toEqual([]);
  const result=await h.publisher.publish(h.account,h.row,h.record,h.check);
  expect(result).toMatchObject({kind:'published',draftId:h.record.draft.draftId,draftRevision:3});
  const save=h.calls.find(c=>c.path==='/v1/drafts');expect(save?.payload).toMatchObject({config:{role:'Only locally saved role.'}});
  expect(h.calls.filter(c=>c.path.endsWith('/publish'))).toHaveLength(1);
});

it('requires a proof transport and a current explicit confirmation before creating any rich job',async()=>{
  const h=await harness(),bare=new LocalRecipePublisher();cleanup.push(()=>bare.close());
  await expect(bare.publish(h.account,h.row,h.record,h.check)).rejects.toThrow('证明通道');expect(bare.has(h.row.association.accountId,h.row.id)).toBe(false);
  const row={...h.row,grant:{...h.row.grant,confirmation:undefined}};
  await expect(h.publisher.publish(h.account,row,h.record,h.check)).rejects.toThrow();expect(h.calls).toEqual([]);
});

it('binds the local normalized logo input to the server normalized descriptor without uploading source-only members',async()=>{
  const sharp=createRequire(new URL('../../../services/recipe-api/package.json',import.meta.url))('sharp');
  const bytes:Buffer=await sharp({create:{width:192,height:192,channels:4,background:'red'}}).webp({quality:70}).toBuffer();
  const f=fixture(),draft=f.record.draft;if(draft.format!=='rich-v2'||f.row.command.kind!=='publish'||f.row.request.type!=='publishDraft')throw Error('fixture');
  const descriptor:RecipeRichPartDescriptor={objectId:randomUUID(),kind:'finalLogo',sha256:sha(bytes),bytes:bytes.length,mediaType:'image/webp'};
  const logo={itemId:randomUUID(),originId:randomUUID(),objectId:descriptor.objectId};
  draft.rich.content.finalLogo=logo;draft.rich.content.parts.push(descriptor);f.record.origins!.push({itemId:logo.itemId,source:{kind:'accountClaim'}});
  f.record.members.push({descriptor,base64:bytes.toString('base64')});draft.logo='data:image/webp;base64,'+bytes.toString('base64');
  draft.rich.canonical=Buffer.from(canonicalizeRichRecipeContent(draft.rich.content).canonicalUTF8).toString('base64url');
  f.row.command.snapshot.parts=draft.rich.content.parts;f.row.command.snapshot.contentSha256=sha(Buffer.from(draft.rich.canonical,'base64url'));
  f.row.command.snapshotDigest=creatorSnapshotDigest(f.row.command.snapshot);f.row.request.canonical=draft.rich.canonical;
  const h=await harness(f);expect((await h.publisher.publish(h.account,h.row,h.record,h.check))?.kind).toBe('published');
  const request=h.lastRequest();if(!request||!('content'in request))throw Error('request');
  expect(request.logoUpload).toEqual({packageId:h.calls.find(c=>c.path.endsWith('/register'))!.path.split('/')[3],inputSha256:descriptor.sha256});
  expect(request.content.finalLogo?.objectId).not.toBe(descriptor.objectId);
  expect(h.uploads.get(64)?.descriptor.sha256).not.toBe(descriptor.sha256);
  expect(statSync(join(h.root,'publications.sqlite')).mode&0o777).toBe(0o600);
});

it('does not let another account reuse a durable publication map or send with the old lease',async()=>{
  const h=await harness();h.losePublish();await expect(h.publisher.publish(h.account,h.row,h.record,h.check)).rejects.toThrow();
  expect(h.publisher.has(randomUUID(),h.row.id)).toBe(false);
  const before=h.calls.length,other:NativeAccount={...h.account,status:()=>({kind:'signedIn',accountId:randomUUID(),displayName:'other',provider:'google',persistence:'memory'})};
  await expect(h.publisher.receipt(other,h.row,h.check)).rejects.toThrow();
  await expect(h.publisher.publish(other,h.row,h.record,h.check)).rejects.toThrow();
  h.logout();await expect(h.publisher.publish(h.account,h.row,h.record,()=>{})).rejects.toThrow();expect(h.calls).toHaveLength(before);
});

it.each(['same parent','different version','different recipe','new recipe'] as const)('preserves file identity only for the exact current parent when selecting %s',async choice=>{
  const f=fixture();
  if(f.record.draft.format!=='rich-v2'||f.row.command.kind!=='publish')throw Error('fixture');
  const parent={recipeId:randomUUID(),versionId:randomUUID()};
  const file=f.record.draft.rich.content.files[0]!;
  f.record.origins!.find(edge=>edge.itemId===file.itemId)!.source={kind:'releaseItem',versionId:parent.versionId,itemId:file.itemId,baselineSha256:sha('published file')};
  f.record.parent=parent;f.record.draft.recipeId=parent.recipeId;
  f.row.command.snapshot.parent=parent;f.row.command.snapshot.recipeId=parent.recipeId;
  f.row.command.snapshotDigest=creatorSnapshotDigest(f.row.command.snapshot);
  f.row.destination=choice==='same parent'?parent:choice==='different version'?{...parent,versionId:randomUUID()}:choice==='different recipe'?{recipeId:randomUUID(),versionId:randomUUID()}:null;
  const h=await harness(f);await h.publisher.publish(h.account,h.row,h.record,h.check);
  const request=h.lastRequest();if(!request||!('content'in request))throw Error('freeze');
  expect(request.sourceVersionId).toBe(choice==='same parent'?parent.versionId:undefined);
  const uploaded=h.uploads.get(65)!;
  const publishedFile=recipeRichContentSchema.parse(JSON.parse(uploaded.bytes.toString())).files[0]!;
  expect(publishedFile.itemId===file.itemId).toBe(choice==='same parent');
  expect(publishedFile.originId===file.originId).toBe(choice==='same parent');
});
