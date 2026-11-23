import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';
import type {RecipePublic} from '@vonvon/protocol';
import {assertBotIdentity} from '../config/bots';
import {botPaths} from '../config/paths';
import {isAdmin} from '../config/schema';
import {listProjectsIn} from '../project/registry';
import {authoringBotKey, linkKey, sameRecipient, selectCreatorBinding, type AuthoringJournal, type AuthoringLedger, type Link, type Recipient} from './authoring-journal';
import type {AuthoringOptions, AuthoringSession} from './authoring-service';
import {atSource,exportableRecipeGroup,sourceIdentityOf} from './authoring-source';
import {chooseScope,conversationInventory,inventoryPage,scopeReview,type ConversationProposal} from './conversation-inventory';
import {draftTargets,renameIntent,renameReceipt,type RenameIntent} from './conversation-draft-target';
import {inventoryAlias} from './authoring-rich-inventory';
import {AuthoringIm} from './authoring-im';
import type {InventoryCategory} from '../agent/entry/recipe-creation-tools';
import {materialContent,materialReview,type MaterialInput} from './conversation-material';
import type {ResourceCaller} from './resource-context';

type Wait = {signal:AbortSignal; notAfter:number};
export type ConversationDraftEditAction={action:'inventory';draftId?:string}|{action:'propose';draftId?:string;inventoryId:string;addIds:string[];removeIds:string[]}|{action:'apply';draftId?:string;proposalId?:string};
export type ConversationDraftAction={action:'inspect'|'preview'|'edit'|'publish';draftId?:string;change?:{field:'name'|'summary'|'overview'|'version'|'access';value:string}};
export type RecipeCreationQuery = (
  {kind:'material';action:'propose';material:MaterialInput} | {kind:'material';action:'create';proposalId:string} | {kind:'sources';offset?:number} | {kind:'inventory';groupId:string;category?:InventoryCategory;offset?:number} |
  {kind:'propose';groupId:string;inventoryId:string;selectedIds:string[];switchFromGroupId?:string;public:Omit<RecipePublic,'access'>;access?:RecipePublic['access']} |
  {kind:'create';proposalId:string} | {kind:'status'} | ({kind:'draft'} & (ConversationDraftAction|ConversationDraftEditAction|{action:'list';offset?:number}))
) & {wait?:Wait};
export function confirmsConversationScope(text:string,editing=false){
  const reply=text.trim().replace(/[。！!]+$/u,'').replace(/^(?:好(?:的)?|没问题|可以)[，,、 ]+/u,'');
  const scope='(?:(?:上面|以上|上述|这个|这份|当前|所选|刚才|你推荐的?|推荐的?)(?:的|推荐的?)?)?(?:范围|方案|内容|选择|配置|这几项)';
  const use='(?:就|请)?按(?:照)?';
  const write=editing?'(?:保存|采用|提交)(?:这次|当前|本次)?修改':'(?:创建|生成|保存|建立|建)(?:成|这份|私人|本地)?草稿';
  const confirmed=new RegExp('^(?:(?:确认|同意|确定)(?:按|采用|使用)?'+scope+'(?:[，,、 ]*(?:现在|请)?'+write+')?|(?:确认|同意)[，,、 ]*(?:现在|请)?'+write+'|'+
    use+'(?:'+scope+'|你推荐的|上面推荐的|刚才选的|推荐的)[，,、 ]*(?:'+write+'|保存))$','u');
  const english=editing?/^(?:I )?(?:confirm|approve) (?:this|the proposed) scope(?: and save (?:these|the) changes)?$/i:
    /^(?:I )?(?:confirm|approve) (?:this|the proposed) scope(?: and (?:create|save) (?:the|this) draft)?$/i;
  return confirmed.test(reply)||english.test(reply);
}
type Account = {key:string;binding:string;order:number};
type Selected = {id:string;groupId:string;name:string;identity:string;expiresAt:number};
type Selection = {materialProposalId?:string;account?:Account;selected?:Selected;proposalId?:string;editProposalId?:string;receiptResource?:string;ambiguous?:true};
type Turn = Selection & {recipient:Recipient;expires:number;authoring:boolean;rename?:RenameIntent;acceptsScope:boolean;acceptsEditScope:boolean;sentAt:number;threadId?:string;sessionId?:string};
const ttl = 30*60_000;
const denied = () => new Error('本次私聊的账号、来源或授权已改变。请在 App 选择当前来源，再发一条消息。');
const offline = {state:'offline',message:'请打开 Vonvon App，登录原账号并连接来源设备，然后在本私聊继续。'} as const;

function reviewPages(text:string){
  const pages:string[]=[];
  let page='',bytes=0;
  for(const char of text){
    const size=Buffer.byteLength(char);
    if(bytes+size>18_000){pages.push(page);page='';bytes=0;}
    page+=char;bytes+=size;
  }
  if(page)pages.push(page);
  return pages;
}

