import {AuthoringRouter} from './authoring-router';
import {PrivateCreator, invalidateWorkOffer,creatorClick} from './private-creator';
import {PrivateHandoffs} from './authoring-handoff';
import {handoffClick} from './authoring-handoff-menu';
import {richSkillOptions,readRichSource,preparedRich,richReviewDigest,bindRichMembers,richMemberCap,richCardReview,typedRichEdit,chatRichProposal,richEditCardContext,type RichLocalDraft,type RichNativeOptions} from './authoring-rich-flow';
import {postRichStage,verifyFrozenRich} from './authoring-rich-proof';
import {itemsOf,wireDigest} from './authoring-rich-snapshot';
import {decodeRichRecipeContent,richFreezeInputSchema} from '@vonvon/protocol';
import type {RichModelInput} from './authoring-rich-model';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { groupIdSchema, recipeAuthoringRequestSchema, type AuthoringFieldRequest, type AuthoringAuthorization, type AuthoringReceipt, type AuthoringReconciliation, type RecipeAuthoringRequest, type RecipeAuthoringReply } from '@vonvon/protocol';
import { assertBotIdentity, withRegisteredBot, type BotIdentity } from '../config/bots';
import { isAdmin, type AppConfig } from '../config/schema';
import { paths } from '../config/paths';
import { configuredRecipeApiOrigin } from '../config/account-deployment';
import { AuthoringIm, candidateConfirmation, physicalChat } from './authoring-im';
import { authoringBotKey, discardAuthoringMaterial, editApproval, AuthoringJournal, CreatorSelectionChanged, active, cardUpdate, linkKey, matchesAuthoringRoute, newCarrier, operationView, renewCreatorBinding, reserve, retire, sameRecipient, selectCreatorOperation, setCard, type AuthoringLedger, type AuthoringRoute, type Link, type LocalOperation, type Recipient, type Source } from './authoring-journal';
import { blankPublic, candidateCardDetails, digest, freezePayload, newAuthoringKey, parseChanges } from './authoring-wire';
import { DraftProviderBusy, draftIntent, requestedField, type DraftInstructionParser, type ReadDraftField } from './draft-instruction';
import { checkAuthorization, postAuthoring } from './authoring-cloud';
import { groupSourceIdentity, reviewSource, type ReviewedSource } from './authoring-source';
import { operationUuid } from './manifest';

export interface AuthoringPeer {id: string; device: string}
export type AuthoringIpc = {kind: 'recipeAuthoring'; peer: AuthoringPeer; request: RecipeAuthoringRequest} |
  {kind: 'recipeAuthoringDisconnect'; peer: AuthoringPeer};
export interface Presence {readonly peer: AuthoringPeer; readonly session: string; readonly account: string; readonly scope: string; readonly binding?: string; readonly nativePreview?: true; readonly resourceContext?: true; until: number; activity: number; activeAt: number}
interface Challenge {
  id: string; session: string; hash: Buffer; expiresAt: number; attempts: number;
  recipient?: Recipient; messageId?: string; evidence?: string;
}
export interface AuthoringOptions {
  bot: BotIdentity; cfg: AppConfig; channel: LarkChannel; root?: string; now?: () => number;
  origin?: string; fetch?: typeof fetch; loopback?: boolean; parser?: DraftInstructionParser & {proposeRich?(input:RichModelInput,signal:AbortSignal):Promise<unknown>}; tasks?:RichNativeOptions['tasks'];managedSources?:RichNativeOptions['managedSources']; readDraftField?: ReadDraftField;
  currentBot?: () => Promise<void>; source?: (scope: string, account: string, group: string) => Promise<ReviewedSource>;
}
const LEASE = 45_000;
const SEND_WINDOW = 55 * 60_000;
const CONTEXT = 30 * 60_000;
const genericLink = '请打开 Vonvon App 的配方草稿，选择这个 Bot 并关联本人飞书私聊。';
const appChoose = '请到 Vonvon App 选择来源群或草稿，再从这次私聊继续。';
const privateOnly = '此处仅编辑私人草稿。请用 /recipe 查看命令，或到 App 核对。';
const commandHelp = '可直接发 /recipe name 新名称、/recipe summary 新简介、/recipe overview 新概览、/recipe version 新版本，也可在 App 编辑。';
const clarify = '请写明要修改的字段和完整新内容。'+commandHelp;
const unavailable = '当前无法使用所选 Provider 解析。'+commandHelp;
const expiredContext = '本次聊天编辑已暂停，请在 Vonvon App 打开原操作，点「重新核验并继续」。';
const paused = '请打开 Vonvon App 并登录原账号，继续本次草稿操作。';
const messageSender = z.object({sender: z.object({sender_type: z.literal('user'), tenant_key: z.string().min(1).max(200),
  sender_id: z.object({open_id: z.string().regex(/^ou_[\w-]{1,200}$/)})}),
  message: z.object({message_id: z.string(), chat_id: z.string(), chat_type: z.literal('p2p')})});
const operator = z.object({operator: z.object({open_id: z.string(), tenant_key: z.string().min(1).max(200)})});
const sourceClick = z.object({a:z.literal('recipe.authoring'),ref:z.string().uuid(),verb:z.literal('source'),index:z.number().int().min(0).max(15)}).strict();
interface SourceMenu {
  session: string; binding: string; recipient: Recipient; ref: string; cardId: string; messageId: string; createdAt: number; offered: Source[]; until: number; instructionId: string;
}
const click = z.object({a: z.literal('recipe.authoring'), ref: z.string().uuid(), verb: z.enum(['confirm','cancel'])}).strict();
export function fromMessage(msg: NormalizedMessage): Recipient | undefined {
  const raw = messageSender.safeParse(msg.raw).data;
  if (msg.chatType !== 'p2p' || !physicalChat(msg.chatId) || !raw || raw.message.chat_id !== msg.chatId ||
      raw.message.message_id !== msg.messageId || raw.sender.sender_id.open_id !== msg.senderId) return;
  return {openId: msg.senderId, chatId: msg.chatId, tenantKey: raw.sender.tenant_key};
}
function revokeOperation(op: LocalOperation) {
  if (!active(op) || op.revoked) return;
  op.revoked = true;
  op.view.state = 'cancelPending';
  op.contextOpen = false;
  discardAuthoringMaterial(op);
}
function bound(op: LocalOperation, link?: Link) {
  return !op.revoked && op.binding === link?.binding && sameRecipient(op.recipient,link.recipient);
}
function editCandidate(op: LocalOperation) {
  if(op.view.format==='rich-v2')return richCardReview(op);
  const details = candidateCardDetails(op.payload);
  if (op.view.purpose === 'editDraft' && details && details.draftId === op.view.draftId &&
      details.revision === op.view.baseRevision && details.payloadDigest === op.proposalDigest) return details;
}
function reconciliationOf(op: LocalOperation): AuthoringReconciliation {
  const {operationId,purpose,targetPublicKey,nonceCommitment,draftId,baseRevision,createdAt,receipt} = op.view;
  return {operationId,purpose,targetPublicKey,nonceCommitment,draftId,baseRevision,createdAt,receipt,...(op.view.format&&{format:op.view.format})};
}
function refusal(): never { throw new Error('身份、来源或草稿上下文已改变，请回到 App 核对。'); }
function richInstructionReply(result:Exclude<Awaited<ReturnType<typeof chatRichProposal>>,{kind:'proposal'}>){
  if('message' in result)return result.message+commandHelp;
  if(result.kind==='clarify')return clarify;
  if(result.kind==='refuse')return privateOnly;
  const reason=result.kind==='busy'?'所选 Provider 暂时繁忙':result.kind==='timeout'?'这条草稿指令解析超时':'当前无法解析这条草稿指令';
  return reason+'，尚未生成新候选。请稍后重新发送，或使用以下命令。'+commandHelp;
}

