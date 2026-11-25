import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AgentRun, AskRequest } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { AskCoordinator } from '../src/bot/ask-coordinator';
import { createIdlePause } from '../src/bot/watchdog';
import { log } from '../src/core/logger';
import { CodexRequestScope, userInputRequest, type InboundQuestion } from '../src/agent/codex-appserver/server-requests';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ask(id: string, kind: 'confirmation' | 'permission' = 'confirmation'): AskRequest {
  const common = { id, title: '决定', detail: '继续吗', acceptedConsequence: '继续', declinedConsequence: '停止' };
  return kind === 'permission' ? { ...common, kind, permissionMode: 'full' } : { ...common, kind };
}
function choices(id = 'choices'): Extract<AskRequest, { kind: 'choices' }> {
  return { id, kind: 'choices', title: '选择', acceptedConsequence: '继续', declinedConsequence: '停止',
    questions: [{ id: 'q', title: '选一个', detail: '', selection: 'single', other: false, options: [{ id: 'one', label: '一', description: '' }] }] };
}
function fixture() {
  let counter = 0;
  const create = vi.fn(async (_input: unknown) => ({ data: { card_id: `card-${++counter}` } }));
  const reply = vi.fn(async (input: { data: { msg_type: string } }) => ({ data: { message_id: input.data.msg_type === 'interactive' ? `msg-${counter}` : 'mention' } }));
  const update = vi.fn(async (_input: unknown) => ({}));
  const send = vi.fn(async () => ({}));
  let dmCounter = 0;
  const messageCreate = vi.fn(async (_input: unknown) => ({ data: { message_id: `dm-${++dmCounter}` } }));
  const channel = { send, rawClient: { cardkit: { v1: { card: { create, update } } }, im: { v1: { message: { reply, create: messageCreate } } } } };
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['owner', 'admin'] } } };
  const coordinator = new AskCoordinator(channel as unknown as LarkChannel, cfg, { peek: id => `name-${id}` });
  const response = vi.fn<NonNullable<AgentRun['respondToAsk']>>(async () => {});
  const run: AgentRun = { turnId: () => 'turn', events: (async function* () {})(), respondToAsk: response };
  const pause = createIdlePause();
  const waiting = vi.fn(); const fault = vi.fn();
  const open = (sessionKey = 'session', kind: 'user' | 'bot' | 'unknown' = 'user', target = run) => coordinator.openTurn({ run: target, sessionKey,
    placement: { chatId: 'chat', replyTo: 'trigger', replyInThread: true }, initiator: { kind, openId: 'starter' }, idlePause: pause, waiting, fault });
  const submit = (id = 'a', messageId = 'msg-1', operatorOpenId = 'starter', extra: object = {}) => coordinator.submit({ messageId, chatId: 'chat', operatorOpenId,
    value: { a: 'ask_submit', requestId: id, decision: 'proceed' }, formValue: undefined, ...extra });
  const typed = (place = 'session', senderId = 'starter', text = '我的回答', chatId = 'chat', createTime = Date.now(),
    senderKind: 'user' | 'bot' | 'unknown' = 'user') => coordinator.typed({ place, senderId, text, chatId, createTime, senderKind });
  return { coordinator, channel, cfg, messageCreate, create, update, reply, send, response, run, pause, waiting, fault, open, submit, typed };
}
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
afterEach(() => { vi.useRealTimers(); });

it('sends FIFO with queued watchdog holds, native mentions, actual stamped callbacks and immutable placement', async () => {
  vi.useFakeTimers();
  const f = fixture(); const turn = f.open();
  turn.enqueue(ask('a')); turn.enqueue(ask('b'));
  expect(f.pause.held).toBe(true);
  await flush();
  expect(f.create).toHaveBeenCalledTimes(1);
  const outbound = JSON.parse((f.create.mock.calls[0]![0] as { data: { data: string } }).data.data);
  const find = (value: unknown): Record<string, unknown> | undefined => {
    if (!value || typeof value !== 'object') return;
    if ('__r' in value) return value as Record<string, unknown>;
    for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
  };
  const callback = find(outbound)!;
  expect(callback.__r).toEqual(expect.any(String));
  expect(JSON.stringify(outbound)).toContain('<at id=');
  expect(f.reply.mock.calls[0]![0]).toMatchObject({ path: { message_id: 'trigger' }, data: { reply_in_thread: true } });
  expect(f.reply.mock.calls[1]![0]).toMatchObject({ data: { msg_type: 'post', content: expect.stringContaining('"tag":"at"') } });
  expect(f.submit('a', 'msg-1', 'starter', { value: { ...callback, forged: true } })).toBe('invalid');
  expect(f.submit('a', 'msg-1', 'starter', { value: callback, formValue: { __r: 'fake' } })).toBe('invalid');
  expect(f.submit('a', 'msg-1', 'starter', { value: callback })).toBe('accepted');
  expect(f.submit()).toBe('inactive');
  expect(f.response).toHaveBeenCalledExactlyOnceWith('a', { kind: 'answered', answer: { kind: 'confirmation', decision: 'proceed' } });
  expect(f.pause.held).toBe(true);
  await flush();
  expect(f.create).toHaveBeenCalledTimes(2);
  turn.close('stopped');
  expect(f.pause.held).toBe(false);
  expect(f.response.mock.calls[1]).toEqual(['b', { kind: 'unanswered', reason: 'stopped' }]);
  expect(vi.getTimerCount()).toBe(0);
});

