import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {canonicalizeRichRecipeContent,recipeInstallRequestSchema,recipeUseRequestSchema,type RecipeInstallRequest} from '@vonvon/protocol';
import type {VonvonClient} from '@vonvon/client/browser';
import type {NativeAccount} from '../src/account-session';
import {RecipeUseController} from '../src/recipe-use';
import {RecipeJournal} from '../src/recipe-use-journal';
import {expect,it,vi} from 'vitest';

const root=await mkdtemp(join(tmpdir(),'recipe-main-terminal-recovery-'));
vi.stubEnv('VONVON_HOME',root);
const {RecipeInstaller}=await import('../../daemon/src/recipe/installer');
const {addProject,getProjectByChatId,mutateProjectByChatId}=await import('../../daemon/src/project/registry');
const {botPaths}=await import('../../daemon/src/config/paths');
const {applyRich,prepareRich,readRichJournal,editRichJournal}=await import('../../daemon/src/recipe/rich-runtime');
const {canonicalLocal}=await import('../../daemon/src/recipe/rich-source-lineage');
const {createScheduleStore}=await import('../../daemon/src/bot/schedule/store');
const {log}=await import('../../daemon/src/core/logger');
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
  const completion:string[]=[],completionRequests:unknown[]=[];
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
      completionRequests.push({url:String(url),body});
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
  return {old,status,action,fetch,completion,completionRequests,installer,device,bot,auth,groupId,
    group:()=>getProjectByChatId(groupId,dir.projectsFile),loseCompletion:()=>{loseCompletion=true;}};
}

async function mainFixture(outcome:'applied'|'rejected'){
  const f=await fixture(outcome==='rejected','directUpdate');
  await editRichJournal(f.bot.appId,f.old.id,op=>{op.issuerState='authorized';op.authorization=f.auth;});
  const mainFile=join(root,'main-'+randomUUID()+'.json'),journal=new RecipeJournal(mainFile);
  const {recipeId,versionId}=f.old.preview.release,accountId=f.old.account,deviceId=f.device.deviceId,pk=f.device.keypair.publicKey;
  const begin=recipeUseRequestSchema.parse({type:'begin',format:'rich-v2',accountId,recipeId,versionId,
    viewId:deviceId,botId:f.bot.appId,groupId:f.groupId});
  if(begin.type!=='begin'||!begin.groupId)throw Error('expected existing-group recovery');
  journal.save({id:randomUUID(),format:'rich-v2',accountId,viewId:deviceId,deviceId,pk,botId:begin.botId,
    groupId:begin.groupId,recipeId,versionId,createdAt:Date.now(),fromJoin:false,stage:'operation',action:'confirm',
    richIntent:f.old.intent,operation:{id:f.old.id,sha:f.old.intent.manifestSha256,commitment:f.old.intent.nonceCommitment}});
  const accountSignal=new AbortController(),requests:RecipeInstallRequest[]=[];
  let targetGeneration=0,afterReply=(_request:RecipeInstallRequest)=>{};
  const account={lease:()=>accountSignal.signal,request:()=>{throw Error('unexpected Main cloud request');}} as unknown as NativeAccount;
  const client={device:async()=>({kind:'deviceStatus',status:{device:{id:deviceId,publicKey:pk,name:'recovery'},
    remote:{port:1234,addresses:[]},clients:{total:1,active:1}}}),recipeInstall:async(request:RecipeInstallRequest)=>{
      requests.push(request);const reply=await f.installer().request(recipeInstallRequestSchema.parse(request));afterReply(request);return reply;
    }} as unknown as VonvonClient;
  const restart=()=>new RecipeUseController(account,viewId=>{const generation=targetGeneration;return {client,viewId,pairedKey:pk,
    check(){if(generation!==targetGeneration)throw Error('target lease changed');}};},new RecipeJournal(mainFile));
  return {...f,begin,requests,restart,rows:()=>new RecipeJournal(mainFile).all(),
    invalidateAccount:()=>accountSignal.abort(),invalidateTarget:()=>{targetGeneration++;},
    afterReply:(handler:typeof afterReply)=>{afterReply=handler;}};
}

