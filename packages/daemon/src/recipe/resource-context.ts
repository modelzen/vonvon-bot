import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {
  newAcquisitionKey,openResourceSnapshot,readResourcePage,type CreatorAnswer,type CreatorJob,type CreatorReply,
  type ExactResourceVersion,type ResourceAcquireTask,type ResourceDocuments,type ResourceLatest,type ResourcePageQuery,type ResourceReadTask,
} from '@vonvon/protocol';
import type {NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {card,md} from '../card/cards';
import {isAdmin} from '../config/schema';
import {AuthoringIm} from './authoring-im';
import {AuthoringJournal,authoringBotKey,linkKey,recipeSelectionOrder,recordRecipeSelection,sameRecipient,type AuthoringLedger,type Link,type Recipient} from './authoring-journal';
import type {AuthoringOptions,Presence} from './authoring-service';
import {digest} from './authoring-wire';

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
}
export type ResourceCaller={sessionId:string;openId:string;chatId:string;messageId:string};
type Trigger={recipient:Recipient;requestId:string;binding:string;expires:number;sessionId?:string};
export type ResourceQuery=ResourcePageQuery|{kind:'latest'}|{kind:'acquire';versionId:string};
const sameTarget=(a:ExactResourceVersion,b:ExactResourceVersion)=>a.recipeId===b.recipeId&&a.versionId===b.versionId;
function newJob(task:Task,p:Presence,now:number):Job{return {task,id:randomUUID(),expires:now+jobTtl,session:p.session};}
const cacheKey=(row:ResourceHandoff,v:DocumentVersion,session:string)=>JSON.stringify([session,row.account,row.scope,row.binding,v.target,v.hash]);
const wireJob=(p:Presence,j:Job):CreatorJob=>({id:j.id,scope:p.scope,binding:p.binding!,task:j.task});
const handoffText='你刚才在 App 选择的配方已准备好。告诉我想调整哪个群、要用哪些内容、哪些设置需要保留。';
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
        const job=newJob({kind:'resourceRead',target},p,this.now());
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
        if(initial&&initial.expires<=this.now()){
          const retry=newJob({kind:'resourceRead',target},p,this.now());delete row.jobs[row.initial];row.initial=retry.id;row.jobs[retry.id]=retry;
        }
        return false;
      }
      if(!row.active)return false;
      const cached=this.cache.get(cacheKey(row,row.active,p.session));if(cached&&cached.expires>this.now())return true;
      const job=newJob({kind:'resourceRead',target},p,this.now());row.initial=job.id;row.jobs[job.id]=job;
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
    return this.run(p,(db,link)=>this.rows(db).filter(row=>this.owns(p,row,link)).flatMap(row=>Object.values(row.jobs).filter(job=>{
      if(job.answerDigest||job.unknown||job.entitlementVerified)return false;
      try{this.permitted(p,row,job);return true;}catch{return false;}
    }).map(job=>wireJob(p,job))).slice(0,4));
  }
  async check(p:Presence,id:string){
    return this.run(p,(db,link)=>{
      const found=this.find(db,id);if(!found)return;
      const {row,job}=found;
      if(!this.owns(p,row,link)||job.answerDigest||job.unknown||job.entitlementVerified)throw denied();
      this.permitted(p,row,job);
      return {kind:'creatorChecked' as const,job:wireJob(p,job),mode:job.task.kind==='resourceAcquire'?'execute' as const:'read' as const};
    });
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
    if(answer.kind==='resourceSnapshot'){
      if(task.kind!=='resourceRead'||!sameTarget(task.target,answer.snapshot.target))throw denied();
      docs=await openResourceSnapshot(answer.snapshot);
    }
    const changed=await this.run(p,(db,link)=>{
      const row=db.resources?.[found.row.requestId],job=row?.jobs[id];
      if(!row||!job||!this.owns(p,row,link))throw denied();
      this.permitted(p,row,job);
      if(job.answerDigest){
        if(job.answerDigest!==hash)throw denied();
        return;
      }
      if(answer.kind==='resourceSnapshot'&&task.kind==='resourceRead'){
        const v={target:task.target,revision:answer.snapshot.revision,hash:answer.snapshot.contentSha256};
        const claim=job.probe?row.jobs[job.probe]:undefined;
        if(claim){
          if(claim.task.kind!=='resourceAcquire'||!sameTarget(v.target,claim.task.target))throw denied();
          claim.entitlementVerified=true;
        }else if(!job.answerDigest&&row.active&&!sameTarget(v.target,row.acquired??row.active.target))throw denied();
        if(row.active&&sameTarget(row.active.target,v.target)&&!isDeepStrictEqual(row.active,v))throw denied();
        if(!job.answerDigest)row.active=v;
        if(!job.answerDigest&&sameTarget(row.acquired??row.target,v.target))delete row.acquired;
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
    if(docs&&answer.kind==='resourceSnapshot'){
      this.put(cacheKey(changed,{target:answer.snapshot.target,revision:answer.snapshot.revision,hash:answer.snapshot.contentSha256},p.session),docs);
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
      const cardId=row.cardId??await this.im.createJson(card([md(handoffText)],{header:{title:'使用配方'},forward:false}));
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
      if(!trigger||trigger.expires<=this.now()||trigger.sessionId!==caller.sessionId||!isDeepStrictEqual(caller,get())||
        trigger.recipient.chatId!==caller.chatId||trigger.recipient.openId!==caller.openId||!isAdmin(this.opts.cfg,caller.openId))throw denied();
    };
    check();await this.current();check();
    let selected:Presence|undefined;
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
      if(query.kind==='acquire'){
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
          probe=original.id;task={kind:'resourceRead',target:offer.target};
        }else task={kind:'resourceAcquire',target:offer.target,requestId:newAcquisitionKey(this.now())};
      }else if(query.kind==='latest'){
        task={kind:'resourceLatest',target:row.active.target,revision:row.active.revision};
        const finished=Object.values(row.jobs).find(j=>j.task.kind==='resourceLatest'&&j.answerDigest&&j.expires>this.now()&&sameTarget(j.task.target,row.active!.target));
        if(finished&&row.offer)return row.offer;
      }else{
        const claim=Object.values(row.jobs).find(j=>j.task.kind==='resourceAcquire'&&!j.answerDigest&&!j.entitlementVerified);
        if(claim&&!row.acquired)return {status:claim.unknown||claim.session!==p.session||claim.expires<=this.now()?'unknown':'pending'};
        const cached=this.cache.get(cacheKey(row,row.active,p.session));
        if(!row.acquired&&cached&&cached.expires>this.now())return {status:'ready',target:row.active.target,revision:row.active.revision,page:readResourcePage(cached.docs,query)};
        task={kind:'resourceRead',target:row.acquired??row.active.target};
      }
      for(const j of Object.values(row.jobs)){
        if(j.task.kind!==task.kind||!sameTarget(j.task.target,task.target)||j.id===row.initial||j.probe!==probe)continue;
        if(j.failure&&j.expires>this.now()&&(!probe||j.messageId===caller.messageId))return {status:j.probe?'unknown':'unavailable'};
        if(!j.answerDigest&&j.expires>this.now()&&j.origin){
          try{this.permitted(p,row,j);return {status:'pending'};}catch{delete row.jobs[j.id];}
        }
      }
      for(const [id,j] of Object.entries(row.jobs))if(id!==row.initial&&j.task.kind!=='resourceAcquire'&&(j.answerDigest||j.expires<=this.now()))delete row.jobs[id];
      if(Object.keys(row.jobs).length>=32)return {status:'unavailable'};
      const job=newJob(task,p,this.now());
      if(probe)job.probe=probe;
      if(probe||task.kind==='resourceAcquire')job.messageId=caller.messageId;
      if(task.kind!=='resourceAcquire'){job.origin=true;this.prune();this.origins.set(job.id,{check,expires:job.expires});}
      row.jobs[job.id]=job;
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
    return result;
  }
}
