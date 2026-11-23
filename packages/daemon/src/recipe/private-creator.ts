import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {agentIdSchema, creatorCommandSchema, creatorSnapshotSchema, groupIdSchema,
  type CreatorAnswer, type CreatorCommand, type CreatorJob as WireJob, type CreatorRead, type CreatorReply, type CreatorRequest,
  type CreatorSelection, type CreatorSnapshot, type CreatorVersion, type CreatorWork, type InheritedPublication, type RecipeAuthoringRequest} from '@vonvon/protocol';
import {safeEditValue} from '../../../../services/recipe-api/src/draft-model-text.mjs';
import {PRIVATE_RECIPE_CODES_TITLE} from '../bot/card-content';
import {button,card} from '../card/cards';
import {assertBotIdentity,loadBots} from '../config/bots';
import {botPaths} from '../config/paths';
import {isAdmin} from '../config/schema';
import {listProjectsIn} from '../project/registry';
import {AuthoringIm,physicalChat} from './authoring-im';
import {AuthoringJournal,CreatorSelectionChanged,authoringBotKey,linkKey,matchesAuthoringRoute,renewCreatorBinding,sameRecipient,selectCreatorBinding,type AuthoringLedger,type AuthoringRoute,type Link,type Recipient} from './authoring-journal';
import {groupSourceIdentity} from './authoring-source';
import type {AuthoringOptions,AuthoringPeer,Presence} from './authoring-service';
import {digest} from './authoring-payload';
import {operationUuid} from './manifest';
import {CreatorCards,layout,sectionName,type Card,type Option} from './private-creator-cards';

export const creatorClick=z.discriminatedUnion('verb',[
  z.object({a:z.literal('recipe.authoring'),verb:z.literal('creator'),ref:z.string().uuid(),generation:z.number().int().positive(),index:z.number().int().min(0).max(127)}).strict(),
  z.object({a:z.literal('recipe.authoring'),verb:z.literal('creatorAccount'),ref:z.string().uuid()}).strict(),
]);
type Intent='create'|'works';
export function creatorIntent(text:string):Intent|undefined{
  if(/^(?:\/recipe\s+(?:create|start)|(?:从群配置|从这个群|帮我)?(?:创建|创作|制作|分享)(?:一个|一份)?配方)[。！]?$/i.test(text))return 'create';
  if(/^(?:\/recipe(?:\s+(?:list|works|preview|publish|continue))?|我的配方|继续创作|预览发布|发布吧)[。！]?$/i.test(text))return 'works';
}
export interface CreatorWake {id:string;messageId:string;intent:Intent;expiresAt:number;cardRef?:string;jobId?:string}
type Attachment={messageId:string;key:string;type:'image'|'file';sha256:string};
function directImage(msg:NormalizedMessage){
  const raw=z.object({message:z.object({message_type:z.enum(['image','file']),content:z.string().max(8192)})}).safeParse(msg.raw).data?.message;
  const [resource,...others]=msg.resources;
  if(!raw||raw.message_type!==msg.rawContentType||!resource||others.length||resource.type!==raw.message_type||!resource.fileKey)throw denied();
  const content=z.record(z.string(),z.unknown()).safeParse(JSON.parse(raw.content)).data;
  if(content?.[resource.type==='image'?'image_key':'file_key']!==resource.fileKey)throw denied();
  return {type:raw.message_type,key:resource.fileKey};
}
type CreatorJob=Omit<WireJob,'task'>&{task:Extract<WireJob['task'],{kind:'read'|'command'|'deliverCodes'}>};
export type JobRecord={
  job:CreatorJob;state:'offer'|'active'|'unknown'|'finished';created:number;expiresAt:number;messageId?:string;originalCardId?:string;approvalGeneration?:number;
  workName?:string;botName?:string;groupName?:string;version?:VersionSelection;codeLabel?:string;
  preview?:{ref?:string;readId?:string;position?:string};previewOwner?:string;
  previewRequest?:{session:string;cardSession:string;eventId?:string};
  attachment?:Attachment;originWork?:CreatorWork;answerDigest?:string;result?:CreatorAnswer;resultCard?:string;offerRef?:string;sourceChoice?:string;receiptCard?:boolean;
};
type DraftSelection={kind:'draft';snapshot:CreatorSnapshot};
export type VersionSelection={kind:'version';target:CreatorVersion;name:string;version:string};
export interface CreatorLedger {
  versionOrigins?:Record<string,CreatorWork>;observed?:Record<string,number>;sources?:Record<string,CreatorWork['source']>;
  jobs:Record<string,JobRecord>;cards:Record<string,Card>;chosenUntil?:number;seen?:string[];focusDraft?:string;focusUntil?:number;
  current?:DraftSelection|VersionSelection;awaitLogo?:{draftId:string;expiresAt:number};
  accountChoice?:{ref:string;intent:Intent;expiresAt:number} & ({messageId?:never;cardId?:never}|{messageId:string;cardId:string});
}
type Hooks={
  canRefreshPreview(p:Presence,delivery:string):boolean;
  guard(p:Presence,recipient?:Recipient):Promise<Link>;live(p:Presence):void;interact(p:Presence):void;
  begin(p:Presence,link:Link,r:Extract<RecipeAuthoringRequest,{type:'beginHandoff'|'beginDraftHandoff'}>):Promise<unknown>;
  resume(p:Presence,link:Link,id:string,commit:(db:AuthoringLedger,actual:Link)=>void):Promise<unknown>;
  resumeEdit(p:Presence,id:string,commit:(db:AuthoringLedger,actual:Link)=>void):Promise<void>;
  edit(p:Presence,link:Link,work:CreatorWork,revision:number,commit?:(db:AuthoringLedger,actual:Link)=>void):Promise<unknown>;
};
const ttl=30*60_000;
const denied=()=>new Error('本次配方的来源、授权或修订已改变。请从原私聊重新选择。');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const snapshotHash=(s:CreatorSnapshot)=>digest(JSON.stringify(creatorSnapshotSchema.parse(s)));
const state=(l:Link):CreatorLedger=>l.creator??={jobs:{},cards:{}};
const workOf=(c:CreatorCommand)=>c.kind==='publish'?c.snapshot.work:'work'in c?c.work:undefined;
const pendingPublication=(r:JobRecord)=>r.state==='active'||r.state==='unknown';
const publicationAt=(r:JobRecord,work:CreatorWork,revision:number)=>r.job.task.kind==='command'&&r.job.task.command.kind==='publish'&&
  same(r.job.task.command.snapshot.work,work)&&r.job.task.command.snapshot.revision===revision;
