import {randomUUID} from 'node:crypto';
import {agentIdSchema,groupIdSchema,richFreezeInputSchema,type RecipeAuthoringRequest,type RecipeAuthoringReply,type AuthoringHandoff} from '@vonvon/protocol';
import type {z} from 'zod';
import {AuthoringJournal,linkKey,sameRecipient,selectCreatorBinding,selectCreatorOperation,type AuthoringLedger,type Link,type Recipient} from './authoring-journal';
import {AuthoringIm,candidateConfirmation} from './authoring-im';
import {groupSourceIdentity} from './authoring-source';
import {conversationSource,preparedRich,readRichSource,richSkillOptions,typedRichEdit,richCardReview,type RichLocalDraft} from './authoring-rich-flow';
import {candidateChanges,contentItems,emptySelection,handoffCard,hasLegacyMemoryChoices,selectedSource,setChoices,toggleChoice,viewHandoff,type ConversationCapture,type PrivateHandoff,type handoffClick} from './authoring-handoff-menu';
import {conversationInventory,inventorySummary,type InventoryOptions} from './conversation-inventory';
import {wireDigest} from './authoring-rich-snapshot';
import {safeEditValue} from '../../../../services/recipe-api/src/draft-model-text.mjs';

type Begin=Extract<RecipeAuthoringRequest,{type:'beginHandoff'|'beginDraftHandoff'}>;
type Restore=Extract<RecipeAuthoringRequest,{type:'restoreHandoff'}>;
type Answer=Extract<RecipeAuthoringRequest,{type:'answerHandoff'}>;
type Presence={session:string;account:string;scope:string;binding?:string};
type Target={rich:RichLocalDraft;sourceIdentity:string;draftId?:string;baseRevision?:number;instructionId:string;
  conversation?:true;handoff:{id:string;ref:string;groupId:string;generation:number;cardId?:string;messageId?:string};sourceCard?:{cardId:string;messageId:string;createdAt:number;seq:number}};
