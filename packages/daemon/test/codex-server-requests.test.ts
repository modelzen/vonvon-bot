import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServerClient } from '../src/provider/transport/jsonrpc';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import { AskCoordinator, type AskTurn } from '../src/bot/ask-coordinator';
import { createIdlePause } from '../src/bot/watchdog';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { AppConfig } from '../src/config/schema';
import type { AgentEvent, AgentRun } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

const fixture = `
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
let turn = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const ask = (id, turnId, extra = {}) => ({ id, method: 'item/tool/requestUserInput', params: {
  threadId: 'thread', turnId, itemId: 'item', questions: [{ id: 'provider-question', header: 'Pick',
    question: 'Choose a format', isOther: true, isSecret: false,
    options: [{ label: 'Original label', description: 'Description' }, { label: 'Second', description: '' }], ...extra }] } });
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (!m.method) {
    fs.appendFileSync(path.join(__dirname, 'replies'), JSON.stringify(m) + '\\n');
    return;
  }
  if (m.method === 'fixture/emit') {
    for (const frame of m.params.frames) send(frame);
  } else if (m.method === 'fixture/exit') {
    process.exit(0);
  } else if (m.method === 'thread/resume') {
    send({ id: m.id, result: { thread: { id: 'thread' } ,
      cwd: m.params.cwd, runtimeWorkspaceRoots: m.params.runtimeWorkspaceRoots,
      approvalPolicy: m.params.approvalPolicy, sandbox: { type: m.params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : undefined },
    } }); return;
  } else if (m.method === 'turn/start') {
    const id = 'turn-' + ++turn;
    const text = m.params.input[0].text;
    send(ask('ask-' + turn, id, text === 'secret' ? { isSecret: true } : {}));
    if (text === 'pre-cancel') send({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'ask-' + turn } });
    if (text === 'fail') { send({ id: m.id, error: { code: -1, message: 'refused' } }); return; }
    send({ id: m.id, result: { turn: { id } } });
    send({ method: 'turn/started', params: { threadId: 'thread', turn: { id } } });
    send({ kind: 'request', method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: id, itemId: 'a', delta: 'still consuming' } });
    if (text === 'complete' || text === 'secret' || text === 'pre-cancel') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id } } });
    if (text === 'cancel') setTimeout(() => {
      send({ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'ask-' + turn } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: id, itemId: 'a', delta: 'after cancellation' } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id } } });
    }, 40);
    if (text === 'eof') setTimeout(() => process.exit(0), 30);
    if (text.startsWith('pipe-')) {
      fs.writeFileSync(path.join(__dirname, 'eof-pid'), String(process.pid));
      fs.closeSync(0);
      fs.closeSync(1);
      if (text !== 'pipe-hang') setTimeout(() => {
        fs.writeFileSync(path.join(__dirname, 'natural-exit'), text);
        process.exit(text === 'pipe-nonzero' ? 7 : 0);
      }, 100);
    }
    return;
  } else if (m.method === 'thread/goal/set') {
    if (m.params.objective === 'unknown turn-null') send({ method: 'future/notification', params: { threadId: 'thread', turn: null } });
    if (m.params.objective === 'unknown params-null') send({ method: 'future/notification', params: null });
    if (m.params.objective === 'unknown params-absent') send({ method: 'future/notification' });
    send({ kind: 'request', method: 'turn/started', params: { threadId: 'thread', turn: { id: 'goal-turn' } } });
    if (m.params.objective === 'foreign lifecycle') send(ask('held-before-foreign', 'goal-turn'));
    send({ method: 'turn/started', params: { threadId: 'foreign', turn: { id: 'foreign-turn' } } });
    if (m.params.objective === 'foreign lifecycle') {
      send({ method: 'turn/completed', params: { threadId: 'foreign', turn: { id: 'foreign-turn' } } });
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'wrong-turn' } } });
      send({ method: 'error', params: { threadId: 'foreign', turnId: 'foreign-turn', error: { message: 'foreign fatal' }, willRetry: false } });
      send({ method: 'error', params: { threadId: 'thread', turnId: 'wrong-turn', error: { message: 'wrong turn fatal' }, willRetry: false } });
      send({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'goal-turn', itemId: 'own', delta: 'owned marker' } });
    }
    send(ask('foreign-goal', 'foreign-turn'));
    send(ask('own-goal', 'goal-turn'));
    send({ method: 'thread/goal/updated', params: { threadId: 'thread', goal: { objective: m.params.objective, status: 'complete' } } });
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'goal-turn' } } });
  } else if (m.method === 'turn/interrupt') {
    send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: m.params.turnId } } });
  }
  if (m.id !== undefined) send({ id: m.id, result: {} });
});
setInterval(() => {}, 1000);
`;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of [...cleanup.splice(0).reverse(), shutdownResidentClients, async () => vi.unstubAllEnvs()]) {
    try { await close(); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'Codex request fixture cleanup failed');
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-requests-'));
  const { bin } = writeNodeExecutable(dir, 'codex', fixture);
  cleanup.push(async () => { rmSync(dir, { recursive: true, force: true }); });
  function replies(): unknown[] {
    try { return readFileSync(join(dir, 'replies'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  }
  return { bin, dir, replies };
}
const params = {
  threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{
    id: 'original-question', header: 'Pick', question: 'Pick one', isOther: true, isSecret: false,
    options: [{ label: 'Original label', description: 'detail' }],
  }],
};
const question = (id: string | number, input: unknown = params) => ({ id, method: 'item/tool/requestUserInput', params: input });

async function clientFixture() {
  const f = setup();
  const client = new AppServerClient({ bin: f.bin, cwd: f.dir, quietOutput: true });
  cleanup.push(() => client.close(100));
  await client.connect();
  return { ...f, client, emit: (frames: unknown[]) => client.request('fixture/emit', { frames }) };
}
async function runFixture(text: string) {
  const f = setup();
  vi.stubEnv('CODEX_BIN', f.bin);
  const thread = await new CodexAppServerBackend().resumeThread({ cwd: f.dir, sessionId: 'thread' });
  cleanup.push(() => thread.close());
  const run = thread.runStreamed({ text });
  return { ...f, thread, run, iterator: run.events[Symbol.asyncIterator]() };
}
async function nextAsk(iterator: AsyncIterator<AgentEvent>) {
  const step = await iterator.next();
  if (step.done || step.value.type !== 'ask') throw new Error('Expected an ask');
  return step.value.request;
}
async function drain(iterator: AsyncIterator<AgentEvent>) {
  const events: AgentEvent[] = [];
  while (true) {
    const step = await iterator.next();
    if (step.done) return events;
    events.push(step.value);
  }
}
function answer(run: AgentRun, id: string) {
  return run.respondToAsk?.(id, { kind: 'answered', answer: {
    kind: 'choices', answers: [{ questionId: 'q0', selected: ['o0'] }],
  } });
}

function coordinatorFixture(run: AgentRun) {
  let cards = 0;
  const channel = { rawClient: {
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: `card-${++cards}` } }), update: async () => ({}) } } },
    im: { v1: { message: { reply: async () => ({ data: { message_id: `message-${cards}` } }) } } },
  } };
  const cfg: AppConfig = { accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' } } };
  const coordinator = new AskCoordinator(channel as unknown as LarkChannel, cfg, { peek: () => 'Owner' });
  cleanup.push(async () => coordinator.shutdown());
  const pause = createIdlePause();
  const open = () => coordinator.openTurn({ run, sessionKey: 'fixture', placement: { chatId: 'chat', replyTo: 'message', replyInThread: true },
    initiator: { kind: 'user', openId: 'owner' }, idlePause: pause, waiting: () => {}, fault: error => { throw error; } });
  return { coordinator, pause, open };
}

