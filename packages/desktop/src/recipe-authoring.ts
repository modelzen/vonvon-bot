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
  type AuthoringReceipt,
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
type Handle = {
  id: string;
  open: Open;
  lease: RecipeDeviceLease;
  signal: AbortSignal;
  stop: AbortController;
  deviceId: string;
  deviceKey: string;
  session?: string;
  tail: Promise<void>;
  queued: number;
  lastInteraction: number;
  lastActivity: number;
  lastVerified: number;
  retry: Map<string, { state: string; until: number; delay: number; message?: string }>;
  target: DesktopAuthoringOperation['target'];
  groups: Map<GroupId, string>;
  operations: Map<string, AuthoringOperation>;
  source?: { groupId: GroupId; reviewToken: string };
  challenge?: { id: string; evidence?: string };
  reviewed: Map<string, string>;
  timer?: ReturnType<typeof setInterval>;
  busy: boolean;
  removeAbort?: () => void;
};
type Action = Exclude<DesktopAuthoringRequest, Open>;
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
  constructor(
    private readonly account: NativeAccount,
    private readonly capture: (viewId: string) => RecipeDeviceLease,
    private readonly journal: AuthoringJournal,
  ) {}
  private check(h: Handle) {
    h.lease.check();
    if (h.stop.signal.aborted || this.account.lease?.(h.open.accountId) !== h.signal || h.signal.aborted)
      throw changed();
  }
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
    if (!bot) throw new AuthoringError('所选 Bot 已移除，请重新选择。');
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
  private async open(input: Open): Promise<DesktopAuthoringReply> {
    const target = input.viewId + '/' + input.botId;
    if (this.opening.has(target)) throw new AuthoringError('正在连接这个 Bot，请稍后继续。');
    this.opening.add(target);
    try {
      return await this.openTarget(input);
    } finally {
      this.opening.delete(target);
    }
  }
  private async openTarget(input: Open): Promise<DesktopAuthoringReply> {
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
      lastInteraction: Date.now(),
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
      const result = await this.refresh(h);
      this.check(h);
      h.timer = setInterval(
        () => {
          if (Date.now() - Math.max(h.lastInteraction, h.lastActivity) > 30 * 60_000) {
            this.revoke(h);
            return;
          }
          if (h.busy) return;
          h.busy = true;
          h.tail = this.present(h, false)
            .then(() => this.refresh(h))
            .then(
              () => {},
              () => {
                this.invalidateStale();
              },
            )
            .finally(() => {
              h.busy = h.queued > 0;
            });
        },
        Math.max(100, Math.min(12_000, Math.floor(session.leaseMs / 3))),
      );
      h.timer.unref();
      return result;
    } catch (error) {
      this.revoke(h);
      throw error;
    } finally {
      h.busy = false;
    }
  }
  private binding(h: Handle) {
    this.check(h);
    return { accountId: h.open.accountId, viewId: h.open.viewId, deviceId: h.deviceId, deviceKey: h.deviceKey, botId: h.open.botId };
  }
  private remember(h: Handle, op: AuthoringOperation, cancel = false) {
    const row = this.journal.observe(this.binding(h), op, cancel);
    h.operations.set(op.operationId, op);
    return row;
  }
  private display(h: Handle, op: AuthoringOperation, cloudMessage?: string): DesktopAuthoringOperation {
    const { targetPublicKey: _pk, nonceCommitment: _nonce, cardUpdate, ...summary } = op;
    const cardMessage = cardUpdate === 'unavailable' ? '原私聊卡片无法再更新，请以 App 中的状态为准。'
      : cardUpdate ? '私聊卡片更新尚未确认，将在连接时重试。' : undefined;
    const syncMessage = [expiryNotice(op.receipt).syncMessage, cloudMessage, cardMessage].filter(Boolean).join(' ');
    return { ...summary, ...(syncMessage && {syncMessage}), target: h.target, ...(op.groupId && { groupName: h.groups.get(op.groupId) || op.groupId }) };
  }
  private async status(h: Handle) {
    const status = expectKind(await this.daemon(h, { type: 'status' }), 'status');
    this.check(h);
    for (const op of status.operations) {
      const prior = h.operations.get(op.operationId);
      if (!prior || prior.state !== op.state) h.lastActivity = Date.now();
    }
    h.operations.clear();
    for (const [index,op] of status.operations.entries()) {
      this.remember(h, op);
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
          const state = await cloud.get(op);
          const winner = state && 'operationId' in state ? state : await cloud.cancel(op);
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
      operations: [...h.operations.values()].map(op =>
        this.display(h, op, terminal(op) ? undefined : h.retry.get(op.operationId)?.message),
      ).concat(revoked),
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
    const reply = expectKind(
      await this.daemon(h, { type: 'inspectCandidate', operationId: op.operationId }),
      'candidate',
    );
    if (reply.operationId !== op.operationId || reply.payloadDigest !== op.payloadDigest) throw recheck();
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
  private async sync(
    h: Handle,
    op: AuthoringOperation,
    action: 'resume' | 'cancel' | 'resend' | 'accept' = 'resume',
    digest?: string,
  ) {
    const row = this.remember(h, op, action === 'cancel');
    const operationId = op.operationId,
      cloud = this.cloud(h);
    if (row.cancelling || op.state === 'cancelPending') {
      if (!terminal(op) && op.state !== 'cancelPending') await this.operation(h, { type: 'cancel', operationId });
      return this.settle(h, op, await cloud.cancel(op));
    }
    let state = await cloud.get(op);
    this.check(h);
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
    if (op.state !== 'pendingCloud') return op;
    const candidate = await this.inspect(h, op);
    this.check(h);
    const authorization = await cloud.authorize(op, 'accept', candidate.payloadDigest);
    // Reject an intervening candidate change before transferring a stage ticket to the original peer.
    await this.inspect(h, op);
    this.check(h);
    return this.confirmedOperation(h, await this.operation(h, { type: 'advance', operationId, authorization }));
  }
  private async action(h: Handle, r: Exclude<Action, { type: 'close' }>): Promise<DesktopAuthoringReply> {
    await this.present(h, r.type !== 'status');
    switch (r.type) {
      case 'status':
        return this.refresh(h);
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
      case 'prepare':
      case 'edit': {
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
        return { kind: 'operation', operation: this.display(h, await this.sync(h, op)) };
      }
      default: {
        await this.status(h);
        const op = h.operations.get(r.operationId);
        if (!op) throw recheck();
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
    if (r.type === 'open') return desktopAuthoringReplySchema.parse(await this.open(r));
    const h = this.handles.get(r.handle);
    if (!h) throw changed();
    if (r.type === 'close') {
      this.revoke(h);
      return { kind: 'closed' as const };
    }
    this.check(h);
    h.lastInteraction = Date.now();
    if (h.queued >= 8) throw new AuthoringError('正在核对上一次操作，请稍后继续。');
    h.queued++;
    h.busy = true;
    const run = h.tail.then(async () => {
      this.check(h);
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
