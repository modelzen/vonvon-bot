import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalizeRichRecipeContent,recipeInstallRequestSchema} from '@vonvon/protocol';
import {expect,it,vi} from 'vitest';

const root=await mkdtemp(join(tmpdir(),'recipe-plan-recovery-'));
vi.stubEnv('VONVON_HOME',root);
const {RecipeInstaller}=await import('../src/recipe/installer');
const {addProject,getProjectByChatId,mutateProjectByChatId}=await import('../src/project/registry');
const {botPaths}=await import('../src/config/paths');
const {applyRich,prepareRich,readRichJournal,editRichJournal}=await import('../src/recipe/rich-runtime');
const {canonicalLocal}=await import('../src/recipe/rich-source-lineage');
const {createScheduleStore}=await import('../src/bot/schedule/store');
const {log}=await import('../src/core/logger');
const hash=(value:unknown)=>createHash('sha256').update(canonicalLocal(value)).digest('hex');
const identity=()=>({itemId:randomUUID(),originId:randomUUID()});
const field=(value:string)=>({...identity(),value});
let sequence=0;

async function fixture(memory=true,authority?:'directUpdate'){
  const bot={appId:'cli_plan_recovery_'+ ++sequence,name:'recovery',tenant:'feishu' as const,createdAt:1,registrationId:randomUUID()};
  const botIdentity={appId:bot.appId,tenant:bot.tenant,createdAt:bot.createdAt,registrationId:bot.registrationId};
  const dir=botPaths(bot.appId),loc={dataRoot:root,file:dir.projectsFile},groupId='oc_plan_recovery';
  const recipeId=randomUUID(),accountId=randomUUID(),fromVersionId=randomUUID();
  await mkdir(dir.dir,{recursive:true});
  await writeFile(join(root,'bots.json'),JSON.stringify({version:1,bots:[bot]}));
  await addProject({chatId:groupId,name:'Recovery',cwd:root,blank:false,createdAt:1},loc);
  await mutateProjectByChatId(groupId,row=>{row.recipeInstall={recipeId,versionId:fromVersionId,authorId:randomUUID(),access:'direct',
    manifestSha256:'1'.repeat(64),installedAt:1,revision:1,base:{role:''}};},undefined,loc);
  const item={...identity(),text:{kind:'inline' as const,value:'OLD_OVERLAY_ONLY'}},setting={...identity(),field:'response.noMention' as const,value:true};
  const document=canonicalizeRichRecipeContent({format:'rich-v2',schemaVersion:2,
    public:{name:field('recipe'),summary:field('summary'),overview:field('overview'),version:field('2')},
    rules:[],skills:[],files:[],tasks:[],settings:[setting],setup:[],parts:[],memories:memory?[item]:[]});
  const keys=generateKeyPairSync('x25519'),device={v:1 as const,deviceId:randomUUID(),name:'recovery',keypair:{
    publicKey:keys.publicKey.export({format:'jwk'}).x!,secretKey:keys.privateKey.export({format:'jwk'}).d!}};
  const contentSha256=createHash('sha256').update(document.canonicalUTF8).digest('hex');
  const request=recipeInstallRequestSchema.parse({type:'richPrepare',botId:bot.appId,groupId,...(authority&&{authority}),
    canonical:document.canonical,parts:{},preview:{accountId,release:{format:'rich-v2',recipeId,versionId:randomUUID(),authorId:randomUUID(),revision:2,access:'direct',
      contentSha256,logicalBytes:document.logicalBytes},manifest:{objectId:randomUUID(),kind:'manifest',sha256:contentSha256,bytes:document.canonicalUTF8.length,mediaType:'application/json'}}});
  if(request.type!=='richPrepare')throw Error('expected prepare request');
  const prepare=(input=request)=>prepareRich(input,device.keypair.publicKey,async()=>{},async()=>{});
  const review=await prepare();
  if(review.kind!=='richReview')throw Error('expected review');
  const approved={...request,reviewToken:review.reviewToken,choices:{}};
  const current=await prepare(approved);
  if(current.kind!=='richPrepared'||current.intent.purpose!=='updateDirectRichRecipe')throw Error('expected direct update');
  const initial=await readRichJournal(bot.appId,current.operationId);
  const oldToken=hash([botIdentity,groupId,initial.rowDigest,request.preview,device.keypair.publicKey,...(authority?[authority]:[])]);
  const oldResolved=[{kind:'settings',itemId:setting.itemId,originId:setting.originId,value:{field:setting.field,value:setting.value}},
    ...(memory?[{kind:'memories',itemId:item.itemId,originId:item.originId,value:{text:item.text.value}}]:[])];
  await editRichJournal(bot.appId,current.operationId,op=>{
    op.reviewToken=oldToken;
    if(op.intent.purpose==='updateDirectRichRecipe')op.intent.localPlanSha256=hash([oldToken,{},oldResolved]);
  });
  const old=await readRichJournal(bot.appId,current.operationId);
  const auth={...old.intent,operationId:old.id,accountId,ticket:Buffer.alloc(32,1).toString('base64url'),deadline:Date.now()+60000,
    serverPublicKey:keys.publicKey.export({format:'jwk'}).x!,status:'authorized' as const};
  const schedule=createScheduleStore(dir.schedulesFile,{now:Date.now,log,diagnostics:()=>{},activeRecipe:()=>undefined});
  await schedule.load();
  const completion:string[]=[];
  let loseCompletion=false;
  const fetch=vi.fn< typeof globalThis.fetch >(async(url,init)=>{
    const path=new URL(String(url)).pathname,body=JSON.parse(String(init?.body));
    if(path.endsWith('/redeem')){
      const {ticket:_,...binding}=auth;
      return Response.json({...binding,...request.preview,status:'redeemed'});
    }
    if(path.includes('/objects/'))return new Response(Buffer.from(document.canonicalUTF8));
    if(path.endsWith('/complete')){
      completion.push(body.outcome);
      if(loseCompletion){loseCompletion=false;throw Error('completion response lost');}
      return Response.json({operationId:old.id,status:body.outcome,disposition:'recorded'});
    }
    throw Error('unexpected transport call '+path);
  });
  const installer=()=>new RecipeInstaller({apiOrigin:'https://api.example.test',device,isInChat:async()=>{},fetch,
    rich:{brokerOrigin:'https://objects.example.test',bot:async(_id,operation)=>{
      if(operation.kind!=='richActivate')throw Error('unexpected bot operation');
      return applyRich(botIdentity,operation.activation,schedule,async()=>{});
    }}});
  const status=()=>readRichJournal(bot.appId,old.id);
  const action=(type:'richIssuing'|'richCommit',authorization=type==='richCommit')=>installer().request(recipeInstallRequestSchema.parse({type,botId:bot.appId,
    operationId:old.id,...(authorization&&{authorization:auth}),memoryPolicy:'exclude'}));
  return {old,current,approved,prepare,status,action,fetch,completion,bot,auth,loc,groupId,memoryItemId:item.itemId,
    group:()=>getProjectByChatId(groupId,dir.projectsFile),loseCompletion:()=>{loseCompletion=true;}};
}