it('revalidates current authorization, carrier/chat/request identity, and deduplicates denials', async () => {
  const f = fixture(); const turn = f.open(); turn.enqueue(ask('a')); await flush();
  expect(f.submit('wrong')).toBe('invalid');
  expect(f.submit('a', 'fake')).toBe('inactive');
  expect(f.submit('a', 'msg-1', 'owner', { chatId: 'fake' })).toBe('foreign');
  f.cfg.preferences!.access!.admins = ['new-admin'];
  expect(f.submit('a', 'msg-1', 'admin')).toBe('denied');
  expect(f.submit('a', 'msg-1', 'admin')).toBe('denied');
  expect(f.send.mock.calls.filter(args => JSON.stringify(args).includes('仅指定成员'))).toHaveLength(1);
  expect(f.submit('a', 'msg-1', 'new-admin')).toBe('accepted');
  turn.close('turn-ended');
});

it.each(['bot', 'unknown'] as const)('never treats %s initiators as eligible humans', async kind => {
  const f = fixture(); const turn = f.open('session', kind); turn.enqueue(ask('a')); await flush();
  expect(f.submit()).toBe('denied'); expect(f.submit('a', 'msg-1', 'owner')).toBe('accepted');
  turn.close('turn-ended');
});

it('permission asks exclude the human initiator and timeout starts after delivery', async () => {
  vi.useFakeTimers(); const f = fixture(); const turn = f.open();
  turn.enqueue(ask('p', 'permission')); await flush();
  const value = { a: 'ask_submit', requestId: 'p', decision: 'deny' };
  expect(f.submit('p', 'msg-1', 'starter', { value })).toBe('denied');
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(f.response).toHaveBeenCalledExactlyOnceWith('p', { kind: 'unanswered', reason: 'timeout' });
  expect(f.pause.held).toBe(false); expect(f.submit('p', 'msg-1', 'owner', { value })).toBe('inactive');
});

it('bounds hung sends, advances FIFO, and terminalizes late success without mentions or a new timer', async () => {
  vi.useFakeTimers(); const f = fixture(); const held = deferred<{ data: { card_id: string } }>();
  f.create.mockReturnValueOnce(held.promise);
  const turn = f.open(); turn.enqueue(ask('a')); turn.enqueue(ask('b')); await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(f.response.mock.calls[0]).toEqual(['a', { kind: 'unanswered', reason: 'unavailable' }]);
  expect(f.pause.held).toBe(true);
  const labels = f.waiting.mock.calls.length;
  held.resolve({ data: { card_id: 'late' } }); await flush();
  expect(f.waiting.mock.calls.length).toBe(labels);
  expect(f.update).toHaveBeenCalled();
  expect(f.reply.mock.calls.filter(([input]) => input.data.msg_type === 'post')).toHaveLength(1);
  turn.close('turn-ended'); expect(vi.getTimerCount()).toBe(0);
});

it('shutdown claims every continuation synchronously despite hung response/edit/send and throwing callbacks', async () => {
  const f = fixture(); f.response.mockImplementation(() => new Promise(() => {}));
  f.update.mockImplementation(() => new Promise(() => {}));
  const turn = f.open(); turn.enqueue(ask('a')); turn.enqueue(ask('b')); await flush();
  f.waiting.mockImplementation(() => { throw new Error('waiting failed'); });
  f.coordinator.shutdown();
  expect(f.response.mock.calls.map(([id]) => id)).toEqual(['a', 'b']); expect(f.pause.held).toBe(false);
  expect(f.submit()).toBe('inactive');
});

it('observes sync/async response faults without stopping a newer generation of the same goal run', async () => {
  const f = fixture(); const delivery = deferred<void>(); f.response.mockReturnValueOnce(delivery.promise);
  const first = f.open(); first.enqueue(ask('a')); await flush(); expect(f.submit()).toBe('accepted');
  const second = f.open(); second.enqueue(ask('b')); await flush();
  delivery.reject(new Error('old delivery')); await flush(); expect(f.fault).not.toHaveBeenCalled();
  f.response.mockImplementationOnce(() => { throw new Error('sync'); });
  second.close('turn-ended'); await flush(); expect(f.fault).not.toHaveBeenCalled(); expect(f.pause.held).toBe(false);
});

it('faults missing ports and repeated IDs across goal generations without sending an unanswerable card', async () => {
  const f = fixture(); const missing: AgentRun = { turnId: () => 't', events: (async function* () {})() };
  f.open('missing', 'user', missing).enqueue(ask('x')); expect(f.fault).toHaveBeenCalledOnce();
  const first = f.open(); first.enqueue(ask('a')); await flush(); first.close('turn-ended');
  const second = f.open(); second.enqueue(ask('a')); expect(f.fault).toHaveBeenCalledTimes(2);
  expect(f.create).toHaveBeenCalledOnce(); expect(f.pause.held).toBe(false); second.close('turn-ended');
});

it('isolates sessions and rejects comment requests immediately without presentation or holds', async () => {
  const f = fixture(); const one = f.open('one'); const two = f.open('two');
  one.enqueue(ask('a')); two.enqueue(ask('b')); await flush(); expect(f.create).toHaveBeenCalledTimes(2);
  f.coordinator.unavailable(f.run, ask('comment'), f.fault);
  expect(f.response).toHaveBeenCalledWith('comment', { kind: 'unanswered', reason: 'unavailable' });
  expect(f.create).toHaveBeenCalledTimes(2); f.coordinator.shutdown(); expect(f.pause.held).toBe(false);
});

