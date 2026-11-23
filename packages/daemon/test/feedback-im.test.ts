import {randomUUID} from 'node:crypto';
import QRCode from 'qrcode';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {feedbackReviewCard} from '../src/feedback/cards.js';
import {NativeFeedbackIm, type FeedbackImClient, type FeedbackPrivateRecipient} from '../src/feedback/im.js';
import type {FeedbackActor} from '../src/feedback/types.js';

const bot = {botId: 'bot-1', appId: 'cli_feedback'};
const actor: FeedbackActor = {...bot, tenantKey: 'actual-tenant', openId: 'ou_author', chatId: 'oc_private', messageId: 'om_source'};
const authorizationUrl = 'https://accounts.feishu.cn/test-only?code=sensitive-authorization-code';
const sdkSecret = 'SDK failed with sensitive-authorization-code and local-private-secret';
const qrPath = '/unused-authorization.png';

function reviewBody() {
  const body = feedbackReviewCard({operationId: randomUUID(), trackingCode: 'VV-0123456789ABCDEF', digest: 'a'.repeat(64),
    accountName: '同名飞书用户', title: '图片发不出去', expiresAt: 86400000,
    summary: {kind: 'bug', title: '图片发不出去', description: '完整描述：' + '图片'.repeat(2000) + '末尾不可丢失', steps: '选择图片后发送',
      expected: '正常发送', environment: 'macOS', impact: '部分受影响', areas: ['聊天与消息']},
    attachments: [{filename: '操作截图.png', bytes: 100}]});
  if (!body) throw new Error('Test card exceeds review budget');
  return body;
}

type Call = {kind: 'get' | 'reply' | 'card' | 'upload'; request: unknown};
class FixtureClient implements FeedbackImClient {
  readonly calls: Call[] = [];
  readonly replyRequests: Array<Parameters<FeedbackImClient['im']['v1']['message']['reply']>[0]> = [];
  readonly cardRequests: Array<Parameters<FeedbackImClient['cardkit']['v1']['card']['create']>[0]> = [];
  readonly uploadRequests: Array<Parameters<FeedbackImClient['im']['v1']['image']['create']>[0]> = [];
  getResponse: unknown = {code: 0, data: {items: [{message_id: actor.messageId, chat_id: actor.chatId,
    sender: {id: actor.openId, id_type: 'open_id', sender_type: 'user', tenant_key: actor.tenantKey}}]}};
  replyResponse: unknown = undefined;
  cardResponse: unknown = {code: 0, data: {card_id: 'card_actual'}};
  uploadResponse: unknown = {image_key: 'img_actual_qr'};
  fail: Call['kind'] | undefined;
  readonly im = {v1: {
    message: {
      get: async (request: Parameters<FeedbackImClient['im']['v1']['message']['get']>[0]): Promise<unknown> => {
        this.calls.push({kind: 'get', request});
        if (this.fail === 'get') throw new Error(sdkSecret);
        return this.getResponse;
      },
      reply: async (request: Parameters<FeedbackImClient['im']['v1']['message']['reply']>[0]): Promise<unknown> => {
        this.calls.push({kind: 'reply', request});
        this.replyRequests.push(request);
        if (this.fail === 'reply') throw new Error(sdkSecret);
        return this.replyResponse ?? {code: 0, data: {message_id: 'om_sent' + this.replyRequests.length, chat_id: actor.chatId}};
      },
    },
    image: {create: async (request: Parameters<FeedbackImClient['im']['v1']['image']['create']>[0]): Promise<unknown> => {
      this.calls.push({kind: 'upload', request});
      this.uploadRequests.push(request);
      if (this.fail === 'upload') throw new Error(sdkSecret);
      return this.uploadResponse;
    }},
  }};
  readonly cardkit = {v1: {card: {create: async (request: Parameters<FeedbackImClient['cardkit']['v1']['card']['create']>[0]): Promise<unknown> => {
    this.calls.push({kind: 'card', request});
    this.cardRequests.push(request);
    if (this.fail === 'card') throw new Error(sdkSecret);
    return this.cardResponse;
  }}}};
}

let sdk: FixtureClient;
let recipient: FeedbackPrivateRecipient | undefined;
let im: NativeFeedbackIm;
const resolvedActors: FeedbackActor[] = [];
beforeEach(() => {
  sdk = new FixtureClient();
  recipient = {actor: {...actor}, chatType: 'p2p'};
  resolvedActors.length = 0;
  im = new NativeFeedbackIm({client: sdk, bot, privateRecipient: async input => {resolvedActors.push(input); return recipient;}});
});
afterEach(() => {vi.restoreAllMocks();});