it.each(['rejected','applied'] as const)('recovers the original %s completion through public Main after restart and another lost response',async outcome=>{
  const f=await mainFixture(outcome),first=f.restart(),opened=await first.request(f.begin);
  expect(opened.kind).toBe('pending');
  if(!('handle' in opened))throw Error('expected recovery handle');
  f.loseCompletion();
  await expect(first.request({type:'resume',handle:opened.handle})).rejects.toThrow('completion response lost');
  expect(await f.status()).toMatchObject({status:outcome,settled:false});
  const terminalGroup=await f.group();
  const restarted=f.restart(),again=await restarted.request(f.begin);
  expect(again.kind).toBe('pending');
  if(!('handle' in again))throw Error('expected recovery handle');
  f.loseCompletion();
  await expect(restarted.request({type:'resume',handle:again.handle})).rejects.toThrow('completion response lost');
  expect(f.rows()[0]).toMatchObject({stage:'operation',action:'confirm',operation:{id:f.old.id}});
  expect(await restarted.request({type:'resume',handle:again.handle})).toMatchObject({kind:outcome});
  expect(await f.status()).toMatchObject({status:outcome,settled:true,intent:f.old.intent,nonce:f.old.nonce});
  expect(f.completion).toEqual([outcome,outcome,outcome]);
  expect(f.completionRequests[1]).toEqual(f.completionRequests[0]);
  expect(f.completionRequests[2]).toEqual(f.completionRequests[0]);
  expect(f.requests.filter(request=>request.type==='richCommit')).toEqual(Array.from({length:3},()=>({
    type:'richCommit',memoryPolicy:'exclude',botId:f.bot.appId,operationId:f.old.id,
  })));
  expect(f.fetch.mock.calls.filter(([url])=>new URL(String(url)).pathname.endsWith('/redeem'))).toHaveLength(1);
  expect(await f.group()).toEqual(terminalGroup);
  expect(f.rows()[0]).toMatchObject({stage:'done',outcome});
  const transportCalls=f.fetch.mock.calls.length,daemonCalls=f.requests.length;
  expect(await restarted.request({type:'resume',handle:again.handle})).toMatchObject({kind:outcome});
  expect(f.requests).toHaveLength(daemonCalls);
  expect(await f.restart().request(f.begin)).toMatchObject({kind:outcome});
  expect(f.fetch.mock.calls).toHaveLength(transportCalls);
});

it.each(['rejected','applied'] as const)('returns the true %s result when cancelling a locally terminal operation',async outcome=>{
  const f=await mainFixture(outcome),first=f.restart(),opened=await first.request(f.begin);
  if(!('handle' in opened))throw Error('expected recovery handle');
  f.loseCompletion();
  await expect(first.request({type:'resume',handle:opened.handle})).rejects.toThrow('completion response lost');
  const terminalGroup=await f.group(),restarted=f.restart(),again=await restarted.request(f.begin);
  if(!('handle' in again))throw Error('expected recovery handle');
  f.loseCompletion();
  await expect(restarted.request({type:'cancel',handle:again.handle})).rejects.toThrow('completion response lost');
  expect(f.rows()[0]).toMatchObject({stage:'operation',action:'cancel'});
  expect(await restarted.request({type:'resume',handle:again.handle})).toMatchObject({kind:outcome});
  expect(await f.status()).toMatchObject({status:outcome,settled:true});
  expect(await f.group()).toEqual(terminalGroup);
  expect(f.requests.map(request=>request.type)).toEqual(['richStatus','richCommit','richStatus','richCommit','richStatus','richCommit']);
  expect(f.completionRequests[1]).toEqual(f.completionRequests[0]);
  expect(f.completionRequests[2]).toEqual(f.completionRequests[0]);
});

it.each(['rejected','applied'] as const)('reads an already settled %s daemon operation through Main without another mutation',async outcome=>{
  const f=await mainFixture(outcome);
  expect(await f.action('richCommit',false)).toMatchObject({status:outcome,settled:true});
  const before=await f.status(),transportCalls=f.fetch.mock.calls.length;
  const main=f.restart(),opened=await main.request(f.begin);
  if(!('handle' in opened))throw Error('expected recovery handle');
  expect(await main.request({type:'resume',handle:opened.handle})).toMatchObject({kind:outcome});
  expect(f.requests.map(request=>request.type)).toEqual(['richStatus']);
  expect(await f.status()).toEqual(before);
  expect(f.fetch.mock.calls).toHaveLength(transportCalls);
});

it.each([
  {boundary:'richStatus',lease:'account'}, {boundary:'richStatus',lease:'target'},
  {boundary:'richCommit',lease:'account'}, {boundary:'richCommit',lease:'target'},
] as const)('retains the $lease lease check after terminal recovery awaits $boundary',async({boundary,lease})=>{
  const f=await mainFixture('applied'),first=f.restart(),opened=await first.request(f.begin);
  if(!('handle' in opened))throw Error('expected recovery handle');
  f.loseCompletion();
  await expect(first.request({type:'resume',handle:opened.handle})).rejects.toThrow('completion response lost');
  const main=f.restart(),again=await main.request(f.begin);
  if(!('handle' in again))throw Error('expected recovery handle');
  f.afterReply(request=>{if(request.type===boundary)(lease==='account'?f.invalidateAccount:f.invalidateTarget)();});
  await expect(main.request({type:'resume',handle:again.handle})).rejects.toThrow();
  expect(f.rows()[0]).toMatchObject({stage:'operation',action:'confirm'});
  expect(f.completion).toEqual(boundary==='richStatus'?['applied']:['applied','applied']);
});
