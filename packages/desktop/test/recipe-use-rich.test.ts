import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,agentIdSchema,groupIdSchema,type RecipeRichContent,type RecipeInstallRequest,type RecipeUseRequest} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import type {NativeAccount} from '../src/account-session';
import {RecipeUseController} from '../src/recipe-use';
import {RecipeJournal} from '../src/recipe-use-journal';
const folders:string[]=[];afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});
function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'rich-main-'));folders.push(folder);
  const accountId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID(),deviceId=randomUUID(),operationId=randomUUID(),objectId=randomUUID();
  const botId=agentIdSchema.parse('cli_rich'),groupId=groupIdSchema.parse('oc_rich'),binary=(n:number)=>Buffer.alloc(32,n).toString('base64url'),pk=binary(1),nonce=binary(2);
  const raw=JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')) as RecipeRichContent;
  raw.parts=[];raw.memories=[];delete raw.finalLogo;
  const doc=canonicalizeRichRecipeContent(raw),hash=createHash('sha256').update(doc.canonicalUTF8).digest('hex');
  const preview={accountId,release:{format:'rich-v2',recipeId,versionId,authorId:accountId,revision:1,access:'direct',logicalBytes:doc.logicalBytes,contentSha256:hash},manifest:{objectId,kind:'manifest',sha256:hash,bytes:doc.canonicalUTF8.length,mediaType:'application/json'}};
  const intent={format:'rich-v2',purpose:'installRichRecipe',generation:2,versionId,manifestSha256:hash,targetPublicKey:pk,nonceCommitment:nonce};
  const signal=new AbortController(),steps:string[]=[];
  const state={lost:false,issuer:'unissued',status:'prepared',account:true,seq:0};
  const account={lease:()=>state.account?signal.signal:undefined,request:async(_id:string,path:string,init?:RequestInit)=>{
    steps.push('cloud:'+path.split('/').pop());
    if(path.endsWith('/install-preview'))return Response.json(preview);
    if(path.includes('/objects/'))return new Response(doc.canonicalUTF8);
    if(path.endsWith('/authorize')){expect(state.issuer).toBe('issuing');expect(JSON.parse(String(init?.body))).toEqual(intent);if(state.lost){state.lost=false;throw new Error('lost authorization response');}return Response.json({...intent,accountId,operationId,deadline:Date.now()+300000,serverPublicKey:binary(3),ticket:binary(4),status:'authorized'});}
    throw new Error('unexpected cloud request');
  }} as unknown as NativeAccount;
  const status=()=>({kind:'richStatus',operationId,status:state.status,issuerState:state.issuer,settled:state.status==='applied'||state.status==='rejected'});
  const client={device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,publicKey:pk,name:'隔离设备'},remote:{port:1234,addresses:[]},clients:{total:1,active:1}}}),recipeInstall:async(req:RecipeInstallRequest)=>{
    steps.push('native:'+req.type);
    if(req.type==='richPrepare')return req.reviewToken?{kind:'richPrepared',operationId,intent,reviewToken:'a'.repeat(64)}:{kind:'richReview',groupId,reviewToken:'a'.repeat(64),conflicts:[]};
    if(req.type==='richIssuing')state.issuer='issuing';
    if(req.type==='richCommit'){expect('authorization' in req&&req.authorization?.versionId).toBe(versionId);state.status='applied';state.issuer='authorized';}
    if(req.type==='richCancel')state.status='rejected';
    return status();
  }} as unknown as VonvonClient;
  let main:RecipeUseController;
  const restart=()=>{main=new RecipeUseController(account,viewId=>{const seq=state.seq;return {client,viewId,pairedKey:pk,check(){if(seq!==state.seq)throw new Error('device changed');}};},new RecipeJournal(join(folder,'journal.json')));};restart();
  const begin=()=>main.request({type:'begin',format:'rich-v2',accountId,recipeId,versionId,viewId:deviceId,botId,groupId});
  return {state,steps,restart,begin,run:(r:RecipeUseRequest)=>main.request(r),journal:()=>JSON.parse(readFileSync(join(folder,'journal.json'),'utf8')) as {rows:{action:string;format:string}[]}};
}
it('requires full review, journals immutable rich intent and arms issuer before requesting authority',async()=>{
  const f=fixture(),first=await f.begin();expect(first.kind).toBe('richReview');if(first.kind!=='richReview')throw new Error();
  const next=await f.run({type:'richResolve',handle:first.handle,reviewToken:first.reviewToken,choices:{}});expect(next.kind).toBe('richPrepared');
  expect(f.journal().rows[0]?.format).toBe('rich-v2');
  const result=await f.run({type:'confirm',handle:first.handle});expect(result.kind).toBe('applied');
  expect(f.steps.indexOf('native:richIssuing')).toBeLessThan(f.steps.indexOf('cloud:authorize'));
  expect(JSON.stringify(result)).not.toContain('ticket');
});
it('recovers lost authorization with the same operation after Main restart without changing target',async()=>{
  const f=fixture(),first=await f.begin();if(first.kind!=='richReview')throw new Error();
  await f.run({type:'richResolve',handle:first.handle,reviewToken:first.reviewToken,choices:{}});f.state.lost=true;
  await expect(f.run({type:'confirm',handle:first.handle})).rejects.toThrow();expect(f.journal().rows[0]?.action).toBe('confirm');
  f.restart();const recovered=await f.begin();expect(recovered.kind).toBe('pending');if(!('handle'in recovered))throw new Error();
  expect((await f.run({type:'resume',handle:recovered.handle})).kind).toBe('applied');
});
it('refuses confirmation after account or device ownership changes',async()=>{
  const f=fixture(),first=await f.begin();if(first.kind!=='richReview')throw new Error();await f.run({type:'richResolve',handle:first.handle,reviewToken:first.reviewToken,choices:{}});
  f.state.account=false;await expect(f.run({type:'confirm',handle:first.handle})).rejects.toThrow();expect(f.steps).not.toContain('cloud:authorize');
});
