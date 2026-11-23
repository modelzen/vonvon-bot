import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import { groupIdSchema, recipeAuthoringRequestSchema, type AuthoringAuthorization, type AuthoringReceipt, type AuthoringReconciliation, type RecipeAuthoringRequest, type RecipeAuthoringReply } from '@vonvon/protocol';
import { assertBotIdentity, withRegisteredBot, type BotIdentity } from '../config/bots';
import { isAdmin, type AppConfig } from '../config/schema';
import { paths } from '../config/paths';
import { configuredRecipeApiOrigin } from '../config/account-deployment';
import { AuthoringIm, physicalChat } from './authoring-im';
import { authoringBotKey, discardAuthoringMaterial, AuthoringJournal, active, cardUpdate, linkKey, newCarrier, operationView, reserve, retire, sameRecipient, setCard, type AuthoringLedger, type Link, type LocalOperation, type Recipient, type Source } from './authoring-journal';
import { blankPublic, digest, freezePayload, newAuthoringKey, parseChanges, type DraftInstructionParser } from './authoring-wire';
import { checkAuthorization, postAuthoring } from './authoring-cloud';
import { groupSourceIdentity, reviewSource, type ReviewedSource } from './authoring-source';
import { operationUuid } from './manifest';

export interface AuthoringPeer {id: string; device: string}
export type AuthoringIpc = {kind: 'recipeAuthoring'; peer: AuthoringPeer; request: RecipeAuthoringRequest} |
  {kind: 'recipeAuthoringDisconnect'; peer: AuthoringPeer};
interface Presence {peer: AuthoringPeer; session: string; account: string; scope: string; until: number}
interface Challenge {
  id: string; session: string; hash: Buffer; expiresAt: number; attempts: number;
  recipient?: Recipient; messageId?: string; evidence?: string;
}
interface Options {
  bot: BotIdentity; cfg: AppConfig; channel: LarkChannel; root?: string; now?: () => number;
  origin?: string; fetch?: typeof fetch; loopback?: boolean; parser?: DraftInstructionParser;
  currentBot?: () => Promise<void>; source?: (scope: string, account: string, group: string) => Promise<ReviewedSource>;
}
const LEASE = 45_000;
const SEND_WINDOW = 55 * 60_000;
const CONTEXT = 30 * 60_000;
const genericLink = '请打开 Vonvon App 的配方草稿，选择这个 Bot 并关联本人飞书私聊。';
const appChoose = '请到 Vonvon App 选择来源群或草稿，再从这次私聊继续。';
const privateOnly = '此处仅编辑私人草稿。请用 /recipe 查看命令，或到 App 核对。';
const paused = '请打开 Vonvon App 并登录原账号，继续本次草稿操作。';
const messageSender = z.object({sender: z.object({sender_type: z.literal('user'), tenant_key: z.string().min(1).max(200),
  sender_id: z.object({open_id: z.string().regex(/^ou_[\w-]{1,200}$/)})}),
  message: z.object({message_id: z.string(), chat_id: z.string(), chat_type: z.literal('p2p')})});