it('empty choices show deduplicated feedback and remain answerable', async () => {
  const f = fixture(); const turn = f.open();
  turn.enqueue({ id: 'choices', kind: 'choices', title: '选择', acceptedConsequence: '继续', declinedConsequence: '停止', questions: [{ id: 'q', title: '选一个', detail: '', selection: 'single', other: false, options: [{ id: 'one', label: '一', description: '' }] }] });
  await flush();
  const value = { a: 'ask_submit', requestId: 'choices', decision: 'submit', __r: 'managed' };
  expect(f.submit('choices', 'msg-1', 'starter', { value })).toBe('invalid');
  expect(f.submit('choices', 'msg-1', 'starter', { value })).toBe('invalid');
  expect(f.send).toHaveBeenCalledExactlyOnceWith('chat', { markdown: '至少选一项' }, { replyTo: 'msg-1', replyInThread: true });
  expect(f.pause.held).toBe(true); expect(f.response).not.toHaveBeenCalled();
  expect(f.submit('choices', 'msg-1', 'starter', { value, formValue: { q0: 'one' } })).toBe('accepted');
  expect(f.pause.held).toBe(false); turn.close('turn-ended');
});

it('a throwing fault callback cannot strand sibling continuations or holds', async () => {
  const f = fixture(); f.fault.mockImplementation(() => { throw new Error('fault failed'); });
  const turn = f.open(); turn.enqueue(ask('a')); turn.enqueue(ask('b'));
  turn.enqueue(ask('a'));
  expect(f.response.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
  expect(f.pause.held).toBe(false); expect(f.fault).toHaveBeenCalledOnce(); await flush();
});

it('send rejection releases and advances independently of response rejection and failed terminal edits', async () => {
  const f = fixture(); f.create.mockRejectedValueOnce(new Error('send failed'));
  const turn = f.open(); turn.enqueue(ask('a')); turn.enqueue(ask('b')); await flush();
  expect(f.response.mock.calls[0]).toEqual(['a', { kind: 'unanswered', reason: 'unavailable' }]);
  expect(f.create).toHaveBeenCalledTimes(2); expect(f.pause.held).toBe(true);
  f.update.mockRejectedValue(new Error('edit failed'));
  f.response.mockRejectedValueOnce(new Error('delivery failed'));
  expect(f.submit('b', 'msg-1')).toBe('accepted'); await flush();
  expect(f.fault).toHaveBeenCalledOnce(); expect(f.pause.held).toBe(false); expect(f.submit('b', 'msg-1')).toBe('inactive');
});

it('a synchronous click wins a same-tick timeout and stop exactly once', async () => {
  vi.useFakeTimers(); const f = fixture(); const turn = f.open(); turn.enqueue(ask('a')); await flush();
  await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
  expect(f.submit()).toBe('accepted'); turn.close('stopped'); await vi.advanceTimersByTimeAsync(1);
  expect(f.response).toHaveBeenCalledOnce(); expect(f.pause.held).toBe(false);
});


it('provider cancellation removes only the matching visible or queued card without answering twice', async () => {
  vi.useFakeTimers();
  const f = fixture(); const turn = f.open();
  turn.enqueue(ask('a')); turn.enqueue(ask('b')); turn.enqueue(ask('c')); await flush();
  turn.cancel('b');
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.pause.held).toBe(true);
  turn.cancel('a');
  expect(f.submit()).toBe('inactive');
  expect(f.response).not.toHaveBeenCalled();
  await flush();
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.update).toHaveBeenCalled();
  turn.cancel('c'); turn.cancel('a');
  expect(f.pause.held).toBe(false);
  expect(f.response).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  turn.close('turn-ended');
});

it('cancels sending cards and terminalizes late delivery without affecting a later turn', async () => {
  vi.useFakeTimers(); const f = fixture(); const held = deferred<{ data: { card_id: string } }>();
  f.create.mockReturnValueOnce(held.promise);
  const first = f.open(); first.enqueue(ask('old')); await flush();
  first.cancel('old');
  expect(f.pause.held).toBe(false);
  const second = f.open(); second.enqueue(ask('new')); await flush();
  first.cancel('new'); first.cancel('old');
  expect(f.pause.held).toBe(true);
  held.resolve({ data: { card_id: 'late-cancelled' } }); await flush();
  expect(f.response).not.toHaveBeenCalled();
  expect(f.update).toHaveBeenCalled();
  second.cancel('new');
  expect(f.pause.held).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.reply.mock.calls.filter(([input]) => input.data.msg_type === 'post')).toHaveLength(1);
});

it('claims visible choices typed by the initiator, updates the card and advances FIFO', async () => {
  const f = fixture(); const turn = f.open();
  turn.enqueue(choices('first')); turn.enqueue(choices('second')); await flush();
  expect(f.typed()).toBe('answered');
  expect(f.response).toHaveBeenCalledExactlyOnceWith('first', { kind: 'answered', answer: { kind: 'text', text: '我的回答' } });
  expect(f.pause.held).toBe(true);
  await flush();
  expect(f.create).toHaveBeenCalledTimes(2);
  const edits = JSON.stringify(f.update.mock.calls);
  expect(edits).toContain('name-starter');
  expect(edits).toContain('我的回答');
  turn.close('turn-ended'); expect(f.pause.held).toBe(false);
});