function conversationReceipt(db:AuthoringLedger,bot:string,account:Account,turn:Turn,id?:string,includePublication=false) {
  const rows=Object.values(db.handoffs??{}).filter(h=>h.conversation&&h.capture&&h.binding===account.binding&&
    linkKey(h.scope,h.account)===account.key&&sameRecipient(h.recipient,turn.recipient)&&
    (!id||h.capture.requestId===id)&&(!turn.selected||h.retryId===turn.selected.id));
  const resourceTarget=turn.receiptResource&&db.resources?.[turn.receiptResource]?.active?.target;
  const publications=includePublication?Object.values(db.links[account.key]?.creator?.jobs??{}).reverse().flatMap(job=>{
    const result=job.result,task=job.job.task;
    if(job.state!=='finished'||job.job.binding!==account.binding||result?.kind!=='published'||task.kind!=='command'||task.command.kind!=='publish')return [];
    const snap=task.command.snapshot;
    if(snap.work.draftId!==result.draftId||snap.revision!==result.draftRevision||resourceTarget&&!isDeepStrictEqual(result.target,resourceTarget))return [];
    return [{scope:job.job.scope,source:snap.work.source,receipt:{operation:'publishDraft' as const,state:'published' as const,draftId:result.draftId,
      name:snap.public.name,version:snap.public.version,draftRevision:result.draftRevision,releaseRevision:result.revision,target:result.target}}];
  }):[];
  // Handoffs retain insertion order across journal writes. A selected App handoff takes precedence over history.
  const last=resourceTarget?rows.reverse().find(({phase,scope})=>phase.state==='prepared'&&publications.some(p=>p.scope===scope&&p.source?.preparationId===phase.operationId)):rows.at(-1);
  if(!last)return;
  if(last.phase.state==='expired'||last.phase.state==='cancelled'||last.phase.state==='needsReview')return {state:last.phase.state};
  if(last.phase.state==='prepared'){
    const op=db.operations[last.phase.operationId];
    if(!op?.conversation||op.revoked||op.bot!==bot||op.binding!==last.binding||op.scope!==last.scope||
      op.accountId!==last.account||!sameRecipient(op.recipient,turn.recipient)||op.instructionId!==last.retryId)throw denied();
    if(op.localDraftAcknowledged&&op.view.receipt?.status==='accepted'){
      const draftId=op.view.receipt.draftId;
      const published=publications.find(p=>p.scope===op.scope&&p.source?.preparationId===op.view.operationId&&p.receipt.draftId===draftId);
      if(published)return published.receipt;
      return {operation:'createDraft' as const,state:'saved' as const,draftId,nameAtCreation:last.capture!.public.name,versionAtCreation:last.capture!.public.version,
        revisionAtCreation:op.view.receipt.revision,groupId:last.groupId,message:'这是初次创建的本地回执。若要说明现在的名称和修订，请按此 draftId 用 recipe_author_draft 的 inspect 读取。'};
    }
    if(op.view.state==='cancelled'||op.view.state==='expired'||op.view.state==='needsReview')return {state:op.view.state};
    if(op.view.state==='cancelPending')return {state:'cancelled' as const};
  }
  return {state:'preparing' as const};
}