it.each([undefined,'directUpdate'] as const)('requires a fresh intent after reviewing a legacy unissued direct update (%s)',async(authority)=>{
  const f=await fixture(true,authority),prepared=await f.prepare(f.approved);
  expect(prepared.kind).toBe('richPrepared');
  if(prepared.kind!=='richPrepared')throw Error('expected preparation');
  expect(prepared.operationId).not.toBe(f.old.id);
  expect(prepared.intent).not.toEqual(f.old.intent);
  expect(await f.status()).toMatchObject({status:'rejected',settled:true,issuerState:'unissued',intent:f.old.intent,nonce:f.old.nonce});
});

it('checks the resolved digest even when a retained intent has a current review token',async()=>{
  const f=await fixture(),prepared=await f.prepare(f.approved);
  if(prepared.kind!=='richPrepared')throw Error('expected preparation');
  await editRichJournal(f.bot.appId,prepared.operationId,op=>{
    if(op.intent.purpose==='updateDirectRichRecipe')op.intent.localPlanSha256='0'.repeat(64);
  });
  const stale=await readRichJournal(f.bot.appId,prepared.operationId),replacement=await f.prepare(f.approved);
  expect(replacement.kind).toBe('richPrepared');
  if(replacement.kind!=='richPrepared')throw Error('expected preparation');
  expect(replacement.operationId).not.toBe(stale.id);
  expect(await readRichJournal(f.bot.appId,stale.id)).toMatchObject({status:'rejected',settled:true,intent:stale.intent,nonce:stale.nonce});
});

