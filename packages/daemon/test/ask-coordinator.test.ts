import { afterEach, expect, it, vi } from 'vitest';
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
  const channel = { send, rawClient: { cardkit: { v1: { card: { create, update } } }, im: { v1: { message: { reply } } } } };
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner', admins: ['admin'] } } };
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
  return { coordinator, channel, cfg, create, update, reply, send, response, run, pause, waiting, fault, open, submit, typed };
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