it('accepts a current admin but rejects wrong identity, location, sender kind, and non-choice cards', async () => {
  const f = fixture(); const turn = f.open(); turn.enqueue(choices()); await flush();
  expect(f.typed('other')).toBe('none');
  expect(f.typed('session', 'starter', 'x', 'other-chat')).toBe('none');
  expect(f.typed('session', 'guest')).toBe('none');
  expect(f.typed('session', 'starter', 'x', 'chat', Date.now(), 'bot')).toBe('none');
  expect(f.typed('session', 'starter', 'x', 'chat', Date.now(), 'unknown')).toBe('none');
  expect(f.response).not.toHaveBeenCalled();
  expect(f.typed('session', 'admin')).toBe('answered');
  expect(f.response).toHaveBeenCalledOnce();
  turn.close('turn-ended');
  for (const kind of ['confirmation', 'permission'] as const) {
    const g = fixture(); const t = g.open(); t.enqueue(ask('a', kind)); await flush();
    expect(g.typed()).toBe('none');
    expect(g.typed('session', 'admin')).toBe('none');
    expect(g.response).not.toHaveBeenCalled();
    expect(g.update).not.toHaveBeenCalled();
    t.close('turn-ended');
  }
});

it('requires a visible card and a message timestamp no earlier than its visibility', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00.000Z'));
  const f = fixture(); const held = deferred<{ data: { card_id: string } }>();
  f.create.mockReturnValueOnce(held.promise);
  const turn = f.open(); turn.enqueue(choices()); await flush();
  expect(f.typed()).toBe('none');
  held.resolve({ data: { card_id: 'card-1' } }); await flush();
  const shownAt = Date.now();
  expect(f.coordinator.typed({ place: 'session', chatId: 'chat', senderId: 'starter', senderKind: 'user', text: 'x' })).toBe('none');
  expect(f.typed('session', 'starter', 'x', 'chat', shownAt - 1)).toBe('none');
  expect(f.typed('session', 'starter', 'x', 'chat', shownAt)).toBe('answered');
  expect(f.typed()).toBe('none');
  expect(f.response).toHaveBeenCalledOnce();
  turn.close('turn-ended');
});

it('ignores blank text and truncates longer answers to 4000 characters', async () => {
  const f = fixture(); const turn = f.open(); turn.enqueue(choices()); await flush();
  expect(f.typed('session', 'starter', ' \n ')).toBe('none');
  expect(f.response).not.toHaveBeenCalled();
  expect(f.typed('session', 'starter', `  ${'x'.repeat(4001)}  `)).toBe('answered');
  expect(f.response.mock.calls[0]![1]).toEqual({ kind: 'answered', answer: { kind: 'text', text: 'x'.repeat(4000) } });
  turn.close('turn-ended');
});

it('logs only answer length and request kind', async () => {
  const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  try {
    const f = fixture(); const turn = f.open(); turn.enqueue(choices()); await flush();
    expect(f.typed('session', 'starter', '私密回答')).toBe('answered');
    expect(info).toHaveBeenCalledWith('card', 'ask-typed', { len: 4, kind: 'choices' });
    expect(JSON.stringify(info.mock.calls.filter(([, event]) => event === 'ask-typed'))).not.toContain('私密回答');
    turn.close('turn-ended');
  } finally { info.mockRestore(); }
});

it('lets the first synchronous claim win against clicks, timeout, stop and replacement turns', async () => {
  vi.useFakeTimers();
  const f = fixture(); const first = f.open(); first.enqueue(choices()); await flush();
  await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
  expect(f.typed()).toBe('answered');
  first.close('stopped'); await vi.advanceTimersByTimeAsync(1);
  expect(f.response).toHaveBeenCalledOnce(); expect(f.pause.held).toBe(false);
  const second = f.open(); second.enqueue(ask('confirm')); await flush();
  expect(f.typed()).toBe('none');
  second.close('turn-ended');
  const third = f.open(); third.enqueue(choices('click')); await flush();
  expect(f.submit('click', 'msg-3', 'starter', { value: { a: 'ask_submit', requestId: 'click', decision: 'submit', __r: 'managed' }, formValue: { q0: 'one' } })).toBe('accepted');
  expect(f.typed()).toBe('none');
  expect(f.response).toHaveBeenCalledTimes(3);
  third.close('turn-ended');
});


it('keeps sensitive text questions pending without responding or editing', async () => {
  const f = fixture(); const turn = f.open();
  turn.enqueue({ ...choices(), questions: [{ id: 'q', title: 'Secret', detail: '', selection: 'text', sensitive: true }] });
  await flush(); expect(f.typed()).toBe('sensitive');
  expect(f.response).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
  expect(f.pause.held).toBe(true); turn.close('turn-ended');
});

it('observes a rejected typed response and faults the current turn', async () => {
  const f = fixture(); const turn = f.open(); const error = new Error('typed response failed');
  turn.enqueue(choices()); await flush();
  const unhandled = vi.fn(); process.on('unhandledRejection', unhandled);
  try {
    f.response.mockRejectedValueOnce(error);
    expect(f.typed()).toBe('answered'); await flush();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.fault).toHaveBeenCalledExactlyOnceWith(error);
    expect(unhandled).not.toHaveBeenCalled(); expect(f.pause.held).toBe(false);
  } finally { process.off('unhandledRejection', unhandled); turn.close('turn-ended'); }
});

it('records only the millisecond delta when the visibility time gate rejects input', async () => {
  vi.useFakeTimers(); const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  const f = fixture(); const turn = f.open();
  try {
    turn.enqueue(choices()); await flush();
    expect(f.typed('session', 'starter', 'private answer', 'chat', Date.now() - 12)).toBe('none');
    expect(info).toHaveBeenCalledWith('card', 'ask-typed-before-visible', { deltaMs: -12 });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private answer');
  } finally { turn.close('turn-ended'); info.mockRestore(); }
});

