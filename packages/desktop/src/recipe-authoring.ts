import {communityRequest} from './community-api.js';
import {inheritedPublication} from './recipe-publication-inheritance.js';
import {richAuthoringCloud,richTerminal,UnavailableSourceItems} from './recipe-authoring-rich-cloud.js';
import {LocalRecipeDrafts,type LocalRecipeDraftRecord} from './local-recipe-drafts.js';
import {bindLocalRichMembers,freezeLocalRich,buildLocalRichRecord} from './local-recipe-content.js';
import {creatorAssociationSchema,type CreatorAssociation} from './recipe-creator-journal.js';
import {safeDraftModelText, safeEditValue} from '../../../services/recipe-api/src/draft-model-text.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authoringCandidateContentSchema,
  decodeRichRecipeContent,
  desktopAuthoringReplySchema,
  desktopAuthoringRequestSchema,
  deviceReplySchema,
  recipeBinary32Schema,
  recipeAuthoringReplySchema,
  type SourceHistoryEntry,
  type AuthoringOperation,
  type HandoffAttestation,
  type AuthoringReceipt,
  type AuthoringSaved,
  type AuthoringReconciliation,
  type DesktopAuthoringOperation,
  type DesktopAuthoringReply,
  type DesktopAuthoringRequest,
  type GroupId,
  type RecipeAuthoringRequest,
  type RecipeAuthoringReply,
} from '@vonvon/protocol';
import type { NativeAccount } from './account-session.js';
import type { RecipeDeviceLease } from './recipe-use.js';
import { authoringCloud, AuthoringError, AuthoringServiceUnavailable, invalidAuthoring } from './recipe-authoring-cloud.js';
import { AuthoringJournal } from './recipe-authoring-journal.js';

