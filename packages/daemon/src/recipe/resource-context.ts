import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {
  newAcquisitionKey,openResourceSnapshot,openResourcePreview,readResourcePage,groupIdSchema,type GroupId,type CreatorAnswer,type CreatorJob,type CreatorReply,
  type ExactResourceVersion,type ResourceAcquireTask,type ResourceDocuments,type ResourceLatest,type ResourcePageQuery,type ResourceReadTask,
} from '@vonvon/protocol';
import type {NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {card,md} from '../card/cards';
import {isAdmin} from '../config/schema';
import {AuthoringIm} from './authoring-im';
import {AuthoringJournal,authoringBotKey,linkKey,recipeSelectionOrder,recordRecipeSelection,sameRecipient,type AuthoringLedger,type Link,type Recipient} from './authoring-journal';
import type {AuthoringOptions,Presence} from './authoring-service';
import {digest} from './authoring-wire';
import {groupSourceIdentity} from './authoring-source';
import {isSetupSkillName,recipeHandoffText,type RecipeHandoffSummary} from './application-guidance';
import {recipeGroupLinks} from './group-links';

const ttl=30*60_000, jobTtl=10*60_000;
const denied=()=>new Error('配方资源、本人关联或原账号连接已改变。请在 App 核对原请求。');
type Task=ResourceReadTask|ResourceAcquireTask;
type Job={id:string;task:Task;session:string;expires:number;origin?:true;messageId?:string;probe?:string;entitlementVerified?:true;answerDigest?:string;failure?:string;retryAt?:number;unknown?:true};
type Delivery=Extract<CreatorReply,{kind:'resourceHandoff'}>['delivery'];
type DocumentVersion={target:ExactResourceVersion;revision:number;hash:string};
export interface ResourceHandoff {
  requestId:string;bot:string;scope:string;account:string;binding:string;recipient:Recipient;target:ExactResourceVersion;
  seen?:string[];focus:boolean;expires:number;delivery:Delivery;firstSend?:number;cardId?:string;messageId?:string;sendId:string;initial:string;
  jobs:Record<string,Job>;active?:DocumentVersion;offer?:ResourceLatest;acquired?:ExactResourceVersion;
  summary?:RecipeHandoffSummary;
  prepared?:{target:ExactResourceVersion;groupId:string;groupIdentity:string;messageId:string;sessionId:string};
  material?:DocumentVersion&{groupId:string;groupIdentity:string;messageId:string;sessionId:string};
}
export type ResourceCaller={sessionId:string;openId:string;chatId:string;messageId:string};
type Trigger={recipient:Recipient;requestId:string;binding:string;expires:number;sessionId?:string};
export type ResourceQuery=(ResourcePageQuery&{groupId?:string})|{kind:'latest'}|{kind:'acquire';versionId:string}|
  {kind:'prepare';groupId:string;wait?:{signal:AbortSignal;notAfter:number}};
const sameTarget=(a:ExactResourceVersion,b:ExactResourceVersion)=>a.recipeId===b.recipeId&&a.versionId===b.versionId;
function newJob(task:Task,p:Presence,now:number):Job{return {task,id:randomUUID(),expires:now+jobTtl,session:p.session};}
const cacheKey=(row:ResourceHandoff,v:DocumentVersion,session:string)=>JSON.stringify([session,row.account,row.scope,row.binding,v.target,v.hash,
  'groupId' in v?v.groupId:null,'groupIdentity' in v?v.groupIdentity:null]);
const wireJob=(p:Presence,j:Job):CreatorJob=>({id:j.id,scope:p.scope,binding:p.binding!,task:j.task});
export class ResourceContext {
  private readonly bot:string;
  private readonly im:AuthoringIm;
  private readonly cache=new Map<string,{docs:ResourceDocuments;expires:number}>();
  private readonly triggers=new Map<string,Trigger>();
  private readonly origins=new Map<string,{check:()=>void;expires:number}>();
  private readonly sending=new Set<string>();
  constructor(private readonly opts:AuthoringOptions,private readonly journal:AuthoringJournal,private readonly now:()=>number,
    private readonly peers:()=>Presence[],private readonly current:()=>Promise<void>){
    this.bot=authoringBotKey(opts.bot);this.im=new AuthoringIm(opts.channel);
  }
  private live(p:Presence){
    if(!p.resourceContext||!p.binding||p.until<=this.now()||this.now()-p.activeAt>=ttl||!this.peers().includes(p))throw denied();
  }
  private link(db:AuthoringLedger,p:Presence){
    this.live(p);
    const link=db.links[linkKey(p.scope,p.account)];
    if(!link||link.binding!==p.binding||link.bot!==this.bot||!isAdmin(this.opts.cfg,link.recipient.openId))throw denied();
    return link;
  }
  private owns(p:Presence,row:ResourceHandoff,link:Link){
    return row.bot===this.bot&&row.account===p.account&&row.scope===p.scope&&row.binding===link.binding&&sameRecipient(link.recipient,row.recipient);
  }
  private async run<T>(p:Presence,op:(db:AuthoringLedger,link:Link)=>T){
    this.live(p);await this.current();
    let recipient:Recipient|undefined;
    const guard=()=>{this.live(p);if(!recipient||!isAdmin(this.opts.cfg,recipient.openId))throw denied();};
    const result=await this.journal.run(db=>{
      const link=this.link(db,p);recipient=link.recipient;return op(db,link);
    },guard);
    guard();p.until=this.now()+45_000;return result;
  }
  private rows(db:AuthoringLedger){return Object.values(db.resources??{});}
  private select(db:AuthoringLedger,row:ResourceHandoff,order:number){
    if(!recordRecipeSelection(db,db.links[linkKey(row.scope,row.account)]!,order))return false;
    for(const other of this.rows(db))if(other.bot===row.bot&&sameRecipient(other.recipient,row.recipient))other.focus=other===row;
    return true;
  }
  async handoff(p:Presence,requestId:string,target:ExactResourceVersion):Promise<Extract<CreatorReply,{kind:'resourceHandoff'}>>{
    const order=recipeSelectionOrder(this.now());
    const result=await this.run(p,(db,link)=>{
      const table=db.resources??={};
      let row=table[requestId];
      if(row){
        if(!this.owns(p,row,link)||!sameTarget(row.target,target))throw denied();
      }else{
        if(Object.keys(table).length>=512)throw new Error('配方资源请求已满。');
        const job=newJob({kind:'resourcePreview',target},p,this.now());
        row=table[requestId]={requestId,target,scope:p.scope,account:p.account,bot:this.bot,binding:link.binding,recipient:link.recipient,
          focus:false,expires:this.now()+ttl,delivery:'pending',sendId:randomUUID(),initial:job.id,jobs:{[job.id]:job}};
        this.select(db,row,order);p.activeAt=this.now();p.activity++;
      }
      return {kind:'resourceHandoff' as const,target,requestId,delivery:row.expires<=this.now()?'unavailable' as const:row.delivery};
    });
    if(result.delivery==='unknown')await this.deliver(p,requestId,true);
    if(result.delivery==='pending'&&await this.run(p,(db,link)=>{
      const row=db.resources![requestId]!;
      if(!this.owns(p,row,link))throw denied();
      if(row.delivery!=='pending')return false;
      const initial=row.jobs[row.initial];
      if(!initial?.answerDigest){
        if(initial&&(initial.expires<=this.now()||initial.task.kind==='resourceRead')){
          const retry=newJob({kind:'resourcePreview',target},p,this.now());delete row.jobs[row.initial];row.initial=retry.id;row.jobs[retry.id]=retry;
        }
        return false;
      }
      if(!row.active)return false;
      const cached=this.cache.get(cacheKey(row,row.active,p.session));if(row.summary&&cached&&cached.expires>this.now())return true;
      const job=newJob({kind:'resourcePreview',target},p,this.now());row.initial=job.id;row.jobs[job.id]=job;
      return false;
    }))await this.deliver(p,requestId);
    return this.run(p,(db,link)=>{
      const row=db.resources![requestId]!;
      if(!this.owns(p,row,link))throw denied();
      return {...result,delivery:row.expires<=this.now()?'unavailable':row.delivery};
    });
  }
  private find(db:AuthoringLedger,id:string){
    for(const row of this.rows(db)){const job=row.jobs[id];if(job)return {row,job};}
  }
  private permitted(p:Presence,row:ResourceHandoff,job:Job){
    if(row.expires<=this.now()||job.expires<=this.now())throw denied();
    if(job.task.kind==='resourceRead'){
      const prepared=row.prepared;
      if(!prepared||!sameTarget(prepared.target,job.task.target)||prepared.groupId!==job.task.groupId||prepared.groupIdentity!==job.task.groupIdentity)throw denied();
    }
    // An accepted mutation stays on the original authenticated native lease.
    if(job.session!==p.session){
      const eligible=this.eligible(row);
      if(job.task.kind==='resourceAcquire'||eligible.length!==1||eligible[0]!==p)throw denied();
    }
    if(job.origin&&!job.answerDigest){
      if(!row.focus)throw denied();
      const origin=this.origins.get(job.id);
      if(!origin||origin.expires<=this.now())throw denied();
      origin.check();
    }
  }
  async poll(p:Presence){
    return this.run(p,(db,link)=>{
      const rows=this.rows(db).filter(row=>this.owns(p,row,link));
      for(const row of rows){
        const initial=row.jobs[row.initial];
        if(row.delivery!=='pending'||row.expires<=this.now()||!initial||
          initial.task.kind!=='resourceRead'||Reflect.has(initial.task,'groupId')||Reflect.has(initial.task,'groupIdentity')||
          initial.origin||initial.probe||!sameTarget(initial.task.target,row.target))continue;
        const eligible=this.eligible(row);
        if(eligible.length!==1||eligible[0]!==p)continue;
        const retry=newJob({kind:'resourcePreview',target:row.target},p,this.now());
        delete row.jobs[row.initial];row.initial=retry.id;row.jobs[retry.id]=retry;
      }
      return rows.flatMap(row=>Object.values(row.jobs).filter(job=>{
        if(job.answerDigest||job.unknown||job.entitlementVerified)return false;
        try{this.permitted(p,row,job);return true;}catch{return false;}
      }).map(job=>wireJob(p,job))).slice(0,4);
    });
  }
  async check(p:Presence,id:string){
    const result=await this.run(p,(db,link)=>{
      const found=this.find(db,id);if(!found)return;
      const {row,job}=found;
      if(!this.owns(p,row,link)||job.answerDigest||job.unknown||job.entitlementVerified)throw denied();
      this.permitted(p,row,job);
      return {kind:'creatorChecked' as const,job:wireJob(p,job),mode:job.task.kind==='resourceAcquire'?'execute' as const:'read' as const};
    });
    if(result?.job.task.kind==='resourceRead')await this.checkGroup(p,result.job.task);
    return result;
  }
  private async checkGroup(p:Presence,task:Extract<Task,{kind:'resourceRead'}>){
    const identity=await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,task.groupId);
    this.live(p);
    if(identity!==task.groupIdentity)throw denied();
  }
  private put(key:string,docs:ResourceDocuments){
    // The protocol caps each full snapshot at 1 MiB logical / 2 MiB wire. At most eight decoded versions per Bot.
    this.cache.delete(key);this.cache.set(key,{docs,expires:this.now()+ttl});
    while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value!);
  }
  async answer(p:Presence,id:string,answer:CreatorAnswer):Promise<boolean>{
    const found=await this.run(p,(db,link)=>{
      const found=this.find(db,id);if(!found)return;
      if(!this.owns(p,found.row,link))throw denied();
      this.permitted(p,found.row,found.job);return found;
    });
    if(!found)return false;
    const hash=digest(JSON.stringify(answer));
    const task=found.job.task;
    if(found.job.answerDigest){
      if(hash!==found.job.answerDigest)throw denied();
      // A duplicate confirms the original receipt. Rehydration requires a fresh exact entitlement check and a new read job.
      return true;
    }
    let docs:ResourceDocuments|undefined;
    if(answer.kind==='resourcePreview'){
      if(task.kind!=='resourcePreview'||!sameTarget(task.target,answer.preview))throw denied();
      docs=await openResourcePreview(answer.preview);
    }
    if(answer.kind==='resourceSnapshot'){
      if(task.kind!=='resourceRead'||!sameTarget(task.target,answer.snapshot.target))throw denied();
      await this.checkGroup(p,task);
      docs=await openResourceSnapshot(answer.snapshot);
      await this.checkGroup(p,task);
    }
    const changed=await this.run(p,(db,link)=>{
      const row=db.resources?.[found.row.requestId],job=row?.jobs[id];
      if(!row||!job||!this.owns(p,row,link))throw denied();
      this.permitted(p,row,job);
      if(job.answerDigest){
        if(job.answerDigest!==hash)throw denied();
        return;
      }
      if(answer.kind==='resourcePreview'&&task.kind==='resourcePreview'){
        row.summary={name:answer.preview.public.name,version:answer.preview.public.version,
          hasSetup:(answer.preview.preview?.skills??[]).some(skill=>isSetupSkillName(skill.name))};
        const v={target:task.target,revision:answer.preview.revision,hash:digest(JSON.stringify(answer.preview))};
        const claim=job.probe?row.jobs[job.probe]:undefined;
        if(claim){
          if(claim.task.kind!=='resourceAcquire'||!sameTarget(v.target,claim.task.target))throw denied();
          claim.entitlementVerified=true;
        }else if(!job.answerDigest&&row.active&&!sameTarget(v.target,row.acquired??row.active.target))throw denied();
        if(!job.answerDigest)row.active=v;
        if(!job.answerDigest&&sameTarget(row.acquired??row.target,v.target))delete row.acquired;
        if(row.material&&!sameTarget(row.material.target,v.target)){delete row.material;delete row.prepared;}
      }else if(answer.kind==='resourceSnapshot'&&task.kind==='resourceRead'){
        const prepared=row.prepared;
        if(!row.active||!sameTarget(row.active.target,task.target)||row.active.revision!==answer.snapshot.revision||
          !prepared||!sameTarget(prepared.target,task.target)||prepared.groupId!==task.groupId||prepared.groupIdentity!==task.groupIdentity)throw denied();
        const v={target:task.target,revision:answer.snapshot.revision,hash:answer.snapshot.contentSha256,groupId:task.groupId,groupIdentity:task.groupIdentity,
          messageId:prepared.messageId,sessionId:prepared.sessionId};
        if(row.material&&sameTarget(row.material.target,v.target)&&row.material.hash!==v.hash)throw denied();
        row.material=v;
      }else if(answer.kind==='resourceLatest'&&task.kind==='resourceLatest'){
        const a=answer.latest;
        if(!row.active||!sameTarget(task.target,row.active.target)||task.revision!==row.active.revision)throw denied();
        if(a.status!=='unknown'&&(a.target.recipeId!==task.target.recipeId||
          (a.status==='current'?(!sameTarget(a.target,task.target)||a.revision!==task.revision):(sameTarget(a.target,task.target)||a.revision<=task.revision))))throw denied();
        if(!job.answerDigest)row.offer=a;
      }else if(answer.kind==='resourceAcquired'&&task.kind==='resourceAcquire'){
        const outcome=answer.outcome;
        if(outcome.ok){
          if(!sameTarget(outcome.value,task.target)||(!outcome.value.owned&&!outcome.value.acquired))throw denied();
          if(!job.answerDigest)row.acquired=task.target;
        }else if(outcome.error.code==='unavailable'){
          job.unknown=true;return row;
        }else{
          job.failure=outcome.error.code;
          if((job.failure==='rate_limited'||job.failure==='acquire_rate_limited')&&outcome.error.retryAfter)
            job.retryAt=this.now()+Math.min(outcome.error.retryAfter*1000,ttl);
        }
      }else if(answer.kind==='rejected'){
        job.failure=answer.reason;
        if(id===row.initial)row.delivery='unavailable';
      }else throw denied();
      job.answerDigest=hash;delete job.unknown;
      return row;
    });
    if(!changed)return true;
    if(changed.jobs[id]?.answerDigest)this.origins.delete(id);
    if(docs&&(answer.kind==='resourceSnapshot'||answer.kind==='resourcePreview')){
      const version=answer.kind==='resourcePreview'?changed.active:changed.material;
      if(!version)throw denied();
      this.put(cacheKey(changed,version,p.session),docs);
      if(id===changed.initial&&changed.delivery==='pending')await this.deliver(p,changed.requestId);
    }
    return true;
  }
  private async deliver(p:Presence,id:string,recover=false){
    if(this.sending.has(id))return;
    this.sending.add(id);
    const update=<T>(fn:(row:ResourceHandoff)=>T)=>this.run(p,(db,link)=>{
      const row=db.resources?.[id];if(!row||!this.owns(p,row,link)||row.expires<=this.now())throw denied();return fn(row);
    });
    try{
      const row=await update(r=>r);
      if(!row.active||row.delivery!=='pending'&&!(recover&&row.delivery==='unknown'&&row.firstSend!==undefined&&this.now()-row.firstSend<55*60_000&&row.cardId))return;
      let cardId=row.cardId;
      if(!cardId){
        if(!row.summary)return;
        cardId=await this.im.createJson(card([md(recipeHandoffText(row.summary))],{header:{title:'使用配方'},forward:false}));
      }
      // The send may have committed before a crash or a lost reply. Persist the original UUID and card before dispatch.
      await update(r=>{if(r.delivery!==row.delivery)throw denied();r.cardId=cardId;r.firstSend??=this.now();r.delivery='unknown';});
      this.live(p);
      const messageId=await this.im.send(row.recipient.chatId,cardId,row.sendId);
      await update(r=>{if(r.cardId!==cardId)throw denied();r.messageId=messageId;r.delivery='sent';});
    }catch{
      // A failed CardKit create has no outgoing DM; an uncertain send remains unknown.
      await update(r=>{if(r.delivery==='pending')r.delivery='unavailable';}).catch(()=>{});
    }finally{this.sending.delete(id);}
  }
  private prune(){
    const now=this.now();
    for(const [id,v] of this.triggers)if(v.expires<=now)this.triggers.delete(id);
    for(const [id,v] of this.origins)if(v.expires<=now)this.origins.delete(id);
  }
  hasTrigger(id:string){return this.triggers.has(id);}
  async route(msg:NormalizedMessage,recipient:Recipient,creatorIntent:boolean):Promise<'resource'|'creator'|'refuse'|'duplicate'>{
    const quoted=msg.replyToMessageId,order=recipeSelectionOrder(this.now());
    if(this.hasTrigger(msg.messageId))return 'duplicate';
    if(!quoted&&creatorIntent)return 'creator';
    this.prune();
    const result=await this.journal.run(db=>{
      const rows=this.rows(db).filter(row=>row.bot===this.bot);
      if(rows.some(row=>row.seen?.includes(msg.messageId)))return 'duplicate' as const;
      const targets=quoted?rows.filter(row=>row.messageId===quoted):rows.filter(row=>row.expires>this.now()&&row.focus&&sameRecipient(row.recipient,recipient));
      if(!targets.length)return;
      const row=targets[0]!,link=db.links[linkKey(row.scope,row.account)];
      const raw=msg.raw as {message?:{parent_id?:string}}|undefined;
      if((raw?.message?.parent_id||undefined)!==(quoted||undefined))return null;
      if(targets.length!==1||!sameRecipient(row.recipient,recipient)||!sameRecipient(link?.recipient,recipient)||link?.binding!==row.binding||
        !isAdmin(this.opts.cfg,recipient.openId)||row.expires<=this.now()||row.delivery!=='sent'||!row.active)return null;
      // DM audio first passes here before transcription. Only the resulting text is routed into an Agent turn.
      if(msg.rawContentType==='audio')return 'voice' as const;
      if(this.triggers.size>=1024)return null;
      if(quoted&&!this.select(db,row,order))return null;
      row.seen=[...(row.seen??[]).slice(-63),msg.messageId];
      return {recipient,requestId:row.requestId,binding:row.binding,expires:row.expires};
    });
    if(result===undefined)return 'creator';
    if(result==='duplicate')return 'duplicate';
    if(result==='voice')return 'resource';
    if(!result)return 'refuse';
    if(!this.triggers.has(msg.messageId)&&this.triggers.size>=1024)return 'refuse';
    const old=this.triggers.get(msg.messageId);
    if(old&&(old.requestId!==result.requestId||!sameRecipient(old.recipient,result.recipient)))return 'refuse';
    if(!old)this.triggers.set(msg.messageId,result);
    return 'resource';
  }
  async bind(caller:ResourceCaller):Promise<'selected'|'unavailable'|undefined>{
    const trigger=this.triggers.get(caller.messageId);
    if(!trigger)return;
    const matches=()=>trigger.expires>this.now()&&trigger.recipient.chatId===caller.chatId&&trigger.recipient.openId===caller.openId&&
      isAdmin(this.opts.cfg,caller.openId)&&(!trigger.sessionId||trigger.sessionId===caller.sessionId);
    if(!matches())return 'unavailable';
    try{
      await this.current();
      const session=await this.journal.run(db=>{
        const row=db.resources?.[trigger.requestId];
        if(!matches()||!row?.focus||row.delivery!=='sent'||!row.active||trigger.binding!==row.binding||!sameRecipient(row.recipient,trigger.recipient))return;
        const p=this.selectedPeer(row);if(!p)return;
        if(this.owns(p,row,this.link(db,p)))return p.session;
      });
      if(!matches()||!session||!this.peers().some(p=>p.session===session&&p.until>this.now()))return 'unavailable';
      trigger.sessionId=caller.sessionId;return 'selected';
    }catch{return 'unavailable';}
  }
  private eligible(row:ResourceHandoff){
    return this.peers().filter(p=>p.resourceContext&&p.scope===row.scope&&p.account===row.account&&p.binding===row.binding&&
      p.until>this.now()&&this.now()-p.activeAt<ttl);
  }
  private selectedPeer(row:ResourceHandoff){
    const peers=this.eligible(row);
    return peers.find(p=>p.session===row.jobs[row.initial]?.session)??(peers.length===1?peers[0]:undefined);
  }
  async tool(get:()=>ResourceCaller|undefined,query:ResourceQuery):Promise<unknown>{
    const caller=get();if(!caller)throw denied();
    const trigger=this.triggers.get(caller.messageId);
    const check=()=>{
      if(query.kind==='prepare')query.wait?.signal.throwIfAborted();
      if(!trigger||trigger.expires<=this.now()||trigger.sessionId!==caller.sessionId||!isDeepStrictEqual(caller,get())||
        trigger.recipient.chatId!==caller.chatId||trigger.recipient.openId!==caller.openId||!isAdmin(this.opts.cfg,caller.openId))throw denied();
    };
    check();await this.current();check();
    let group:{groupId:GroupId;groupIdentity:string}|undefined;
    if('groupId' in query&&query.groupId){
      const scope=await this.journal.run(db=>{
        check();const row=db.resources?.[trigger!.requestId];
        if(!row?.focus||row.binding!==trigger!.binding||!sameRecipient(row.recipient,trigger!.recipient)||row.expires<=this.now())throw denied();
        return row.scope;
      },check);
      const groupId=groupIdSchema.parse(query.groupId);
      const groupIdentity=await groupSourceIdentity(this.opts.channel,this.opts.bot,scope,groupId);
      check();group={groupId,groupIdentity};
    }
    let selected:Presence|undefined;
    let preparation:{id:string;task:Extract<Task,{kind:'resourceRead'}>}|undefined;
    const result=await this.journal.run(db=>{
      check();
      const row=db.resources?.[trigger!.requestId];
      if(!row||!row.focus||row.binding!==trigger!.binding||!sameRecipient(row.recipient,trigger!.recipient)||row.delivery!=='sent'||!row.active||row.expires<=this.now())throw denied();
      const link=db.links[linkKey(row.scope,row.account)];
      if(!link||row.binding!==link.binding||!sameRecipient(link.recipient,row.recipient))throw denied();
      const p=selected=this.selectedPeer(row);
      if(!p)return {status:'unavailable'};
      this.link(db,p);p.activeAt=this.now();
      let task:Task,probe:string|undefined;
      if(query.kind==='prepare'){
        if(!group)throw denied();
        if(row.acquired)return {status:'refreshRequired'};
        row.prepared={target:row.active.target,...group,messageId:caller.messageId,sessionId:caller.sessionId};
        const material=row.material;
        const cached=material?this.cache.get(cacheKey(row,material,p.session)):undefined;
        if(material&&sameTarget(material.target,row.active.target)&&material.groupId===group.groupId&&material.groupIdentity===group.groupIdentity&&
          material.messageId===caller.messageId&&material.sessionId===caller.sessionId&&cached&&cached.expires>this.now())
          return {status:'ready',target:material.target,groupId:group.groupId,links:recipeGroupLinks(this.opts.bot,group.groupId)};
        task={kind:'resourceRead',target:row.active.target,...group};
      }else if(query.kind==='acquire'){
        if(row.active.target.versionId===query.versionId||row.acquired?.versionId===query.versionId)return {status:'acquired'};
        const offer=row.offer;
        if(offer?.status!=='newer'||offer.target.versionId!==query.versionId)throw denied();
        const original=Object.values(row.jobs).find(j=>j.task.kind==='resourceAcquire'&&sameTarget(j.task.target,offer.target));
        if(original){
          if(original.session===p.session&&original.expires>this.now()){
            if(!original.failure){delete original.unknown;return {status:'pending'};}
            if(original.messageId===caller.messageId&&(original.retryAt??Infinity)>this.now())
              return {status:original.failure==='invalid_code'?'needsCode':original.failure};
          }
          // After a failure, a later human message may observe an App redemption. An expired or replaced lease also permits only an exact read.
          probe=original.id;task={kind:'resourcePreview',target:offer.target};
        }else task={kind:'resourceAcquire',target:offer.target,requestId:newAcquisitionKey(this.now())};
      }else if(query.kind==='latest'){
        task={kind:'resourceLatest',target:row.active.target,revision:row.active.revision};
        const finished=Object.values(row.jobs).find(j=>j.task.kind==='resourceLatest'&&j.answerDigest&&j.expires>this.now()&&sameTarget(j.task.target,row.active!.target));
        if(finished&&row.offer)return row.offer;
      }else{
        const claim=Object.values(row.jobs).find(j=>j.task.kind==='resourceAcquire'&&!j.answerDigest&&!j.entitlementVerified);
        if(claim&&!row.acquired)return {status:claim.unknown||claim.session!==p.session||claim.expires<=this.now()?'unknown':'pending'};
        if(group){
          const prepared=row.prepared,material=row.material;
          if(!prepared||prepared.groupId!==group.groupId||prepared.groupIdentity!==group.groupIdentity||prepared.messageId!==caller.messageId||prepared.sessionId!==caller.sessionId)
            return {status:'prepareRequired'};
          const cached=material&&material.groupId===group.groupId&&material.groupIdentity===group.groupIdentity&&material.messageId===caller.messageId&&material.sessionId===caller.sessionId
            ?this.cache.get(cacheKey(row,material,p.session)):undefined;
          if(!cached||cached.expires<=this.now()){
            const pending=Object.values(row.jobs).some(job=>job.task.kind==='resourceRead'&&sameTarget(job.task.target,prepared.target)&&
              job.task.groupId===group.groupId&&job.task.groupIdentity===group.groupIdentity&&!job.answerDigest&&!job.failure&&job.expires>this.now());
            return pending?{status:'pending',groupId:group.groupId}:{status:'prepareRequired'};
          }
          return {status:'ready',target:material!.target,revision:material!.revision,groupId:group.groupId,links:recipeGroupLinks(this.opts.bot,group.groupId),
            page:readResourcePage(cached.docs,query.kind==='index'?{kind:'index',cursor:query.cursor}:{kind:'text',documentId:query.documentId,cursor:query.cursor})};
        }
        const cached=this.cache.get(cacheKey(row,row.active,p.session));
        if(!row.acquired&&cached&&cached.expires>this.now())return {status:'ready',target:row.active.target,revision:row.active.revision,page:readResourcePage(cached.docs,query)};
        task={kind:'resourcePreview',target:row.acquired??row.active.target};
      }
      for(const j of Object.values(row.jobs)){
        if(j.task.kind!==task.kind||!sameTarget(j.task.target,task.target)||j.id===row.initial||j.probe!==probe)continue;
        if(task.kind==='resourceRead'&&!isDeepStrictEqual(task,j.task))continue;
        if(j.failure&&j.expires>this.now()&&(!probe||j.messageId===caller.messageId))return {status:j.probe?'unknown':'unavailable'};
        if(!j.answerDigest&&j.expires>this.now()&&j.origin){
          try{
            this.permitted(p,row,j);
            if(j.task.kind==='resourceRead')preparation={id:j.id,task:j.task};
            return {status:'pending'};
          }catch{delete row.jobs[j.id];}
        }
      }
      for(const [id,j] of Object.entries(row.jobs))if(id!==row.initial&&j.task.kind!=='resourceAcquire'&&(j.answerDigest||j.expires<=this.now()))delete row.jobs[id];
      if(Object.keys(row.jobs).length>=32)return {status:'unavailable'};
      const job=newJob(task,p,this.now());
      if(probe)job.probe=probe;
      if(probe||task.kind==='resourceAcquire')job.messageId=caller.messageId;
      if(task.kind!=='resourceAcquire'){job.origin=true;this.prune();this.origins.set(job.id,{check,expires:job.expires});}
      row.jobs[job.id]=job;
      if(job.task.kind==='resourceRead')preparation={id:job.id,task:job.task};
      return {status:'pending'};
    },()=>{check();if(selected)this.live(selected);});
    check();
    if(selected){
      const p=selected;
      await this.run(p,(db,link)=>{
        check();
        const row=db.resources?.[trigger!.requestId];
        if(!row||!this.owns(p,row,link)||!row.focus)throw denied();
      });
      check();
    }
    if(query.kind==='prepare'&&query.wait&&preparation&&selected){
      const {id,task}=preparation,p=selected,wait=query.wait;
      const deadline=Math.min(wait.notAfter,Date.now()+60_000),elapsed=Symbol('preparation-deadline');
      const guard=()=>{check();this.live(p);if(Date.now()>=deadline)throw elapsed;};
      const observe=async()=>{
        guard();await this.current();guard();await this.checkGroup(p,task);guard();
        const outcome=await this.journal.run(db=>{
          guard();const link=this.link(db,p),row=db.resources?.[trigger!.requestId];
          const prepared=row?.prepared,job=row?.jobs[id];
          if(!row||!this.owns(p,row,link)||!row.focus||row.delivery!=='sent'||row.expires<=this.now()||!row.active||
            !sameTarget(row.acquired??row.active.target,task.target)||!prepared||!sameTarget(prepared.target,task.target)||
            prepared.groupId!==task.groupId||prepared.groupIdentity!==task.groupIdentity||
            prepared.messageId!==caller.messageId||prepared.sessionId!==caller.sessionId)throw denied();
          if(!job||!isDeepStrictEqual(job.task,task)||job.expires<=this.now()||job.failure||job.unknown)return {status:'unavailable'};
          this.permitted(p,row,job);
          const material=row.material,cached=material?this.cache.get(cacheKey(row,material,p.session)):undefined;
          if(job.answerDigest&&material&&sameTarget(material.target,task.target)&&material.groupId===task.groupId&&
            material.groupIdentity===task.groupIdentity&&material.messageId===caller.messageId&&material.sessionId===caller.sessionId&&
            cached&&cached.expires>this.now())return {status:'ready',target:task.target,groupId:task.groupId,links:recipeGroupLinks(this.opts.bot,task.groupId)};
          return {status:'pending'};
        },guard);
        guard();
        if(outcome.status==='ready'){await this.checkGroup(p,task);guard();}
        return outcome;
      };
      while(Date.now()<deadline){
        // The App must be able to poll and answer the original job while this tool is waiting.
        await delay(Math.min(500,deadline-Date.now()),undefined,{signal:wait.signal});
        check();if(Date.now()>=deadline)break;
        const timer=new AbortController();
        try{
          const outcome=await Promise.race([observe(),delay<typeof elapsed>(Math.max(0,deadline-Date.now()),elapsed,{signal:AbortSignal.any([wait.signal,timer.signal])})]);
          if(outcome===elapsed)break;
          if(outcome.status!=='pending')return outcome;
        }catch(error){if(error===elapsed)break;throw error;}
        finally{timer.abort();}
      }
      return {status:'pending',groupId:task.groupId,retryable:true,
        message:'完整配方仍在准备中，并非领取或授权失败。请继续核对同一个群的准备结果，ready 后再读取完整资料；不要要求本人重复领取。'};
    }
    return result;
  }
}