it('logs only question identity when Codex disallows other choices but receives free text', async () => {
  const info = vi.spyOn(log, 'info').mockImplementation(() => {});
  const scope = new CodexRequestScope('thread'); let question!: InboundQuestion;
  try {
    const wire = userInputRequest({ threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{
      id: 'provider-question', header: 'Pick', question: 'Pick one', isOther: false, isSecret: false,
      options: [{ label: 'One', description: '' }],
    }] }, 'rpc', 1, scope, value => { question = value; });
    await scope.respond(question.request.id, { kind: 'answered', answer: { kind: 'text', text: 'private answer' } });
    expect(await wire).toEqual({ result: { answers: { 'provider-question': { answers: ['private answer'] } } } });
    expect(info).toHaveBeenCalledWith('agent', 'ask-text-without-other', { questionId: 'provider-question' });
    expect(JSON.stringify(info.mock.calls)).not.toContain('private answer');
  } finally { scope.close(); info.mockRestore(); }
});

it('retires queued asks too when provider completion wins before the next promotion', async () => {
  const f = fixture(); const pending = vi.fn(() => true); f.run.askPending = pending;
  const turn = f.open(); turn.enqueue(choices('first')); turn.enqueue(choices('second')); await flush();
  pending.mockReturnValue(false);
  expect(f.typed()).toBe('none'); await flush();
  expect(f.create).toHaveBeenCalledOnce(); expect(f.response).not.toHaveBeenCalled();
  expect(f.pause.held).toBe(false); turn.close('turn-ended');
});


it('queues parent then child, keeps origin after timeout and clears the waiting child identity', async () => {
  vi.useFakeTimers(); const f = fixture(); const turn = f.open();
  turn.enqueue(ask('parent')); turn.enqueue(ask('child'), { subagentId: 's1', name: 'reviewer' });
  await flush(); expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.waiting).toHaveBeenLastCalledWith(expect.any(String), undefined);
  expect(f.submit('parent')).toBe('accepted'); await flush();
  expect(f.waiting).toHaveBeenLastCalledWith(expect.any(String), 's1');
  expect(JSON.stringify(f.create.mock.calls[1])).toContain('子 agent reviewer 问：');
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(JSON.stringify(f.update.mock.calls)).toContain('子 agent reviewer 问：');
  expect(f.waiting).toHaveBeenLastCalledWith(undefined, undefined);
  expect(f.response).toHaveBeenLastCalledWith('child', { kind: 'unanswered', reason: 'timeout' });
  turn.close('turn-ended');
});

it('finishes only parent entries without releasing child holds or showing queued parent cards', async () => {
  const f = fixture(), turn = f.open();
  turn.enqueue(ask('parent-a')); turn.enqueue(ask('parent-b')); turn.enqueue(ask('child'), { subagentId: 'C' });
  await flush(); turn.finishParent(); await flush();
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.response.mock.calls).toEqual(['parent-a', 'parent-b'].map(id => [id, { kind: 'unanswered', reason: 'turn-ended' }]));
  expect(f.pause.held).toBe(true); expect(f.waiting.mock.lastCall?.[1]).toBe('C');
  expect(f.submit('parent-a')).toBe('inactive'); expect(f.submit('child', 'msg-2')).toBe('accepted');
  expect(f.pause.held).toBe(false); turn.close('turn-ended');
});

it('rejects reused request identity across parent boundaries without answering the wrong child', async () => {
  const f = fixture(), turn = f.open(); turn.enqueue(ask('same')); await flush();
  expect(f.submit('same')).toBe('accepted'); turn.finishParent();
  turn.enqueue(ask('same'), { subagentId: 'C' }); await flush();
  expect(f.fault).toHaveBeenCalledOnce(); expect(f.response).toHaveBeenCalledTimes(1);
  expect(f.submit('same')).toBe('inactive'); expect(f.pause.held).toBe(false);
});

function sensitive(id = 'secret'): Extract<AskRequest, { kind: 'choices' }> {
  return { ...choices(id), questions: [{ id: 'secret-q', title: '密码', detail: '', selection: 'text', sensitive: true }] };
}
/** A reply to the card this person got; a fixture's first question reaches owner, admin and starter in that order. */
const DM_CARD: Record<string, string> = { owner: 'dm-1', admin: 'dm-2', starter: 'dm-3' };
function dmInput(openId = 'starter', text = '机密答案', createTime = Date.now(), quoted = DM_CARD[openId]!) {
  return { openId, text, quoted, createTime };
}
function secretSubmission(id = 'secret', text = '机密答案') {
  return { value: { a: 'ask_submit', requestId: id, decision: 'submit' }, formValue: { q0: text }, chatId: 'p2p-chat' };
}

