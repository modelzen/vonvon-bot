import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppServerClient } from '../src/provider/transport/jsonrpc';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { shutdownResidentClients } from '../src/agent/codex-appserver/client-pool';
import type { AgentEvent, AgentRun } from '../src/agent/types';
import { writeNodeExecutable } from './helpers/node-executable';

const fixture = `
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
    send({ id: m.id, result: { thread: { id: 'thread' } } }); return;
  } else if (m.method === 'turn/start') {
    const id = 'turn-' + ++turn;
    const text = m.params.input[0].text;
    send(ask('ask-' + turn, id, text === 'secret' ? { isSecret: true } : {}));
    if (text === 'fail') { send({ id: m.id, error: { code: -1, message: 'refused' } }); return; }
    send({ id: m.id, result: { turn: { id } } });
    send({ method: 'turn/started', params: { threadId: 'thread', turn: { id } } });
    send({ kind: 'request', method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: id, itemId: 'a', delta: 'still consuming' } });
    if (text === 'complete' || text === 'secret') send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id } } });
    if (text === 'eof') setTimeout(() => process.exit(0), 30);
    return;
  } else if (m.method === 'thread/goal/set') {
    send({ kind: 'request', method: 'turn/started', params: { threadId: 'thread', turn: { id: 'goal-turn' } } });
    send({ method: 'turn/started', params: { threadId: 'foreign', turn: { id: 'foreign-turn' } } });
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
  for (const close of cleanup.splice(0).reverse()) await close();
  await shutdownResidentClients();
  vi.unstubAllEnvs();
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
    if (!entry || 'method' in entry) throw new Error('Expected request');
    expect(scope.accepts(entry, 'turn')).toBe(true);
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
    if (!entry || 'method' in entry) throw new Error('Expected request');
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

  it('settles malformed, secret, missing/empty options and foreign requests without producing group asks', async () => {
    const f = await clientFixture();
    f.client.openRequestScope('thread');
    const base = params.questions[0];
    await f.emit([
      question('bad', {}), question('secret', { ...params, questions: [{ ...base, isSecret: true }] }),
      question('null', { ...params, questions: [{ ...base, options: null }] }),
      question('empty', { ...params, questions: [{ ...base, options: [] }] }),
      question('foreign', { ...params, threadId: 'other' }),
      question('duplicate', { ...params, questions: [base, base] }),
    ]);
    await vi.waitFor(() => expect(f.replies()).toHaveLength(6));
    for (const reply of f.replies()) expect(reply).toMatchObject({ result: { answers: {} } });
  });

  it.each(['clear', 'iterator-return', 'utility', 'resolved', 'filtered'] as const)('releases %s requests without stranding wire replies', async kind => {
    const f = await clientFixture();
    const scope = f.client.openRequestScope('thread');
    await f.emit([question('pending')]);
    if (kind === 'clear') f.client.clearNotifications();
    else if (kind === 'utility') {
      const stream = f.client.stream()[Symbol.asyncIterator]();
      await f.emit([{ method: 'marker', params: {} }]);
      expect((await stream.next()).value).toMatchObject({ method: 'marker' });
      await stream.return?.();
    } else if (kind === 'resolved') {
      await f.emit([{ method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 'pending' } }]);
    } else {
      const stream = f.client.events()[Symbol.asyncIterator]();
      const entry = (await stream.next()).value;
      if (!entry || 'method' in entry) throw new Error('Expected request');
      if (kind === 'filtered') expect(scope.accepts(entry, 'later-turn')).toBe(false);
      await stream.return?.();
    }
    await vi.waitFor(() => expect(f.replies()).toEqual([{ jsonrpc: '2.0', id: 'pending', result: { answers: {} } }]));
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
    if (text === 'secret' || text === 'fail') expect(events.some(e => e.type === 'ask')).toBe(false);
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

});
