import { randomUUID } from 'node:crypto';
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
  private base(h: Handle) {
    return {
      id: h.row?.id ?? h.id,
      accountId: h.input.accountId,
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
    return { kind: 'pending', handle: h.id, phase, ...(h.row && 'groupId' in h.row && { groupId: h.row.groupId }) };
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
    if (reply.kind === 'prepared') {
      if (
        reply.targetPublicKey !== h.pk ||
        reply.versionId !== h.input.versionId ||
        reply.manifestSha256 !== h.preview.manifestSha256
      )
        throw invalid();
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
      const row = this.journal
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
        this.handles.set(h.id, h);
        return { kind: row.outcome, handle: h.id, groupId: row.groupId };
      }
      if (row?.stage === 'joining' || (row?.stage === 'operation' && row.action !== 'reviewed')) {
        this.handles.set(h.id, h);
        return this.pending(
          h,
          row.stage === 'joining' ? 'joining' : row.action === 'cancel' ? 'cancelling' : 'installing',
        );
      }
      h.preview = await this.cloud(h).preview(input.recipeId, input.versionId);
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
  private async reconcileJoin(h: Handle): Promise<RecipeUseReply> {
    const row = h.row;
    if (row?.stage !== 'joining') throw invalid();
    let groupId: GroupId | undefined;
    if (row.bindId) {
      const snapshot = await h.lease.client.snapshot();
      this.check(h);
      if (snapshot.memberships.some((m) => m.agentId === row.botId && m.groupId === row.bindId)) groupId = row.bindId;
    } else {
      const reply = await this.daemon(h, { type: 'createdGroup', botId: row.botId, requestId: row.id });
      this.check(h);
      if (reply.kind !== 'createdGroup') throw invalid();
      groupId = reply.groupId ?? undefined;
    }
    if (!groupId) return this.pending(h, 'joining');
    this.save(h, { ...this.base(h), stage: 'group', groupId });
    return this.prepare(h, groupId);
  }
  private async join(h: Handle, input: Extract<RecipeUseRequest, { type: 'join' }>['input']): Promise<RecipeUseReply> {
    if (h.row || h.input.groupId || input.agentId !== h.input.botId || !h.preview) throw invalid();
    await this.identity(h);
    this.check(h);
    const row = { ...this.base(h), stage: 'joining' as const, ...('type' in input && { bindId: input.groupId }) };
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
      this.check(h);
      if (
        error instanceof JoinRefused ||
        (error instanceof RpcError &&
          ['invalid_params', 'permission_denied', 'invalid_input', 'unsupported', 'invalid_argument'].includes(
            error.code,
          ))
      ) {
        this.journal.remove(row.id);
        h.row = undefined;
        throw error;
      }
      return this.pending(h, 'joining');
    }
    // A returned creation belongs to its original journal even when its window or account has gone.
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
        if (status.status === 'rejected') return this.done(h, row.groupId, 'rejected', '已取消或过期');
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
    const read = recipeInstallReplySchema.parse(await lease.client.recipeInstall({ type: 'source', botId, groupId }));
    check();
    if (read.kind !== 'source' || read.groupId !== groupId) throw invalid();
    if (request.type === 'read' || !read.source || !accountId || !signal) return { source: read.source };
    const latest = await recipeCloud(this.account, { accountId, signal, check }).latest(read.source.recipeId);
    check();
    if (request.type === 'ignore') {
      if (
        latest.versionId !== request.versionId ||
        latest.revision <= read.source.revision ||
        request.installedVersionId !== read.source.versionId
      )
        throw changed();
      const now = await identity();
      check();
      if (now.pk !== device.pk || now.id !== device.id) throw changed();
      const applied = recipeInstallReplySchema.parse(
        await lease.client.recipeInstall({
          type: 'ignoreVersion',
          botId,
          groupId,
          recipeId: read.source.recipeId,
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
    return {
      source: read.source,
      ...(latest.revision > read.source.revision && latest.versionId !== read.source.ignoredVersionId && { latest }),
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
          if (!row || row.stage !== 'operation' || row.action !== 'reviewed' || !h.review) throw changed();
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
