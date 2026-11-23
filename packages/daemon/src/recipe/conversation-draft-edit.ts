import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import {draftScopeItemSchema,type CreatorAnswer,type CreatorJob,type CreatorWork,type DraftScopeApply,type RecipeAuthoringReply,type RecipeAuthoringRequest} from '@vonvon/protocol';
import {safeEditValue} from '../../../../services/recipe-api/src/draft-model-text.mjs';
import {contentItems} from './authoring-handoff-menu';
import {AuthoringIm} from './authoring-im';
import {linkKey,sameRecipient,type AuthoringJournal,type AuthoringLedger,type Link,type Recipient} from './authoring-journal';
import {conversationSource} from './authoring-rich-flow';
import {itemsOf,selectedRichContent,wireDigest} from './authoring-rich-snapshot';
import type {AuthoringOptions,Presence} from './authoring-service';
import {sourceIdentityOf} from './authoring-source';

type Task=Extract<CreatorJob['task'],{kind:'draftScopeRead'|'draftScopeApply'}>;
type Job=Omit<CreatorJob,'task'>&{task:Task};
type Result=Extract<CreatorAnswer,{kind:'draftScopeHead'|'saved'|'rejected'}>;
export interface EditJob {job:Job;order:number;expires:number;result?:Result}
export interface ConversationEditState {
  readId?:string;readFor?:string;
  proposal?:{id:string;work:CreatorWork;order:number;thread?:string;from:string;expires:number;shown?:number;acceptedBy?:string;
    inventoryId:string;addIds:string[];removeIds:string[];revision:number;baseSha256:string;lease:string};
}
type Context={opts:AuthoringOptions;journal:AuthoringJournal;p:Presence;work:CreatorWork;recipient:Recipient;messageId:string;
  threadId?:string;sentAt:number;acceptsScope:boolean;stopAt:number;signal?:AbortSignal;check:(db:AuthoringLedger)=>Link;guard:()=>void;now:()=>number};
