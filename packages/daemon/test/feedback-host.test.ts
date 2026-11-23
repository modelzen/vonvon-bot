import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {isChatAllowed, isUserAllowedInProject, type AppConfig} from '../src/config/schema';
import type {FeedbackChatIm} from '../src/feedback/chat';
import {configuredFeedback, configureFeedback, feedbackBinding, setupDestination} from '../src/feedback/config';
import {FEEDBACK_ACTION} from '../src/feedback/events';
import {createFeedbackHost} from '../src/feedback/host';
import {NativeFeedbackIm, type FeedbackImClient} from '../src/feedback/im';
import {FileFeedbackStore} from '../src/feedback/store';
import {feedbackSummarySchema, type FeedbackActor, type FeedbackDraft, type FeedbackGateway} from '../src/feedback/types';
import type {Project} from '../src/project/registry';

const registration = randomUUID();
const destination = {baseToken: 'BaseABC', tableId: 'tblOne', shareToken: 'shrOne'};
const command = '/feedback setup https://my.feishu.cn/base/BaseABC?table=tblOne&view=vewX https://my.feishu.cn/share/base/shrOne';
const summary = feedbackSummarySchema.parse({kind: 'bug', title: '图片', description: '待核对描述'});
let root: string;
beforeEach(async () => {root = await mkdtemp(join(tmpdir(), 'feedback-host-'));});
afterEach(async () => {await rm(root, {recursive: true, force: true});});
const bot = {appId: 'cli_fixture', botId: 'cli_fixture'};
function message(text = '整理反馈', senderId = 'ou_member', chatType: 'group' | 'p2p' = 'group'): NormalizedMessage {
  const chatId = chatType === 'group' ? 'oc_group' : 'oc_private';
  return {messageId: 'om_1', chatId, senderId, chatType, rawContentType: 'text', content: text,
    raw: {sender: {sender_type: 'user', tenant_key: 'org', sender_id: {open_id: senderId}},
      message: {message_id: 'om_1', chat_id: chatId, chat_type: chatType}}, resources: [], mentions: [], mentionAll: false, mentionedBot: true, createTime: 1};
}
function action(draft: FeedbackDraft, openId = draft.actor.openId): CardActionEvent {
  return {messageId: 'om_review', chatId: draft.actor.chatId, operator: {openId},
    action: {tag: 'button', value: {a: FEEDBACK_ACTION, operationId: draft.operationId, digest: draft.digest, verb: 'confirm'}},
    raw: {operator: {open_id: openId, tenant_key: 'org'}, context: {open_chat_id: draft.actor.chatId, open_message_id: 'om_review'}}};
}
function projectRow(): Project {
  const bindingIncarnation = randomUUID();
  return {name: 'group', chatId: 'oc_group', bindingIncarnation, blank: true, createdAt: 1, cwd: root};
}
function fixture() {
  const project = projectRow();
  const access: {allowedChats: string[]} = {allowedChats: []};
  const cfg: AppConfig = {accounts: {app: {id: bot.appId, secret: 'fixture', tenant: 'feishu'}}, preferences: {access}};
  const store = new FileFeedbackStore(join(root, 'operations'));
  const sent = new Set<string>();
  const gateway = {
    user: async (actor: FeedbackActor) => ({appId: actor.appId, openId: actor.openId, name: '本人'}),
    validate: vi.fn(async () => {}),
    lookup: vi.fn(async (draft: FeedbackDraft) => sent.has(draft.operationId)
      ? {state: 'found' as const, recordId: 'recOne', creatorOpenId: draft.actor.openId} : {state: 'missing' as const}),
    submit: vi.fn(async (draft: FeedbackDraft, check?: () => Promise<void>) => {await check?.(); sent.add(draft.operationId);}),
    recordLink: async () => 'https://my.feishu.cn/record/TestLink',
  } satisfies FeedbackGateway;
  const review = vi.fn(async () => 'om_review'), reply = vi.fn(async (_actor: FeedbackActor, _text: string) => {}), close = vi.fn(async () => {});
  const beginAuthorization = vi.fn(async () => ({verificationUrl: 'private-fixture', qrPath: 'unused', expiresAt: 1000}));
  const checkBot = vi.fn(async () => {});
  const makeHost = (operationStore = store, im: FeedbackChatIm = {reply, review, authorization: async () => {}}) => createFeedbackHost({root, bot, registration, store: operationStore, gateway, project: id => id === project.chatId ? project : undefined,
    checkBot, close, allowed: (current, openId) => isChatAllowed(cfg, current.chatId) && (!openId || isUserAllowedInProject(cfg, current, openId)), configure: async (actor, dest, binding) => {
      if (actor.openId !== 'ou_admin') throw new Error('non-admin'); configureFeedback(project, registration, dest, binding);
    }, im: () => im, authorization: {beginAuthorization, finishAuthorization: gateway.user},
    download: async () => Readable.from(['file'])});
  const host = makeHost();
  const setup = () => host.onMessage(message(command, 'ou_admin'));
  const prepare = (signal = new AbortController().signal) => host.bind(message(), project)!.prepare({summary, attachmentRefs: []}, signal, () => {});
  return {host, makeHost, setup, prepare, project, access, checkBot, store, gateway, review, reply, close, beginAuthorization};
}

