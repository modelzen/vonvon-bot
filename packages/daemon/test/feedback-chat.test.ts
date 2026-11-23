import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {FeedbackChatController, type FeedbackChatAuthorization, type FeedbackChatIm} from '../src/feedback/chat.js';
import {FEEDBACK_ACTION} from '../src/feedback/events.js';
import {FeedbackSubmissionService} from '../src/feedback/service.js';
import {FileFeedbackStore} from '../src/feedback/store.js';
import type {FeedbackActor, FeedbackDestination, FeedbackDraft, FeedbackGateway, FeedbackLookup, FeedbackUserIdentity} from '../src/feedback/types.js';

const bot = {botId: 'bot-1', appId: 'cli_feedback'};
const destination: FeedbackDestination = {baseToken: 'baseToken', tableId: 'tblFeedback', shareToken: 'shrFeedback'};
const summary = {kind: 'bug', title: '截图发不出去', description: '选择一张截图并发送，消息一直等待。', environment: 'macOS'};
const verificationUrl = 'https://accounts.feishu.cn/test-only-authorization';
const qrPath = '/test-only-private-authorization/qr.png';
const receiptUrl = 'https://modelzen.feishu.cn/record/actualReceiptShareToken';

function message(content: string, chatType: 'group' | 'p2p' = 'group', openId = 'ou_author'): NormalizedMessage {
  const chatId = chatType === 'p2p' ? 'oc_private' : 'oc_group';
  return {messageId: 'om_source', chatId, chatType, senderId: openId, senderName: '聊天昵称',
    content, rawContentType: 'text', resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 1,
    raw: {sender: {sender_type: 'user', tenant_key: 'tenant-1', sender_id: {open_id: openId}},
      message: {message_id: 'om_source', chat_id: chatId, chat_type: chatType}}};
}

function action(operationId: string, digest: string, openId = 'ou_author', verb: 'confirm' | 'cancel' = 'confirm'): CardActionEvent {
  return {messageId: 'om_card', chatId: 'oc_group', operator: {openId, name: '同名用户'},
    action: {tag: 'button', value: {a: FEEDBACK_ACTION, operationId, digest, verb}},
    raw: {operator: {open_id: openId, tenant_key: 'tenant-1'}, context: {open_chat_id: 'oc_group', open_message_id: 'om_card'}}};
}

class FixtureIm implements FeedbackChatIm {
  readonly replies: Array<{actor: FeedbackActor; text: string}> = [];
  readonly reviews: Array<{actor: FeedbackActor; body: Parameters<FeedbackChatIm['review']>[1]}> = [];
  readonly authorizations: Array<{actor: FeedbackActor; verificationUrl: string; qrPath: string}> = [];
  async reply(actor: FeedbackActor, text: string): Promise<void> {this.replies.push({actor, text});}
  async review(actor: FeedbackActor, body: Parameters<FeedbackChatIm['review']>[1]): Promise<string> {this.reviews.push({actor, body}); return 'om_review';}
  async authorization(actor: FeedbackActor, verificationUrl: string, qrPath: string): Promise<void> {this.authorizations.push({actor, verificationUrl, qrPath});}
}

class FixtureAuthorization implements FeedbackChatAuthorization {
  readonly began: FeedbackActor[] = [];
  readonly finished: FeedbackActor[] = [];
  async beginAuthorization(actor: FeedbackActor) {
    this.began.push(actor);
    return {verificationUrl, qrPath, expiresAt: 10000};
  }
  async finishAuthorization(actor: FeedbackActor): Promise<FeedbackUserIdentity> {
    this.finished.push(actor);
    return {appId: actor.appId, openId: actor.openId, name: '同名用户'};
  }
}

class FixtureGateway implements FeedbackGateway {
  readonly authorized: FeedbackActor[] = [];
  readonly validated: FeedbackDestination[] = [];
  readonly submitted: FeedbackDraft[] = [];
  lookupCount = 0;
  linkCount = 0;
  async user(actor: FeedbackActor): Promise<FeedbackUserIdentity> {
    this.authorized.push(actor);
    return {appId: actor.appId, openId: actor.openId, name: '飞书授权账号'};
  }
  async validate(_actor: FeedbackActor, destination: FeedbackDestination): Promise<void> {this.validated.push(destination);}
  async submit(draft: FeedbackDraft): Promise<void> {this.submitted.push(draft);}
  async lookup(draft: FeedbackDraft): Promise<FeedbackLookup> {
    this.lookupCount++;
    return this.submitted.some(item => item.operationId === draft.operationId)
      ? {state: 'found', recordId: 'recActual', creatorOpenId: draft.actor.openId} : {state: 'missing'};
  }
  async recordLink(): Promise<string> {this.linkCount++; return receiptUrl;}
}

