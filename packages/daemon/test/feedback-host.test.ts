import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import type {CardActionEvent, NormalizedMessage} from '@larksuiteoapi/node-sdk';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {configuredFeedback, configureFeedback, setupDestination} from '../src/feedback/config';
import {FEEDBACK_ACTION} from '../src/feedback/events';
import {createFeedbackHost} from '../src/feedback/host';
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
  return {name: 'group', chatId: 'oc_group', bindingIncarnation, blank: true, createdAt: 1, cwd: root,
    richRecipe: {bindingIncarnation, pointer: {format: 'recipe-generation-1', installationId: randomUUID(),
      generationId: randomUUID(), selection: 'effective', rootIdentity: 'root', resolvedSha256: 'a'.repeat(64),
      release: {format: 'rich-v2', recipeId: randomUUID(), versionId: randomUUID(), authorId: randomUUID(), revision: 1, access: 'direct', contentSha256: 'b'.repeat(64), logicalBytes: 1}},
      choices: {}, sources: {}, setup: {}, resolved: [], receipt: 'receipt', installedAt: 1}};
}
function fixture() {
  const project = projectRow();
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
  const review = vi.fn(async () => 'om_review'), reply = vi.fn(async () => {}), close = vi.fn(async () => {});
  const beginAuthorization = vi.fn(async () => ({verificationUrl: 'private-fixture', qrPath: 'unused', expiresAt: 1000}));
  const checkBot = vi.fn(async () => {});
  const makeHost = () => createFeedbackHost({root, bot, registration, store, gateway, project: id => id === project.chatId ? project : undefined,
    checkBot, close, allowed: () => true, configure: async (actor, dest) => {
      if (actor.openId !== 'ou_admin') throw new Error('non-admin'); configureFeedback(project, registration, dest);
    }, im: () => ({reply, review, authorization: async () => {}}), authorization: {beginAuthorization, finishAuthorization: gateway.user},
    download: async () => Readable.from(['file'])});
  const host = makeHost();
  const setup = () => host.onMessage(message(command, 'ou_admin'));
  const prepare = (signal = new AbortController().signal) => host.bind(message(), project)!.prepare({summary, attachmentRefs: []}, signal, () => {});
  return {host, makeHost, setup, prepare, project, checkBot, store, gateway, review, reply, close, beginAuthorization};
}

it('binds explicit setup to the current registered installation and exact official URL shapes', async () => {
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
  expect(first?.destination).toEqual(destination);
  await f.setup();
  expect(f.project.feedback).toEqual(first);
  expect(configuredFeedback(f.project, 'different-registration')).toBeUndefined();
  const bound = f.host.bind(message(), f.project)!;
  f.project.bindingIncarnation = randomUUID();
  expect(f.host.enabled('oc_group')).toBe(false);
  await expect(bound.prepare({summary, attachmentRefs: []}, new AbortController().signal, () => {})).rejects.toThrow();
  expect(f.review).not.toHaveBeenCalled();
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

it.each(['disable', 'destination', 'installation', 'registration'] as const)('rejects a previously issued review after %s changes', async changed => {
  const f = fixture();
  await f.setup();
  const {operationId} = await f.prepare();
  const {draft} = await f.store.read(operationId);
  if (changed === 'disable') f.project.enabled = false;
  if (changed === 'destination') configureFeedback(f.project, registration, {...destination, shareToken: 'shrTwo'});
  if (changed === 'installation') f.project.richRecipe!.pointer = {...f.project.richRecipe!.pointer, generationId: randomUUID()};
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