it('binds explicit setup to an ordinary group binding and bot registration and exact official URL shapes', async () => {
  expect(setupDestination(command)).toEqual(destination);
  for (const text of [command.replace('my.feishu.cn', 'my.feishu.cn.example.org'), command.replace('https:', 'http:'),
    command.replace('BaseABC?', 'BaseABC/../BaseABC?'), command.replace('&view=vewX', '&table=tblOther'), command + '#extra'])
    expect(setupDestination(text)).toBeUndefined();
  const f = fixture();
  expect(f.host.enabled('oc_group')).toBe(false);
  await f.host.onMessage(message(command));
  expect(f.project.feedback).toBeUndefined();
  await f.setup();
  const first = f.project.feedback;
  expect(first).toMatchObject({destination, bindingIncarnation: f.project.bindingIncarnation, registration});
  expect(f.host.enabled('oc_group')).toBe(true);
  await f.setup();
  expect(f.project.feedback).toEqual(first);
  expect(configuredFeedback(f.project, 'different-registration')).toBeUndefined();
  const bound = f.host.bind(message(), f.project)!;
  f.project.bindingIncarnation = randomUUID();
  expect(f.host.enabled('oc_group')).toBe(false);
  await expect(bound.prepare({summary, attachmentRefs: []}, new AbortController().signal, () => {})).rejects.toThrow();
  expect(f.review).not.toHaveBeenCalled();
});

it('assigns legacy ordinary groups an incarnation only on valid setup and rejects a stale setup after rebind', async () => {
  const f = fixture();
  delete f.project.bindingIncarnation;
  const initial = feedbackBinding(f.project)!;
  expect(() => configureFeedback(f.project, '', destination, initial)).toThrow();
  expect(() => configureFeedback(f.project, registration, {...destination, tableId: 'invalid'}, initial)).toThrow();
  expect(f.project.bindingIncarnation).toBeUndefined();
  await f.setup();
  expect(f.project.bindingIncarnation).toBeTruthy();
  expect(f.host.enabled('oc_group')).toBe(true);
  f.project.bindingIncarnation = randomUUID();
  expect(() => configureFeedback(f.project, registration, destination, initial)).toThrow('绑定已变化');
  expect(f.host.enabled('oc_group')).toBe(false);
});

it('keeps feedback cards and in-flight receipt checks in their original binding', async () => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  await f.store.write({state: 'sending', draft, sentAt: Date.now()});
  f.project.bindingIncarnation = randomUUID();
  await f.setup();
  await f.host.onAction(action(draft));
  expect(f.gateway.lookup).not.toHaveBeenCalled();
  expect(f.gateway.submit).not.toHaveBeenCalled();
  expect((await f.prepare()).operationId).not.toBe(operationId);
});

it('routes only the feedback command to private authorization with matching raw sender', async () => {
  const f = fixture();
  expect(await f.host.onMessage(message('/unrelated', 'ou_member', 'p2p'))).toBe(false);
  await f.host.onMessage(message('/feedback authorize'));
  expect(f.beginAuthorization).not.toHaveBeenCalled();
  await f.host.onMessage({...message('/feedback authorize', 'ou_member', 'p2p'), senderId: 'ou_forged'});
  expect(f.beginAuthorization).not.toHaveBeenCalled();
  await f.host.onMessage(message('/feedback authorize', 'ou_member', 'p2p'));
  expect(f.beginAuthorization).toHaveBeenCalledWith(expect.objectContaining({chatId: 'oc_private', openId: 'ou_member'}));
});