describe('native feedback message and CardKit delivery', () => {
  it('checks the physical message chat and replies to that message without creating a new target', async () => {
    await im.reply(actor, '反馈仍在处理中');
    expect(sdk.calls.map(call => call.kind)).toEqual(['get', 'reply']);
    expect(sdk.calls[0]?.request).toEqual({path: {message_id: actor.messageId}, params: {user_id_type: 'open_id'}});
    expect(sdk.replyRequests).toEqual([{path: {message_id: actor.messageId}, data: {msg_type: 'text', content: JSON.stringify({text: '反馈仍在处理中'})}}]);
  });

  it.each([
    {code: 100, data: {items: [{message_id: actor.messageId, chat_id: actor.chatId}]}},
    {data: {items: [{message_id: actor.messageId, chat_id: actor.chatId}]}},
    {code: 0, data: {items: []}},
    {code: 0, data: {items: [{message_id: actor.messageId, chat_id: 'oc_other'}]}},
    {code: 0, data: {items: [{message_id: actor.messageId, chat_id: actor.chatId, deleted: true}]}},
  ])('refuses an unverified or mismatched source before sending anything', async response => {
    sdk.getResponse = response;
    await expect(im.review(actor, reviewBody())).rejects.toThrow(/尚未确认送达/);
    expect(sdk.calls.map(call => call.kind)).toEqual(['get']);
  });

  it.each([
    {code: 100, data: {message_id: 'om_reply', chat_id: actor.chatId}},
    {code: 0, data: {chat_id: actor.chatId}},
    {code: 0, data: {message_id: 'om_reply', chat_id: 'oc_other'}},
    {code: 0, data: {message_id: actor.messageId, chat_id: actor.chatId}},
  ])('requires a successful reply receipt with a new message ID in the original chat', async response => {
    sdk.replyResponse = response;
    await expect(im.reply(actor, '结果待核实')).rejects.toThrow(/尚未确认送达/);
  });

  it('creates the complete review card and replies using its actual CardKit ID', async () => {
    const body = reviewBody();
    await im.review(actor, body);
    expect(sdk.calls.map(call => call.kind)).toEqual(['get', 'card', 'reply']);
    expect(sdk.cardRequests[0]).toEqual({data: {type: 'card_json', data: JSON.stringify(body)}});
    expect(sdk.cardRequests[0]?.data.data).toContain('末尾不可丢失');
    expect(Buffer.byteLength(JSON.stringify(sdk.cardRequests[0]?.data))).toBeLessThanOrEqual(30000);
    expect(sdk.replyRequests[0]?.data).toEqual({msg_type: 'interactive', content: JSON.stringify({type: 'card', data: {card_id: 'card_actual'}})});
  });

  it('rejects an oversized serialized card instead of truncating any reviewed content', async () => {
    const oversized = {...reviewBody(), extra: '\\'.repeat(30000)};
    await expect(im.review(actor, oversized)).rejects.toThrow(/尚未确认送达/);
    expect(sdk.calls).toEqual([]);
  });

  it.each([{code: 0, data: {}}, {code: 100, data: {card_id: 'untrusted'}}, {data: {card_id: 'untrusted'}}])('does not send a card without a verified CardKit creation ID', async response => {
    sdk.cardResponse = response;
    await expect(im.review(actor, reviewBody())).rejects.toThrow(/尚未确认送达/);
    expect(sdk.replyRequests).toEqual([]);
  });

  it.each([{...actor, appId: 'cli_other'}, {...actor, botId: 'another-bot'}, {...actor, chatId: 'oc_dm_synthetic'}])('does not accept a different Bot or synthetic destination', async wrongActor => {
    await expect(im.reply(wrongActor, '内容')).rejects.toThrow(/尚未确认送达/);
    expect(sdk.calls).toEqual([]);
  });
});