const versionOf=(c:CreatorCommand)=>'target'in c?c.target:undefined;
const viewVersion=(target:CreatorVersion,name:string,version:string):VersionSelection=>({kind:'version',target,name,version});
function invalidate(s:CreatorLedger,draftId:string){
  for(const row of Object.values(s.jobs)){
    const task=row.job.task;
    if(task.kind==='command'&&workOf(task.command)?.draftId===draftId){
      if(row.state==='active'||row.state==='unknown')throw denied();
      if(row.state==='offer')delete s.jobs[row.job.id];
    }
    if(task.kind==='read'&&'work' in task.read&&task.read.work.draftId===draftId&&(row.state==='active'||task.read.kind==='page'))delete s.jobs[row.job.id];
  }
  for(const c of Object.values(s.cards))if(c.workId===draftId)delete s.cards[c.ref];
  if(s.current?.kind==='draft'&&s.current.snapshot.work.draftId===draftId)delete s.current;
  if(s.awaitLogo?.draftId===draftId)delete s.awaitLogo;
}
export function invalidateWorkOffer(db:AuthoringLedger,p:Pick<Presence,'scope'|'account'>,link:Link,draftId:string){
  const s=db.links[linkKey(p.scope,p.account)];
  if(s?.binding!==link.binding)throw denied();
  if(s.creator)invalidate(s.creator,draftId);
}
export class PrivateCreator{
  enabled=false;
  private readonly cards:CreatorCards;
  private readonly botKey:string;
  private pollOffset=0;
  constructor(private readonly opts:AuthoringOptions,private readonly ledger:AuthoringJournal,private readonly im:AuthoringIm,private readonly now:()=>number,private readonly hooks:Hooks){
    this.botKey=authoringBotKey(opts.bot);
    this.cards=new CreatorCards(now);
  }
  async discover(peer:AuthoringPeer,account:string):Promise<Extract<CreatorReply,{kind:'creatorBinding'}>>{
    await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));
    const b=this.opts.bot,scope=digest(JSON.stringify([peer.device,b.appId,b.tenant,b.createdAt,b.registrationId??null]));
    return this.ledger.run(db=>{
      const l=db.links[linkKey(scope,account)];
      if(!l||l.bot!==this.botKey||!isAdmin(this.opts.cfg,l.recipient.openId))return {kind:'creatorBinding',association:null,wakeId:null};
      return {kind:'creatorBinding',association:{binding:l.binding,scope,recipient:{...l.recipient,chatId:groupIdSchema.parse(l.recipient.chatId)}},wakeId:l.wake&&l.wake.expiresAt>this.now()?l.wake.id:null};
    });
  }
  private run<T>(p:Presence,link:Link,fn:(s:CreatorLedger,actual:Link,db:AuthoringLedger)=>T){
    return this.ledger.run(db=>{
      this.hooks.live(p);
      const actual=db.links[linkKey(p.scope,p.account)];
      if(!actual||actual.bot!==this.botKey||actual.binding!==p.binding||actual.binding!==link.binding||!sameRecipient(actual.recipient,link.recipient)||!isAdmin(this.opts.cfg,link.recipient.openId))throw denied();
      return fn(state(actual),actual,db);
    });
  }
  private wakeRoute(db:AuthoringLedger,link:Link):AuthoringRoute|undefined{
    const key=Object.keys(db.links).find(key=>db.links[key]===link);
    if(!key)return;
    const chosenUntil=link.creator?.chosenUntil;
    const route:AuthoringRoute=chosenUntil!==undefined&&chosenUntil>this.now()?
      {key,binding:link.binding,kind:'chosen',chosenUntil}:{key,binding:link.binding,kind:'intent'};
    if(matchesAuthoringRoute(db,link,route,this.now()))return route;
  }
  private currentWake(db:AuthoringLedger,link:Link,wake:{id:string;route:AuthoringRoute}){
    const current=link.wake;
    if(current?.id!==wake.id||current.expiresAt<=this.now()||!matchesAuthoringRoute(db,link,wake.route,this.now()))throw new CreatorSelectionChanged();
    return current;
  }
  async open(p:Presence,binding:string,wakeId:string|null){
    const link=await this.hooks.guard(p);
    if(binding!==p.binding||binding!==link.binding)throw denied();
    const wake=await this.run(p,link,(_s,l,db)=>{
      if(!wakeId)return;
      const route=this.wakeRoute(db,l);
      if(!route)throw new CreatorSelectionChanged();
      const current=this.currentWake(db,l,{id:wakeId,route});
      return {id:wakeId,route,intent:current.intent};
    });
    this.enabled=true;
    if(wake){
      this.hooks.interact(p);
      if(wake.intent==='create')await this.groups(p,link,0,undefined,wake);
      else await this.run(p,link,(s,l,db)=>{
        const current=this.currentWake(db,l,wake);
        current.jobId??=this.addJob(p,link,s,{kind:'read',read:{kind:'works',offset:0}}).job.id;
      });
      await this.run(p,link,(s,l,db)=>{
        const current=this.currentWake(db,l,wake);
        s.seen=[...(s.seen??[]).slice(-63),current.messageId];delete l.wake;
      });
    }
  }
  private async source(p:Presence,work?:CreatorWork){
    if(work){
      await this.ledger.run(db=>{
        const l=db.links[linkKey(p.scope,p.account)],known=l?.creator?.sources?.[work.draftId];
        if(!l||l.binding!==p.binding||known!==undefined&&!same(known,work.source))throw denied();
        const op=work.source&&db.operations[work.source.preparationId];
        if(op&&(op.accountId!==p.account||op.scope!==p.scope||op.binding!==l.binding||op.revoked||
          op.view.purpose!=='prepareDraft'||op.view.groupId!==work.source!.groupId||op.sourceIdentity!==work.source!.identity||
          op.view.receipt?.status!=='accepted'||op.view.receipt.draftId!==work.draftId))throw denied();
      });
    }
    if(work?.source){
      const original=work.source;
      if(await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,original.groupId)!==original.identity)throw denied();
      this.hooks.live(p);
    }
  }
  private addJob(p:Presence,link:Link,s:CreatorLedger,task:CreatorJob['task'],status:JobRecord['state']='active',originWork?:CreatorWork){
    if(Object.values(s.jobs).filter(r=>r.state!=='finished').length>=64)throw new Error('进行中的配方操作已满。');
    const id=operationUuid(this.now());
    const target=task.kind==='read'&&'target'in task.read?task.read.target:task.kind==='command'?versionOf(task.command):task.kind==='deliverCodes'?task.target:undefined;
    const row:JobRecord={job:{id,binding:link.binding,scope:p.scope,task},state:status,created:this.now(),expiresAt:this.now()+ttl,originWork:originWork??(target&&s.versionOrigins?.[target.versionId])};
    s.jobs[id]=row;return row;
  }
  private read(p:Presence,link:Link,read:CreatorRead,version?:VersionSelection){
    return this.run(p,link,s=>{
      if('work'in read&&read.kind==='draft'){
        if(Object.values(s.jobs).some(r=>r.job.task.kind==='command'&&workOf(r.job.task.command)?.draftId===read.work.draftId&&['active','unknown'].includes(r.state)))throw denied();
      }
      const job=this.addJob(p,link,s,{kind:'read',read},'active','work'in read?read.work:undefined);
      if(version&&'target'in read&&same(version.target,read.target))job.version=version;
      return job.job.id;
    });
  }
  private livePreview(s:CreatorLedger,session:string,owner:JobRecord|undefined){
    const offer=owner?.offerRef&&s.cards[owner.offerRef];
    return Boolean(owner&&offer&&offer.session===session&&offer.expiresAt>this.now()&&(owner.state==='unknown'||owner.state==='offer'&&owner.expiresAt>this.now()));
  }
  private previewOwner(s:CreatorLedger,session:string,card:Card){
    const actual=s.cards[card.ref];
    if(!actual||actual.generation!==card.generation||actual.session!==session||actual.expiresAt<=this.now()||
      actual.needsUpdate||actual.cardId!==card.cardId||actual.messageId!==card.messageId)return;
    const owner=card.previewOwner?s.jobs[card.previewOwner]:Object.values(s.jobs).find(r=>r.offerRef===card.ref);
    if(!owner||!this.livePreview(s,session,owner))return;
    if(card.previewOwner&&(owner.preview?.ref!==card.ref||card.previewApproval!==owner.offerRef))return;
    return owner;
  }
  private appPreviewOwner(s:CreatorLedger,card:Card,read:Extract<CreatorRead,{kind:'openPreview'}>){
    const owner=this.previewOwner(s,card.session,card),task=owner?.job.task;
    if(!owner||owner.offerRef!==card.ref||task?.kind!=='command'||task.command.kind!=='publish'||
      task.command.snapshotDigest!==read.snapshotDigest||snapshotHash(task.command.snapshot)!==read.snapshotDigest||
      !same(task.command.snapshot.work,read.work))throw denied();
    return owner;
  }
  private refreshPreview(s:CreatorLedger,owner:JobRecord|undefined,original:Card){
    const c=owner?.offerRef?s.cards[owner.offerRef]:undefined;
    if(!owner||owner.state!=='offer'||owner.expiresAt<=this.now()||owner.job.task.kind!=='command'||owner.job.task.command.kind!=='publish'||
      !c||c.ref!==original.ref||c.generation!==original.generation||c.session!==original.session||c.expiresAt<=this.now()||c.needsUpdate||
      !c.cardId||!c.messageId||c.cardId!==original.cardId||c.messageId!==original.messageId)return;
    c.generation++;c.needsUpdate=true;c.previewRefresh={owner:owner.job.id,cardId:c.cardId,messageId:c.messageId};
    return c;
  }
  private pendingPreviewRefresh(s:CreatorLedger,c:Card){
    const refresh=c.previewRefresh,owner=refresh&&s.jobs[refresh.owner];
    return Boolean(refresh&&c.needsUpdate&&c.cardId===refresh.cardId&&c.messageId===refresh.messageId&&c.expiresAt>this.now()&&
      owner?.state==='offer'&&owner.expiresAt>this.now()&&owner.offerRef===c.ref&&owner.job.task.kind==='command'&&owner.job.task.command.kind==='publish');
  }
  private acknowledgeVisibleRefresh(s:CreatorLedger,clicked:Card){
    const c=s.cards[clicked.ref];
    if(!c||c.generation!==clicked.generation||c.cardId!==clicked.cardId||c.messageId!==clicked.messageId||c.session!==clicked.session)return false;
    if(!c.needsUpdate)return true;
    if(!this.pendingPreviewRefresh(s,c))return false;
    delete c.needsUpdate;
    delete c.previewRefresh;
    return true;
  }
  private async openPreview(p:Presence,link:Link,card:Card,read:Extract<CreatorRead,{kind:'openPreview'}>,eventId:string|undefined){
    await this.source(p,read.work);
    await this.run(p,link,(s,_l,db)=>{
      if(!p.nativePreview)throw denied();
      const owner=this.appPreviewOwner(s,card,read);
      this.noPendingSave(db,p,link,read.work);
      const prior=Object.values(s.jobs).filter(row=>row.previewRequest&&row.previewOwner===owner.job.id&&
        row.originalCardId===card.cardId&&row.approvalGeneration===card.generation);
      if(prior.some(row=>eventId?row.previewRequest?.eventId===eventId:row.previewRequest?.session===p.session&&row.state==='active'))return;
      for(const old of prior)if(old.state==='active'&&old.previewRequest&&this.hooks.canRefreshPreview(p,old.previewRequest.session))delete s.jobs[old.job.id];
      const row=this.addJob(p,link,s,{kind:'read',read},'active',read.work);
      row.previewRequest={session:p.session,cardSession:card.session,eventId};
      row.previewOwner=owner.job.id;row.originalCardId=card.cardId;row.messageId=card.messageId;
      row.approvalGeneration=card.generation;
    });
  }
  private async preview(p:Presence,link:Link,clicked:Card,choice:Extract<Option['choice'],{kind:'detailPage'}>|Extract<CreatorRead,{kind:'page'}>){
    const start=await this.run(p,link,s=>{
      const owner=this.previewOwner(s,p.session,clicked);
      if(owner)return {work:owner.originWork,navigation:clicked.ref===owner.offerRef&&owner.preview?.ref?s.cards[owner.preview.ref]:undefined};
    });
    if(!start)return;
    await this.source(p,start.work);
    const nav=start.navigation;
    const missing=nav?.messageId&&nav.cardId&&await this.im.cardStatus(nav.messageId,link.recipient.chatId,nav.cardId)==='unavailable';
    const card=await this.run(p,link,s=>{
      const row=this.previewOwner(s,p.session,clicked),task=row?.job.task;
      if(!row||task?.kind!=='command')return;
      const cmd=task.command,preview=row.preview??={};
      const nav=preview.ref&&s.cards[preview.ref];
      if(nav&&(nav.needsUpdate||!nav.messageId))return;
      const position=choice.kind==='page'?choice.section+'/'+choice.page:'detail/'+choice.page;
      if(preview.position===position&&!missing)return;
      const prior=preview.readId&&s.jobs[preview.readId];
      if(prior){
        // A new section from the approval card may supersede an outstanding read.
        if(prior.state==='active'&&clicked.ref!==row.offerRef)return;
        delete s.jobs[prior.job.id];
      }
      delete preview.readId;
      if(choice.kind==='page'){
        if(cmd.kind!=='publish'||cmd.snapshotDigest!==choice.snapshotDigest||!same(cmd.snapshot.work,choice.work)||
          !cmd.snapshot.sections[choice.section]?.pageHashes[choice.page])throw denied();
        const job=this.addJob(p,link,s,{kind:'read',read:choice},'active',choice.work);
        job.previewOwner=row.job.id;job.originalCardId=clicked.cardId;job.messageId=clicked.messageId;
        preview.readId=job.job.id;preview.position=position;
        return;
      }
      if(row.job.id!==choice.id||(cmd.kind!=='metadata'&&cmd.kind!=='publish'))throw denied();
      const publish=cmd.kind==='publish',chars=[...(publish?cmd.snapshot.public.overview:cmd.change.value)],start=choice.page*1500;
      if(start>=chars.length)throw denied();
      const options:Option[]=[];
      if(start)options.push({label:'上一页',choice:{...choice,page:choice.page-1}});
      if(start+1500<chars.length)options.push({label:'下一页',choice:{...choice,page:choice.page+1}});
      preview.position=position;
      return this.cards.previewCard(s,p,row,(publish?'公开概览':'本次修改')+' · 第 '+(choice.page+1)+'/'+Math.ceil(chars.length/1500)+' 页',
        chars.slice(start,start+1500).join(''),options,workOf(cmd)!.draftId);
    });
    if(card)await this.display(p,link,card);
  }
  private async redeliver(p:Presence,link:Link,card:Card){
    if(card.previewOwner){
      const work=await this.run(p,link,s=>{
        const owner=s.jobs[card.previewOwner!];
        if(this.livePreview(s,p.session,owner)&&owner?.preview?.ref===card.ref&&s.cards[card.ref]?.generation===card.generation)return owner.originWork;
      });
      if(!work)return;
      await this.source(p,work);
    }
    await this.display(p,link,card);
  }
  private async display(p:Presence,link:Link,c:Card,wake?:{id:string;route:AuthoringRoute}){
    await this.hooks.guard(p,link.recipient);
    if(c.previewRefresh&&!await this.run(p,link,s=>{
      const current=s.cards[c.ref];
      return current&&current.generation===c.generation&&this.pendingPreviewRefresh(s,current);
    }))return;
    if(wake)await this.run(p,link,(_s,l,db)=>this.currentWake(db,l,wake));
    if(c.needsUpdate&&c.messageId&&c.cardId){
      const attached=c.previewOwner||c.previewRefresh?await this.im.cardStatus(c.messageId,link.recipient.chatId,c.cardId):'matched';
      const result=attached==='matched'?await this.im.updateJson(c.cardId,c.generation,c.ref,layout(c)):attached;
      const applied=result==='updated'||result==='conflict'&&await this.im.showsJson(c.messageId,link.recipient.chatId,layout(c)).catch(()=>false);
      if(c.previewRefresh&&!applied)throw new Error('卡片等待更新，请稍后再试。');
      if(!applied&&result!=='unavailable')throw new Error('卡片等待更新，请稍后再试。');
      c=await this.run(p,link,s=>{
        const r=s.cards[c.ref];
        if(!r||r.generation!==c.generation||r.cardId!==c.cardId)throw denied();
        delete r.needsUpdate;
        delete r.previewRefresh;
        if(!applied){delete r.cardId;delete r.messageId;r.sendId=randomUUID();}
        return r;
      });
    }
    if(!c.cardId){
      const id=await this.im.createJson(layout(c));
      c=await this.run(p,link,(s,l,db)=>{if(wake)this.currentWake(db,l,wake);const r=s.cards[c.ref];if(!r||r.generation!==c.generation||r.expiresAt<=this.now())throw denied();r.cardId??=id;return r;});
    }
    if(!c.messageId){
      await this.hooks.guard(p,link.recipient);
      if(wake)await this.run(p,link,(_s,l,db)=>this.currentWake(db,l,wake));
      const id=await this.im.send(link.recipient.chatId,c.cardId!,c.sendId);
      c=await this.run(p,link,s=>{const r=s.cards[c.ref];if(!r||r.generation!==c.generation||r.cardId!==c.cardId)throw denied();r.messageId=id;return r;});
    }
  }
  async chooseAccount(links:{key:string;binding:string}[],recipient:Recipient,messageId:string,intent:Intent){
    if(!physicalChat(recipient.chatId)||!isAdmin(this.opts.cfg,recipient.openId))return;
    const choices=await this.ledger.run(db=>{
      const own=Object.values(db.links).filter(l=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient));
      if(!isAdmin(this.opts.cfg,recipient.openId)||own.filter(l=>(l.creator?.chosenUntil??0)>this.now()).length===1)return [];
      return links.slice(0,32).flatMap(choice=>{
        const l=db.links[choice.key];
        if(!l||!own.includes(l)||l.binding!==choice.binding)return [];
        const ref=randomUUID();state(l).accountChoice={ref,intent,expiresAt:this.now()+300_000};
        return [{...choice,ref}];
      });
    });
    if(!choices.length)return;
    const cardId=await this.im.createJson(card(choices.map((l,i)=>button('关联 '+(i+1)+' · '+l.binding.slice(-8),{a:'recipe.authoring',verb:'creatorAccount',ref:l.ref})),{header:{title:'选择本人账号关联'},forward:false}));
    await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));
    if(!isAdmin(this.opts.cfg,recipient.openId))return;
    const sent=await this.im.send(recipient.chatId,cardId,randomUUID());
    await this.ledger.run(db=>{
      if(!isAdmin(this.opts.cfg,recipient.openId))return;
      for(const choice of choices){
        const l=db.links[choice.key],reserved=l?.creator?.accountChoice;
        if(l?.bot===this.botKey&&l.binding===choice.binding&&sameRecipient(l.recipient,recipient)&&reserved?.ref===choice.ref&&reserved.expiresAt>this.now()){
          l.creator!.accountChoice={...reserved,cardId,messageId:sent};
        }
      }
    });
  }
  async accountAction(evt:CardActionEvent,recipient:Recipient){
    if(!physicalChat(evt.chatId)||!isAdmin(this.opts.cfg,recipient.openId))return;
    const click=creatorClick.safeParse(evt.action?.value).data;
    if(click?.verb!=='creatorAccount')return;
    const ref=click.ref;
    const bound=await this.ledger.run(db=>Object.values(db.links).find(l=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient)&&l.creator?.accountChoice?.ref===ref));
    const choice=bound?.creator?.accountChoice;
    if(!bound||!choice?.cardId||choice.messageId!==evt.messageId||choice.expiresAt<=this.now()||!await this.im.matches(evt.messageId,evt.chatId,choice.cardId))return;
    await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));
    await this.ledger.run(db=>{
      if(!isAdmin(this.opts.cfg,recipient.openId))return;
      const matches=Object.values(db.links).filter(l=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient)&&
        l.creator?.accountChoice?.ref===ref&&l.creator.accountChoice.messageId===evt.messageId&&l.creator.accountChoice.cardId===choice.cardId&&l.creator.accountChoice.expiresAt>this.now());
      if(matches.length!==1||matches[0]!.binding!==bound.binding)return;
      const actual=matches[0]!;
      selectCreatorBinding(db,actual,this.now());
      actual.wake={id:randomUUID(),messageId:evt.messageId,intent:choice.intent,expiresAt:this.now()+300_000};
    });
  }
  private async groups(p:Presence,link:Link,offset:number,inherited?:InheritedPublication,wake?:{id:string;route:AuthoringRoute}){
    if(wake){
      const existing=await this.run(p,link,(s,l,db)=>{
        const current=this.currentWake(db,l,wake);
        const c=current.cardRef&&s.cards[current.cardRef];
        if(c&&c.session===p.session)return c;
      });
      if(existing){await this.display(p,link,existing,wake);return;}
    }
    if(offset===0)await this.run(p,link,(s,l,db)=>{
      if(wake)this.currentWake(db,l,wake);
      const prev=s.current;
      if(prev?.kind==='draft'){
        const offered=Object.values(s.jobs).some(r=>r.state==='offer'&&r.job.task.kind==='command'&&workOf(r.job.task.command)?.draftId===prev.snapshot.work.draftId);
        if(offered)invalidate(s,prev.snapshot.work.draftId);
      }
    });
    await this.hooks.guard(p,link.recipient);
    const rows=(await listProjectsIn(botPaths(this.opts.bot.appId).projectsFile)).filter(r=>!r.dm&&physicalChat(r.chatId)&&
      !(r.recipeInstall?.access==='coded'&&r.recipeInstall.authorId!==p.account)).sort((a,b)=>a.chatId.localeCompare(b.chatId));
    const buttons:Option[]=[];
    for(const r of rows.slice(offset,offset+8)){
      const identity=await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,r.chatId).catch(()=>undefined);
      if(identity)buttons.push({label:r.name+' · '+r.chatId.slice(-8),choice:{kind:'group',group:{groupId:r.chatId,name:r.name,identity},inherited}});
    }
    if(offset>0)buttons.push({label:'上一页',choice:{kind:'groups',offset:offset-8,inherited}});
    if(rows.length>offset+8)buttons.push({label:'下一页',choice:{kind:'groups',offset:offset+8,inherited}});
    const view=await this.run(p,link,(s,l,db)=>{
      const current=wake&&this.currentWake(db,l,wake);
      const c=this.cards.newCard(s,p,'选择来源群',buttons.length?'请选择本次要取用配置的群。':'没有可用的已绑定群。',buttons);
      if(current)current.cardRef=c.ref;
      return c;
    });
    await this.display(p,link,view,wake);
  }
  private async intent(p:Presence,link:Link,intent:Intent){
    if(intent==='create')return this.groups(p,link,0);
    await this.read(p,link,{kind:'works',offset:0});
  }
  private async attachment(messageId:string,key:string,type:'image'|'file'){
    const res=await this.opts.channel.rawClient.im.v1.messageResource.get({path:{message_id:messageId,file_key:key},params:{type}});
    const stream=res.getReadableStream(),chunks:Buffer[]=[];let size=0;
    try{for await(const bytes of stream){
      const b=Buffer.from(bytes);size+=b.length;
      if(size>2*1024*1024)throw denied();
      chunks.push(b);
    }}finally{stream.destroy();}
    if(!size)throw denied();return Buffer.concat(chunks);
  }
  private async offer(p:Presence,link:Link,command:CreatorCommand,{attachment,sourceChoice,selection,codeLabel,route,quote}:{quote?:Card;attachment?:Attachment;sourceChoice?:string;selection?:VersionSelection;codeLabel?:string;route?:AuthoringRoute}={}){
    creatorCommandSchema.parse(command);
    if(command.kind==='metadata'&&!safeEditValue(command.change))throw denied();
    await this.source(p,workOf(command));
    const c=await this.run(p,link,(s,actual,db)=>{
      if(route&&!matchesAuthoringRoute(db,actual,route,this.now()))throw new CreatorSelectionChanged();
      if(quote)this.currentCard(s,p,quote);
      const work=workOf(command),version=versionOf(command);
      const current=s.current;
      const draft=work&&'revision'in command?Object.values(s.jobs).flatMap(row=>{
        const task=row.job.task;
        return row.state==='offer'&&task.kind==='command'&&task.command.kind==='publish'?[task.command.snapshot]:[];
      }).find(snap=>same(snap.work,work)&&snap.revision===command.revision&&
        (command.kind!=='metadata'||snap.contentSha256===command.baseSha256))?.public:undefined;
      const selected=selection??(current?.kind==='version'?current:undefined);
      if(work)invalidate(s,work.draftId);
      if(version&&Object.values(s.jobs).some(r=>r.job.task.kind==='command'&&same(versionOf(r.job.task.command),version)&&
        ['active','unknown'].includes(r.state)))throw denied();
      const task:Extract<CreatorJob['task'],{kind:'command'}>={kind:'command',command,expiresAt:this.now()+ttl,approval:'0'.repeat(64)};
      const row=this.addJob(p,link,s,task,'offer',work);
      row.attachment=attachment;row.sourceChoice=sourceChoice;row.codeLabel=codeLabel;
      if(draft)row.workName=draft.name+' · '+draft.version;
      if(selected&&same(selected.target,version))row.version=selected;
      if(route)renewCreatorBinding(db,actual,this.now());
      return this.cards.approvalCard(p,s,row,false);
    });
    await this.display(p,link,c);
  }
  private selectionState(db:AuthoringLedger,actual:Link){
    return JSON.stringify({
      chosen:Object.entries(db.links).filter(([,l])=>l.bot===this.botKey&&sameRecipient(l.recipient,actual.recipient)).map(([key,l])=>[key,l.binding,l.selectionOrder,l.creator?.chosenUntil,l.wake?.id]),
      focus:[actual.creator?.focusDraft,actual.creator?.focusUntil,actual.creator?.current],
    });
  }
  private async selected(p:Presence,link:Link,selection:CreatorSelection,clicked?:{card:Card;index:number;selectionState:string},select=true){
    const commit=(s:CreatorLedger,actual:Link,db:AuthoringLedger)=>{
      if(clicked){
        if(clicked.selectionState!==this.selectionState(db,actual))throw new CreatorSelectionChanged();
        this.consumeChoice(s,p,clicked.card,clicked.index);
      }
      if(select)selectCreatorBinding(db,actual,this.now());
    };
    if(selection.kind==='draft'){
      const beforeSource=clicked?.selectionState??await this.run(p,link,(_s,actual,db)=>this.selectionState(db,actual));
      await this.source(p,selection.work);
      const edits=(db:AuthoringLedger)=>Object.values(db.operations).filter(o=>o.bot===this.botKey&&o.accountId===p.account&&o.scope===p.scope&&o.binding===link.binding&&
        sameRecipient(o.recipient,link.recipient)&&o.terminalAt===undefined&&o.view.purpose==='editDraft'&&o.view.draftId===selection.work.draftId);
      const editing=await this.run(p,link,(s,actual,db)=>{
        if(beforeSource!==this.selectionState(db,actual))throw new CreatorSelectionChanged();
        const rows=edits(db);
        if(rows.length){
          const row=rows[0]!,source=selection.work.source;
          if(rows.length!==1||row.revoked||!['waiting','candidate'].includes(row.view.state)||!row.dispatched||row.view.deliveryUnknown||
            !row.carrier.messageId||!row.carrier.cardId||row.rich?.destinationDraftId&&row.rich.destinationDraftId!==selection.work.draftId||
            source&&row.originalGroup&&(source.groupId!==row.originalGroup.groupId||source.identity!==row.originalGroup.identity))throw denied();
          if(!select&&(!row.contextOpen||(row.contextUntil??0)<=this.now()))throw denied();
        }else this.noPendingSave(db,p,link,selection.work);
        commit(s,actual,db);delete s.current;s.focusDraft=selection.work.draftId;s.focusUntil=this.now()+ttl;
        if(rows.length)return {id:rows[0]!.view.operationId,focusUntil:s.focusUntil,selectionState:this.selectionState(db,actual),
          route:{key:linkKey(p.scope,p.account),binding:link.binding,kind:'chosen' as const,chosenUntil:s.chosenUntil!}};
      });
      if(editing){
        if(select)await this.hooks.resumeEdit(p,editing.id,(db,actual)=>{
          const s=state(actual),rows=edits(db),known=s.sources?.[selection.work.draftId];
          if(this.selectionState(db,actual)!==editing.selectionState||!matchesAuthoringRoute(db,actual,editing.route,this.now())||s.focusDraft!==selection.work.draftId||s.focusUntil!==editing.focusUntil||
            s.current||rows.length!==1||rows[0]!.view.operationId!==editing.id||known!==undefined&&!same(known,selection.work.source))throw new CreatorSelectionChanged();
          if(selection.work.source)(s.sources??={})[selection.work.draftId]=selection.work.source;
        });
        return;
      }
      if(await this.retryCard(p,link,selection.work.draftId))return;
      await this.read(p,link,{kind:'draft',work:selection.work});
    }else{
      const c=await this.run(p,link,(s,actual,db)=>{
        commit(s,actual,db);
        s.current=viewVersion(selection.target,selection.name,selection.version);delete s.focusDraft;s.focusUntil=this.now()+ttl;
        return this.cards.versionCard(s,p,s.current);
      });
      await this.display(p,link,c);
    }
  }
  private currentCard(s:CreatorLedger,p:Presence,original:Card){
    const actual=s.cards[original.ref];
    if(!actual||actual.generation!==original.generation||actual.session!==p.session||actual.expiresAt<=this.now()||actual.needsUpdate||
      actual.messageId!==original.messageId||actual.cardId!==original.cardId)throw denied();
    return actual;
  }
  private consumeChoice(s:CreatorLedger,p:Presence,original:Card,index:number){
    const actual=this.currentCard(s,p,original);
    if(!same(actual.options[index],original.options[index]))throw denied();
    delete s.cards[original.ref];
  }
  private async retryCard(p:Presence,link:Link,draftId?:string,versionId?:string){
    const c=await this.run(p,link,s=>{
      const rows=Object.values(s.jobs).filter(r=>r.state==='unknown'&&r.job.task.kind==='command'&&(!draftId||workOf(r.job.task.command)?.draftId===draftId)&&(!versionId||versionOf(r.job.task.command)?.versionId===versionId));
      if(rows.length===1)return this.cards.approvalCard(p,s,rows[0]!,true);
    });
    if(c){await this.display(p,link,c);return true;}
    return false;
  }
  async message(p:Presence,recipient:Recipient,msg:NormalizedMessage,route?:AuthoringRoute){
    if(!this.enabled)return false;
    const link=await this.hooks.guard(p,recipient);
    const text=msg.content.trim(),intent=creatorIntent(text);
    const selection=await this.run(p,link,(s,_l,db)=>{
      const quoted=msg.replyToMessageId;
      const op=quoted&&Object.values(db.operations).find(o=>o.accountId===p.account&&o.scope===p.scope&&o.binding===link.binding&&o.carrier.messageId===quoted);
      const activeCard=quoted&&Object.values(s.cards).find(c=>c.messageId===quoted&&c.session===p.session&&c.expiresAt>this.now());
      const quotedOffer=activeCard&&Object.values(s.jobs).find(j=>j.offerRef===activeCard.ref&&j.state==='offer');
      const cmd=quotedOffer&&quotedOffer.job.task.kind==='command'?quotedOffer.job.task.command:undefined;
      const selected=quoted?(cmd?.kind==='publish'?{kind:'draft' as const,snapshot:cmd.snapshot}:undefined):s.focusUntil&&s.focusUntil>this.now()?s.current:undefined;
      const matching=selected?.kind==='draft'&&Object.values(db.operations).some(o=>o.accountId===p.account&&o.scope===p.scope&&o.binding===link.binding&&o.contextOpen&&
        (o.contextUntil??0)>this.now()&&(o.view.draftId===selected.snapshot.work.draftId||o.view.receipt?.status==='accepted'&&o.view.receipt.draftId===selected.snapshot.work.draftId));
      const focusedOperation=!selected&&s.focusDraft&&Object.values(db.operations).some(o=>o.bot===this.botKey&&o.accountId===p.account&&o.scope===p.scope&&o.binding===link.binding&&sameRecipient(o.recipient,recipient)&&
        !o.revoked&&o.contextOpen&&(o.contextUntil??0)>this.now()&&(o.view.draftId===s.focusDraft||o.view.receipt?.status==='accepted'&&o.view.receipt.draftId===s.focusDraft));
      const openOperations=Object.values(db.operations).filter(o=>o.bot===this.botKey&&o.accountId===p.account&&o.scope===p.scope&&o.binding===link.binding&&sameRecipient(o.recipient,recipient)&&
        o.contextOpen&&(o.contextUntil??0)>this.now()&&o.terminalAt===undefined);
      const commandOperation=!quoted&&!selected&&openOperations.length===1?openOperations[0]:undefined;
      const operationDraft=commandOperation?.view.draftId??commandOperation?.rich?.destinationDraftId;
      const editableFocus=commandOperation&&(!s.focusDraft||s.focusDraft===operationDraft)&&!commandOperation.revoked&&(commandOperation.view.purpose==='prepareDraft'||commandOperation.view.purpose==='editDraft')&&
        ['waiting','candidate'].includes(commandOperation.view.state);
      return {selected,quote:activeCard||undefined,logo:s.awaitLogo,duplicate:s.seen?.includes(msg.messageId),originalOp:Boolean(op),matching:matching||focusedOperation,editableFocus:Boolean(editableFocus),foreignQuote:Boolean(quoted&&!op&&!activeCard),active:Boolean(s.focusUntil&&s.focusUntil>this.now())};
    });
    if(selection.duplicate)return true;
    const {quote}=selection;
    if(quote){
      if(!quote.cardId||!await this.im.matches(msg.replyToMessageId!,recipient.chatId,quote.cardId)){
        await this.im.reply(recipient.chatId,msg.messageId,'请选择原作品的当前卡片。');return true;
      }
      await this.run(p,link,s=>this.currentCard(s,p,quote));
    }
    const current=selection.selected;
    const photo=selection.logo&&selection.logo.expiresAt>this.now()&&['file','image'].includes(msg.rawContentType);
    const change=/^\/recipe\s+(name|summary|overview|version|access|logo)(?:\s+([\s\S]*))?$/i.exec(text);
    const issue=/^(?:\/recipe\s+issue\s+|(?:给这个版本)?生成)(\d+)(?:枚分享码)?$/i.exec(text);
    const retry=/^\/recipe\s+retry$/i.test(text);
    if(msg.replyToMessageId&&selection.foreignQuote&&selection.active){await this.im.reply(recipient.chatId,msg.messageId,'请选择原作品的当前卡片。');return true;}
    if(selection.originalOp&&!intent)return false;
    if(!current&&selection.editableFocus&&change&&/^(name|summary|overview|version)$/i.test(change[1]!))return false;
    if(!intent&&!photo&&!change&&!issue&&!retry){
      if(!selection.active)return false;
      if(selection.matching||selection.editableFocus)return false;
      if(current?.kind==='draft'&&msg.rawContentType==='text'){
        const {work,revision}=current.snapshot;
        await this.run(p,link,(s,actual,db)=>{
          if(route&&!matchesAuthoringRoute(db,actual,route,this.now()))throw new CreatorSelectionChanged();
          if(quote)this.currentCard(s,p,quote);
          invalidate(s,work.draftId);
        });
        if(current.snapshot.format==='role-v1')await this.hooks.edit(p,link,work,revision);
        else await this.read(p,link,{kind:'edit',work,revision});
        await this.im.reply(recipient.chatId,msg.messageId,'请在本次编辑卡选择内容，并回复希望采用的修改。');
      }else await this.im.reply(recipient.chatId,msg.messageId,'请使用原配方卡上的操作，或发送 /recipe works 选择作品。');
      return true;
    }
    if(!intent&&!photo&&!retry&&!current){
      await this.im.reply(recipient.chatId,msg.messageId,'请发送 /recipe works 选择要修改的作品。');
      return true;
    }
    if(!photo&&msg.rawContentType!=='text')return true;
    this.hooks.interact(p);
    await this.run(p,link,(s,actual,db)=>{
      if(route&&!matchesAuthoringRoute(db,actual,route,this.now()))throw new CreatorSelectionChanged();
      if(quote)this.currentCard(s,p,quote);
      s.seen=[...(s.seen??[]).slice(-63),msg.messageId];
    });
    if(retry){
      if(!await this.retryCard(p,link,current?.kind==='draft'?current.snapshot.work.draftId:undefined,current?.kind==='version'?current.target.versionId:undefined))await this.im.reply(recipient.chatId,msg.messageId,'没有可重新核验的原请求。');
    }else if(photo&&current?.kind==='draft'&&selection.logo?.draftId===current.snapshot.work.draftId){
      const r=directImage(msg);
      const bytes=await this.attachment(msg.messageId,r.key,r.type);
      const sha256=digest(bytes);
      await this.hooks.guard(p,recipient);
      await this.offer(p,link,{kind:'metadata',work:current.snapshot.work,baseSha256:current.snapshot.contentSha256,revision:current.snapshot.revision,change:{field:'logo',value:'attachment',sha256}},
        {attachment:{key:r.key,messageId:msg.messageId,type:r.type,sha256},route,quote});
    }else if(issue&&current?.kind==='version')await this.offer(p,link,{kind:'issue',target:current.target,count:Number(issue[1])},{route,quote});
    else if(change&&current?.kind==='draft'){
      const {work,revision,contentSha256}=current.snapshot;
      const field=change[1]!.toLowerCase(),input=change[2]??'';
      const value=field==='access'&&input==='直接获取'?'direct':field==='access'&&input==='凭码获取'?'coded':field==='logo'&&input==='移除'?'remove':input;
      if(field==='access'&&!['direct','coded'].includes(value)){
        await this.im.reply(recipient.chatId,msg.messageId,'请发送 /recipe access 直接获取 或 /recipe access 凭码获取。');return true;
      }
      if(field==='logo'&&current.snapshot.format!=='rich-v2'){await this.im.reply(recipient.chatId,msg.messageId,'这份旧格式作品没有 Logo 字段。');return true;}
      if(field==='logo'&&!value){await this.run(p,link,s=>{s.awaitLogo={draftId:work.draftId,expiresAt:this.now()+300_000};});await this.im.reply(recipient.chatId,msg.messageId,'请发送一张图片或图片附件。');}
      else await this.offer(p,link,creatorCommandSchema.parse({kind:'metadata',work,revision,baseSha256:contentSha256,change:{field,value}}),{route,quote});
    }else if(intent==='works'&&current?.kind==='draft'&&/预览发布|发布吧|\/recipe\s+(?:publish|preview)/i.test(text))await this.selected(p,link,{kind:'draft',work:current.snapshot.work,name:current.snapshot.public.name,version:current.snapshot.public.version},undefined,false);
    else if(intent)await this.intent(p,link,intent);
    else await this.im.reply(recipient.chatId,msg.messageId,'请选择可执行这个操作的草稿或已发布版本。');
    return true;
  }
  async action(p:Presence,evt:CardActionEvent,previewFrom?:string){
    if(!this.enabled||!physicalChat(evt.chatId))return;
    const raw=evt.raw as {operator?:{open_id?:string;tenant_key?:string}};
    if(!raw?.operator?.tenant_key||raw.operator.open_id!==evt.operator.openId)return;
    const recipient={openId:evt.operator.openId,chatId:evt.chatId,tenantKey:raw.operator.tenant_key};
    const selectionState=await this.ledger.run(db=>{
      const actual=db.links[linkKey(p.scope,p.account)];
      if(!actual)throw denied();
      return this.selectionState(db,actual);
    });
    const link=await this.hooks.guard(p,recipient);
    const click=creatorClick.safeParse(evt.action?.value).data;
    if(click?.verb!=='creator')return;
    const {ref,generation,index}=click;
    if(typeof ref!=='string'||!Number.isInteger(index))return;
    const c=await this.run(p,link,s=>s.cards[ref]);
    if(!c||c.session!==(previewFrom??p.session)||c.expiresAt<=this.now()||c.generation!==generation||c.messageId!==evt.messageId||c.needsUpdate&&!c.previewRefresh||!c.cardId||!c.options[index])return;
    const choice=c.options[index]!.choice;
    if(previewFrom&&(choice.kind!=='read'||choice.read.kind!=='openPreview'))return;
    if(!await this.im.matches(evt.messageId,evt.chatId,c.cardId))return;
    await this.hooks.guard(p,recipient);
    if(c.needsUpdate&&!await this.run(p,link,s=>this.acknowledgeVisibleRefresh(s,c)))return;
    this.hooks.interact(p);
    switch(choice.kind){
      case 'detailPage':return this.preview(p,link,c,choice);
      case 'codePage':return this.display(p,link,await this.run(p,link,s=>this.cards.codePage(s,p,choice.answer,choice.offset,c.version)));
      case 'select':
        try{return await this.selected(p,link,choice.selection,{card:c,index,selectionState});}
        catch(error){
          await this.im.reply(evt.chatId,evt.messageId,error instanceof CreatorSelectionChanged?'账号选择已改变，请引用原配方卡或重新选择账号后重发本条修改。':denied().message);
          throw error;
        }
      case 'resumeHandoff':await this.hooks.resume(p,link,choice.id,(_db,actual)=>this.consumeChoice(state(actual),p,c,index));return;
      case 'groups':return this.groups(p,link,choice.offset,choice.inherited);
      case 'group':{
        const g=choice.group;
        if(await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,g.groupId)!==g.identity)throw denied();
        const again=await this.hooks.guard(p,recipient);
        if(again.binding!==link.binding)throw denied();
        const retryId=await this.run(p,link,s=>{const card=s.cards[ref];if(!card)throw denied();return card.retryId??=operationUuid(this.now());});
        await this.hooks.begin(p,link,{type:'beginHandoff',botId:agentIdSchema.parse(this.opts.bot.appId),session:p.session,retryId,groupId:groupIdSchema.parse(g.groupId),groupName:g.name,
          ...(choice.inherited&&{inherited:choice.inherited,sourceVersionId:choice.inherited.versionId})});
        await this.run(p,link,s=>{delete s.cards[ref];});
        return;
      }
      case 'edit':{
        const row=await this.currentJob(p,link,choice.id),t=row.job.task;
        if(row.state!=='offer'||row.offerRef!==ref||t.kind!=='command'||t.command.kind!=='publish')return;
        const {work,revision,format}=t.command.snapshot;
        await this.source(p,work);
        const commit=(db:AuthoringLedger,actual:Link)=>{
          const s=state(actual);this.consumeChoice(s,p,c,index);invalidate(s,work.draftId);selectCreatorBinding(db,actual,this.now());
        };
        if(format==='role-v1'){await this.hooks.edit(p,link,work,revision,commit);return;}
        await this.run(p,link,(_s,actual,db)=>commit(db,actual));
        await this.read(p,link,{kind:'edit',work,revision});return;
      }
      case 'logo':
        await this.run(p,link,s=>{s.awaitLogo={draftId:choice.work.draftId,expiresAt:this.now()+300_000};});
        await this.im.reply(recipient.chatId,evt.messageId,'请发送一张图片或图片附件。');return;
      case 'read':
        if(choice.read.kind==='openPreview'){
          const identity=z.object({event_id:z.string().min(1).max(256)}).safeParse(evt.raw).data;
          return this.openPreview(p,link,c,choice.read,identity&&digest(identity.event_id));
        }
        if(choice.read.kind==='page')return this.preview(p,link,c,choice.read);
        await this.read(p,link,choice.read,c.version);return;
      case 'offer':{
        const reused=await this.run(p,link,s=>Object.values(s.jobs).find(r=>r.sourceChoice===ref+'/'+index));
        if(reused)return;
        await this.offer(p,link,choice.command,{sourceChoice:ref+'/'+index,selection:c.version,codeLabel:choice.codeLabel});return;
      }
      case 'approve':{
        const row=await this.run(p,link,s=>s.jobs[choice.id]);
        if(!row||row.job.task.kind!=='command')return;
        await this.source(p,row.originWork);
        await this.hooks.guard(p,recipient);
        await this.run(p,link,(s,actual,db)=>{
          const row=s.jobs[choice.id],card=s.cards[ref];
          if(!row||!card||card.messageId!==evt.messageId||card.expiresAt<=this.now()||row.offerRef!==ref||
            card.generation!==generation||card.session!==p.session||card.cardId!==c.cardId||!same(card.options[index],c.options[index])||
            row.state!==(choice.retry?'unknown':'offer')||row.job.task.kind!=='command')return;
          const task=row.job.task;
          this.noPendingSave(db,p,link,workOf(task.command),row.job.id);
          row.messageId=evt.messageId;row.originalCardId=card.cardId;row.approvalGeneration=card.generation;row.state='active';task.expiresAt=this.now()+ttl;
          task.approval=digest(JSON.stringify([row.job.id,task.command,task.expiresAt,link.binding,p.scope,p.account,recipient,card.cardId,evt.messageId,ref,generation]));
          task.confirmation={kind:'feishu-card'};
          renewCreatorBinding(db,actual,this.now());
        });
      }
    }
  }
  async offlinePreview(evt:CardActionEvent,otherConnected=false){
    const click=creatorClick.safeParse(evt.action?.value).data;
    const raw=z.object({operator:z.object({open_id:z.string(),tenant_key:z.string()})}).safeParse(evt.raw).data;
    if(click?.verb!=='creator'||!raw||raw.operator.open_id!==evt.operator.openId||!physicalChat(evt.chatId)||!isAdmin(this.opts.cfg,evt.operator.openId))return;
    const recipient={openId:evt.operator.openId,chatId:evt.chatId,tenantKey:raw.operator.tenant_key};
    const verified=await this.ledger.run(db=>{
      const entry=Object.entries(db.links).find(([,link])=>link.bot===this.botKey&&sameRecipient(link.recipient,recipient)&&link.creator?.cards[click.ref]);
      if(!entry)return;
      const [key,link]=entry;
      const card=link?.creator?.cards[click.ref],choice=card?.options[click.index]?.choice;
      if(card&&card.expiresAt>this.now()&&(!card.needsUpdate||card.previewRefresh)&&card.generation===click.generation&&card.messageId===evt.messageId&&
        card.cardId&&choice?.kind==='read'&&choice.read.kind==='openPreview')return {card,key,binding:link.binding};
    });
    if(!verified)return;
    const {card}=verified;
    if(card.cardId&&await this.im.matches(evt.messageId,evt.chatId,card.cardId)){
      await this.ledger.run(db=>{
        const link=db.links[verified.key];
        if(!link?.creator||link.bot!==this.botKey||link.binding!==verified.binding||!sameRecipient(link.recipient,recipient))return;
        if(card.needsUpdate&&!this.acknowledgeVisibleRefresh(link.creator,card))return;
        const owner=Object.values(link.creator.jobs).find(r=>r.offerRef===card.ref);
        this.refreshPreview(link.creator,owner,card);
      });
      await this.im.reply(evt.chatId,evt.messageId,otherConnected?'请在原 App 的「我的配方」查看这份草稿。':'请先打开 App 再点击预览。');
    }
  }
  private noPendingSave(db:AuthoringLedger,p:Presence,link:Link,work?:CreatorWork,exceptId?:string){
    if(!work)return;
    if(Object.values(db.operations).some(o=>o.scope===p.scope&&o.accountId===p.account&&o.binding===link.binding&&!o.revoked&&o.terminalAt===undefined&&
      (o.view.draftId===work.draftId||o.view.operationId===work.source?.preparationId)))throw denied();
    if(Object.values(db.handoffs??{}).some(h=>h.binding===link.binding&&h.draftId===work.draftId&&['selecting','awaitingAttestations'].includes(h.phase.state)))throw denied();
    if(Object.values(db.links[linkKey(p.scope,p.account)]?.creator?.jobs??{}).some(r=>r.job.id!==exceptId&&r.state!=='finished'&&r.job.task.kind==='command'&&
      r.job.task.command.kind==='metadata'&&r.job.task.command.work.draftId===work.draftId))throw denied();
  }
  private currentJob(p:Presence,link:Link,id:string){
    return this.run(p,link,s=>{
      const row=s.jobs[id];
      if(!row||row.job.binding!==link.binding||row.job.scope!==p.scope)throw denied();
      return row;
    });
  }
  private appApproval(p:Presence,link:Link,job:CreatorJob){
    const task=job.task;
    if(task.kind!=='command'||task.confirmation?.kind!=='app')throw denied();
    return digest(JSON.stringify(['app',task.confirmation.confirmationId,job.id,task.command,task.expiresAt,link.binding,p.scope,p.account]));
  }
  private async publicationPreview(p:Presence,link:Link,work:CreatorWork,revision:number):Promise<Extract<CreatorReply,{kind:'creatorPreview'}>>{
    await this.source(p,work);
    const row=await this.run(p,link,(s,_l,db)=>{
      this.noPendingSave(db,p,link,work);
      const publications=Object.values(s.jobs).filter(r=>r.job.task.kind==='command'&&r.job.task.command.kind==='publish'&&r.job.task.command.snapshot.work.draftId===work.draftId);
      const existing=publications.find(pendingPublication)??publications.find(r=>r.state==='offer'&&publicationAt(r,work,revision)&&r.expiresAt>this.now())??
        publications.find(r=>r.state==='finished'&&publicationAt(r,work,revision))??publications.find(r=>r.state==='offer'&&r.expiresAt>this.now());
      if(existing){
        const task=existing.job.task;
        if(task.kind!=='command'||task.command.kind!=='publish'||!same(task.command.snapshot.work,work)||task.command.snapshot.revision!==revision)throw denied();
        return existing;
      }
      const read=Object.values(s.jobs).find(r=>r.state==='active'&&r.job.task.kind==='read'&&r.job.task.read.kind==='draft'&&same(r.job.task.read.work,work));
      return read??this.addJob(p,link,s,{kind:'read',read:{kind:'draft',work}},'active',work);
    });
    if(row.state==='offer'||row.state==='unknown'){
      const card=await this.run(p,link,s=>{
        const current=s.jobs[row.job.id];if(!current)throw denied();
        let c=current.offerRef&&s.cards[current.offerRef];
        if(current.state==='unknown'&&(!c||c.expiresAt<=this.now()||c.session!==p.session))c=this.cards.approvalCard(p,s,current,true);
        if(!c||c.expiresAt<=this.now())throw denied();
        if(!p.nativePreview&&c.options.some(o=>o.choice.kind==='read'&&o.choice.read.kind==='openPreview')){
          const expiresAt=c.expiresAt;c=this.cards.approvalCard(p,s,current,current.state==='unknown');c.expiresAt=expiresAt;
        }
        c.session=p.session;return c;
      });
      await this.display(p,link,card);
    }
    return {kind:'creatorPreview',job:row.job,state:row.job.task.kind==='read'?'preparing':row.state,...(row.result&&{result:row.result})};
  }
  private async appConfirm(p:Presence,link:Link,input:Extract<CreatorRequest,{type:'creatorAppConfirm'}>){
    const row=await this.currentJob(p,link,input.id),task=row.job.task;
    if(task.kind!=='command'||task.command.kind!=='publish'||task.command.snapshotDigest!==input.snapshotDigest||snapshotHash(task.command.snapshot)!==input.snapshotDigest)throw denied();
    await this.source(p,task.command.snapshot.work);
    await this.run(p,link,(s,actual,db)=>{
      const current=s.jobs[input.id],command=current?.job.task;
      if(!current||command?.kind!=='command'||command.command.kind!=='publish'||command.command.snapshotDigest!==input.snapshotDigest)throw denied();
      if(current.state==='active'||current.state==='finished')return;
      if(command.confirmation?.kind==='app'&&command.confirmation.confirmationId===input.confirmationId)return;
      if(current.state!=='offer'&&current.state!=='unknown')throw denied();
      if(current.state==='offer'&&current.expiresAt<=this.now())throw denied();
      this.noPendingSave(db,p,link,command.command.snapshot.work);
      const carrier=current.offerRef?s.cards[current.offerRef]:undefined;
      if(!carrier?.messageId||!carrier.cardId||carrier.needsUpdate||carrier.session!==p.session||carrier.expiresAt<=this.now())throw denied();
      current.messageId=carrier.messageId;current.originalCardId=carrier.cardId;current.approvalGeneration=carrier.generation;
      current.state='active';command.expiresAt=this.now()+ttl;
      command.confirmation={kind:'app',confirmationId:input.confirmationId};command.approval=this.appApproval(p,link,current.job);
      renewCreatorBinding(db,actual,this.now());
    });
  }
  private async allowedJob(p:Presence,link:Link,id:string):Promise<Extract<CreatorReply,{kind:'creatorChecked'}>>{
    const row=await this.currentJob(p,link,id);
    await this.source(p,row.originWork);
    const mustCheckCard=row.job.task.kind==='read'&&['page','openPreview'].includes(row.job.task.read.kind)||row.job.task.kind==='deliverCodes'||row.job.task.kind==='command'&&row.job.task.confirmation?.kind!=='app'&&row.state==='active'&&row.job.task.expiresAt>this.now();
    const cardAvailable=!mustCheckCard||Boolean(row.messageId&&row.originalCardId&&await this.im.matches(row.messageId,link.recipient.chatId,row.originalCardId));
    await this.hooks.guard(p,link.recipient);
    return this.run(p,link,(s,_l,db)=>{
      const r=s.jobs[id];
      if(!r||r.state==='finished'||row.originalCardId!==r.originalCardId||row.messageId!==r.messageId)throw denied();
      const {job}=r;
      if(r.state==='offer'){
        if(job.task.kind!=='command'||job.task.command.kind!=='publish'||r.expiresAt<=this.now())throw denied();
        this.noPendingSave(db,p,link,job.task.command.snapshot.work);
        return {kind:'creatorChecked',job,mode:'preview'};
      }
      switch(job.task.kind){
        case 'read':
          if(r.expiresAt<=this.now())throw denied();
          if(job.task.read.kind==='openPreview'){
            const owner=r.previewOwner?s.jobs[r.previewOwner]:undefined,card=owner?.offerRef?s.cards[owner.offerRef]:undefined;
            if(!p.nativePreview||r.previewRequest?.session!==p.session||!cardAvailable||!card||card.session!==r.previewRequest.cardSession||card.cardId!==r.originalCardId||card.messageId!==r.messageId||card.generation!==r.approvalGeneration||
              this.appPreviewOwner(s,card,job.task.read)!==owner)throw denied();
            this.noPendingSave(db,p,link,job.task.read.work);
          }
          if(job.task.read.kind==='page'){
            const owner=r.previewOwner?s.jobs[r.previewOwner]:undefined;
            if(!cardAvailable||owner?.preview?.readId!==id||!this.livePreview(s,p.session,owner))throw denied();
          }
          if(job.task.read.kind==='draft')this.noPendingSave(db,p,link,job.task.read.work);
          return {kind:'creatorChecked',job,mode:'read'};
        case 'deliverCodes':
          if(!cardAvailable)throw denied();
          return {kind:'creatorChecked',job,mode:'delivery'};
        case 'command':
          if(job.task.confirmation?.kind==='app'&&job.task.approval!==this.appApproval(p,link,job))throw denied();
          if(!cardAvailable||r.state==='unknown'||job.task.expiresAt<=this.now())return {kind:'creatorChecked',job,mode:'receipt'};
          this.noPendingSave(db,p,link,workOf(job.task.command),job.id);
          return {kind:'creatorChecked',job,mode:'execute'};
      }
    });
  }
  async request(p:Presence,req:Exclude<CreatorRequest,{type:'creatorDiscover'|'creatorOpen'}>):Promise<CreatorReply>{
    if(!this.enabled)throw denied();
    const link=await this.hooks.guard(p);
    switch(req.type){
      case 'creatorPreview':return this.publicationPreview(p,link,req.work,req.revision);
      case 'creatorAppConfirm':await this.appConfirm(p,link,req);break;
      case 'creatorContinue':this.hooks.interact(p);await this.selected(p,link,req.selection);break;
      case 'creatorPoll':{
        const wakeId=await this.run(p,link,(_s,l,db)=>l.wake&&l.wake.expiresAt>this.now()&&this.wakeRoute(db,l)?l.wake.id:undefined);
        if(wakeId)await this.open(p,link.binding,wakeId).catch(error=>{if(!(error instanceof CreatorSelectionChanged))throw error;});
        const {jobs,cards}=await this.run(p,link,(s,l,db)=>{
          const now=this.now();
          for(const [id,r] of Object.entries(s.jobs)){
            if(r.state!=='finished'&&r.job.task.kind==='read'&&r.job.task.read.kind==='openPreview'){
              const owner=r.previewOwner?s.jobs[r.previewOwner]:undefined,card=owner?.offerRef?s.cards[owner.offerRef]:undefined;
              if(!card||card.session!==r.previewRequest?.cardSession||!this.livePreview(s,card.session,owner)||card.generation!==r.approvalGeneration||card.cardId!==r.originalCardId||card.messageId!==r.messageId){
                delete s.jobs[id];continue;
              }
              if(this.hooks.canRefreshPreview(p,r.previewRequest.session)&&this.refreshPreview(s,owner,card)){
                delete s.jobs[id];continue;
              }
            }
            if(r.job.task.kind==='read'&&r.job.task.read.kind==='page'){
              const owner=r.previewOwner?s.jobs[r.previewOwner]:undefined;
              const offer=owner?.offerRef?s.cards[owner.offerRef]:undefined;
              if(!offer||!this.livePreview(s,offer.session,owner)||owner?.preview?.readId!==id){
                if(!r.previewOwner&&r.resultCard&&s.cards[r.resultCard]?.workId===r.job.task.read.work.draftId)delete s.cards[r.resultCard];
                delete s.jobs[id];
                if(owner?.preview?.readId===id){delete owner.preview.readId;delete owner.preview.position;}
                continue;
              }
            }
            if(r.state==='finished'&&(!r.receiptCard||!r.resultCard||s.cards[r.resultCard]?.messageId&&!s.cards[r.resultCard]?.needsUpdate)&&r.created+7*86400_000<=now||r.expiresAt<=now&&(r.state==='offer'||r.job.task.kind==='read'))delete s.jobs[id];
          }
          const undelivered=Object.values(s.jobs).filter(r=>r.receiptCard&&r.resultCard&&(!s.cards[r.resultCard]?.messageId||s.cards[r.resultCard]?.needsUpdate));
          for(const r of undelivered){
            const c=s.cards[r.resultCard!];
            if(c&&(c.session!==p.session||c.expiresAt<=now)){c.session=p.session;c.options=[];c.expiresAt=now+ttl;}
          }
          for(const [ref,c] of Object.entries(s.cards))if(c.expiresAt<=now&&!undelivered.some(r=>r.resultCard===ref))delete s.cards[ref];
          for(const op of Object.values(db.operations)){
            const receipt=op.view.receipt;
            if(op.scope!==p.scope||op.binding!==link.binding||op.accountId!==p.account||op.revoked||op.view.state!=='completed'||receipt?.status!=='accepted'||
              !op.creatorSave||s.observed?.[op.view.operationId])continue;
            const source=op.view.purpose==='prepareDraft'&&op.view.groupId&&op.sourceIdentity?
              {preparationId:op.view.operationId,groupId:op.view.groupId,identity:op.sourceIdentity}:s.sources?.[receipt.draftId]??null;
            if(op.view.format==='rich-v2'&&!source)continue;
            const work={draftId:receipt.draftId,source};
            (s.sources??={})[work.draftId]=source;
            (s.observed??={})[op.view.operationId]=now;
            const existing=Object.values(s.jobs).some(r=>r.job.task.kind==='read'&&r.state==='active'&&r.job.task.read.kind==='draft'&&same(r.job.task.read.work,work)||
              r.job.task.kind==='command'&&r.job.task.command.kind==='publish'&&r.job.task.command.snapshot.work.draftId===work.draftId&&
                (pendingPublication(r)||publicationAt(r,work,receipt.revision)));
            if(!existing)this.addJob(p,link,s,{kind:'read',read:{kind:'draft',work}},'active',work);
          }
          for(const [id,time] of Object.entries(s.observed??{}))if(time+8*86400_000<=now)delete s.observed![id];
          const pending=Object.values(s.jobs).filter(r=>{
            if(r.state!=='active'&&r.state!=='unknown')return false;
            if(r.job.task.kind!=='read')return true;
            if(r.job.task.read.kind==='openPreview')return p.nativePreview&&r.previewRequest?.session===p.session;
            if(r.job.task.read.kind==='page'){
              const ref=r.previewOwner&&s.jobs[r.previewOwner]?.offerRef;
              return ref&&s.cards[ref]?.session===p.session;
            }
            return true;
          });
          const offset=this.pollOffset%Math.max(1,pending.length);
          const next=[...pending.slice(offset),...pending.slice(0,offset)].slice(0,16).map(r=>r.job);
          this.pollOffset=offset+next.length;
          return {jobs:next,
            cards:Object.values(s.cards).filter(c=>c.ref!==l.wake?.cardRef&&(!c.messageId||c.needsUpdate)&&
              (c.previewRefresh?this.pendingPreviewRefresh(s,c):c.session===p.session&&(!c.previewOwner||this.livePreview(s,p.session,s.jobs[c.previewOwner])))).slice(0,4)};
        });
        for(const c of cards){
          if(c.previewOwner)await this.redeliver(p,link,c).catch(()=>undefined);
          else if(c.previewRefresh)await this.display(p,link,c).catch(()=>undefined);
          else await this.display(p,link,c);
        }
        this.hooks.live(p);
        return {kind:'creatorJobs',jobs};
      }
      case 'creatorCheck':return this.allowedJob(p,link,req.id);
      case 'creatorLogo':{
        const checked=await this.allowedJob(p,link,req.id);
        const row=await this.currentJob(p,link,req.id);
        const a=row.attachment,task=checked.job.task;
        if(checked.mode!=='execute'||task.kind!=='command'||task.command.kind!=='metadata'||task.command.change.field!=='logo'||
          task.command.change.value!=='attachment'||!a||a.sha256!==task.command.change.sha256)throw denied();
        const bytes=await this.attachment(a.messageId,a.key,a.type);
        if(digest(bytes)!==a.sha256||(await this.allowedJob(p,link,req.id)).mode!=='execute')throw denied();
        return {kind:'creatorLogoBytes',base64:bytes.toString('base64'),sha256:a.sha256};
      }
      case 'creatorAnswer':await this.answer(p,link,req.id,req.answer);break;
      case 'creatorDeliver':{
        const row=await this.currentJob(p,link,req.id);
        const task=row.job.task;
        if(task.kind!=='deliverCodes'||!same(task.codeIds,req.items.map(i=>i.codeId)))throw denied();
        if(row.state==='finished')return {kind:'creatorAck'};
        if((await this.allowedJob(p,link,req.id)).mode!=='delivery')throw denied();
        const lines=req.items.map((i,index)=>i.status==='available'?i.code:'分享码 '+(index+1)+' · '+(i.status==='redeemed'?'已兑换':'已停用'));
        const body=card([{tag:'div',text:{tag:'plain_text',content:lines.join('\n')}}],{header:{title:PRIVATE_RECIPE_CODES_TITLE},summary:PRIVATE_RECIPE_CODES_TITLE,forward:false});
        await this.hooks.guard(p,link.recipient);
        const id=await this.im.createJson(body).catch(()=>{throw denied();});
        await this.allowedJob(p,link,req.id);
        await this.im.send(link.recipient.chatId,id,req.id).catch(()=>{throw denied();});
        await this.run(p,link,s=>{const r=s.jobs[req.id];if(r)r.state='finished';});
        break;
      }
    }
    return {kind:'creatorAck'};
  }
  private async answer(p:Presence,link:Link,id:string,a:CreatorAnswer){
    const old=await this.currentJob(p,link,id);
    const answerDigest=digest(JSON.stringify(a));
    if(old.state==='finished'){
      if(old.answerDigest!==answerDigest)throw denied();
      const c=await this.run(p,link,s=>old.resultCard&&s.cards[old.resultCard]);
      if(c&&(!c.messageId||c.needsUpdate))await this.redeliver(p,link,c);
      return;
    }
    const checked=await this.allowedJob(p,link,id),task=checked.job.task;
    if(task.kind!=='read'&&task.kind!=='command')throw denied();
    if(task.kind==='read'&&task.read.kind==='edit'&&a.kind==='edit'){
      const q=task.read,src=a.work.source;
      if(!same(q.work,a.work)||q.revision!==a.revision||!src)throw denied();
      await this.hooks.begin(p,link,{type:'beginDraftHandoff',botId:agentIdSchema.parse(this.opts.bot.appId),session:p.session,
        retryId:id,groupName:src.groupId,groupId:src.groupId,identity:src.identity,draftId:q.work.draftId,baseRevision:q.revision,canonical:a.canonical,
        source:{sourceIntentId:src.preparationId,canonical:a.sourceCanonical}});
    }
    if(task.kind==='read'&&task.read.kind==='parent'&&a.kind==='parent'){
      if(!same(task.read.target,a.target)||a.inherited.accountId!==p.account||a.inherited.versionId!==task.read.target.versionId)throw denied();
      await this.groups(p,link,0,a.inherited);
    }
    const bot=a.kind==='snapshot'&&a.snapshot.work.source?(await loadBots()).bots.find(b=>authoringBotKey(b)===this.botKey):undefined;
    const c=await this.run(p,link,(s,_l,db)=>{
      const r=s.jobs[id];
      if(!r||!['active','unknown'].includes(r.state))throw denied();
      let card:Card|undefined,refresh:Card|undefined;
      if(a.kind==='unknown'){
        if(task.kind!=='command')throw denied();
        if(r.state==='unknown'&&r.resultCard&&s.cards[r.resultCard]?.session===p.session)return;
        r.state='unknown';
        card=this.cards.approvalCard(p,s,r,true);r.resultCard=card.ref;return card;
      }
      if(task.kind==='read'&&task.read.kind==='openPreview'){
        const q=task.read,owner=r.previewOwner?s.jobs[r.previewOwner]:undefined,command=owner?.job.task;
        if(command?.kind!=='command'||command.command.kind!=='publish')throw denied();
        if(a.kind==='previewOpened'){
          if(!same(a.work,q.work)||a.snapshotDigest!==q.snapshotDigest||a.revision!==command.command.snapshot.revision)throw denied();
        }else if(a.kind==='rejected'){
          card=this.cards.newCard(s,p,'无法核实这张卡的草稿','请在 App 的「我的配方」重新读取当前草稿，或在原私聊获取新的预览卡。',[]);
        }else throw denied();
        const carrier=owner?.offerRef?s.cards[owner.offerRef]:undefined;
        if(carrier&&carrier.generation===r.approvalGeneration&&carrier.cardId===r.originalCardId&&carrier.messageId===r.messageId)
          refresh=this.refreshPreview(s,owner,carrier);
      }else if(a.kind==='rejected'&&task.kind==='read'&&task.read.kind==='page'){
        const owner=r.previewOwner&&s.jobs[r.previewOwner];
        if(!owner||owner.preview?.readId!==id)throw denied();
        delete owner.preview.position;
        card=this.cards.previewCard(s,p,owner,'当前页暂时无法显示','请从发布预览卡重新选择这一节。',[],task.read.work.draftId);
      }else if(a.kind==='rejected'){
        card=this.cards.newCard(s,p,'配方操作未完成',{changed:'修订或来源已改变，请重新核对。',unavailable:'当前操作未能完成。',forbidden:'当前账号或来源不可用。',invalid:'原请求未被接受，请核对内容。'}[a.reason],[]);
      }else if(task.kind==='read'){
        const q=task.read;
        if(q.kind==='works'&&a.kind==='works'){
          const buttons:Option[]=a.items.map((item,index)=>({label:(q.offset+index+1)+'. '+(item.kind==='draft'?'草稿':'已发布')+' · '+item.name+' · '+item.version,choice:{kind:'select',selection:item}}));
          if(q.offset===0){
            for(const h of Object.values(db.handoffs??{}).filter(h=>h.creator&&h.scope===p.scope&&h.account===p.account&&h.binding===link.binding&&
              h.expiresAt>this.now()&&['selecting','awaitingAttestations'].includes(h.phase.state)).slice(0,16))
              buttons.push({label:'继续选择 '+h.groupName+' · '+h.retryId.slice(-8),choice:{kind:'resumeHandoff',id:h.retryId}});
          }
          if(a.nextOffset!==null){if(a.nextOffset<=q.offset)throw denied();buttons.push({label:'下一页',choice:{kind:'read',read:{kind:'works',offset:a.nextOffset}}});}
          buttons.push({label:'从群创建配方',choice:{kind:'groups',offset:0}});
          card=this.cards.newCard(s,p,'我的配方','请选择要继续的作品。',buttons);
        }else if(q.kind==='draft'&&a.kind==='snapshot'){
          const snap=a.snapshot;if(!same(q.work,snap.work))throw denied();
          this.noPendingSave(db,p,link,q.work);
          r.state='finished';invalidate(s,snap.work.draftId);
          (s.sources??={})[snap.work.draftId]=snap.work.source;
          const context=_l.context&&_l.context.until>this.now()?db.operations[_l.context.operationId]:undefined;
          const otherContext=context&&context.bot===_l.bot&&context.accountId===p.account&&context.scope===p.scope&&context.binding===_l.binding&&
            sameRecipient(context.recipient,_l.recipient)&&!context.revoked&&context.contextOpen&&(context.contextUntil??0)>this.now()&&
            (context.terminalAt===undefined||context.view.state==='completed')&&context.view.draftId!==snap.work.draftId&&
            !(context.view.receipt?.status==='accepted'&&context.view.receipt.draftId===snap.work.draftId);
          const otherHandoff=Object.values(db.handoffs??{}).some(h=>h.creator&&h.account===p.account&&h.scope===p.scope&&h.binding===_l.binding&&
            sameRecipient(h.recipient,_l.recipient)&&h.expiresAt>this.now()&&['selecting','awaitingAttestations'].includes(h.phase.state)&&h.draftId!==snap.work.draftId);
          if(s.focusDraft===snap.work.draftId||!s.current&&!s.focusDraft&&Object.keys(s.sources).length===1&&!otherContext&&!otherHandoff){
            s.current={kind:'draft',snapshot:snap};s.focusUntil=this.now()+ttl;
          }
          const cmd:CreatorCommand={kind:'publish',snapshot:snap,snapshotDigest:snapshotHash(snap)};
          const offer=this.addJob(p,link,s,{kind:'command',command:cmd,expiresAt:this.now()+ttl,approval:'0'.repeat(64)},'offer',snap.work);
          offer.botName=bot?.botName??bot?.name;
          const src=snap.work.source;
          if(src)offer.groupName=Object.values(db.handoffs??{}).find(h=>h.scope===p.scope&&h.account===p.account&&h.binding===link.binding&&h.phase.state==='prepared'&&
            h.phase.operationId===src.preparationId&&h.groupId===src.groupId&&h.identity===src.identity)?.groupName;
          card=this.cards.approvalCard(p,s,offer,false);
        }else if(q.kind==='page'&&a.kind==='page'){
          const offer=r.previewOwner?s.jobs[r.previewOwner]:undefined;
          const cmd=offer?.job.task.kind==='command'?offer.job.task.command:undefined;
          if(!offer||offer.preview?.readId!==id||!['offer','unknown'].includes(offer.state)||cmd?.kind!=='publish'||cmd.snapshotDigest!==q.snapshotDigest||!same(cmd.snapshot.work,q.work)||a.snapshotDigest!==q.snapshotDigest||a.section!==q.section||a.page!==q.page)throw denied();
          const part=cmd.snapshot.sections[q.section];
          if(!part||digest(a.text)!==part.pageHashes[q.page]||!safeEditValue(a.text))throw denied();
          const nav:Option[]=[];
          if(q.page>0)nav.push({label:'上一页',choice:{kind:'read',read:{...q,page:q.page-1}}});
          if(q.page+1<part.pageHashes.length)nav.push({label:'下一页',choice:{kind:'read',read:{...q,page:q.page+1}}});
          card=this.cards.previewCard(s,p,offer,sectionName(cmd.snapshot,q.section)+' · 第 '+(q.page+1)+'/'+part.pageHashes.length+' 页',a.text,nav,q.work.draftId);
        }else if(q.kind==='codes'&&a.kind==='codes'&&same(q.target,a.target)){
          card=this.cards.codePage(s,p,a,0,r.version);
        }else if(q.kind==='parent'&&a.kind==='parent'&&same(q.target,a.target)&&a.inherited.accountId===p.account&&a.inherited.versionId===q.target.versionId){
          r.state='finished';
        }else if(q.kind==='edit'&&a.kind==='edit'&&same(q.work,a.work)&&q.revision===a.revision){
          r.state='finished';
        }else throw denied();
      }else{
        const cmd=task.command,versionName=r.version?r.version.name+' · '+r.version.version:'所选版本';
        let delivery:Extract<CreatorJob['task'],{kind:'deliverCodes'}>|undefined;
        if(cmd.kind==='publish'&&a.kind==='published'&&a.draftId===cmd.snapshot.work.draftId&&a.draftRevision===cmd.snapshot.revision&&
           (!cmd.snapshot.recipeId||a.target.recipeId===cmd.snapshot.recipeId)&&Boolean(a.firstCodeId)===(cmd.snapshot.public.access==='coded')){
          const {name,version}=cmd.snapshot.public;
          const url=new URL(a.url);
          if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/recipes/'+a.target.recipeId+'/versions/'+a.target.versionId)throw denied();
          s.current=viewVersion(a.target,name,version);s.focusUntil=this.now()+ttl;delete s.focusDraft;
          (s.versionOrigins??={})[a.target.versionId]=cmd.snapshot.work;
          card=this.cards.versionCard(s,p,s.current,a.url);
          if(a.firstCodeId)delivery={kind:'deliverCodes',target:a.target,codeIds:[a.firstCodeId]};
        }else if(cmd.kind==='issue'&&a.kind==='issued'&&same(cmd.target,a.target)&&a.codeIds.length===cmd.count){
          delivery={kind:'deliverCodes',target:a.target,codeIds:a.codeIds};
          card=this.cards.newCard(s,p,'分享码已生成',versionName+' 已生成 '+cmd.count+' 枚分享码。',[]);
        }else if(cmd.kind==='reveal'&&a.kind==='reveal'&&same(cmd.target,a.target)&&cmd.codeId===a.codeId){
          delivery={kind:'deliverCodes',target:a.target,codeIds:[cmd.codeId]};
        }else if(cmd.kind==='disable'&&a.kind==='disabled'&&same(cmd.target,a.target)&&cmd.codeId===a.codeId){
          card=this.cards.newCard(s,p,'分享码已停用',versionName+' · '+(r.codeLabel??'所选分享码'),[]);
        }else if(cmd.kind==='withdraw'&&a.kind==='withdrawn'&&same(cmd.target,a.target)){
          card=this.cards.newCard(s,p,'版本已撤下',versionName,[]);
        }else if(cmd.kind==='metadata'&&a.kind==='saved'&&same(cmd.work,a.work)&&a.revision===cmd.revision+1){
          card=this.cards.newCard(s,p,'修改已保存','修订 '+a.revision,[]);
          this.addJob(p,link,s,{kind:'read',read:{kind:'draft',work:cmd.work}},'active',cmd.work);
        }else if(cmd.kind==='discard'&&a.kind==='discarded'&&same(cmd.work,a.work)&&a.revision===cmd.revision){
          card=this.cards.newCard(s,p,'已删除创作中的作品',r.workName??'所选草稿',[]);
        }else throw denied();
        if(delivery){
          const result=this.addJob(p,link,s,delivery,'active',r.originWork);
          result.messageId=r.messageId;result.originalCardId=r.originalCardId;
        }
      }
      r.state='finished';r.answerDigest=answerDigest;
      if(task.kind==='command'&&task.command.kind==='publish'&&(a.kind==='published'||a.kind==='rejected'))r.result=a;
      r.resultCard=card?.ref;
      if(task.kind==='command'&&card){
        r.receiptCard=true;
        if(r.originalCardId&&r.messageId){
          card.cardId=r.originalCardId;card.messageId=r.messageId;
          card.generation=(r.approvalGeneration??1)+1;card.needsUpdate=true;
        }
      }
      delete r.attachment;
      if(r.preview?.ref)delete s.cards[r.preview.ref];
      if(r.preview?.readId)delete s.jobs[r.preview.readId];
      if(r.offerRef)delete s.cards[r.offerRef];
      return card??refresh;
    });
    if(c)await this.display(p,link,c);
  }
}
