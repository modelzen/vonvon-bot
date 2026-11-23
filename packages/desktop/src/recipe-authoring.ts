import {inheritedPublication} from './recipe-publication-inheritance.js';
import {uploadRichMembers} from './recipe-authoring-upload.js';
import {richAuthoringCloud,richTerminal,UnavailableSourceItems} from './recipe-authoring-rich-cloud.js';
import {safeDraftModelText, safeEditValue} from '../../../services/recipe-api/src/draft-model-text.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  authoringCandidateContentSchema,
  desktopAuthoringReplySchema,
  desktopAuthoringRequestSchema,
  deviceReplySchema,
  recipeBinary32Schema,
  recipeAuthoringReplySchema,
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
import { authoringCloud, AuthoringError, invalidAuthoring, dispatchDigest } from './recipe-authoring-cloud.js';
import { AuthoringJournal } from './recipe-authoring-journal.js';

type Open = Extract<DesktopAuthoringRequest, { type: 'open' }>;
type DraftSourceOpen = Extract<DesktopAuthoringRequest, {type:'openDraftSource'}>;
type DraftSource = Pick<DraftSourceOpen, 'draftId' | 'baseRevision'> & {
  operationId:string; deviceId:string; deviceKey:string; groupId?:GroupId; identity?:string;
};
type HandoffScope = {retryId:string;groupId:GroupId;draftId?:string};
type Handle = {
  id: string;
  open: Open;
  lease: RecipeDeviceLease;
  signal: AbortSignal;
  stop: AbortController;
  transfer?:{operationId:string;cancel:AbortController};
  deviceId: string;
  deviceKey: string;
  session?: string;
  tail: Promise<void>;
  queued: number;
  attached: boolean;
  workflow?: Promise<void>;
  nextRefresh: number;
  sequence: number;
  pausedContexts: Set<string>;
  lastActivity: number;
  lastVerified: number;
  retry: Map<string, { state: string; until: number; delay: number; message?: string }>;
  target: DesktopAuthoringOperation['target'];
  groups: Map<GroupId, string>;
  operations: Map<string, AuthoringOperation>;
  groupIdentity?: string;
  draftSource?: DraftSource;
  handoff?: HandoffScope;
  attesting?: Promise<void>;
  attestationRetry?: {ref:string;after:number};
  source?: { groupId: GroupId; reviewToken: string };
  challenge?: { id: string; evidence?: string };
  reviewed: Map<string, string>;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
  removeAbort?: () => void;
};
type Action = Exclude<DesktopAuthoringRequest, Open | DraftSourceOpen>;
type SessionRequest = Exclude<RecipeAuthoringRequest, { type: 'open' }>;
type ScopedRequest<T = SessionRequest> = T extends SessionRequest ? Omit<T, 'session' | 'botId'> : never;
const changed = () => new AuthoringError('账号或设备连接已改变，请重新打开原来的配方操作。');
const recheck = () => new AuthoringError('本次选择已改变，请重新核对来源或草稿。');
const terminal = (op: AuthoringOperation) => ['completed', 'cancelled', 'expired'].includes(op.state);
function expiryNotice(receipt?: AuthoringReceipt) {
  return receipt && 'outcome' in receipt ? {syncMessage:'这次操作已到期，无法确认之前是否保存。若已保存，请到创作中心查看。'} : {};
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
  private handles = new Map<string, Handle>();
  private opening = new Set<string>();
  private accountTransfer = new Map<string,Promise<void>>();
  constructor(
    private readonly account: NativeAccount,
    private readonly capture: (viewId: string) => RecipeDeviceLease,
    private readonly journal: AuthoringJournal,
    private readonly onSaved?: (receipt: AuthoringSaved) => void,
  ) {}
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
    )
      throw changed();
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
  private revoke(h: Handle) {
    if (h.stop.signal.aborted) return;
    this.handles.delete(h.id);
    h.stop.abort();
    clearInterval(h.timer);
    h.removeAbort?.();
    // Cleanup uses only the original peer and one-shot session, including after a device switch.
    const session = h.session;
    if (session) void h.lease.client.recipeAuthoring?.({ type: 'close', botId: h.open.botId, session }).catch(() => {});
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
  closeAll() {
    for (const h of this.handles.values()) this.revoke(h);
    this.journal.history.close();
  }
  private async present(h: Handle, force = true) {
    this.check(h);
    if (!force && Date.now() - h.lastVerified < 10_000) return;
    try {
      await this.cloud(h).presence();
      h.lastVerified = Date.now();
    } catch {
      this.revoke(h);
      throw new AuthoringError('账号连接已暂停，重新打开此 Bot 后可继续原操作。');
    }
    this.check(h);
  }
  private async openDraftSource(input: DraftSourceOpen) {
    const {accountId, viewId, draftId, baseRevision} = input;
    const signal = this.account.lease?.(accountId);
    const check = () => {
      if (signal?.aborted || signal !== this.account.lease?.(accountId)) throw changed();
    };
    if (!signal) throw changed();
    check();
    const meta = await richAuthoringCloud(this.account,accountId,signal,check).draftMetadata(draftId,baseRevision)
      .catch(() => {check();throw new AuthoringError('无法核验当前账号的这份草稿，请刷新草稿后重试。');});
    check();
    const saved = this.journal.history.locator(accountId,meta.sourceIntentId);
    const prior = this.journal.preparation(accountId,meta.sourceIntentId);
    const target = saved ?? prior;
    if (!target) throw new AuthoringError('这台 App 没有这份草稿的来源记录，仍可编辑发布信息。');
    if (prior && saved && (saved.deviceId !== prior.deviceId || saved.deviceKey !== prior.deviceKey ||
      saved.botId !== prior.botId || saved.groupId && prior.groupId !== saved.groupId)) throw invalidAuthoring();
    if ((viewId !== 'local' && viewId !== target.deviceId) || (prior && prior.viewId !== viewId))
      throw new AuthoringError('请先在设备菜单切换到创建这份草稿的来源设备。');
    return this.open({type:'open',accountId,viewId,botId:target.botId}, {
      draftId, baseRevision, operationId:meta.sourceIntentId, deviceId:target.deviceId, deviceKey:target.deviceKey,
      groupId:saved?.groupId ?? prior?.groupId, identity:saved?.identity,
    });
  }
  private async verifyDraftSource(h: Handle, source: DraftSource) {
    if (source.deviceId !== h.deviceId || source.deviceKey !== h.deviceKey)
      throw new AuthoringError('当前连接与原来源设备不符，请在设备菜单检查原设备。');
    let {groupId,identity} = source;
    if (!groupId || !identity) {
      const status = expectKind(await this.daemon(h,{type:'status'}),'status');
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
        if (prior.attached || !prior.handoff || prior.open.accountId !== input.accountId || prior.open.viewId !== input.viewId ||
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
        return session;
      }
      return await this.openTarget(input,source);
    } finally {
      this.opening.delete(target);
    }
  }
  private async openTarget(input: Open, source?: DraftSource): Promise<DesktopAuthoringReply> {
    const signal = this.account.lease?.(input.accountId),
      actor = this.account.status();
    if (!signal || actor.kind !== 'signedIn' || actor.accountId !== input.accountId) throw changed();
    this.invalidateStale();
    for (const prior of this.handles.values())
      if (prior.open.botId === input.botId && prior.open.viewId === input.viewId) this.revoke(prior);
    if (this.handles.size >= 16) throw new AuthoringError('请先关闭其他 Bot 的草稿会话。');
    const h: Handle = {
      id: randomUUID(),
      open: input,
      lease: this.capture(input.viewId),
      signal,
      stop: new AbortController(),
      deviceId: '',
      deviceKey: '',
      attached:true, nextRefresh:0, sequence:0, pausedContexts:new Set(),
      lastActivity: Date.now(),
      lastVerified: 0,
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
      const session = expectKind(
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
      await this.workflow(h);
      const result = await this.refresh(h);
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
    }
    this.checkIdle(h);
    h.pausedContexts = new Set(info.pausedContexts);
    if (info.handoff && info.handoff.retryId === h.handoff?.retryId && !h.attesting) {
      h.attesting = this.attestHandoff(h,info.handoff).catch(() => this.invalidateStale()).finally(() => {delete h.attesting;});
    }
    const request = info.field;
    if (!request) return;
    const op = h.operations.get(request.operationId);
    const saved = op?.receipt?.status === 'accepted' ? op.receipt : undefined;
    let value: string | null = null;
    if (op && (saved?.draftId ?? op.draftId) === request.draftId && (saved?.revision ?? op.baseRevision) === request.revision &&
        (saved || op.purpose === 'editDraft' && ['waiting','candidate'].includes(op.state))) {
      try {
        await this.present(h,true);
        await this.checkGroup(h);
        const cloud = this.cloud(h);
        const registration = await cloud.get(op);
        if (saved ? !registration || canonical(registration) !== canonical(saved) : registration?.status !== 'dispatched') throw recheck();
        const draft = await cloud.draft(request.draftId,request.revision);
        const text = draft.public[request.field];
        if (safeDraftModelText(text)) value = text;
      } catch { this.check(h); }
    }
    this.checkIdle(h);
    const pending = expectKind(await this.daemon(h,{type:'workflow'}),'workflow').field;
    if (pending?.requestId !== request.requestId) return;
    await this.checkGroup(h);
    this.checkIdle(h);
    expectKind(await this.daemon(h,{type:'answerField',request,value}),'fieldAnswered');
  }
  private async attestHandoff(h:Handle,request:HandoffAttestation) {
    if (h.attestationRetry?.ref === request.ref && h.attestationRetry.after > Date.now()) return;
    if (new Set(request.versions).size !== request.versions.length) throw invalidAuthoring();
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
      this.checkIdle(h);
      await this.checkGroup(h);
      const reply = expectKind(await this.daemon(h,{type:'answerHandoff',request,
        attestations:unavailable?[]:attestations,...(unavailable && {unavailable:true as const})}),'handoff');
      this.verifyHandoff(h.handoff,reply);
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
    } catch {
      this.revoke(h);
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
    try {
      if ((h.draftSource?.identity ?? h.groupIdentity) !== await this.groupIdentity(h,groupId)) throw recheck();
    } catch (error) { this.revoke(h); throw error; }
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
    if (h.draftSource) return op.purpose === 'editDraft' && op.draftId === h.draftSource.draftId;
    return !h.open.groupId || op.groupId === h.open.groupId &&
      this.journal.history.source(this.binding(h), op.operationId) === h.groupIdentity;
  }
  private remember(h: Handle, op: AuthoringOperation, cancel = false) {
    const row = this.journal.observe(this.binding(h), op, cancel);
    const prior = h.operations.get(op.operationId);
    h.operations.set(op.operationId, op);
    if (prior && prior.receipt?.status !== 'accepted' && op.state === 'completed' && op.receipt?.status === 'accepted') {
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
    const status = expectKind(await this.daemon(h, { type: 'status' }), 'status');
    this.check(h);
    const current = new Set(status.operations.map(op => op.operationId));
    for (const id of h.operations.keys()) if (!current.has(id)) h.operations.delete(id);
    for (const [index,op] of status.operations.entries()) {
      this.remember(h, op);
      if (terminal(op) && op.receipt?.status === 'accepted') await this.rememberSource(h, op);
      if (status.linked && op.cardUpdate === 'pending')
        status.operations[index] = await this.operation(h, { type: 'updateCard', operationId: op.operationId });
    }
    return status;
  }
  private async reconcile(h: Handle, op: AuthoringReconciliation): Promise<DesktopAuthoringOperation> {
    this.journal.checkReconciliation(this.binding(h), op);
    const { operationId, createdAt, purpose, draftId, baseRevision } = op;
    const summary = { operationId, createdAt, purpose, draftId, baseRevision, target:h.target, deliveryUnknown:false };
    let receipt = op.receipt;
    if (!receipt) {
      const recent = h.retry.get(operationId);
      if (recent?.state !== 'revoked' || recent.until <= Date.now()) {
        try {
          const cloud = this.cloud(h);
          // A registration must match this account and device operation before even a cancellation can mutate it.
          let winner:AuthoringReceipt|undefined;
          if(op.format==='rich-v2'){
            winner=richTerminal(await this.richCloud(h).cancel(operationId));
          }else{
            const state=await cloud.get(op);
            winner=state&&'operationId' in state?state:await cloud.cancel(op);
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
  private async refresh(h: Handle): Promise<DesktopAuthoringReply> {
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
    return {
      kind: 'session',
      handle: h.id,
      target: h.target,
      linked: status.linked,
      ...(h.draftSource?.groupId && {sourceGroup:{groupId:h.draftSource.groupId,groupName:h.groups.get(h.draftSource.groupId)!}}),
      operations: [...h.operations.values()].map(op =>
        this.display(h, op, terminal(op) ? undefined : h.retry.get(op.operationId)?.message),
      ).concat(revoked).filter(op => this.visible(h,op)),
    };
  }
  private async operation(h: Handle, request: ScopedRequest & { operationId: string }) {
    const { operation } = expectKind(await this.daemon(h, request), 'operation');
    if (operation.operationId !== request.operationId) throw invalidAuthoring();
    this.remember(h, operation);
    return operation;
  }
  private async confirmedOperation(h: Handle, op: AuthoringOperation) {
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
    const cloud=this.richCloud(h),id=op.operationId;
    if(action==='accept'&&(op.state!=='pendingCloud'||op.payloadDigest!==digest))throw recheck();
    const row=this.remember(h,op,action==='cancel');
    if(row.cancelling||op.state==='cancelPending'){
      if(op.state!=='cancelPending'&&!terminal(op))await this.operation(h,{type:'cancel',operationId:id});
      const winner=richTerminal(await cloud.cancel(id));
      if(!winner)throw invalidAuthoring();
      await cloud.cancelPackage(id).catch(()=>{});
      return this.settle(h,op,winner);
    }
    if(terminal(op))return op;
    await this.rememberSource(h,op);
    const recovered=await cloud.recover(id);
    const winner=richTerminal(recovered);
    if(winner)return this.settle(h,op,winner);
    const destinationDraftId=await cloud.register(op);
    if(op.state==='pendingMain'){
      const already=z.object({status:z.literal('dispatched'),format:z.literal('rich-v2'),operationId:z.literal(id),accountId:z.literal(h.open.accountId)}).safeParse(recovered);
      if(already.success)return this.operation(h,{type:'deliver',operationId:id});
      const authorization=await cloud.authorize(id,'dispatch',dispatchDigest);
      return this.operation(h,{type:'richAdvance',operationId:id,destinationDraftId,authorization});
    }
    if(action==='resend'||op.state==='sending')return this.operation(h,{type:action==='resend'?'resend':'deliver',operationId:id});
    if(action==='resume'&&h.pausedContexts.has(id))return this.operation(h,{type:'resumeContext',operationId:id});
    if(op.cardUpdate==='pending')op=await this.operation(h,{type:'updateCard',operationId:id});
    if(op.state!=='pendingCloud')return op;
    const cancel=new AbortController(),signal=AbortSignal.any([h.signal,h.stop.signal,cancel.signal]);
    const accountId=h.open.accountId,prior=this.accountTransfer.get(accountId);
    h.transfer={operationId:id,cancel};
    const run=(async()=>{
      await prior;
      signal.throwIfAborted();
      return this.transferRich(h,op,destinationDraftId,signal);
    })();
    const settled=run.then(()=>{},()=>{});
    this.accountTransfer.set(accountId,settled);
    try{return await run;}finally{
      if(this.accountTransfer.get(accountId)===settled)this.accountTransfer.delete(accountId);
      delete h.transfer;
    }
  }
  private async transferRich(h:Handle,op:AuthoringOperation,destinationDraftId:string,signal:AbortSignal){
    const cloud=richAuthoringCloud(this.account,h.open.accountId,signal,()=>this.check(h)),id=op.operationId;
    const read=async()=>expectKind(await this.daemon(h,{type:'richInspect',operationId:id}),'richCandidate');
    const transfer=expectKind(await this.daemon(h,{type:'richMembers',operationId:id}),'richMembers');
    if(transfer.operationId!==id||transfer.reviewDigest!==op.payloadDigest)throw recheck();
    if(transfer.members.length){
      await cloud.reserve(id,destinationDraftId,transfer.cap);
      const descriptors=await uploadRichMembers(transfer.members,signal,async(index,ordinal,m,signal)=>{
        const raw=expectKind(await this.daemon(h,{type:'richReadMember',operationId:id,reviewDigest:transfer.reviewDigest,index}),'richMember');
        if(raw.operationId!==id||raw.index!==index||raw.reviewDigest!==transfer.reviewDigest)throw recheck();
        const bytes=Buffer.from(raw.bytes,'base64url');
        if(createHash('sha256').update(bytes).digest('hex')!==m.sha256)throw recheck();
        signal.throwIfAborted();
        const part=await cloud.upload(id,ordinal,m.kind,bytes,signal);
        if(part.kind==='manifest')throw recheck();
        return part;
      });
      await this.daemon(h,{type:'richBindMembers',operationId:id,reviewDigest:transfer.reviewDigest,descriptors});
    }
    const approved=await read();
    if(approved.operationId!==id||approved.reviewDigest!==op.payloadDigest)throw recheck();
    const frozen=await cloud.freeze(id,approved.request);
    if(frozen.destinationDraftId!==destinationDraftId||frozen.sourceReviewSha256!==createHash('sha256').update(canonical(approved.request)).digest('hex'))throw recheck();
    const bytes=Buffer.from(frozen.canonical,'base64url');
    if(createHash('sha256').update(bytes).digest('hex')!==frozen.contentSha256)throw invalidAuthoring();
    if(!transfer.members.length)await cloud.reserve(id,destinationDraftId,2*bytes.length);
    const member=await cloud.upload(id,65,'manifest',bytes,signal);
    const binding=await cloud.authorize(id,'accept',frozen.payloadDigest);
    if((await read()).reviewDigest!==approved.reviewDigest)throw recheck();
    signal.throwIfAborted();
    return this.operation(h,{type:'richAdvance',operationId:id,destinationDraftId,authorization:binding,accepted:{frozen,manifestId:member.objectId,packageId:id}});
  }
  private async sync(
    h: Handle,
    op: AuthoringOperation,
    action: 'sync' | 'resume' | 'cancel' | 'resend' | 'accept' = 'sync',
    digest?: string,
  ) {
    if(op.format==='rich-v2')return this.syncRich(h,op,action,digest);
    const row = this.remember(h, op, action === 'cancel');
    const operationId = op.operationId,
      cloud = this.cloud(h);
    if (row.cancelling || op.state === 'cancelPending') {
      if (!terminal(op) && op.state !== 'cancelPending') await this.operation(h, { type: 'cancel', operationId });
      return this.settle(h, op, await cloud.cancel(op));
    }
    let state = await cloud.get(op);
    this.check(h);
    if (!state || !('operationId' in state)) await this.rememberSource(h,op);
    if (!state && op.state === 'pendingMain') state = await cloud.register(op);
    this.check(h);
    if (!state) throw invalidAuthoring();
    if ('operationId' in state) return this.settle(h, op, state);
    if (terminal(op)) throw invalidAuthoring();
    if (action === 'accept' && (op.state !== 'pendingCloud' || digest !== op.payloadDigest)) throw recheck();
    if (state.status === 'registered') {
      if (op.state !== 'pendingMain' && op.state !== 'sending') throw invalidAuthoring();
      const authorization = await cloud.authorize(op, 'dispatch', dispatchDigest);
      op = await this.operation(h, { type: 'advance', operationId, authorization });
      if (terminal(op)) return this.confirmedOperation(h, op);
    }
    if (op.state === 'pendingMain' || op.state === 'sending' || action === 'resend') {
      return this.operation(h, { type: action === 'resend' ? 'resend' : 'deliver', operationId });
    }
    if (action === 'resume' && h.pausedContexts.has(operationId) && ['waiting','candidate'].includes(op.state)) {
      if (op.draftId && op.baseRevision) await cloud.draft(op.draftId,op.baseRevision);
      const resumed = await this.operation(h,{type:'resumeContext',operationId});
      h.pausedContexts.delete(operationId);
      return resumed;
    }
    if (op.state !== 'pendingCloud') return op;
    const candidate = await this.inspect(h, op);
    this.check(h);
    const authorization = await cloud.authorize(op, 'accept', candidate.payloadDigest);
    // Reject an intervening candidate change before transferring a stage ticket to the original peer.
    await this.inspect(h, op);
    this.check(h);
    return this.confirmedOperation(h, await this.operation(h, { type: 'advance', operationId, authorization }));
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
        const cloud = this.richCloud(h);
        const {canonical,meta} = await cloud.draft(r.draftId,r.baseRevision);
        if (meta.sourceIntentId !== source.operationId) throw recheck();
        const sourceBytes = await cloud.readMember(r.draftId,meta.sourceManifest);
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
        return this.verifyHandoff(scope,expectKind(await this.daemon(h,{type:r.type,retryId:r.retryId}),'handoff'));
      }
      case 'sourceHistory': {
        if (r.groupId !== h.open.groupId || !h.groupIdentity) throw recheck();
        const current = await this.groupIdentity(h,r.groupId);
        if (current !== h.groupIdentity) throw recheck();
        const {ids,nextCursor} = this.journal.history.page(this.binding(h), current, r.cursor);
        const entries = await this.cloud(h).sourceHistory(ids);
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
          const attestations=await Promise.all(inv.versions.map(v=>cloud.sourceItems(v)));
          req={type:r.type,groupId:r.groupId,selection:r.selection,attestations};
        }else{
          if(h.open.groupId)throw recheck();
          const {canonical,meta}=await cloud.draft(r.draftId,r.baseRevision);
          const source=r.changes?.some(c=>c.op==='includeCandidate')?{sourceIntentId:meta.sourceIntentId,
            canonical:(await cloud.readMember(r.draftId,meta.sourceManifest)).toString('base64url')}:undefined;
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
        if (r.type === 'edit') await this.cloud(h).draft(r.draftId, r.baseRevision);
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
  async request(raw: DesktopAuthoringRequest) {
    const r = desktopAuthoringRequestSchema.parse(raw);
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
    this.check(h);
    if (h.queued >= 8) throw new AuthoringError('正在核对上一次操作，请稍后继续。');
    if(r.type==='cancel'&&h.transfer?.operationId===r.operationId)h.transfer.cancel.abort();
    h.queued++;
    h.busy = true;
    const run = h.tail.then(async () => {
      this.check(h);
      if (!h.attached) throw changed();
      await this.workflow(h);
      if (!h.attached) throw changed();
      const reply = await this.action(h, r);
      this.check(h);
      return desktopAuthoringReplySchema.parse(reply);
    });
    h.tail = run.then(
      () => {},
      () => {},
    );
    try {
      return await run;
    } finally {
      h.queued--;
      h.busy = h.queued > 0;
    }
  }
}