export class ConversationAuthoring {
  private readonly bot:string;
  private readonly turns=new Map<string,Turn>();
  private readonly inventories=new Map<string,{identity:string;view:Awaited<ReturnType<typeof conversationInventory>>}>();
  constructor(private readonly opts:AuthoringOptions,private readonly journal:AuthoringJournal,private readonly now:()=>number,
    private readonly peers:(key:string,binding:string)=>AuthoringSession[]) {
    this.bot=authoringBotKey(opts.bot);
  }
  selection(db:AuthoringLedger,recipient:Recipient,readReceipt=false):Selection {
    const own=Object.entries(db.links).filter(([,link])=>link.bot===this.bot&&sameRecipient(link.recipient,recipient));
    const chosen=own.filter(([,link])=>(link.creator?.chosenUntil??0)>this.now());
    let candidate=chosen.length===1?chosen[0]:chosen.length===0&&own.length===1?own[0]:undefined;
    let receiptResource:string|undefined;
    if(!candidate&&readReceipt&&!chosen.length&&own.length>1){
      const focused=Object.values(db.resources??{}).filter(r=>r.bot===this.bot&&r.focus&&r.delivery==='sent'&&r.active&&r.expires>this.now()&&sameRecipient(r.recipient,recipient));
      if(focused.length===1){
        const r=focused[0]!;
        candidate=own.find(([key,l])=>key===linkKey(r.scope,r.account)&&l.binding===r.binding);
        if(candidate)receiptResource=r.requestId;
      }
    }
    if(!candidate)return own.length?{ambiguous:true}:{};
    if(own.some(([,l])=>(l.selectionOrder??0)>(candidate[1].selectionOrder??0)))return {ambiguous:true};
    const [key,link]=candidate;
    const handoffs=Object.values(db.handoffs??{}).filter(h=>h.conversation&&h.phase.state==='selecting'&&h.expiresAt>this.now()&&
      linkKey(h.scope,h.account)===key&&h.binding===link.binding&&sameRecipient(h.recipient,recipient));
    if(handoffs.length>1)return {ambiguous:true};
    const h=handoffs[0];
    const offer=link.conversationProposal;
    const proposalId=offer?.shownAt&&offer.binding===link.binding&&offer.order===(link.selectionOrder??0)&&offer.expiresAt>this.now()?offer.id:undefined;
    const edit=link.conversationEdit?.proposal;
    const editProposalId=edit?.shown&&edit.order===(link.selectionOrder??0)&&edit.expires>this.now()?edit.id:undefined;
    const material=link.materialProposal;
    const materialProposalId=material?.shownAt&&material.binding===link.binding&&material.order===(link.selectionOrder??0)&&material.expiresAt>this.now()?material.id:undefined;
    return {materialProposalId,account:{key,binding:link.binding,order:link.selectionOrder??0},proposalId,editProposalId,receiptResource,
      ...(h&&{selected:{id:h.retryId,groupId:h.groupId,name:h.groupName,identity:h.identity,expiresAt:h.expiresAt}})};
  }
  remember(messageId:string,recipient:Recipient,selection:Selection,authoring:boolean,threadId?:string,text='',sentAt=0) {
    const now=this.now();
    for(const [id,turn] of this.turns)if(turn.expires<=now)this.turns.delete(id);
    const existing=this.turns.get(messageId);
    if(existing)return existing.authoring;
    const previous=[...this.turns.values()].reverse().find(t=>sameRecipient(t.recipient,recipient)&&t.threadId===threadId);
    const expiry=authoring?now+ttl:previous?.authoring?previous.expires:now+ttl;
    authoring ||= Boolean(previous?.authoring&&isDeepStrictEqual(previous.account,selection.account)&&previous.selected?.id===selection.selected?.id);
    if(this.turns.size>=1024)this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(messageId,{...selection,recipient,authoring,threadId,rename:renameIntent(text,isDeepStrictEqual(selection.account,previous?.account)?previous?.rename:undefined),acceptsScope:confirmsConversationScope(text),acceptsEditScope:confirmsConversationScope(text,true),sentAt,expires:Math.min(expiry,selection.selected?.expiresAt??Infinity)});
    return authoring;
  }
  active(messageId:string){const turn=this.turns.get(messageId);return turn&&turn.expires>this.now()&&turn.authoring;}
  close(){this.turns.clear();this.inventories.clear();}

  private async worker(account:Account,messageId:string,checkLink:(db:AuthoringLedger)=>Link,guard:()=>void,stopAt:number,signal?:AbortSignal) {
    const active=()=>this.peers(account.key,account.binding);
    let peers=active();
    if(!peers.length){
      await this.journal.run(db=>{
        const link=checkLink(db);
        if(!link.wake||link.wake.expiresAt<=this.now()){
          link.wake={id:randomUUID(),intent:'conversation',messageId,expiresAt:this.now()+300_000};
        }
      },guard);
      const wakeUntil=Math.min(stopAt,Date.now()+20_000);
      while(!peers.length&&Date.now()+300<wakeUntil){
        await delay(300,undefined,{signal});guard();peers=active();
      }
    }
    if(peers.length>1)throw new Error('同一来源有多个 App 连接。请在 App 保留本次创作使用的连接，再重试。');
    return peers[0];
  }