type Query={action:string;proposalId?:string;inventoryId?:string;addIds?:string[];removeIds?:string[]};
const ttl=30*60_000;
const changed=()=>new Error('草稿、来源群或当前修改提案已变化，请重新盘点原草稿。');
function requireLink(c:Context,db:AuthoringLedger){
  c.guard();const link=c.check(db),source=link.creator?.sources?.[c.work.draftId];
  if(!c.work.source||link.binding!==c.p.binding||!sameRecipient(c.recipient,link.recipient)||source!==undefined&&!isDeepStrictEqual(source,c.work.source))throw changed();
  return link;
}
async function waitJob(c:Context,id:string){
  do{
    const row=await c.journal.run(db=>requireLink(c,db).conversationEditJobs?.[id]);
    if(!row||row.expires<=c.now()||row.result?.kind==='rejected')throw changed();
    if(row.result)return row.result;
    if(Date.now()+150>=c.stopAt)return;
    await delay(150,undefined,{signal:c.signal});
  }while(true);
}
async function loadSource(c:Context){
  const source=c.work.source;if(!source)throw changed();
  const {inventory,row}=await conversationSource(c.opts,c.p.scope,c.p.account,source.groupId);
  if(sourceIdentityOf(c.p.scope,row)!==source.identity)throw changed();
  c.guard();
  return inventory;
}
function queue(link:Link,id:string,task:Task,expires:number,p:Presence){
  const jobs=link.conversationEditJobs??={};
  if(Object.keys(jobs).length>=96)throw new Error('当前草稿操作过多，请稍后再试。');
  jobs[id]={job:{id,scope:p.scope,binding:link.binding,task},order:link.selectionOrder??0,expires};
}
export async function conversationDraftEdit(c:Context,q:Query){
  if(!c.p.draftScope)throw new Error('请更新当前 Vonvon App 和来源设备，再在私聊修改草稿范围。');
  if(!c.work.source)throw changed();
  if(q.action==='apply'){
    const proposal=await c.journal.run(db=>{
      const link=requireLink(c,db),offer=link.conversationEdit?.proposal;
      if(!offer||offer.id!==q.proposalId||!offer.shown||offer.expires<=c.now()||offer.order!==(link.selectionOrder??0)||
        offer.thread!==c.threadId||!isDeepStrictEqual(offer.work,c.work))throw changed();
      return offer;
    });
    if(!proposal.acceptedBy&&(!c.acceptsScope||c.messageId===proposal.from||c.sentAt<proposal.shown!))
      return {state:'awaitingConfirmation',proposalId:proposal.id,message:'请作者在下一条私聊中明确回复“确认这个范围，保存修改”。'};
    const queued=await c.journal.run(db=>Boolean(requireLink(c,db).conversationEditJobs?.[proposal.id]));
    if(!queued){
      const inventory=await loadSource(c);
      if(inventory.lease!==proposal.lease)throw changed();
      const rows=contentItems(inventory.content),ids=new Set(proposal.addIds);
      for(const item of rows)if(item.parent&&proposal.addIds.includes(item.parent))ids.add(item.id);
      for(const item of rows)if(item.kind==='file'&&ids.has(item.id)&&item.parent){
        const skill=inventory.content.skills.find(s=>s.itemId===item.parent);
        if(!skill)throw changed();ids.add(skill.itemId);ids.add(skill.entryFileId);
      }
      const donor=selectedRichContent(inventory.content,[...ids]);
      if(!safeEditValue(donor))throw changed();
      const evidence:DraftScopeApply['evidence']={};
      for(const item of itemsOf(donor)){
        const proof=inventory.evidence.get(item.itemId);
        if(!proof||proof.kind==='unresolved')throw changed();
        evidence[item.itemId]=proof.kind==='managed'?{kind:'managed',parents:[...proof.parents]}:proof;
      }
      await c.journal.run(db=>{
        const link=requireLink(c,db),current=link.conversationEdit?.proposal;
        if(current?.id!==proposal.id||current.order!==(link.selectionOrder??0)||current.expires<=c.now())throw changed();
        if(!link.conversationEditJobs?.[current.id])queue(link,current.id,{kind:'draftScopeApply',work:c.work,revision:current.revision,baseSha256:current.baseSha256,
          addIds:current.addIds,removeIds:current.removeIds,donor,evidence,lease:inventory.lease},c.now()+24*60*60_000,c.p);
        current.acceptedBy??=c.messageId;
      },c.guard);
    }
    const answer=await waitJob(c,proposal.id);
    return answer?.kind==='saved'?{state:'saved',draftId:c.work.draftId,revision:answer.revision}:
      {state:'preparing',draftId:c.work.draftId,proposalId:proposal.id};
  }
  const requestId=await c.journal.run(db=>{
    const link=requireLink(c,db),state=link.conversationEdit??={};
    const readFor=wireDigest([c.work,c.messageId,link.selectionOrder??0]);
    if(state.readFor===readFor&&state.readId&&link.conversationEditJobs?.[state.readId])return state.readId;
    const id=randomUUID();queue(link,id,{kind:'draftScopeRead',work:c.work},c.now()+ttl,c.p);
    state.readFor=readFor;state.readId=id;return id;
  },c.guard);
  const answer=await waitJob(c,requestId);
  if(!answer)return {state:'reading',draftId:c.work.draftId,message:'App 正在读取当前修订，请稍后再盘点。'};
  if(answer.kind!=='draftScopeHead')throw changed();
  const head=answer.head,inventory=await loadSource(c);
  const current=head.items,known=new Set(current.map(i=>i.id));
  const entries=new Set(inventory.content.skills.map(s=>s.entryFileId));
  const available=contentItems(inventory.content).filter(item=>!known.has(item.id)&&safeEditValue(item.label)&&inventory.evidence.get(item.id)?.kind!=='unresolved'&&
    (item.kind!=='file'||!entries.has(item.id)&&!!item.parent&&known.has(item.parent)))
    .flatMap(item=>{const result=draftScopeItemSchema.safeParse({id:item.id,kind:item.kind,label:item.label,...(item.parent&&{parent:item.parent})});return result.success?[result.data]:[];});
  const inventoryId=wireDigest([c.work,head,inventory.lease,available]);
  if(q.action==='inventory')return {state:'ready',draftId:c.work.draftId,revision:head.revision,inventoryId,current,available};
  const addIds=[...new Set(q.addIds??[])].sort(),removeIds=[...new Set(q.removeIds??[])].sort();
  if(q.action!=='propose'||q.inventoryId!==inventoryId||!addIds.length&&!removeIds.length||
    addIds.some(id=>!available.some(i=>i.id===id))||removeIds.some(id=>!known.has(id)))throw changed();
  const offer=await c.journal.run(db=>{
    const link=requireLink(c,db),state=link.conversationEdit??={},prior=state.proposal;
    if(prior?.from===c.messageId&&prior.inventoryId===inventoryId&&prior.thread===c.threadId&&prior.order===(link.selectionOrder??0)&&
      isDeepStrictEqual(prior.addIds,addIds)&&isDeepStrictEqual(prior.removeIds,removeIds))return prior;
    delete link.conversationProposal;
    return state.proposal={id:randomUUID(),work:c.work,order:link.selectionOrder??0,thread:c.threadId,from:c.messageId,expires:c.now()+ttl,
      revision:head.revision,baseSha256:head.baseSha256,inventoryId,lease:inventory.lease,addIds,removeIds};
  },c.guard);
  if(!offer.shown){
    const adds=available.filter(i=>addIds.includes(i.id)).map(i=>{
      const skill=inventory.content.skills.find(s=>s.itemId===i.id);
      const files=skill?inventory.content.files.filter(f=>skill.fileIds.includes(f.itemId)).map(f=>f.name):[];
      return '• '+i.label+(files.length?'\n  '+files.join('\n  '):'');
    });
    const removals=current.filter(i=>removeIds.includes(i.id)&&(!i.parent||!removeIds.includes(i.parent))).map(i=>
      '• '+i.label+(i.kind==='skill'?'（含该技能的文件）':''));
    const message=['修改已有私人草稿 · 修订 '+head.revision,adds.length&&'加入\n'+adds.join('\n'),removals.length&&'移除\n'+removals.join('\n'),
      '确认后保存到同一份草稿。请回复“确认这个范围，保存修改”。'].filter(Boolean).join('\n\n');
    if(Buffer.byteLength(message)>20_000)throw changed();
    c.guard();await new AuthoringIm(c.opts.channel).sendText(c.recipient.chatId,message,offer.id);
    await c.journal.run(db=>{const current=requireLink(c,db).conversationEdit?.proposal;if(current?.id!==offer.id)throw changed();current.shown??=c.now();},c.guard);
  }
  return {state:'awaitingConfirmation',draftId:c.work.draftId,revision:head.revision,proposalId:offer.id};
}
type Request=Extract<RecipeAuthoringRequest,{type:'creatorCheck'|'creatorAnswer'|'creatorPoll'}>;
export async function editJobRequest(journal:AuthoringJournal,p:Presence,req:Request,now:()=>number,guard:()=>void,opts:AuthoringOptions):Promise<RecipeAuthoringReply|undefined>{
  const read=(db:AuthoringLedger)=>{
    guard();const link=db.links[linkKey(p.scope,p.account)];
    if(!link||link.binding!==p.binding||!p.binding)throw changed();
    return link;
  };
  if(req.type==='creatorPoll'){
    const jobs=await journal.run(db=>{const link=read(db);return Object.values(link.conversationEditJobs??{}).filter(j=>j.order===(link.selectionOrder??0)&&!j.result&&j.expires>now()).slice(0,4).map(j=>j.job);});
    return {kind:'creatorJobs',jobs};
  }
  const original=await journal.run(db=>read(db).conversationEditJobs?.[req.id]);
  if(!original)return;
  const row=original,task=row.job.task;
  const assert=(link:Link)=>{
    guard();
    if(row.job.binding!==link.binding||row.job.scope!==p.scope||row.order!==(link.selectionOrder??0)||row.expires<=now())throw changed();
  };
  if(req.type==='creatorCheck'){
    let mode:'read'|'execute'|'receipt'=task.kind==='draftScopeRead'?'read':'execute';
    if(task.kind==='draftScopeApply'){
      mode='receipt';
      if(!row.result&&task.work.source){
        try{
          const {row:source,inventory}=await conversationSource(opts,p.scope,p.account,task.work.source.groupId);
          if(sourceIdentityOf(p.scope,source)===task.work.source.identity&&inventory.lease===task.lease)mode='execute';
        }catch{guard();}
      }
    }
    await journal.run(db=>assert(read(db)));
    return {kind:'creatorChecked',job:row.job,mode};
  }
  if(req.answer.kind==='rejected'||task.kind==='draftScopeRead'&&req.answer.kind==='draftScopeHead'&&isDeepStrictEqual(req.answer.work,task.work)||
    task.kind==='draftScopeApply'&&req.answer.kind==='saved'&&isDeepStrictEqual(req.answer.work,task.work)&&req.answer.revision===task.revision+1){
    const result=req.answer as Result;
    await journal.run(db=>{
      const link=read(db);assert(link);const current=link.conversationEditJobs?.[req.id];if(!current||current.result&&!isDeepStrictEqual(current.result,result))throw changed();
      current.result=result;
    },guard);
    return {kind:'creatorAck'};
  }
  throw changed();
}
