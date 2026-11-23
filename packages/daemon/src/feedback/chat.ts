import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {feedbackReviewCard} from './cards.js';
import {feedbackActionFromEvent, feedbackActorFromMessage} from './events.js';
import type {FeedbackSubmissionService} from './service.js';
import type {FeedbackActor, FeedbackDestination, FeedbackSubmissionResult, FeedbackUserIdentity} from './types.js';

type ReviewCard = NonNullable<ReturnType<typeof feedbackReviewCard>>;
export interface FeedbackChatIm {
  reply(actor: FeedbackActor, text: string, beforeSend?: () => Promise<void>): Promise<void>;
  review(actor: FeedbackActor, body: ReviewCard, beforeSend?: () => Promise<void>): Promise<string>;
  /** Send URL followed by its QR image to this exact person's private chat. */
  authorization(actor: FeedbackActor, verificationUrl: string, qrPath: string): Promise<void>;
}
export interface FeedbackChatAuthorization {
  beginAuthorization(actor: FeedbackActor): Promise<{verificationUrl: string; qrPath: string; expiresAt: number}>;
  finishAuthorization(actor: FeedbackActor): Promise<FeedbackUserIdentity>;
}

export async function feedbackAuthorizationMessage(command: '/feedback authorize' | '/feedback authorized', message: NormalizedMessage,
  actor: FeedbackActor, authorization: FeedbackChatAuthorization, im: FeedbackChatIm): Promise<void> {
  if (message.chatType !== 'p2p') {
    await im.reply(actor, '请在与这个 Bot 的本人私聊发送 /feedback authorize。授权链接和二维码只会在私聊展示。');
    return;
  }
  try {
    if (command === '/feedback authorize') {
      const link = await authorization.beginAuthorization(actor);
      await im.authorization(actor, link.verificationUrl, link.qrPath);
      await im.reply(actor, '请用本人飞书账号打开链接或扫码授权，然后发送 /feedback authorized。这里仅需登录授权，无需填写反馈表。');
    } else {
      const user = await authorization.finishAuthorization(actor);
      await im.reply(actor, `已核对你的飞书账号：${user.name}。可以回到原聊天继续整理反馈，公开提交前还需核对摘要并点击确认。`);
    }
  } catch {
    await im.reply(actor, '尚未完成本人授权。请确认这是自己组织的本地 Bot，管理员已启用所需权限；授权过期或账号不符时重新发送 /feedback authorize。');
  }
}

/** SDK host boundary. None of these methods is a model-callable confirmation API. */
export class FeedbackChatController {
  constructor(private readonly options: {
    bot: {botId: string; appId: string};
    destination: FeedbackDestination;
    service: FeedbackSubmissionService;
    authorization: FeedbackChatAuthorization;
    im: FeedbackChatIm;
  }) {}

  /** Route this narrow command before the admin-only DM gate. */
  async onMessage(message: NormalizedMessage): Promise<boolean> {
    if (!/^\/feedback(?:\s|$)/.test(message.content.trim())) return false;
    const actor = feedbackActorFromMessage(this.options.bot, message);
    if (!actor) return true;
    const command = message.content.trim();
    if (command === '/feedback authorize' || command === '/feedback authorized') {
      await feedbackAuthorizationMessage(command, message, actor, this.options.authorization, this.options.im);
      return true;
    }
    await this.options.im.reply(actor, '直接在聊天中描述问题或建议，排查后告诉我“整理并提交反馈”。首次使用先在本人私聊发送 /feedback authorize。网页用于查看进展、补充内容和评论：' +
      `https://my.feishu.cn/base/${this.options.destination.baseToken}?table=${this.options.destination.tableId}`);
    return true;
  }

  /** Host binds the actual event and explicitly selected local files out of band. */
  async prepare(message: NormalizedMessage, summary: unknown, selectedAttachments: readonly string[] = [],
    lifecycle?: {beforeReview(operationId: string): Promise<void>; delivered(operationId: string, messageId: string): Promise<void>; check(): Promise<void>}): Promise<{operationId: string; trackingCode: string}> {
    const actor = feedbackActorFromMessage(this.options.bot, message);
    if (!actor) throw new Error('无法核验发起反馈的实际聊天身份。');
    const review = await this.options.service.prepare({actor, destination: this.options.destination, summary, attachments: selectedAttachments});
    const body = feedbackReviewCard(review);
    if (!body) {
      await this.options.service.cancel({actor, operationId: review.operationId});
      throw new Error('内容过长，无法在卡片中完整核对。请先精简说明，再重新准备反馈。');
    }
    try {
      await lifecycle?.beforeReview(review.operationId);
      await lifecycle?.check();
      const messageId = await this.options.im.review(actor, body, lifecycle?.check);
      await lifecycle?.delivered(review.operationId, messageId);
      await lifecycle?.check();
    } catch (error) {
      await this.options.service.cancel({actor, operationId: review.operationId});
      throw error;
    }
    return {operationId: review.operationId, trackingCode: review.trackingCode};
  }

  /** Register only on the trusted Bot SDK callback dispatcher. */
  async onAction(event: CardActionEvent, guard?: () => Promise<void>): Promise<boolean> {
    const action = feedbackActionFromEvent(this.options.bot, event);
    if (!action) return false;
    const actor = {...action.confirmation, messageId: action.messageId};
    // Reconstruct only the actor fields; confirmation-only keys never reach service actor schemas.
    const recipient: FeedbackActor = {botId: actor.botId, appId: actor.appId, tenantKey: actor.tenantKey,
      openId: actor.openId, chatId: actor.chatId, messageId: actor.messageId};
    try {
      if (action.verb === 'cancel') {
        await this.options.service.cancel({actor: recipient, operationId: action.confirmation.operationId});
        await this.options.im.reply(recipient, '已取消这次反馈，尚未公开提交。');
      } else {
        const result = action.verb === 'confirm'
          ? await this.options.service.confirm(action.confirmation, guard)
          : await this.options.service.reconcile({actor: recipient, operationId: action.confirmation.operationId});
        await this.showResult(recipient, result);
      }
    } catch {
      await this.options.im.reply(recipient, '本次操作尚未完成核验。请保留原摘要和跟进编号；如已点击提交，先查询本次回执，不要新建一条重复反馈。');
    }
    return true;
  }

  private async showResult(actor: FeedbackActor, result: FeedbackSubmissionResult): Promise<void> {
    if (result.state === 'submitted') {
      await this.options.im.reply(actor, `反馈已提交。跟进编号：${result.receipt.trackingCode}\n${result.receipt.url}\n可以在网页继续补充和评论，并查看后续进展。`);
    } else if (result.state === 'not-submitted') {
      await this.options.im.reply(actor, `反馈记录尚未发出。跟进编号：${result.trackingCode}\n本次提交已停止，可以重新整理反馈并核对新卡片。`);
    } else {
      await this.options.im.reply(actor, `提交结果待核实。跟进编号：${result.trackingCode}\n请保留原卡片，再次点击只会查询本次回执，不会重新提交。`);
    }
  }
}
