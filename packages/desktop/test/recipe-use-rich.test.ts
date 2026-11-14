import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,expect,it} from 'vitest';
import {canonicalizeRichRecipeContent,agentIdSchema,groupIdSchema,type RecipeRichContent,type RecipeInstallRequest,type RecipeUseRequest,type DesktopRecipeSourceRequest} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import type {NativeAccount} from '../src/account-session';
import {RecipeUseController} from '../src/recipe-use';
import {RecipeJournal} from '../src/recipe-use-journal';
type SourceInput<T=DesktopRecipeSourceRequest>=T extends DesktopRecipeSourceRequest?Omit<T,'viewId'|'botId'|'groupId'>:never;
const folders:string[]=[];afterEach(()=>{for(const folder of folders.splice(0))rmSync(folder,{recursive:true,force:true});});
function fixture(){
  const folder=mkdtempSync(join(tmpdir(),'rich-main-'));folders.push(folder);
  const accountId=randomUUID(),recipeId=randomUUID(),versionId=randomUUID(),deviceId=randomUUID(),operationId=randomUUID(),objectId=randomUUID();
  const botId=agentIdSchema.parse('cli_rich'),groupId=groupIdSchema.parse('oc_rich'),binary=(n:number)=>Buffer.alloc(32,n).toString('base64url'),pk=binary(1),nonce=binary(2);
  const raw=JSON.parse(readFileSync(new URL('../../protocol/test/fixtures/recipe-rich-v2.content.json',import.meta.url),'utf8')) as RecipeRichContent;
  raw.parts=[];raw.memories=[];delete raw.finalLogo;
  const doc=canonicalizeRichRecipeContent(raw),hash=createHash('sha256').update(doc.canonicalUTF8).digest('hex');
  const preview={accountId,release:{format:'rich-v2',recipeId,versionId,authorId:accountId,revision:1,access:'direct',logicalBytes:doc.logicalBytes,contentSha256:hash},manifest:{objectId,kind:'manifest',sha256:hash,bytes:doc.canonicalUTF8.length,mediaType:'application/json'}};
  let intent:Record<string,unknown>={format:'rich-v2',purpose:'installRichRecipe',generation:2,versionId,manifestSha256:hash,targetPublicKey:pk,nonceCommitment:nonce};
  const signal=new AbortController(),steps:string[]=[];
  const state={lastAuthority:'',previewDenied:false,denyAuthority:false,changeDuringPreview:false,coded:false,sourcePresent:true,changeDuringSetup:false,lost:false,issuer:'unissued',status:'prepared',account:true,seq:0};
  const account={lease:()=>state.account?signal.signal:undefined,request:async(_id:string,path:string,init?:RequestInit)=>{
    steps.push('cloud:'+path.split('/').pop());
    if(path.endsWith('/install-preview')){if(state.changeDuringPreview)state.account=false;if(state.previewDenied)return Response.json({error:{code:'forbidden'}},{status:403});return Response.json({...preview,release:{...preview.release,access:state.coded?'coded':'direct'}});}
    if(path.includes('/recipes/'))return Response.json({format:'rich-v2',recipeId,versionId,revision:1,public:{name:doc.content.public.name.value,summary:doc.content.public.summary.value,overview:doc.content.public.overview.value,version:doc.content.public.version.value,access:state.coded?'coded':'direct'},state:'listed',visibility:state.coded?'intro':'full',owned:false,acquired:false,creator:{authorId:accountId,displayName:'公开作者'},hasDisplayLogo:false,...(state.coded?{}:{release:preview.release,manifest:preview.manifest})});
    if(path.includes('/objects/'))return new Response(doc.canonicalUTF8);
    if(path.endsWith('/authorize')){if(state.denyAuthority)return Response.json({error:{code:'forbidden'}},{status:403});expect(state.issuer).toBe('issuing');expect(JSON.parse(String(init?.body))).toEqual(intent);if(state.lost){state.lost=false;throw new Error('lost authorization response');}return Response.json({...intent,accountId,operationId,deadline:Date.now()+300000,serverPublicKey:binary(3),ticket:binary(4),status:'authorized'});}
    throw new Error('unexpected cloud request');
  }} as unknown as NativeAccount;
  const status=()=>({kind:'richStatus',operationId,status:state.status,issuerState:state.issuer,settled:state.status==='applied'||state.status==='rejected'});
  const client={run:async()=>({kind:'applied'}),device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,publicKey:pk,name:'隔离设备'},remote:{port:1234,addresses:[]},clients:{total:1,active:1}}}),recipeInstall:async(req:RecipeInstallRequest)=>{
    steps.push('native:'+req.type);
    if(req.type==='source')return {kind:'source',groupId,source:state.sourcePresent?{format:'rich-v2',recipeId,versionId,revision:1,authorId:accountId,installedAt:1,sourceToken:'c'.repeat(64)}:null};
    if(req.type==='richSetup'){if(state.changeDuringSetup)++state.seq;return {kind:'richSetup',groupId,token:'d'.repeat(64),steps:[],tasks:[]};}
    if(req.type==='richPrepare'){state.lastAuthority=req.authority??'';intent={format:'rich-v2',generation:2,versionId,manifestSha256:hash,targetPublicKey:pk,nonceCommitment:nonce,...(req.authority==='directUpdate'?{purpose:'updateDirectRichRecipe',fromVersionId:objectId,localPlanSha256:'f'.repeat(64)}:{purpose:'installRichRecipe'})};return req.reviewToken?{kind:'richPrepared',operationId,intent,reviewToken:'a'.repeat(64)}:{kind:'richReview',groupId,reviewToken:'a'.repeat(64),conflicts:[]};}
    if(req.type==='richIssuing')state.issuer='issuing';
    if(req.type==='richCommit'){expect('authorization' in req&&req.authorization?.versionId).toBe(versionId);state.status='applied';state.issuer='authorized';}
    if(req.type==='richCancel')state.status='rejected';
    return status();
  }} as unknown as VonvonClient;
  let main:RecipeUseController;
  const restart=()=>{main=new RecipeUseController(account,viewId=>{const seq=state.seq;return {client,viewId,pairedKey:pk,check(){if(seq!==state.seq)throw new Error('device changed');}};},new RecipeJournal(join(folder,'journal.json')));};restart();
  const begin=(join=false)=>main.request({type:'begin',format:'rich-v2',accountId,recipeId,versionId,viewId:deviceId,botId,...(join?{}:{groupId})});
  return {state,steps,restart,begin,botId,groupId,source:(r:SourceInput)=>main.source({...r,viewId:deviceId,botId,groupId} as DesktopRecipeSourceRequest),run:(r:RecipeUseRequest)=>main.request(r),journal:()=>JSON.parse(readFileSync(join(folder,'journal.json'),'utf8')) as {rows:{action:string;format:string}[]}};
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