type Open = Extract<DesktopAuthoringRequest, { type: 'open' }>;
type Restore = Extract<DesktopAuthoringRequest, {type:'restoreHandoff'}>;
type Intent = {kind:'initial'} | {kind:'restore';retryId:string;operationId?:string};
type SessionReply = Extract<DesktopAuthoringReply,{kind:'session'}>;
type DraftSourceOpen = Extract<DesktopAuthoringRequest, {type:'openDraftSource'}>;
type DraftSource = Pick<DraftSourceOpen, 'draftId' | 'baseRevision'> & {
  operationId:string; deviceId:string; deviceKey:string; groupId?:GroupId; identity?:string;
};
type HandoffScope = {retryId:string;groupId:GroupId;draftId?:string};
type Handle = {
  id: string;
  creator?:boolean;
  intent: Intent;
  open: Open;
  lease: RecipeDeviceLease;
  signal: AbortSignal;
  stop: AbortController;
  deviceId: string;
  deviceKey: string;
  session?: string;
  tail: Promise<void>;
  queued: number;
  attached: boolean;
  ownership: number;
  workflow?: Promise<void>;
  nextRefresh: number;
  sequence: number;
  pausedContexts: Set<string>;
  acknowledgedLocal?:Set<string>;
  lastActivity: number;
  lastVerified?: number;
  retry: Map<string, { state: string; until: number; delay: number; message?: string }>;
  target: DesktopAuthoringOperation['target'];
  groups: Map<GroupId, string>;
  operations: Map<string, AuthoringOperation>;
  groupIdentity?: string;
  draftSource?: DraftSource;
  handoff?: HandoffScope;
  parent?:{recipeId:string;versionId:string};
  attesting?: Promise<void>;
  attestationRetry?: {ref:string;after:number};
  source?: { groupId: GroupId; reviewToken: string };
  challenge?: { id: string; evidence?: string };
  reviewed: Map<string, string>;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
  removeAbort?: () => void;
};
type CreatorContinuation=Extract<DesktopAuthoringReply,{kind:'creatorContinuing'}>;
type CreatorContinue=Extract<DesktopAuthoringRequest,{type:'creatorContinue'}>;
type Action = Exclude<DesktopAuthoringRequest, Open | DraftSourceOpen | Restore | CreatorContinue | {type:'resourceHandoff'|'preparePublication'|'confirmPublication'|'recoverPublication'}>;
type SessionRequest = Extract<RecipeAuthoringRequest,{session:string}>;
type ScopedRequest<T = SessionRequest> = T extends SessionRequest ? Omit<T, 'session' | 'botId'> : never;
const changed = () => new AuthoringError('账号或设备连接已改变，请重新打开原来的配方操作。');
const recheck = () => new AuthoringError('本次选择已改变，请重新核对来源或草稿。');
const terminal = (op: AuthoringOperation) => ['completed', 'cancelled', 'expired'].includes(op.state);
function expiryNotice(receipt?: AuthoringReceipt) {
  return receipt && 'outcome' in receipt ? {syncMessage:'这次操作已到期，无法确认之前是否保存。若已保存，请到 App 的「我的配方」查看。'} : {};
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return (
      '{' +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(obj[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
function expectKind<K extends RecipeAuthoringReply['kind']>(reply: RecipeAuthoringReply, kind: K) {
  if (reply.kind !== kind) throw invalidAuthoring();
  return reply as Extract<RecipeAuthoringReply, { kind: K }>;
}
export class RecipeAuthoringController {
  private readonly drafts:LocalRecipeDrafts;
  private readonly ownsDrafts:boolean;
  private handles = new Map<string, Handle>();
  private opening = new Set<string>();
  constructor(
    private readonly account: NativeAccount,
    private readonly capture: (viewId: string) => RecipeDeviceLease,
    private readonly journal: AuthoringJournal,
    private readonly onSaved?: (receipt: AuthoringSaved) => void,
    localDrafts?:LocalRecipeDrafts,
    private readonly normalizeLogo?:(bytes:Buffer)=>Promise<Buffer>,
  ) {this.drafts=localDrafts??new LocalRecipeDrafts();this.ownsDrafts=!localDrafts;}
  private check(h: Handle) {
    h.lease.check();
    if (h.stop.signal.aborted || this.account.lease?.(h.open.accountId) !== h.signal || h.signal.aborted)
      throw changed();
  }
  private checkIdle(h: Handle) {
    if (Date.now() - h.lastActivity >= 30 * 60_000) {
      this.revoke(h);
      throw new AuthoringError('聊天编辑已暂停，请重新打开原来的配方操作。');
    }
  }
  private richCloud(h:Handle){return richAuthoringCloud(this.account,h.open.accountId,AbortSignal.any([h.signal,h.stop.signal]),()=>this.check(h));}
  private cloud(h: Handle) {
    return authoringCloud(this.account, h.open.accountId, AbortSignal.any([h.signal, h.stop.signal]), () =>
      this.check(h),
    );
  }
  private async identity(h: Handle) {
    this.check(h);
    const reply = deviceReplySchema.parse(await h.lease.client.device({ type: 'status' }));
    this.check(h);
    if (reply.kind !== 'deviceStatus') throw invalidAuthoring();
    const { id, publicKey } = reply.status.device;
    z.string().uuid().parse(id);
    const key = recipeBinary32Schema.parse(publicKey);
    if (
      (h.deviceId && (h.deviceId !== id || h.deviceKey !== key)) ||
      (h.open.viewId !== 'local' && (h.open.viewId !== id || h.lease.pairedKey !== key))
    ) {
      this.revoke(h);
      throw changed();
    }
    h.deviceId = id;
    h.deviceKey = key;
  }
  private async names(h: Handle) {
    this.check(h);
    const snapshot = await h.lease.client.snapshot();
    this.check(h);
    const bot = snapshot.agents.find((b) => b.id === h.open.botId);
    if (!bot) throw new AuthoringError('来源 Bot 已移除或无法连接。');
    if (bot.running === false) throw new AuthoringError('来源 Bot 已停止，请先启动这个 Bot。');
    h.target.botName = bot.name || bot.id;
    h.groups = new Map(
      snapshot.memberships
        .filter((m) => m.agentId === bot.id && !m.stale)
        .map((m) => [m.groupId, snapshot.groups.find((g) => g.id === m.groupId)?.name || m.name || m.groupId]),
    );
  }
  private async daemon(h: Handle, request: ScopedRequest): Promise<RecipeAuthoringReply> {
    await this.identity(h);
    if (request.type === 'restoreHandoff' || request.type === 'answerField' || request.type === 'answerHandoff') {
      await this.present(h,false);
      if (h.lastVerified === undefined || Date.now() - h.lastVerified >= 10_000)
        throw new AuthoringServiceUnavailable('账号服务未确认本次操作，请稍后恢复。');
    }
    this.check(h);
    if (!h.session || !h.lease.client.recipeAuthoring) throw changed();
    const reply = recipeAuthoringReplySchema.parse(
      await h.lease.client.recipeAuthoring({
        ...request,
        session: h.session,
        botId: h.open.botId,
      }),
    );
    this.check(h);
    return reply;
  }
  private revoke(h: Handle, close=true) {
    if (h.stop.signal.aborted) return;
    this.handles.delete(h.id);
    h.stop.abort();
    clearInterval(h.timer);
    h.removeAbort?.();
    // Cleanup uses only the original peer and one-shot session, including after a device switch.
    const session = h.session;
    if (session&&close) void h.lease.client.recipeAuthoring?.({ type: 'close', botId: h.open.botId, session }).catch(() => {});
  }
  invalidateStale() {
    for (const h of this.handles.values()) {
      try {
        this.check(h);
      } catch {
        this.revoke(h);
      }
    }
  }
  closeRenderer(){for(const h of this.handles.values())if(!h.creator)this.revoke(h);}
  closeAll() {
    for (const h of this.handles.values()) this.revoke(h);
    this.journal.history.close();
    if(this.ownsDrafts)this.drafts.close();
  }
  private localDraft(h:Handle,draftId:string,revision?:number):LocalRecipeDraftRecord{
    this.check(h);const row=this.drafts.read(h.open.accountId,draftId);
    if(!row||revision!==undefined&&row.draft.revision!==revision||row.association.viewId!==h.open.viewId||
      row.association.deviceId!==h.deviceId||row.association.deviceKey!==h.deviceKey||row.association.botId!==h.open.botId)throw recheck();
    return row;
  }
  private async localAssociation(h:Handle):Promise<CreatorAssociation>{
    this.check(h);if(!h.lease.client.recipeAuthoring)throw changed();
    const reply=expectKind(recipeAuthoringReplySchema.parse(await h.lease.client.recipeAuthoring({type:'creatorDiscover',botId:h.open.botId,accountId:h.open.accountId})),'creatorBinding');
    this.check(h);if(!reply.association)throw recheck();
    return creatorAssociationSchema.parse({...this.binding(h),binding:reply.association.binding,scope:reply.association.scope});
  }
  private async present(h: Handle, force = true) {
    this.check(h);
    if (!force && h.lastVerified !== undefined && Date.now() - h.lastVerified < 10_000) return;
    try {
      await this.cloud(h).presence();
      h.lastVerified = Date.now();
    } catch (error) {
      delete h.lastVerified;
      if (error instanceof AuthoringServiceUnavailable) throw error;
      this.revoke(h);
      throw new AuthoringError('账号连接已暂停，重新打开此 Bot 后可继续原操作。');
    }
    this.check(h);
  }
  async adoptCreator(input:{accountId:string;viewId:string;botId:Open['botId'];lease:RecipeDeviceLease;session:string;leaseMs:number}) {
    const reply=await this.openTarget({type:'open',accountId:input.accountId,viewId:input.viewId,botId:input.botId},undefined,{kind:'initial'},input);
    return {handle:reply.handle,botName:reply.target.botName,stop:()=>{const h=this.handles.get(reply.handle);if(h)this.revoke(h);}};
  }
  async creatorSettled(handle:string,draftId:string){
    const h=this.handles.get(handle);if(!h?.creator)throw changed();
    await this.enqueue(h,async()=>{
      const status=expectKind(await this.daemon(h,{type:'status'}),'status');
      if(!status.linked)throw changed();
      if(status.operations.some(op=>op.purpose==='editDraft'&&op.draftId===draftId&&!terminal(op))||
        status.reconciliation.some(op=>op.purpose==='editDraft'&&op.draftId===draftId&&!op.receipt))
        throw new AuthoringError('这份草稿的保存结果尚未确认，请稍后再查看。');
      return {kind:'closed'};
    });
  }
  async creatorBegin(handle:string,{entry,retryId,recover}:CreatorContinue,target:Omit<CreatorContinuation,'kind'|'retryId'|'delivery'>){
    const continuation=(delivery:CreatorContinuation['delivery']):CreatorContinuation=>({kind:'creatorContinuing',...target,retryId,delivery});
    const handoffDelivery=(result:Extract<RecipeAuthoringReply,{kind:'handoff'}>,restored=false)=>{
      switch(result.handoff.state){
        case 'deliveryUnknown':return continuation('deliveryUnknown');
        case 'selecting':case 'awaitingAttestations':return continuation('delivered');
        case 'prepared':
          if(!restored)throw recheck();
          return continuation('restored');
        default:throw new AuthoringError('本次私聊准备已停止或需要重新核对，请回到原来源查看。');
      }
    };
    const h=this.handles.get(handle);if(!h?.creator)throw changed();
    return this.enqueue(h,async()=>{
      await this.names(h);await this.present(h,true);
      if(entry.kind==='version'){
        const account:NativeAccount={...this.account,request:(accountId,path,init,beforeSend)=>this.account.request(accountId,path,init,async()=>{await beforeSend?.();this.check(h);})};
        const detail=await communityRequest(account,{type:'detail',accountId:h.open.accountId,recipeId:entry.recipeId,versionId:entry.versionId});this.check(h);
        if(!detail.owned||detail.recipeId!==entry.recipeId||detail.versionId!==entry.versionId||detail.creator&&detail.creator.authorId!==h.open.accountId)throw recheck();
        // Version selection does not expose an idempotent handoff to restore.
        if(recover)return continuation('unverified');
        expectKind(await this.daemon(h,{type:'creatorContinue',selection:{kind:'version',target:{recipeId:entry.recipeId,versionId:entry.versionId},name:detail.public.name,version:detail.public.version}}),'creatorAck');
        return continuation('delivered');
      }
      if(entry.kind==='source'){
        h.parent=entry.parent;
        if(entry.viewId!==h.open.viewId||entry.botId!==h.open.botId)throw recheck();
        const groupName=h.groups.get(entry.groupId);if(!groupName)throw recheck();
        const inherited=entry.parent?await inheritedPublication(this.account,h.open.accountId,entry.parent.recipeId,entry.parent.versionId,()=>this.check(h)):undefined;
        const scope={retryId,groupId:entry.groupId};
        await this.groupIdentity(h,entry.groupId);
        const origin={sourceVersionId:entry.parent?.versionId,...(inherited&&{inherited})};
        if(recover){
          const restored=await this.restoreCreatorHandoff(h,scope,recover,{kind:'source',groupId:entry.groupId,...origin});
          if(restored)return handoffDelivery(restored,true);
        }
        return handoffDelivery(await this.beginHandoff(h,scope,{type:'beginHandoff',...scope,groupName,conversation:true,...origin}));
      }
      const local=this.localDraft(h,entry.draftId,entry.revision),source=local.work.source;
      if(local.draft.format!=='rich-v2'||!source||!local.sourceCanonical||source.identity!==await this.groupIdentity(h,source.groupId))throw recheck();
      const status=expectKind(await this.daemon(h,{type:'status'}),'status');
      if(!status.linked)throw recheck();
      const scope={retryId,groupId:source.groupId,draftId:entry.draftId};
      if(recover){
        const restored=await this.restoreCreatorHandoff(h,scope,recover,{kind:'draft',groupId:source.groupId,draftId:entry.draftId,baseRevision:entry.revision});
        if(restored)return handoffDelivery(restored,true);
      }
      const existing=status.operations.filter(op=>op.purpose==='editDraft'&&op.draftId===entry.draftId&&!terminal(op));
      if(existing.length){
        const op=existing[0]!;
        if(existing.length!==1||op.format!=='rich-v2'||op.baseRevision!==entry.revision||op.deliveryUnknown||!['waiting','candidate'].includes(op.state))throw recheck();
        const resumed=await this.operation(h,{type:'resumeContext',operationId:op.operationId});
        if(resumed.operationId!==op.operationId||resumed.format!=='rich-v2'||resumed.purpose!=='editDraft'||resumed.draftId!==entry.draftId||resumed.baseRevision!==entry.revision||
          resumed.deliveryUnknown||!['waiting','candidate'].includes(resumed.state))throw recheck();
      }
      expectKind(await this.daemon(h,{type:'creatorContinue',conversationRevision:entry.revision,conversationRetryId:retryId,
        selection:{kind:'draft',work:local.work,name:local.draft.public.name,version:local.draft.public.version}}),'creatorAck');
      return continuation(existing.length?'restored':'delivered');
    });
  }
  private async openDraftSource(input: DraftSourceOpen) {
    const {accountId, viewId, draftId, baseRevision} = input;
    const signal = this.account.lease?.(accountId);
    const check = () => {
      if (signal?.aborted || signal !== this.account.lease?.(accountId)) throw changed();
    };
    if (!signal) throw changed();
    check();
    const local=this.drafts.read(accountId,draftId);
    if(!local||local.draft.format!=='rich-v2'||local.draft.revision!==baseRevision||!local.work.source)throw recheck();
    const meta={sourceIntentId:local.draft.sourceIntentId};
    check();
    const original=this.draftSource(input,meta.sourceIntentId);
    return this.open({type:'open',accountId,viewId,botId:original.botId},original.source);
  }
  private draftSource({accountId,viewId,draftId,baseRevision}:DraftSourceOpen,sourceIntentId:string) {
    const local=this.drafts.read(accountId,draftId);
    if(local?.draft.format==='rich-v2'&&local.work.source&&local.draft.revision===baseRevision&&local.draft.sourceIntentId===sourceIntentId){
      if(local.association.viewId!==viewId)throw recheck();
      return {botId:local.association.botId,source:{draftId,baseRevision,operationId:sourceIntentId,deviceId:local.association.deviceId,
        deviceKey:local.association.deviceKey,groupId:local.work.source.groupId,identity:local.work.source.identity}};
    }
    const saved = this.journal.history.locator(accountId,sourceIntentId);
    const prior = this.journal.preparation(accountId,sourceIntentId);
    const target = saved ?? prior;
    if (!target) throw new AuthoringError('这台 App 没有这份草稿的来源记录，仍可编辑发布信息。');
    if (prior && saved && (saved.deviceId !== prior.deviceId || saved.deviceKey !== prior.deviceKey ||
      saved.botId !== prior.botId || saved.groupId && prior.groupId !== saved.groupId)) throw invalidAuthoring();
    if ((viewId !== 'local' && viewId !== target.deviceId) || (prior && prior.viewId !== viewId))
      throw new AuthoringError('请先在设备菜单切换到创建这份草稿的来源设备。');
    return {botId:target.botId,source:{
      draftId, baseRevision, operationId:sourceIntentId, deviceId:target.deviceId, deviceKey:target.deviceKey,
      groupId:saved?.groupId ?? prior?.groupId, identity:saved?.identity,
    }};
  }
  private async verifyDraftSource(h: Handle, source: DraftSource) {
    if (source.deviceId !== h.deviceId || source.deviceKey !== h.deviceKey)
      throw new AuthoringError('当前连接与原来源设备不符，请在设备菜单检查原设备。');
    let {groupId,identity} = source;
    if (!groupId || !identity) {
      const status = expectKind(await this.daemon(h,{type:'status',operationId:source.operationId}),'status');
      const op = status.operations.find(op => op.operationId === source.operationId && op.format === 'rich-v2' &&
        op.purpose === 'prepareDraft' && op.receipt?.status === 'accepted' && op.receipt.draftId === source.draftId);
      if (op?.groupId) {
        if (groupId && op.groupId !== groupId) throw invalidAuthoring();
        this.journal.observe(this.binding(h),op);
        const stored = expectKind(await this.daemon(h,{type:'operationSourceIdentity',operationId:op.operationId}),'operationSourceIdentity');
        if (stored.operationId !== op.operationId || stored.groupId !== op.groupId ||
          identity && stored.identity && identity !== stored.identity) throw invalidAuthoring();
        identity ??= stored.identity ?? undefined;
        groupId = op.groupId;
      }
    }
    if (!groupId || !identity) throw new AuthoringError('原群的可核验记录已不可用，仍可编辑发布信息。');
    if (!h.groups.has(groupId) || await this.groupIdentity(h,groupId) !== identity)
      throw new AuthoringError('原 Bot 已更换或原群绑定已变化，无法在原私聊继续。');
    this.journal.history.remember(this.binding(h),source.operationId,identity,groupId);
    h.draftSource = {...source,groupId,identity};
  }
  private async open(input: Open, source?: DraftSource): Promise<DesktopAuthoringReply> {
    const target = input.viewId + '/' + input.botId;
    if (this.opening.has(target)) throw new AuthoringError('正在连接这个 Bot，请稍后继续。');
    this.opening.add(target);
    try {
      this.invalidateStale();
      for (const prior of this.handles.values()) {
        if (prior.attached || prior.intent.kind==='restore' || !prior.handoff || prior.open.accountId !== input.accountId || prior.open.viewId !== input.viewId ||
          prior.open.botId !== input.botId || prior.open.groupId !== input.groupId || prior.draftSource?.draftId !== source?.draftId ||
          prior.draftSource?.baseRevision !== source?.baseRevision) continue;
        await prior.tail;
        this.check(prior);
        await this.names(prior);
        if (source) await this.verifyDraftSource(prior,source);
        await this.present(prior,true);
        this.checkIdle(prior);
        const session = await this.refresh(prior);
        prior.attached = true;
        prior.ownership++;
        return session;
      }
      return await this.openTarget(input,source);
    } finally {
      this.opening.delete(target);
    }
  }
  private async openTarget(input: Open, source?: DraftSource, intent:Intent={kind:'initial'}, adopted?:{lease:RecipeDeviceLease;session:string;leaseMs:number}): Promise<SessionReply> {
    const signal = this.account.lease?.(input.accountId),
      actor = this.account.status();
    if (!signal || actor.kind !== 'signedIn' || actor.accountId !== input.accountId) throw changed();
    this.invalidateStale();
    for (const prior of this.handles.values())
      if (!prior.creator && prior.open.botId === input.botId && prior.open.viewId === input.viewId) this.revoke(prior,prior.session!==adopted?.session);
    if (this.handles.size >= 16) throw new AuthoringError('请先关闭其他 Bot 的草稿会话。');
    const h: Handle = {
      id: randomUUID(),
      intent,
      open: input,
      lease: adopted?.lease ?? this.capture(input.viewId),
      creator:!!adopted,
      signal,
      stop: new AbortController(),
      deviceId: '',
      deviceKey: '',
      attached:true, ownership:0, nextRefresh:0, sequence:0, pausedContexts:new Set(),
      lastActivity: Date.now(),
      retry: new Map(),
      groups: new Map(),
      operations: new Map(),
      reviewed: new Map(),
      busy: true,
      tail: Promise.resolve(),
      queued: 0,
      target: {
        accountId: actor.accountId,
        accountName: actor.displayName,
        viewId: input.viewId,
        botId: input.botId,
        botName: input.botId,
      },
    };
    this.handles.set(h.id, h);
    const abort = () => this.revoke(h);
    signal.addEventListener('abort', abort, { once: true });
    h.removeAbort = () => signal.removeEventListener('abort', abort);
    try {
      await this.present(h);
      await this.identity(h);
      if (source && (h.deviceId !== source.deviceId || h.deviceKey !== source.deviceKey))
        throw new AuthoringError('请在设备菜单连接原来源设备后重试。');
      await this.names(h);
      this.check(h);
      if (!h.lease.client.recipeAuthoring) throw new AuthoringError('所选设备尚不支持聊天草稿。');
      const session = adopted ? {kind:'session' as const,session:adopted.session,leaseMs:adopted.leaseMs,linked:true} : expectKind(
        recipeAuthoringReplySchema.parse(
          await h.lease.client.recipeAuthoring({
            type: 'open',
            botId: input.botId,
            accountId: input.accountId,
          }),
        ),
        'session',
      );
      h.session = session.session;
      if (h.stop.signal.aborted) {
        void h.lease.client
          .recipeAuthoring({ type: 'close', botId: input.botId, session: session.session })
          .catch(() => {});
        throw changed();
      }
      this.check(h);
      if (source) await this.verifyDraftSource(h,source);
      if (input.groupId) h.groupIdentity = await this.groupIdentity(h, input.groupId);
      if(adopted)await this.status(h);
      if(intent.kind==='initial')await this.workflow(h);
      const result = intent.kind==='initial'?await this.refresh(h):this.sessionView(h,session.linked,[]);
      this.check(h);
      h.timer = setInterval(() => {void this.tick(h);}, Math.max(100,Math.min(3_000,Math.floor(session.leaseMs/3))));
      h.timer.unref();
      return result;
    } catch (error) {
      this.revoke(h);
      throw error;
    } finally {
      h.busy = false;
    }
  }
  private workflow(h: Handle) {
    return h.workflow ??= this.checkWorkflow(h).finally(() => {h.workflow = undefined;});
  }
  private async checkWorkflow(h: Handle) {
    await this.present(h,false);
    const start = Date.now();
    const info = expectKind(await this.daemon(h,{type:'workflow'}),'workflow');
    if (info.activity > h.sequence) {
      h.sequence = info.activity;
      h.lastActivity = Math.max(h.lastActivity,start-info.ageMs);
      if(h.creator) h.nextRefresh = 0;
    }
    this.checkIdle(h);
    h.pausedContexts = new Set(info.pausedContexts);
    if (h.intent.kind==='restore' && !h.intent.operationId && h.handoff) {
      await this.checkGroup(h);
      const reply=this.verifyHandoff(h.handoff,expectKind(await this.daemon(h,{type:'handoffStatus',retryId:h.intent.retryId}),'handoff'));
      this.trackRestoredOperation(h,reply.handoff);
    }
    if(h.creator&&info.handoff&&!h.attesting){
      const pending=expectKind(await this.daemon(h,{type:'handoffStatus',retryId:info.handoff.retryId}),'handoff').handoff;
      if(pending.retryId!==info.handoff.retryId)throw recheck();
      if(!h.groups.has(pending.groupId))await this.names(h);
      h.handoff={retryId:pending.retryId,groupId:pending.groupId,draftId:pending.draftId};
      await this.groupIdentity(h,pending.groupId);
    }
    if (info.handoff && info.handoff.retryId === h.handoff?.retryId && !h.attesting) {
      h.attesting = this.attestHandoff(h,info.handoff).catch(() => this.invalidateStale()).finally(() => {delete h.attesting;});
    }
    const request = info.field;
    if (!request || h.intent.kind==='restore'&&h.intent.operationId!==request.operationId) return;
    const op = h.operations.get(request.operationId);
    const saved = op?.receipt?.status === 'accepted' ? op.receipt : undefined;
    let value: string | null = null;
    if (op && (saved?.draftId ?? op.draftId) === request.draftId && (saved?.revision ?? op.baseRevision) === request.revision &&
        (saved || op.purpose === 'editDraft' && ['waiting','candidate'].includes(op.state))) {
      try {
        await this.present(h,true);
        await this.checkGroup(h);
        const draft = this.localDraft(h,request.draftId,request.revision).draft;
        const text = draft.public[request.field];
        if (safeDraftModelText(text)) value = text;
      } catch (error) {
        this.check(h);
        if (error instanceof AuthoringServiceUnavailable) throw error;
      }
    }
    this.checkIdle(h);
    const pending = expectKind(await this.daemon(h,{type:'workflow'}),'workflow').field;
    if (pending?.requestId !== request.requestId || h.intent.kind==='restore'&&h.intent.operationId!==request.operationId) return;
    await this.checkGroup(h);
    this.checkIdle(h);
    expectKind(await this.daemon(h,{type:'answerField',request,value}),'fieldAnswered');
  }
  private async attestHandoff(h:Handle,request:HandoffAttestation) {
    if (h.attestationRetry?.ref === request.ref && h.attestationRetry.after > Date.now()) return;
    if (new Set(request.versions).size !== request.versions.length) throw invalidAuthoring();
    const scope=h.handoff;if(!scope||scope.retryId!==request.retryId)return;
    const sourceIdentity=h.creator?await this.groupIdentity(h,scope.groupId):undefined;
    await this.checkGroup(h);
    const cloud = this.richCloud(h);
    try {
      const attestations:Awaited<ReturnType<typeof cloud.sourceItems>>[] = [];
      let unavailable = false;
      try {
        for (const version of request.versions) {
          const source=await cloud.sourceItems(version);
          const required=request.items?.find(v=>v.versionId===version)?.itemIds;
          if(required){
            const ids=new Set(required);
            const items=source.items.filter(item=>ids.has(item.itemId));
            if(items.length!==ids.size)throw new UnavailableSourceItems('所选内容已不在原版本中。');
            attestations.push({...source,items});
          }else attestations.push(source);
        }
      } catch(error) {
        if (!(error instanceof UnavailableSourceItems)) throw error;
        unavailable = true;
      }
      const pending = expectKind(await this.daemon(h,{type:'workflow'}),'workflow').handoff;
      if (!pending || canonical(pending) !== canonical(request) || h.handoff?.retryId !== request.retryId) return;
      await this.present(h,false);
      this.checkIdle(h);
      await this.checkGroup(h);
      if(h.creator&&sourceIdentity!==await this.groupIdentity(h,scope.groupId))throw recheck();
      const reply = expectKind(await this.daemon(h,{type:'answerHandoff',request,
        attestations:unavailable?[]:attestations,...(unavailable && {unavailable:true as const})}),'handoff');
      this.verifyHandoff(scope,reply);
      this.trackRestoredOperation(h,reply.handoff);
      h.nextRefresh = 0;
      delete h.attestationRetry;
    } catch {
      this.check(h);
      h.attestationRetry = {ref:request.ref,after:Date.now()+12_000};
    }
  }
  private async tick(h: Handle) {
    if (h.workflow) return;
    try {
      await this.workflow(h);
    } catch (error) {
      if (error instanceof AuthoringServiceUnavailable) {
        try { this.check(h); this.checkIdle(h); } catch { this.revoke(h); }
      } else this.revoke(h);
      return;
    }
    if (h.busy || Date.now() < h.nextRefresh) return;
    h.nextRefresh = Date.now()+12_000;
    h.busy = true;
    h.tail = this.refresh(h).then(() => {}, () => {this.invalidateStale();}).finally(() => {h.busy = h.queued > 0;});
  }
  private binding(h: Handle) {
    this.check(h);
    return { accountId: h.open.accountId, viewId: h.open.viewId, deviceId: h.deviceId, deviceKey: h.deviceKey, botId: h.open.botId };
  }
  private async groupIdentity(h: Handle, groupId: GroupId) {
    if (!h.groups.has(groupId)) throw recheck();
    const reply = expectKind(await this.daemon(h, {type:'groupSourceIdentity', groupId}), 'groupSourceIdentity');
    if (reply.groupId !== groupId) throw invalidAuthoring();
    return reply.identity;
  }
  private async checkGroup(h: Handle) {
    const groupId = h.draftSource?.groupId ?? h.open.groupId;
    if (!groupId) return;
    if (!h.groups.has(groupId) || (h.draftSource?.identity ?? h.groupIdentity) !== await this.groupIdentity(h,groupId)) {
      this.revoke(h);
      throw recheck();
    }
  }
  private async rememberSource(h: Handle, op: AuthoringOperation) {
    if (op.purpose !== 'prepareDraft' || !op.groupId) return;
    const binding = this.binding(h);
    const existing = this.journal.history.source(binding,op.operationId);
    if (existing) {
      this.journal.history.remember(binding,op.operationId,existing,op.groupId);
      return;
    }
    const reply = expectKind(await this.daemon(h, {type:'operationSourceIdentity', operationId:op.operationId}), 'operationSourceIdentity');
    if (reply.operationId !== op.operationId || reply.groupId !== op.groupId) throw invalidAuthoring();
    if (reply.identity) this.journal.history.remember(binding, op.operationId, reply.identity,op.groupId);
    else if (!terminal(op)) throw recheck();
  }
  private visible(h: Handle, op: DesktopAuthoringOperation) {
    if(h.intent.kind==='restore')return op.operationId===h.intent.operationId;
    if (h.draftSource) return op.purpose === 'editDraft' && op.draftId === h.draftSource.draftId;
    return !h.open.groupId || op.groupId === h.open.groupId &&
      this.journal.history.source(this.binding(h), op.operationId) === h.groupIdentity;
  }
  private async settleLocalDraft(h:Handle,op:Pick<AuthoringOperation,'operationId'|'draftId'|'storage'|'receipt'>,acknowledge=true){
    if(op.storage!=='local'||!op.receipt)return;
    const draftId=op.receipt.status==='accepted'?op.receipt.draftId:op.draftId??op.operationId;
    const pending=this.drafts.pending(h.open.accountId,draftId,op.operationId);
    if(pending){
      const a=pending.record.association;
      if(a.viewId!==h.open.viewId||a.deviceId!==h.deviceId||a.deviceKey!==h.deviceKey||a.botId!==h.open.botId)throw recheck();
      if(op.receipt.status==='accepted'){
        this.drafts.finishPending({accountId:h.open.accountId,draftId,requestId:op.operationId,receipt:op.receipt});
        this.onSaved?.({accountId:h.open.accountId,draftId,revision:op.receipt.revision});
      }else this.drafts.abortPending(h.open.accountId,draftId,op.operationId);
    }
    const committed=this.drafts.receipt(h.open.accountId,draftId,op.operationId);
    if(this.journal.localAcceptance(op.operationId)&&(op.receipt.status!=='accepted'||committed))this.journal.clearLocalAcceptance(op.operationId);
    if(!acknowledge||op.receipt.status==='accepted'&&(!committed||committed.deleted||committed.revision!==op.receipt.revision))return;
    if(h.acknowledgedLocal?.has(op.operationId))return;
    try{
      const reply=expectKind(await this.daemon(h,{type:'localDraftAcknowledged',operationId:op.operationId,receipt:op.receipt}),'localDraftAcknowledged');
      if(reply.operationId!==op.operationId)throw invalidAuthoring();
      (h.acknowledgedLocal??=new Set()).add(op.operationId);
    }catch{this.check(h);}
  }
  private remember(h: Handle, op: AuthoringOperation, cancel = false) {
    const binding=this.binding(h),row = this.journal.observe(binding, op, cancel,op.purpose==='prepareDraft'?h.parent:undefined);
    if(op.storage==='local')this.journal.history.markLocal(binding,op.operationId);
    const prior = h.operations.get(op.operationId);
    h.operations.set(op.operationId, op);
    if (op.storage!=='local' && prior && prior.receipt?.status !== 'accepted' && op.state === 'completed' && op.receipt?.status === 'accepted') {
      this.onSaved?.({accountId:h.open.accountId,draftId:op.receipt.draftId,revision:op.receipt.revision});
    }
    return row;
  }
  private display(h: Handle, op: AuthoringOperation, cloudMessage?: string): DesktopAuthoringOperation {
    const { targetPublicKey: _pk, nonceCommitment: _nonce, cardUpdate, ...summary } = op;
    const cardMessage = cardUpdate === 'unavailable' ? '原私聊卡片无法再更新，请以 App 中的状态为准。'
      : cardUpdate ? '私聊卡片更新尚未确认，将在连接时重试。' : undefined;
    const syncMessage = [expiryNotice(op.receipt).syncMessage, cloudMessage, cardMessage].filter(Boolean).join(' ');
    return { ...summary, ...(h.pausedContexts.has(op.operationId) && {contextPaused:true}), ...(syncMessage && {syncMessage}), target: h.target, ...(op.groupId && { groupName: h.groups.get(op.groupId) || op.groupId }) };
  }
  private async status(h: Handle) {
    const status = expectKind(await this.daemon(h, { type: 'status',
      ...(h.intent.kind==='restore'&&{operationId:h.intent.operationId??null}),
    }), 'status');
    const id=h.intent.kind==='restore'?h.intent.operationId:undefined;
    if(h.intent.kind==='restore'&&(status.operations.some(op=>op.operationId!==id)||status.reconciliation.some(op=>op.operationId!==id)))throw invalidAuthoring();
    this.check(h);
    const current = new Set(status.operations.map(op => op.operationId));
    for (const id of h.operations.keys()) if (!current.has(id)) h.operations.delete(id);
    for (const [index,op] of status.operations.entries()) {
      this.journal.observe(this.binding(h),op,false,op.purpose==='prepareDraft'?h.parent:undefined);
      await this.settleLocalDraft(h,op,false);
      this.remember(h, op);
      if (terminal(op) && op.receipt?.status === 'accepted') await this.rememberSource(h, op);
      if (status.linked && op.cardUpdate === 'pending')
        status.operations[index] = await this.operation(h, { type: 'updateCard', operationId: op.operationId });
      await this.settleLocalDraft(h,status.operations[index]!);
    }
    return status;
  }
  private async reconcile(h: Handle, op: AuthoringReconciliation): Promise<DesktopAuthoringOperation> {
    this.journal.checkReconciliation(this.binding(h), op);
    if(op.storage==='local')this.journal.history.markLocal(this.binding(h),op.operationId);
    await this.settleLocalDraft(h,op);
    const { operationId, createdAt, purpose, draftId, baseRevision } = op;
    const summary = { operationId, createdAt, purpose, draftId, baseRevision, target:h.target, deliveryUnknown:false };
    let receipt = op.receipt;
    if(op.storage==='local'&&!receipt)return {...summary,state:'cancelPending',syncMessage:'原关联已变化，本地草稿已保留；请重新核对来源。'};
    if (!receipt) {
      const recent = h.retry.get(operationId);
      if (recent?.state !== 'revoked' || recent.until <= Date.now()) {
        try {
          const cloud = this.cloud(h);
          // A registration must match this account and device operation before even a cancellation can mutate it.
          let winner:AuthoringReceipt|undefined;
          if(op.format==='rich-v2'){
            winner=richTerminal(await this.richCloud(h).recover(operationId));
          }else{
            const state=await cloud.get(op);
            winner=state&&'operationId' in state?state:undefined;
          }
          if(!winner)throw invalidAuthoring();
          const result = expectKind(await this.daemon(h, { type:'reconcile', operationId, receipt:winner }), 'reconciled');
          if (canonical(result.receipt) !== canonical(winner)) throw invalidAuthoring();
          receipt = winner;
          h.retry.delete(operationId);
        } catch (error) {
          this.check(h);
          const delay = Math.min(120_000, Math.max(12_000, (recent?.delay ?? 0) * 2));
          h.retry.set(operationId, {state:'revoked', until:Date.now()+delay, delay,
            message:error instanceof AuthoringError ? error.message : '旧关联已停用，取消结果待同步。'});
        }
      }
    }
    if (!receipt) return { ...summary, state:'cancelPending', syncMessage:h.retry.get(operationId)?.message };
    if (receipt.operationId !== operationId || (receipt.status === 'accepted' &&
        (purpose === 'prepareDraft' ? receipt.revision !== 1 : receipt.draftId !== draftId || receipt.revision !== baseRevision! + 1)))
      throw invalidAuthoring();
    return { ...summary, receipt, ...expiryNotice(receipt), state:receipt.status === 'accepted' ? 'completed' : receipt.status };
  }
  private async refresh(h: Handle): Promise<SessionReply> {
    await this.checkGroup(h);
    const status = await this.status(h);
    const revoked = [];
    for (const op of status.reconciliation) revoked.push(await this.reconcile(h, op));
    for (const op of status.operations) {
      if (terminal(op) || !status.linked) continue;
      // Each already-confirmed chat operation progresses independently of a conflict on another draft.
      const stamp = [op.state, op.payloadDigest, op.deliveryUnknown].join('/');
      const recent = h.retry.get(op.operationId);
      if (recent?.state === stamp && recent.until > Date.now()) continue;
      try {
        await this.sync(h, op);
        const delay = ['waiting', 'candidate', 'needsReview'].includes(op.state) ? 60_000 : 12_000;
        h.retry.set(op.operationId, { state: stamp, until: Date.now() + delay, delay: 0 });
      } catch (error) {
        this.check(h);
        const message = error instanceof AuthoringError ? error.message : '同步待重试，请检查设备与账号连接。';
        const delay = Math.min(120_000, Math.max(12_000, (recent?.delay ?? 0) * 2));
        h.retry.set(op.operationId, { state: stamp, until: Date.now() + delay, delay, message });
      }
    }
    this.check(h);
    return this.sessionView(h,status.linked,[...h.operations.values()].map(op =>
      this.display(h, op, terminal(op) ? undefined : h.retry.get(op.operationId)?.message),
    ).concat(revoked).filter(op => this.visible(h,op)));
  }
  private sessionView(h:Handle,linked:boolean,operations:DesktopAuthoringOperation[]):SessionReply {
    return {
      kind:'session',handle:h.id,target:h.target,linked,operations,
      ...(h.draftSource?.groupId&&{sourceGroup:{groupId:h.draftSource.groupId,groupName:h.groups.get(h.draftSource.groupId)!}}),
    };
  }
  private async operation(h: Handle, request: ScopedRequest & { operationId: string }) {
    const { operation } = expectKind(await this.daemon(h, request), 'operation');
    if (operation.operationId !== request.operationId) throw invalidAuthoring();
    await this.settleLocalDraft(h,operation);
    this.remember(h, operation);
    return operation;
  }
  private async confirmedOperation(h: Handle, op: AuthoringOperation) {
    if(op.storage==='local')return op;
    if (!terminal(op)) return op;
    const state = await this.cloud(h).get(op);
    if (!state || !('operationId' in state)) throw invalidAuthoring();
    return this.settle(h, op, state);
  }
  private async inspect(h: Handle, op: AuthoringOperation) {
    if (!op.payloadDigest || !['candidate', 'pendingCloud'].includes(op.state)) throw recheck();
    const approval = op.state === 'pendingCloud' && op.purpose === 'editDraft';
    const result = await this.daemon(h,{type:'inspectCandidate',operationId:op.operationId,...(approval && {requireEditApproval:true})});
    if (result.kind === 'operation' && approval && result.operation.operationId === op.operationId &&
        ['candidate','waiting'].includes(result.operation.state)) {
      this.remember(h,result.operation);
      throw new AuthoringError('请在原飞书私聊查看最新候选并重新确认。');
    }
    const reply = expectKind(result,'candidate');
    if (reply.operationId !== op.operationId || reply.payloadDigest !== op.payloadDigest ||
        (approval && reply.reviewedDigest !== op.payloadDigest)) throw recheck();
    const bytes = Buffer.from(reply.payload, 'base64url');
    if (
      bytes.length > 128 * 1024 ||
      bytes.toString('base64url') !== reply.payload ||
      createHash('sha256').update(bytes).digest('hex') !== op.payloadDigest
    )
      throw invalidAuthoring();
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const content = authoringCandidateContentSchema.parse(JSON.parse(decoded));
    if (canonical(content) !== decoded) throw invalidAuthoring();
    if ('changes' in content) {
      if (
        op.purpose !== 'editDraft' ||
        content.draftId !== op.draftId ||
        content.baseRevision !== op.baseRevision ||
        !content.changes.every(change => safeEditValue(change.value)) ||
        new Set(content.changes.map((c) => (c.op === 'setPublicText' ? c.field : c.op))).size !== content.changes.length
      )
        throw invalidAuthoring();
    } else if (op.purpose !== 'prepareDraft') throw invalidAuthoring();
    return { kind: 'candidate' as const, operation: this.display(h, op), payloadDigest: op.payloadDigest, content };
  }
  private async settle(h: Handle, op: AuthoringOperation, receipt: AuthoringReceipt) {
    // A pruned cloud receipt cannot contradict an exact terminal receipt already stored by this device.
    if ('outcome' in receipt && terminal(op) && op.receipt) return op;
    if (
      op.receipt &&
      canonical(op.receipt) === canonical(receipt) &&
      op.state === (receipt.status === 'accepted' ? 'completed' : receipt.status)
    )
      return op;
    const result = await this.operation(h, { type: 'settle', operationId: op.operationId, receipt });
    if (
      !result.receipt ||
      canonical(result.receipt) !== canonical(receipt) ||
      result.state !== (receipt.status === 'accepted' ? 'completed' : receipt.status)
    )
      throw invalidAuthoring();
    return result;
  }
  private async syncRich(h:Handle,op:AuthoringOperation,action:'sync'|'resume'|'cancel'|'resend'|'accept',digest?:string){
    if(op.storage==='local')return this.syncLocal(h,op,action,digest);
    return this.pauseLegacy(h,op);
  }
  private async pauseLegacy(h:Handle,op:AuthoringOperation){
    this.check(h);
    if(terminal(op))return op;
    if(op.format==='rich-v2'){
      const receipt=richTerminal(await this.richCloud(h).recover(op.operationId));
      if(receipt)return this.settle(h,op,receipt);
    }else{
      const receipt=await this.cloud(h).get(op);
      if(receipt&&'operationId'in receipt)return this.settle(h,op,receipt);
    }
    if(terminal(op))return op;
    throw new AuthoringError('旧云草稿操作已暂停；未继续上传。已有数据会保留，请从本地草稿继续。');
  }
  private async syncLocal(h:Handle,op:AuthoringOperation,action:'sync'|'resume'|'cancel'|'resend'|'accept',digest?:string):Promise<AuthoringOperation>{
    this.check(h);const row=this.remember(h,op,action==='cancel'),draftId=op.draftId??op.operationId;
    const replay=this.journal.localAcceptance(op.operationId),pending=this.drafts.pending(h.open.accountId,draftId,op.operationId),
      receipt=this.drafts.receipt(h.open.accountId,draftId,op.operationId);
    if(op.receipt){await this.settleLocalDraft(h,op);return op;}
    if(replay&&(pending||receipt&&!receipt.deleted)&&action!=='cancel'&&!row.cancelling){
      const saved=await this.operation(h,{type:'localDraftAdvance',operationId:op.operationId,advance:replay});
      if(saved.receipt?.status!=='accepted'||saved.receipt.draftId!==draftId||saved.receipt.revision!==(pending?.record.draft.revision??receipt?.revision))throw recheck();
      return saved;
    }
    if(terminal(op))return op;
    if(row.cancelling||op.state==='cancelPending'){
      if(op.state!=='cancelPending')op=await this.operation(h,{type:'cancel',operationId:op.operationId});
      return this.operation(h,{type:'localDraftAdvance',operationId:op.operationId,advance:{kind:'cancel'}});
    }
    await this.rememberSource(h,op);
    if(op.state==='pendingMain'){
      const dispatched=await this.operation(h,{type:'localDraftAdvance',operationId:op.operationId,advance:{kind:'dispatch',draftId}});
      if(h.creator && dispatched.state==='pendingCloud') h.nextRefresh = 0;
      return dispatched;
    }
    if(action==='resend'||op.state==='sending')return this.operation(h,{type:action==='resend'?'resend':'deliver',operationId:op.operationId});
    if(action==='resume'&&h.pausedContexts.has(op.operationId))return this.operation(h,{type:'resumeContext',operationId:op.operationId});
    if(op.cardUpdate==='pending')op=await this.operation(h,{type:'updateCard',operationId:op.operationId});
    if(op.state!=='pendingCloud')return op;
    if(action==='accept'&&op.payloadDigest!==digest)throw recheck();
    const base=op.draftId?this.localDraft(h,op.draftId,op.baseRevision):undefined;
    const association=base?.association??await this.localAssociation(h),revision=(op.baseRevision??0)+1;
    let record:LocalRecipeDraftRecord,advance:Extract<RecipeAuthoringRequest,{type:'localDraftAdvance'}>['advance'];
    if(op.format==='rich-v2'){
      const transfer=expectKind(await this.daemon(h,{type:'richMembers',operationId:op.operationId}),'richMembers');
      if(transfer.reviewDigest!==op.payloadDigest)throw recheck();
      const raw=expectKind(await this.daemon(h,{type:'richInspect',operationId:op.operationId,preview:true}),'richCandidate');
      if(raw.reviewDigest!==transfer.reviewDigest)throw recheck();
      const members=[];
      for(const [index,member] of transfer.members.entries()){
        const value=expectKind(await this.daemon(h,{type:'richReadMember',operationId:op.operationId,reviewDigest:transfer.reviewDigest,index}),'richMember');
        if(value.reviewDigest!==transfer.reviewDigest||value.index!==index)throw recheck();
        members.push({...member,bytes:value.bytes});
      }
      const local=await bindLocalRichMembers(op.operationId,raw.request,members,this.normalizeLogo);this.check(h);
      if(transfer.members.length)await this.daemon(h,{type:'richBindMembers',operationId:op.operationId,reviewDigest:transfer.reviewDigest,descriptors:local.descriptors});
      const bound=expectKind(await this.daemon(h,{type:'richInspect',operationId:op.operationId}),'richCandidate');
      if(bound.reviewDigest!==transfer.reviewDigest)throw recheck();
      const frozen=freezeLocalRich(op.operationId,draftId,bound.request),source=this.journal.history.locator(h.open.accountId,op.operationId);
      const work=base?.work??(source?.groupId?{draftId,source:{preparationId:op.operationId,groupId:source.groupId,identity:source.identity}}:undefined);
      if(!work)throw recheck();
      let parent=base?.parent;
      if(!base&&'content'in bound.request&&bound.request.sourceVersionId){
        const versionId=bound.request.sourceVersionId,known=this.journal.parent(op.operationId)??h.parent,
          verified=this.journal.history.parent(this.binding(h),versionId);
        if(verified&&known?.versionId===versionId&&verified.recipeId!==known.recipeId)throw recheck();
        parent=verified??(known?.versionId===versionId?known:undefined);
      }
      record=buildLocalRichRecord({association,work,revision,request:bound.request,frozen,members:local.members,base,parent});
      advance={kind:'richAccept',draftId,reviewDigest:transfer.reviewDigest,frozen};
    }else{
      const candidate=await this.inspect(h,op),content=candidate.content;
      if(!('changes'in content))record={association,work:{draftId,source:null},draft:{draftId,recipeId:null,revision,public:content.public,config:content.config},members:[]};
      else{
        if(!base||base.draft.format==='rich-v2')throw recheck();
        const value=structuredClone(base.draft);
        for(const change of content.changes){
          if(change.op==='setPublicText')value.public[change.field]=change.value;
          else if(change.op==='setDraftRole')value.config.role=change.value;
          else if(change.value)value.config.setup=change.value;else delete value.config.setup;
        }
        record={...base,draft:{...value,revision}};
      }
      advance={kind:'roleAccept',draftId,reviewDigest:candidate.payloadDigest,revision};
    }
    this.check(h);this.journal.acceptLocal(this.binding(h),op,advance);
    try{this.drafts.stage({requestId:op.operationId,expectedRevision:op.baseRevision??null,record});}
    catch(error){if(!this.drafts.pending(h.open.accountId,draftId,op.operationId)&&!this.drafts.receipt(h.open.accountId,draftId,op.operationId))this.journal.clearLocalAcceptance(op.operationId);throw error;}
    this.check(h);
    const saved=await this.operation(h,{type:'localDraftAdvance',operationId:op.operationId,advance});
    if(saved.receipt?.status!=='accepted'||saved.receipt.draftId!==draftId||saved.receipt.revision!==revision)throw recheck();
    return saved;
  }
  private async sync(
    h: Handle,
    op: AuthoringOperation,
    action: 'sync' | 'resume' | 'cancel' | 'resend' | 'accept' = 'sync',
    digest?: string,
  ) {
    return op.storage==='local'?this.syncLocal(h,op,action,digest):this.pauseLegacy(h,op);
  }
  private async restoreCreatorHandoff(h:Handle,scope:HandoffScope,recover:NonNullable<CreatorContinue['recover']>,expected:Extract<ScopedRequest,{type:'restoreHandoff'}>['expected']){
    const reply=await this.daemon(h,{type:'restoreHandoff',retryId:scope.retryId,expected});
    if(reply.kind==='handoffUnavailable'){
      if(reply.retryId!==scope.retryId)throw invalidAuthoring();
      if(recover==='handoff')throw new AuthoringError('原发卡记录无法核验，请先在原 Bot 的私聊中查看。');
      return;
    }
    const restored=this.verifyHandoff(scope,expectKind(reply,'handoff'));
    h.handoff=scope;
    return restored;
  }
  private async beginHandoff(h:Handle,scope:HandoffScope,request:Extract<ScopedRequest,{type:'beginHandoff'|'beginDraftHandoff'}>) {
    h.handoff ??= scope;
    const result = this.verifyHandoff(scope,expectKind(await this.daemon(h,request),'handoff'));
    h.handoff = scope;
    return result;
  }
  private verifyHandoff(scope:HandoffScope,reply:Extract<RecipeAuthoringReply,{kind:'handoff'}>) {
    const handoff = reply.handoff;
    if (handoff.retryId !== scope.retryId || handoff.groupId !== scope.groupId || handoff.draftId !== scope.draftId ||
      (handoff.state === 'prepared') !== Boolean(handoff.operationId)) throw invalidAuthoring();
    return reply;
  }
  private async action(h: Handle, r: Exclude<Action, { type: 'close' | 'detach' }>): Promise<DesktopAuthoringReply> {
    await this.present(h, r.type !== 'status');
    if (h.draftSource && !['beginLink','inspectLink','confirmLink','beginDraftHandoff','handoffStatus','cancelHandoff',
      'status','cancel','resume','resend'].includes(r.type)) throw recheck();
    if (h.open.groupId && r.type !== 'status' && r.type !== 'sourceHistory') {
      if (h.groupIdentity !== await this.groupIdentity(h,h.open.groupId) || ('groupId' in r && r.groupId !== h.open.groupId)) throw recheck();
    }
    switch (r.type) {
      case 'status':
        return this.refresh(h);
      case 'beginHandoff': {
        h.parent=r.source;
        if (h.draftSource || h.open.groupId !== r.groupId) throw recheck();
        await this.names(h);
        const groupName = h.groups.get(r.groupId);
        if (!groupName) throw recheck();
        const inherited=r.source?await inheritedPublication(this.account,h.open.accountId,r.source.recipeId,r.source.versionId,()=>this.check(h)):undefined;
        await this.checkGroup(h);
        const scope = {retryId:r.retryId,groupId:r.groupId};
        return this.beginHandoff(h,scope,{type:r.type,...scope,groupName,sourceVersionId:r.source?.versionId,...(inherited&&{inherited})});
      }
      case 'beginDraftHandoff': {
        const source = h.draftSource;
        if (!source?.groupId || !source.identity || source.draftId !== r.draftId || source.baseRevision !== r.baseRevision) throw recheck();
        await this.names(h);
        const groupName = h.groups.get(source.groupId);
        if (!groupName) throw recheck();
        await this.checkGroup(h);
        const local=this.localDraft(h,r.draftId,r.baseRevision);
        if(local.draft.format!=='rich-v2'||local.draft.sourceIntentId!==source.operationId||!local.sourceCanonical)throw recheck();
        const canonical=local.draft.rich.canonical,sourceBytes=Buffer.from(local.sourceCanonical,'base64url');
        await this.checkGroup(h);
        const scope = {retryId:r.retryId,groupId:source.groupId,draftId:r.draftId};
        return this.beginHandoff(h,scope,{type:r.type,...scope,groupName,identity:source.identity,baseRevision:r.baseRevision,canonical,
          source:{sourceIntentId:source.operationId,canonical:sourceBytes.toString('base64url')}});
      }
      case 'handoffStatus':
      case 'cancelHandoff': {
        const groupId = h.draftSource?.groupId ?? h.open.groupId;
        if (!groupId) throw recheck();
        await this.checkGroup(h);
        const scope = {retryId:r.retryId,groupId,draftId:h.draftSource?.draftId};
        if (r.type === 'cancelHandoff' && h.handoff?.retryId !== r.retryId)
          this.verifyHandoff(scope,expectKind(await this.daemon(h,{type:'handoffStatus',retryId:r.retryId}),'handoff'));
        const reply=this.verifyHandoff(scope,expectKind(await this.daemon(h,{type:r.type,retryId:r.retryId}),'handoff'));
        this.trackRestoredOperation(h,reply.handoff);
        return reply;
      }
      case 'sourceHistory': {
        if (r.groupId !== h.open.groupId || !h.groupIdentity) throw recheck();
        const current = await this.groupIdentity(h,r.groupId);
        if (current !== h.groupIdentity) throw recheck();
        const {ids,nextCursor} = this.journal.history.page(this.binding(h), current, r.cursor);
        const local=new Map(this.drafts.list(h.open.accountId).filter(record=>record.work.source).map(record=>[record.work.source!.preparationId,record]));
        const legacy=ids.filter(id=>!this.journal.history.isLocal(this.binding(h),id));
        const remote=new Map((await this.cloud(h).sourceHistory(legacy)).map(entry=>[entry.operationId,entry]));
        const entries:SourceHistoryEntry[]=ids.map(operationId=>{
          const published=this.journal.history.publication(this.binding(h),operationId);
          if(published)return published;
          const record=local.get(operationId);
          if(record){this.localDraft(h,record.draft.draftId);return {state:'draft',operationId,draftId:record.draft.draftId,recipeId:record.draft.recipeId,
            name:record.draft.public.name,version:record.draft.public.version,revision:record.draft.revision,versionId:null};}
          return remote.get(operationId)??{state:'unknown',operationId,draftId:null,recipeId:null,versionId:null};
        });
        if (current !== await this.groupIdentity(h,r.groupId)) throw recheck();
        return {kind:'sourceHistory', entries, nextCursor};
      }
      case 'beginLink': {
        const challenge = expectKind(await this.daemon(h, { type: r.type }), 'challenge');
        h.challenge = { id: challenge.challengeId };
        return challenge;
      }
      case 'inspectLink':
      case 'confirmLink': {
        if (
          !h.challenge ||
          h.challenge.id !== r.challengeId ||
          (r.type === 'confirmLink' && h.challenge.evidence !== r.evidence)
        )
          throw recheck();
        const req =
          r.type === 'inspectLink'
            ? { type: r.type, challengeId: r.challengeId }
            : { type: r.type, challengeId: r.challengeId, evidence: r.evidence };
        const link = expectKind(await this.daemon(h, req), 'link');
        if (r.type === 'inspectLink') h.challenge.evidence = link.evidence;
        return link;
      }
      case 'reviewSource': {
        h.source = undefined;
        await this.names(h);
        const groupName = h.groups.get(r.groupId);
        if (!groupName) throw new AuthoringError('所选 Bot 尚未连接这个群。');
        const source = expectKind(await this.daemon(h, { type: r.type, groupId: r.groupId }), 'source');
        if (source.groupId !== r.groupId) throw recheck();
        h.source = { groupId: r.groupId, reviewToken: source.reviewToken };
        return { ...source, target: h.target, groupName };
      }
      case 'richInspectCandidate': {
        await this.status(h);
        const op=h.operations.get(r.operationId);
        if(!op||op.format!=='rich-v2'||!this.visible(h,this.display(h,op)))throw recheck();
        const preview=expectKind(await this.daemon(h,{type:'richInspect',operationId:r.operationId,preview:true}),'richCandidate');
        if(preview.operationId!==op.operationId||preview.reviewDigest!==op.payloadDigest)throw recheck();
        return {kind:'richCandidate',operation:this.display(h,op),reviewDigest:preview.reviewDigest,request:preview.request};
      }
      case 'richSourceOptions': {
        if(!h.groups.has(r.groupId))throw recheck();
        return expectKind(await this.daemon(h,{type:r.type,groupId:r.groupId}),'richSourceOptions');
      }
      case 'richInventory': {
        if(!h.groups.has(r.groupId))throw recheck();
        return expectKind(await this.daemon(h,{type:r.type,groupId:r.groupId,options:r.options}),'richInventory');
      }
      case 'richPrepare':
      case 'richEdit': {
        const cloud=this.richCloud(h);
        let req:ScopedRequest;
        if(r.type==='richPrepare'){
          if(!h.groups.has(r.groupId))throw recheck();
          const inv=expectKind(await this.daemon(h,{type:'richInventory',groupId:r.groupId,options:r.selection.options}),'richInventory').inventory;
          if(inv.reviewToken!==r.selection.reviewToken)throw recheck();
          // Inventory covers the whole group. The daemon verifies every selected item's
          // parent, so an unavailable, unselected version need not prevent preparation.
          const sources=await Promise.all(inv.versions.map(async version=>{
            try {return await cloud.sourceItems(version);}
            catch(error){if(error instanceof UnavailableSourceItems)return undefined;throw error;}
          }));
          const attestations=sources.filter(source=>source!==undefined);
          req={type:r.type,groupId:r.groupId,selection:r.selection,attestations};
        }else{
          if(h.open.groupId)throw recheck();
          const local=this.localDraft(h,r.draftId,r.baseRevision);
          if(local.draft.format!=='rich-v2'||!local.sourceCanonical)throw recheck();
          const canonical=local.draft.rich.canonical;
          const source=r.changes?.some(c=>c.op==='includeCandidate')?{sourceIntentId:local.draft.sourceIntentId,canonical:local.sourceCanonical}:undefined;
          req={type:r.type,draftId:r.draftId,baseRevision:r.baseRevision,canonical,selected:r.selected,changes:r.changes,logo:r.logo,access:r.access,source};
        }
        const op=expectKind(await this.daemon(h,req),'operation').operation;
        if(op.format!=='rich-v2'||(r.type==='richPrepare'?op.groupId!==r.groupId:op.draftId!==r.draftId||op.baseRevision!==r.baseRevision))throw recheck();
        return {kind:'operation',operation:this.display(h,await this.syncRich(h,op,'sync'))};
      }
      case 'prepare':
      case 'edit': {
        if (r.type === 'edit' && h.open.groupId) throw recheck();
        if (r.type === 'prepare' && (h.source?.groupId !== r.groupId || h.source.reviewToken !== r.reviewToken))
          throw recheck();
        if (r.type === 'edit')this.localDraft(h,r.draftId,r.baseRevision);
        const req =
          r.type === 'prepare'
            ? {
                type: r.type,
                groupId: r.groupId,
                reviewToken: r.reviewToken,
                sourceAttested: r.sourceAttested,
                setup: r.setup,
              }
            : { type: r.type, draftId: r.draftId, baseRevision: r.baseRevision };
        const { operation: op } = expectKind(await this.daemon(h, req), 'operation');
        if (
          r.type === 'prepare'
            ? op.purpose !== 'prepareDraft' || op.groupId !== r.groupId
            : op.purpose !== 'editDraft' || op.draftId !== r.draftId || op.baseRevision !== r.baseRevision
        )
          throw recheck();
        this.remember(h, op);
        const updated = this.display(h, await this.sync(h, op));
        if (!this.visible(h,updated)) throw recheck();
        return { kind:'operation', operation:updated };
      }
      default: {
        await this.status(h);
        const op = h.operations.get(r.operationId);
        if (!op || !this.visible(h,this.display(h,op))) throw recheck();
        if (r.type === 'inspectCandidate') {
          const candidate = await this.inspect(h, op);
          h.reviewed.set(op.operationId, candidate.payloadDigest);
          return candidate;
        }
        if (r.type === 'accept' && h.reviewed.get(op.operationId) !== r.payloadDigest) throw recheck();
        return {
          kind: 'operation',
          operation: this.display(h, await this.sync(h, op, r.type, r.type === 'accept' ? r.payloadDigest : undefined)),
        };
      }
    }
  }
  private trackRestoredOperation(h:Handle,handoff:Extract<RecipeAuthoringReply,{kind:'handoff'}>['handoff']){
    if(h.intent.kind!=='restore')return;
    if(handoff.retryId!==h.intent.retryId||h.intent.operationId&&handoff.operationId!==h.intent.operationId)throw recheck();
    if(handoff.operationId)h.intent.operationId=handoff.operationId;
  }
  private checkRestoreAction(h:Handle,r:Action){
    if(h.intent.kind!=='restore')return;
    if(!['status','beginLink','inspectLink','confirmLink','handoffStatus','cancelHandoff','cancel','resume','resend'].includes(r.type)||
      'retryId' in r&&r.retryId!==h.intent.retryId||'operationId' in r&&r.operationId!==h.intent.operationId)throw recheck();
  }
  private async restoreHandoff(r:Restore):Promise<DesktopAuthoringReply> {
    const actor=this.account.status();
    if(actor.kind!=='signedIn'||actor.accountId!==r.accountId||!this.account.lease?.(r.accountId))throw changed();
    this.invalidateStale();
    const previous=r.handle?this.handles.get(r.handle):undefined;
    if(previous){
      if(previous.open.accountId!==r.accountId||previous.open.viewId!==r.viewId||
        (r.target.kind==='source'?(previous.open.botId!==r.target.botId||previous.open.groupId!==r.target.groupId||!!previous.draftSource):
          previous.draftSource?.draftId!==r.target.draftId||previous.draftSource.baseRevision!==r.target.baseRevision)||
        previous.handoff&&previous.handoff.retryId!==r.retryId||previous.intent.kind==='restore'&&previous.intent.retryId!==r.retryId)throw recheck();
      return this.enqueue(previous,()=>this.restoreExisting(previous,r));
    }
    const owners=new Map([...this.handles.values()].map(h=>[h.id,h.ownership]));
    let source:DraftSource|undefined;
    let open:Open;
    if(r.target.kind==='draft'){
      const signal=this.account.lease?.(r.accountId);
      if(!signal)throw changed();
      const check=()=>{if(signal.aborted||signal!==this.account.lease?.(r.accountId))throw changed();};
      const local=this.drafts.read(r.accountId,r.target.draftId);
      if(!local||local.draft.format!=='rich-v2'||local.draft.revision!==r.target.baseRevision)throw recheck();
      const locator={sourceIntentId:local.draft.sourceIntentId};
      const original=this.draftSource({type:'openDraftSource',accountId:r.accountId,viewId:r.viewId,...r.target},locator.sourceIntentId);
      source=original.source;
      open={type:'open',accountId:r.accountId,viewId:r.viewId,botId:original.botId};
    }else open={type:'open',accountId:r.accountId,viewId:r.viewId,botId:r.target.botId,groupId:r.target.groupId};
    if([...this.handles.values()].some(h=>h.open.viewId===open.viewId&&h.open.botId===open.botId&&owners.get(h.id)!==h.ownership))throw changed();
    const key=open.viewId+'/'+open.botId;
    if(this.opening.has(key))throw new AuthoringError('正在连接这个 Bot，请稍后继续。');
    this.opening.add(key);
    let h:Handle|undefined;
    try {
      const session=await this.openTarget(open,source,{kind:'restore',retryId:r.retryId});
      const opened=this.handles.get(session.handle);
      if(!opened)throw changed();
      h=opened;
      const result=await this.enqueue(opened,()=>this.restoreExisting(opened,r));
      if(result.kind==='handoffUnavailable')this.revoke(h);
      return result;
    }catch(error){if(h)this.revoke(h);throw error;}
    finally {this.opening.delete(key);}
  }
  private async restoreExisting(h:Handle,r:Restore):Promise<DesktopAuthoringReply>{
    await this.present(h,true);
    const operationId=h.intent.kind==='restore'?h.intent.operationId:undefined;
    h.intent={kind:'restore',retryId:r.retryId,operationId};
    await this.identity(h);
    await this.names(h);
    await this.checkGroup(h);
    const status=expectKind(await this.daemon(h,{type:'status',operationId:null}),'status');
    if(status.operations.length||status.reconciliation.length)throw invalidAuthoring();
    if(!status.linked){
      delete h.handoff;
      return {kind:'handoffLinkRequired',session:this.sessionView(h,false,[])};
    }
    const target=r.target;
    if(target.kind==='source')h.parent=target.parent;
    const groupId=target.kind==='source'?target.groupId:h.draftSource?.groupId;
    if(!groupId)throw recheck();
    const expected:Extract<ScopedRequest,{type:'restoreHandoff'}>['expected']=target.kind==='draft'
      ?{kind:'draft',groupId,draftId:target.draftId,baseRevision:target.baseRevision}
      :{kind:'source',groupId,sourceVersionId:target.parent?.versionId,
        ...(target.parent&&{inherited:await inheritedPublication(this.account,r.accountId,target.parent.recipeId,target.parent.versionId,()=>this.check(h))})};
    const reply=await this.daemon(h,{type:'restoreHandoff',retryId:r.retryId,expected});
    if(reply.kind==='handoffUnavailable'){
      if(reply.retryId!==r.retryId)throw invalidAuthoring();
      h.intent={kind:'restore',retryId:r.retryId};
      delete h.handoff;
      h.operations.clear();
      return reply;
    }
    const scope={retryId:r.retryId,groupId,...(target.kind==='draft'&&{draftId:target.draftId})};
    const restored=this.verifyHandoff(scope,expectKind(reply,'handoff')).handoff;
    h.handoff=scope;
    this.trackRestoredOperation(h,restored);
    if(restored.operationId)h.retry.delete(restored.operationId);
    const session=await this.refresh(h);
    if(restored.operationId){
      const op=session.operations.find(op=>op.operationId===restored.operationId);
      if(!op){
        const current=await this.daemon(h,{type:'restoreHandoff',retryId:r.retryId,expected});
        if(current.kind!=='handoffUnavailable'||current.retryId!==r.retryId)throw invalidAuthoring();
        h.intent={kind:'restore',retryId:r.retryId};
        delete h.handoff;
        h.operations.clear();
        return current;
      }
      if(op.format!=='rich-v2'||op.purpose!==(target.kind==='draft'?'editDraft':'prepareDraft')||
        (target.kind==='draft'?(op.draftId!==target.draftId||op.baseRevision!==target.baseRevision):op.groupId!==target.groupId)||
        op.receipt?.status==='accepted'&&(op.receipt.operationId!==op.operationId||
          (target.kind==='draft'?(op.receipt.draftId!==target.draftId||op.receipt.revision!==target.baseRevision+1):op.receipt.revision!==1)))throw invalidAuthoring();
    }
    return {kind:'handoffRestored',session,handoff:restored};
  }
  private async enqueue(h:Handle,action:()=>Promise<DesktopAuthoringReply>){
    this.check(h);
    if(h.queued>=8)throw new AuthoringError('正在核对上一次操作，请稍后继续。');
    h.queued++;h.busy=true;
    const run=h.tail.then(async()=>{
      this.check(h);
      if(!h.attached)throw changed();
      const reply=await action();
      this.check(h);
      return desktopAuthoringReplySchema.parse(reply);
    });
    h.tail=run.then(()=>{},()=>{});
    try{return await run;}
    finally {h.queued--;h.busy=h.queued>0;}
  }
  async request(raw: DesktopAuthoringRequest) {
    const r = desktopAuthoringRequestSchema.parse(raw);
    if(r.type==='resourceHandoff'||r.type==='creatorContinue'||r.type==='preparePublication'||r.type==='confirmPublication'||r.type==='recoverPublication')throw recheck();
    if (r.type === 'restoreHandoff') return desktopAuthoringReplySchema.parse(await this.restoreHandoff(r));
    if (r.type === 'openDraftSource') return desktopAuthoringReplySchema.parse(await this.openDraftSource(r));
    if (r.type === 'open') return desktopAuthoringReplySchema.parse(await this.open(r));
    const h = this.handles.get(r.handle);
    if (!h) throw changed();
    if (r.type === 'detach') {
      h.attached = false;
      if (!h.queued && !h.operations.size && !h.handoff) this.revoke(h);
      return {kind:'closed' as const};
    }
    if (!h.attached) throw changed();
    if (r.type === 'close') {
      this.revoke(h);
      return { kind: 'closed' as const };
    }
    return this.enqueue(h,async()=>{
      this.checkRestoreAction(h,r);
      await this.workflow(h);
      if(!h.attached)throw changed();
      return this.action(h,r);
    });
  }
}