type Start=(target:Target)=>Promise<RecipeAuthoringReply>;
const changed=()=>new Error('身份或群来源已变化，请回到 App 重新准备。');
function bound(h:PrivateHandoff,p:Presence,link:Link){
  return h.account===p.account&&h.scope===p.scope&&h.binding===link.binding&&sameRecipient(h.recipient,link.recipient);
}
const active=(h:PrivateHandoff)=>h.phase.state==='selecting'||h.phase.state==='awaitingAttestations';
function rotate(h:PrivateHandoff){h.ref=randomUUID();h.generation++;h.cardDirty=true;}
function publicView(h:PrivateHandoff):AuthoringHandoff{
  const view=viewHandoff(h);
  if(active(h)&&(h.cardDirty||h.sentAt!==undefined&&!h.messageId))view.state='deliveryUnknown';
  return view;
}
export class PrivateHandoffs {
  constructor(private readonly native:InventoryOptions,private readonly ledger:AuthoringJournal,private readonly im:AuthoringIm,
    private readonly now:()=>number,private readonly live:(p:Presence,recipient?:Recipient)=>void){}
  private async transaction<T>(p:Presence,link:Link,id:string,edit:(h:PrivateHandoff)=>T){
    return this.ledger.run(db=>{
      this.live(p,link.recipient);
      const h=db.handoffs?.[id];
      const actual=db.links[linkKey(p.scope,p.account)];
      if(!h||!bound(h,p,link)||actual?.bot!==link.bot||actual.binding!==link.binding||!sameRecipient(actual.recipient,link.recipient))throw changed();
      return edit(h);
    });
  }
  private async save(p:Presence,link:Link,h:PrivateHandoff,previous:string,click?:PrivateHandoff,select?:(db:AuthoringLedger,actual:Link)=>void){
    return this.ledger.run(db=>{
      this.live(p,link.recipient);
      const actual=db.links[linkKey(p.scope,p.account)],row=db.handoffs?.[h.retryId];
      if(!actual||actual.bot!==link.bot||actual.binding!==link.binding||!sameRecipient(actual.recipient,link.recipient)||!row||!bound(row,p,actual)||
        row.ref!==previous||row.expiresAt<=this.now()||row.phase.state==='cancelled')throw changed();
      if(click&&(row.phase.state!=='selecting'||row.session!==p.session||row.generation!==click.generation||row.cardId!==click.cardId||row.messageId!==click.messageId))throw changed();
      if(select){
        if(!active(h)||h.session!==p.session)throw changed();
        select(db,actual);selectCreatorBinding(db,actual,this.now());
      }
      if(click&&h.phase.state==='awaitingAttestations')selectCreatorOperation(db,actual,this.now());
      Object.assign(row,h);
      if(!h.edit)delete row.edit;
      return row;
    });
  }
  private async identity(p:Presence,h:Pick<PrivateHandoff,'groupId'|'identity'>){
    const actual=await groupSourceIdentity(this.native.channel,this.native.bot,p.scope,h.groupId);
    this.live(p);
    if(actual!==h.identity)throw changed();
  }
  private async inventory(p:Presence,h:PrivateHandoff){
    await this.identity(p,h);
    const inv=h.conversation?(await conversationSource(this.native,p.scope,p.account,h.groupId)).inventory:
      await readRichSource(this.native,p.scope,p.account,h.groupId,h.selection.options);
    await this.identity(p,h);
    return inv;
  }
  private async choices(p:Presence,h:PrivateHandoff){
    if(h.edit){setChoices(h);return;}
    const inv=await this.inventory(p,h);
    h.selection.lease=inv.lease;
    const ids=new Set(contentItems(inv.content).map(i=>i.id));
    h.selection.selected=h.selection.selected.filter(id=>ids.has(id));
    const skills=['skills','files'].includes(h.selection.page)?await richSkillOptions(this.native,h.groupId):undefined;
    this.live(p);setChoices(h,inv,skills);
  }
  private async refresh(p:Presence,link:Link,h:PrivateHandoff){
    if(!h.cardId)return;
    this.live(p);
    const body=handoffCard(h);
    const result=await this.im.updateJson(h.cardId,h.generation,h.ref,body);
    if(result==='updated'||result==='conflict'&&h.messageId&&await this.im.showsJson(h.messageId,h.recipient.chatId,body)){
      await this.transaction(p,link,h.retryId,row=>{if(row.ref===h.ref)delete row.cardDirty;});
      delete h.cardDirty;return;
    }
    if(result==='unavailable')await this.transaction(p,link,h.retryId,row=>{if(row.ref===h.ref&&active(row)){row.phase={state:'needsReview'};delete row.edit;}});
    throw new Error('卡片尚未更新，请从 App 继续同一次准备。');
  }
  private async send(p:Presence,link:Link,h:PrivateHandoff){
    if(h.messageId){await this.refresh(p,link,h);return h;}
    if(!h.cardId){
      const cardId=await this.im.createJson(handoffCard(h));
      h=await this.transaction(p,link,h.retryId,row=>{if(row.ref!==h.ref||!active(row))throw changed();row.cardId=cardId;return row;});
    }else{
      const before=h.ref;
      rotate(h);h=await this.save(p,link,h,before);
      await this.refresh(p,link,h);
    }
    h=await this.transaction(p,link,h.retryId,row=>{if(row.ref!==h.ref||!active(row))throw changed();row.sentAt??=this.now();return row;});
    let messageId:string;
    try{messageId=await this.im.send(h.recipient.chatId,h.cardId!,h.sendUuid);}catch{return h;}
    return this.transaction(p,link,h.retryId,row=>{if(row.ref!==h.ref||!active(row))throw changed();row.messageId=messageId;return row;});
  }
  async begin(p:Presence,link:Link,r:Begin,creator=false){
    if(r.type==='beginHandoff'&&(!!r.sourceVersionId!==!!r.inherited||r.inherited&&(r.inherited.accountId!==p.account||r.inherited.versionId!==r.sourceVersionId||r.inherited.public.version!=='')))throw changed();
    const identity=await groupSourceIdentity(this.native.channel,this.native.bot,p.scope,r.groupId);
    if(r.type==='beginDraftHandoff'&&r.identity!==identity)throw changed();
    const conversation=r.type==='beginHandoff'&&r.conversation;
    const edit=r.type==='beginDraftHandoff'?{draftId:r.draftId,baseRevision:r.baseRevision,canonical:r.canonical,source:r.source}:undefined;
    let h=await this.ledger.run(db=>{
      this.live(p,link.recipient);
      const actual=db.links[linkKey(p.scope,p.account)];
      if(actual?.bot!==link.bot||actual.binding!==link.binding||!sameRecipient(actual.recipient,link.recipient))throw changed();
      const slots=db.handoffs??={};
      const previous=slots[r.retryId];
      if(previous){
        if(Boolean(previous.conversation)!==Boolean(conversation)||!bound(previous,p,link)||previous.identity!==identity||previous.groupId!==r.groupId||previous.draftId!==edit?.draftId||
          previous.sourceVersionId!==(r.type==='beginHandoff'?r.sourceVersionId:undefined)||wireDigest(previous.inherited??null)!==wireDigest(r.type==='beginHandoff'?r.inherited??null:null)||previous.edit&&wireDigest(previous.edit)!==wireDigest(edit))throw changed();
        return previous;
      }
      if(Object.values(slots).filter(x=>x.account===p.account&&x.expiresAt>this.now()).length>=60)throw new Error('本次准备次数已到上限，请稍后再试。');
      if(conversation){
        selectCreatorBinding(db,actual,this.now());
        for(const row of Object.values(slots))if(bound(row,p,link)&&row.conversation&&row.phase.state==='selecting')row.phase={state:'cancelled'};
      }
      if(!conversation&&Object.values(slots).some(x=>!x.conversation&&bound(x,p,link)&&active(x)&&(!creator||edit&&x.draftId===edit.draftId)))throw new Error('同一私聊已有配方准备，请先完成或取消。');
      if(!conversation&&Object.values(db.operations).some(op=>op.scope===p.scope&&op.accountId===p.account&&op.binding===link.binding&&op.terminalAt===undefined&&
        (edit?op.view.draftId===edit.draftId:!creator&&op.view.groupId===r.groupId)))throw new Error('这份配方已有进行中的私聊，请先在原卡片完成或取消。');
      return slots[r.retryId]={...(conversation&&{conversation:true as const}),...(creator&&!conversation&&{creator:true as const}),account:p.account,scope:p.scope,groupId:r.groupId,groupName:r.groupName,identity,binding:link.binding,recipient:link.recipient,
        ref:randomUUID(),generation:1,sendUuid:randomUUID(),session:p.session,retryId:r.retryId,expiresAt:this.now()+30*60_000,selection:emptySelection(),phase:{state:'selecting'},
        ...(edit&&{edit,draftId:edit.draftId,baseRevision:edit.baseRevision}),...(r.type==='beginHandoff'&&r.sourceVersionId&&{sourceVersionId:r.sourceVersionId,inherited:structuredClone(r.inherited)})} satisfies PrivateHandoff;
    });
    h=await this.transaction(p,link,h.retryId,row=>{if(row.ref!==h.ref)throw changed();return row;});
    return this.resumeExisting(p,link,h);
  }
  async capture(p:Presence,link:Link,input:ConversationCapture,guard:()=>void,start:Start){
    const {expectedSelection,requestId,public:description,access}=input;
    const groupId=groupIdSchema.parse(input.groupId);
    if(!requestId||requestId.length>256)throw changed();
    if(!safeEditValue(description))throw new Error('配方介绍包含敏感信息，请修改后再创建。');
    const capture={requestId,public:description,...(access&&{access}),...(input.reviewedScope&&{reviewedScope:input.reviewedScope})};
    const read=(db:AuthoringLedger)=>{
      guard();this.live(p,link.recipient);
      const actual=db.links[linkKey(p.scope,p.account)];
      if(actual?.bot!==link.bot||p.binding!==actual.binding||actual.binding!==link.binding||!sameRecipient(actual.recipient,link.recipient))throw changed();
      if(expectedSelection&&(actual.selectionOrder??0)!==expectedSelection.order)throw changed();
      const rows=Object.values(db.handoffs??{}).filter(row=>row.conversation&&bound(row,p,link));
      const prior=rows.find(row=>row.capture?.requestId===requestId);
      if(prior){
        if(prior.groupId!==groupId||wireDigest(prior.capture)!==wireDigest(capture)||expectedSelection&&
          (prior.identity!==expectedSelection.identity||expectedSelection.handoffId&&prior.retryId!==expectedSelection.handoffId))throw changed();
        return {prior};
      }
      const offer=actual.conversationProposal;
      if(!offer||!offer.shownAt||!offer.acceptedBy||offer.acceptedBy===offer.from||offer.expiresAt<=this.now()||offer.id!==requestId||
        offer.binding!==actual.binding||offer.order!==(actual.selectionOrder??0)||offer.groupId!==groupId||offer.identity!==expectedSelection.identity||
        offer.handoffId!==expectedSelection.handoffId||offer.access!==(access??'direct')||
        wireDigest(offer.public)!==wireDigest(description)||offer.lease!==input.reviewedScope.lease||
        wireDigest(offer.selected)!==wireDigest(input.reviewedScope.selected))throw changed();
      const selected=rows.filter(row=>row.phase.state==='selecting');
      if(selected.length>1)throw changed();
      const row=selected[0];
      if(row&&(row.groupId!==groupId||row.expiresAt<=this.now()||row.capture)||expectedSelection&&
        (expectedSelection.handoffId!==row?.retryId||row&&row.identity!==expectedSelection.identity))throw changed();
      return {row};
    };
    const result=(h:PrivateHandoff)=>this.ledger.run(db=>{
      const {prior}=read(db);
      if(prior?.retryId!==h.retryId)throw changed();
      if(prior.phase.state==='prepared'){
        const op=db.operations[prior.phase.operationId];
        if(!op?.conversation||op.revoked||op.accountId!==p.account||op.scope!==p.scope||op.binding!==link.binding||
          !sameRecipient(op.recipient,link.recipient)||op.originalGroup?.identity!==prior.identity||op.instructionId!==h.retryId||
          ['cancelPending','cancelled','expired','needsReview'].includes(op.view.state))throw changed();
        if(op.localDraftAcknowledged&&op.view.receipt?.status==='accepted')return {state:'saved' as const,draftId:op.view.receipt.draftId};
      }else if(prior.phase.state!=='awaitingAttestations')throw changed();
      return {state:'preparing' as const};
    });
    const first=await this.ledger.run(read);
    if(first.prior)return result(first.prior);
    const identity=await groupSourceIdentity(this.native.channel,this.native.bot,p.scope,groupId);
    if(first.row&&first.row.identity!==identity||expectedSelection&&expectedSelection.identity!==identity)throw changed();
    const {options,inventory}=await conversationSource(this.native,p.scope,p.account,groupId);
    const id=first.row?.retryId??randomUUID();
    const handoff:PrivateHandoff=first.row??{conversation:true,account:p.account,scope:p.scope,groupId,groupName:'',identity,binding:link.binding,
      recipient:link.recipient,session:p.session,retryId:id,expiresAt:this.now()+30*60_000,ref:randomUUID(),generation:1,sendUuid:randomUUID(),
      selection:emptySelection(),phase:{state:'selecting'}};
    handoff.selection.options=options;handoff.selection.lease=inventory.lease;
    const offered=contentItems(inventory.content).filter(item=>item.kind!=='publicText').map(item=>item.id);
    if(input.reviewedScope.lease!==inventory.lease||input.reviewedScope.selected.some(id=>!offered.includes(id)))throw changed();
    handoff.selection.selected=input.reviewedScope.selected;
    const {versions,items}=selectedSource(handoff,inventory);
    if(versions.length>64||items.some(v=>v.itemIds.length>512)||items.reduce((n,v)=>n+v.itemIds.length,0)>16000)throw new Error('群来源超过单份配方可核对的上限。');
    const request={retryId:id,ref:randomUUID(),generation:handoff.generation+1,lease:inventory.lease,versions,items};
    await this.identity(p,handoff);
    const current=await this.ledger.run(db=>{
      const {row,prior}=read(db);
      if(prior)return prior;
      if(row?.retryId!==first.row?.retryId||row?.ref!==first.row?.ref)throw changed();
      const slots=db.handoffs??={};
      if(!row&&Object.values(slots).filter(x=>x.account===p.account&&x.expiresAt>this.now()).length>=60)throw new Error('本次准备次数已到上限，请稍后再试。');
      return slots[id]={...handoff,session:p.session,capture,captureOrder:expectedSelection.order,ref:request.ref,generation:request.generation,phase:{state:'awaitingAttestations',request}};
    },guard);
    if(current.phase.state==='awaitingAttestations'&&!current.phase.request.versions.length&&current.ref===request.ref)
      await this.answer(p,link,{type:'answerHandoff',botId:agentIdSchema.parse(this.native.bot.appId),session:p.session,request,attestations:[]},start);
    return result(current);
  }
  async restore(p:Presence,link:Link,r:Restore):Promise<Extract<RecipeAuthoringReply,{kind:'handoff'|'handoffUnavailable'}>>{
    const read=(db:AuthoringLedger)=>{
      this.live(p);
      const row=db.handoffs?.[r.retryId];
      if(!row)return;
      const expected=r.expected;
      if(!bound(row,p,link)||row.groupId!==expected.groupId||row.draftId!==(expected.kind==='draft'?expected.draftId:undefined))throw changed();
      const op=row.phase.state==='prepared'?db.operations[row.phase.operationId]:undefined;
      if(expected.kind==='source'){
        if(row.sourceVersionId!==expected.sourceVersionId||wireDigest(row.inherited??null)!==wireDigest(expected.inherited??null))throw changed();
      }else{
        const revision=row.baseRevision??row.edit?.baseRevision??op?.view.baseRevision;
        if(revision===undefined)return {row,available:false};
        if(revision!==expected.baseRevision)throw changed();
      }
      if(row.phase.state==='prepared'){
        if(!op)return {row,available:false};
        if(op.accountId!==p.account||op.scope!==p.scope||op.bot!==link.bot||op.binding!==link.binding||!sameRecipient(op.recipient,link.recipient)||
          op.revoked||op.view.format!=='rich-v2'||op.instructionId!==row.retryId||
          op.originalGroup?.groupId!==row.groupId||op.originalGroup.identity!==row.identity||
          op.view.purpose!==(expected.kind==='draft'?'editDraft':'prepareDraft')||
          (expected.kind==='draft'?(op.view.draftId!==expected.draftId||op.view.baseRevision!==expected.baseRevision):op.view.groupId!==row.groupId))throw changed();
      }
      return {row,available:true};
    };
    const found=await this.ledger.run(read);
    const unavailable={kind:'handoffUnavailable',retryId:r.retryId,reason:'notFound'} as const;
    if(!found)return unavailable;
    try{
      await this.identity(p,found.row);
      if(!found.available)return unavailable;
      const current=await this.ledger.run(db=>{
        const retained=read(db);
        if(retained&&(retained.row.ref!==found.row.ref||!Object.values(db.links).some(l=>l.binding===link.binding&&sameRecipient(l.recipient,link.recipient))))throw changed();
        return retained;
      });
      if(!current?.available)return unavailable;
      return {kind:'handoff',handoff:await this.resumeExisting(p,link,current.row)};
    }catch(error){
      if(!await this.ledger.run(db=>Boolean(db.handoffs?.[r.retryId])))return unavailable;
      throw error;
    }
  }
  private async resumeExisting(p:Presence,link:Link,h:PrivateHandoff,select?:(db:AuthoringLedger,actual:Link)=>void){
    if(!active(h))return publicView(h);
    if(h.conversation){
      if(h.phase.state!=='selecting'||h.messageId)return publicView(h);
      let intro=h.introText;
      if(!intro){
        const header='已选好「'+h.groupName+'」。';
        intro=header+'回复“盘点这个群”，我会查看当前模型、技能、工具、沟通规则和任务，和你一起选出适合放进配方的内容。';
        if(this.native.groupSkills&&this.native.tasks){
          try{
            const inv=await conversationInventory(this.native,p,h.groupId);
            const core=inv.items.filter(i=>['role','rule','skill'].includes(i.kind)).slice(0,3).map(i=>i.label);
            const suggestion=core.length?'建议先从'+core.join('、')+'开始，这些项目定义了群的做法。':'建议先选跟使用场景直接相关的设置。';
            intro=header+'\n'+inventorySummary(inv)+'\n'+suggestion+'你想保留哪些？可以直接说“按推荐范围”或指定要增减的项目。';
          }catch{/* The linked human can retry discovery in the next private turn. */}
        }
      }
      h=await this.transaction(p,link,h.retryId,row=>{
        if(row.ref!==h.ref||row.phase.state!=='selecting')throw changed();
        row.introText??=intro;row.sentAt??=this.now();return row;
      });
      let messageId:string;
      try{messageId=await this.im.sendText(h.recipient.chatId,h.introText!,h.sendUuid);}
      catch{return publicView(h);}
      return publicView(await this.transaction(p,link,h.retryId,row=>{
        if(row.ref!==h.ref||row.phase.state!=='selecting')throw changed();
        row.messageId=messageId;return row;
      }));
    }
    if(hasLegacyMemoryChoices(h)){
      const before=h.ref;
      h.selection.options.includeBotMemories=false;
      if(h.edit)setChoices(h);
      else {h.phase={state:'needsReview'};h.selection.choices=[];}
      rotate(h);h=await this.save(p,link,h,before);
    }
    if(h.session!==p.session){
      if(!h.messageId&&h.sentAt!==undefined){h=await this.send(p,link,h);if(!h.messageId)return publicView(h);}
      const before=h.ref;
      rotate(h);h.session=p.session;h.phase={state:'selecting'};
      if(!h.edit&&h.selection.lease&&h.selection.lease!==(await this.inventory(p,h)).lease)h.phase={state:'needsReview'};
      else await this.choices(p,h);
      h=await this.save(p,link,h,before);
    }else if(!h.cardId){await this.choices(p,h);h=await this.save(p,link,h,h.ref);}
    if(select){const before=h.ref;if(h.phase.state==='selecting')rotate(h);h=await this.save(p,link,h,before,undefined,select);}
    return publicView(await this.send(p,link,h));
  }
  async continuePrivate(p:Presence,link:Link,id:string,select:(db:AuthoringLedger,actual:Link)=>void){
    const row=await this.transaction(p,link,id,h=>{if(!h.creator||!active(h)||h.expiresAt<=this.now())throw changed();return h;});
    await this.identity(p,row);
    return this.resumeExisting(p,link,row,select);
  }
  async status(p:Presence,link:Link,id:string,cancel:boolean){
    const h=await this.transaction(p,link,id,row=>{
      if(!cancel&&!row.conversation&&active(row)&&row.session!==p.session)throw new Error('请在 App 继续本次准备，重新核验本人私聊。');
      if(cancel&&active(row)){rotate(row);row.phase={state:'cancelled'};delete row.edit;}
      return row;
    });
    if(cancel&&h.phase.state==='cancelled')await this.refresh(p,link,h).catch(()=>undefined);
    return publicView(h);
  }
  pending(handoffs:Record<string,PrivateHandoff>|undefined,p:Presence,link:Link|undefined){
    if(!link)return;
    const row=Object.values(handoffs??{}).find(h=>(h.session===p.session||h.conversation&&p.binding===h.binding)&&bound(h,p,link)&&h.phase.state==='awaitingAttestations');
    return row?.phase.state==='awaitingAttestations'?row.phase.request:undefined;
  }
  private async start(p:Presence,link:Link,h:PrivateHandoff,rich:RichLocalDraft,start:Start){
    await this.identity(p,h);
    const reply=await start({rich,instructionId:h.retryId,sourceIdentity:h.identity,draftId:h.edit?.draftId,baseRevision:h.edit?.baseRevision,
      handoff:{id:h.retryId,ref:h.ref,groupId:h.groupId,generation:h.generation,cardId:h.cardId,messageId:h.messageId},...(h.conversation?{conversation:true as const}:{sourceCard:{cardId:h.cardId!,messageId:h.messageId!,createdAt:h.sentAt!,seq:h.generation}})});
    if(reply.kind!=='operation')throw changed();
    h.phase={state:'prepared',operationId:reply.operation.operationId};delete h.edit;
    return publicView(h);
  }
  async answer(p:Presence,link:Link,r:Answer,start:Start){
    const h=await this.transaction(p,link,r.request.retryId,row=>{
      if(row.conversation&&row.phase.state==='awaitingAttestations'&&p.binding===row.binding)row.session=p.session;
      return row;
    });
    if(h.session!==p.session||h.phase.state!=='awaitingAttestations'||h.ref!==r.request.ref||h.generation!==r.request.generation||wireDigest(h.phase.request)!==wireDigest(r.request)||
      (r.unavailable?r.attestations.length!==0:wireDigest(r.request.versions)!==wireDigest(r.attestations.map(v=>v.versionId).sort())))throw changed();
    if(r.unavailable){
      h.phase={state:'needsReview'};rotate(h);
      await this.save(p,link,h,r.request.ref);await this.refresh(p,link,h).catch(()=>undefined);
      return publicView(h);
    }
    try{
      if(h.sourceVersionId&&(!h.inherited||h.inherited.accountId!==p.account||h.inherited.versionId!==h.sourceVersionId))throw changed();
      const inv=await this.inventory(p,h);
      const {selected,versions,items}=selectedSource(h,inv);
      if(inv.lease!==h.phase.request.lease||wireDigest(versions)!==wireDigest(r.request.versions)||r.request.items&&wireDigest(items)!==wireDigest(r.request.items))throw changed();
      const rich=preparedRich({type:'richPrepare',botId:agentIdSchema.parse(this.native.bot.appId),session:p.session,groupId:h.groupId,attestations:r.attestations,
        selection:{options:h.selection.options,reviewToken:inv.lease,selected,sourceAttested:true,public:h.capture?.public??h.inherited?.public??{name:'',summary:'',overview:'',version:''},setup:[],access:h.capture?.access??h.inherited?.access??'direct',
          ...(h.inherited?.logo&&{logo:h.inherited.logo}),
          ...(h.sourceVersionId&&{sourceVersionId:h.sourceVersionId})}},inv,p.account);
      rich.privateSelection=true;
      if(h.inherited)rich.inheritedVersionId=h.inherited.versionId;
      if(h.conversation){
        if(!h.capture)throw changed();
        richFreezeInputSchema.parse(rich.request);
        return await this.start(p,link,h,rich,start);
      }
      const details=richCardReview({view:{operationId:h.retryId},rich});
      if(!details||!candidateConfirmation(h.ref,details)){
        h.phase={state:'selecting'};rotate(h);
        await this.save(p,link,h,r.request.ref);await this.refresh(p,link,h);
        await this.im.reply(link.recipient.chatId,h.messageId!,'所选内容超过确认卡容量，请减少所选项目后再确认。');
        return publicView(h);
      }
      return await this.start(p,link,h,rich,start);
    }catch(error){
      const current=await this.transaction(p,link,h.retryId,row=>{
        if(row.ref===r.request.ref&&row.phase.state==='awaitingAttestations'){row.phase={state:'needsReview'};rotate(row);}
        return row;
      });
      if(current.phase.state==='needsReview')await this.refresh(p,link,current).catch(()=>undefined);
      throw error;
    }
  }
  async action(p:Presence,link:Link,recipient:Recipient,messageId:string,click:z.infer<typeof handoffClick>,start:Start,interact:()=>void){
    let h=await this.ledger.run(db=>Object.values(db.handoffs??{}).find(x=>x.ref===click.ref&&bound(x,p,link)&&x.session===p.session&&x.phase.state==='selecting'&&x.generation===click.generation));
    if(!h||!sameRecipient(h.recipient,recipient)||!h.cardId||h.sentAt===undefined||h.messageId&&h.messageId!==messageId)return;
    if(!await this.im.matches(messageId,recipient.chatId,h.cardId))return;
    interact();
    if(!h.messageId)h=await this.transaction(p,link,h.retryId,row=>{if(row.ref!==click.ref)throw changed();row.messageId=messageId;return row;});
    const clicked=structuredClone(h);
    if(click.action==='cancel'){await this.status(p,link,h.retryId,true);return;}
    try{
      await this.identity(p,h);
      if(!h.edit&&h.selection.lease!==(await this.inventory(p,h)).lease){
        h.phase={state:'needsReview'};rotate(h);await this.save(p,link,h,click.ref);await this.refresh(p,link,h);return;
      }
      if(click.action==='finish'&&h.edit){
        const edit=h.edit,changes=candidateChanges(h);
        const rich=typedRichEdit({type:'richEdit',botId:agentIdSchema.parse(this.native.bot.appId),session:p.session,...edit,selected:h.selection.selected,...(changes.length&&{changes})});
        if(!h.selection.selected.length&&!changes.length&&!rich.request)throw new Error('请先选择要修改的草稿内容。');
        await this.start(p,link,h,rich,start);return;
      }
      if(click.action==='finish'){
        const inv=await this.inventory(p,h);
        if(h.selection.lease!==inv.lease)throw changed();
        const {versions,items}=selectedSource(h,inv);
        if(versions.length>64||items.some(v=>v.itemIds.length>512)||items.reduce((n,v)=>n+v.itemIds.length,0)>16000)
          throw new Error('本次选择涉及过多来源，请减少所选项目。');
        rotate(h);
        h.phase={state:'awaitingAttestations',request:{retryId:h.retryId,ref:h.ref,generation:h.generation,lease:inv.lease,versions,items}};
      }else{
        toggleChoice(h,click);await this.choices(p,h);rotate(h);
      }
      await this.save(p,link,h,click.ref,clicked);await this.refresh(p,link,h);
    }catch(error){
      this.live(p);
      await this.im.reply(recipient.chatId,messageId,error instanceof Error&&/^(请选择|请先|本次选择|所选内容超过|每次最多)/.test(error.message)?error.message:'来源或卡片暂时无法核对，请从 App 继续本次准备。');
    }
  }
}
