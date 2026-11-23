import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {creatorChatTargetSchema,deviceReplySchema,recipeAuthoringReplySchema,recipePublicationMetadataIssue,type DesktopAuthoringReply,type DesktopAuthoringRequest,type RecipeAuthoringRequest,type RecipeAuthoringReply,type RecipeDraft,type CreatorWork,type CreatorAnswer,type CreatorJob} from '@vonvon/protocol';
import type {NativeAccount} from './account-session.js';
import type {RecipeDeviceLease} from './recipe-use.js';
import {RecipeAuthoringController} from './recipe-authoring.js';
import {AuthoringError} from './recipe-authoring-cloud.js';
import {AuthoringJournal} from './recipe-authoring-journal.js';
import {RecipeCreatorJournal,checkVersionSource,type CreatorAssociation} from './recipe-creator-journal.js';
import {RecipeCreatorExecutor,type CreatorContext} from './recipe-creator.js';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from './local-recipe-drafts.js';

type Continue=Extract<DesktopAuthoringRequest,{type:'creatorContinue'}>;
export interface CreatorSourceLease extends RecipeDeviceLease {signal:AbortSignal;release():void}
type Worker={resourceContext:boolean;botName:string;contextHandle:string;association:CreatorAssociation;source:CreatorSourceLease;session:string;stop:()=>void;context:CreatorContext;busy:boolean;queue:Promise<void>;timer:ReturnType<typeof setInterval>};
type DraftSource={work:CreatorWork;selected:Pick<CreatorAssociation,'viewId'|'botId'>;original:CreatorAssociation;expected:CreatorAssociation};
type PublicationReview={worker:Worker;signal:AbortSignal;draft:RecipeDraft;job:CreatorJob;snapshotDigest:string;confirmationId:string;expiresAt:number;sent:boolean};
type PublicationPreparationStage='account'|'source'|'association'|'worker'|'workerSource'|'queue'|'daemonPreview'|'prepareExecution'|'existingExecution'|'freezePreview'|'compareDraft'|'review';
const diagnosticErrorNames=new Set(['Error','TypeError','RangeError','ZodError','AuthoringError','AbortError','TimeoutError']);
const diagnosticFields=new Set(['kind','type','job','task','command','snapshot','work','draftId','source','preparationId','groupId','identity','revision','public','name','version','summary','overview','access','format','recipeId','parent','contentSha256','parts','sections','title','pageHashes','appPreviewUrl','result','state','mode','approval','expiresAt','confirmation','confirmationId','id','binding','scope']);
const unavailable=()=>new Error('请先在 App 关联原来源 Bot，并保持原账号和设备在线。');
function expect<K extends RecipeAuthoringReply['kind']>(reply:RecipeAuthoringReply,kind:K){if(reply.kind!==kind)throw unavailable();return reply as Extract<RecipeAuthoringReply,{kind:K}>;}
export class RecipeCreatorSupervisor {
  private readonly workers=new Map<string,Worker>();
  private resourceQueue:Promise<void>=Promise.resolve();
  private readonly resourceLinks=new Map<string,{handle:string;lease:AbortSignal}>();
  private readonly opening=new Map<string,Promise<Worker|undefined>>();
  private readonly reviews=new Map<string,PublicationReview>();
  private readonly stop=new AbortController();
  private readonly unsubscribe:()=>void;
  private restoring:Promise<void>=Promise.resolve();
  private activeAccount?:AbortSignal;
  private reconnecting?:Promise<void>;
  private readonly reconnect:ReturnType<typeof setInterval>;
  private readonly localDrafts:LocalRecipeDrafts;
  private readonly ownsLocalDrafts:boolean;
  constructor(private readonly account:NativeAccount,private readonly retain:(viewId:string,signal:AbortSignal)=>Promise<CreatorSourceLease>,
    private readonly sources:()=>string[],private readonly journal:RecipeCreatorJournal,private readonly authoringJournal:AuthoringJournal,
    private readonly authoring:RecipeAuthoringController,private readonly executor:RecipeCreatorExecutor,localDrafts?:LocalRecipeDrafts){
    this.localDrafts=localDrafts??new LocalRecipeDrafts();this.ownsLocalDrafts=localDrafts===undefined;
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
      const opened=expect(await rpc({type:'creatorOpen',accountId,botId,binding,scope,wakeId:discovered.wakeId,nativePreview:true,draftScope:true,...(source.client.supportsResourceContext&&{resourceContext:true})}),'creatorSession');
      session=opened.session;
      if(opened.binding!==binding||opened.scope!==scope)throw unavailable();
      adopted=await this.authoring.adoptCreator({accountId,viewId,botId,lease:source,session,leaseMs:opened.leaseMs});check();
      const handle=adopted.handle,adoptedStop=adopted.stop;
      const context:CreatorContext={association,session,check,rpc,settled:draftId=>this.authoring.creatorSettled(handle,draftId)};
      const key=this.key(accountId,viewId,botId);
      let worker:Worker;
      const halt=()=>{
        if(this.workers.get(key)!==worker)return;
        for(const [id,review] of this.reviews)if(review.worker===worker)this.reviews.delete(id);
        this.workers.delete(key);clearInterval(worker.timer);source.signal.removeEventListener('abort',halt);signal.removeEventListener('abort',halt);
        adoptedStop();source.release();
      };
      worker={resourceContext:opened.resourceContext===true,botName:adopted.botName,contextHandle:handle,association,source,session,context,busy:false,queue:Promise.resolve(),stop:halt,timer:setInterval(()=>{void this.tick(worker);},Math.max(250,Math.min(3000,Math.floor(opened.leaseMs/3))))};
      worker.timer.unref();this.workers.set(key,worker);
      source.signal.addEventListener('abort',halt,{once:true});signal.addEventListener('abort',halt,{once:true});
      this.journal.remember(association);void this.tick(worker);return worker;
    }catch(error){
      adopted?.stop();if(!adopted&&session)void source.client.recipeAuthoring?.({type:'close',botId,session}).catch(()=>{});
      source.release();throw error;
    }
  }
  private async tick(worker:Worker){
    if(worker.busy)return;
    try{await this.exclusive(worker,async()=>{
      worker.context.check();
      const polled=expect(await worker.context.rpc({type:'creatorPoll',botId:worker.association.botId,session:worker.session}),'creatorJobs');
      for(const job of polled.jobs){
        worker.context.check();
        if(job.binding!==worker.association.binding||job.scope!==worker.association.scope)throw unavailable();
        try{await this.executor.run(worker.context,job);}catch{worker.context.check();}
      }
    });}catch{worker.stop();}
  }
  private async exclusive<T>(worker:Worker,run:()=>Promise<T>):Promise<T>{
    const previous=worker.queue;
    let release=()=>{};worker.queue=new Promise<void>(resolve=>{release=resolve;});
    await previous;worker.busy=true;
    try{worker.context.check();return await run();}finally{worker.busy=false;release();}
  }
  invalidate(){for(const [id,review] of this.reviews)if(review.signal.aborted||this.account.lease?.(review.worker.association.accountId)!==review.signal)this.reviews.delete(id);for(const worker of this.workers.values()){try{worker.context.check();}catch{worker.stop();}}}
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
  private localDraft(accountId:string,draftId:string,check:()=>void):LocalRecipeDraftRecord{
    check();
    const record=this.localDrafts.read(accountId,draftId);check();
    if(!record)throw new AuthoringError('本机未找到这份草稿。旧云草稿需要显式导入后才能继续。');
    if(record.association.accountId!==accountId||record.work.draftId!==draftId||record.draft.draftId!==draftId)throw unavailable();
    return record;
  }
  private draftSource(accountId:string,record:LocalRecipeDraftRecord,check:()=>void,source?:Continue['source']):DraftSource{
    check();const original=record.association;
    if(original.accountId!==accountId||source&&(source.viewId!==original.viewId||source.botId!==original.botId))throw unavailable();
    if(record.draft.format==='rich-v2'&&(!record.work.source||!record.sourceCanonical||record.work.source.preparationId!==record.draft.sourceIntentId))
      throw new AuthoringError('本地草稿的来源资料尚未完整保存，请在原来源 Bot 中重新核对。');
    const linked=this.journal.associations(accountId).find(row=>row.viewId===original.viewId&&row.botId===original.botId);
    if(linked)checkVersionSource(original,linked);
    const expected=linked??original;
    return {original,expected,selected:{viewId:expected.viewId,botId:expected.botId},work:record.work};
  }
  private async checkDraftSource(worker:Worker,resolved:DraftSource){
    checkVersionSource(resolved.original,worker.association);
    const source=resolved.work.source;
    if(!source)return;
    const current=expect(await worker.context.rpc({type:'groupSourceIdentity',botId:worker.association.botId,session:worker.session,groupId:source.groupId}),'groupSourceIdentity');
    if(current.groupId!==source.groupId||current.identity!==source.identity)throw unavailable();
  }
  invalidateDraft(accountId:string,draftId:string){
    for(const [id,review] of this.reviews)if(review.worker.association.accountId===accountId&&review.draft.draftId===draftId)this.reviews.delete(id);
  }
  invalidateReviews(){this.reviews.clear();}
  private async publicationWait<T>(pending:Promise<T>):Promise<T>{
    let timer:ReturnType<typeof setTimeout>|undefined;
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new AuthoringError('发布准备尚未完成，请稍后核对原请求。')),15000);timer.unref();});
    try{return await Promise.race([pending,timeout]);}finally{if(timer)clearTimeout(timer);}
  }
  private async previewState(worker:Worker,work:CreatorWork,revision:number){
    return expect(await worker.context.rpc({type:'creatorPreview',botId:worker.association.botId,session:worker.session,work,revision}),'creatorPreview');
  }
  private publicationResult(worker:Worker,job:CreatorJob,result?:CreatorAnswer):Extract<DesktopAuthoringReply,{kind:'publicationResult'}>{
    const task=job.task;
    if(task.kind!=='command'||task.command.kind!=='publish')throw unavailable();
    const answer=result??this.journal.command(worker.association.accountId,job.id)?.result;
    if(answer?.kind==='rejected')throw new AuthoringError('原发布请求未完成，请重新读取草稿并核对来源和修订。');
    if(answer?.kind!=='published')return {kind:'publicationResult',result:{kind:'pending'}};
    const destination=this.journal.command(worker.association.accountId,job.id)?.destination;
    const recipeId=destination===undefined?task.command.snapshot.recipeId:destination?.recipeId;
    if(answer.draftId!==task.command.snapshot.work.draftId||answer.draftRevision!==task.command.snapshot.revision||
      recipeId&&recipeId!==answer.target.recipeId)throw unavailable();
    return {kind:'publicationResult',result:{kind:'published',publication:{accountId:worker.association.accountId,draftId:answer.draftId,
      ...answer.target,revision:answer.revision}}};
  }
  async recoverPublication(input:Extract<DesktopAuthoringRequest,{type:'recoverPublication'}>):Promise<DesktopAuthoringReply>{
    try {
      const signal=this.account.lease?.(input.accountId);if(!signal)throw unavailable();
      const check=()=>{
        const status=this.account.status();
        if(this.stop.signal.aborted||signal.aborted||this.account.lease?.(input.accountId)!==signal||status.kind!=='signedIn'||status.accountId!==input.accountId)throw unavailable();
      };
      return await this.executor.recoverPublication(input.accountId,input.draftId,check);
    }catch{throw new AuthoringError('发布结果尚未确认，请在原账号中重试核对同一次请求。');}
  }
  async preparePublication(input:Extract<DesktopAuthoringRequest,{type:'preparePublication'}>):Promise<DesktopAuthoringReply>{
    const issue=recipePublicationMetadataIssue(input.draft.public);
    if(issue)throw new AuthoringError(issue);
    let stage:PublicationPreparationStage='account';
    try {
      const signal=this.account.lease?.(input.accountId);if(!signal)throw unavailable();
      const check=()=>{const status=this.account.status();if(this.stop.signal.aborted||signal.aborted||this.account.lease?.(input.accountId)!==signal||status.kind!=='signedIn'||status.accountId!==input.accountId)throw unavailable();};
      const record=this.localDraft(input.accountId,input.draft.draftId,check),draft=record.draft;
      if(!isDeepStrictEqual(draft,input.draft))throw new AuthoringError('草稿内容或修订已改变，请重新读取本地草稿后确认发布。');
      stage='source';
      const resolved=this.draftSource(input.accountId,record,check);
      stage='association';
      const {selected,expected}=resolved;
      stage='worker';
      const worker=await this.open(input.accountId,selected.viewId,selected.botId,expected);if(!worker)throw unavailable();check();
      stage='workerSource';
      await this.checkDraftSource(worker,resolved);check();
      stage='queue';
      return await this.publicationWait(this.exclusive(worker,async()=>{
        const deadline=Date.now()+15000;
        stage='daemonPreview';
        let state=await this.previewState(worker,resolved.work,draft.revision);
        for(let attempt=0;attempt<3&&Date.now()<deadline&&state.state==='preparing';attempt++){
          stage='prepareExecution';
          await this.executor.run(worker.context,state.job);check();
          stage='daemonPreview';
          state=await this.previewState(worker,resolved.work,draft.revision);
        }
        if(state.state==='preparing')throw new AuthoringError('发布准备尚未完成，请稍后重试。');
        if(state.state==='active'||state.state==='unknown'){
          stage='existingExecution';
          await this.executor.run(worker.context,state.job);check();
          stage='daemonPreview';
          state=await this.previewState(worker,resolved.work,draft.revision);
        }
        stage='existingExecution';
        if(state.state==='finished'||state.state==='active')return this.publicationResult(worker,state.job,state.result);
        stage='freezePreview';
        const frozen=await this.executor.preview(worker.context,state.job);check();
        stage='compareDraft';
        if(!isDeepStrictEqual(frozen.draft,input.draft))throw new AuthoringError('草稿内容或修订已改变，请重新读取后确认发布。');
        if(state.job.task.kind!=='command'||state.job.task.command.kind!=='publish')throw unavailable();
        const snapshotDigest=state.job.task.command.snapshotDigest;
        stage='review';
        for(const [id,review] of this.reviews){
          if(review.expiresAt<=Date.now()||review.signal.aborted)this.reviews.delete(id);
          else if(!review.sent&&review.worker===worker&&review.signal===signal&&review.job.id===state.job.id&&review.snapshotDigest===snapshotDigest&&isDeepStrictEqual(review.draft,frozen.draft))
            return {kind:'publicationReady',reviewId:id,draftId:draft.draftId,revision:draft.revision,public:draft.public};
        }
        if(this.reviews.size>=128)throw new AuthoringError('请完成或关闭现有发布确认后重试。');
        const reviewId=randomUUID();
        this.reviews.set(reviewId,{worker,signal,draft:frozen.draft,job:state.job,snapshotDigest,confirmationId:randomUUID(),expiresAt:Date.now()+10*60_000,sent:false});
        return {kind:'publicationReady',reviewId,draftId:draft.draftId,revision:draft.revision,public:draft.public};
      }));
    }catch(error){
      console.warn('recipe.publication.prepare.failed',{
        code:'prepare_failed',stage,errorName:error instanceof Error&&diagnosticErrorNames.has(error.name)?error.name:'UnknownError',
        ...(error instanceof z.ZodError&&{issues:error.issues.slice(0,8).map(issue=>({code:issue.code,
          path:issue.path.slice(0,16).map(part=>typeof part==='number'?part:diagnosticFields.has(part)?part:'*')}))}),
      });
      if(error instanceof AuthoringError)throw error;
      throw new AuthoringError('发布准备尚未完成。请保持原来源 Bot 在线，完成草稿保存，并重新读取草稿后核对原请求。');
    }
  }
  async confirmPublication(input:Extract<DesktopAuthoringRequest,{type:'confirmPublication'}>):Promise<DesktopAuthoringReply>{
    try {
      const review=this.reviews.get(input.reviewId);
      if(!review)throw new AuthoringError('发布确认已失效，请重新读取草稿并确认。');
      const checkReview=()=>{
        const status=this.account.status();
        if(this.reviews.get(input.reviewId)!==review||review.worker.association.accountId!==input.accountId||review.expiresAt<=Date.now()||
          review.signal.aborted||this.account.lease?.(input.accountId)!==review.signal||status.kind!=='signedIn'||status.accountId!==input.accountId)
          throw new AuthoringError('发布确认已失效，请重新读取草稿并确认。');
        review.worker.context.check();
      };
      checkReview();
      const {worker}=review,task=review.job.task;
      if(task.kind!=='command'||task.command.kind!=='publish')throw unavailable();
      const {work,revision}=task.command.snapshot;
      const checkDestination=(job:CreatorJob)=>{
        if(job.task.kind!=='command'||job.task.command.kind!=='publish')throw unavailable();
        const approval=job.task.confirmation;
        const destination=approval?.kind==='app'?this.journal.publicationChoice(input.accountId,job.id,approval.confirmationId):undefined;
        if(!isDeepStrictEqual(destination,input.destination))throw new AuthoringError('此草稿已按另一项发布选择确认，请核对原发布结果。');
      };
      return await this.exclusive(worker,async()=>{
        checkReview();
        let state=await this.previewState(worker,work,revision);
        if(state.job.id!==review.job.id)throw unavailable();
        if(state.state==='finished'){checkDestination(state.job);return this.publicationResult(worker,state.job,state.result);}
        if(!review.sent&&state.state!=='active'){
          const frozen=await this.executor.preview(worker.context,state.job);
          if(!isDeepStrictEqual(frozen.draft,review.draft)||state.job.task.kind!=='command'||state.job.task.command.kind!=='publish'||state.job.task.command.snapshotDigest!==review.snapshotDigest)
            throw new AuthoringError('草稿内容或修订已改变，请重新读取后确认发布。');
          checkReview();
          if(input.destination!==undefined)this.journal.bindPublicationChoice(input.accountId,review.job.id,review.confirmationId,input.destination);
          review.sent=true;
          expect(await worker.context.rpc({type:'creatorAppConfirm',botId:worker.association.botId,session:worker.session,id:review.job.id,
            snapshotDigest:review.snapshotDigest,confirmationId:review.confirmationId}),'creatorAck');
          state=await this.previewState(worker,work,revision);
        }
        if(state.state==='active'||state.state==='finished')checkDestination(state.job);
        if(state.state==='active'||state.state==='unknown'){
          await this.executor.run(worker.context,state.job);
          state=await this.previewState(worker,work,revision);
        }
        return this.publicationResult(worker,state.job,state.result);
      });
    }catch(error){
      if(error instanceof AuthoringError)throw error;
      throw new AuthoringError('发布结果尚未确认。请保持原来源 Bot 在线，重新读取草稿后核对同一次请求。');
    }
  }
  resourceHandoff(input:Extract<DesktopAuthoringRequest,{type:'resourceHandoff'}>):Promise<DesktopAuthoringReply>{
    // Preserve App selection order across snapshot and association reads. The native worker processes cloud jobs separately.
    const turn=this.resourceQueue.then(()=>this.beginResourceHandoff(input));
    this.resourceQueue=turn.then(()=>{},()=>{});
    return turn;
  }
  private async beginResourceHandoff(input:Extract<DesktopAuthoringRequest,{type:'resourceHandoff'}>):Promise<DesktopAuthoringReply>{
    const {accountId,viewId,botId,target,requestId}=input;
    const linkKey=JSON.stringify([accountId,viewId,botId,requestId]);
    const worker=await this.open(accountId,viewId,botId);
    if(!worker){
      const accountLease=this.account.lease?.(accountId);if(!accountLease)throw unavailable();
      const source=await this.retain(viewId,AbortSignal.any([accountLease,this.stop.signal]));
      try{
        this.check(accountId,accountLease,source);
        if(!source.client.supportsResourceContext)throw new AuthoringError('此设备尚不支持配方资源交付。');
      }finally{source.release();}
      for(const [key,association] of this.resourceLinks)if(association.lease.aborted)this.resourceLinks.delete(key);
      const linking=this.resourceLinks.get(linkKey);
      if(linking?.lease===accountLease){
        const prior=await this.authoring.request({type:'status',handle:linking.handle}).catch(()=>undefined);
        if(prior?.kind==='session'&&!prior.linked)return {kind:'handoffLinkRequired',session:prior};
      }
      const session=await this.authoring.request({type:'open',accountId,viewId,botId});
      if(session.kind!=='session'||session.linked)throw unavailable();
      if(this.resourceLinks.size>=64)this.resourceLinks.delete(this.resourceLinks.keys().next().value!);
      this.resourceLinks.set(linkKey,{handle:session.handle,lease:accountLease});
      return {kind:'handoffLinkRequired',session};
    }
    this.resourceLinks.delete(linkKey);
    if(!worker.resourceContext)throw new AuthoringError('此设备尚不支持配方资源交付。');
    worker.context.check();
    const snapshot=await worker.source.client.snapshot();
    worker.context.check();
    const bot=snapshot.agents.find(row=>row.id===botId);
    if(snapshot.stale||snapshot.host.kind!=='connected'||!bot?.running||bot.connection!=='connected'||!bot.tenant)throw unavailable();
    const chat=creatorChatTargetSchema.parse({accountId,viewId,botId,botName:bot.name,tenant:bot.tenant});
    const state=expect(await worker.context.rpc({type:'resourceHandoff',botId,session:worker.session,target,requestId}),'resourceHandoff');
    worker.context.check();
    if(state.requestId!==requestId||!isDeepStrictEqual(state.target,target))throw unavailable();
    if(state.delivery==='pending')void this.tick(worker);
    return {...state,...chat};
  }
  async continue(input:Continue):Promise<DesktopAuthoringReply>{
    const signal=this.account.lease?.(input.accountId);if(!signal)throw unavailable();
    let selected:Pick<CreatorAssociation,'viewId'|'botId'>|undefined=input.entry.kind==='source'?input.entry:undefined;
    const check=()=>{const status=this.account.status();if(this.stop.signal.aborted||signal.aborted||signal!==this.account.lease?.(input.accountId)||status.kind!=='signedIn'||status.accountId!==input.accountId)throw unavailable();};
    let expected:CreatorAssociation|undefined;
    let localSource:DraftSource|undefined;
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
      const record=this.localDraft(input.accountId,input.entry.draftId,check),draft=record.draft;
      if(draft.revision!==input.entry.revision)throw unavailable();
      const resolved=this.draftSource(input.accountId,record,check,input.source);
      localSource=resolved;expected=resolved.expected;
      selected=resolved.selected;
      if(draft.format!=='rich-v2')roleDraft={name:draft.public.name,version:draft.public.version,draftId:draft.draftId};
    }
    if(selected&&input.source&&(selected.viewId!==input.source.viewId||selected.botId!==input.source.botId))throw unavailable();
    selected??=input.source;
    // A lost reply from a legacy selection cannot establish which formerly available Bot received it.
    check();
    if(!selected&&input.recover)return {kind:'creatorUnverified',accountId:input.accountId,retryId:input.retryId};
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
    if(localSource){await this.checkDraftSource(worker,localSource);check();}
    worker.context.check();
    const snapshot=await worker.source.client.snapshot();
    worker.context.check();
    const bot=snapshot.agents.find(bot=>bot.id===worker.association.botId);
    if(snapshot.stale||snapshot.host.kind!=='connected'||!bot?.running||bot.connection!=='connected'||!bot.tenant)throw unavailable();
    if(input.entry.kind==='source'){
      const entry=input.entry;
      const binding=snapshot.memberships.find(row=>row.agentId===bot.id&&row.groupId===entry.groupId);
      if(!binding?.enabled||binding.stale||!snapshot.groups.some(group=>group.id===entry.groupId)||
        bot.registrationId!==entry.registrationId||bot.registeredAt!==entry.registeredAt||binding.bindingIncarnation!==entry.bindingIncarnation)throw unavailable();
    }
    const target=creatorChatTargetSchema.parse({accountId:input.accountId,viewId:selected.viewId,botId:selected.botId,tenant:bot.tenant,botName:bot.name});
    if(roleDraft){
      if(input.recover)return {kind:'creatorContinuing',...target,retryId:input.retryId,delivery:'unverified'};
      expect(await worker.context.rpc({type:'creatorContinue',botId:worker.association.botId,session:worker.session,
        selection:{kind:'draft',work:{draftId:roleDraft.draftId,source:null},name:roleDraft.name,version:roleDraft.version}}),'creatorAck');
      worker.context.check();
      return {kind:'creatorContinuing',...target,retryId:input.retryId,delivery:'queued'};
    }
    const result=await this.authoring.creatorBegin(worker.contextHandle,input,target);
    worker.context.check();
    if(result.kind!=='creatorContinuing')throw unavailable();
    if(input.entry.kind==='version'&&result.delivery==='delivered')this.journal.rememberVersion(worker.association,input.entry.versionId);
    return result;
  }
  dispose(){if(this.stop.signal.aborted)return;this.invalidateReviews();this.stop.abort();clearInterval(this.reconnect);this.unsubscribe();for(const worker of this.workers.values())worker.stop();if(this.ownsLocalDrafts)this.localDrafts.close();}
}
type RecipeDraftForSelection={draftId:string;name:string;version:string};