it('serializes two preparations, invalidates the first, and after restart accepts only the same actor and destination', async () => {
  const f = fixture();
  await f.setup();
  const [a, b] = await Promise.all([f.prepare(), f.prepare()]);
  const older = await f.store.read(a.operationId);
  const current = await f.store.read(b.operationId);
  expect(older.state).toBe('cancelled');
  expect(current.state).toBe('prepared');
  expect(f.gateway.submit).not.toHaveBeenCalled();
  const restarted = f.makeHost();
  await restarted.onAction(action(older.draft));
  await restarted.onAction(action(current.draft, 'ou_other'));
  const copied = action(current.draft);
  copied.messageId = 'om_other_card';
  copied.raw = {operator: {open_id: 'ou_member', tenant_key: 'org'}, context: {open_chat_id: 'oc_group', open_message_id: copied.messageId}};
  await restarted.onAction(copied);
  expect(f.gateway.submit).not.toHaveBeenCalled();
  await restarted.onAction(action(current.draft));
  await restarted.onAction(action(current.draft));
  expect(f.gateway.submit).toHaveBeenCalledTimes(1);
  expect((await f.store.read(b.operationId)).state).toEqual('submitted');
});

it.each(['disable', 'destination', 'binding', 'registration'] as const)('rejects a previously issued review after %s changes', async changed => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  if (changed === 'disable') f.project.enabled = false;
  if (changed === 'destination') configureFeedback(f.project, registration, {...destination, shareToken: 'shrTwo'}, feedbackBinding(f.project)!);
  if (changed === 'binding') f.project.bindingIncarnation = randomUUID();
  if (changed === 'registration') f.checkBot.mockRejectedValue(new Error('removed'));
  await f.host.onAction(action(draft));
  expect(f.gateway.submit).not.toHaveBeenCalled();
});

it('cancels the staged operation when the source is revoked before review delivery', async () => {
  const f = fixture();
  await f.setup();
  const stop = new AbortController();
  f.gateway.validate.mockImplementationOnce(async () => {stop.abort();});
  const create = vi.spyOn(f.store, 'create');
  await expect(f.prepare(stop.signal)).rejects.toThrow();
  expect(f.review).not.toHaveBeenCalled();
  expect((await f.store.read(create.mock.calls[0]![0].draft.operationId)).state).toBe('cancelled');
});

it('keeps an uncertain submission query-only even when a new summary is requested', async () => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  f.gateway.submit.mockRejectedValue(new Error('timeout'));
  await f.host.onAction(action(draft));
  await expect(f.prepare()).rejects.toThrow(/回执/);
  await f.host.onAction(action(draft));
  expect(f.gateway.submit).toHaveBeenCalledTimes(1);
  expect((await f.store.read(operationId)).state).toBe('uncertain');
});

it('closes its CLI once and waits for pending preparation to cancel before returning', async () => {
  const f = fixture();
  await f.setup();
  let release!: () => void;
  f.gateway.validate.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve;}));
  const prepare = f.prepare().catch(error => error);
  await vi.waitFor(() => expect(release).toBeDefined());
  const closing = f.host.close();
  expect(f.host.enabled('oc_group')).toBe(false);
  expect(f.host.close()).toBe(closing);
  release();
  await closing;
  expect(await prepare).toBeInstanceOf(Error);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.review).not.toHaveBeenCalled();
});

it('releases an operation rejected after persisting sending without dispatching a feedback record', async () => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  const write = f.store.write.bind(f.store);
  vi.spyOn(f.store, 'write').mockImplementation(async operation => {
    await write(operation);
    if (operation.state === 'sending') configureFeedback(f.project, registration, {...destination, shareToken: 'shrTwo'}, feedbackBinding(f.project)!);
  });
  await f.host.onAction(action(draft));
  expect(f.gateway.submit).not.toHaveBeenCalled();
  expect((await f.store.read(operationId)).state).toBe('not-submitted');
  expect(f.reply).toHaveBeenLastCalledWith(expect.anything(), expect.stringContaining('反馈记录尚未发出'));
  const next = await f.makeHost().bind(message(), f.project)!.prepare({summary, attachmentRefs: []}, new AbortController().signal, () => {});
  expect(next.operationId).not.toBe(operationId);
});