describe('Codex inbound requests over the real app-server transport', () => {
  it('uses protocol-specific negative replies with original numeric/string IDs and preserves unknown methods', async () => {
    const f = await clientFixture();
    await f.emit([
      { id: 11, method: 'item/commandExecution/requestApproval', params: {} },
      { id: 'file', method: 'item/fileChange/requestApproval', params: {} },
      { id: 12, method: 'execCommandApproval', params: {} },
      { id: 'patch', method: 'applyPatchApproval', params: {} },
      { id: 13, method: 'item/permissions/requestApproval', params: {} },
      { id: 'unknown', method: 'unimplemented', params: {} },
    ]);
    await vi.waitFor(() => expect(f.replies()).toEqual([
      { jsonrpc: '2.0', id: 11, result: { decision: 'decline' } },
      { jsonrpc: '2.0', id: 'file', result: { decision: 'decline' } },
      { jsonrpc: '2.0', id: 12, result: { decision: 'denied' } },
      { jsonrpc: '2.0', id: 'patch', result: { decision: 'denied' } },
      { jsonrpc: '2.0', id: 13, result: { permissions: {}, scope: 'turn' } },
      { jsonrpc: '2.0', id: 'unknown', error: { code: -32601, message: 'not handled' } },
    ]));
  });

  it('keeps request/notification ingress ordered and maps stable selection IDs to provider labels once', async () => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const events = f.client.events()[Symbol.asyncIterator]();
    await f.emit([{ method: 'before', params: {} }, question(77), { method: 'after', params: {} }]);
    expect((await events.next()).value).toMatchObject({ method: 'before' });
    const entry = (await events.next()).value;
    if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected request');
    expect(scope.accepts(entry, 'turn')).toBe(true);
    expect(entry.request.questions).toMatchObject([{ selection: 'single', other: true }]);
    expect((await events.next()).value).toMatchObject({ method: 'after' });
    await scope.respond(entry.request.id, { kind: 'answered', answer: { kind: 'choices', answers: [{ questionId: 'q0', selected: ['o0'] }] } });
    await scope.respond(entry.request.id);
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 77, result: { answers: { 'original-question': { answers: ['Original label'] } } } }]));
    await events.return?.();
  });

  it.each([' native question ', '__proto__'])('preserves the opaque provider question key %j and exact option label on the wire', async providerId => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const stream = f.client.events()[Symbol.asyncIterator]();
    await f.emit([question('opaque', { ...params, questions: [{ ...params.questions[0], id: providerId,
      options: [{ label: ' Original label ', description: '' }] }] })]);
    const entry = (await stream.next()).value;
    if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected request');
    await scope.respond(entry.request.id, { kind: 'answered', answer: { kind: 'choices', answers: [{ questionId: 'q0', selected: ['o0'] }] } });
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'opaque',
      result: { answers: Object.fromEntries([[providerId, { answers: [' Original label '] }]]) } }]));
    await stream.return?.();
  });

  it('keeps external notification metadata separate from internal requests in both consumers', async () => {
    const f = await clientFixture();
    const frame = { kind: 'request', method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'metadata' } };
    await f.emit([frame]);
    const utility = f.client.stream()[Symbol.asyncIterator]();
    expect((await utility.next()).value).toMatchObject(frame);
    await utility.return?.();
    await f.emit([frame]);
    const owned = f.client.events()[Symbol.asyncIterator]();
    const step = await owned.next();
    expect(step.value).toMatchObject(frame);
    await owned.return?.();
  });

  it('maps missing and empty options to text questions while rejecting malformed and foreign requests', async () => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const stream = f.client.events()[Symbol.asyncIterator]();
    const base = params.questions[0];
    await f.emit([
      question('bad', {}),
      question('null', { ...params, questions: [{ ...base, options: null }] }),
      question('empty', { ...params, questions: [{ ...base, options: [] }] }),
      question('foreign', { ...params, threadId: 'other' }),
      question('duplicate', { ...params, questions: [base, base] }),
    ]);
    for (const id of ['null', 'empty']) {
      const entry = (await stream.next()).value;
      if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected text request');
      expect(entry.rpcId).toBe(id);
      expect(scope.accepts(entry, 'turn')).toBe(true);
      expect(entry.request).toMatchObject({ title: 'Codex 需要你回答', questions: [{ selection: 'text', sensitive: false }] });
      await scope.respond(entry.request.id);
    }
    const foreign = (await stream.next()).value;
    if (!foreign || 'method' in foreign || foreign.kind !== 'request') throw new Error('Expected foreign request');
    expect(scope.accepts(foreign, 'turn')).toBe(false);
    await vi.waitFor(() => expect(f.replies()).toHaveLength(5));
    expect(f.replies().map(reply => (reply as { id: string }).id).sort()).toEqual(['bad', 'duplicate', 'empty', 'foreign', 'null']);
    for (const reply of f.replies()) expect(reply).toMatchObject({ result: { answers: {} } });
    await stream.return?.();
  });

  it.each(['text', 'choices'])('maps secret questions with options to sensitive text and returns %s answers', async kind => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const stream = f.client.events()[Symbol.asyncIterator]();
    await f.emit([question('secret', { ...params, questions: [{ ...params.questions[0], isSecret: true }] }), { method: 'after-secret', params: {} }]);
    const entry = (await stream.next()).value;
    if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected sensitive request');
    expect(entry.request).toMatchObject({ title: 'Codex 需要你回答', questions: [{ selection: 'text', sensitive: true }] });
    expect(entry.request.questions[0]).not.toHaveProperty('options');
    await scope.respond(entry.request.id, { kind: 'answered', answer: kind === 'text'
      ? { kind: 'text', text: 'private answer' }
      : { kind: 'choices', answers: [{ questionId: 'q0', text: 'private answer' }] } });
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'secret', result: { answers: {
      'original-question': { answers: ['private answer'] },
    } } }]));
    await stream.return?.();
  });

  it('returns a whole text answer to every original question', async () => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const stream = f.client.events()[Symbol.asyncIterator]();
    await f.emit([question('whole-text', { ...params, questions: [
      { ...params.questions[0], isOther: false }, { ...params.questions[0], id: 'free-form', header: 'Explain', options: null },
    ] })]);
    const entry = (await stream.next()).value;
    if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected request');
    expect(entry.request).toMatchObject({ title: 'Codex 需要你回答', questions: [
      { selection: 'single', other: false }, { selection: 'text', sensitive: false },
    ] });
    await scope.respond(entry.request.id, { kind: 'answered', answer: { kind: 'text', text: '随便写' } });
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'whole-text', result: { answers: {
      'original-question': { answers: ['随便写'] }, 'free-form': { answers: ['随便写'] },
    } } }]));
    await stream.return?.();
  });

  it('maps per-question text and selected labels, and rejects incomplete or mismatched choice answers', async () => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const stream = f.client.events()[Symbol.asyncIterator]();
    const two = { ...params, questions: [params.questions[0],
      { ...params.questions[0], id: 'free-form', header: 'Explain', options: [] }] };
    const responses = [
      { id: 'mixed', answers: [{ questionId: 'q0', selected: ['o0'] as [string] }, { questionId: 'q1', text: '手写' }] },
      { id: 'other', answers: [{ questionId: 'q0', text: '我的选项' }, { questionId: 'q1', text: '另一段' }] },
      { id: 'missing', answers: [{ questionId: 'q0', selected: ['o0'] as [string] }] },
      { id: 'extra', answers: [{ questionId: 'q0', selected: ['o0'] as [string] }, { questionId: 'q1', text: '写' }, { questionId: 'q2', text: '多余' }] },
      { id: 'wrong-option', answers: [{ questionId: 'q0', selected: ['o9'] as [string] }, { questionId: 'q1', text: '写' }] },
    ];
    for (const { id, answers } of responses) {
      await f.emit([question(id, two)]);
      const entry = (await stream.next()).value;
      if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected request');
      await scope.respond(entry.request.id, { kind: 'answered', answer: { kind: 'choices', answers: answers as [{ questionId: string; selected: [string] } | { questionId: string; text: string }, ...({ questionId: string; selected: [string] } | { questionId: string; text: string })[]] } });
    }
    await vi.waitFor(() => expect(f.replies()).toHaveLength(responses.length));
    expect(f.replies()).toEqual([
      { jsonrpc: '2.0', id: 'mixed', result: { answers: { 'original-question': { answers: ['Original label'] }, 'free-form': { answers: ['手写'] } } } },
      { jsonrpc: '2.0', id: 'other', result: { answers: { 'original-question': { answers: ['我的选项'] }, 'free-form': { answers: ['另一段'] } } } },
      ...['missing', 'extra', 'wrong-option'].map(id => ({ jsonrpc: '2.0', id, result: { answers: {} } })),
    ]);
    await stream.return?.();
  });

  it.each(['clear', 'iterator-return', 'utility', 'filtered'] as const)('releases %s requests without stranding wire replies', async kind => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    await f.emit([question('pending')]);
    if (kind === 'clear') f.client.clearNotifications();
    else if (kind === 'utility') {
      const stream = f.client.stream()[Symbol.asyncIterator]();
      await f.emit([{ method: 'marker', params: {} }]);
      expect((await stream.next()).value).toMatchObject({ method: 'marker' });
      await stream.return?.();
    } else {
      const stream = f.client.events()[Symbol.asyncIterator]();
      const entry = (await stream.next()).value;
      if (!entry || 'method' in entry || entry.kind !== 'request') throw new Error('Expected request');
      if (kind === 'filtered') expect(scope.accepts(entry, 'later-turn')).toBe(false);
      await stream.return?.();
    }
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'pending', result: { answers: {} } }]));
  });

  it('cancels only the matching original RPC ID and keeps another queued request answerable', async () => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    const stream = f.client.events()[Symbol.asyncIterator]();
    await f.emit([question('cancel-this'), question(81), { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'cancel-this' } }]);
    const old = (await stream.next()).value;
    if (!old || 'method' in old || old.kind !== 'request') throw new Error('Expected request');
    expect(scope.accepts(old, 'turn')).toBe(false);
    const current = (await stream.next()).value;
    if (!current || 'method' in current || current.kind !== 'request') throw new Error('Expected request');
    expect(scope.accepts(current, 'turn')).toBe(true);
    expect((await stream.next()).value).toMatchObject({ kind: 'request_cancelled', requestId: old.request.id });
    await scope.respond(current.request.id, { kind: 'answered', answer: { kind: 'choices', answers: [{ questionId: 'q0', selected: ['o0'] }] } });
    await f.emit([{ method: 'marker', params: {} }]);
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 81, result: { answers: { 'original-question': { answers: ['Original label'] } } } }]));
    await scope.respond(old.request.id);
    await stream.return?.();
  });

  it('releases unowned warm/utility requests immediately', async () => {
    const f = await clientFixture();
    await f.emit([question('warm')]);
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'warm', result: { answers: {} } }]));
  });
});