describe('s33b sensitive DM coordination', () => {
  it('sends every eligible recipient a DM, rejects forged group/cross-recipient clicks, and hides the winning answer', async () => {
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      const f = fixture(); const turn = f.open(); turn.enqueue(sensitive()); await flush();
      expect(f.create).toHaveBeenCalledTimes(4);
      expect(f.create.mock.calls[0]).toEqual([expect.objectContaining({ data: expect.objectContaining({ data: expect.not.stringContaining('\"tag\":\"form\"') }) })]);
      expect(f.messageCreate.mock.calls).toEqual(['owner', 'admin', 'starter'].map(receive_id => [expect.objectContaining({ params: { receive_id_type: 'open_id' }, data: expect.objectContaining({ receive_id, msg_type: 'interactive' }) })]));
      expect(f.typed()).toBe('sensitive');
      expect(f.submit('secret', 'msg-1', 'starter', { ...secretSubmission(), chatId: 'chat' })).toBe('invalid');
      expect(f.submit('secret', 'msg-1', 'starter', { ...secretSubmission(), chatId: 'chat' })).toBe('invalid');
      expect(f.send).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.send.mock.calls)).toContain('私聊');
      expect(f.submit('secret', 'dm-1', 'starter', secretSubmission())).toBe('denied');
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.submit('secret', 'dm-3', 'starter', secretSubmission())).toBe('accepted'); await flush();
      expect(f.response).toHaveBeenCalledExactlyOnceWith('secret', { kind: 'answered', answer: { kind: 'choices', answers: [{ questionId: 'secret-q', text: '机密答案' }] } });
      expect(f.update).toHaveBeenCalledTimes(4);
      const edits = JSON.stringify(f.update.mock.calls);
      expect(edits).toContain('已在私聊里回答'); expect(edits).toContain('已由 name-starter 回答'); expect(edits).toContain('已提交');
      for (const calls of [f.create.mock.calls, f.update.mock.calls, f.send.mock.calls, f.messageCreate.mock.calls, f.reply.mock.calls, info.mock.calls]) expect(JSON.stringify(calls)).not.toContain('机密答案');
      expect(f.coordinator.dmText(dmInput())).toBe(false); expect(f.submit('secret', 'dm-1', 'owner', secretSubmission())).toBe('inactive');
      turn.close('turn-ended');
    } finally { info.mockRestore(); }
  });

  it('accepts only a visible, current DM and trims/truncates text without logging the answer or recipient', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    try {
      const f = fixture(); expect(f.coordinator.dmText(dmInput())).toBe(false);
      const held = deferred<{ data: { message_id: string } }>();
      f.messageCreate.mockReturnValueOnce(held.promise);
      const turn = f.open(); turn.enqueue(sensitive()); await flush();
      expect(f.coordinator.dmText(dmInput('owner', '早了', Date.now(), 'late-owner'))).toBe(false);
      await vi.advanceTimersByTimeAsync(1000); held.resolve({ data: { message_id: 'late-owner' } }); await flush();
      const replyAt = (text: string, at = Date.now()) => dmInput('owner', text, at, 'late-owner');
      expect(f.coordinator.dmText(replyAt('old', Date.now() - 1))).toBe(false);
      expect(f.coordinator.dmText({ openId: 'owner', text: 'missing timestamp', quoted: 'late-owner' })).toBe(false);
      expect(f.coordinator.dmText(replyAt(' \n '))).toBe(false);
      const answer = '机'.repeat(4001);
      expect(f.coordinator.dmText(replyAt(` ${answer} `))).toBe(true); await flush();
      expect(f.response).toHaveBeenCalledExactlyOnceWith('secret', { kind: 'answered', answer: { kind: 'text', text: '机'.repeat(4000) } });
      expect(info).toHaveBeenCalledWith('card', 'ask-dm-typed', { len: 4000 });
      for (const calls of [f.create.mock.calls, f.update.mock.calls, f.send.mock.calls, f.messageCreate.mock.calls, info.mock.calls]) expect(JSON.stringify(calls)).not.toContain(answer.slice(0, 100));
      expect(JSON.stringify(info.mock.calls.filter(([, event]) => event === 'ask-dm-typed'))).not.toContain('owner');
      turn.close('stopped'); expect(vi.getTimerCount()).toBe(0);
    } finally { info.mockRestore(); }
  });

  it('takes only a reply to the person\'s own card, whichever of several questions it is', async () => {
    const f = fixture(); const one = f.open('one'); const two = f.open('two');
    one.enqueue(sensitive('one')); two.enqueue(sensitive('two')); await flush();
    // Plain words, a reply to another message, a reply to someone else's card: none of them answers (main 必败).
    expect(f.coordinator.dmText(dmInput('admin', '普通的话', Date.now(), 'om_other'))).toBe(false);
    expect(f.coordinator.dmText(dmInput('admin', '不是我的卡', Date.now(), 'dm-1'))).toBe(false);
    expect(f.response).not.toHaveBeenCalled();
    expect(f.messageCreate.mock.calls.filter(([input]) => JSON.stringify(input).includes('个问题'))).toEqual([]);
    expect(f.coordinator.dmText(dmInput('admin', '第二题', Date.now(), 'dm-5'))).toBe(true); await flush();
    expect(f.response).toHaveBeenCalledExactlyOnceWith('two', { kind: 'answered', answer: { kind: 'text', text: '第二题' } });
    f.cfg.preferences!.access!.admins = [];
    expect(f.coordinator.dmText(dmInput('admin', '第一题', Date.now(), 'dm-2'))).toBe(false);
    expect(f.submit('one', 'dm-2', 'admin', secretSubmission('one'))).toBe('denied');
    expect(f.response).toHaveBeenCalledOnce();
    f.coordinator.shutdown(); expect(f.pause.held).toBe(false);
  });

  it('filters authorization per turn so a revoked admin can still answer their own human-initiated question', async () => {
    const f = fixture(); f.cfg.preferences!.access!.admins = ['starter'];
    const own = f.open('own'); const bot = f.open('bot', 'bot');
    own.enqueue(sensitive('own')); bot.enqueue(sensitive('bot')); await flush();
    f.cfg.preferences!.access!.admins = [];
    expect(f.coordinator.dmText(dmInput('starter', '机密答案', Date.now(), 'dm-1'))).toBe(true);
    expect(f.response).toHaveBeenCalledExactlyOnceWith('own', { kind: 'answered', answer: { kind: 'text', text: '机密答案' } });
    expect(f.coordinator.dmText(dmInput('starter', '机密答案', Date.now(), 'dm-1'))).toBe(false); f.coordinator.shutdown();
  });

  it('settles all failed deliveries and empty eligibility immediately, while partial failures remain answerable', async () => {
    vi.useFakeTimers();
    const f = fixture(); f.messageCreate.mockRejectedValue(new Error('not friends'));
    const turn = f.open(); turn.enqueue(sensitive()); await flush();
    expect(f.response).toHaveBeenCalledExactlyOnceWith('secret', { kind: 'unanswered', reason: 'unavailable' });
    expect(JSON.stringify(f.update.mock.calls)).toContain('没能私聊到'); expect(f.pause.held).toBe(false); turn.close('stopped');
    const empty = fixture(); empty.cfg.preferences!.access = {};
    const emptyTurn = empty.open('empty', 'bot'); emptyTurn.enqueue(sensitive()); await flush();
    expect(empty.messageCreate).not.toHaveBeenCalled(); expect(empty.create).toHaveBeenCalledOnce();
    expect(empty.response).toHaveBeenCalledExactlyOnceWith('secret', { kind: 'unanswered', reason: 'unavailable' });
    expect(JSON.stringify(empty.update.mock.calls)).toContain('没能私聊到'); emptyTurn.close('stopped');
    const partial = fixture(); partial.messageCreate.mockRejectedValueOnce(new Error('not friends'));
    const partialTurn = partial.open(); partialTurn.enqueue(sensitive()); await flush();
    expect(partial.response).not.toHaveBeenCalled(); expect(partial.send).not.toHaveBeenCalled();
    expect(partial.update).not.toHaveBeenCalled(); expect(partial.reply).toHaveBeenCalledTimes(2);
    expect(partial.coordinator.dmText(dmInput('admin', '机密答案', Date.now(), 'dm-1'))).toBe(true); partialTurn.close('stopped');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['answered', 'timeout', 'stopped', 'shutdown'] as const)('terminalizes every late DM after %s without restoring carriers or timers', async winner => {
    vi.useFakeTimers(); const f = fixture();
    const held = [deferred<{ data: { message_id: string } }>(), deferred<{ data: { message_id: string } }>()];
    f.messageCreate.mockReturnValueOnce(held[0]!.promise).mockReturnValueOnce(held[1]!.promise);
    const turn = f.open(); turn.enqueue(sensitive()); await flush();
    if (winner === 'answered') expect(f.coordinator.dmText(dmInput('starter', '机密答案', Date.now(), 'dm-1'))).toBe(true);
    else if (winner === 'timeout') await vi.advanceTimersByTimeAsync(15 * 60_000);
    else if (winner === 'shutdown') f.coordinator.shutdown();
    else turn.close('stopped');
    held[0]!.resolve({ data: { message_id: 'late-1' } }); held[1]!.resolve({ data: { message_id: 'late-2' } }); await flush();
    expect(f.update).toHaveBeenCalledTimes(4);
    expect(f.submit('secret', 'late-1', 'owner', secretSubmission())).toBe('inactive');
    expect(f.submit('secret', 'late-2', 'admin', secretSubmission())).toBe('inactive');
    expect(f.coordinator.dmText(dmInput('owner', '机密答案', Date.now(), 'late-1'))).toBe(false); expect(f.response).toHaveBeenCalledOnce();
    expect(f.pause.held).toBe(false); expect(vi.getTimerCount()).toBe(0); turn.close('stopped');
  });

  it('ignores individual late delivery failures after an answer has already settled the request', async () => {
    vi.useFakeTimers(); const f = fixture();
    const held = [deferred<{ data: { message_id: string } }>(), deferred<{ data: { message_id: string } }>()];
    f.messageCreate.mockReturnValueOnce(held[0]!.promise).mockReturnValueOnce(held[1]!.promise);
    const turn = f.open(); turn.enqueue(sensitive()); await flush();
    expect(f.coordinator.dmText(dmInput('starter', '机密答案', Date.now(), 'dm-1'))).toBe(true);
    held[0]!.reject(new Error('late delivery rejected')); held[1]!.reject(new Error('late delivery rejected')); await flush();
    expect(f.response).toHaveBeenCalledOnce(); expect(f.update).toHaveBeenCalledTimes(2); expect(f.fault).not.toHaveBeenCalled();
    expect(f.coordinator.dmText(dmInput('owner', '机密答案', Date.now(), 'late-1'))).toBe(false); turn.close('stopped'); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['click', 'typed', 'timeout', 'stopped', 'shutdown'] as const)('allows only %s to win a race with all other terminal paths', async winner => {
    vi.useFakeTimers(); const f = fixture(); const turn = f.open(); turn.enqueue(sensitive()); await flush();
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1);
    if (winner === 'click') expect(f.submit('secret', 'dm-3', 'starter', secretSubmission())).toBe('accepted');
    if (winner === 'typed') expect(f.coordinator.dmText(dmInput())).toBe(true);
    if (winner === 'timeout') await vi.advanceTimersByTimeAsync(1);
    if (winner === 'stopped') turn.close('stopped');
    if (winner === 'shutdown') f.coordinator.shutdown();
    expect(f.coordinator.dmText(dmInput())).toBe(false);
    expect(f.submit('secret', 'dm-3', 'starter', secretSubmission())).toBe('inactive');
    turn.close('stopped'); f.coordinator.shutdown(); await vi.advanceTimersByTimeAsync(1);
    expect(f.response).toHaveBeenCalledOnce(); expect(f.pause.held).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it('s33b rejects an expired provider DM click without recording an answer', async () => {
    const f = fixture(); const pending = vi.fn(() => true); f.run.askPending = pending;
    const turn = f.open(); turn.enqueue(sensitive()); await flush(); pending.mockReturnValue(false);
    expect(f.submit('secret', 'dm-3', 'starter', secretSubmission())).toBe('inactive'); await flush();
    expect(f.response).not.toHaveBeenCalled(); expect(JSON.stringify(f.update.mock.calls)).toContain('本轮已结束');
    expect(f.coordinator.dmText(dmInput())).toBe(false); expect(f.pause.held).toBe(false); turn.close('stopped');
  });

  it('retires an expired provider request before claiming a DM answer or promoting queued asks', async () => {
    const f = fixture(); const pending = vi.fn(() => true); f.run.askPending = pending;
    const turn = f.open(); turn.enqueue(sensitive('first')); turn.enqueue(sensitive('second')); await flush();
    pending.mockReturnValue(false);
    expect(f.coordinator.dmText(dmInput())).toBe(false); await flush();
    expect(f.response).not.toHaveBeenCalled(); expect(f.create).toHaveBeenCalledTimes(4);
    expect(f.pause.held).toBe(false); expect(f.submit('first', 'dm-3', 'starter', secretSubmission('first'))).toBe('inactive'); turn.close('stopped');
  });
});

describe('a private chat\'s own question (dm-agent 5)', () => {
  const ownTurn = (f: ReturnType<typeof fixture>) => f.coordinator.openTurn({ run: f.run, sessionKey: 'session', placement: { chatId: 'chat', replyTo: 'trigger', replyInThread: false, own: true },
    initiator: { kind: 'user', openId: 'starter' }, idlePause: f.pause, waiting: f.waiting, fault: f.fault });

  it('goes to the window it was asked in, to nobody else: no @, no other admin\'s private chat, a sensitive one with its form (main 必败)', async () => {
    const f = fixture(); const turn = ownTurn(f); turn.enqueue(sensitive()); await flush();
    expect(f.create).toHaveBeenCalledOnce(); expect(f.messageCreate).not.toHaveBeenCalled();
    expect(f.reply.mock.calls.filter(([input]) => input.data.msg_type === 'post')).toEqual([]);
    const card = JSON.stringify(f.create.mock.calls[0]);
    expect(card).toContain('form'); expect(card).not.toContain('不在群里显示'); expect(card).not.toContain('可回答');
    expect(f.waiting).toHaveBeenLastCalledWith(expect.stringContaining('name-starter'), undefined);
    expect(f.submit('secret', 'msg-1', 'starter', { ...secretSubmission(), chatId: 'chat' })).toBe('accepted');
    expect(f.response).toHaveBeenCalledExactlyOnceWith('secret', { kind: 'answered', answer: { kind: 'choices', answers: [{ questionId: 'secret-q', text: '机密答案' }] } });
    turn.close('turn-ended');
  });

  it('takes typed words as the answer, a sensitive question too: nobody else reads this window', async () => {
    const f = fixture(); const turn = ownTurn(f); turn.enqueue(sensitive()); await flush();
    expect(f.typed()).toBe('answered');
    expect(f.response).toHaveBeenCalledExactlyOnceWith('secret', { kind: 'answered', answer: { kind: 'text', text: '我的回答' } });
    turn.close('turn-ended');
  });
});


it('adopts the question carrier topic before accepting a typed answer without a run placeholder', async () => {
  const f = fixture();
  const placed = vi.fn(async () => 'question-topic');
  const turn = f.coordinator.openTurn({ run: f.run, sessionKey: 'pending:trigger',
    placement: { chatId: 'chat', replyTo: 'trigger', replyInThread: true },
    initiator: { kind: 'user', openId: 'starter' }, idlePause: f.pause,
    waiting: f.waiting, fault: f.fault, placed });
  turn.enqueue(choices());
  await flush();
  expect(placed).toHaveBeenCalledWith('msg-1');
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.typed('question-topic', 'starter', '一')).toBe('answered');
  expect(f.response).toHaveBeenCalled();
  turn.close('turn-ended');
});