  async tool(get:()=>ResourceCaller|undefined,query:RecipeCreationQuery) {
    const caller=get(),turn=caller&&this.turns.get(caller.messageId);
    if(!caller||!turn)throw denied();
    const guard=()=>{
      query.wait?.signal.throwIfAborted();
      if(this.turns.get(caller.messageId)!==turn||turn.expires<=this.now()||!isDeepStrictEqual(get(),caller)||
        caller.openId!==turn.recipient.openId||caller.chatId!==turn.recipient.chatId||
        turn.sessionId!==caller.sessionId||!isAdmin(this.opts.cfg,caller.openId))throw denied();
    };
    turn.sessionId??=caller.sessionId;
    guard();await (this.opts.currentBot?.()??assertBotIdentity(this.opts.bot));guard();
    const checkAccount=(db:AuthoringLedger)=>{
      guard();
      const current=this.selection(db,turn.recipient,!!turn.receiptResource);
      if(!isDeepStrictEqual(current.account,turn.account)||current.ambiguous!==turn.ambiguous||current.receiptResource!==turn.receiptResource)throw denied();
      return current;
    };
    const initial=await this.journal.run(checkAccount);
    if(!initial.account)return initial.ambiguous?
      {state:'chooseAccount',message:'有多个账号或来源。请在希望使用的账号打开 App，点创作配方并选择资料创作或来源群，再回到这里。'}:
      {state:'unlinked',message:'请在 Vonvon App 登录，点创作配方、选择资料创作或来源群，按提示将当前 Bot 与本人飞书私聊关联。'};
    const account=initial.account;
    const id=query.kind==='create'&&!turn.receiptResource?query.proposalId:undefined;
    const readStatus=(db:AuthoringLedger)=>{
      checkAccount(db);
      return conversationReceipt(db,this.bot,account,turn,id,query.kind==='status'||!!turn.receiptResource);
    };
    const stopAt=Math.min(Date.now()+55_000,(query.wait?.notAfter??Date.now())-1200);
    const receipt=async()=>{
      let result=await this.journal.run(readStatus);
      if(result?.state==='preparing'&&!this.peers(account.key,account.binding).length){
        const peer=await this.worker(account,caller.messageId,db=>{checkAccount(db);return db.links[account.key]!;},guard,stopAt,query.wait?.signal);
        if(!peer)return {...result,message:offline.message};
      }
      while(result?.state==='preparing'&&Date.now()+600<stopAt){
        await delay(600,undefined,{signal:query.wait?.signal});guard();
        result=await this.journal.run(readStatus);
      }
      return result;
    };
    if(turn.receiptResource)return await receipt()??{state:'none',message:'当前 App 选定账号没有对应的草稿保存回执。'};
    const editProposal=(db:AuthoringLedger)=>{
      const current=checkAccount(db),link=db.links[account.key],offer=link?.conversationEdit?.proposal;
      if(!link||!offer||!turn.editProposalId||turn.editProposalId!==current.editProposalId||offer.id!==turn.editProposalId||
        !isDeepStrictEqual(current.selected,turn.selected)||offer.thread!==turn.threadId)return;
      const work=offer.work,known=link.creator?.sources?.[work.draftId];
      if(known!==undefined&&!isDeepStrictEqual(known,work.source))return;
      const op=work.source&&db.operations[work.source.preparationId];
      if(op&&(op.revoked||op.bot!==this.bot||linkKey(op.scope,op.accountId)!==account.key||op.binding!==account.binding||
        !sameRecipient(op.recipient,turn.recipient)||op.view.receipt?.status!=='accepted'||op.view.receipt.draftId!==work.draftId||
        (op.originalGroup?.groupId??op.view.groupId)!==work.source!.groupId||(op.originalGroup?.identity??op.sourceIdentity)!==work.source!.identity))return;
      return offer;
    };
    const materialStatus=await this.journal.run(db=>{
      const current=checkAccount(db),link=db.links[account.key]!,offer=link.materialProposal;
      if(!offer||!current.materialProposalId||turn.materialProposalId!==offer.id||current.materialProposalId!==offer.id||
        offer.threadId!==turn.threadId||offer.handoffId!==turn.selected?.id)return;
      const row=offer.jobId&&link.creator?.jobs[offer.jobId];
      if(row&&row.job.binding!==account.binding)throw denied();
      if(row&&row.result?.kind==='saved')return {operation:'createDraft',state:'saved',draftId:row.result.work.draftId,
        nameAtCreation:offer.input.public.name,versionAtCreation:offer.input.public.version,revisionAtCreation:row.result.revision};
      if(row&&row.result?.kind==='rejected')return {operation:'createDraft',state:'needsReview',proposalId:offer.id,message:'App 未能保存，请核对当前账号与内容后重新提案。'};
      return {operation:'createDraft',state:offer.acceptedBy?'preparing':'awaitingConfirmation',proposalId:offer.id,
        nextTool:'recipe_author_material',nextAction:'create',proposedName:offer.input.public.name};
    });
    if(query.kind==='status'&&materialStatus)return materialStatus;
    const renameContext=await this.journal.run(db=>{
      const selection=checkAccount(db),link=db.links[account.key]!;
      const proposal=link.conversationProposal;
      const creationProposal=selection.proposalId&&proposal?.id===selection.proposalId&&proposal.threadId===turn.threadId&&
        !conversationReceipt(db,this.bot,account,turn,proposal.id)?
        {proposalId:proposal.id,proposedName:proposal.public.name,groupId:proposal.groupId}:undefined;
      const targets=draftTargets(db,account.key,link,this.now());
      const savedDrafts=[...targets.values()].map(({work,lastVerifiedName,nameAtCreation})=>({draftId:work.draftId,lastVerifiedName,nameAtCreation}));
      const focus=link.creator?.conversationFocus;
      const focusedDraftId=focus&&focus.order===account.order&&targets.has(focus.draftId)?focus.draftId:undefined;
      return {creationProposal,savedDrafts,focusedDraftId,rename:renameReceipt(link,turn.threadId,this.now())};
    });
    const {creationProposal,savedDrafts}=renameContext;
    const rename=turn.rename;
    const named=rename?.originalName?savedDrafts.filter(d=>d.lastVerifiedName===rename.originalName):[];
    const namedDraftId=named.length===1&&rename?.originalName!==creationProposal?.proposedName?named[0]!.draftId:undefined;
    const focusedDraftId=namedDraftId??renameContext.focusedDraftId;
    const ambiguous=rename?.target==='unspecified'&&creationProposal&&!focusedDraftId;
    if(rename&&rename.target!=='proposal'&&(query.kind==='propose'||query.kind==='create'||query.kind==='status'||
      query.kind==='draft'&&query.action==='edit'&&query.change?.field==='name')){
      if(query.kind==='status'&&rename.checking&&renameContext.rename&&!ambiguous)return renameContext.rename;
      if(ambiguous)return {state:'chooseRenameTarget',savedDrafts,creationProposal,nextTool:'recipe_author_draft',nextAction:'list',
        message:'确认要改 App 里已经保存的草稿，还是只改未保存的新建提案。先用 list 核对本地草稿的现名。'};
      if(query.kind==='draft'&&query.draftId&&namedDraftId&&query.draftId!==namedDraftId)
        throw new Error('指定的草稿编号与作者说出的原名称不符，请重新读取本地草稿。');
      if(query.kind==='propose'||query.kind==='create'||rename.bare||query.kind==='status'){
        return {state:'editExistingDraft',operation:'renameDraft',savedDrafts,focusedDraftId,creationProposal,nextTool:'recipe_author_draft',
          nextAction:focusedDraftId?'inspect':'list',message:'先核对已存草稿和新名称。作者只说“改名”时询问新名称；不得将新建提案名称直接写入原稿。已有本人明确给出的新名称时，用 edit 和 field=name 修改同一草稿。'};
      }
    }
    if(rename?.target==='proposal'&&query.kind==='draft'&&query.action==='edit'&&query.change?.field==='name'){
      return {state:'editCreationProposal',creationProposal,message:'本人指定的是未保存的提案，请只调整提案中的拟用名称。'};
    }
    if(query.kind==='status'){
      const pending=await this.journal.run(db=>{
        const edit=editProposal(db);
        if(edit){
          const job=db.links[account.key]!.conversationEditJobs?.[edit.id];
          if(job&&(job.job.binding!==account.binding||job.order!==edit.order||
            job.job.task.kind!=='draftScopeApply'||!isDeepStrictEqual(job.job.task.work,edit.work)||job.job.task.revision!==edit.revision||
            job.job.task.baseSha256!==edit.baseSha256))throw denied();
          const target={operation:'editDraftScope' as const,draftId:edit.work.draftId,...(edit.work.source&&{groupId:edit.work.source.groupId}),proposalId:edit.id};
          if(job?.result?.kind==='saved')return {...target,state:'saved',revision:job.result.revision};
          if(job?.result?.kind==='rejected')return {...target,state:'needsReview',revision:edit.revision};
          return {...target,state:edit.acceptedBy?'preparing':'awaitingConfirmation',revision:edit.revision,
            nextTool:'recipe_author_draft',nextAction:'apply',message:'本人已明确确认修改范围时，请直接使用 apply 保存这个提案。'};
        }
        const current=checkAccount(db);
        const proposal=db.links[account.key]?.conversationProposal;
        const rename=renameReceipt(db.links[account.key]!,turn.threadId,this.now());
        if(rename&&!turn.acceptsScope&&(!creationProposal||rename.state!=='saved'))return {...rename,creationProposal};
        if(current.proposalId&&proposal?.id===current.proposalId&&proposal.threadId===turn.threadId&&
          !conversationReceipt(db,this.bot,account,turn,proposal.id))
          return {operation:'createDraft',nextTool:'recipe_author_create',state:proposal.acceptedBy?'retryConfirmed':'awaitingConfirmation',proposalId:proposal.id,groupId:proposal.groupId,proposedName:proposal.public.name,savedDrafts};
      });
      return pending??await receipt()??{state:'none'};
    }
    if(query.kind==='create'){
      const existing=await this.journal.run(readStatus);
      if(existing)return existing.state==='preparing'?await receipt()??existing:existing;
    }
    const checkSelection=(db:AuthoringLedger)=>{
      const current=checkAccount(db);
      if(!isDeepStrictEqual(current.selected,turn.selected))throw denied();
      return db.links[account.key]!;
    };
    await this.journal.run(db=>{checkSelection(db);});
    if(query.kind==='propose'&&turn.selected&&query.groupId!==turn.selected.groupId&&query.switchFromGroupId!==turn.selected.groupId){
      return {state:'sourceConflict',selected:{groupId:turn.selected.groupId,name:turn.selected.name},message:'请核对本人这次明确指定的群。如要改用该群，以 switchFromGroupId 标明原选群。'};
    }
    const session=await this.worker(account,caller.messageId,checkSelection,guard,stopAt,query.wait?.signal);
    if(!session)return offline;
    const p=session.presence!;
    const live=()=>{
      guard();
      if(session.presence!==p||!this.peers(account.key,account.binding).includes(session))throw denied();
    };
    const source=(groupId:string)=>atSource(this.opts.channel,this.opts.bot,groupId,row=>{
      live();
      if(!exportableRecipeGroup(row,p.account))throw new Error('这个群目前不能用作该账号的配方来源。');
      return {groupId:row.chatId,name:row.name,identity:sourceIdentityOf(p.scope,row)};
    });
    const verified=async()=>{
      live();await this.journal.run(db=>{checkSelection(db);});live();
    };
    await verified();
    if(query.kind==='material'){
      if(!p.materialAuthor)return {state:'upgradeRequired',message:'请更新来源 App 后再保存资料创作的配方。'};
      if(query.action==='propose'){
        const content=materialContent(query.material),offer=await this.journal.run(db=>{
          const link=checkSelection(db),prior=link.materialProposal;
          if(prior?.from===caller.messageId&&prior.binding===account.binding&&prior.order===account.order&&
            isDeepStrictEqual(prior.input,query.material))return prior;
          if(turn.selected){
            const old=db.handoffs?.[turn.selected.id];
            if(!old?.conversation||old.capture||old.phase.state!=='selecting')throw denied();
            old.phase={state:'cancelled'};delete turn.selected;
          }
          selectCreatorBinding(db,link,this.now());account.order=link.selectionOrder!;turn.account={...account};
          delete link.conversationProposal;delete link.conversationEdit;
          return link.materialProposal={id:randomUUID(),draftId:randomUUID(),content,input:query.material,binding:account.binding,
            order:account.order,threadId:turn.threadId,from:caller.messageId,expiresAt:Math.min(this.now()+ttl,turn.expires)};
        },live);
        turn.materialProposalId=offer.id;turn.authoring=true;
        if(!offer.shownAt){
          const im=new AuthoringIm(this.opts.channel),pages=reviewPages(materialReview(offer.input));
          for(const [index,page] of pages.entries()){
            await this.journal.run(db=>{if(checkSelection(db).materialProposal?.id!==offer.id)throw denied();},live);
            await im.sendText(turn.recipient.chatId,page,index===0?offer.id:inventoryAlias(offer.id,'page:'+index));
          }
          await this.journal.run(db=>{const current=checkSelection(db).materialProposal;if(current?.id!==offer.id)throw denied();current.shownAt??=this.now();},live);
        }
        return {state:'awaitingConfirmation',operation:'createDraft',proposalId:offer.id,message:'已展示完整保存内容，等待作者下一条消息明确确认。'};
      }
      const offer=await this.journal.run(db=>{
        const current=checkSelection(db).materialProposal;
        if(!current||current.id!==query.proposalId||current.id!==turn.materialProposalId||!current.shownAt||current.binding!==account.binding||
          current.order!==account.order||current.threadId!==turn.threadId||current.handoffId!==turn.selected?.id||current.expiresAt<=this.now())
          throw new Error('资料创作提案已改变或过期，请重新展示并确认。');
        return current;
      },live);
      if(!offer.acceptedBy&&(!turn.acceptsScope||caller.messageId===offer.from||turn.sentAt<offer.shownAt!))
        return {state:'awaitingConfirmation',proposalId:offer.id,message:'请作者在下一条私聊中明确确认这个范围并保存草稿。'};
      const jobId=await session.creator.conversationMaterial(p,turn.recipient,offer,caller.messageId,checkSelection);
      let row=await this.journal.run(db=>checkSelection(db).creator?.jobs[jobId]);
      while(row&&row.state!=='finished'&&Date.now()+400<stopAt){
        await delay(400,undefined,{signal:query.wait?.signal});live();row=await this.journal.run(db=>checkSelection(db).creator?.jobs[jobId]);
      }
      if(row?.result?.kind==='saved')return {operation:'createDraft',state:'saved',draftId:row.result.work.draftId,
        nameAtCreation:offer.input.public.name,versionAtCreation:offer.input.public.version,revisionAtCreation:row.result.revision};
      return {operation:'createDraft',state:row?.result?.kind==='rejected'?'needsReview':'preparing',proposalId:offer.id};
    }
    if(query.kind==='sources'){
      turn.authoring=true;
      const offset=query.offset??0,selected=turn.selected&&await source(turn.selected.groupId);
      if(selected&&selected.identity!==turn.selected!.identity)throw denied();
      const projects=(await listProjectsIn(botPaths(this.opts.bot.appId).projectsFile)).filter(row=>exportableRecipeGroup(row,p.account)).sort((a,b)=>a.chatId.localeCompare(b.chatId));
      const groups:{groupId:string;name:string}[]=[];
      for(const row of projects.slice(offset,offset+12)){
        const group=selected?.groupId===row.chatId?selected:await source(row.chatId).catch(()=>undefined);
        live();if(group)groups.push({groupId:group.groupId,name:group.name});
      }
      await verified();
      return {state:'ready' as const,groups,...(selected&&{selected:{groupId:selected.groupId,name:selected.name}}),
        ...(projects.length>offset+12&&{nextOffset:offset+12})};
    }
    if(query.kind==='draft'){
      const readJob=async(id:string)=>{
        const read=()=>this.journal.run(db=>{const row=checkSelection(db).creator?.jobs[id];live();return row;});
        let row=await read();
        while(row&&row.state!=='finished'&&Date.now()+400<stopAt){
          await delay(400,undefined,{signal:query.wait?.signal});row=await read();
        }
        if(!row||row.result?.kind==='rejected')throw new Error('无法读取此草稿，请在 App 核对当前账号和草稿。');
        return row;
      };
      if(query.action==='list'){
        const id=await session.creator.conversationList(p,turn.recipient,caller.messageId,query.offset??0,checkSelection),row=await readJob(id);
        if(row.result?.kind!=='works')return {state:'reading',message:'App 正在读取当前账号的本地草稿，请稍后重试。'};
        return {state:'ready',savedDrafts:row.result.items.flatMap(i=>i.kind==='draft'?[{draftId:i.work.draftId,name:i.name,version:i.version}]:[]),
          nextOffset:row.result.nextOffset,creationProposal};
      }
      const confirmedEdit=query.action==='apply'?await this.journal.run(db=>{
        const offer=editProposal(db);
        if(!offer||query.proposalId&&query.proposalId!==offer.id||query.draftId&&query.draftId!==offer.work.draftId)
          throw new Error('本次私聊没有相符的已展示修改提案。请用 recipe_author_status 核对当前提案。');
        return offer;
      }):undefined;
      const target=confirmedEdit?.work??await this.journal.run(db=>{
        const link=checkSelection(db),targets=draftTargets(db,account.key,link,this.now());
        const focus=link.creator?.conversationFocus;
        const draftId=query.draftId??namedDraftId??(focus&&focus.order===account.order?focus.draftId:undefined)??
          (!creationProposal&&(link.creator?.focusUntil??0)>this.now()?link.creator?.focusDraft:undefined)??
          (targets.size===1?targets.keys().next().value:undefined);
        return draftId?targets.get(draftId)?.work:undefined;
      });
      if(!target)return {state:'chooseDraft',savedDrafts,nextTool:'recipe_author_draft',nextAction:'list',message:'用 list 核对本地草稿；如有多份，请本人指明要修改哪一份。'};
      if(query.action==='inspect'){
        const request=await session.creator.conversationDraft(p,turn.recipient,target,query,caller.messageId,checkSelection,turn.threadId);
        const row=await readJob(request.requestId);
        return row.inspected?{state:'ready',draftId:target.draftId,...row.inspected}:{state:'reading',draftId:target.draftId};
      }
      const edit=confirmedEdit?{action:'apply' as const,draftId:target.draftId,proposalId:confirmedEdit.id}:
        query.action==='edit'&&!query.change?{action:'inventory' as const,draftId:target.draftId}:query;
      if(edit.action==='inventory'||edit.action==='propose'||edit.action==='apply'){
        await verified();
        const {conversationDraftEdit}=await import('./conversation-draft-edit');
        return conversationDraftEdit({opts:this.opts,journal:this.journal,p,work:target,recipient:turn.recipient,messageId:caller.messageId,
          threadId:turn.threadId,sentAt:turn.sentAt,acceptsScope:turn.acceptsEditScope,stopAt,signal:query.wait?.signal,
          check:checkSelection,guard:live,now:this.now},edit);
      }
      return session.creator.conversationDraft(p,turn.recipient,target,edit,caller.messageId,checkSelection,turn.threadId,turn.rename?.originalName);
    }
    const proposal=await this.journal.run(db=>{
      const current=checkSelection(db).conversationProposal;
      if(query.kind!=='create')return;
      if(!current||current.id!==query.proposalId||!current.shownAt||current.id!==turn.proposalId&&caller.messageId!==current.from||
        current.order!==account.order||current.binding!==account.binding||current.handoffId!==turn.selected?.id||
        current.threadId!==turn.threadId||current.expiresAt<=this.now())throw new Error('当前范围提案已改变或过期，请重新盘点并核对。');
      return current;
    });
    if(proposal&&!proposal.acceptedBy&&(!turn.acceptsScope||caller.messageId===proposal.from||turn.sentAt<proposal.shownAt!)){
      return {state:'awaitingConfirmation',proposalId:proposal.id,message:'请作者在下一条私聊中明确确认这个范围并保存草稿。'};
    }
    const groupId=query.kind==='create'?proposal!.groupId:query.groupId;
    const group=await source(groupId);
    // A provider can page one immutable inventory during this turn. Proposing and saving always re-read the source.
    const cached=query.kind==='inventory'&&(query.category||query.offset)?this.inventories.get(caller.messageId):undefined;
    const inventory=cached&&cached.identity===group.identity?cached.view:await conversationInventory(this.opts,p,groupId);
    await verified();
    if(query.kind==='inventory'){
      turn.authoring=true;
      if(this.inventories.size>=8)this.inventories.delete(this.inventories.keys().next().value!);
      this.inventories.set(caller.messageId,{identity:group.identity,view:inventory});
      return inventoryPage(inventory,query.category,query.offset);
    }
    if(turn.selected&&turn.selected.groupId===group.groupId&&turn.selected.identity!==group.identity)throw denied();
    if(query.kind==='propose'){
      if(query.inventoryId!==inventory.inventoryId)throw new Error('来源群配置已经变化，请重新盘点，再请作者核对范围。');
      const review=chooseScope(inventory,query.selectedIds,query.public,query.access??'direct');
      const shown=scopeReview(group.name,review,query.public.overview);
      const offer=await this.journal.run(db=>{
        const link=checkSelection(db);
        const prior=link.conversationProposal;
        if(prior?.from===caller.messageId&&prior.binding===account.binding&&prior.order===account.order&&prior.inventoryId===inventory.inventoryId&&
          prior.access===review.access&&isDeepStrictEqual(prior.selected,review.selected)&&isDeepStrictEqual(prior.public,review.public))return prior;
        if(turn.selected&&turn.selected.groupId!==group.groupId){
          if(query.switchFromGroupId!==turn.selected.groupId)throw denied();
          const old=db.handoffs?.[turn.selected.id];
          if(!old?.conversation||old.capture||old.phase.state!=='selecting')throw denied();
          old.phase={state:'cancelled'};delete turn.selected;
        }
        if(!turn.selected){
          selectCreatorBinding(db,link,this.now());
          account.order=link.selectionOrder!;turn.account={...account};
        }
        delete link.conversationEdit;
        return link.conversationProposal={id:randomUUID(),groupId,identity:group.identity,inventoryId:inventory.inventoryId,lease:inventory.lease,selected:review.selected,
          public:review.public,access:review.access,binding:account.binding,order:account.order,handoffId:turn.selected?.id,threadId:turn.threadId,
          from:caller.messageId,offeredAt:this.now(),expiresAt:Math.min(this.now()+ttl,turn.expires)} satisfies ConversationProposal;
      },live);
      if(!offer.shownAt){
        const im=new AuthoringIm(this.opts.channel),pages=reviewPages(shown);
        for(const [index,page] of pages.entries()){
          await this.journal.run(db=>{if(checkSelection(db).conversationProposal?.id!==offer.id)throw denied();},live);
          live();
          const text=pages.length===1?page:'保存范围 · '+(index+1)+'/'+pages.length+'\n'+page;
          await im.sendText(turn.recipient.chatId,text,index===0?offer.id:inventoryAlias(offer.id,'page:'+index));
        }
        await this.journal.run(db=>{
          const current=checkSelection(db).conversationProposal;
          if(current?.id!==offer.id)throw denied();
          current.shownAt??=this.now();
        },live);
      }
      return {state:'awaitingConfirmation',operation:'createDraft',proposalId:offer.id,included:review.included.map(i=>i.label),public:review.public,
        message:'已在本人私聊展示这个范围，等待作者下一条消息明确确认。'};
    }
    if(!proposal||proposal.inventoryId!==inventory.inventoryId||proposal.identity!==group.identity)throw new Error('来源配置已经变化，请重新盘点并确认范围。');
    // Atomically bind this exact proposal to the later human turn before the desktop worker writes.
    await this.journal.run(db=>{
      const current=checkSelection(db).conversationProposal;
      if(current?.id!==proposal.id||current.expiresAt<=this.now())throw denied();
      current.acceptedBy??=caller.messageId;
    },live);
    const result=await session.captureConversation(turn.recipient,{groupId,requestId:proposal.id,public:proposal.public,access:proposal.access,
      expectedSelection:{order:account.order,handoffId:turn.selected?.id,identity:group.identity},reviewedScope:{lease:proposal.lease,selected:proposal.selected}},live);
    if(result.state==='saved')return result;
    return await receipt()??result;
  }
}
