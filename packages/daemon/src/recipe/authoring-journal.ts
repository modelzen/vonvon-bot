import {localRichStorage} from './authoring-rich-storage';
import type {RichLocalDraft,SourceCapture} from './authoring-rich-flow';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import type { AuthoringAuthorization, AuthoringOperation, RecipeSetup } from '@vonvon/protocol';
import type { BotIdentity } from '../config/bots';
import { acquireMutex, closeMutex } from '../config/data-access';
import { ensureDurableDirectory, syncDirectory } from '../config/bot-namespace';
import { readLocalText } from '../import/bridge/bounded-local-files';
import { writeFileAtomic } from '../server/atomic-file';
import { digest } from './authoring-wire';
import type { CardMode } from './authoring-im';

export function authoringBotKey(bot: BotIdentity) {
  return digest(JSON.stringify([bot.appId,bot.tenant,bot.createdAt,bot.registrationId ?? null]));
}
export const DAY = 86_400_000;
export interface Recipient { openId: string; chatId: string; tenantKey: string }
export function sameRecipient(a: Recipient | undefined, b: Recipient | undefined) {
  return Boolean(a && b && a.openId === b.openId && a.chatId === b.chatId && a.tenantKey === b.tenantKey);
}
export interface Source { groupId: string; reviewToken: string; setup?: RecipeSetup; rich?:{ref:string;draft:RichLocalDraft;identity:string} }
let lastSelectionOrder=0;
const selectionIntake=new AsyncLocalStorage<number>();
function nextSelectionOrder(now:number){return lastSelectionOrder=Math.max(lastSelectionOrder+1,now*1000);}
/** Preserve the inbound event's order across account checks, source validation and the per-session queue. */
export function atRecipeIntake<T>(now:number,run:()=>Promise<T>){return selectionIntake.run(nextSelectionOrder(now),run);}
export function recipeSelectionOrder(now:number){return selectionIntake.getStore()??nextSelectionOrder(now);}
export interface Link { selectionOrder?:number; wake?: import('./private-creator').CreatorWake; creator?: import('./private-creator').CreatorLedger; bot: string; binding: string; recipient: Recipient; sources: Source[]; context?: {operationId: string; until: number} }
export interface Carrier {
  ref: string; sendUuid: string; generation: number; seq: number; mode: CardMode; dirty: boolean;
  cardId?: string; messageId?: string; firstSend?: number; createdAt?: number;
  previewDigest?: string; unavailable?: true; retryAt?: number; retryDelay?: number;
}
export const newCarrier = (mode: CardMode, generation = 1): Carrier => ({
  ref: randomUUID(), sendUuid: randomUUID(), generation, seq: 0, mode, dirty: false,
});
export function setCard(op: LocalOperation, mode: CardMode) {
  const c = op.carrier;
  if (mode !== 'pending' || op.view.state !== 'pendingCloud') delete op.editApproval;
  c.mode = mode; c.ref = randomUUID(); c.seq++; c.dirty = true;
  delete c.retryAt; delete c.retryDelay; delete c.previewDigest;
}
export function cardUpdate(op: LocalOperation, now: number): AuthoringOperation['cardUpdate'] {
  const c = op.carrier;
  if (!c.dirty || !c.messageId || !c.cardId) return;
  const created = c.createdAt ?? op.view.createdAt;
  if (c.unavailable || now < created || now - created >= 14 * DAY) return 'unavailable';
  return (c.retryAt ?? 0) > now ? 'backoff' : 'pending';
}
export function operationView(op: LocalOperation, now: number): AuthoringOperation {
  const update = cardUpdate(op, now);
  return update ? {...op.view, cardUpdate:update} : op.view;
}
export interface LocalOperation {
  creatorSave?:true;
  view: AuthoringOperation;
  accountId: string; scope: string; bot: string; binding: string; recipient: Recipient; carrier: Carrier;
  secret?: string; nonce?: string; source?: Source; sourceIdentity?: string; payload?: string; proposalDigest?: string;
  originalGroup?:{groupId:string;identity:string};
  rich?: RichLocalDraft;
  richSourceOriginal?:SourceCapture;
  richSaved?:NonNullable<RichLocalDraft['base']>;
  editApproval?: string;
  dispatchAuthorization?: AuthoringAuthorization;
  richDispatch?:import('./authoring-rich-proof').RichAuthorization;
  dispatched: boolean; revoked?: true; contextOpen?: boolean; instructionId?: string; seenInstructions?: string[]; terminalAt?: number; contextUntil?: number;
}
export function editApproval(op: LocalOperation, payloadDigest: string) {
  return digest(JSON.stringify(['exact-edit-v1', op.view.operationId, op.accountId, op.scope, op.bot, op.binding,
    op.recipient.tenantKey, op.recipient.chatId, op.recipient.openId, op.carrier.cardId, op.carrier.messageId,
    op.view.targetPublicKey, op.view.nonceCommitment, op.view.draftId, op.view.baseRevision, payloadDigest]));
}
export interface AuthoringLedger {
  resources?: Record<string, import('./resource-context').ResourceHandoff>;
  handoffs?: Record<string, import('./authoring-handoff-menu').PrivateHandoff>;
  version: 1; links: Record<string, Link>; operations: Record<string, LocalOperation>;
  daily: Record<string, {day: string; count: number}>;
}
const CREATOR_SELECTION_TTL = 30 * 60_000;
export function recordRecipeSelection(db:AuthoringLedger,current:Link,order:number) {
  if(Object.values(db.links).some(link=>link.bot===current.bot&&sameRecipient(link.recipient,current.recipient)&&(link.selectionOrder??0)>order))return false;
  current.selectionOrder=order;
  return true;
}
export function selectCreatorBinding(db: AuthoringLedger, current: Link, now: number, order=recipeSelectionOrder(now)) {
  if(!recordRecipeSelection(db,current,order))throw new CreatorSelectionChanged();
  for(const row of Object.values(db.resources??{}))if(row.bot===current.bot&&sameRecipient(row.recipient,current.recipient))row.focus=false;
  for (const link of Object.values(db.links)) if (link.bot === current.bot && sameRecipient(link.recipient,current.recipient)) {
    if(link.wake?.cardRef&&link.creator)delete link.creator.cards[link.wake.cardRef];
    if(link.wake?.jobId&&link.creator)delete link.creator.jobs[link.wake.jobId];
    delete link.wake;
    if(link.creator){delete link.creator.chosenUntil;delete link.creator.accountChoice;}
  }
  (current.creator ??= {jobs:{},cards:{}}).chosenUntil = now + CREATOR_SELECTION_TTL;
}
export function selectCreatorOperation(db: AuthoringLedger, link: Link, now: number, draftId?: string) {
  selectCreatorBinding(db,link,now);
  const creator=link.creator!;
  delete creator.current; delete creator.focusUntil; delete creator.awaitLogo;
  if(draftId)creator.focusDraft=draftId;else delete creator.focusDraft;
}
export function renewCreatorBinding(db: AuthoringLedger, current: Link, now: number) {
  const chosen = Object.values(db.links).filter(link => link.bot === current.bot && sameRecipient(link.recipient,current.recipient) &&
    (link.creator?.chosenUntil ?? 0) > now);
  if (chosen.length === 1 && chosen[0] === current) current.creator!.chosenUntil = now + CREATOR_SELECTION_TTL;
}
export type AuthoringRoute = {key:string;binding:string} & ({kind:'chosen';chosenUntil:number}|{kind:'quoted'}|{kind:'intent'});
export class CreatorSelectionChanged extends Error {}
export function matchesAuthoringRoute(db: AuthoringLedger, current: Link, route: AuthoringRoute, now: number) {
  if (db.links[route.key] !== current || current.binding !== route.binding) return false;
  if (route.kind === 'quoted') return true;
  const links = Object.values(db.links).filter(link => link.bot === current.bot && sameRecipient(link.recipient,current.recipient));
  const chosen = links.filter(link => (link.creator?.chosenUntil ?? 0) > now);
  return route.kind === 'intent' ? links.length === 1 && chosen.length === 0 : chosen.length === 1 && chosen[0] === current && current.creator?.chosenUntil === route.chosenUntil;
}
export const active = (op: LocalOperation) => op.terminalAt === undefined;
export function discardAuthoringMaterial(op: LocalOperation) {
  delete op.richDispatch; delete op.secret; delete op.nonce; delete op.dispatchAuthorization; delete op.payload; delete op.source;
  delete op.rich; delete op.richSourceOriginal; delete op.editApproval; delete op.view.payloadDigest; delete op.proposalDigest;
}
export function retire(op: LocalOperation, state: 'completed' | 'cancelled' | 'expired', now: number) {
  op.view.state = state;
  if(state!=='completed')delete op.richSaved;
  op.view.deliveryUnknown = false;
  op.terminalAt = now;
  discardAuthoringMaterial(op);
}
export function maintain(ledger: AuthoringLedger, now: number) {
  for(const [id,row] of Object.entries(ledger.resources??{}))if(row.expires+7*DAY<=now)delete ledger.resources![id];
  for(const link of Object.values(ledger.links))if(link.wake&&link.wake.expiresAt<=now){
    const creator=link.creator,wake=link.wake;
    if(creator&&wake.cardRef&&!Object.values(creator.jobs).some(job=>job.receiptCard&&job.resultCard===wake.cardRef))delete creator.cards[wake.cardRef];
    const job=creator&&wake.jobId&&creator.jobs[wake.jobId];
    if(creator&&job&&job.job.task.kind==='read'&&job.job.task.read.kind==='works'&&!job.receiptCard)delete creator.jobs[job.job.id];
    delete link.wake;
  }
  for(const [id,h] of Object.entries(ledger.handoffs??{})){
    if(h.expiresAt+7*DAY<=now){delete ledger.handoffs![id];continue;}
    if(h.expiresAt<=now&&!['prepared','cancelled','needsReview'].includes(h.phase.state)){
      h.phase={state:'expired'};delete h.edit;
    }
  }
  for (const [id, op] of Object.entries(ledger.operations)) {
    if (active(op) && op.view.createdAt + DAY <= now) {
      // An accept response may have been lost. Keep tracking until the original account settles it, even after cloud retention.
      if (op.view.state === 'pendingCloud' || op.view.state === 'cancelPending') {
        op.view.state = 'cancelPending';
        // Recovery needs only the registration commitment and a receipt; do not retain candidate text or keys indefinitely.
        discardAuthoringMaterial(op);
      } else {
        retire(op, 'expired', op.view.createdAt + DAY);
        if (!op.revoked) setCard(op, 'expired');
      }
    } else if (op.terminalAt !== undefined && op.terminalAt + 7 * DAY <= now) delete ledger.operations[id];
  }
  const day = new Date(now).toISOString().slice(0,10);
  for (const [key, budget] of Object.entries(ledger.daily)) if (budget.day !== day) delete ledger.daily[key];
}
export function reserve(ledger: AuthoringLedger, account: string, now: number) {
  const day = new Date(now).toISOString().slice(0,10);
  const count = ledger.daily[account]?.day === day ? ledger.daily[account]!.count : 0;
  if (count >= 60 || Object.values(ledger.operations).filter(op => op.accountId === account && active(op)).length >= 3)
    throw new Error('进行中的配方请求或今日请求数已到上限。');
  ledger.daily[account] = {day, count: count + 1};
}
export function linkKey(scope: string, account: string) { return digest(JSON.stringify([scope, account])); }
export class AuthoringJournal {
  constructor(private readonly root: string, private readonly now: () => number) {}
  async run<T>(edit: (ledger: AuthoringLedger) => T,beforeCommit?:()=>void): Promise<T> {
    const dir = join(this.root, 'recipe-authoring');
    await ensureDurableDirectory(dir);
    const file = join(dir, 'journal.json');
    const lock = await acquireMutex(dir, 'creation', 10000);
    try {
      const before = await readLocalText(dir, file, undefined, 8 * 1024 * 1024);
      const ledger: AuthoringLedger = before === undefined ? {version: 1, links: {}, operations: {}, daily: {}} : JSON.parse(before);
      if (ledger.version !== 1 || !ledger.links || !ledger.operations || !ledger.daily) throw new Error('配方操作记录无法读取。');
      const persist=localRichStorage(dir,ledger);
      maintain(ledger, this.now());
      const result = structuredClone(edit(ledger));
      const clean=await persist();
      const after = JSON.stringify(ledger);
      if (after !== before) {
        if (Buffer.byteLength(after) > 8 * 1024 * 1024) throw new Error('本机配方操作记录已满。');
        await writeFileAtomic(file, after, {durable: true,beforeCommit});
      }
      // The atomic writer allows a best-effort directory fsync. Authoring's next irreversible action needs a durable result.
      await syncDirectory(dir);
      await clean();
      return result;
    } finally { await closeMutex(lock); }
  }
}