describe('native feedback private authorization delivery', () => {
  it('confirms the host private recipient, replies with the URL first, then uploads and replies with a PNG Buffer', async () => {
    const original = await QRCode.toBuffer(authorizationUrl);
    await im.authorization(actor, authorizationUrl, qrPath);
    expect(resolvedActors).toEqual([actor]);
    expect(sdk.calls.map(call => call.kind)).toEqual(['get', 'reply', 'upload', 'reply']);
    expect(sdk.replyRequests[0]?.data.msg_type).toBe('text');
    expect(sdk.replyRequests[0]?.data.content).toContain(authorizationUrl);
    expect(sdk.uploadRequests[0]?.data.image_type).toBe('message');
    expect(sdk.uploadRequests[0]?.data.image).toEqual(original);
    expect(Buffer.isBuffer(sdk.uploadRequests[0]?.data.image)).toBe(true);
    expect(sdk.replyRequests[1]).toEqual({path: {message_id: actor.messageId}, data: {msg_type: 'image', content: JSON.stringify({image_key: 'img_actual_qr'})}});
  });

  it.each(['not-private', 'other-user', 'other-chat', 'other-tenant', 'other-message'])('rejects a host recipient that is not this exact private sender: %s', async change => {
    if (change === 'not-private') recipient = undefined;
    if (change === 'other-user') recipient = {actor: {...actor, openId: 'ou_sameNameOtherUser'}, chatType: 'p2p'};
    if (change === 'other-chat') recipient = {actor: {...actor, chatId: 'oc_other'}, chatType: 'p2p'};
    if (change === 'other-tenant') recipient = {actor: {...actor, tenantKey: 'other-tenant'}, chatType: 'p2p'};
    if (change === 'other-message') recipient = {actor: {...actor, messageId: 'om_other'}, chatType: 'p2p'};
    await expect(im.authorization(actor, authorizationUrl, qrPath)).rejects.toThrow(/本人私聊/);
    expect(sdk.calls).toEqual([]);
  });

  it('checks the source message belongs to the user even when two people have the same display name', async () => {
    sdk.getResponse = {code: 0, data: {items: [{message_id: actor.messageId, chat_id: actor.chatId,
      sender: {id: 'ou_sameNameOtherUser', id_type: 'open_id', sender_type: 'user', sender_name: '同名飞书用户'}}]}};
    await expect(im.authorization(actor, authorizationUrl, qrPath)).rejects.toThrow(/本人私聊/);
    expect(sdk.replyRequests).toEqual([]);
    expect(sdk.uploadRequests).toEqual([]);
  });

  it.each(['/nonexistent/authorization.png', '../../private/credentials.json', 'relative.png', ''])('never reads the legacy QR path and generates the PNG from this exact URL: %s', async path => {
    const originalUrl = 'https://open.feishu.cn/authorize?b=%2F%2b&a=one+two&a=three';
    await im.authorization(actor, originalUrl, path);
    expect(sdk.uploadRequests[0]?.data.image).toEqual(await QRCode.toBuffer(originalUrl));
    expect(sdk.replyRequests[0]?.data.content).toContain(originalUrl);
  });

  it('keeps each URL paired with its own generated QR when two authorizations interleave for the same actor', async () => {
    let beginCount = 0;
    let releaseFirst: () => void = () => undefined;
    const blocked = new Promise<void>(resolve => {releaseFirst = resolve;});
    let announceFirst: () => void = () => undefined;
    const firstEntered = new Promise<void>(resolve => {announceFirst = resolve;});
    const concurrent = new NativeFeedbackIm({client: sdk, bot, privateRecipient: async () => {
      if (++beginCount === 1) {announceFirst(); await blocked;}
      return recipient;
    }});
    const urlA = 'https://open.feishu.cn/authorize?code=A&raw=%2F';
    const urlB = 'https://open.feishu.cn/authorize?code=B&raw=%2b';
    const first = concurrent.authorization(actor, urlA, qrPath);
    try {
      await firstEntered;
      await concurrent.authorization(actor, urlB, qrPath);
    } finally {releaseFirst();}
    await first;
    expect(sdk.uploadRequests.map(request => request?.data.image)).toEqual([await QRCode.toBuffer(urlB), await QRCode.toBuffer(urlA)]);
    expect(sdk.replyRequests.map(request => request?.data.msg_type)).toEqual(['text', 'image', 'text', 'image']);
    expect(sdk.replyRequests[0]?.data.content).toContain(urlB);
    expect(sdk.replyRequests[2]?.data.content).toContain(urlA);
  });

  it.each(['https://evil.invalid/authorize', 'http://accounts.feishu.cn/authorize', 'https://user:password@accounts.feishu.cn/authorize'])('rejects an untrusted authorization URL', async url => {
    await expect(im.authorization(actor, url, qrPath)).rejects.toThrow(/本人私聊/);
    expect(sdk.replyRequests).toEqual([]);
  });

  it('stops after a link reply whose actual chat could not be confirmed', async () => {
    sdk.replyResponse = {code: 0, data: {message_id: 'om_link', chat_id: 'oc_other'}};
    await expect(im.authorization(actor, authorizationUrl, qrPath)).rejects.toThrow(/本人私聊/);
    expect(sdk.replyRequests).toHaveLength(1);
    expect(sdk.uploadRequests).toEqual([]);
  });

  it.each([null, {}, {code: 100, data: {image_key: 'img_fake'}}, {code: 100, image_key: 'img_fake'}])('does not send an image without a valid upload result', async response => {
    sdk.uploadResponse = response;
    await expect(im.authorization(actor, authorizationUrl, qrPath)).rejects.toThrow(/本人私聊/);
    expect(sdk.replyRequests).toHaveLength(1);
  });

  it.each(['get', 'reply', 'card', 'upload'] satisfies Call['kind'][])('never returns or logs raw SDK errors: %s', async kind => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    sdk.fail = kind;
    const operation = kind === 'card' ? im.review(actor, reviewBody()) : im.authorization(actor, authorizationUrl, qrPath);
    const error: unknown = await operation.then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).not.toContain('sensitive-authorization-code');
      expect(error.message).not.toContain('local-private-secret');
      expect(error.message).not.toContain(authorizationUrl);
      expect(error.cause).toBeUndefined();
    }
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    expect(logs).not.toHaveBeenCalled();
  });
});

it('rechecks the review after CardKit creation and before the actual SDK reply', async () => {
  await expect(im.review(actor, reviewBody(), async () => {
    expect(sdk.calls.map(call => call.kind)).toEqual(['get', 'card']);
    throw new Error('revoked');
  })).rejects.toThrow(/尚未确认送达/);
  expect(sdk.replyRequests).toHaveLength(0);
});