it.each(['destination', 'disabled'] as const)('reconciles an original uncertain card after %s changes and restart without another write', async changed => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  f.gateway.submit.mockRejectedValue(new Error('response lost after form start'));
  await f.host.onAction(action(draft));
  if (changed === 'destination') configureFeedback(f.project, registration, {...destination, baseToken: 'BaseTwo', tableId: 'tblTwo', shareToken: 'shrTwo'}, feedbackBinding(f.project)!);
  if (changed === 'disabled') f.project.enabled = false;
  const restarted = f.makeHost(new FileFeedbackStore(join(root, 'operations')));
  const calls = f.gateway.lookup.mock.calls.length;
  await restarted.onAction(action(draft));
  expect(f.gateway.lookup.mock.calls.length).toBe(calls + 1);
  expect(f.gateway.lookup).toHaveBeenLastCalledWith(expect.objectContaining({destination}));
  expect((await f.store.read(operationId)).state).toBe('uncertain');
  f.project.enabled = true;
  configureFeedback(f.project, registration, {...destination, shareToken: 'shrNew'}, feedbackBinding(f.project)!);
  await expect(restarted.bind(message(), f.project)!.prepare({summary, attachmentRefs: []}, new AbortController().signal, () => {})).rejects.toThrow(/回执/);
  const beforeWrongEvents = f.gateway.lookup.mock.calls.length;
  await restarted.onAction(action(draft, 'ou_other'));
  const wrongChat = action(draft);
  wrongChat.chatId = 'oc_other';
  wrongChat.raw = {operator: {open_id: 'ou_member', tenant_key: 'org'}, context: {open_chat_id: 'oc_other', open_message_id: 'om_review'}};
  await restarted.onAction(wrongChat);
  const copied = action(draft);
  copied.messageId = 'om_copied';
  copied.raw = {operator: {open_id: 'ou_member', tenant_key: 'org'}, context: {open_chat_id: 'oc_group', open_message_id: copied.messageId}};
  await restarted.onAction(copied);
  f.checkBot.mockRejectedValueOnce(new Error('registration changed'));
  await restarted.onAction(action(draft));
  expect(f.gateway.lookup.mock.calls.length).toBe(beforeWrongEvents);
  f.gateway.lookup.mockImplementation(async input => ({state: 'found', recordId: 'recLater', creatorOpenId: input.actor.openId}));
  await restarted.onAction(action(draft));
  expect((await f.store.read(operationId)).state).toBe('submitted');
  expect(f.gateway.submit).toHaveBeenCalledTimes(1);
  const next = await restarted.bind(message(), f.project)!.prepare({summary, attachmentRefs: []}, new AbortController().signal, () => {});
  expect(next.operationId).not.toBe(operationId);
});

it('reconciles a persisted sending operation against its original destination after restart', async () => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  await f.store.write({state: 'sending', draft, sentAt: Date.now()});
  configureFeedback(f.project, registration, {...destination, shareToken: 'shrTwo'}, feedbackBinding(f.project)!);
  const restarted = f.makeHost(new FileFeedbackStore(join(root, 'operations')));
  await restarted.onAction(action(draft));
  expect((await f.store.read(operationId)).state).toBe('uncertain');
  expect(f.gateway.lookup).toHaveBeenLastCalledWith(expect.objectContaining({destination}));
  expect(f.gateway.submit).not.toHaveBeenCalled();
  f.gateway.lookup.mockImplementation(async input => ({state: 'found', recordId: 'recRecovered', creatorOpenId: input.actor.openId}));
  await restarted.onAction(action(draft));
  expect((await f.store.read(operationId)).state).toBe('submitted');
  expect(f.gateway.submit).not.toHaveBeenCalled();
});

it.each(['allowedChats', 'allowedUsers', 'missingProject'] as const)('denies historical callbacks after %s revocation without releasing an uncertain operation', async policy => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  f.gateway.submit.mockRejectedValue(new Error('response lost after form start'));
  await f.host.onAction(action(draft));
  const calls = f.gateway.lookup.mock.calls.length;
  f.reply.mockClear();
  if (policy === 'allowedChats') f.access.allowedChats = ['oc_other'];
  else if (policy === 'allowedUsers') f.project.allowedUsers = ['ou_other'];
  else f.project.chatId = 'oc_other';
  f.gateway.lookup.mockImplementation(async input => ({state: 'found', recordId: 'recLater', creatorOpenId: input.actor.openId}));
  await f.makeHost().onAction(action(draft));
  expect(f.gateway.lookup.mock.calls.length).toBe(calls);
  expect(f.reply.mock.calls.some(([, text]) => text.includes('https://'))).toBe(false);
  expect((await f.store.read(operationId)).state).toBe('uncertain');
  f.access.allowedChats = [];
  f.project.allowedUsers = [];
  f.project.chatId = 'oc_group';
  await expect(f.prepare()).rejects.toThrow(/回执/);
  await f.host.onAction(action(draft));
  expect((await f.store.read(operationId)).state).toBe('submitted');
  expect(f.gateway.submit).toHaveBeenCalledTimes(1);
});