it.each([undefined,'directUpdate'] as const)('refuses direct issuance of an old unissued operation without a new preparation (%s)',async(authority)=>{
  const f=await fixture(true,authority);
  expect(await f.action('richIssuing')).toMatchObject({status:'rejected',settled:true,issuerState:'unissued',reason:expect.stringMatching(/重新预览/)});
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.status()).toMatchObject({intent:f.old.intent,nonce:f.old.nonce});
});

it.each(['issuing','authorized','redeemed'] as const)('finishes an old %s memory-bound update as rejected and retries its same completion',async(state)=>{
  const f=await fixture();
  await editRichJournal(f.bot.appId,f.old.id,op=>{
    op.issuerState=state==='issuing'?'issuing':'authorized';
    if(state!=='issuing')op.authorization=f.auth;
    if(state==='redeemed')op.status='redeemed';
  });
  f.loseCompletion();
  await expect(f.action('richCommit')).rejects.toThrow('completion response lost');
  expect(await f.status()).toMatchObject({status:'rejected',settled:false,issuerState:'authorized',intent:f.old.intent,nonce:f.old.nonce});
  expect((await f.group())?.recipeInstall?.versionId).toBe(f.old.intent.purpose==='updateDirectRichRecipe'?f.old.intent.fromVersionId:undefined);
  expect((await f.group())?.richRecipe).toBeUndefined();
  expect(f.completion).toEqual(['rejected']);
  expect(await f.action('richCommit')).toMatchObject({status:'rejected',settled:true});
  expect(f.completion).toEqual(['rejected','rejected']);
});

it('completes an already-issued old direct update when its approved projection has no recipe memory',async()=>{
  const f=await fixture(false);
  await editRichJournal(f.bot.appId,f.old.id,op=>{op.issuerState='issuing';});
  expect(await f.action('richCommit')).toMatchObject({status:'applied',settled:true});
  expect((await f.group())?.noMention).toBe(true);
  const before=await f.status(),transportCalls=f.fetch.mock.calls.length;
  expect(await f.action('richCommit')).toMatchObject({status:'applied',settled:true});
  expect(await f.status()).toEqual(before);
  expect(f.fetch.mock.calls).toHaveLength(transportCalls);
});

it('completes an issued update with obsolete memory conflict choices as rejected',async()=>{
  const f=await fixture();
  await editRichJournal(f.bot.appId,f.old.id,op=>{op.issuerState='issuing';op.choices[f.memoryItemId]='local';});
  expect(await f.action('richCommit')).toMatchObject({status:'rejected',settled:true});
  expect((await f.group())?.richRecipe).toBeUndefined();
  expect(f.completion).toEqual(['rejected']);
});

it('leaves unexpected merge failures available for retry instead of recording a rejection',async()=>{
  const f=await fixture(),merge=await import('../src/recipe/rich-merge');
  await editRichJournal(f.bot.appId,f.old.id,op=>{op.issuerState='issuing';});
  const failure=vi.spyOn(merge,'mergeRecipeItems').mockImplementation(()=>{throw Error('unexpected merge failure');});
  try{await expect(f.action('richCommit')).rejects.toThrow('unexpected merge failure');}finally{failure.mockRestore();}
  expect(await f.status()).toMatchObject({status:'redeemed',settled:false});
  expect(f.completion).toEqual([]);
});
