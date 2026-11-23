import {richUseCloud} from './recipe-use-rich-cloud.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { type VonvonClient, RpcError } from '@vonvon/client/browser';
import {
  desktopRecipeReviewSchema,
  deviceReplySchema,
  groupIdSchema,
  recipeBinary32Schema,
  recipeInstallReplySchema,
  recipeUseReplySchema,
  recipeUseRequestSchema,
  type GroupId,
  type RecipeInstallReply,
  type RecipeUseReply,
  type RecipeUseRequest,
  type DesktopRecipeReview,
  desktopRecipeSourceRequestSchema,
  type DesktopRecipeSourceRequest,
  type DesktopRecipeSourceReply,
} from '@vonvon/protocol';
import type { NativeAccount } from './account-session.js';
import { RecipeJournal, type RecipeJournalRow } from './recipe-use-journal.js';
import { changed, recipeCloud, RecipeUseError, Unredeemable, type InstallPreview } from './recipe-use-cloud.js';

export interface RecipeDeviceLease {
  client: VonvonClient;
  viewId: string;
  pairedKey?: string;
  check(): void;
}
type Begin = Extract<RecipeUseRequest, { type: 'begin' }>;
type Handle = {
  id: string;
  input: Begin;
  lease: RecipeDeviceLease;
  signal: AbortSignal;
  deviceId: string;
  pk: string;
  preview?: InstallPreview;
  richPreview?: Awaited<ReturnType<ReturnType<typeof richUseCloud>['preview']>>;
  richReview?: Extract<RecipeUseReply,{kind:'richReview'|'richPrepared'}>;
  review?: DesktopRecipeReview;
  row?: RecipeJournalRow;
  touched: number;
  busy: boolean;
};
type Operation = Extract<RecipeJournalRow, { stage: 'operation' }>;
const invalid = () => new RecipeUseError('目标设备的安装回执无效。请重新打开配方。');
class JoinRefused extends RecipeUseError {
  constructor() {
    super('设备未接受此次建群或连接，请检查 Bot 和群设置。');
  }
}
const retry = () => new RecipeUseError('安装尚未确认，请重新打开配方核对原操作。');

