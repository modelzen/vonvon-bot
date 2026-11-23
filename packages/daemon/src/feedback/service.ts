import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {basename} from 'node:path';
import {z} from 'zod';
import {assertFeedbackTextPrivacy} from './privacy.js';
import {
  feedbackActorSchema, feedbackConfirmationSchema, feedbackDestinationSchema,
  feedbackDetailFields, feedbackDetails, feedbackFormChangedMessage, feedbackDraftSchema, feedbackReceiptSchema, feedbackSummarySchema, feedbackTooLongMessage, sameFeedbackPerson, FeedbackNotDispatchedError,
  type FeedbackActor, type FeedbackConfirmation, type FeedbackDraft, type FeedbackGateway,
  type FeedbackLookup, type FeedbackOperation, type FeedbackReceipt, type FeedbackReview,
  type FeedbackStore, type FeedbackSubmissionResult,
} from './types.js';

const reviewLifetime = 24 * 60 * 60 * 1000;
const prepareSchema = z.object({
  actor: feedbackActorSchema,
  destination: feedbackDestinationSchema,
  summary: feedbackSummarySchema,
  attachments: z.array(z.string().min(1)).max(6).default([]),
}).strict();
const operationRequestSchema = z.object({
  actor: feedbackActorSchema,
  operationId: z.string().uuid(),
}).strict();

interface Options {
  store: FeedbackStore;
  gateway: FeedbackGateway;
  now?: () => number;
  operationId?: () => string;
  trackingCode?: () => string;
}

function contentDigest(draft: Omit<FeedbackDraft, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({
    operationId: draft.operationId,
    trackingCode: draft.trackingCode,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    actor: feedbackActorSchema.parse(draft.actor),
    accountName: draft.accountName,
    destination: feedbackDestinationSchema.parse(draft.destination),
    summary: feedbackSummarySchema.parse(draft.summary),
    attachments: draft.attachments.map(({filename, bytes, sha256}) => ({filename, bytes, sha256})),
  })).digest('hex');
}

function sameChat(left: FeedbackActor, right: FeedbackActor | FeedbackConfirmation): boolean {
  return left.botId === right.botId && left.appId === right.appId &&
    left.tenantKey === right.tenantKey && left.openId === right.openId && left.chatId === right.chatId;
}

function assertActor(draft: FeedbackDraft, actor: FeedbackActor | FeedbackConfirmation): void {
  if (!sameChat(draft.actor, actor)) throw new Error('这条反馈不属于当前聊天身份。');
}

function assertContent(draft: FeedbackDraft): void {
  if (contentDigest(draft) !== draft.digest) throw new Error('待提交内容已经改变，请重新核对摘要。');
}