const operator = z.object({operator: z.object({open_id: z.string(), tenant_key: z.string().min(1).max(200)})});
const click = z.object({a: z.literal('recipe.authoring'), ref: z.string().uuid(), verb: z.enum(['confirm','cancel'])}).strict();
function fromMessage(msg: NormalizedMessage): Recipient | undefined {
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
function reconciliationOf(op: LocalOperation): AuthoringReconciliation {
  const {operationId,purpose,targetPublicKey,nonceCommitment,draftId,baseRevision,createdAt,receipt} = op.view;
  return {operationId,purpose,targetPublicKey,nonceCommitment,draftId,baseRevision,createdAt,receipt};
}
function refusal(): never { throw new Error('身份、来源或草稿上下文已改变，请回到 App 核对。'); }

export class AuthoringService {
  private p?: Presence;
  private challenge?: Challenge;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly ledger: AuthoringJournal;
  private readonly im: AuthoringIm;
  private readonly botKey: string;
  private readonly now: () => number;
  private readonly origin?: string;
  constructor(private readonly opts: Options) {
    this.now = opts.now ?? Date.now;
    this.botKey = authoringBotKey(opts.bot);
    this.im = new AuthoringIm(opts.channel);
    this.origin = opts.origin ?? configuredRecipeApiOrigin();
    this.ledger = new AuthoringJournal(opts.root ?? paths.appDir, this.now);
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.then(() => {}, () => {});
    return result;
  }
  private current() { return this.opts.currentBot?.() ?? assertBotIdentity(this.opts.bot); }
  private present(p: Presence) {
    if (this.stopped || this.p !== p || p.until <= this.now()) throw new Error(paused);
  }
  disconnect(id: string) {
    if (this.p?.peer.id === id) { this.p = undefined; this.challenge = undefined; }
  }
  async adminRemoved(openId: string) {
    if (this.challenge?.recipient?.openId === openId) this.challenge = undefined;
    await this.ledger.run(db => {
      for (const [key,link] of Object.entries(db.links)) if (link.bot === this.botKey && link.recipient.openId === openId) delete db.links[key];
      for (const op of Object.values(db.operations)) if (op.bot === this.botKey && op.recipient.openId === openId) revokeOperation(op);
    });
  }
  close() { this.stopped = true; this.p = undefined; this.challenge = undefined; }
  private liveLink(db: AuthoringLedger, p: Presence) {
    this.present(p);
    const key = linkKey(p.scope,p.account), link = db.links[key];
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
  private change<T>(p: Presence, id: string, fn: (op: LocalOperation) => T) {
    return this.ledger.run(db => {
      const op = this.locate(db,p,id);
      if (!bound(op,this.liveLink(db,p))) refusal();
      return fn(op);
    });
  }
  private operation(p: Presence, id: string) { return this.change(p,id,op => op); }
  private source(p: Presence, group: string) {
    return this.opts.source?.(p.scope, p.account, group) ?? reviewSource(this.opts.channel, this.opts.bot, p.scope, p.account, group);
  }
  private async sourceNow(p: Presence, op: LocalOperation) {
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
    if (req.type === 'close') {
      if (this.p?.peer.id === peer.id && this.p.session === req.session) this.disconnect(peer.id);
      return {kind:'closed'};
    }
    if (req.type === 'open') {
      const scope = digest(JSON.stringify([peer.device, this.opts.bot.appId, this.opts.bot.tenant, this.opts.bot.createdAt, this.opts.bot.registrationId ?? null]));
      if (this.p?.account !== req.accountId || this.p?.peer.id !== peer.id || this.p?.scope !== scope || this.p.until <= this.now()) {
        this.challenge = undefined;
        this.p = {peer, session: randomUUID(), account: req.accountId, scope, until: this.now()+LEASE};
      }
      const p = this.p;
      p.until = this.now()+LEASE;
      await this.current();
      const linked = Boolean(await this.link(p));
      this.present(p);
      return {kind:'session', session:p.session, linked, leaseMs: LEASE};
    }
    const p = this.p;
    if (!p || p.peer.id !== peer.id || p.peer.device !== peer.device || p.session !== req.session) refusal();
    this.present(p);
    p.until = this.now()+LEASE;
    return this.serial(async () => {
      this.present(p);
      await this.current();
      switch (req.type) {
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
              if (op.scope !== p.scope || op.accountId !== p.account) continue;
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
        case 'groupSourceIdentity': {
          const identity = await groupSourceIdentity(this.opts.channel, this.opts.bot, p.scope, req.groupId);
          this.present(p);
          return {kind:'groupSourceIdentity', groupId:req.groupId, identity};
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
        case 'reviewSource': {
          await this.allowed(p);
          const {identity: _localBinding, ...source} = await this.source(p,req.groupId);
          await this.allowed(p);
          return source;
        }
        case 'prepare': {
          const linked = await this.allowed(p), review = await this.source(p,req.groupId);
          if (review.reviewToken !== req.reviewToken) refusal();
          freezePayload({public:blankPublic(),config:{role:review.role, ...(req.setup ? {setup:req.setup} : {})}});
          const source = {groupId:req.groupId, reviewToken:req.reviewToken, setup:req.setup};
          return this.start(p, linked.recipient, {source,sourceIdentity:review.identity});
        }
        case 'edit': {
          const link = await this.allowed(p);
          return this.start(p, link.recipient, {draftId:req.draftId, baseRevision:req.baseRevision});
        }
        case 'inspectCandidate': {
          const op = await this.operation(p,req.operationId);
          await this.validate(p,op);
          const payloadDigest = op.view.state === 'candidate' ? op.proposalDigest : op.view.state === 'pendingCloud' ? op.view.payloadDigest : undefined;
          if (!op.payload || !payloadDigest) refusal();
          return {kind:'candidate',operationId:req.operationId,payloadDigest,payload:op.payload};
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
        case 'updateCard': await this.refresh(p,req.operationId); break;
        case 'settle': await this.settle(p,req.receipt,req.operationId); break;
        case 'advance': await this.advance(p,req.operationId,req.authorization); break;
        case 'resend':
        case 'deliver': await this.deliver(p,req.operationId,req.type === 'resend'); break;
      }
      return {kind:'operation',operation:await this.change(p,req.operationId,op => operationView(op,this.now()))};
    });
  }
  private async start(p: Presence, recipient: Recipient, target: {source?: Source; sourceIdentity?: string; draftId?: string; baseRevision?: number; instructionId?: string; payload?: string; proposalDigest?: string}): Promise<RecipeAuthoringReply> {
    if (target.source && !target.sourceIdentity) refusal();
    const op = await withRegisteredBot(this.opts.bot.appId, () => this.ledger.run(db => {
      this.present(p);
      const link = db.links[linkKey(p.scope,p.account)];
      if (!sameRecipient(link?.recipient, recipient) || !isAdmin(this.opts.cfg,recipient.openId)) refusal();
      const current = Object.values(db.operations).filter(o => o.scope === p.scope && o.accountId === p.account && o.binding === link!.binding && sameRecipient(o.recipient,recipient));
      const prior = current.find(o => target.instructionId && (o.instructionId === target.instructionId || o.seenInstructions?.includes(target.instructionId))) ??
        current.find(o => active(o) && (target.draftId ? o.view.draftId === target.draftId :
          o.source?.groupId === target.source?.groupId && o.source?.reviewToken === target.source?.reviewToken));
      if (prior) {
        if (target.sourceIdentity && !prior.sourceIdentity && prior.source?.reviewToken === target.source?.reviewToken) prior.sourceIdentity = target.sourceIdentity;
        if (active(prior) && (target.draftId ? prior.view.baseRevision !== target.baseRevision : JSON.stringify(prior.source) !== JSON.stringify(target.source))) refusal();
        if (active(prior) && !target.instructionId && (!prior.contextOpen || (prior.contextUntil ?? 0) <= this.now())) {
          prior.contextOpen = true; prior.contextUntil = this.now()+CONTEXT; setCard(prior,prior.carrier.mode);
          link!.context = {operationId:prior.view.operationId,until:prior.contextUntil};
        }
        return prior;
      }
      reserve(db,p.account,this.now());
      const material = newAuthoringKey();
      const operationId = operationUuid(this.now());
      const row: LocalOperation = {accountId:p.account, scope:p.scope, bot:this.botKey, binding:link!.binding, recipient, secret:material.secret, nonce:material.nonce,
        source:target.source, sourceIdentity:target.sourceIdentity, instructionId: target.instructionId, payload: target.payload, proposalDigest: target.proposalDigest,
        contextUntil:this.now()+CONTEXT, carrier:newCarrier(target.source ? 'prepare' : target.payload ? 'confirm' : 'edit'), dispatched:false, contextOpen:true,
        view:{operationId, targetPublicKey:material.targetPublicKey, nonceCommitment:material.nonceCommitment,
          purpose:target.source ? 'prepareDraft' : 'editDraft', draftId:target.draftId, baseRevision:target.baseRevision,
          groupId:target.source ? groupIdSchema.parse(target.source.groupId) : undefined,
          state:'pendingMain', deliveryUnknown:false,createdAt:this.now()}};
      if (target.source) {
        link!.sources = [target.source, ...link!.sources.filter(s => s.groupId !== target.source!.groupId)].slice(0,16);
      }
      for (const prior of current) if (prior.view.state === 'completed') prior.contextOpen = false;
      link!.context = {operationId, until:this.now()+CONTEXT};
      db.operations[operationId] = row;
      return row;
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
  private async advance(p: Presence, id: string, auth: AuthoringAuthorization) {
    const op = await this.operation(p,id);
    if (!active(op) || op.view.receipt) return;
    await this.validate(p,op);
    if (auth.stage === 'dispatch' && op.dispatched) { await this.deliver(p,id,false); return; }
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
      delete row.dispatchAuthorization;
      if (row.view.state === 'pendingMain') row.view.state = 'sending';
    });
  }
  private async refresh(p: Presence, id: string) {
    await this.current();
    const pending = await this.change(p,id,op => {
      const c = op.carrier;
      if (cardUpdate(op,this.now()) !== 'pending') return;
      return {cardId:c.cardId!, messageId:c.messageId!, seq:c.seq, ref:c.ref, mode:c.mode, recipient:op.recipient};
    });
    if (!pending) return;
    this.present(p);
    if (!isAdmin(this.opts.cfg,pending.recipient.openId)) refusal();
    const {cardId,messageId,seq,ref,mode,recipient} = pending;
    let result = await this.im.update(cardId,seq,ref,mode);
    if (result === 'conflict') {
      // A duplicate UUID or old sequence is not an acknowledgement of these bytes.
      const current = await this.change(p,id,op => op.carrier.cardId === cardId && op.carrier.ref === ref);
      this.present(p);
      if (current && isAdmin(this.opts.cfg,recipient.openId) && await this.im.shows(messageId,recipient.chatId,ref,mode).catch(() => false)) result = 'updated';
    }
    await this.change(p,id,op => {
      const c = op.carrier;
      if (c.cardId !== cardId || c.ref !== ref || c.seq !== seq) return;
      if (result === 'updated') { c.dirty = false; delete c.retryAt; delete c.retryDelay; }
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
      const cap = op.dispatchAuthorization;
      if (!cap) refusal();
      this.present(p);
      const result = await postAuthoring(this.origin!,op,cap,this.opts.fetch,this.opts.loopback);
      if (result.status !== 'dispatched') refusal();
      await this.markDispatched(p,id);
    }
    op = await this.operation(p,id);
    if (op.carrier.messageId) {
      if ((op.contextUntil ?? 0) <= this.now() && op.contextOpen && (op.view.state === 'waiting' || op.view.state === 'candidate')) {
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
      const cardId = await this.im.create(op.carrier.ref,op.carrier.mode);
      op = await this.change(p,id,row => { row.carrier.cardId = cardId; row.carrier.createdAt = createdAt; return row; });
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
      if (row.view.state === 'sending') { row.view.state = row.payload ? 'candidate' : 'waiting'; row.view.payloadDigest = row.proposalDigest; }
    });
  }
  async onMessage(msg: NormalizedMessage): Promise<boolean> {
    const explicit = /^\/recipe(?:\s|$)/i.test(msg.content.trimStart());
    const recipient = fromMessage(msg);
    if (!recipient) {
      if (explicit || msg.chatType !== 'p2p' || !this.origin) return explicit;
      // An incomplete identity on a message in an active private draft must never fall through to the ordinary tool-enabled Agent.
      return this.ledger.run(db => Object.values(db.operations).some(op => op.bot === this.botKey && op.contextOpen &&
        op.recipient.chatId === msg.chatId && op.recipient.openId === msg.senderId && (op.contextUntil ?? 0) > this.now())).catch(() => true);
    }
    if (!this.origin) { if (explicit) await this.im.reply(msg.chatId,msg.messageId,paused); return explicit; }
    return this.serial(async () => {
      const reply = (text: string) => this.im.reply(msg.chatId,msg.messageId,text);
      const p = this.p;
      const live = Boolean(p && !this.stopped && p.until > this.now());
      const cmd = msg.content.trim();
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
      const {duplicate,contexts} = await this.ledger.run(db => {
        const own = Object.values(db.operations).filter(o => o.bot === this.botKey && sameRecipient(o.recipient,recipient));
        return {
          duplicate: own.some(o => o.instructionId === msg.messageId || o.seenInstructions?.includes(msg.messageId)),
          contexts: own.filter(o => o.contextOpen && (Boolean(msg.replyToMessageId) && o.carrier.messageId === msg.replyToMessageId ||
            (o.contextUntil ?? 0) > this.now() && (active(o) || o.view.state === 'completed'))),
        };
      });
      if (duplicate) return true;
      if (!explicit && !contexts.length) return false;
      if (msg.rawContentType !== 'text') { await reply(privateOnly); return true; }
      if (!live || !p) { await reply(explicit ? genericLink : paused); return true; }
      const link = await this.link(p);
      if (!sameRecipient(link?.recipient, recipient)) { await reply(genericLink); return true; }
      if (!link) refusal();
      const eligible = contexts.filter(o => o.scope === p.scope && o.accountId === p.account && o.binding === link.binding);
      const quoted = msg.replyToMessageId ? eligible.find(o => o.carrier.messageId === msg.replyToMessageId) : undefined;
      if (msg.replyToMessageId && !quoted) { await reply(appChoose); return true; }
      const open = eligible.filter(o => active(o));
      const selected = quoted ?? (open.length === 1 ? open[0] : !open.length ? eligible.find(o => o.view.operationId === link.context?.operationId) : undefined);
      if (cmd === '/recipe end') {
        await this.ledger.run(db => {
          for (const row of Object.values(db.operations)) {
            if (row.scope === p.scope && row.accountId === p.account && row.binding === link.binding && sameRecipient(row.recipient,recipient) && (!quoted || row.view.operationId === quoted.view.operationId)) row.contextOpen = false;
          }
          const bound = db.links[linkKey(p.scope,p.account)];
          if (bound && (!quoted || bound.context?.operationId === quoted.view.operationId)) delete bound.context;
        });
        await reply('已结束本次私聊编辑。'); return true;
      }
      if (/^\/recipe(?:\s+(?:create|start))?$/i.test(cmd)) {
        if (selected && (active(selected) || cmd === '/recipe' && selected.view.state === 'completed')) { await reply(active(selected) ? '请在当前草稿卡片操作，或用 /recipe name 名称 等命令编辑。' : '私人草稿已保存。可用 /recipe name 名称 等命令继续修改。'); return true; }
        if (link.sources.length !== 1) { await reply(appChoose); return true; }
        const source = link.sources[0]!;
        const reviewed = await this.source(p,source.groupId);
        if (reviewed.reviewToken !== source.reviewToken) { await reply(appChoose); return true; }
        await this.start(p,recipient,{source,sourceIdentity:reviewed.identity,instructionId:msg.messageId});
        await reply('已请求准备私人草稿。云端登记后，Bot 会在这里发确认卡。'); return true;
      }
      if (!selected || !selected.contextOpen || (selected.contextUntil ?? 0) <= this.now()) { await reply(appChoose); return true; }
      if (selected.seenInstructions?.includes(msg.messageId) || selected.instructionId === msg.messageId) return true;
      const prior = selected.view.receipt;
      const draftId = prior?.status === 'accepted' ? prior.draftId : selected.view.draftId;
      const baseRevision = prior?.status === 'accepted' ? prior.revision : selected.view.baseRevision;
      if (!draftId || !baseRevision || (selected.view.state !== 'waiting' && selected.view.state !== 'candidate' && selected.view.state !== 'completed')) {
        await reply(privateOnly); return true;
      }
      let frozen: ReturnType<typeof freezePayload>;
      try {
        const changes = await parseChanges(cmd,this.opts.parser);
        frozen = freezePayload({schemaVersion:1, draftId, baseRevision, changes});
      } catch { await reply(privateOnly); return true; }
      await this.allowed(p,recipient);
      if (selected.view.state === 'completed') {
        await this.start(p,recipient,{draftId,baseRevision,instructionId:msg.messageId,payload:frozen.payload,proposalDigest:frozen.payloadDigest});
      } else {
        await this.change(p,selected.view.operationId,row => {
          this.present(p);
          if ((row.seenInstructions?.length ?? 0) >= 32) throw new Error('本次草稿提案已到输入上限。');
          row.payload = frozen.payload; row.proposalDigest = frozen.payloadDigest;
          (row.seenInstructions ??= []).push(msg.messageId); row.view.state = 'candidate'; row.view.payloadDigest = frozen.payloadDigest;
          setCard(row,'confirm');
        });
        await this.refresh(p,selected.view.operationId);
      }
      return true;
    }).catch(async () => {
      await this.im.reply(msg.chatId,msg.messageId,privateOnly);
      return true;
    });
  }
  async onAction(evt: CardActionEvent) {
    const value = click.safeParse(evt.action?.value).data, raw = operator.safeParse(evt.raw).data;
    if (!value || !raw || evt.operator.openId !== raw.operator.open_id || !physicalChat(evt.chatId)) return;
    return this.serial(async () => {
      const p = this.p;
      if (!p || p.until <= this.now()) return;
      const recipient = {openId:evt.operator.openId, chatId:evt.chatId, tenantKey:raw.operator.tenant_key};
      const link = await this.allowed(p,recipient);
      const op = await this.ledger.run(db => Object.values(db.operations).find(o => o.scope === p.scope && o.accountId === p.account &&
        o.binding === link.binding && o.carrier.ref === value.ref && sameRecipient(o.recipient,recipient) && sameRecipient(link.recipient,recipient)));
      if (!op || !active(op) || !op.dispatched || !op.contextOpen || (op.contextUntil ?? 0) <= this.now() || op.carrier.firstSend === undefined || !op.carrier.cardId) return;
      if (op.carrier.messageId !== evt.messageId) {
        if (op.carrier.messageId || !await this.im.matches(evt.messageId,evt.chatId,op.carrier.cardId)) return;
        await this.change(p,op.view.operationId,row => {
          row.carrier.messageId = evt.messageId; row.view.deliveryUnknown = false;
          if (row.view.state === 'sending') { row.view.state = row.payload ? 'candidate' : 'waiting'; row.view.payloadDigest = row.proposalDigest; }
        });
      }
      if (value.verb === 'cancel') {
        await this.change(p,op.view.operationId,row => { row.view.state = 'cancelPending'; setCard(row,'pending'); });
      } else {
        if (!['prepare','confirm'].includes(op.carrier.mode) || !['sending','waiting','candidate'].includes(op.view.state)) return;
        const source = await this.validate(p,op);
        const frozen = source ? freezePayload({public:blankPublic(),config:{role:source.role, ...(op.source?.setup ? {setup:op.source.setup} : {})}}) :
          op.payload && op.proposalDigest ? {payload:op.payload,payloadDigest:op.proposalDigest} : undefined;
        if (!frozen || digest(Buffer.from(frozen.payload,'base64url')) !== frozen.payloadDigest) refusal();
        await this.change(p,op.view.operationId,row => {
          this.present(p);
          row.payload = frozen.payload; row.view.payloadDigest = frozen.payloadDigest;
          row.view.state = 'pendingCloud'; setCard(row,'pending');
        });
      }
      await this.refresh(p,op.view.operationId);
    }).catch(() => undefined);
  }
}