it.each(['allowedChats', 'allowedUsers'] as const)('withholds a cached submitted receipt after %s revocation', async policy => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  await f.host.onAction(action(draft));
  expect((await f.store.read(operationId)).state).toBe('submitted');
  const calls = f.gateway.lookup.mock.calls.length;
  f.reply.mockClear();
  if (policy === 'allowedChats') f.access.allowedChats = ['oc_other'];
  else f.project.allowedUsers = ['ou_other'];
  await f.makeHost().onAction(action(draft));
  expect(f.gateway.lookup.mock.calls.length).toBe(calls);
  expect(f.reply.mock.calls.some(([, text]) => text.includes('https://'))).toBe(false);
});

it.each(['allowedChats', 'allowedUsers'] as const)('withholds the receipt when %s is revoked while lookup is pending', async policy => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  f.gateway.submit.mockRejectedValue(new Error('response lost after form start'));
  await f.host.onAction(action(draft));
  f.reply.mockClear();
  f.gateway.lookup.mockImplementation(async input => {
    if (policy === 'allowedChats') f.access.allowedChats = ['oc_other'];
    else f.project.allowedUsers = ['ou_other'];
    return {state: 'found', recordId: 'recLater', creatorOpenId: input.actor.openId};
  });
  await f.host.onAction(action(draft));
  expect(f.reply.mock.calls.some(([, text]) => text.includes('https://'))).toBe(false);
  expect(f.gateway.submit).toHaveBeenCalledTimes(1);
});

it.each(['submitted', 'uncertain'].flatMap(state => ['allowedChats', 'allowedUsers', 'lifetime', 'registration', 'retained'].map(policy => ({state, policy}))))(
  'checks $policy at native reply dispatch for a $state historical receipt', async ({state, policy}) => {
    const f = fixture();
    await f.setup();
    const {operationId} = await f.prepare();
    const {draft} = await f.store.read(operationId);
    if (state === 'uncertain') f.gateway.submit.mockRejectedValue(new Error('response lost after form start'));
    await f.host.onAction(action(draft));
    expect((await f.store.read(operationId)).state).toBe(state);
    configureFeedback(f.project, registration, {...destination, baseToken: 'BaseTwo', tableId: 'tblTwo', shareToken: 'shrTwo'}, feedbackBinding(f.project)!);
    f.gateway.lookup.mockImplementation(async input => ({state: 'found', recordId: 'recLater', creatorOpenId: input.actor.openId}));
    let release = () => {};
    const gate = new Promise<void>(resolve => {release = resolve;});
    let entered = () => {};
    const querying = new Promise<void>(resolve => {entered = resolve;});
    let firstGet = true;
    const reply = vi.fn(async (_request: Parameters<FeedbackImClient['im']['v1']['message']['reply']>[0]) =>
      ({code: 0, data: {message_id: 'om_receipt', chat_id: draft.actor.chatId}}));
    const client: FeedbackImClient = {
      im: {v1: {message: {
        get: async request => {
          if (firstGet) {firstGet = false; entered(); await gate;}
          return {code: 0, data: {items: [{message_id: request?.path.message_id, chat_id: draft.actor.chatId}]}};
        }, reply,
      }, image: {create: async () => {throw new Error('Unexpected image upload');}}}},
      cardkit: {v1: {card: {create: async () => {throw new Error('Unexpected card creation');}}}},
    };
    const native = new NativeFeedbackIm({client, bot, privateRecipient: async () => undefined});
    const restarted = f.makeHost(new FileFeedbackStore(join(root, 'operations')), native);
    const pending = restarted.onAction(action(draft));
    let closing: Promise<void> | undefined;
    try {
      await querying;
      if (policy === 'allowedChats') f.access.allowedChats = ['oc_other'];
      if (policy === 'allowedUsers') f.project.allowedUsers = ['ou_other'];
      if (policy === 'lifetime') closing = restarted.close();
      if (policy === 'registration') f.checkBot.mockRejectedValue(new Error('registration changed'));
    } finally {release();}
    await pending;
    await closing;
    const receipts = reply.mock.calls.filter(([request]) => request?.data.content.includes('https://my.feishu.cn/record/'));
    expect(receipts).toHaveLength(policy === 'retained' ? 1 : 0);
    if (policy === 'retained') expect(receipts[0]?.[0]?.path.message_id).toBe('om_review');
    if (state === 'uncertain') expect(f.gateway.lookup).toHaveBeenLastCalledWith(expect.objectContaining({destination}));
    expect((await f.store.read(operationId)).state).toBe('submitted');
    expect(f.gateway.submit).toHaveBeenCalledTimes(1);
  },
);