let scratch: string;
let operationId: string;
let store: FileFeedbackStore;
let im: FixtureIm;
let authorization: FixtureAuthorization;
let gateway: FixtureGateway;
let controller: FeedbackChatController;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'feedback-chat-'));
  operationId = randomUUID();
  store = new FileFeedbackStore(join(scratch, 'private-operations'));
  im = new FixtureIm();
  authorization = new FixtureAuthorization();
  gateway = new FixtureGateway();
  const service = new FeedbackSubmissionService({store, gateway, operationId: () => operationId, now: () => 1000});
  controller = new FeedbackChatController({bot, destination, service, authorization, im});
});
afterEach(async () => {await rm(scratch, {recursive: true, force: true});});

describe('feedback chat narrow routing and private authorization', () => {
  it.each(['请帮我看看这张截图', '/feedbackish authorize', '/feedback-authorize', '请执行 /feedback authorize'])('leaves ordinary chat and other command names untouched: %s', async content => {
    await expect(controller.onMessage(message(content))).resolves.toBe(false);
    expect(im.replies).toEqual([]);
    expect(im.authorizations).toEqual([]);
    expect(authorization.began).toEqual([]);
    expect(authorization.finished).toEqual([]);
    expect(gateway.authorized).toEqual([]);
  });

  it('recognizes only the exact authorization command, while the feedback entry explains chat submission', async () => {
    await expect(controller.onMessage(message('/feedback authorize extra', 'p2p'))).resolves.toBe(true);
    expect(authorization.began).toEqual([]);
    expect(im.authorizations).toEqual([]);
    expect(im.replies[0]?.text).toContain('直接在聊天中描述');
    expect(im.replies[0]?.text).toContain('网页用于查看进展、补充内容和评论');
    expect(gateway.submitted).toEqual([]);
  });

  it.each(['/feedback authorize', '/feedback authorized'])('never obtains or exposes authorization links or QR images in a group: %s', async content => {
    await expect(controller.onMessage(message(content))).resolves.toBe(true);
    expect(authorization.began).toEqual([]);
    expect(authorization.finished).toEqual([]);
    expect(im.authorizations).toEqual([]);
    expect(im.replies).toHaveLength(1);
    expect(im.replies[0]?.text).toContain('本人私聊');
    expect(JSON.stringify(im.replies)).not.toContain(verificationUrl);
    expect(JSON.stringify(im.replies)).not.toContain(qrPath);
  });

  it('binds the private authorization link and QR image to the actual SDK sender', async () => {
    await expect(controller.onMessage(message('/feedback authorize', 'p2p', 'ou_privateAuthor'))).resolves.toBe(true);
    const expectedActor: FeedbackActor = {...bot, tenantKey: 'tenant-1', openId: 'ou_privateAuthor', chatId: 'oc_private', messageId: 'om_source'};
    expect(authorization.began).toEqual([expectedActor]);
    expect(im.authorizations).toEqual([{actor: expectedActor, verificationUrl, qrPath}]);
    expect(im.replies[0]?.actor).toEqual(expectedActor);
    expect(im.replies[0]?.text).toContain('无需填写反馈表');
    await controller.onMessage(message('/feedback authorized', 'p2p', 'ou_privateAuthor'));
    expect(authorization.finished).toEqual([expectedActor]);
    expect(im.replies.at(-1)?.text).toContain('已核对你的飞书账号');
  });

  it('does not authorize or prepare from a message missing raw SDK identity evidence', async () => {
    const untrusted = message('/feedback authorize', 'p2p');
    untrusted.raw = undefined;
    await expect(controller.onMessage(untrusted)).resolves.toBe(true);
    await expect(controller.prepare(untrusted, summary)).rejects.toThrow(/实际聊天身份/);
    expect(authorization.began).toEqual([]);
    expect(authorization.finished).toEqual([]);
    expect(im.replies).toEqual([]);
    expect(im.authorizations).toEqual([]);
    expect(im.reviews).toEqual([]);
    expect(gateway.authorized).toEqual([]);
  });
});

