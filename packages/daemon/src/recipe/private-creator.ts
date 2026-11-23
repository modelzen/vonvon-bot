import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {agentIdSchema, creatorCommandSchema, creatorSnapshotSchema, groupIdSchema,
  type CreatorAnswer, type CreatorCommand, type CreatorJob, type CreatorRead, type CreatorReply, type CreatorRequest,
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
  if(/^(?:\/recipe\s+(?:create|start)|(?:从群配置|从这个群|帮我)?(?:创建|制作|分享)(?:一个|一份)?配方)[。！]?$/i.test(text))return 'create';
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
export type JobRecord={
  job:CreatorJob;state:'offer'|'active'|'unknown'|'finished';created:number;expiresAt:number;messageId?:string;originalCardId?:string;approvalGeneration?:number;
  workName?:string;botName?:string;groupName?:string;version?:VersionSelection;codeLabel?:string;
  preview?:{ref?:string;readId?:string;position?:string};previewOwner?:string;
  attachment?:Attachment;originWork?:CreatorWork;answerDigest?:string;resultCard?:string;offerRef?:string;sourceChoice?:string;receiptCard?:boolean;
};
type DraftSelection={kind:'draft';snapshot:CreatorSnapshot};
export type VersionSelection={kind:'version';target:CreatorVersion;name:string;version:string};
export interface CreatorLedger {
  versionOrigins?:Record<string,CreatorWork>;observed?:Record<string,number>;sources?:Record<string,CreatorWork['source']>;
  jobs:Record<string,JobRecord>;cards:Record<string,Card>;chosenUntil?:number;seen?:string[];focusDraft?:string;focusUntil?:number;
  current?:DraftSelection|VersionSelection;awaitLogo?:{draftId:string;expiresAt:number};
  accountChoice?:{ref:string;messageId:string;cardId:string;intent:Intent;expiresAt:number};
}
type Hooks={
  guard(p:Presence,recipient?:Recipient):Promise<Link>;live(p:Presence):void;interact(p:Presence):void;
  begin(p:Presence,link:Link,r:Extract<RecipeAuthoringRequest,{type:'beginHandoff'|'beginDraftHandoff'}>):Promise<unknown>;
  resume(p:Presence,link:Link,id:string,commit:(db:AuthoringLedger,actual:Link)=>void):Promise<unknown>;
  edit(p:Presence,link:Link,work:CreatorWork,revision:number,commit?:(db:AuthoringLedger,actual:Link)=>void):Promise<unknown>;
};
const ttl=30*60_000;
const denied=()=>new Error('本次配方的来源、授权或修订已改变。请从原私聊重新选择。');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const snapshotHash=(s:CreatorSnapshot)=>digest(JSON.stringify(creatorSnapshotSchema.parse(s)));
const state=(l:Link):CreatorLedger=>l.creator??={jobs:{},cards:{}};
const workOf=(c:CreatorCommand)=>c.kind==='publish'?c.snapshot.work:'work'in c?c.work:undefined;
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
  async open(p:Presence,binding:string,wakeId:string|null){
    const link=await this.hooks.guard(p);
    if(binding!==p.binding||binding!==link.binding)throw denied();
    const intent=await this.run(p,link,(s,l)=>{
      if(!wakeId)return;
      const w=l.wake;
      if(w?.id!==wakeId||w.expiresAt<=this.now())throw denied();
      return w.intent;
    });
    this.enabled=true;
    if(intent&&wakeId){
      this.hooks.interact(p);
      if(intent==='create')await this.groups(p,link,0,undefined,wakeId);
      else await this.run(p,link,(s,l)=>{
        if(l.wake?.id!==wakeId)throw denied();
        l.wake.jobId??=this.addJob(p,link,s,{kind:'read',read:{kind:'works',offset:0}}).job.id;
      });
      await this.run(p,link,(s,l)=>{
        if(l.wake?.id===wakeId){s.seen=[...(s.seen??[]).slice(-63),l.wake.messageId];delete l.wake;}
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
  private livePreview(s:CreatorLedger,p:Presence,owner:JobRecord|undefined){
    const offer=owner?.offerRef&&s.cards[owner.offerRef];
    return Boolean(owner&&offer&&offer.session===p.session&&offer.expiresAt>this.now()&&['offer','unknown'].includes(owner.state));
  }
  private previewOwner(s:CreatorLedger,p:Presence,card:Card){
    const actual=s.cards[card.ref];
    if(!actual||actual.generation!==card.generation||actual.session!==p.session||actual.expiresAt<=this.now()||
      actual.needsUpdate||actual.cardId!==card.cardId||actual.messageId!==card.messageId)return;
    const owner=card.previewOwner?s.jobs[card.previewOwner]:Object.values(s.jobs).find(r=>r.offerRef===card.ref);
    if(!owner||!this.livePreview(s,p,owner))return;
    if(card.previewOwner&&(owner.preview?.ref!==card.ref||card.previewApproval!==owner.offerRef))return;
    return owner;
  }
  private async preview(p:Presence,link:Link,clicked:Card,choice:Extract<Option['choice'],{kind:'detailPage'}>|Extract<CreatorRead,{kind:'page'}>){
    const start=await this.run(p,link,s=>{
      const owner=this.previewOwner(s,p,clicked);
      if(owner)return {work:owner.originWork,navigation:clicked.ref===owner.offerRef&&owner.preview?.ref?s.cards[owner.preview.ref]:undefined};
    });
    if(!start)return;
    await this.source(p,start.work);
    const nav=start.navigation;
    const missing=nav?.messageId&&nav.cardId&&await this.im.cardStatus(nav.messageId,link.recipient.chatId,nav.cardId)==='unavailable';
    const card=await this.run(p,link,s=>{
      const row=this.previewOwner(s,p,clicked),task=row?.job.task;
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
        if(this.livePreview(s,p,owner)&&owner?.preview?.ref===card.ref&&s.cards[card.ref]?.generation===card.generation)return owner.originWork;
      });
      if(!work)return;
      await this.source(p,work);
    }
    await this.display(p,link,card);
  }
  private async display(p:Presence,link:Link,c:Card){
    await this.hooks.guard(p,link.recipient);
    if(c.needsUpdate&&c.messageId&&c.cardId){
      const attached=c.previewOwner?await this.im.cardStatus(c.messageId,link.recipient.chatId,c.cardId):'matched';
      const result=attached==='matched'?await this.im.updateJson(c.cardId,c.generation,c.ref,layout(c)):attached;
      const applied=result==='updated'||result==='conflict'&&await this.im.showsJson(c.messageId,link.recipient.chatId,layout(c)).catch(()=>false);
      if(!applied&&result!=='unavailable')throw new Error('卡片等待更新，请稍后再试。');
      c=await this.run(p,link,s=>{
        const r=s.cards[c.ref];
        if(!r||r.generation!==c.generation||r.cardId!==c.cardId)throw denied();
        delete r.needsUpdate;
        if(!applied){delete r.cardId;delete r.messageId;r.sendId=randomUUID();}
        return r;
      });
    }
    if(!c.cardId){
      const id=await this.im.createJson(layout(c));
      c=await this.run(p,link,s=>{const r=s.cards[c.ref];if(!r||r.generation!==c.generation||r.expiresAt<=this.now())throw denied();r.cardId??=id;return r;});
    }
    if(!c.messageId){
      await this.hooks.guard(p,link.recipient);
      const id=await this.im.send(link.recipient.chatId,c.cardId!,c.sendId);
      c=await this.run(p,link,s=>{const r=s.cards[c.ref];if(!r||r.generation!==c.generation||r.cardId!==c.cardId)throw denied();r.messageId=id;return r;});
    }
  }
  async chooseAccount(links:{key:string;binding:string}[],recipient:Recipient,messageId:string,intent:Intent){
    if(!physicalChat(recipient.chatId)||!isAdmin(this.opts.cfg,recipient.openId))return;
    const choices=links.slice(0,32).map(l=>({...l,ref:randomUUID()}));
    const cardId=await this.im.createJson(card(choices.map((l,i)=>button('关联 '+(i+1)+' · '+l.binding.slice(-8),{a:'recipe.authoring',verb:'creatorAccount',ref:l.ref})),{header:{title:'选择本人账号关联'},forward:false}));
    await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));
    if(!isAdmin(this.opts.cfg,recipient.openId))return;
    const sent=await this.im.send(recipient.chatId,cardId,randomUUID());
    await this.ledger.run(db=>{for(const choice of choices){const l=db.links[choice.key];if(l?.binding===choice.binding&&sameRecipient(l.recipient,recipient))state(l).accountChoice={ref:choice.ref,cardId,messageId:sent,expiresAt:this.now()+300_000,intent};}});
  }
  async accountAction(evt:CardActionEvent,recipient:Recipient){
    if(!physicalChat(evt.chatId)||!isAdmin(this.opts.cfg,recipient.openId))return;
    const click=creatorClick.safeParse(evt.action?.value).data;
    if(click?.verb!=='creatorAccount')return;
    const ref=click.ref;
    const bound=await this.ledger.run(db=>Object.values(db.links).find(l=>l.bot===this.botKey&&sameRecipient(l.recipient,recipient)&&l.creator?.accountChoice?.ref===ref));
    const choice=bound?.creator?.accountChoice;
    if(!choice||choice.messageId!==evt.messageId||choice.expiresAt<=this.now()||!await this.im.matches(evt.messageId,evt.chatId,choice.cardId))return;
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
  private async groups(p:Presence,link:Link,offset:number,inherited?:InheritedPublication,wakeId?:string){
    if(wakeId){
      const existing=await this.run(p,link,(s,l)=>{
        if(l.wake?.id!==wakeId)throw denied();
        const c=l.wake.cardRef&&s.cards[l.wake.cardRef];
        if(c&&c.session===p.session)return c;
      });
      if(existing){await this.display(p,link,existing);return;}
    }
    if(offset===0)await this.run(p,link,s=>{
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
    const view=await this.run(p,link,(s,l)=>{
      if(wakeId&&l.wake?.id!==wakeId)throw denied();
      const c=this.cards.newCard(s,p,'选择来源群',buttons.length?'请选择本次要取用配置的群。':'没有可用的已绑定群。',buttons);
      if(wakeId&&l.wake)l.wake.cardRef=c.ref;
      return c;
    });
    await this.display(p,link,view);
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
  private async offer(p:Presence,link:Link,command:CreatorCommand,{attachment,sourceChoice,selection,codeLabel,route}:{attachment?:Attachment;sourceChoice?:string;selection?:VersionSelection;codeLabel?:string;route?:AuthoringRoute}={}){
    creatorCommandSchema.parse(command);
    if(command.kind==='metadata'&&!safeEditValue(command.change))throw denied();
    await this.source(p,workOf(command));
    const c=await this.run(p,link,(s,actual,db)=>{
      if(route&&!matchesAuthoringRoute(db,actual,route,this.now()))throw new CreatorSelectionChanged();
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
  private async selected(p:Presence,link:Link,selection:CreatorSelection,clicked?:{card:Card;index:number},select=true){
    const commit=(s:CreatorLedger,actual:Link,db:AuthoringLedger)=>{
      if(clicked)this.consumeChoice(s,p,clicked.card,clicked.index);
      if(select)selectCreatorBinding(db,actual,this.now());
    };
    if(selection.kind==='draft'){
      await this.source(p,selection.work);
      await this.run(p,link,(s,actual,db)=>{commit(s,actual,db);s.focusDraft=selection.work.draftId;s.focusUntil=this.now()+ttl;});
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
  private consumeChoice(s:CreatorLedger,p:Presence,original:Card,index:number){
    const actual=s.cards[original.ref];
    if(!actual||actual.generation!==original.generation||actual.session!==p.session||actual.expiresAt<=this.now()||actual.needsUpdate||
      actual.messageId!==original.messageId||actual.cardId!==original.cardId||!same(actual.options[index],original.options[index]))throw denied();
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
      return {selected,logo:s.awaitLogo,duplicate:s.seen?.includes(msg.messageId),originalOp:Boolean(op),matching:matching||focusedOperation,foreignQuote:Boolean(quoted&&!op&&!activeCard),active:Boolean(s.focusUntil&&s.focusUntil>this.now())};
    });
    if(selection.duplicate)return true;
    const current=selection.selected;
    const photo=selection.logo&&selection.logo.expiresAt>this.now()&&['file','image'].includes(msg.rawContentType);
    const change=/^\/recipe\s+(name|summary|overview|version|access|logo)(?:\s+([\s\S]*))?$/i.exec(text);
    const issue=/^(?:\/recipe\s+issue\s+|(?:给这个版本)?生成)(\d+)(?:枚分享码)?$/i.exec(text);
    const retry=/^\/recipe\s+retry$/i.test(text);
    if(msg.replyToMessageId&&selection.foreignQuote&&selection.active){await this.im.reply(recipient.chatId,msg.messageId,'请选择原作品的当前卡片。');return true;}
    if(selection.originalOp&&!intent)return false;
    if(!intent&&!photo&&!change&&!issue&&!retry){
      if(!selection.active)return false;
      if(text==='/recipe end'){await this.run(p,link,(s,actual,db)=>{
        if(route&&!matchesAuthoringRoute(db,actual,route,this.now()))throw new CreatorSelectionChanged();
        delete s.current;delete s.focusDraft;delete s.focusUntil;
      });return false;}
      if(selection.matching)return false;
      if(current?.kind==='draft'&&msg.rawContentType==='text'){
        const {work,revision}=current.snapshot;
        await this.run(p,link,(s,actual,db)=>{
          if(route&&!matchesAuthoringRoute(db,actual,route,this.now()))throw new CreatorSelectionChanged();
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
        {attachment:{key:r.key,messageId:msg.messageId,type:r.type,sha256},route});
    }else if(issue&&current?.kind==='version')await this.offer(p,link,{kind:'issue',target:current.target,count:Number(issue[1])},{route});
    else if(change&&current?.kind==='draft'){
      const {work,revision,contentSha256}=current.snapshot;
      const field=change[1]!.toLowerCase(),input=change[2]??'';
      const value=field==='access'&&input==='直接获取'?'direct':field==='access'&&input==='凭码获取'?'coded':field==='logo'&&input==='移除'?'remove':input;
      if(field==='access'&&!['direct','coded'].includes(value)){
        await this.im.reply(recipient.chatId,msg.messageId,'请发送 /recipe access 直接获取 或 /recipe access 凭码获取。');return true;
      }
      if(field==='logo'&&current.snapshot.format!=='rich-v2'){await this.im.reply(recipient.chatId,msg.messageId,'这份旧格式作品没有 Logo 字段。');return true;}
      if(field==='logo'&&!value){await this.run(p,link,s=>{s.awaitLogo={draftId:work.draftId,expiresAt:this.now()+300_000};});await this.im.reply(recipient.chatId,msg.messageId,'请发送一张图片或图片附件。');}
      else await this.offer(p,link,creatorCommandSchema.parse({kind:'metadata',work,revision,baseSha256:contentSha256,change:{field,value}}),{route});
    }else if(intent==='works'&&current?.kind==='draft'&&/预览发布|发布吧|\/recipe\s+(?:publish|preview)/i.test(text))await this.selected(p,link,{kind:'draft',work:current.snapshot.work,name:current.snapshot.public.name,version:current.snapshot.public.version},undefined,false);
    else if(intent)await this.intent(p,link,intent);
    else await this.im.reply(recipient.chatId,msg.messageId,'请选择可执行这个操作的草稿或已发布版本。');
    return true;
  }
  async action(p:Presence,evt:CardActionEvent){
    if(!this.enabled||!physicalChat(evt.chatId))return;
    const raw=evt.raw as {operator?:{open_id?:string;tenant_key?:string}};
    if(!raw?.operator?.tenant_key||raw.operator.open_id!==evt.operator.openId)return;
    const recipient={openId:evt.operator.openId,chatId:evt.chatId,tenantKey:raw.operator.tenant_key};
    const link=await this.hooks.guard(p,recipient);
    const click=creatorClick.safeParse(evt.action?.value).data;
    if(click?.verb!=='creator')return;
    const {ref,generation,index}=click;
    if(typeof ref!=='string'||!Number.isInteger(index))return;
    const c=await this.run(p,link,s=>s.cards[ref]);
    if(!c||c.session!==p.session||c.expiresAt<=this.now()||c.generation!==generation||c.messageId!==evt.messageId||c.needsUpdate||!c.cardId||!c.options[index])return;
    if(!await this.im.matches(evt.messageId,evt.chatId,c.cardId))return;
    await this.hooks.guard(p,recipient);
    this.hooks.interact(p);
    const choice=c.options[index]!.choice;
    switch(choice.kind){
      case 'detailPage':return this.preview(p,link,c,choice);
      case 'codePage':return this.display(p,link,await this.run(p,link,s=>this.cards.codePage(s,p,choice.answer,choice.offset,c.version)));
      case 'select':return this.selected(p,link,choice.selection,{card:c,index});
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
          this.noPendingSave(db,p,link,workOf(task.command));
          row.messageId=evt.messageId;row.originalCardId=card.cardId;row.approvalGeneration=card.generation;row.state='active';task.expiresAt=this.now()+ttl;
          task.approval=digest(JSON.stringify([row.job.id,task.command,task.expiresAt,link.binding,p.scope,p.account,recipient,card.cardId,evt.messageId,ref,generation]));
          renewCreatorBinding(db,actual,this.now());
        });
      }
    }
  }
  private noPendingSave(db:AuthoringLedger,p:Presence,link:Link,work?:CreatorWork){
    if(!work)return;
    if(Object.values(db.operations).some(o=>o.scope===p.scope&&o.accountId===p.account&&o.binding===link.binding&&!o.revoked&&o.terminalAt===undefined&&
      (o.view.draftId===work.draftId||o.view.operationId===work.source?.preparationId)))throw denied();
    if(Object.values(db.handoffs??{}).some(h=>h.binding===link.binding&&h.draftId===work.draftId&&['selecting','awaitingAttestations'].includes(h.phase.state)))throw denied();
  }
  private currentJob(p:Presence,link:Link,id:string){
    return this.run(p,link,s=>{
      const row=s.jobs[id];
      if(!row||row.job.binding!==link.binding||row.job.scope!==p.scope)throw denied();
      return row;
    });
  }
  private async allowedJob(p:Presence,link:Link,id:string):Promise<Extract<CreatorReply,{kind:'creatorChecked'}>>{
    const row=await this.currentJob(p,link,id);
    await this.source(p,row.originWork);
    const mustCheckCard=row.job.task.kind==='read'&&row.job.task.read.kind==='page'||row.job.task.kind==='deliverCodes'||row.job.task.kind==='command'&&row.state==='active'&&row.job.task.expiresAt>this.now();
    const cardAvailable=!mustCheckCard||Boolean(row.messageId&&row.originalCardId&&await this.im.matches(row.messageId,link.recipient.chatId,row.originalCardId));
    await this.hooks.guard(p,link.recipient);
    return this.run(p,link,(s,_l,db)=>{
      const r=s.jobs[id];
      if(!r||r.state==='offer'||r.state==='finished'||row.originalCardId!==r.originalCardId||row.messageId!==r.messageId)throw denied();
      const {job}=r;
      switch(job.task.kind){
        case 'read':
          if(r.expiresAt<=this.now())throw denied();
          if(job.task.read.kind==='page'){
            const owner=r.previewOwner?s.jobs[r.previewOwner]:undefined;
            if(!cardAvailable||owner?.preview?.readId!==id||!this.livePreview(s,p,owner))throw denied();
          }
          if(job.task.read.kind==='draft')this.noPendingSave(db,p,link,job.task.read.work);
          return {kind:'creatorChecked',job,mode:'read'};
        case 'deliverCodes':
          if(!cardAvailable)throw denied();
          return {kind:'creatorChecked',job,mode:'delivery'};
        case 'command':
          if(!cardAvailable||r.state==='unknown'||job.task.expiresAt<=this.now())return {kind:'creatorChecked',job,mode:'receipt'};
          this.noPendingSave(db,p,link,workOf(job.task.command));
          return {kind:'creatorChecked',job,mode:'execute'};
      }
    });
  }
  async request(p:Presence,req:Exclude<CreatorRequest,{type:'creatorDiscover'|'creatorOpen'}>):Promise<CreatorReply>{
    if(!this.enabled)throw denied();
    const link=await this.hooks.guard(p);
    switch(req.type){
      case 'creatorContinue':this.hooks.interact(p);await this.selected(p,link,req.selection);break;
      case 'creatorPoll':{
        const {jobs,cards}=await this.run(p,link,(s,_l,db)=>{
          const now=this.now();
          for(const [id,r] of Object.entries(s.jobs)){
            if(r.job.task.kind==='read'&&r.job.task.read.kind==='page'){
              const owner=r.previewOwner?s.jobs[r.previewOwner]:undefined;
              if(!this.livePreview(s,p,owner)||owner?.preview?.readId!==id){
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
            this.addJob(p,link,s,{kind:'read',read:{kind:'draft',work}},'active',work);
          }
          for(const [id,time] of Object.entries(s.observed??{}))if(time+8*86400_000<=now)delete s.observed![id];
          const pending=Object.values(s.jobs).filter(r=>r.state==='active'||r.state==='unknown');
          const offset=this.pollOffset%Math.max(1,pending.length);
          const next=[...pending.slice(offset),...pending.slice(0,offset)].slice(0,16).map(r=>r.job);
          this.pollOffset=offset+next.length;
          return {jobs:next,
            cards:Object.values(s.cards).filter(c=>(!c.messageId||c.needsUpdate)&&c.session===p.session&&(!c.previewOwner||this.livePreview(s,p,s.jobs[c.previewOwner]))).slice(0,4)};
        });
        for(const c of cards){
          if(c.previewOwner)await this.redeliver(p,link,c).catch(()=>undefined);
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
    if(task.kind==='deliverCodes')throw denied();
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
      let card:Card|undefined;
      if(a.kind==='unknown'){
        if(task.kind!=='command')throw denied();
        if(r.state==='unknown'&&r.resultCard&&s.cards[r.resultCard]?.session===p.session)return;
        r.state='unknown';
        card=this.cards.approvalCard(p,s,r,true);r.resultCard=card.ref;return card;
      }
      if(a.kind==='rejected'&&task.kind==='read'&&task.read.kind==='page'){
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
          if(s.focusDraft===snap.work.draftId||!s.focusDraft&&Object.keys(s.sources).length===1){
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
      r.state='finished';r.answerDigest=answerDigest;r.resultCard=card?.ref;
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
      return card;
    });
    if(c)await this.display(p,link,c);
  }
}