export class FeedbackSubmissionService {
  private readonly now: () => number;
  private readonly operationId: () => string;
  private readonly trackingCode: () => string;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.operationId = options.operationId ?? randomUUID;
    this.trackingCode = options.trackingCode ?? (() => `VV-${randomBytes(8).toString('hex').toUpperCase()}`);
  }

  private async authorize(actor: FeedbackActor): Promise<string> {
    const user = await this.options.gateway.user(actor);
    if (!sameFeedbackPerson(actor, user)) throw new Error('反馈提交账号与聊天身份不一致，请重新授权。');
    return user.name;
  }

  async prepare(input: {
    actor: unknown;
    destination: unknown;
    summary: unknown;
    attachments?: readonly string[];
  }): Promise<FeedbackReview> {
    const request = prepareSchema.parse(input);
    assertFeedbackTextPrivacy(request.summary, request.attachments.map(path => basename(path)));
    const accountName = await this.authorize(request.actor);
    const layout = await this.options.gateway.validate(request.actor, request.destination);
    const summary = request.summary;
    const details = feedbackDetails(summary);
    if (details.length && layout !== 'detail-fields') {
      // Freeze the exact fields displayed on the card; a later template upgrade cannot change a retry.
      summary.description = [summary.description, ...details.map(({label, value}) => label + '\n' + value)].join('\n\n');
      if (summary.description.length > 30000) throw new Error(feedbackTooLongMessage);
      for (const [key] of feedbackDetailFields) delete summary[key];
      assertFeedbackTextPrivacy(summary);
    }
    const operationId = z.string().uuid().parse(this.operationId());
    const attachments = await this.options.store.stage(operationId, request.attachments);
    const createdAt = this.now();
    const content = {
      operationId,
      trackingCode: this.trackingCode(),
      createdAt,
      expiresAt: createdAt + reviewLifetime,
      actor: request.actor,
      accountName,
      destination: request.destination,
      summary,
      attachments,
    };
    const draft = feedbackDraftSchema.parse({...content, digest: contentDigest(content)});
    await this.options.store.create({state: 'prepared', draft});
    return {
      operationId,
      trackingCode: draft.trackingCode,
      digest: draft.digest,
      accountName,
      title: draft.summary.title,
      summary: structuredClone(draft.summary),
      attachments: draft.attachments.map(({filename, bytes}) => ({filename, bytes})),
      expiresAt: draft.expiresAt,
    };
  }

  async confirm(input: unknown, check?: () => Promise<void>): Promise<FeedbackSubmissionResult> {
    const confirmation = feedbackConfirmationSchema.parse(input);
    return this.options.store.exclusive(confirmation.operationId, async () => {
      const operation = await this.options.store.read(confirmation.operationId);
      const {draft} = operation;
      assertActor(draft, confirmation);
      assertContent(draft);
      if (confirmation.digest !== draft.digest) throw new Error('确认内容与原摘要不一致，请重新核对。');
      await this.authorize(draft.actor);
      switch (operation.state) {
        case 'submitted': return {state: 'submitted', receipt: operation.receipt};
        case 'not-submitted': return {state: 'not-submitted', operationId: draft.operationId, trackingCode: draft.trackingCode};
        case 'cancelled': throw new Error('这次反馈已取消，请重新整理后再提交。');
        case 'sending':
        case 'uncertain': return this.recover(operation);
        case 'prepared': {
          if (this.now() >= draft.expiresAt || this.now() < draft.createdAt) {
            throw new Error('这份提交确认已过期，请重新核对摘要。');
          }
          const existing = await this.options.gateway.lookup(draft);
          if (existing.state !== 'missing') return this.finishExisting(draft, existing);
          assertFeedbackTextPrivacy(draft.summary, draft.attachments.map(file => file.filename));
          await this.options.store.verify(draft);
          if (feedbackDetails(draft.summary).length && await this.options.gateway.validate(draft.actor, draft.destination) !== 'detail-fields') {
            throw new Error(feedbackFormChangedMessage);
          }
          await check?.();
          const sending = {state: 'sending', draft, sentAt: this.now()} satisfies FeedbackOperation;
          await this.options.store.write(sending);
          try {
            try {await check?.();}
            catch {throw new FeedbackNotDispatchedError();}
            await this.options.gateway.submit(draft, check);
          } catch (error) {
            if (error instanceof FeedbackNotDispatchedError) {
              await this.options.store.write({state: 'not-submitted', draft});
              return {state: 'not-submitted', operationId: draft.operationId, trackingCode: draft.trackingCode};
            }
            // Once the form process can have started, a failure cannot rule out a write.
          }
          return this.recover(sending);
        }
        default: {
          const unhandled: never = operation;
          return unhandled;
        }
      }
    });
  }

  async reconcile(input: {actor: unknown; operationId: string}): Promise<FeedbackSubmissionResult> {
    const request = operationRequestSchema.parse(input);
    return this.options.store.exclusive(request.operationId, async () => {
      const operation = await this.options.store.read(request.operationId);
      assertActor(operation.draft, request.actor);
      assertContent(operation.draft);
      await this.authorize(operation.draft.actor);
      switch (operation.state) {
        case 'submitted': return {state: 'submitted', receipt: operation.receipt};
        case 'not-submitted': return {state: 'not-submitted', operationId: operation.draft.operationId, trackingCode: operation.draft.trackingCode};
        case 'sending':
        case 'uncertain': return this.recover(operation);
        case 'prepared': throw new Error('这条反馈尚未在聊天中确认提交。');
        case 'cancelled': throw new Error('这次反馈已取消。');
        default: {
          const unhandled: never = operation;
          return unhandled;
        }
      }
    });
  }

  async cancel(input: {actor: unknown; operationId: string}): Promise<void> {
    const request = operationRequestSchema.parse(input);
    await this.options.store.exclusive(request.operationId, async () => {
      const operation = await this.options.store.read(request.operationId);
      assertActor(operation.draft, request.actor);
      if (operation.state !== 'prepared') throw new Error('这次操作已进入提交阶段，不能当作未提交草稿取消。');
      await this.options.store.write({state: 'cancelled', draft: operation.draft});
    });
  }

  private async finishExisting(draft: FeedbackDraft, found: Exclude<FeedbackLookup, {state: 'missing'}>): Promise<FeedbackSubmissionResult> {
    if (found.state === 'conflict') throw new Error('发现多条匹配的反馈，请先核对提交结果。');
    if (found.creatorOpenId !== draft.actor.openId) throw new Error('反馈创建人与本次提交身份不一致。');
    let receipt: FeedbackReceipt;
    try {
      receipt = feedbackReceiptSchema.parse({
        operationId: draft.operationId,
        trackingCode: draft.trackingCode,
        recordId: found.recordId,
        url: await this.options.gateway.recordLink(draft, found.recordId),
        accountName: draft.accountName,
        submittedAt: this.now(),
      });
    } catch {
      throw new Error('无法核验反馈链接，请查询本次提交结果。');
    }
    await this.options.store.write({state: 'submitted', draft, receipt});
    return {state: 'submitted', receipt};
  }

  private async recover(operation: Extract<FeedbackOperation, {state: 'sending' | 'uncertain'}>): Promise<FeedbackSubmissionResult> {
    const {draft, sentAt} = operation;
    const uncertain = async (): Promise<FeedbackSubmissionResult> => {
      await this.options.store.write({state: 'uncertain', draft, sentAt});
      return {state: 'uncertain', operationId: draft.operationId, trackingCode: draft.trackingCode};
    };
    let found: FeedbackLookup;
    try {
      found = await this.options.gateway.lookup(draft);
    } catch {
      return uncertain();
    }
    if (found.state === 'missing') return uncertain();
    try {
      return await this.finishExisting(draft, found);
    } catch (error) {
      await uncertain();
      throw error;
    }
  }
}