describe('feedback chat review and trusted card callbacks', () => {
  it('only stages the selected files and sends the full review card before any publication', async () => {
    const selected = join(scratch, '截图.png');
    await writeFile(selected, 'selected screenshot');
    await writeFile(join(scratch, 'unselected-private.log'), 'must not be submitted');
    const prepared = await controller.prepare(message('整理并提交反馈'), summary, [selected]);
    expect(prepared).toEqual({operationId, trackingCode: expect.stringMatching(/^VV-[A-F0-9]{16}$/)});
    const persisted = await store.read(operationId);
    expect(persisted.state).toBe('prepared');
    expect(persisted.draft.actor).toEqual({...bot, tenantKey: 'tenant-1', openId: 'ou_author', chatId: 'oc_group', messageId: 'om_source'});
    expect(persisted.draft.attachments.map(file => file.filename)).toEqual(['截图.png']);
    expect(gateway.validated).toEqual([destination]);
    expect(gateway.lookupCount).toBe(0);
    expect(gateway.submitted).toEqual([]);
    expect(im.reviews).toHaveLength(1);
    const card = JSON.stringify(im.reviews[0]?.body);
    for (const text of ['截图发不出去', '选择一张截图并发送', '飞书授权账号', '截图.png', '确认提交', '取消']) expect(card).toContain(text);
    expect(card).not.toContain(scratch);
    expect(card).not.toContain('unselected-private.log');
    expect(card).not.toContain('聊天昵称');
  });

  it('cancels the prepared draft when the complete contents cannot fit in a review card', async () => {
    await expect(controller.prepare(message('整理并提交反馈'), {...summary, description: '长'.repeat(15000)})).rejects.toThrow(/完整核对/);
    expect((await store.read(operationId)).state).toBe('cancelled');
    expect(im.reviews).toEqual([]);
    expect(gateway.submitted).toEqual([]);
  });

  it('rejects another real SDK operator even if their display name is identical', async () => {
    await controller.prepare(message('整理并提交反馈'), summary);
    const persisted = await store.read(operationId);
    await expect(controller.onAction(action(operationId, persisted.draft.digest, 'ou_someoneElse'))).resolves.toBe(true);
    expect(gateway.submitted).toEqual([]);
    expect((await store.read(operationId)).state).toBe('prepared');
    expect(im.replies[0]?.actor.openId).toBe('ou_someoneElse');
    expect(im.replies[0]?.text).toContain('尚未完成核验');
    expect(im.replies[0]?.text).not.toContain(receiptUrl);
  });

  it('publishes once and returns the saved real receipt on a repeated card confirmation', async () => {
    await controller.prepare(message('整理并提交反馈'), summary);
    const persisted = await store.read(operationId);
    const callback = action(operationId, persisted.draft.digest);
    await expect(controller.onAction(callback)).resolves.toBe(true);
    await expect(controller.onAction(callback)).resolves.toBe(true);
    expect(gateway.submitted).toHaveLength(1);
    expect(gateway.submitted[0]?.actor.openId).toBe('ou_author');
    expect(gateway.lookupCount).toBe(2);
    expect(gateway.linkCount).toBe(1);
    expect((await store.read(operationId)).state).toBe('submitted');
    expect(im.replies).toHaveLength(2);
    expect(im.replies[0]?.text).toBe(im.replies[1]?.text);
    expect(im.replies[0]?.text).toContain(receiptUrl);
    expect(im.replies[0]?.text).toContain('继续补充和评论');
  });

  it('routes cancellation to the original prepared draft and leaves unrelated callbacks untouched', async () => {
    await controller.prepare(message('整理并提交反馈'), summary);
    const persisted = await store.read(operationId);
    const unrelated = action(operationId, persisted.draft.digest);
    unrelated.action.value = {a: 'another.feature', verb: 'confirm'};
    await expect(controller.onAction(unrelated)).resolves.toBe(false);
    expect(im.replies).toEqual([]);
    await expect(controller.onAction(action(operationId, persisted.draft.digest, 'ou_author', 'cancel'))).resolves.toBe(true);
    expect((await store.read(operationId)).state).toBe('cancelled');
    expect(gateway.submitted).toEqual([]);
    expect(im.replies[0]?.text).toContain('已取消');
  });
});
