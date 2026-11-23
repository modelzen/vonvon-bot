import {isDeepStrictEqual} from 'node:util';
import {deviceReplySchema,recipeAuthoringReplySchema,type DesktopAuthoringReply,type DesktopAuthoringRequest,type RecipeAuthoringRequest,type RecipeAuthoringReply,type GroupId} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import type {RecipeDeviceLease} from './recipe-use.js';
import {RecipeAuthoringController} from './recipe-authoring.js';
import {AuthoringJournal} from './recipe-authoring-journal.js';
import {RecipeCreatorJournal,checkVersionSource,type CreatorAssociation} from './recipe-creator-journal.js';
import {RecipeCreatorExecutor,type CreatorContext} from './recipe-creator.js';
import {creatorDraft} from './recipe-creator-cloud.js';

type Continue=Extract<DesktopAuthoringRequest,{type:'creatorContinue'}>;
export interface CreatorSourceLease extends RecipeDeviceLease {signal:AbortSignal;release():void}
type Worker={botName:string;contextHandle:string;association:CreatorAssociation;source:CreatorSourceLease;session:string;stop:()=>void;context:CreatorContext;busy:boolean;timer:ReturnType<typeof setInterval>};
const unavailable=()=>new Error('请先在 App 关联原来源 Bot，并保持原账号和设备在线。');
function expect<K extends RecipeAuthoringReply['kind']>(reply:RecipeAuthoringReply,kind:K){if(reply.kind!==kind)throw unavailable();return reply as Extract<RecipeAuthoringReply,{kind:K}>;}
export class RecipeCreatorSupervisor {
  private readonly workers=new Map<string,Worker>();
  private readonly opening=new Map<string,Promise<Worker|undefined>>();
  private readonly stop=new AbortController();
  private readonly unsubscribe:()=>void;
  private restoring:Promise<void>=Promise.resolve();
  private activeAccount?:AbortSignal;
  private reconnecting?:Promise<void>;
  private readonly reconnect:ReturnType<typeof setInterval>;
  constructor(private readonly account:NativeAccount,private readonly retain:(viewId:string,signal:AbortSignal)=>Promise<CreatorSourceLease>,
    private readonly sources:()=>string[],private readonly journal:RecipeCreatorJournal,private readonly authoringJournal:AuthoringJournal,
    private readonly authoring:RecipeAuthoringController,private readonly executor:RecipeCreatorExecutor){
    const accountChanged=()=>{
      this.invalidate();const status=account.status(),signal=status.kind==='signedIn'?account.lease?.(status.accountId):undefined;
      if(signal===this.activeAccount)return;this.activeAccount=signal;this.restore();
    };
    this.unsubscribe=account.onStatus(accountChanged);
    accountChanged();
    this.reconnect=setInterval(()=>{this.reconnecting??=this.restoreKnown().finally(()=>{this.reconnecting=undefined;});},15000);this.reconnect.unref();
  }
  private key(accountId:string,viewId:string,botId:string){return [accountId,viewId,botId].join('/');}
  private check(accountId:string,signal:AbortSignal,source:CreatorSourceLease){
    source.check();
    if(this.stop.signal.aborted||signal.aborted||this.account.lease?.(accountId)!==signal)throw unavailable();
    const actor=this.account.status();if(actor.kind!=='signedIn'||actor.accountId!==accountId)throw unavailable();
  }
  private async rpc(source:CreatorSourceLease,accountId:string,signal:AbortSignal,request:RecipeAuthoringRequest){
    this.check(accountId,signal,source);if(!source.client.recipeAuthoring)throw unavailable();
    const result=recipeAuthoringReplySchema.parse(await source.client.recipeAuthoring(request));
    this.check(accountId,signal,source);return result;
  }
  private async open(accountId:string,viewId:string,botId:CreatorAssociation['botId'],expected?:CreatorAssociation):Promise<Worker|undefined>{
    const key=this.key(accountId,viewId,botId),current=this.workers.get(key);
    if(current){
      try{current.context.check();}catch{current.stop();}
      if(this.workers.get(key)===current){if(expected&&!isDeepStrictEqual(expected,current.association))throw unavailable();return current;}
    }
    const prior=this.opening.get(key);if(prior){const result=await prior;if(result&&expected&&!isDeepStrictEqual(expected,result.association))throw unavailable();return result;}
    const run=this.openNew(accountId,viewId,botId,expected);this.opening.set(key,run);
    try{return await run;}finally{if(this.opening.get(key)===run)this.opening.delete(key);}
  }
  private async openNew(accountId:string,viewId:string,botId:CreatorAssociation['botId'],expected?:CreatorAssociation):Promise<Worker|undefined>{
    const signal=this.account.lease?.(accountId);if(!signal)throw unavailable();
    const source=await this.retain(viewId,AbortSignal.any([signal,this.stop.signal]));
    let adopted:{handle:string;botName:string;stop:()=>void}|undefined,session:string|undefined;
    try {
      const check=()=>this.check(accountId,signal,source);
      check();
      const identity=deviceReplySchema.parse(await source.client.device({type:'status'}));check();
      if(identity.kind!=='deviceStatus')throw unavailable();
      const {id:deviceId,publicKey:deviceKey}=identity.status.device;
      if(expected&&(expected.deviceId!==deviceId||expected.deviceKey!==deviceKey)||viewId!=='local'&&(viewId!==deviceId||source.pairedKey!==deviceKey))throw unavailable();
      const rpc=(request:RecipeAuthoringRequest)=>this.rpc(source,accountId,signal,request);
      const discovered=expect(await rpc({type:'creatorDiscover',accountId,botId}),'creatorBinding');
      if(!discovered.association){source.release();return;}
      const {binding,scope}=discovered.association;
      if(expected&&(expected.binding!==binding||expected.scope!==scope))throw unavailable();
      const association={accountId,viewId,deviceId,deviceKey,botId,binding,scope};
      const opened=expect(await rpc({type:'creatorOpen',accountId,botId,binding,scope,wakeId:discovered.wakeId}),'creatorSession');
      session=opened.session;
      if(opened.binding!==binding||opened.scope!==scope)throw unavailable();
      adopted=await this.authoring.adoptCreator({accountId,viewId,botId,lease:source,session,leaseMs:opened.leaseMs});check();
      const handle=adopted.handle,adoptedStop=adopted.stop;
      const context:CreatorContext={association,session,check,rpc,settled:draftId=>this.authoring.creatorSettled(handle,draftId)};
      const key=this.key(accountId,viewId,botId);
      let worker:Worker;
      const halt=()=>{
        if(this.workers.get(key)!==worker)return;
        this.workers.delete(key);clearInterval(worker.timer);source.signal.removeEventListener('abort',halt);signal.removeEventListener('abort',halt);
        adoptedStop();source.release();
      };
      worker={botName:adopted.botName,contextHandle:handle,association,source,session,context,busy:false,stop:halt,timer:setInterval(()=>{void this.tick(worker);},Math.max(250,Math.min(3000,Math.floor(opened.leaseMs/3))))};
      worker.timer.unref();this.workers.set(key,worker);
      source.signal.addEventListener('abort',halt,{once:true});signal.addEventListener('abort',halt,{once:true});
      this.journal.remember(association);void this.tick(worker);return worker;
    }catch(error){
      adopted?.stop();if(!adopted&&session)void source.client.recipeAuthoring?.({type:'close',botId,session}).catch(()=>{});
      source.release();throw error;
    }
  }
  private async tick(worker:Worker){
    if(worker.busy)return;worker.busy=true;
    try {
      worker.context.check();
      const polled=expect(await worker.context.rpc({type:'creatorPoll',botId:worker.association.botId,session:worker.session}),'creatorJobs');
      for(const job of polled.jobs){
        worker.context.check();
        if(job.binding!==worker.association.binding||job.scope!==worker.association.scope)throw unavailable();
        try{await this.executor.run(worker.context,job);}catch{worker.context.check();}
      }
    }catch{worker.stop();}
    finally{worker.busy=false;}
  }
  invalidate(){for(const worker of this.workers.values()){try{worker.context.check();}catch{worker.stop();}}}
  private async restoreKnown(){
    const status=this.account.status();if(status.kind!=='signedIn'||this.stop.signal.aborted)return;
    for(const association of this.journal.associations(status.accountId).slice(0,64)){
      if(this.stop.signal.aborted)return;
      await this.open(status.accountId,association.viewId,association.botId,association).catch(()=>{});
    }
  }
  private restore(){
    this.restoring=this.restoring.catch(()=>{}).then(async()=>{
      const status=this.account.status();if(status.kind!=='signedIn'||this.stop.signal.aborted)return;
      const accountId=status.accountId,signal=this.account.lease?.(accountId);if(!signal)return;
      const known=this.journal.associations(accountId);
      for(const association of known.slice(0,64)){
        if(signal.aborted||this.stop.signal.aborted)return;
        await this.open(accountId,association.viewId,association.botId,association).catch(()=>{});
      }
      // Discover explicit Links created before creator associations were journaled.
      for(const viewId of [...new Set(this.sources())].slice(0,16)){
        if(signal.aborted||this.stop.signal.aborted)return;
        let source:CreatorSourceLease|undefined;
        try {
          source=await this.retain(viewId,AbortSignal.any([signal,this.stop.signal]));this.check(accountId,signal,source);
          const snapshot=await source.client.snapshot();this.check(accountId,signal,source);
          for(const bot of snapshot.agents.filter(bot=>bot.running!==false).slice(0,32)){
            if(known.some(row=>row.viewId===viewId&&row.botId===bot.id))continue;
            await this.open(accountId,viewId,bot.id).catch(()=>{});
          }
        }catch{}finally{source?.release();}
      }
    });
  }
  async associated(accountId:string,viewId:string,botId:CreatorAssociation['botId']){
    return this.open(accountId,viewId,botId);
  }
  async continue(input:Continue):Promise<DesktopAuthoringReply>{
    const signal=this.account.lease?.(input.accountId);if(!signal)throw unavailable();
    let selected:Pick<CreatorAssociation,'viewId'|'botId'>|undefined=input.entry.kind==='source'?input.entry:undefined;
    const check=()=>{if(signal.aborted||signal!==this.account.lease?.(input.accountId))throw unavailable();};
    let expected:CreatorAssociation|undefined;
    let roleDraft:RecipeDraftForSelection|undefined;
    if(input.entry.kind==='version'){
      let original=this.journal.version(input.accountId,input.entry.versionId);
      if(!original){
        await this.restoring;
        for(const worker of this.workers.values())if(worker.association.accountId===input.accountId){
          check();
          if(await this.executor.resolveVersion(worker.context,input.entry))break;
        }
        original=this.journal.version(input.accountId,input.entry.versionId);
      }
      if(original){
        // A re-linked private chat can continue only on the originally recorded device, key and Bot.
        const linked=this.journal.associations(input.accountId).find(row=>row.viewId===original.viewId&&row.botId===original.botId);
        if(linked)checkVersionSource(original,linked);
        expected=linked??original;
        selected=expected;
      }
    }
    if(input.entry.kind==='draft'){
      const draft=await creatorDraft(this.account,input.accountId,input.entry.draftId,check);check();
      if(draft.revision!==input.entry.revision)throw unavailable();
      if(draft.format==='rich-v2'){
        let original=this.authoringJournal.history.locator(input.accountId,draft.sourceIntentId);
        if(!original?.groupId){
          await this.restoring;check();
          const candidates:Array<{worker:Worker;groupId:GroupId;identity:string}>=[];
          for(const worker of this.workers.values())if(worker.association.accountId===input.accountId){
            if(original&&(original.deviceId!==worker.association.deviceId||original.deviceKey!==worker.association.deviceKey||original.botId!==worker.association.botId))continue;
            try {
              const found:Extract<RecipeAuthoringReply,{kind:'operationSourceIdentity'}>=expect(await worker.context.rpc({type:'operationSourceIdentity',botId:worker.association.botId,session:worker.session,operationId:draft.sourceIntentId}),'operationSourceIdentity');
              if(found.operationId!==draft.sourceIntentId||!found.identity||original&&original.identity!==found.identity)continue;
              const current=expect(await worker.context.rpc({type:'groupSourceIdentity',botId:worker.association.botId,session:worker.session,groupId:found.groupId}),'groupSourceIdentity');
              if(current.groupId===found.groupId&&current.identity===found.identity)candidates.push({worker,groupId:found.groupId,identity:found.identity});
            }catch{check();}
          }
          const chosen=candidates.filter(candidate=>!input.source||candidate.worker.association.viewId===input.source.viewId&&candidate.worker.association.botId===input.source.botId);
          if(chosen.length!==1){
            if(chosen.length>1)return {kind:'creatorSourceRequired',options:chosen.map(({worker})=>({viewId:worker.association.viewId,botId:worker.association.botId,botName:worker.botName}))};
            throw unavailable();
          }
          const verified=chosen[0]!;this.authoringJournal.history.remember(verified.worker.association,draft.sourceIntentId,verified.identity,verified.groupId);
          original=this.authoringJournal.history.locator(input.accountId,draft.sourceIntentId);
        }
        if(original)selected={viewId:this.journal.associations(input.accountId).find(row=>row.deviceId===original.deviceId&&row.deviceKey===original.deviceKey&&row.botId===original.botId)?.viewId??original.deviceId,botId:original.botId};
      }else roleDraft={name:draft.public.name,version:draft.public.version,draftId:draft.draftId};
    }
    if(selected&&input.source&&(selected.viewId!==input.source.viewId||selected.botId!==input.source.botId))throw unavailable();
    selected??=input.source;
    if(!selected){
      await this.restoring;
      const options=[...this.workers.values()].filter(worker=>worker.association.accountId===input.accountId).flatMap(worker=>{
        try{worker.context.check();return [{viewId:worker.association.viewId,botId:worker.association.botId,botName:worker.botName}];}catch{return [];}
      });
      if(options.length===1)selected=options[0];else return {kind:'creatorSourceRequired',options};
    }
    check();
    const worker=await this.open(input.accountId,selected.viewId,selected.botId,expected);if(!worker)throw unavailable();
    check();
    worker.context.check();
    const creatorHandle=worker.contextHandle;
    if(roleDraft){
      expect(await worker.context.rpc({type:'creatorContinue',botId:worker.association.botId,session:worker.session,
        selection:{kind:'draft',work:{draftId:roleDraft.draftId,source:null},name:roleDraft.name,version:roleDraft.version}}),'creatorAck');
    }else await this.authoring.creatorBegin(creatorHandle,input.entry);
    worker.context.check();
    if(input.entry.kind==='version')this.journal.rememberVersion(worker.association,input.entry.versionId);
    return {kind:'creatorContinuing',accountId:input.accountId,viewId:selected.viewId,botId:selected.botId};
  }
  dispose(){if(this.stop.signal.aborted)return;this.stop.abort();clearInterval(this.reconnect);this.unsubscribe();for(const worker of this.workers.values())worker.stop();}
}
type RecipeDraftForSelection={draftId:string;name:string;version:string};