it('notifies answered(messageId) on submit and typed answers so live run cards rotate below the choice card, but not on timeout or close', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const answered = vi.fn();
  const turn = f.coordinator.openTurn({
    run: f.run, sessionKey: 'session',
    placement: { chatId: 'chat', replyTo: 'trigger', replyInThread: false, own: true },
    initiator: { kind: 'user', openId: 'starter' }, idlePause: f.pause,
    waiting: f.waiting, fault: f.fault, answered,
  });

  // 1. Card button submit fires answered('msg-1')
  turn.enqueue(ask('first'));
  await flush();
  expect(f.submit('first', 'msg-1')).toBe('accepted');
  expect(answered).toHaveBeenCalledTimes(1);
  expect(answered).toHaveBeenLastCalledWith('msg-1');

  // 2. Typed reply to a choices card fires answered('msg-2')
  turn.enqueue(choices('second'));
  await flush();
  expect(f.typed('session', 'starter', '自定义回答')).toBe('answered');
  expect(answered).toHaveBeenCalledTimes(2);
  expect(answered).toHaveBeenLastCalledWith('msg-2');

  // 3. Timeout and turn close do NOT fire answered
  turn.enqueue(ask('third'));
  await flush();
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(answered).toHaveBeenCalledTimes(2);
  turn.close('turn-ended');
  expect(answered).toHaveBeenCalledTimes(2);
});