export class AuthoringSession {
  readonly creator: PrivateCreator;
  get presence() { return this.p; }
  matchesChallenge(code: string) { return !!this.challenge && timingSafeEqual(Buffer.from(digest(code),'hex'),this.challenge.hash); }
  ownsLegacyMenu(ref:unknown){return this.menu?.ref===ref&&Boolean(ref);}
  get hasChallenge() { return !!this.challenge; }
  private p?: Presence;
  private challenge?: Challenge;
  private menu?: SourceMenu;
  private readonly lifetime = new AbortController();
  private parsing?: AbortController;
  private field?: {presence: Presence; request: AuthoringFieldRequest; resolve(value: string | null): void};
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly ledger: AuthoringJournal;
  private readonly im: AuthoringIm;
  private readonly handoffs:PrivateHandoffs;
  private readonly botKey: string;
  private readonly now: () => number;
  private readonly origin?: string;
  constructor(private readonly opts: AuthoringOptions,canRefreshPreview:(p:Presence,delivery:string)=>boolean) {
    this.now = opts.now ?? Date.now;
    this.botKey = authoringBotKey(opts.bot);
    this.im = new AuthoringIm(opts.channel);
    this.origin = opts.origin ?? configuredRecipeApiOrigin();
    this.ledger = new AuthoringJournal(opts.root ?? paths.appDir, this.now);
    this.handoffs=new PrivateHandoffs(opts,this.ledger,this.im,this.now,(p,recipient)=>{
      if(this.p!==p||recipient&&!isAdmin(opts.cfg,recipient.openId))refusal();
      this.present(this.p);
    });
    this.creator = new PrivateCreator(opts,this.ledger,this.im,this.now,{
      canRefreshPreview,
      guard:(p,recipient)=>this.allowed(p,recipient),
      live:p=>this.present(p),
      interact:p=>this.interact(p),
      begin:(p,link,req)=>this.handoffs.begin(p,link,req,true),
      resume:(p,link,id,commit)=>this.handoffs.continuePrivate(p,link,id,commit),
      resumeEdit:(p,id,commit)=>this.resumeContext(p,id,commit),
      edit:(p,link,work,revision,selectionCommit)=>this.start(p,link.recipient,{draftId:work.draftId,baseRevision:revision,selectionCommit}),
    });
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private current() { return this.opts.currentBot?.() ?? assertBotIdentity(this.opts.bot); }
  private present(p: Presence) {
    if (this.now() < p.activeAt || this.now() - p.activeAt >= CONTEXT) throw new Error(expiredContext);
    if (this.stopped || this.p !== p || p.until <= this.now()) throw new Error(paused);
  }
  private interact(p: Presence) {
    this.present(p);
    p.activity++;
    p.activeAt = this.now();
  }
  private async requestField(p: Presence, request: AuthoringFieldRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    this.present(p);
    const value = await new Promise<string | null>(resolve => {
      const pending = {presence:p, request, resolve:(v: string | null) => {
        if (this.field === pending) this.field = undefined;
        signal.removeEventListener('abort',abort);
        resolve(v);
      }};
      const abort = () => pending.resolve(null);
      this.field = pending;
      signal.addEventListener('abort',abort,{once:true});
    });
    signal.throwIfAborted();
    this.present(p);
    return value === null ? undefined : {draftId:request.draftId,revision:request.revision,field:request.field,value};
  }
  disconnect(id: string) {
    if (this.p?.peer.id === id) { this.parsing?.abort(); this.menu = undefined; this.p = undefined; this.challenge = undefined; }
  }
  clearAdminContext(openId: string, linked: boolean) {
    if (this.menu?.recipient.openId === openId) this.menu = undefined;
    if (linked) this.parsing?.abort();
    if (this.challenge?.recipient?.openId === openId) this.challenge = undefined;
  }
  async revokeAdminLinks(openId: string) {
    await this.ledger.run(db => {
      for (const [key,link] of Object.entries(db.links)) if (link.bot === this.botKey && link.recipient.openId === openId) {
        for(const h of Object.values(db.handoffs??{}))if(h.binding===link.binding){
          h.phase={state:'cancelled'};delete h.edit;
        }
        delete db.links[key];
      }
      for (const op of Object.values(db.operations)) if (op.bot === this.botKey && op.recipient.openId === openId) revokeOperation(op);
    });
  }
  close() { this.lifetime.abort(); this.menu = undefined; this.stopped = true; this.p = undefined; this.challenge = undefined; }
  private liveLink(db: AuthoringLedger, p: Presence) {
    this.present(p);
    const key = linkKey(p.scope,p.account), link = db.links[key];
    if (p.binding && link?.binding !== p.binding) refusal();
    if (link && !isAdmin(this.opts.cfg,link.recipient.openId)) {
      delete db.links[key];
      return undefined;
    }
    return link;
  }
  private link(p: Presence) { return this.ledger.run(db => this.liveLink(db,p)); }
  private async allowed(p: Presence, recipient?: Recipient) {
    await this.current();
    const linked = await this.link(p);
    this.present(p);
    if (!linked || !isAdmin(this.opts.cfg, linked.recipient.openId) || (recipient && !sameRecipient(linked.recipient, recipient))) refusal();
    return linked;
  }
  private locate(db: AuthoringLedger, p: Presence, id: string) {
    const op = db.operations[id];
    if (!op || op.scope !== p.scope || op.accountId !== p.account) refusal();
    return op;
  }
  private change<T>(p: Presence, id: string, fn: (op: LocalOperation,link:Link,db:AuthoringLedger) => T) {
    return this.ledger.run(db => {
      const op = this.locate(db,p,id);
      const link=this.liveLink(db,p);
      if (!link||!bound(op,link)) refusal();
      return fn(op,link,db);
    });
  }
  private operation(p: Presence, id: string) { return this.change(p,id,op => op); }
  private source(p: Presence, group: string) {
    return this.opts.source?.(p.scope, p.account, group) ?? reviewSource(this.opts.channel, this.opts.bot, p.scope, p.account, group);
  }
  private async sourceNow(p: Presence, op: LocalOperation) {
    if(op.originalGroup){
      const {groupId,identity}=op.originalGroup;
      if(identity!==await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,groupId))refusal();
    }
    if(op.view.format==='rich-v2'&&op.rich?.source){
      const src=op.rich.source, current=await readRichSource(this.opts,p.scope,p.account,src.groupId,src.options);
      if(current.lease!==src.token){
        await this.change(p,op.view.operationId,row=>{if(active(row)){row.view.state='needsReview';setCard(row,'review');}});
        refusal();
      }
      return;
    }
    if (!op.source) return;
    const source = await this.source(p, op.source.groupId);
    if (source.reviewToken !== op.source.reviewToken) {
      await this.change(p, op.view.operationId, row => { if (active(row)) { row.view.state = 'needsReview'; setCard(row, 'review'); } });
      refusal();
    }
    return source;
  }
  private async validate(p: Presence, op: LocalOperation) {
    if ((await this.allowed(p, op.recipient)).binding !== op.binding) refusal();
    const source = await this.sourceNow(p, op);
    await this.allowed(p, op.recipient);
    return source;
  }
  async request(peer: AuthoringPeer, input: RecipeAuthoringRequest): Promise<RecipeAuthoringReply> {
    const req = recipeAuthoringRequestSchema.parse(input);
    if (req.botId !== this.opts.bot.appId || !this.origin || this.stopped) throw new Error('此 Bot 尚未启用配方草稿。');
    if (req.type === 'creatorDiscover') return this.creator.discover(peer,req.accountId);
    if (req.type === 'creatorOpen') {
      const association = await this.creator.discover(peer,req.accountId);
      if (association.association?.binding !== req.binding || association.association.scope !== req.scope) refusal();
      const p = this.p = {peer,session:randomUUID(),account:req.accountId,scope:req.scope,binding:req.binding,nativePreview:req.nativePreview,resourceContext:req.resourceContext,until:this.now()+LEASE,activity:0,activeAt:this.now()};
      await this.creator.open(p,req.binding,req.wakeId);
      return {kind:'creatorSession',session:p.session,binding:req.binding,scope:p.scope,leaseMs:LEASE,...(p.resourceContext&&{resourceContext:true})};
    }
    if (req.type === 'close') {
      if (this.p?.peer.id === peer.id && this.p.session === req.session) this.disconnect(peer.id);
      return {kind:'closed'};
    }
    if (req.type === 'open') {
      const scope = digest(JSON.stringify([peer.device, this.opts.bot.appId, this.opts.bot.tenant, this.opts.bot.createdAt, this.opts.bot.registrationId ?? null]));
      this.parsing?.abort(); this.menu = undefined; this.challenge = undefined;
      const p = this.p = {peer, session: randomUUID(), account: req.accountId, scope, until: this.now()+LEASE, activity:0, activeAt:this.now()};
      await this.current();
      const linked = Boolean(await this.link(p));
      this.present(p);
      return {kind:'session', session:p.session, linked, leaseMs: LEASE};
    }
    const p = this.p;
    if (!p || p.peer.id !== peer.id || p.peer.device !== peer.device || p.session !== req.session) refusal();
    this.present(p);
    p.until = this.now()+LEASE;
    if (req.type === 'resourceHandoff') refusal(); // The resource broker owns this action.
    if (req.type === 'creatorContinue' || req.type === 'creatorPoll' || req.type === 'creatorCheck' || req.type === 'creatorAnswer' || req.type === 'creatorLogo' || req.type === 'creatorDeliver' || req.type === 'creatorPreview' || req.type === 'creatorAppConfirm') {
      return this.serial(()=>this.creator.request(p,req));
    }
    if (p.binding) {
      if (req.type === 'beginLink' || req.type === 'inspectLink' || req.type === 'confirmLink') refusal();
      await this.allowed(p);
    }
    if (req.type === 'groupSourceIdentity') {
      const identity = await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,req.groupId);
      if(p.binding)await this.allowed(p);
      this.present(p);
      return {kind:'groupSourceIdentity',groupId:req.groupId,identity};
    }
    if (req.type === 'workflow' || req.type === 'answerField') {
      await this.current();
      this.present(p);
      if (req.type === 'answerField') {
        const field = this.field;
        if (!field || field.presence !== p || Object.entries(field.request).some(([k,v]) => req.request[k as keyof AuthoringFieldRequest] !== v)) refusal();
        const row = await this.operation(p,field.request.operationId);
        if (!row.contextOpen || (row.contextUntil ?? 0) <= this.now() || this.field !== field || !['waiting','candidate','completed'].includes(row.view.state)) refusal();
        field.resolve(req.value);
        return {kind:'fieldAnswered'};
      }
      return this.ledger.run(db => {
        const current = this.liveLink(db,p);
        const pausedContexts = Object.values(db.operations).filter(op => op.accountId === p.account && op.scope === p.scope &&
          bound(op,current) && ['waiting','candidate'].includes(op.view.state) && (!op.contextOpen || (op.contextUntil ?? 0) <= this.now())).map(op => op.view.operationId);
        return {kind:'workflow' as const, activity:p.activity, ageMs:Math.max(0,this.now()-p.activeAt), pausedContexts,
          handoff:this.handoffs.pending(db.handoffs,p,current), ...(this.field?.presence === p && current && {field:this.field.request})};
      });
    }
    return this.serial(async () => {
      this.present(p);
      await this.current();
      if (['beginLink','confirmLink','prepare','edit','reviewSource','resumeContext'].includes(req.type)) this.interact(p);
      switch (req.type) {
        case 'beginHandoff':
        case 'beginDraftHandoff':{
          const link=await this.allowed(p);this.interact(p);
          if(req.type==='beginDraftHandoff') await this.ledger.run(db=>invalidateWorkOffer(db,p,link,req.draftId));
          return {kind:'handoff',handoff:await this.handoffs.begin(p,link,req,this.creator.enabled)};
        }
        case 'restoreHandoff':{
          const link=await this.allowed(p);this.interact(p);
          return this.handoffs.restore(p,link,req);
        }
        case 'handoffStatus':
        case 'cancelHandoff':{
          const link=await this.allowed(p);
          return {kind:'handoff',handoff:await this.handoffs.status(p,link,req.retryId,req.type==='cancelHandoff')};
        }
        case 'answerHandoff':{
          const link=await this.allowed(p);
          return {kind:'handoff',handoff:await this.handoffs.answer(p,link,req,target=>this.start(p,link.recipient,target))};
        }
        case 'beginLink': {
          const code = randomBytes(10).toString('hex');
          this.challenge = {id: randomUUID(), session: p.session, hash: Buffer.from(digest(code),'hex'), attempts: 0, expiresAt: this.now()+300000};
          return {kind:'challenge', challengeId:this.challenge.id, code, expiresAt:this.challenge.expiresAt};
        }
        case 'inspectLink':
        case 'confirmLink': {
          const c = this.challenge;
          if (!c || c.id !== req.challengeId || c.session !== p.session || c.expiresAt <= this.now() || (!c.recipient && c.attempts >= 5)) refusal();
          if (!c.recipient) return {kind:'link', linked:false};
          if (!isAdmin(this.opts.cfg, c.recipient.openId)) refusal();
          const recipient = {...c.recipient, chatId:groupIdSchema.parse(c.recipient.chatId)};
          if (req.type === 'inspectLink') return {kind:'link', linked:false, recipient, evidence:c.evidence};
          if (req.evidence !== c.evidence || c.session !== this.p?.session) refusal();
          await this.ledger.run(db => {
            this.present(p);
            if (Object.keys(db.links).length >= 1024 && !db.links[linkKey(p.scope,p.account)]) throw new Error('本机关联数量已到上限。');
            for (const op of Object.values(db.operations)) if (op.scope === p.scope && op.accountId === p.account) revokeOperation(op);
            const previous=db.links[linkKey(p.scope,p.account)];
            for(const h of Object.values(db.handoffs??{}))if(h.binding===previous?.binding){h.phase={state:'cancelled'};delete h.edit;}
            db.links[linkKey(p.scope,p.account)] = {bot:this.botKey, binding:randomUUID(), recipient, sources:[]};
          });
          this.challenge = undefined;
          return {kind:'link', linked:true, recipient};
        }
        case 'status': {
          return this.ledger.run(db => {
            const link = this.liveLink(db,p);
            const operations = [], reconciliation = [];
            for (const op of Object.values(db.operations)) {
              if (op.scope !== p.scope || op.accountId !== p.account || req.operationId !== undefined && op.view.operationId !== req.operationId) continue;
              if (bound(op,link)) operations.push(operationView(op,this.now()));
              else {
                // Also recover a disk/journal failure during removal or an orphan from an older daemon.
                revokeOperation(op);
                if (op.revoked) reconciliation.push(reconciliationOf(op));
              }
            }
            return {kind:'status' as const, linked:Boolean(link), operations, reconciliation};
          });
        }
        case 'operationSourceIdentity': {
          const op = await this.operation(p,req.operationId);
          if (op.view.purpose !== 'prepareDraft' || !op.view.groupId) refusal();
          let identity = op.sourceIdentity;
          if (!identity && op.source) {
            const review = await this.source(p,op.source.groupId).catch(() => undefined);
            if (review && review.reviewToken === op.source.reviewToken) {
              identity = review.identity;
              await this.change(p,req.operationId,row => { row.sourceIdentity = review.identity; });
            }
          }
          this.present(p);
          return {kind:'operationSourceIdentity', operationId:req.operationId, groupId:op.view.groupId, identity:identity ?? null};
        }
        case 'richSourceOptions': {
          const link=await this.allowed(p),skills=await richSkillOptions(this.opts,req.groupId);
          if((await this.allowed(p)).binding!==link.binding)refusal();
          return {kind:'richSourceOptions',skills};
        }
        case 'richInventory':
        case 'richPrepare': {
          const link=await this.allowed(p);
          this.interact(p);
          const inv=await readRichSource(this.opts,p.scope,p.account,req.groupId,req.type==='richInventory'?req.options:req.selection.options);
          if((await this.allowed(p)).binding!==link.binding)refusal();
          if(req.type==='richInventory')return {kind:'richInventory',groupId:req.groupId,inventory:{content:inv.content,reviewToken:inv.lease,
            unavailable:[...inv.evidence].filter(([,v])=>v.kind==='unresolved').map(([id])=>id),
            versions:[...new Set([...inv.evidence.values()].flatMap(v=>v.kind==='managed'?v.parents.map(e=>e.versionId):[]))]}};
          const rich=preparedRich(req,inv,p.account);
          const sourceIdentity=await groupSourceIdentity(this.opts.channel,this.opts.bot,p.scope,req.groupId);
          return this.start(p,link.recipient,{rich,sourceIdentity,userSelection:true});
        }
        case 'richEdit': {
          const link=await this.allowed(p);
          this.interact(p);
          return this.start(p,link.recipient,{draftId:req.draftId,baseRevision:req.baseRevision,rich:typedRichEdit(req),userSelection:true});
        }
        case 'richReadMember':
        case 'richMembers':
        case 'richBindMembers': {
          const op=await this.operation(p,req.operationId);
          await this.validate(p,op);
          if(!op.rich?.request||op.view.state!=='pendingCloud'||op.editApproval!==editApproval(op,richReviewDigest(op.rich)))refusal();
          const reviewDigest=richReviewDigest(op.rich);
          if(req.type==='richReadMember'){
            const member=op.rich.members?.[req.index];
            if(req.reviewDigest!==reviewDigest||!member)refusal();
            return {kind:'richMember',operationId:req.operationId,reviewDigest,index:req.index,bytes:member.bytes};
          }
          if(req.type==='richMembers')return {kind:'richMembers',operationId:req.operationId,reviewDigest,cap:op.rich.members?.length?richMemberCap(op.rich):1,
            members:op.rich.members?.map(({kind,sha256})=>({kind,sha256}))??[]};
          if(reviewDigest!==req.reviewDigest)refusal();
          const request=bindRichMembers(op.rich,req.descriptors,req.operationId);
          await this.change(p,req.operationId,row=>{if(!row.rich||richReviewDigest(row.rich)!==reviewDigest)refusal();row.rich.boundRequest=request;});
          return {kind:'richCandidate',operationId:req.operationId,reviewDigest,request};
        }
        case 'richInspect': {
          const op=await this.operation(p,req.operationId);
          await this.validate(p,op);
          if(req.preview){
            if(!op.rich?.request||!['candidate','pendingCloud'].includes(op.view.state))refusal();
            return {kind:'richCandidate',operationId:req.operationId,reviewDigest:richReviewDigest(op.rich),request:op.rich.request};
          }
          const request=op.rich?.members?.length?op.rich.boundRequest:op.rich?.request;
          if(!op.rich||!request||op.view.state!=='pendingCloud'||op.view.payloadDigest!==richReviewDigest(op.rich)||op.editApproval!==editApproval(op,richReviewDigest(op.rich)))refusal();
          return {kind:'richCandidate',operationId:req.operationId,reviewDigest:richReviewDigest(op.rich),request};
        }
        case 'richAdvance': {
          const op=await this.operation(p,req.operationId);
          await this.validate(p,op);
          if(!op.rich||op.view.format!=='rich-v2'||op.view.draftId&&op.view.draftId!==req.destinationDraftId||
            op.rich.destinationDraftId&&op.rich.destinationDraftId!==req.destinationDraftId)refusal();
          if(req.authorization.stage==='dispatch'&&op.dispatched){await this.deliver(p,req.operationId,false);break;}
          if(req.authorization.stage==='accept'&&(!op.rich.request||op.editApproval!==editApproval(op,richReviewDigest(op.rich))))refusal();
          await this.change(p,req.operationId,row=>{if(!row.rich)refusal();row.rich.destinationDraftId=req.destinationDraftId;});
          op.rich.destinationDraftId=req.destinationDraftId;
          this.present(p);
          if(req.accepted&&op.rich.request){
            const frozen=verifyFrozenRich(op.view.operationId,req.destinationDraftId,op.rich.boundRequest??op.rich.request,req.accepted.frozen);
            const saved=decodeRichRecipeContent(Buffer.from(frozen.canonical,'base64url')).content;
            const original=op.rich.boundRequest??op.rich.request;
            let selected=op.rich.base?.selected??[];
            let origins=op.rich.base?.origins;
            if('content' in original){
              const allow=itemsOf(original.content).filter(x=>Object.values(original.content.public).some(f=>f.itemId===x.itemId)||op.rich!.source?.selected.includes(x.itemId));
              const accepted=itemsOf(saved),items=itemsOf(original.content);
              selected=allow.map(i=>accepted[items.findIndex(x=>x.itemId===i.itemId)]!.itemId);
              const sourceMap=new Map(original.origins.map(o=>[o.itemId,o.source]));
              origins=Object.fromEntries(items.map((item,i)=>[accepted[i]!.itemId,sourceMap.get(item.itemId)!]));
            }
            if('payload' in original && op.rich.base){
              const before=decodeRichRecipeContent(Buffer.from(op.rich.base.canonical,'base64url')).content;
              const inserted=saved.setup.filter(step=>!before.setup.some(old=>old.itemId===step.itemId));
              const adds=original.payload.changes.filter(c=>c.op==='addSetup');
              if(adds.length && adds.length===inserted.length){
                origins={...origins};
                selected=[...selected,...inserted.map(item=>item.itemId)];
                for(const [index,item] of inserted.entries())origins[item.itemId]=adds[index]!.source;
              }
            }
            await this.change(p,req.operationId,row=>{row.richSaved={canonical:frozen.canonical,origins,selected:selected.filter(id=>itemsOf(saved).some(item=>item.itemId===id))};});
          }
          if(req.authorization.stage==='dispatch')await this.change(p,req.operationId,row=>{row.richDispatch=req.authorization;});
          const receipt=await postRichStage(this.origin!,op,req,this.now(),this.opts.fetch,this.opts.loopback);
          if(receipt)await this.settle(p,receipt,req.operationId);
          else {await this.markDispatched(p,req.operationId);await this.deliver(p,req.operationId,false);}
          break;
        }
        case 'reviewSource': {
          await this.allowed(p);
          const {identity: _localBinding, ...source} = await this.source(p,req.groupId);
          await this.allowed(p);
          return source;
        }
        case 'prepare': {
          const linked = await this.allowed(p), review = await this.source(p,req.groupId);
          if (review.reviewToken !== req.reviewToken) refusal();
          if(req.setup?.steps.length)throw new Error('setup 是普通技能，请在配方介绍中说明运行方式。');
          freezePayload({public:blankPublic(),config:{role:review.role}});
          const source = {groupId:req.groupId, reviewToken:req.reviewToken};
          return this.start(p, linked.recipient, {source,sourceIdentity:review.identity,userSelection:true});
        }
        case 'edit': {
          const link = await this.allowed(p);
          return this.start(p, link.recipient, {draftId:req.draftId, baseRevision:req.baseRevision,userSelection:true});
        }
        case 'inspectCandidate': {
          const op = await this.operation(p,req.operationId);
          await this.validate(p,op);
          const pending = op.view.state === 'pendingCloud';
          const edit = op.view.purpose === 'editDraft';
          if (pending && edit && !await this.requireEditApproval(p,op)) {
            return {kind:'operation',operation:await this.change(p,req.operationId,row => operationView(row,this.now()))};
          }
          if (req.requireEditApproval && (!pending || !edit)) refusal();
          const payloadDigest = op.view.state === 'candidate' ? op.proposalDigest : pending ? op.view.payloadDigest : undefined;
          if (!op.payload || !payloadDigest || (edit && editCandidate(op)?.payloadDigest !== payloadDigest)) refusal();
          return {kind:'candidate',operationId:req.operationId,payloadDigest,payload:op.payload,
            ...(req.requireEditApproval && {reviewedDigest:payloadDigest})};
        }
        case 'cancel': {
          await this.change(p,req.operationId,op => { if (active(op)) { op.view.state = 'cancelPending'; setCard(op,'pending'); } });
          break;
        }
        case 'reconcile': {
          await this.ledger.run(db => {
            this.present(p);
            const op = this.locate(db,p,req.operationId);
            if (!op.revoked) refusal();
            this.recordReceipt(op,req.receipt);
          });
          return {kind:'reconciled', receipt:req.receipt};
        }
        case 'resumeContext': await this.resumeContext(p,req.operationId); break;
        case 'updateCard': await this.refresh(p,req.operationId); break;
        case 'settle': await this.settle(p,req.receipt,req.operationId); break;
        case 'advance': await this.advance(p,req.operationId,req.authorization); break;
        case 'resend':
        case 'deliver': await this.deliver(p,req.operationId,req.type === 'resend'); break;
      }
      return {kind:'operation',operation:await this.change(p,req.operationId,op => operationView(op,this.now()))};
    });
  }
  private async resumeContext(p:Presence,id:string,commit?:(db:AuthoringLedger,link:Link)=>void){
    const eligible=(op:LocalOperation)=>!op.revoked&&active(op)&&['waiting','candidate'].includes(op.view.state)&&
      op.dispatched&&!op.view.deliveryUnknown&&Boolean(op.carrier.messageId&&op.carrier.cardId);
    const op=await this.operation(p,id);
    if(!eligible(op))refusal();
    await this.validate(p,op);
    await this.change(p,id,(row,linked,db)=>{
      if(!eligible(row))refusal();
      commit?.(db,linked);
      row.contextOpen=true;row.contextUntil=this.now()+CONTEXT;
      linked.context={operationId:id,until:row.contextUntil};
      setCard(row,row.carrier.mode);
    });
    await this.refresh(p,id);
  }
  private async start(p: Presence, recipient: Recipient, target: {selectionCommit?:(db:AuthoringLedger,link:Link)=>void;userSelection?:true;handoff?:{id:string;ref:string;groupId:string;generation:number;cardId:string;messageId:string};originalGroup?:LocalOperation['originalGroup'];rich?:RichLocalDraft;source?: Source; sourceIdentity?: string; sourceCard?: Pick<SourceMenu,'cardId'|'messageId'|'createdAt'>&{seq?:number}; draftId?: string; baseRevision?: number; instructionId?: string; payload?: string; proposalDigest?: string}): Promise<RecipeAuthoringReply> {
    if (target.source && !target.sourceIdentity) refusal();
    this.menu = undefined;
    const op = await withRegisteredBot(this.opts.bot.appId, () => this.ledger.run(db => {
      this.present(p);
      const link = this.liveLink(db,p);
      if (!sameRecipient(link?.recipient, recipient) || !isAdmin(this.opts.cfg,recipient.openId)) refusal();
      const handoff=target.handoff&&db.handoffs?.[target.handoff.id];
      if(target.handoff&&(!handoff||handoff.ref!==target.handoff.ref||handoff.session!==p.session||handoff.scope!==p.scope||
        handoff.generation!==target.handoff.generation||handoff.cardId!==target.handoff.cardId||handoff.messageId!==target.handoff.messageId||
        handoff.groupId!==target.handoff.groupId||target.draftId&&(handoff.edit?.draftId!==target.draftId||handoff.edit.baseRevision!==target.baseRevision)||
        handoff.account!==p.account||handoff.binding!==link!.binding||!sameRecipient(handoff.recipient,recipient)||handoff.expiresAt<=this.now()||
        handoff.phase.state!==(target.draftId?'selecting':'awaitingAttestations')||handoff.identity!==target.sourceIdentity))refusal();
      target.selectionCommit?.(db,link!);
      if(target.draftId) invalidateWorkOffer(db,p,link!,target.draftId);
      const done=(row:LocalOperation)=>{
        if(handoff){
          if(handoff.edit&&handoff.phase.state==='selecting')selectCreatorOperation(db,link!,this.now(),target.draftId);
          handoff.phase={state:'prepared',operationId:row.view.operationId};delete handoff.edit;
        }
        return row;
      };
      const current = Object.values(db.operations).filter(o => o.scope === p.scope && o.accountId === p.account && o.binding === link!.binding && sameRecipient(o.recipient,recipient));
      const prior = current.find(o => target.instructionId && (o.instructionId === target.instructionId || active(o) && o.seenInstructions?.includes(target.instructionId))) ??
        current.find(o => (!this.creator.enabled||target.draftId||!target.handoff)&&active(o) && Boolean(o.view.format)===Boolean(target.rich) && (target.draftId ? o.view.draftId === target.draftId :
          target.rich?.source ? o.rich?.source?.groupId===target.rich.source.groupId : o.source?.groupId === target.source?.groupId && o.source?.reviewToken === target.source?.reviewToken));
      if (prior) {
        if(target.rich&&active(prior)){
          const matches=target.rich.selectionDigest ? target.rich.selectionDigest===prior.rich?.selectionDigest :
            target.rich.base&&prior.rich?.base&&wireDigest(target.rich.base)===wireDigest(prior.rich.base);
          if(!matches)refusal();
        }
        if (target.sourceIdentity && !prior.sourceIdentity && prior.source?.reviewToken === target.source?.reviewToken) prior.sourceIdentity = target.sourceIdentity;
        if (active(prior) && (target.draftId ? prior.view.baseRevision !== target.baseRevision : JSON.stringify(prior.source) !== JSON.stringify(target.source))) refusal();
        if (active(prior) && !target.instructionId && (!prior.contextOpen || (prior.contextUntil ?? 0) <= this.now())) {
          prior.contextOpen = true; prior.contextUntil = this.now()+CONTEXT; setCard(prior,prior.carrier.mode);
          link!.context = {operationId:prior.view.operationId,until:prior.contextUntil};
        }
        if(handoff&&prior.instructionId!==handoff.retryId)refusal();
        return done(prior);
      }
      reserve(db,p.account,this.now());
      const material = newAuthoringKey();
      const operationId = operationUuid(this.now());
      const row: LocalOperation = {...(this.creator.enabled&&{creatorSave:true as const}),accountId:p.account, scope:p.scope, bot:this.botKey, binding:link!.binding, recipient, secret:material.secret, nonce:material.nonce,
        originalGroup:handoff?{groupId:handoff.groupId,identity:handoff.identity}:target.originalGroup,rich:target.rich, source:target.source, sourceIdentity:target.sourceIdentity, instructionId: target.instructionId, payload: target.payload, proposalDigest: target.proposalDigest,
        contextUntil:this.now()+CONTEXT, carrier:newCarrier(target.rich?.request ? 'confirm' : target.source ? 'prepare' : target.payload ? 'confirm' : target.rich?'richEdit':'edit'), dispatched:false, contextOpen:true,
        view:{operationId, targetPublicKey:material.targetPublicKey, nonceCommitment:material.nonceCommitment,
          ...(target.rich&&{format:'rich-v2'}),purpose:target.source||target.rich?.source ? 'prepareDraft' : 'editDraft', draftId:target.draftId, baseRevision:target.baseRevision,
          groupId:target.source||target.rich?.source ? groupIdSchema.parse(target.source?.groupId??target.rich!.source!.groupId) : undefined,
          state:'pendingMain', deliveryUnknown:false,createdAt:this.now()}};
      if(target.rich?.request)row.proposalDigest=richReviewDigest(target.rich);
      if (target.sourceCard) Object.assign(row.carrier,{
        cardId:target.sourceCard.cardId,messageId:target.sourceCard.messageId,createdAt:target.sourceCard.createdAt,
        firstSend:target.sourceCard.createdAt,seq:target.sourceCard.seq??0,
      });
      if(target.rich?.source && target.sourceIdentity){
        const source=target.rich.source;
        const saved:Source={groupId:source.groupId,reviewToken:source.token,rich:{ref:target.rich.sourceRef??randomUUID(),
          draft:target.rich,identity:target.sourceIdentity}};
        link!.sources=[saved,...link!.sources.filter(s=>s.groupId!==source.groupId)].slice(0,16);
      }
      if (target.source) {
        link!.sources = [target.source, ...link!.sources.filter(s => s.groupId !== target.source!.groupId)].slice(0,16);
      }
      for (const prior of current) if (prior.view.state === 'completed' && (!this.creator.enabled || target.draftId&&prior.view.receipt?.status==='accepted'&&prior.view.receipt.draftId===target.draftId)) {prior.contextOpen = false;delete prior.richSaved;}
      link!.context = {operationId, until:this.now()+CONTEXT};
      db.operations[operationId] = row;
      if(target.userSelection)selectCreatorOperation(db,link!,this.now(),target.draftId);
      return done(row);
    }), this.opts.bot);
    if (!op.carrier.dirty) return {kind:'operation',operation:op.view};
    await this.refresh(p,op.view.operationId);
    return {kind:'operation',operation:await this.change(p,op.view.operationId,row => operationView(row,this.now()))};
  }
  private recordReceipt(op: LocalOperation, receipt: AuthoringReceipt) {
    if (receipt.operationId !== op.view.operationId) refusal();
    if (op.view.receipt) { if (JSON.stringify(op.view.receipt) !== JSON.stringify(receipt)) refusal(); return; }
    if (receipt.status === 'accepted' && (op.view.purpose === 'prepareDraft' ? receipt.revision !== 1 :
        op.view.draftId !== receipt.draftId || op.view.baseRevision! + 1 !== receipt.revision)) refusal();
    op.view.receipt = receipt;
    retire(op,receipt.status === 'accepted' ? 'completed' : receipt.status, this.now());
    if (!op.revoked) setCard(op,receipt.status === 'accepted' ? 'saved' : receipt.status);
  }
  private async settle(p: Presence, receipt: AuthoringReceipt, id: string) {
    await this.change(p,id,op => this.recordReceipt(op,receipt));
    await this.refresh(p,id);
  }
  private async requireEditApproval(p: Presence, op: LocalOperation) {
    const details = editCandidate(op);
    if (details && op.view.payloadDigest === details.payloadDigest && op.editApproval === editApproval(op,details.payloadDigest)) return true;
    await this.change(p,op.view.operationId,row => {
      if (row.view.state !== 'pendingCloud') refusal();
      if (!details) {
        delete row.payload; delete row.view.payloadDigest; delete row.proposalDigest;
        row.view.state = 'waiting'; setCard(row,'edit');
      } else {
        row.view.payloadDigest = details.payloadDigest;
        row.view.state = 'candidate'; setCard(row,'confirm');
      }
    });
    await this.refresh(p,op.view.operationId);
    return false;
  }
  private async advance(p: Presence, id: string, auth: AuthoringAuthorization) {
    const op = await this.operation(p,id);
    if (!active(op) || op.view.receipt) return;
    await this.validate(p,op);
    if (auth.stage === 'dispatch' && op.dispatched) { await this.deliver(p,id,false); return; }
    if (auth.stage === 'accept' && op.view.state === 'pendingCloud' && op.view.purpose === 'editDraft' &&
        !await this.requireEditApproval(p,op)) return;
    checkAuthorization(op,auth,this.now());
    if (auth.stage === 'dispatch') await this.change(p,id,row => { row.dispatchAuthorization = auth; });
    this.present(p);
    const result = await postAuthoring(this.origin!,op,auth,this.opts.fetch,this.opts.loopback);
    if (result.status === 'accepted') { await this.settle(p,result,id); return; }
    if (result.status !== 'dispatched') refusal();
    await this.markDispatched(p,id);
    if (this.p === p && p.until > this.now()) await this.deliver(p,id,false);
  }
  private markDispatched(p: Presence, id: string) {
    return this.change(p,id,row => {
      row.dispatched = true;
      delete row.dispatchAuthorization; delete row.richDispatch;
      if (row.view.state === 'pendingMain') row.view.state = 'sending';
    });
  }
  private async refresh(p: Presence, id: string) {
    await this.current();
    const pending = await this.change(p,id,op => {
      const c = op.carrier;
      if (cardUpdate(op,this.now()) !== 'pending') return;
      return {cardId:c.cardId!, messageId:c.messageId!, seq:c.seq, ref:c.ref, mode:c.mode, recipient:op.recipient, details:c.mode === 'confirm' ? editCandidate(op) : undefined,
        creatorSave:op.creatorSave,editing:c.mode==='richEdit'?richEditCardContext(op):undefined};
    });
    if (!pending) return;
    this.present(p);
    if (!isAdmin(this.opts.cfg,pending.recipient.openId)) refusal();
    const {cardId,messageId,seq,ref,mode,recipient,details,editing} = pending;
    let result = await this.im.update(cardId,seq,ref,mode,details,editing,pending.creatorSave);
    if (result === 'conflict') {
      // A duplicate UUID or old sequence is not an acknowledgement of these bytes.
      const current = await this.change(p,id,op => op.carrier.cardId === cardId && op.carrier.ref === ref);
      this.present(p);
      if (current && isAdmin(this.opts.cfg,recipient.openId) && await this.im.shows(messageId,recipient.chatId,ref,mode,details,editing,pending.creatorSave).catch(() => false)) result = 'updated';
    }
    await this.change(p,id,op => {
      const c = op.carrier;
      if (c.cardId !== cardId || c.ref !== ref || c.seq !== seq) return;
      if (result === 'updated') { c.dirty = false; c.previewDigest = mode === 'confirm' && details && candidateConfirmation(ref,details,op.creatorSave) ? details.payloadDigest : undefined; delete c.retryAt; delete c.retryDelay; }
      else if (result === 'unavailable') c.unavailable = true;
      else if (c.retryDelay !== undefined) {
        c.retryDelay = Math.min(600_000,Math.max(12_000,(c.retryDelay ?? 0)*2));
        c.retryAt = this.now() + c.retryDelay;
      } else c.retryDelay = 0;
    });
  }
  private async deliver(p: Presence, id: string, resend: boolean) {
    let op = await this.operation(p,id);
    if (!active(op) || !['pendingMain','sending','waiting','candidate','pendingCloud'].includes(op.view.state)) {
      await this.refresh(p,id); return;
    }
    await this.validate(p,op);
    if (!op.dispatched) {
      if(op.view.format==='rich-v2'){
        if(!op.richDispatch||!op.rich?.destinationDraftId)refusal();
        this.present(p);
        await postRichStage(this.origin!,op,{destinationDraftId:op.rich.destinationDraftId,authorization:op.richDispatch},this.now(),this.opts.fetch,this.opts.loopback,true);
      }else{
      const cap = op.dispatchAuthorization;
      if (!cap) refusal();
      this.present(p);
      const result = await postAuthoring(this.origin!,op,cap,this.opts.fetch,this.opts.loopback);
      if (result.status !== 'dispatched') refusal();
      }
      await this.markDispatched(p,id);
    }
    op = await this.operation(p,id);
    if (op.carrier.messageId) {
      if (op.view.state === 'sending') {
        await this.change(p,id,row => { row.view.state = row.payload||row.rich?.request ? 'candidate' : 'waiting'; row.view.payloadDigest = row.proposalDigest; setCard(row,row.carrier.mode); });
      }
      if (resend && (op.contextUntil ?? 0) <= this.now() && op.contextOpen && (op.view.state === 'waiting' || op.view.state === 'candidate')) {
        await this.change(p,id,row => { row.contextUntil = this.now()+CONTEXT; setCard(row,row.carrier.mode); });
      }
      await this.refresh(p,id); return;
    }
    if (op.carrier.firstSend !== undefined && (this.now() < op.carrier.firstSend || this.now()-op.carrier.firstSend >= SEND_WINDOW)) {
      if (!resend) return;
      op = await this.change(p,id,row => { row.contextUntil = this.now()+CONTEXT; row.carrier = newCarrier(row.carrier.mode,row.carrier.generation+1); row.view.deliveryUnknown = false; return row; });
    }
    if (!op.carrier.cardId) {
      this.present(p);
      const createdAt = this.now();
      const details = op.carrier.mode === 'confirm' ? editCandidate(op) : undefined;
      const cardId = await this.im.create(op.carrier.ref,op.carrier.mode,details,op.carrier.mode==='richEdit'?richEditCardContext(op):undefined,op.creatorSave);
      op = await this.change(p,id,row => {
        row.carrier.cardId = cardId; row.carrier.createdAt = createdAt;
        if (details && candidateConfirmation(row.carrier.ref,details,row.creatorSave)) row.carrier.previewDigest = details.payloadDigest;
        return row;
      });
    }
    op = await this.change(p,id,row => {
      this.present(p);
      row.carrier.firstSend ??= this.now(); row.view.deliveryUnknown = true; return row;
    });
    await this.allowed(p,op.recipient);
    this.present(p);
    const messageId = await this.im.send(op.recipient.chatId,op.carrier.cardId!,op.carrier.sendUuid);
    await this.change(p,id,row => {
      row.carrier.messageId = messageId; row.view.deliveryUnknown = false; row.contextUntil = this.now()+CONTEXT;
      if (row.view.state === 'sending') { row.view.state = row.payload||row.rich?.request ? 'candidate' : 'waiting'; row.view.payloadDigest = row.proposalDigest; }
    });
  }
  private async offerSources(p: Presence, link: Link, recipient: Recipient, instructionId: string) {
    if (!link.sources.length) return false;
    if (this.menu?.instructionId === instructionId && this.menu.session === p.session && this.menu.binding === link.binding && this.menu.until > this.now()) return true;
    const offered = link.sources.slice(0,16);
    if ((await this.allowed(p,recipient)).binding !== link.binding) refusal();
    const ref = randomUUID(), createdAt = this.now(), cardId = await this.im.sourceMenu(ref,offered.length);
    if ((await this.allowed(p,recipient)).binding !== link.binding) refusal();
    const messageId = await this.im.send(recipient.chatId,cardId,randomUUID());
    if ((await this.allowed(p,recipient)).binding !== link.binding) refusal();
    this.menu = {session:p.session,binding:link.binding,recipient,ref,messageId,cardId,createdAt,offered,until:this.now()+300_000,instructionId};
    return true;
  }
  private async endContext(p:Presence,recipient:Recipient,route:AuthoringRoute,quote?:string){
    await this.current();
    const scope=(db:AuthoringLedger)=>{
      const link=this.liveLink(db,p);
      if(!link||link.bot!==this.botKey||!sameRecipient(link.recipient,recipient))refusal();
      if(!matchesAuthoringRoute(db,link,route,this.now()))throw new CreatorSelectionChanged();
      const operations=Object.values(db.operations).filter(o=>o.scope===p.scope&&o.accountId===p.account&&o.bot===link.bot&&bound(o,link)&&o.contextOpen);
      const handoffs=Object.values(db.handoffs??{}).filter(h=>h.scope===p.scope&&h.account===p.account&&h.binding===link.binding&&h.session===p.session&&
        sameRecipient(h.recipient,recipient)&&h.expiresAt>this.now()&&['selecting','awaitingAttestations'].includes(h.phase.state));
      const targets=quote?[
        ...operations.filter(o=>o.carrier.messageId===quote).map(o=>({kind:'operation' as const,id:o.view.operationId,ref:o.carrier.ref,cardId:o.carrier.cardId,generation:o.carrier.generation})),
        ...handoffs.filter(h=>h.messageId===quote).map(h=>({kind:'handoff' as const,id:h.retryId,ref:h.ref,cardId:h.cardId,generation:h.generation})),
      ]:[];
      return {link,operations,handoffs,target:targets.length===1?targets[0]:undefined};
    };
    const original=quote?await this.ledger.run(db=>scope(db).target):undefined;
    if(quote&&(!original?.cardId||!await this.im.matches(quote,recipient.chatId,original.cardId)))return false;
    const ended=await this.ledger.run(db=>{
      const {link,operations,handoffs,target}=scope(db);
      if(quote&&(!target||target.kind!==original?.kind||target.id!==original.id||target.ref!==original.ref||target.cardId!==original.cardId||target.generation!==original.generation))return false;
      for(const o of operations)if(!quote||target?.kind==='operation'&&o.view.operationId===target.id)o.contextOpen=false;
      for(const h of handoffs)if(!quote||target?.kind==='handoff'&&h.retryId===target.id){h.phase={state:'cancelled'};delete h.edit;}
      if(!quote||target?.kind==='operation'&&link.context?.operationId===target.id)delete link.context;
      const s=link.creator;
      if(s){
        if(!quote){delete s.current;delete s.focusUntil;delete s.focusDraft;delete s.awaitLogo;}
        if(!quote||!operations.some(o=>o.contextOpen)&&!handoffs.some(h=>['selecting','awaitingAttestations'].includes(h.phase.state))&&(s.focusUntil??0)<=this.now())delete s.chosenUntil;
      }
      return true;
    });
    if(ended&&(!quote||this.menu?.messageId===quote))this.menu=undefined;
    return ended;
  }
  async onMessage(msg: NormalizedMessage,route?:AuthoringRoute): Promise<boolean> {
    const intent = draftIntent(msg.content);
    const explicit = /^\/recipe(?:\s|$)/i.test(msg.content.trimStart()) || Boolean(intent);
    const recipient = fromMessage(msg);
    if (!recipient) {
      if (explicit || msg.chatType !== 'p2p' || !this.origin) return explicit;
      // An incomplete identity on a message in an active private draft must never fall through to the ordinary tool-enabled Agent.
      return this.ledger.run(db => Object.values(db.handoffs??{}).some(h=>h.recipient.chatId===msg.chatId&&h.recipient.openId===msg.senderId&&['selecting','awaitingAttestations'].includes(h.phase.state))||Object.values(db.operations).some(op => op.bot === this.botKey && op.contextOpen &&
        op.recipient.chatId === msg.chatId && op.recipient.openId === msg.senderId && (op.contextUntil ?? 0) > this.now())).catch(() => true);
    }
    if (!this.origin) { if (explicit) await this.im.reply(msg.chatId,msg.messageId,paused); return explicit; }
    return this.serial(async () => {
      const reply = (text: string) => this.im.reply(msg.chatId,msg.messageId,text);
      const p = this.p;
      const live = Boolean(p && !this.stopped && p.until > this.now() && this.now()-p.activeAt < CONTEXT);
      const cmd = msg.content.trim();
      const routing=(db:AuthoringLedger,link:Link)=>{
        if(route&&!matchesAuthoringRoute(db,link,route,this.now()))throw new CreatorSelectionChanged();
      };
      if(route&&p)await this.ledger.run(db=>{
        const link=this.liveLink(db,p);
        if(!link||!sameRecipient(link.recipient,recipient))refusal();
        routing(db,link);
      });
      const challenge = /^\/recipe\s+link\s+([a-f0-9]{20})$/i.exec(cmd);
      if (challenge || /^\/recipe\s+link\b/i.test(cmd)) {
        const c = this.challenge;
        if (p && live && c && c.session === p.session && c.expiresAt > this.now() && c.attempts < 5 && !c.recipient && isAdmin(this.opts.cfg,recipient.openId)) {
          const supplied = Buffer.from(digest(challenge?.[1] ?? ''),'hex');
          c.attempts++;
          if (timingSafeEqual(supplied,c.hash)) {
            await this.current();
            this.present(p);
            c.recipient = recipient; c.messageId = msg.messageId;
            c.evidence = digest(JSON.stringify([c.id,p.scope,p.session,recipient,msg.messageId]));
            await reply('已收到关联请求。请在原 App 核对收件人并确认。');
            return true;
          }
        }
        await reply(genericLink); return true;
      }
      if(cmd==='/recipe end'&&p&&live&&route&&msg.rawContentType==='text'){
        const ended=await this.endContext(p,recipient,route,msg.replyToMessageId);
        await reply(ended?'已结束本次私聊编辑。':'请引用原配方卡，或发送“我的配方”重新选择账号。');return true;
      }
      if (p && live && await this.creator.message(p,recipient,msg,route)) return true;
      const {contexts,pausedEdit,selecting} = await this.ledger.run(db => {
        const link=p&&this.liveLink(db,p);
        const own = Object.values(db.operations).filter(o => o.bot === this.botKey && sameRecipient(o.recipient,recipient)&&
          (!p||o.scope===p.scope&&o.accountId===p.account&&o.binding===link?.binding));
        return {
          selecting:Object.values(db.handoffs??{}).some(h=>p&&h.scope===p.scope&&h.account===p.account&&h.binding===link?.binding&&h.session===p.session&&sameRecipient(h.recipient,recipient)&&['selecting','awaitingAttestations'].includes(h.phase.state)&&
            (!msg.replyToMessageId||h.messageId===msg.replyToMessageId)),
          pausedEdit: own.some(o => o.contextOpen && (o.contextUntil ?? 0) <= this.now() && (active(o) || o.view.state === 'completed') &&
            (msg.replyToMessageId && msg.replyToMessageId === o.carrier.messageId || requestedField(cmd) !== undefined || /角色|步骤/.test(cmd))),
          contexts: own.filter(o => o.contextOpen && (Boolean(msg.replyToMessageId) && o.carrier.messageId === msg.replyToMessageId ||
            (o.contextUntil ?? 0) > this.now() && (active(o) || o.view.state === 'completed'))),
        };
      });
      if(selecting&&cmd!=='/recipe end'){await reply('请在本次配方卡片中选择内容并确认。');return true;}
      if (!contexts.length && pausedEdit && intent !== 'create') { await reply(expiredContext); return true; }
      if (!explicit && !contexts.length) return false;
      if (msg.rawContentType !== 'text') { await reply(privateOnly); return true; }
      if (!live || !p) { await reply(contexts.length ? paused : genericLink); return true; }
      const link = await this.link(p);
      if (!sameRecipient(link?.recipient, recipient)) { await reply(genericLink); return true; }
      if (!link) refusal();
      const eligible = contexts.filter(o => o.scope === p.scope && o.accountId === p.account && o.binding === link.binding);
      const quoted = msg.replyToMessageId ? eligible.find(o => o.carrier.messageId === msg.replyToMessageId) : undefined;
      if (msg.replyToMessageId && !quoted) { await reply(appChoose); return true; }
      const open = eligible.filter(o => active(o));
      const selected = quoted ?? (open.length === 1 ? open[0] : !open.length ? eligible.find(o => o.view.operationId === link.context?.operationId) : undefined);
      if (/^\/recipe$/i.test(cmd)) {
        await reply(selected ? '可用当前私聊的 Provider 解读单条草稿指令，例如“把名称改成周报”。'+commandHelp : '发 /recipe create 创建私人草稿，或在 App 选择已有草稿并点「在飞书继续编辑」。');
        return true;
      }
      if (/^\/recipe\s+(?:create|start)$/i.test(cmd) || intent === 'create') {
        if (open.length) { await reply('已有草稿正在编辑。请先在卡片完成或取消本次操作，再创建新草稿。'); return true; }
        if (!await this.offerSources(p,link,recipient,msg.messageId)) await reply(appChoose);
        return true;
      }
      if (!selected || !selected.contextOpen || (selected.contextUntil ?? 0) <= this.now()) { await reply(selected ? expiredContext : appChoose); return true; }
      if (selected.seenInstructions?.includes(msg.messageId) || selected.instructionId === msg.messageId) return true;
      if(msg.replyToMessageId&&(!selected.carrier.cardId||!await this.im.matches(msg.replyToMessageId,recipient.chatId,selected.carrier.cardId))){await reply(appChoose);return true;}
      if(selected.view.format==='rich-v2'){
        const completed=selected.view.state==='completed',saved=selected.view.receipt;
        if(completed&&(saved?.status!=='accepted'||!selected.richSaved)){await reply(appChoose);return true;}
        if(!completed&&!['waiting','candidate'].includes(selected.view.state)){await reply(appChoose);return true;}
        await this.validate(p,selected);
        const ref=await this.change(p,selected.view.operationId,(row,link,db)=>{
          routing(db,link);
          if(row.carrier.ref!==selected.carrier.ref||!row.contextOpen||(row.contextUntil??0)<=this.now()||
            row.view.state!==selected.view.state||(row.seenInstructions?.length??0)>=32)refusal();
          (row.seenInstructions??=[]).push(msg.messageId); this.interact(p); row.contextUntil=this.now()+CONTEXT;
          renewCreatorBinding(db,link,this.now());
          if(!completed){setCard(row,'richEdit');row.view.state='waiting';delete row.view.payloadDigest;delete row.proposalDigest;}
          return row.carrier.ref;
        });
        // Withdraw the previous confirmation before parsing; a failed instruction must not leave a stale save button visible.
        await this.refresh(p,selected.view.operationId);
        const attempt=new AbortController();this.parsing=attempt;
        try{
          const signal=AbortSignal.any([attempt.signal,this.lifetime.signal,AbortSignal.timeout(Math.min(28000,Math.max(1,p.until-this.now())))]);
          const context=completed&&saved?.status==='accepted'?{...selected,rich:{base:selected.richSaved!},
            view:{...selected.view,purpose:'editDraft' as const,draftId:saved.draftId,baseRevision:saved.revision}}:selected;
          const result=await chatRichProposal(context,cmd,signal,this.opts.parser?.proposeRich?{proposeRich:this.opts.parser.proposeRich}:undefined);
          await this.validate(p,selected);
          if(result.kind!=='proposal'){await this.refresh(p,selected.view.operationId);await reply(richInstructionReply(result));return true;}
          const request=richFreezeInputSchema.parse(result.request);
          if(completed&&saved?.status==='accepted'){
            await this.change(p,selected.view.operationId,row=>{
              if(!row.contextOpen||(row.contextUntil??0)<=this.now()||row.view.state!=='completed'||
                row.view.receipt?.status!=='accepted'||row.view.receipt.revision!==saved.revision||
                wireDigest(row.richSaved)!==wireDigest(selected.richSaved))refusal();
            });
            await this.start(p,recipient,{draftId:saved.draftId,baseRevision:saved.revision,instructionId:msg.messageId,
              originalGroup:selected.originalGroup,rich:{base:selected.richSaved,request}});
            return true;
          }
          await this.change(p,selected.view.operationId,row=>{
            if(!row.rich||!row.contextOpen||(row.contextUntil??0)<=this.now()||row.carrier.ref!==ref||row.view.state!=='waiting')refusal();
            row.rich.request=request;
            if(result.newFields)row.rich.newFields=result.newFields;
            if(result.sourcePublicValues)row.rich.sourcePublicValues=result.sourcePublicValues;
            if('richSourceOriginal'in result&&result.richSourceOriginal){row.richSourceOriginal=result.richSourceOriginal;row.rich.sourceOmitted=result.sourceOmitted;}
            if('content' in request)row.rich.members=row.rich.members?.filter(m=>m.kind==='finalLogo'||request.content.files.some(f=>f.itemId===m.itemId));
            delete row.rich.boundRequest;row.proposalDigest=richReviewDigest(row.rich);row.view.payloadDigest=row.proposalDigest;row.view.state='candidate';setCard(row,'confirm');
          });
          await this.refresh(p,selected.view.operationId);
        }finally{this.parsing=undefined;}
        return true;
      }
      const prior = selected.view.receipt;
      const draftId = prior?.status === 'accepted' ? prior.draftId : selected.view.draftId;
      const baseRevision = prior?.status === 'accepted' ? prior.revision : selected.view.baseRevision;
      if (!draftId || !baseRevision || (selected.view.state !== 'waiting' && selected.view.state !== 'candidate' && selected.view.state !== 'completed')) {
        await reply(privateOnly); return true;
      }
      const natural = !cmd.startsWith('/');
      if (natural) await this.validate(p,selected);
      selected.contextUntil = await this.change(p,selected.view.operationId,(row,link,db) => {
        routing(db,link);
        if (!row.contextOpen || (row.contextUntil ?? 0) <= this.now()) refusal();
        this.interact(p);
        renewCreatorBinding(db,link,this.now());
        return row.contextUntil = this.now()+CONTEXT;
      });
      if (natural && selected.view.state === 'completed') {
        await this.change(p,selected.view.operationId,row => {
          if (!row.contextOpen || (row.contextUntil ?? 0) <= this.now() || (row.seenInstructions?.length ?? 0) >= 32) refusal();
          (row.seenInstructions ??= []).push(msg.messageId);
        });
      }
      if (natural && (selected.view.state === 'candidate' || selected.view.state === 'waiting')) {
        const row = await this.change(p,selected.view.operationId,op => {
          if (!op.contextOpen || (op.contextUntil ?? 0) <= this.now() || op.carrier.ref !== selected.carrier.ref ||
              !['waiting','candidate'].includes(op.view.state) || (op.seenInstructions?.length ?? 0) >= 32) refusal();
          (op.seenInstructions ??= []).push(msg.messageId);
          if (op.view.state === 'candidate') {
            delete op.payload; delete op.proposalDigest; delete op.view.payloadDigest;
            op.view.state = 'waiting'; setCard(op,'edit');
          }
          return op;
        });

        selected.carrier = row.carrier;
      }
      let frozen: ReturnType<typeof freezePayload>;
      try {
        const attempt = new AbortController();
        this.parsing = attempt;
        const remaining = Math.min(28_000, p.until-this.now(), (selected.contextUntil ?? 0)-this.now());
        if (remaining <= 0) refusal();
        const signal = AbortSignal.any([attempt.signal,this.lifetime.signal,AbortSignal.timeout(remaining)]);
        if (natural && this.opts.parser) await reply('已收到草稿修改。解析后会在卡片上请你确认。');
        this.present(p);
        const read = this.opts.readDraftField;
        let currentField: {field: AuthoringFieldRequest['field']; value: string} | undefined;
        const getField = async (field: AuthoringFieldRequest['field']) => {
          const row = read ? await read({accountId:p.account,scope:p.scope,draftId,baseRevision,field})
            : await this.requestField(p,{requestId:randomUUID(),operationId:selected.view.operationId,draftId,revision:baseRevision,field},signal);
          if (!row || row.field !== field || row.draftId !== draftId || row.revision !== baseRevision) return;
          if ((await this.allowed(p,recipient)).binding !== selected.binding) refusal();
          return {field,value:row.value};
        };
        const result = await parseChanges(cmd,{parser:this.opts.parser,signal,readField:async field => currentField = await getField(field)});
        if (result.kind === 'proposal' && currentField && (await getField(currentField.field))?.value !== currentField.value) {
          await reply('原草稿修订已变化或暂时无法核验。请在 App 重新打开这份草稿。'); return true;
        }
        this.present(p);
        if (result.kind !== 'proposal') {
          if (selected.view.state === 'candidate') await this.refresh(p,selected.view.operationId);
          await reply(result.kind === 'clarify' ? clarify : result.kind === 'refuse' ? privateOnly : unavailable);
          return true;
        }
        frozen = freezePayload({schemaVersion:1, draftId, baseRevision, changes:result.changes});
      } catch (error) {
        if (selected.view.state === 'candidate' && this.p === p) await this.refresh(p,selected.view.operationId).catch(() => undefined);
        await reply(error instanceof DraftProviderBusy ? '所选 Provider 暂时繁忙，这条指令未保存。'+commandHelp : unavailable); return true;
      } finally { this.parsing = undefined; }
      await this.allowed(p,recipient);
      if (selected.view.state === 'completed') {
        await this.change(p,selected.view.operationId,row => {
          if (!row.contextOpen || (row.contextUntil ?? 0) <= this.now() || row.view.state !== 'completed') refusal();
        });
        await this.start(p,recipient,{draftId,baseRevision,instructionId:msg.messageId,payload:frozen.payload,proposalDigest:frozen.payloadDigest});
      } else {
        await this.change(p,selected.view.operationId,row => {
          this.present(p);
          if (!row.contextOpen || (row.contextUntil ?? 0) <= this.now() || row.carrier.ref !== selected.carrier.ref ||
              !['waiting','candidate'].includes(row.view.state)) refusal();
          if (!natural) {
            if ((row.seenInstructions?.length ?? 0) >= 32) refusal();
            (row.seenInstructions ??= []).push(msg.messageId);
          }
          row.payload = frozen.payload; row.proposalDigest = frozen.payloadDigest;
          row.view.state = 'candidate'; row.view.payloadDigest = frozen.payloadDigest;
          setCard(row,'confirm');
        });
        await this.refresh(p,selected.view.operationId);
      }
      return true;
    }).catch(async error => {
      await this.im.reply(msg.chatId,msg.messageId,error instanceof CreatorSelectionChanged?'账号选择已改变，请引用原配方卡或重新选择账号后重发本条修改。':privateOnly);
      return true;
    });
  }
  async onAction(evt: CardActionEvent,previewFrom?:string) {
    if(creatorClick.safeParse(evt.action?.value).data?.verb==='creator') {
      const p=this.p;
      await this.serial(()=>p&&p.until>this.now()?this.creator.action(p,evt,previewFrom):this.creator.offlinePreview(evt)).catch(()=>undefined);
      return;
    }
    const value = handoffClick.safeParse(evt.action?.value).data ?? sourceClick.safeParse(evt.action?.value).data ?? click.safeParse(evt.action?.value).data, raw = operator.safeParse(evt.raw).data;
    if (!value || !raw || evt.operator.openId !== raw.operator.open_id || !physicalChat(evt.chatId)) return;
    return this.serial(async () => {
      const p = this.p;
      if (!p || p.until <= this.now() || this.now()-p.activeAt >= CONTEXT) {
        const recipient = {openId:evt.operator.openId,chatId:evt.chatId,tenantKey:raw.operator.tenant_key};
        const known = await this.ledger.run(db => Object.values(db.operations).some(op => op.bot === this.botKey && active(op) &&
          !op.revoked && bound(op,db.links[linkKey(op.scope,op.accountId)]) && sameRecipient(op.recipient,recipient) &&
          op.carrier.messageId === evt.messageId && op.carrier.ref === value.ref));
        if (known && isAdmin(this.opts.cfg,recipient.openId)) await this.im.reply(evt.chatId,evt.messageId,expiredContext);
        return;
      }
      const recipient = {openId:evt.operator.openId, chatId:evt.chatId, tenantKey:raw.operator.tenant_key};
      const link = await this.allowed(p,recipient);
      if(value.verb==='handoff'){
        await this.handoffs.action(p,link,recipient,evt.messageId,value,target=>this.start(p,recipient,target),()=>this.interact(p));
        return;
      }
      if (value.verb === 'source') {
        const menu = this.menu;
        if (!menu || menu.ref !== value.ref || menu.messageId !== evt.messageId || menu.session !== p.session ||
            menu.binding !== link.binding || menu.until <= this.now() || !sameRecipient(menu.recipient,recipient)) return;
        const source = menu.offered[value.index];
        if (!source) return;
        this.menu = undefined;
        const current = link.sources.find(s => s.groupId === source.groupId);
        if(current?.rich){
          if(current.rich.ref!==source.rich?.ref||current.reviewToken!==source.reviewToken)return;
          const draft=structuredClone(current.rich.draft),src=draft.source;
          if(!src)return;
          const live=await readRichSource(this.opts,p.scope,p.account,src.groupId,src.options);
          if(live.lease!==src.token){await this.im.reply(evt.chatId,evt.messageId,appChoose);return;}
          if((await this.allowed(p,recipient)).binding!==menu.binding)return;
          this.interact(p);
          await this.start(p,recipient,{rich:draft,sourceIdentity:current.rich.identity,sourceCard:menu,instructionId:menu.instructionId,userSelection:true});
          return;
        }
        const reviewed = current && await this.source(p,current.groupId).catch(() => undefined);
        if (!reviewed || current?.reviewToken !== source.reviewToken || reviewed.reviewToken !== source.reviewToken) {
          await this.im.reply(evt.chatId,evt.messageId,appChoose); return;
        }
        if ((await this.allowed(p,recipient)).binding !== menu.binding) refusal();
        this.interact(p);
        await this.start(p,recipient,{source,sourceIdentity:reviewed.identity,sourceCard:menu,instructionId:menu.instructionId,userSelection:true});
        return;
      }
      const op = await this.ledger.run(db => Object.values(db.operations).find(o => o.scope === p.scope && o.accountId === p.account &&
        o.binding === link.binding && o.carrier.ref === value.ref && sameRecipient(o.recipient,recipient) && sameRecipient(link.recipient,recipient)));
      if (!op || !active(op) || !op.dispatched || op.carrier.firstSend === undefined || !op.carrier.cardId) return;
      if (!op.contextOpen || (op.contextUntil ?? 0) <= this.now()) {
        if (op.carrier.messageId === evt.messageId) await this.im.reply(evt.chatId,evt.messageId,expiredContext);
        return;
      }
      if (op.carrier.messageId !== evt.messageId) {
        if (op.carrier.messageId || !await this.im.matches(evt.messageId,evt.chatId,op.carrier.cardId)) return;
        await this.change(p,op.view.operationId,row => {
          row.carrier.messageId = evt.messageId; row.view.deliveryUnknown = false;
          if (row.view.state === 'sending') { row.view.state = row.payload||row.rich?.request ? 'candidate' : 'waiting'; row.view.payloadDigest = row.proposalDigest; }
        });
      }
      if (value.verb === 'cancel') {
        if (op.view.state === 'cancelPending') return;
        this.interact(p);
        await this.change(p,op.view.operationId,row => { row.view.state = 'cancelPending'; setCard(row,'pending'); });
      } else {
        if (!['prepare','confirm'].includes(op.carrier.mode) || !['sending','waiting','candidate'].includes(op.view.state)) return;
        if (op.view.format!=='rich-v2' && (op.view.purpose === 'editDraft') !== (op.carrier.mode === 'confirm')) return;
        if (op.carrier.mode === 'confirm') {
          const details = editCandidate(op);
          if (!details || op.carrier.previewDigest !== details.payloadDigest ||
              op.carrier.dirty || !candidateConfirmation(op.carrier.ref,details,op.creatorSave)) {
            await this.change(p,op.view.operationId,row => setCard(row,'confirm'));
            await this.refresh(p,op.view.operationId);
            return;
          }
        }
        this.interact(p);
        const source = await this.validate(p,op);
        if(op.view.format==='rich-v2'){
          const request=op.rich?.request;
          if(!request||op.carrier.mode!=='confirm'||op.carrier.previewDigest!==richReviewDigest(op.rich!))refusal();
          await this.change(p,op.view.operationId,(row,link,db)=>{
            if(!row.contextOpen||(row.contextUntil??0)<=this.now()||row.carrier.ref!==value.ref||row.carrier.dirty||
              !row.rich?.request||richReviewDigest(row.rich)!==row.carrier.previewDigest)refusal();
            renewCreatorBinding(db,link,this.now());
            row.view.payloadDigest=richReviewDigest(row.rich);row.view.state='pendingCloud';
            row.editApproval=editApproval(row,row.view.payloadDigest);setCard(row,'pending');
          });
          await this.refresh(p,op.view.operationId);return;
        }
        if(source&&op.source?.setup?.steps.length)throw new Error('请重新选择群配置；setup 按普通技能分享。');
        const frozen = source ? freezePayload({public:blankPublic(),config:{role:source.role}}) :
          op.payload && op.proposalDigest ? {payload:op.payload,payloadDigest:op.proposalDigest} : undefined;
        if (!frozen || digest(Buffer.from(frozen.payload,'base64url')) !== frozen.payloadDigest) refusal();
        await this.change(p,op.view.operationId,(row,link,db) => {
          this.present(p);
          if (!row.contextOpen || (row.contextUntil ?? 0) <= this.now() || row.carrier.ref !== value.ref) refusal();
          renewCreatorBinding(db,link,this.now());
          if (row.view.purpose === 'editDraft') {
            if (row.carrier.dirty || row.carrier.previewDigest !== frozen.payloadDigest ||
                row.proposalDigest !== frozen.payloadDigest || row.payload !== op.payload) refusal();
            row.editApproval = editApproval(row,frozen.payloadDigest);
          }
          row.contextUntil = this.now()+CONTEXT; row.payload = frozen.payload; row.view.payloadDigest = frozen.payloadDigest;
          row.view.state = 'pendingCloud'; setCard(row,'pending');
        });
      }
      await this.refresh(p,op.view.operationId);
    }).catch(() => undefined);
  }
}

export class AuthoringService extends AuthoringRouter {
  constructor(opts:AuthoringOptions) { super(opts,canRefreshPreview=>new AuthoringSession(opts,canRefreshPreview)); }
}