export class RecipeUseController {
  private handles = new Map<string, Handle>();
  private starting = false;
  constructor(
    private readonly account: NativeAccount,
    private readonly capture: (viewId: string) => RecipeDeviceLease,
    private readonly journal: RecipeJournal,
  ) {}
  private check(h: Handle) {
    h.lease.check();
    if (h.signal.aborted || this.account.lease?.(h.input.accountId) !== h.signal) throw changed();
  }
  private cloud(h: Handle) {
    return recipeCloud(this.account, { accountId: h.input.accountId, signal: h.signal, check: () => this.check(h) });
  }
  private verifyIdentity(lease: RecipeDeviceLease, device: { id: string; publicKey: string }) {
    const pk = recipeBinary32Schema.parse(device.publicKey),
      id = z.string().uuid().parse(device.id);
    if (lease.viewId !== 'local' && (lease.pairedKey !== pk || lease.viewId !== id)) throw changed();
    return { pk, id };
  }
  private async identity(h: Handle) {
    this.check(h);
    const res = deviceReplySchema.parse(await h.lease.client.device({ type: 'status' }));
    this.check(h);
    if (res.kind !== 'deviceStatus') throw invalid();
    const { pk, id } = this.verifyIdentity(h.lease, res.status.device);
    if (h.pk && (h.pk !== pk || h.deviceId !== id)) throw changed();
    h.pk = pk;
    h.deviceId = id;
  }
  private async daemon(h: Handle, request: Parameters<NonNullable<VonvonClient['recipeInstall']>>[0]) {
    this.check(h);
    if (!h.lease.client.recipeInstall) throw new RecipeUseError('此设备尚不支持配方安装。');
    const reply = recipeInstallReplySchema.parse(await h.lease.client.recipeInstall(request));
    this.check(h);
    return reply;
  }
  private richCloud(h: Handle) {return richUseCloud(this.account,{accountId:h.input.accountId,signal:h.signal,check:()=>this.check(h)});}
  private base(h: Handle) {
    return {
      id: h.row?.id ?? h.id,
      accountId: h.input.accountId,
      ...(h.input.format && {format:h.input.format}),
      deviceId: h.deviceId,
      viewId: h.input.viewId,
      pk: h.pk,
      botId: h.input.botId,
      recipeId: h.input.recipeId,
      versionId: h.input.versionId,
      createdAt: h.row?.createdAt ?? Date.now(),
      fromJoin: h.row?.fromJoin ?? !h.input.groupId,
    };
  }
  private save(h: Handle, row: RecipeJournalRow) {
    this.journal.save(row);
    h.row = row;
  }
  private pending(h: Handle, phase: 'joining' | 'installing' | 'cancelling'): RecipeUseReply {
    const row = h.row;
    if (phase === 'joining' && row?.stage === 'joining') {
      const name = row.intent && ('name' in row.intent ? row.intent.name : row.intent.projectName);
      return {
        kind: 'pending',
        handle: h.id,
        phase,
        recovery: {
          state: row.createdUnsaved ? 'createdUnsaved' : 'unknown',
          groupId: row.bindId,
          name,
        },
      };
    }
    return { kind: 'pending', handle: h.id, phase, ...(row && 'groupId' in row && { groupId: row.groupId }) };
  }
  private done(h: Handle, groupId: GroupId, outcome: 'applied' | 'rejected', reason?: string): RecipeUseReply {
    this.save(h, { ...this.base(h), groupId, stage: 'done', outcome });
    return outcome === 'applied'
      ? { handle: h.id, kind: 'applied', groupId }
      : { handle: h.id, kind: 'rejected', groupId, reason };
  }
  private async prepare(
    h: Handle,
    groupId: GroupId,
    selection?: Extract<RecipeUseRequest, { type: 'resolve' }>,
  ): Promise<RecipeUseReply> {
    if (h.input.format === 'rich-v2') return this.prepareRich(h,groupId);
    if (!h.preview) {
      h.preview = await this.cloud(h).preview(h.input.recipeId, h.input.versionId);
      this.check(h);
    }
    await this.identity(h);
    this.check(h);
    const reply = await this.daemon(h, {
      type: 'prepare',
      botId: h.input.botId,
      accountId: h.input.accountId,
      groupId,
      manifest: h.preview.manifest,
      manifestSha256: h.preview.manifestSha256,
      ...(selection && { resolution: selection.resolution, reviewToken: selection.reviewToken }),
    });
    this.check(h);
    if (
      reply.kind === 'alreadyInstalled' &&
      reply.groupId === groupId &&
      reply.recipeId === h.input.recipeId &&
      reply.versionId === h.input.versionId
    )
      return this.done(h, groupId, 'applied');
    if ((reply.kind !== 'prepared' && reply.kind !== 'review') || reply.groupId !== groupId) throw invalid();
    if (
      reply.incomingRole !== h.preview.content.role ||
      reply.incomingSetup !== undefined && !isDeepStrictEqual(reply.incomingSetup, h.preview.content.setup)
    )
      throw invalid();
    const {
      reviewToken,
      currentRole,
      incomingRole,
      baseRole,
      currentSetup,
      incomingSetup,
      baseSetup,
      roleChoiceRequired,
      setupChoiceRequired,
    } = reply;
    const review = desktopRecipeReviewSchema.parse({
      reviewToken,
      currentRole,
      incomingRole,
      baseRole,
      currentSetup,
      incomingSetup,
      baseSetup,
      roleChoiceRequired,
      setupChoiceRequired,
    });
    if (
      reply.kind === 'prepared' &&
      (reply.targetPublicKey !== h.pk ||
        reply.versionId !== h.input.versionId ||
        reply.manifestSha256 !== h.preview.manifestSha256)
    )
      throw invalid();
    if (
      h.row?.stage === 'operation' &&
      h.row.action === 'reviewed' &&
      (reply.kind === 'review' || h.row.operation.id !== reply.operationId)
    ) {
      const previous = h.row;
      const released = this.status(
        h,
        previous,
        await this.daemon(h, { type: 'cancel', botId: h.input.botId, operationId: previous.operation.id }),
      );
      this.check(h);
      if (released.status !== 'rejected') {
        this.save(h, { ...previous, action: 'confirm' });
        return this.pending(h, 'installing');
      }
    }
    if (reply.kind === 'prepared') {
      this.save(h, {
        ...this.base(h),
        stage: 'operation',
        groupId,
        action: 'reviewed',
        operation: { id: reply.operationId, sha: reply.manifestSha256, commitment: reply.nonceCommitment },
      });
    }
    if (reply.kind === 'review' && h.row?.stage === 'operation')
      this.save(h, { ...this.base(h), stage: 'group', groupId });
    h.review = review;
    return { kind: reply.kind, handle: h.id, groupId, review };
  }
  private async prepareRich(h:Handle,groupId:GroupId,selection?:Extract<RecipeUseRequest,{type:'richResolve'}>):Promise<RecipeUseReply> {
    h.richPreview ??= await this.richCloud(h).preview(h.input.recipeId,h.input.versionId);
    await this.identity(h);
    const reply=await this.daemon(h,{type:'richPrepare',botId:h.input.botId,groupId,...h.richPreview,...(selection?{reviewToken:selection.reviewToken,choices:selection.choices}:{})});
    if(reply.kind==='alreadyInstalled'&&reply.groupId===groupId&&reply.recipeId===h.input.recipeId&&reply.versionId===h.input.versionId)return this.done(h,groupId,'applied');
    if(reply.kind==='richReview'){
      if(reply.groupId!==groupId)throw invalid();
      const previous=h.row;
      if(previous?.stage==='operation'){
        const status=await this.daemon(h,{type:'richStatus',botId:h.input.botId,operationId:previous.operation.id});
        if(status.kind!=='richStatus'||status.operationId!==previous.operation.id)throw invalid();
        if(status.issuerState!=='unissued')return this.pending(h,'installing');
        const cancelled=await this.daemon(h,{type:'richCancel',botId:h.input.botId,operationId:previous.operation.id});
        if(cancelled.kind!=='richStatus'||cancelled.status!=='rejected'||!cancelled.settled)throw changed();
        this.save(h,{...this.base(h),stage:'group',groupId});
      }
      h.richReview={...reply,handle:h.id}; return h.richReview;
    }
    if(reply.kind!=='richPrepared'||reply.intent.versionId!==h.input.versionId||reply.intent.targetPublicKey!==h.pk||reply.intent.manifestSha256!==h.richPreview.preview.release.contentSha256)throw invalid();
    this.save(h,{...this.base(h),stage:'operation',groupId,action:'reviewed',operation:{id:reply.operationId,sha:reply.intent.manifestSha256,commitment:reply.intent.nonceCommitment},richIntent:reply.intent});
    h.richReview={kind:'richPrepared',handle:h.id,groupId,reviewToken:reply.reviewToken};return h.richReview;
  }
  private async settleRich(h:Handle,row:Operation,cancel:boolean):Promise<RecipeUseReply> {
    await this.identity(h);
    const target={botId:h.input.botId,operationId:row.operation.id};
    const status=async(type:'richStatus'|'richIssuing'|'richReconcile'|'richCancel')=>{const value=await this.daemon(h,{type,...target});if(value.kind!=='richStatus'||value.operationId!==row.operation.id)throw invalid();return value;};
    let current=await status('richStatus');
    if(cancel){
      if(current.issuerState==='unissued')current=await status('richCancel');
      else {await this.richCloud(h).cancel(row);current=await status('richReconcile');}
    }
    if(current.status==='applied'||current.status==='rejected')return current.settled?this.done(h,row.groupId,current.status,current.reason):this.pending(h,'installing');
    if(cancel)return this.pending(h,'cancelling');
    let authorization;
    if(current.status==='prepared'&&current.issuerState!=='authorized'){
      current=await status('richIssuing');
      if(current.status!=='prepared'||current.issuerState!=='issuing')throw invalid();
      try{authorization=await this.richCloud(h).authorize(row);}catch(error){if(error instanceof Unredeemable){const reconciled=await status('richReconcile');return reconciled.status==='rejected'?this.done(h,row.groupId,'rejected',reconciled.reason):this.pending(h,'installing');}throw error;}
    }
    const applied=await this.daemon(h,{type:'richCommit',...target,...(authorization?{authorization}:{})});
    if(applied.kind!=='richStatus'||applied.operationId!==row.operation.id)throw invalid();
    return (applied.status==='applied'||applied.status==='rejected')&&applied.settled?this.done(h,row.groupId,applied.status,applied.reason):this.pending(h,'installing');
  }
  private async begin(input: Begin): Promise<RecipeUseReply> {
    if (this.starting) throw retry();
    this.starting = true;
    try {
      const signal = this.account.lease?.(input.accountId);
      if (!signal) throw changed();
      const lease = this.capture(input.viewId);
      const h: Handle = {
        id: randomUUID(),
        input,
        lease,
        signal,
        deviceId: '',
        pk: '',
        touched: Date.now(),
        busy: false,
      };
      await this.identity(h);
      this.check(h);
      for (const [id, prior] of this.handles) {
        if (prior.busy) continue;
        let stale = Date.now() - prior.touched > 15 * 60_000;
        try {
          this.check(prior);
        } catch {
          stale = true;
        }
        if (stale) this.handles.delete(id);
      }
      let row = this.journal
        .all()
        .find(
          (r) =>
            r.accountId === input.accountId &&
            r.pk === h.pk &&
            r.deviceId === h.deviceId &&
            r.botId === input.botId &&
            r.recipeId === input.recipeId &&
            r.versionId === input.versionId &&
            (input.groupId ? 'groupId' in r && r.groupId === input.groupId : r.fromJoin),
        );
      for (const [id, prior] of this.handles)
        if (
          (row && prior.row?.id === row.id) ||
          (!row &&
            !prior.row &&
            prior.pk === h.pk &&
            prior.input.botId === input.botId &&
            prior.input.accountId === input.accountId &&
            prior.input.versionId === input.versionId &&
            prior.input.groupId === input.groupId)
        ) {
          if (prior.busy) throw retry();
          this.handles.delete(id);
        }
      if (this.handles.size >= 32) throw new RecipeUseError('请先完成或关闭其他配方安装。');
      h.row = row;
      if (row?.stage === 'done') {
        if(row.outcome==='applied'){
          const current=await this.daemon(h,{type:'source',botId:input.botId,groupId:row.groupId});
          if(current.kind!=='source'||current.groupId!==row.groupId)throw invalid();
          if(current.source?.recipeId!==input.recipeId||current.source.versionId!==input.versionId){this.journal.remove(row.id);h.row=undefined;row=undefined;}
        }
        if(row?.stage==='done'){this.handles.set(h.id,h);return {kind:row.outcome,handle:h.id,groupId:row.groupId};}
      }
      if (row?.stage === 'joining' || (row?.stage === 'operation' && row.action !== 'reviewed')) {
        this.handles.set(h.id, h);
        return this.pending(
          h,
          row.stage === 'joining' ? 'joining' : row.action === 'cancel' ? 'cancelling' : 'installing',
        );
      }
      if(input.format==='rich-v2') h.richPreview=await this.richCloud(h).preview(input.recipeId,input.versionId);
      else h.preview = await this.cloud(h).preview(input.recipeId, input.versionId);
      this.check(h);
      const groupId = input.groupId ?? (row && 'groupId' in row ? row.groupId : undefined);
      if (groupId && !row) this.save(h, { ...this.base(h), stage: 'group', groupId });
      const reply = groupId ? await this.prepare(h, groupId) : { kind: 'choose' as const, handle: h.id };
      this.check(h);
      this.handles.set(h.id, h);
      return reply;
    } finally {
      this.starting = false;
    }
  }
  private async createdGroup(h: Handle, row: Extract<RecipeJournalRow, { stage: 'joining' }>) {
    const reply = await this.daemon(h, { type: 'createdGroup', botId: row.botId, requestId: row.id });
    this.check(h);
    if (reply.kind !== 'createdGroup') throw invalid();
    return reply.groupId;
  }
  private async bound(h: Handle, groupId: GroupId) {
    this.check(h);
    const snapshot = await h.lease.client.snapshot();
    this.check(h);
    return snapshot.memberships.some((m) => m.agentId === h.input.botId && m.groupId === groupId);
  }
  private async reconcileJoin(h: Handle): Promise<RecipeUseReply> {
    const row = h.row;
    if (row?.stage !== 'joining') throw invalid();
    await this.identity(h);
    this.check(h);
    let groupId = row.bindId ?? null;
    if (!groupId) groupId = await this.createdGroup(h, row);
    else if (!(await this.bound(h, groupId))) groupId = null;
    this.check(h);
    if (!groupId) return this.pending(h, 'joining');
    this.save(h, { ...this.base(h), stage: 'group', groupId });
    return this.prepare(h, groupId);
  }
  private async repairJoin(
    h: Handle,
    input: Extract<RecipeUseRequest, { type: 'repairJoin' }>['input'],
  ): Promise<RecipeUseReply> {
    const row = h.row;
    if (row?.stage !== 'joining' || input.agentId !== row.botId || (row.bindId && row.bindId !== input.groupId))
      throw changed();
    await this.identity(h);
    this.check(h);
    h.preview = await this.cloud(h).preview(h.input.recipeId, h.input.versionId);
    this.check(h);
    if (!row.bindId) {
      const found = await this.createdGroup(h, row);
      this.check(h);
      if (found && found !== input.groupId) {
        this.save(h, { ...row, bindId: found });
        return this.pending(h, 'joining');
      }
    }
    const bound = await this.bound(h, input.groupId);
    this.check(h);
    if (!bound && input.type === 'existingBinding') throw new RecipeUseError('此群的绑定已改变，请重新选择。');
    if (!bound && input.type === 'bindGroup') {
      await this.identity(h);
      this.check(h);
      this.save(h, { ...row, bindId: input.groupId });
      let reply;
      try {
        reply = await h.lease.client.run(input);
      } catch {
        this.check(h);
        return this.pending(h, 'joining');
      }
      if (reply.kind === 'refused') {
        this.check(h);
        throw new JoinRefused();
      }
      if (reply.kind !== 'applied') {
        this.check(h);
        return this.pending(h, 'joining');
      }
    }
    this.save(h, { ...this.base(h), stage: 'group', groupId: input.groupId });
    this.check(h);
    return this.prepare(h, input.groupId);
  }
  private async join(h: Handle, input: Extract<RecipeUseRequest, { type: 'join' }>['input']): Promise<RecipeUseReply> {
    if (h.row || h.input.groupId || input.agentId !== h.input.botId || (!h.preview&&!h.richPreview)) throw invalid();
    await this.identity(h);
    this.check(h);
    const row = {
      ...this.base(h),
      stage: 'joining' as const,
      intent: input,
      ...('type' in input && { bindId: input.groupId }),
    };
    this.save(h, row);
    let groupId: GroupId;
    try {
      if ('action' in input) {
        const reply = await h.lease.client.collaboration({ ...input, requestId: row.id });
        if (reply.kind === 'refused') throw new JoinRefused();
        if (reply.kind !== 'applied' || !reply.project?.chatId) throw retry();
        groupId = groupIdSchema.parse(reply.project.chatId);
      } else {
        const reply = await h.lease.client.run(input);
        if (reply.kind === 'refused') throw new JoinRefused();
        if (reply.kind !== 'applied') throw retry();
        groupId = input.groupId;
      }
    } catch (error) {
      if ('action' in input && error instanceof RpcError && error.code === 'created_unsaved') {
        const id = groupIdSchema.safeParse(error.details?.groupId);
        this.save(h, { ...row, createdUnsaved: true, ...(id.success && { bindId: id.data }) });
      }
      this.check(h);
      if (
        error instanceof JoinRefused ||
        ('action' in input && error instanceof RpcError && error.details?.creationRefused === true) ||
        (error instanceof RpcError &&
          [
            'invalid_params',
            'permission_denied',
            'invalid_input',
            'invalid_request',
            'unsupported',
            'invalid_argument',
            'draining',
          ].includes(error.code))
      ) {
        this.journal.remove(row.id);
        h.row = undefined;
        throw error;
      }
      return this.pending(h, 'joining');
    }
    this.save(h, { ...this.base(h), stage: 'group', groupId });
    this.check(h);
    return this.prepare(h, groupId);
  }
  private status(h: Handle, row: Operation, reply: RecipeInstallReply) {
    if (reply.kind !== 'status' || reply.operationId !== row.operation.id || reply.groupId !== row.groupId)
      throw invalid();
    return reply;
  }
  private async settle(h: Handle, row: Operation, cancel: boolean): Promise<RecipeUseReply> {
    if(row.format==='rich-v2')return this.settleRich(h,row,cancel);
    await this.identity(h);
    this.check(h);
    const target = { operationId: row.operation.id, botId: h.input.botId };
    let status = this.status(h, row, await this.daemon(h, { type: 'status', ...target }));
    this.check(h);
    const reconcile = async () => {
      const receipt = this.status(h, row, await this.daemon(h, { type: 'reconcile', ...target }));
      this.check(h);
      return receipt.status === 'rejected'
        ? this.done(h, row.groupId, 'rejected', '授权已取消或过期。')
        : this.pending(h, 'cancelling');
    };
    if (cancel) {
      const decision = await this.cloud(h).cancel(row);
      this.check(h);
      if (decision === 'in_progress') {
        this.save(h, { ...row, action: 'confirm' });
        return this.pending(h, 'installing');
      }
      if (decision === 'cancelled' || decision === 'expired') {
        if (status.stillNeedsTicket && status.issuerState === 'issuing') return reconcile();
        status = this.status(h, row, await this.daemon(h, { type: 'cancel', ...target }));
        this.check(h);
        if (status.status === 'rejected' && status.issuerState !== 'authorized')
          return this.done(h, row.groupId, 'rejected', '已取消或过期');
        if (status.stillNeedsTicket) return reconcile();
      }
    }
    let authorization;
    if (status.stillNeedsTicket && !cancel) {
      status = this.status(h, row, await this.daemon(h, { type: 'issuing', ...target }));
      this.check(h);
      if (status.stillNeedsTicket && status.issuerState === 'issuing') {
        try {
          authorization = await this.cloud(h).authorize(row);
        } catch (error) {
          this.check(h);
          if (error instanceof Unredeemable) return reconcile();
          throw error;
        }
      } else if (status.stillNeedsTicket) throw invalid();
    }
    this.check(h);
    await this.identity(h);
    this.check(h);
    const applied = this.status(
      h,
      row,
      await this.daemon(h, { type: 'commit', ...target, ...(authorization && { authorization }) }),
    );
    this.check(h);
    if (applied.status === 'applied' || applied.status === 'rejected')
      return this.done(h, row.groupId, applied.status, applied.reason);
    return this.pending(h, 'installing');
  }
  async source(raw: DesktopRecipeSourceRequest): Promise<DesktopRecipeSourceReply> {
    const request = desktopRecipeSourceRequestSchema.parse(raw);
    const lease = this.capture(request.viewId),
      { botId, groupId } = request;
    const accountId = 'accountId' in request ? request.accountId : undefined;
    const signal = accountId && this.account.lease?.(accountId);
    const check = () => {
      lease.check();
      if (accountId && (!signal || signal.aborted || this.account.lease?.(accountId) !== signal)) throw changed();
    };
    check();
    if (!lease.client.recipeInstall) throw retry();
    const identity = async () => {
      check();
      const status = deviceReplySchema.parse(await lease.client.device({ type: 'status' }));
      check();
      if (status.kind !== 'deviceStatus') throw invalid();
      return this.verifyIdentity(lease, status.status.device);
    };
    const device = await identity();
    check();
    const install = lease.client.recipeInstall.bind(lease.client);
    const localSource = async () => {
      check();
      const read = recipeInstallReplySchema.parse(await install({ type: 'source', botId, groupId }));
      check();
      if (read.kind !== 'source' || read.groupId !== groupId) throw invalid();
      return read.source;
    };
    const staleSource = () => new RecipeUseError('安装来源已改变，请重新检查更新。');
    const shown = await localSource();
    check();
    if (request.type === 'ignore' && shown?.sourceToken !== request.sourceToken) throw staleSource();
    if(request.type==='setup'){
      if(shown?.format!=='rich-v2'||shown.sourceToken!==request.sourceToken)throw staleSource();
      const reply=recipeInstallReplySchema.parse(await install({type:'richSetup',botId,groupId,action:request.action}));check();
      const now=await identity();if(now.id!==device.id||now.pk!==device.pk)throw changed();
      if(reply.kind!=='richSetup'||reply.groupId!==groupId)throw invalid();
      return {source:shown,setup:reply};
    }
    if (request.type === 'read' || !shown || !accountId || !signal) return { source: shown };
    const latest = await recipeCloud(this.account, { accountId, signal, check }).latest(shown.recipeId);
    check();
    const now = await identity();
    check();
    if (now.pk !== device.pk || now.id !== device.id) throw changed();
    if (request.type === 'ignore') {
      if (
        latest.versionId !== request.versionId ||
        latest.revision <= shown.revision ||
        request.installedVersionId !== shown.versionId
      )
        throw staleSource();
      const applied = recipeInstallReplySchema.parse(
        await lease.client.recipeInstall({
          type: 'ignoreVersion',
          botId,
          groupId,
          recipeId: shown.recipeId,
          sourceToken: request.sourceToken,
          installedVersionId: request.installedVersionId,
          versionId: latest.versionId,
        }),
      );
      check();
      if (
        applied.kind !== 'source' ||
        applied.groupId !== groupId ||
        applied.source?.ignoredVersionId !== latest.versionId
      )
        throw invalid();
      return { source: applied.source };
    }
    const current = await localSource();
    check();
    if (current?.sourceToken !== shown.sourceToken) throw staleSource();
    return {
      source: current,
      ...(latest.revision > current.revision && latest.versionId !== current.ignoredVersionId && { latest }),
    };
  }
  async request(raw: RecipeUseRequest): Promise<RecipeUseReply> {
    const r = recipeUseRequestSchema.parse(raw);
    if (r.type === 'begin') return recipeUseReplySchema.parse(await this.begin(r));
    const h = this.handles.get(r.handle);
    if (!h || h.busy || Date.now() - h.touched > 15 * 60_000) throw changed();
    this.check(h);
    h.touched = Date.now();
    h.busy = true;
    try {
      let reply: RecipeUseReply;
      const row = h.row;
      switch (r.type) {
        case 'retry':
          if (row?.stage !== 'done' || row.outcome !== 'rejected') throw changed();
          this.save(h, { ...this.base(h), stage: 'group', groupId: row.groupId });
          h.preview = undefined;
          reply = await this.prepare(h, row.groupId);
          break;
        case 'finish':
          if (row && row.stage !== 'done') throw retry();
          if (row) this.journal.remove(row.id);
          this.handles.delete(h.id);
          reply = { kind: 'closed' };
          break;
        case 'join':
          reply = await this.join(h, r.input);
          break;
        case 'repairJoin':
          reply = await this.repairJoin(h, r.input);
          break;
        case 'dismissJoin':
          if (row?.stage !== 'joining') throw changed();
          this.journal.remove(row.id);
          this.handles.delete(h.id);
          reply = { kind: 'closed' };
          break;
        case 'richResolve':
          if(row?.stage!=='group'||!h.richReview||r.reviewToken!==h.richReview.reviewToken)throw changed();
          reply=await this.prepareRich(h,row.groupId,r);
          break;
        case 'resolve':
          if (row?.stage !== 'group' || !h.review || r.reviewToken !== h.review.reviewToken) throw changed();
          reply = await this.prepare(h, row.groupId, r);
          break;
        case 'cancel':
          if (!row || row.stage === 'group') {
            if (row && !row.fromJoin) this.journal.remove(row.id);
            this.handles.delete(h.id);
            reply = { kind: 'closed' };
            break;
          }
          if (row.stage === 'joining') {
            reply = this.pending(h, 'joining');
            break;
          }
          if (row.stage === 'done') {
            reply = { kind: row.outcome, handle: h.id, groupId: row.groupId };
            break;
          }
          this.save(h, { ...row, action: 'cancel' });
          reply = await this.settle(h, row, true);
          break;
        case 'confirm':
          if (!row || row.stage !== 'operation' || row.action !== 'reviewed' || !(h.review||h.richReview)) throw changed();
          this.save(h, { ...row, action: 'confirm' });
          reply = await this.settle(h, row, false);
          break;
        case 'resume':
          if (row?.stage === 'joining') {
            reply = await this.reconcileJoin(h);
            break;
          }
          if (row?.stage === 'group') {
            reply = await this.prepare(h, row.groupId);
            break;
          }
          if (row?.stage === 'done') {
            reply = { kind: row.outcome, handle: h.id, groupId: row.groupId };
            break;
          }
          if (row?.stage !== 'operation' || row.action === 'reviewed') throw changed();
          reply = await this.settle(h, row, row.action === 'cancel');
          break;
      }
      this.check(h);
      return recipeUseReplySchema.parse(reply);
    } finally {
      h.busy = false;
    }
  }
}