it('routes local setup through the Main source facade and refuses stale installed-source or changed-device replies',async()=>{
  const f=fixture();
  const read=await f.source({type:'read'});expect(read.source?.format).toBe('rich-v2');
  const request={type:'setup',sourceToken:'c'.repeat(64),action:{kind:'read'}} as const;
  expect((await f.source(request)).setup).toMatchObject({kind:'richSetup',steps:[],tasks:[]});
  const before=f.steps.filter(step=>step==='native:richSetup').length;
  await expect(f.source({...request,sourceToken:'e'.repeat(64)})).rejects.toThrow('来源已改变');
  expect(f.steps.filter(step=>step==='native:richSetup')).toHaveLength(before);
  f.state.changeDuringSetup=true;await expect(f.source(request)).rejects.toThrow('device changed');
});

it('checks the native installed source instead of presenting an old journal success after the slot changes',async()=>{
  const f=fixture(),review=await f.begin();if(review.kind!=='richReview')throw new Error();await f.run({type:'richResolve',handle:review.handle,reviewToken:review.reviewToken,choices:{}});await f.run({type:'confirm',handle:review.handle});
  f.state.sourcePresent=false;f.restart();expect((await f.begin()).kind).toBe('richReview');
});

it.each([false,true])('uses exact-version authority after an account-bound entitled preview including coded=%s',async coded=>{
  const f=fixture();f.state.coded=coded;const review=await f.begin();expect(f.state.lastAuthority).toBe('exactVersion');if(review.kind!=='richReview')throw new Error();await f.run({type:'richResolve',handle:review.handle,reviewToken:review.reviewToken,choices:{}});expect((await f.run({type:'confirm',handle:review.handle})).kind).toBe('applied');
});
it('uses direct-update authority only after a verified public direct fallback and stops before commit when cloud denies both grants',async()=>{
  const f=fixture();f.state.previewDenied=true;const review=await f.begin();expect(f.state.lastAuthority).toBe('directUpdate');if(review.kind!=='richReview')throw new Error();await f.run({type:'richResolve',handle:review.handle,reviewToken:review.reviewToken,choices:{}});f.state.denyAuthority=true;await expect(f.run({type:'confirm',handle:review.handle})).rejects.toThrow();expect(f.steps).not.toContain('native:richCommit');
});
it('invalidates the preview authority when the account generation changes before its response',async()=>{
  const f=fixture();f.state.changeDuringPreview=true;await expect(f.begin()).rejects.toThrow();expect(f.steps).not.toContain('native:richPrepare');
});

it('retires an unissued preparation before accepting a fresh review after Main restarts',async()=>{
  const f=fixture(),review=await f.begin();if(review.kind!=='richReview')throw new Error();
  await f.run({type:'richResolve',handle:review.handle,reviewToken:review.reviewToken,choices:{}});
  f.restart();const fresh=await f.begin();expect(fresh.kind).toBe('richReview');if(fresh.kind!=='richReview')throw new Error();
  expect(f.steps).toContain('native:richCancel');
  expect((await f.run({type:'richResolve',handle:fresh.handle,reviewToken:fresh.reviewToken,choices:{}})).kind).toBe('richPrepared');
});

it('continues the ordinary existing-group join into rich review through the Main facade',async()=>{
  const f=fixture(),choose=await f.begin(true);if(choose.kind!=='choose')throw new Error();
  const review=await f.run({type:'join',handle:choose.handle,input:{type:'bindGroup',agentId:f.botId,groupId:f.groupId,projectName:'rich-join',folder:{kind:'default'},tool:'codex',conversation:'threads'}});
  expect(review.kind).toBe('richReview');
});