describe('Codex AgentRun request ownership', () => {
  it('emits a pre-ACK question, consumes later deltas, and answers with provider labels', async () => {
    const f = await runFixture('wait');
    const request = await nextAsk(f.iterator);
    const started = await f.iterator.next();
    expect(started.value).toMatchObject({ type: 'turn_started' });
    expect((await f.iterator.next()).value).toMatchObject({ type: 'text_delta', delta: 'still consuming' });
    await answer(f.run, request.id);
    await vi.waitFor(() => expect(f.replies()).toContainEqual({ jsonrpc: '2.0', id: 'ask-1', result: { answers: { 'provider-question': { answers: ['Original label'] } } } }));
    await f.iterator.return?.();
  });

  it.each(['complete', 'fail', 'secret', 'eof'])('settles or releases pending input on %s', async text => {
    const f = await runFixture(text);
    const events = await drain(f.iterator);
    if (text === 'fail') expect(events.some(e => e.type === 'ask')).toBe(false);
    if (text === 'secret') expect(events.some(e => e.type === 'ask')).toBe(true);
    if (text !== 'eof') await vi.waitFor(() => expect(f.replies()).toContainEqual({ jsonrpc: '2.0', id: 'ask-1', result: { answers: {} } }));
    // A closed peer cannot deliver, but a stale local answer remains harmless.
    const ask = events.find(e => e.type === 'ask');
    if (ask?.type === 'ask') await expect(answer(f.run, ask.request.id)).resolves.toBeUndefined();
  });

  it('stop settles once and an old answer cannot reach a later turn', async () => {
    const f = await runFixture('wait');
    const old = await nextAsk(f.iterator);
    await f.thread.abort('turn-1');
    await drain(f.iterator);
    const later = f.thread.runStreamed({ text: 'wait' });
    const iterator = later.events[Symbol.asyncIterator]();
    const current = await nextAsk(iterator);
    await answer(f.run, old.id);
    await answer(later, current.id);
    await vi.waitFor(() => expect(f.replies()).toEqual([
      { jsonrpc: '2.0', id: 'ask-1', result: { answers: {} } },
      { jsonrpc: '2.0', id: 'ask-2', result: { answers: { 'provider-question': { answers: ['Original label'] } } } },
    ]));
    await iterator.return?.();
  });
  it('a failed start releases the pre-ACK request before a subsequent turn', async () => {
    const f = await runFixture('fail');
    await drain(f.iterator);
    const later = f.thread.runStreamed({ text: 'wait' });
    const iterator = later.events[Symbol.asyncIterator]();
    const request = await nextAsk(iterator);
    await answer(later, request.id);
    await vi.waitFor(() => expect(f.replies()).toEqual([
      { jsonrpc: '2.0', id: 'ask-1', result: { answers: {} } },
      { jsonrpc: '2.0', id: 'ask-2', result: { answers: { 'provider-question': { answers: ['Original label'] } } } },
    ]));
    await iterator.return?.();
  });

  it('close releases the pending continuation and makes its later answer harmless', async () => {
    const f = await runFixture('wait');
    const request = await nextAsk(f.iterator);
    await f.thread.close();
    await expect(answer(f.run, request.id)).resolves.toBeUndefined();
    await drain(f.iterator);
  });

  it('goal asks belong to the original thread and live turn even after foreign turn notifications', async () => {
    const f = setup();
    vi.stubEnv('CODEX_BIN', f.bin);
    const thread = await new CodexAppServerBackend().resumeThread({ cwd: f.dir, sessionId: 'thread' });
    cleanup.push(() => thread.close());
    if (!thread.runGoal) throw new Error('Goal support missing');
    const run = thread.runGoal('fixture goal');
    const iterator = run.events[Symbol.asyncIterator]();
    const events = await drain(iterator);
    expect(events.filter(e => e.type === 'ask')).toHaveLength(1);
    await vi.waitFor(() => expect(f.replies()).toEqual([
      { jsonrpc: '2.0', id: 'foreign-goal', result: { answers: {} } },
      { jsonrpc: '2.0', id: 'own-goal', result: { answers: {} } },
    ]));
  });

  it('foreign goal lifecycle cannot clear an owned coordinator ask or replace the active turn', async () => {
    const f = setup();
    vi.stubEnv('CODEX_BIN', f.bin);
    const thread = await new CodexAppServerBackend().resumeThread({ cwd: f.dir, sessionId: 'thread' });
    cleanup.push(() => thread.close());
    if (!thread.runGoal) throw new Error('Goal support missing');
    const run = thread.runGoal('foreign lifecycle');
    const c = coordinatorFixture(run);
    let turn: AskTurn | undefined;
    let marker = false;
    for await (const event of run.events) {
      if (event.type === 'turn_started') { turn?.close('turn-ended'); turn = c.open(); }
      else if (event.type === 'ask') turn?.enqueue(event.request);
      else if (event.type === 'done') turn?.close('turn-ended');
      else if (event.type === 'text_delta' && event.delta === 'owned marker') {
        marker = true;
        expect(run.turnId()).toBe('goal-turn');
        expect(c.pause.held).toBe(true);
        expect(f.replies()).not.toContainEqual(expect.objectContaining({ id: 'held-before-foreign' }));
      }
      expect(event).not.toMatchObject({ type: 'error' });
      if (event.type === 'turn_started' || event.type === 'done') expect(event.turnId).toBe('goal-turn');
    }
    expect(marker).toBe(true);
    expect(c.pause.held).toBe(false);
  });

  it('server cancellation releases the actual coordinator hold without replying or ending the run', async () => {
    const f = await runFixture('cancel');
    const c = coordinatorFixture(f.run);
    const turn = c.open();
    let cancelled = false;
    let after = false;
    for await (const event of { [Symbol.asyncIterator]: () => f.iterator }) {
      if (event.type === 'ask') turn.enqueue(event.request);
      else if (event.type === 'ask_cancelled') {
        turn.cancel(event.requestId);
        cancelled = true;
        expect(c.pause.held).toBe(false);
      } else if (event.type === 'text_delta' && event.delta === 'after cancellation') after = true;
    }
    expect(cancelled).toBe(true);
    expect(after).toBe(true);
    expect(c.pause.held).toBe(false);
    expect(f.replies()).toEqual([]);
  });

  it('pre-ACK cancellation suppresses the old ask and cannot clear a later turn', async () => {
    const f = await runFixture('pre-cancel');
    const events = await drain(f.iterator);
    expect(events.some(event => event.type === 'ask')).toBe(false);
    expect(f.replies()).toEqual([]);
    const next = f.thread.runStreamed({ text: 'wait' });
    const iterator = next.events[Symbol.asyncIterator]();
    const request = await nextAsk(iterator);
    await answer(next, request.id);
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'ask-2', result: { answers: { 'provider-question': { answers: ['Original label'] } } } }]));
    await iterator.return?.();
  });

  it.each(['turn-null', 'params-null', 'params-absent'])('ignores unknown goal notifications with %s and continues the owned turn', async variant => {
    const f = setup();
    vi.stubEnv('CODEX_BIN', f.bin);
    const thread = await new CodexAppServerBackend().resumeThread({ cwd: f.dir, sessionId: 'thread' });
    cleanup.push(() => thread.close());
    if (!thread.runGoal) throw new Error('Goal support missing');
    const run = thread.runGoal(`unknown ${variant}`);
    const events = await drain(run.events[Symbol.asyncIterator]());
    expect(events.filter(event => event.type === 'turn_started' || event.type === 'done')).toEqual([
      { type: 'turn_started', turnId: 'goal-turn' }, { type: 'done', turnId: 'goal-turn' },
    ]);
    expect(events.filter(event => event.type === 'ask')).toHaveLength(1);
  });

  it('waits for a short natural exit after pipe closure with a pending ask even when explicitly closed immediately', async () => {
    const f = await runFixture('pipe-exit');
    const events = await drain(f.iterator);
    expect(events.some(event => event.type === 'ask')).toBe(true);
    await expect(f.thread.close()).resolves.toBeUndefined();
    expect(readFileSync(join(f.dir, 'natural-exit'), 'utf8')).toBe('pipe-exit');
    const pid = Number(readFileSync(join(f.dir, 'eof-pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  });

  it('preserves a natural nonzero exit after pipe closure instead of terminating it first', async () => {
    const f = await runFixture('pipe-nonzero');
    await drain(f.iterator);
    const closing = f.thread.close();
    await expect(closing).rejects.toThrow('Codex 子进程树已退出，但清理失败');
    await expect(closing).rejects.toMatchObject({ cause: { errors: expect.arrayContaining([
      expect.objectContaining({ message: 'Codex child exited with code 7' }),
    ]) } });
    expect(readFileSync(join(f.dir, 'natural-exit'), 'utf8')).toBe('pipe-nonzero');
    // The expected strict owner rejection was asserted above; remove only this already-joined cleanup.
    cleanup.pop();
  });

  it('bounds the pipe-close wait and terminates a child that remains alive', async () => {
    const f = await runFixture('pipe-hang');
    await drain(f.iterator);
    const pid = Number(readFileSync(join(f.dir, 'eof-pid'), 'utf8'));
    const closing = f.thread.close();
    expect(f.thread.close()).toBe(closing);
    await expect(closing).resolves.toBeUndefined();
    expect(existsSync(join(f.dir, 'natural-exit'))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  });

});
