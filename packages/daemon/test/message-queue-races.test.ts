import { UnsentRequestError } from '../src/agent/types';
import { JsonRpcError } from '../src/agent/codex-appserver/app-server-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../src/agent/types';

const fake = vi.hoisted(() => ({
  groupMode: 'single' as 'single' | 'multi',
  projectKind: undefined as 'single' | undefined,
  groupPolicy: undefined as 'steer' | 'queue' | undefined,
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  voice: vi.fn(async (_channel: unknown, msg: NormalizedMessage) => ({ text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true } })),
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async (..._args: unknown[]) => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  titleRegister: vi.fn(async (..._args: unknown[]) => undefined),
  record: {} as Record<string, unknown>,
  history: vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[], ok: true, complete: true })),
}));
vi.mock('../src/bot/steer-delivery', async original => { const real = await original<typeof import('../src/bot/steer-delivery')>(); return { ...real, steerWithDeadline: (thread: any, input: any, id: string) => real.steerWithDeadline(thread, input, id, undefined, 150) }; });
// F1's profileOf prepares the download folder on the real disk, which fake timers do not wait for.
vi.mock('../src/bot/media', async original => ({ ...await original<object>(), prepareInboundDir: async () => {} }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
// Queue timing uses a deterministic profile; filesystem profile delivery has its own tests.
vi.mock('../src/bot/context-assembly', async original => ({
  ...await original<object>(),
  loadContextSources: async () => ({ place: { kind: 'comment' }, botName: 'fixture', soul: '', role: { identity: '', notes: '', headed: false }, supplement: '', failed: {} }),
  planTurnUpdate: async () => ({ context: { versions: {}, nonce: 'fixture' } }),
}));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: '/test', groupMode: fake.groupMode, ...(fake.projectKind ? { kind: fake.projectKind } : {}), ...(fake.groupPolicy ? { pendingPolicy: fake.groupPolicy } : {}) }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => fake.record.absent ? undefined : ({ threadId: 'topic', chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '', ...fake.record }),
  // Only watermark writes (the function form) land; other patches stay no-ops.
  patchSession: async (_key: string, patch: unknown) => {
    if (typeof patch === 'function') Object.assign(fake.record, patch({ ...fake.record }));
  },
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(), fetchThreadContext: fake.history }));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} register = fake.titleRegister; },
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = fake.createCard;
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced = fake.live;
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    updateCard = fake.final;
    finalizeCard = fake.final;
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
vi.mock('../src/voice/inbound', async original => ({ ...await original<object>(), ingestVoice: fake.voice }));
import { createAgentEntries, type AgentEntries } from '../src/agent/entry/registry';
import type { FeedbackHost } from '../src/feedback/host';
import type { AgentEntry } from '../src/agent/types';
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';

function voiceResult(text: string, messageId = 'voice') {
  return { text, voice: { messageId, text, transcribed: true } };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function thread() {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const progress: { queue: AgentEvent[]; wake?: () => void }[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    injectContext: vi.fn(async (_text: string) => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const live: { queue: AgentEvent[]; wake?: () => void } = { queue: [] };
      progress.push(live);
      const id = `turn-${turns.push(end)}`;
      return {
        turnId: () => id, // deliberately keep backend ID stale during final-card I/O
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          let done = false;
          let failure: { error: unknown } | undefined;
          void end.promise.then(() => { done = true; live.wake?.(); }, error => { failure = { error }; done = true; live.wake?.(); });
          while (!done || live.queue.length) {
            const event = live.queue.shift();
            if (event) yield event;
            else await new Promise<void>(resolve => { live.wake = resolve; });
          }
          if (failure) throw failure.error;
          yield { type: 'done', turnId: id };
        })(),
      };
    },
  };
  return { t, turns, consumed, emit(event: AgentEvent, index = 0) {
    progress[index]!.queue.push(event); progress[index]!.wake?.();
  } };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup(policy: 'steer' | 'queue' = 'steer', entries?: AgentEntries, sessionTitles?: NonNullable<AppConfig['preferences']>['sessionTitles'], feedback?: FeedbackHost) {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner', admins: ['owner'] }, completionReminder: { mode: 'manual' }, sessionTitles } };
  const channel = { send: fake.send, rawClient: { im: { v1: { message: { get: async () => ({ data: { items: [{ thread_id: 'new-topic' }] } }) }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test', undefined, { entries, feedback });
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.groupMode = 'single';
  fake.projectKind = undefined;
  fake.groupPolicy = undefined;
  fake.record = {};
  fake.history.mockReset().mockResolvedValue({ messages: [], ok: true, complete: true });
  fake.voice.mockReset().mockImplementation(async (_channel, msg) => voiceResult('语音正文', msg.messageId));
  fake.backend.capabilities.steer = true;
  fake.final.mockReset().mockResolvedValue(true);
  fake.createCard.mockReset().mockResolvedValue('card');
  fake.send.mockReset().mockResolvedValue({});
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
});
afterEach(async () => {
  await orchestrator?.shutdown();
});
// Keep synchronization polling well below the injected 150ms steer deadline.
const until = (check: () => void) => vi.waitFor(check, { interval: 5 });

it.each([true, false])('wires the global title policy into new sessions (enabled=%s)', async enabled => {
  fake.record = { absent: true };
  const run = thread();
  fake.backend.startThread.mockResolvedValueOnce(run.t);
  const policy = enabled ? {enabled:true as const,backend:'claude-agent',model:'title-model',effort:'low' as const} : {enabled:false as const};
  await setup('queue', undefined, {policy}).onMessage({...message('给这个新会话起标题'),raw:{sender:{sender_type:'user'}}});
  await until(() => expect(fake.titleRegister).toHaveBeenCalled());
  expect(fake.titleRegister).toHaveBeenCalledWith(expect.objectContaining({backend:fake.backend.id,
    policy:enabled ? {strategy:'model',backend:'claude-agent',model:'title-model',effort:'low'} : {strategy:'truncate'}}));
  if (run.turns[0]) run.turns[0].resolve();
});

describe('running card token redaction', () => {
  it.each(['ordinary', 'goal'] as const)('redacts split tokens in the final %s card', async kind => {
    const token = `vvs1_${'a'.repeat(43)}`;
    const run = thread();
    const goalThread = { ...run.t, runGoal: () => run.t.runStreamed({ text: 'goal' }), clearGoal: vi.fn(async () => undefined) };
    fake.backend.resumeThread.mockResolvedValue(goalThread);
    const o = setup();
    await o.onMessage(message(kind === 'goal' ? '/goal finish fixture' : 'finish fixture'));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.emit({ type: 'text_delta', itemId: 'answer', delta: `prefix ${token.slice(0, 21)}` });
    run.emit({ type: 'text_delta', itemId: 'answer', delta: `${token.slice(21)} suffix` });
    run.turns[0]!.resolve();
    await until(() => {
      const card = JSON.stringify(fake.final.mock.calls.at(-1)?.[1]);
      expect(card).toContain('prefix [已隐藏的 vonvon 令牌] suffix');
      expect(card).not.toContain(token);
    });
  });
});

describe('message queue lifecycle', () => {
  it('starts the follow-up when steer rejects after its original consumer has finished', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const steer = deferred<void>();
    run.t.steer.mockReturnValueOnce(steer.promise);
    await o.onMessage(message('follow-up'));
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    steer.reject(new JsonRpcError('turn already completed'));
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('follow-up');
    run.turns[1]!.resolve();
  });

  it('queues on the replacement owner if another run starts before steer rejects', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const steer = deferred<void>();
    run.t.steer.mockReturnValueOnce(steer.promise);
    await o.onMessage(message('late follow-up'));
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    await o.onMessage(message('replacement'));
    await until(() => expect(run.consumed).toHaveLength(2));
    steer.reject(new JsonRpcError('no active turn'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    run.turns[1]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(3));
    expect(run.consumed[2]!.text).toContain('late follow-up');
    run.turns[2]!.resolve();
  });

  it('queues during final-card I/O instead of steering into a completed turn', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const card = deferred<boolean>();
    fake.final.mockReturnValueOnce(card.promise);
    const o = setup();
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    run.turns[0]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalled());
    await o.onMessage(message('second'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.t.steer).not.toHaveBeenCalled();
    card.resolve(true);
    await until(() => expect(run.consumed).toHaveLength(2));
    run.turns[1]!.resolve();
  });

  it('s21: a group set to queue queues even when the bot steers', async () => {
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.groupPolicy = 'queue';
    const o = setup('steer');
    await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await o.onMessage(message('second'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    run.turns[1]!.resolve();
  });

  it('reports queued inputs on stream failure and cannot remove a replacement reservation', async () => {
    const first = thread();
    const replacement = thread();
    fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValue(replacement.t);
    const o = setup('queue');
    await o.onMessage(message('first'));
    await until(() => expect(first.consumed).toHaveLength(1));
    await o.onMessage(message('queued'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    const feedback = deferred<object>();
    fake.send.mockReturnValueOnce(feedback.promise);
    first.turns[0]!.reject(new Error('stream failed'));
    await until(() => expect(fake.send).toHaveBeenCalledWith('chat', { markdown: expect.stringContaining('1 条排队消息未执行') }, expect.anything()));
    expect(first.t.close).toHaveBeenCalled();
    await o.onMessage(message('replacement'));
    await until(() => expect(replacement.consumed).toHaveLength(1));
    feedback.resolve({});
    await Promise.resolve();
    await o.onMessage(message('replacement follow-up'));
    await until(() => expect(fake.log.info.mock.calls.filter(c => c[1] === 'queued')).toHaveLength(2));
    expect(replacement.consumed).toHaveLength(1);
    replacement.turns[0]!.resolve();
    await until(() => expect(replacement.consumed).toHaveLength(2));
    replacement.turns[1]!.resolve();
  });

  it('reports follow-ups queued while initial session resolution fails', async () => {
    const resume = deferred<never>();
    fake.backend.resumeThread.mockReturnValueOnce(resume.promise);
    fake.backend.startThread.mockRejectedValue(new Error('backend unavailable'));
    const o = setup('queue');
    await o.onMessage(message('first'));
    await until(() => expect(fake.backend.resumeThread).toHaveBeenCalled());
    await o.onMessage(message('queued during startup'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    resume.reject(new Error('resume failed'));
    await until(() => expect(fake.send).toHaveBeenCalledWith('chat', {
      markdown: expect.stringContaining('1 条排队消息未执行'),
    }, expect.anything()));
  });

});

it.each(['disconnect', 'missing-response'])('does not replay uncertain steer delivery: %s', async failure => {
 const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 const pending = deferred<void>();
 run.t.steer.mockImplementationOnce(async () => { if (failure === 'disconnect') throw new Error('connection lost after write'); await pending.promise; });
 await o.onMessage(message('perform exactly once'));
 await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('未自动重投'))).toBe(true));
 run.turns[0]!.resolve(); pending.resolve();
 await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
 await o.onMessage(message('next request'));
 await until(() => expect(run.consumed).toHaveLength(2));
 expect(run.consumed[1]!.text).toContain('next request');
 expect(run.consumed[1]!.text).not.toContain('perform exactly once');
 run.turns[1]!.resolve();
});

it('queues directly when the backend does not support steer', async () => {
 fake.backend.capabilities.steer = true; // project default differs from the actual thread
 const run = thread(); Object.assign(run.t, { supportsSteer: false }); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 await o.onMessage(message('second'));
 expect(run.t.steer).not.toHaveBeenCalled();
 run.turns[0]!.resolve();
 await until(() => expect(run.consumed).toHaveLength(2));
 expect(run.consumed[1]!.text).toContain('second');
 run.turns[1]!.resolve();
});

it('resubmits a definitely unsent message on a fresh thread after a process exit', async () => {
 const first = thread(), next = thread();
 fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValue(next.t);
 const o = setup(); await o.onMessage(message('first'));
 await until(() => expect(first.consumed).toHaveLength(1));
 first.t.isAlive = () => false;
 first.t.steer.mockRejectedValueOnce(new UnsentRequestError('app-server client closed'));
 await o.onMessage(message('unsent followup'));
 await until(() => expect(next.consumed).toHaveLength(1));
 expect(next.consumed[0]!.text).toContain('unsent followup');
 first.turns[0]!.resolve(); next.turns[0]!.resolve();
});
// Codex review 230-1: dropping it from the cache without closing it left its entry, and the session's token, standing
it('closes a cached thread whose process went between turns when the next message evicts it', async () => {
 const first = thread(), next = thread();
 fake.backend.resumeThread.mockResolvedValueOnce(first.t).mockResolvedValue(next.t);
 const o = setup('queue'); await o.onMessage(message('first'));
 await until(() => expect(first.consumed).toHaveLength(1));
 first.turns[0]!.resolve();
 await until(() => expect(fake.final).toHaveBeenCalled());
 first.t.isAlive = () => false;
 await o.onMessage(message('second'));
 await until(() => expect(next.consumed).toHaveLength(1));
 expect(first.t.close).toHaveBeenCalled();
 next.turns[0]!.resolve();
});
it('keeps the healthy thread and queued messages after terminal card failure', async () => {
 const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
 const o = setup('queue'); await o.onMessage(message('first'));
 await until(() => expect(run.consumed).toHaveLength(1));
 await o.onMessage(message('second'));
 fake.final.mockRejectedValueOnce(new Error('Feishu 503'));
 run.turns[0]!.resolve();
 await until(() => expect(run.consumed).toHaveLength(2));
 expect(run.t.close).not.toHaveBeenCalled();
 run.turns[1]!.resolve();
});


describe('voice intake integration', () => {
  it('does not run a following text message before a slow opening voice, and deduplicates voice events', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('queue'); const transcription = deferred<ReturnType<typeof voiceResult>>();
    fake.voice.mockReturnValueOnce(transcription.promise);
    const voice = { ...message('<audio/>'), rawContentType: 'audio' };
    await o.onMessage(voice); await until(() => expect(fake.voice).toHaveBeenCalledOnce());
    await o.onMessage(voice); await o.onMessage(message('补充说明'));
    expect(run.consumed).toHaveLength(0);
    transcription.resolve(voiceResult('先分析代码', voice.messageId));
    await until(() => expect(run.consumed).toHaveLength(1));
    expect(run.consumed[0]!.text).toContain('先分析代码');
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    run.turns[0]!.resolve(); await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('补充说明'); expect(fake.voice).toHaveBeenCalledOnce();
    run.turns[1]!.resolve();
  });
  it('routes a transcribed slash command through the same handler as text', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
    fake.voice.mockResolvedValue(voiceResult('/settings'));
    await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
    await until(() => expect(fake.send).toHaveBeenCalled());
    expect(run.consumed).toHaveLength(0);
    expect(fake.voice).toHaveBeenCalledOnce();
  });
  it.each(['text', 'voice'] as const)('routes a %s /goal command to the goal backend', async kind => {
    const run = thread();
    const runGoal = vi.fn((objective: string) => run.t.runStreamed({ text: objective }));
    fake.backend.resumeThread.mockResolvedValue({ ...run.t, runGoal, clearGoal: vi.fn(async () => undefined) });
    const o = setup();
    const objective = 'finish this fixture task';
    fake.voice.mockResolvedValue(voiceResult(`/goal ${objective}`));
    await o.onMessage(kind === 'voice' ? { ...message('<audio/>'), rawContentType: 'audio' } : message(`/goal ${objective}`));
    try {
      await until(() => expect(runGoal).toHaveBeenCalledOnce());
      expect(runGoal.mock.calls[0]![0]).toContain(objective);
      expect(runGoal.mock.calls[0]![0]).not.toContain('/goal');
      expect(fake.voice).toHaveBeenCalledTimes(kind === 'voice' ? 1 : 0);
    } finally { for (const turn of run.turns) turn.resolve(); }
  });
});


it('keeps voice before later text when the current agent finishes during transcription', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup('queue');
  await o.onMessage(message('initial')); await until(() => expect(run.consumed).toHaveLength(1));
  const transcription = deferred<ReturnType<typeof voiceResult>>(); fake.voice.mockReturnValueOnce(transcription.promise);
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
  await until(() => expect(fake.voice).toHaveBeenCalledOnce());
  run.turns[0]!.resolve(); await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  await o.onMessage(message('later text')); expect(run.consumed).toHaveLength(1);
  transcription.resolve(voiceResult('earlier voice'));
  await until(() => expect(run.consumed).toHaveLength(2));
  expect(run.consumed[1]!.text).toContain('earlier voice');
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
  run.turns[1]!.resolve(); await until(() => expect(run.consumed).toHaveLength(3));
  expect(run.consumed[2]!.text).toContain('later text'); run.turns[2]!.resolve();
});


it('does not restart a stopped run when a pending voice transcription finishes', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup('queue');
  await o.onMessage(message('initial')); await until(() => expect(run.consumed).toHaveLength(1));
  const transcription = deferred<ReturnType<typeof voiceResult>>(); fake.voice.mockReturnValueOnce(transcription.promise);
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
  await until(() => expect(fake.voice).toHaveBeenCalledOnce());
  await o.onReaction({ action: 'added', emojiType: 'OK', messageId: 'card', operator: { openId: 'owner' } } as never);
  await until(() => expect(run.t.abort).toHaveBeenCalled());
  run.turns[0]!.resolve();
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  transcription.resolve(voiceResult('不应继续执行'));
  await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('会话已停止'))).toBe(true));
  expect(run.consumed).toHaveLength(1);
});

it.each([false, true])('does not restart stopped opening voice with text already queued behind a second voice (new input=%s)', async newInput => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup('queue');
  const at = Date.now() - 3000;
  const first = { ...message('<audio A/>'), rawContentType: 'audio', createTime: at };
  const second = { ...message('<audio B/>'), rawContentType: 'audio', createTime: at + 1000 };
  const later = { ...message('C must stay stopped'), createTime: at + 2000 };
  const firstAsr = deferred<ReturnType<typeof voiceResult>>();
  const secondAsr = deferred<ReturnType<typeof voiceResult>>();
  fake.voice.mockReturnValueOnce(firstAsr.promise).mockReturnValueOnce(secondAsr.promise);
  const stopNotices = () => fake.send.mock.calls.filter(args => JSON.stringify(args).includes('会话已停止'));
  try {
    await o.onMessage(first);
    await until(() => expect(fake.voice).toHaveBeenCalledOnce());
    // None of these messages has an active run when it enters the intake lane.
    await o.onMessage(second);
    await o.onMessage(later);
    expect(run.consumed).toHaveLength(0);
    firstAsr.resolve(voiceResult('A starts the run', first.messageId));
    await until(() => expect(run.consumed).toHaveLength(1));
    await until(() => expect(fake.voice).toHaveBeenCalledTimes(2));
    await o.onReaction({ action: 'added', emojiType: 'OK', messageId: 'card', operator: { openId: 'owner' } } as never);
    await until(() => expect(run.t.abort).toHaveBeenCalled());
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    // A fresh message sent after Stop finished is allowed, even while the old
    // B/C intake lane is still waiting for recognition to return.
    if (newInput) await o.onMessage({ ...message('D is a fresh request'), createTime: at + 3000 });
    secondAsr.resolve(voiceResult('B must stay stopped', second.messageId));
    // Each queued message must now either be refused or reach the agent. This
    // waits for both to settle without hiding a restarted run with shutdown.
    await until(() => expect(stopNotices().length + run.consumed.length).toBe(newInput ? 4 : 3));
    expect(run.consumed).toHaveLength(newInput ? 2 : 1);
    if (newInput) expect(run.consumed[1]!.text).toContain('D is a fresh request');
    expect(stopNotices()).toHaveLength(2);
    expect(stopNotices().map(args => args[2])).toEqual([
      expect.objectContaining({ replyTo: second.messageId }), expect.objectContaining({ replyTo: later.messageId }),
    ]);
  } finally {
    firstAsr.resolve(voiceResult('A starts the run', first.messageId));
    secondAsr.resolve(voiceResult('B must stay stopped', second.messageId));
    for (const turn of run.turns) turn.resolve();
  }
});

const voicePanels = (card: unknown): any[] => (card as any).body.elements.filter((el: any) => el.element_id?.startsWith('voice_'));
const panelText = (card: unknown) => voicePanels(card).map(p => p.elements[0].text.content);

it('adds the opening transcript to the initial and final cards without decorating agent input', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
  await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  expect(panelText(fake.createCard.mock.calls[0]![2])).toEqual(['语音正文']);
  expect(run.consumed[0]!.text).toContain('语音正文');
  expect(run.consumed[0]!.text).not.toMatch(/语音消息|> |复述|原文块/);
  expect(Object.keys(run.consumed[0]!)).not.toContain('voice');
  run.turns[0]!.resolve();
  await until(() => expect(fake.final).toHaveBeenCalled());
  expect(panelText(fake.final.mock.calls.at(-1)![1])).toEqual(['语音正文']);
});

it('shows queued voice on its own turn and does not leak it into the next text reply', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup('queue');
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
  await o.onMessage(message('last')); await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 2 }));
  run.turns[0]!.resolve(); await until(() => expect(fake.createCard).toHaveBeenCalledTimes(2));
  expect(panelText(fake.createCard.mock.calls[0]![2])).toEqual([]);
  expect(panelText(fake.createCard.mock.calls[1]![2])).toEqual(['语音正文']);
  run.turns[1]!.resolve(); await until(() => expect(fake.createCard).toHaveBeenCalledTimes(3));
  expect(panelText(fake.createCard.mock.calls[2]![2])).toEqual([]);
  run.turns[2]!.resolve();
});

it('opens a new card for accepted voice steering while keeping the agent input plain', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  const msg = { ...message('<audio/>'), rawContentType: 'audio' };
  await o.onMessage(msg); await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
  await until(() => expect(panelText(fake.live.mock.calls.at(-1)![1])).toEqual(['语音正文']));
  await o.onMessage(msg);
  expect(fake.createCard).toHaveBeenCalledTimes(2);
  expect(run.t.steer.mock.calls[0]![0].text).not.toMatch(/语音消息|> |复述/);
  expect(panelText(fake.createCard.mock.calls[1]![2])).toEqual(['语音正文']);
  expect(fake.createCard.mock.calls[1]![3]).toMatchObject({ replyTo: msg.messageId, replyInThread: true });
  expect(run.consumed).toHaveLength(1);
  run.turns[0]!.resolve(); await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  expect(panelText(fake.final.mock.calls.at(-1)![1])).toEqual(['语音正文']);
});

it('carries voice display metadata through stale-steer rejection into the replacement turn', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  const ack = deferred<void>(); run.t.steer.mockReturnValueOnce(ack.promise);
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
  await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
  run.turns[0]!.resolve(); await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  ack.reject(new JsonRpcError('turn already completed'));
  await until(() => expect(fake.createCard).toHaveBeenCalledTimes(2));
  expect(panelText(fake.createCard.mock.calls[0]![2])).toEqual([]);
  expect(panelText(fake.createCard.mock.calls[1]![2])).toEqual(['语音正文']);
  run.turns[1]!.resolve();
});

it('includes the transcript when a group voice message creates a new topic', async () => {
  const run = thread(); fake.groupMode = 'multi';
  fake.backend.listModels.mockResolvedValue([{ id: 'test-model', displayName: 'Test', isDefault: true, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }] as never);
  fake.backend.startThread.mockResolvedValue(run.t);
  const o = setup();
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio', threadId: undefined });
  await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  expect(panelText(fake.createCard.mock.calls[0]![2])).toEqual(['语音正文']);
  expect(run.consumed[0]!.text).not.toMatch(/语音消息|> |复述/);
  run.turns[0]!.resolve();
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
});

it('keeps a late successful steer acknowledgement attached to its original reply', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  const ack = deferred<void>(); run.t.steer.mockReturnValueOnce(ack.promise);
  await o.onMessage({ ...message('<audio/>'), rawContentType: 'audio' });
  await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
  run.turns[0]!.resolve(); await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  await o.onMessage(message('replacement')); await until(() => expect(fake.createCard).toHaveBeenCalledTimes(2));
  ack.resolve();
  await until(() => expect(panelText(fake.final.mock.calls.at(-1)![1])).toEqual(['语音正文']));
  expect(panelText(fake.createCard.mock.calls[1]![2])).toEqual([]);
  run.turns[1]!.resolve();
  await until(() => expect(fake.log.info.mock.calls.filter(c => c[1] === 'final')).toHaveLength(2));
  expect(panelText(fake.final.mock.calls.at(-1)![1])).toEqual([]);
});


it('rotates consecutive steers without starting another turn or replaying full text snapshots', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  let cardId = 0; fake.createCard.mockImplementation(async () => `card-${++cardId}`);
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  run.emit({ type: 'text_delta', itemId: 'answer', delta: 'BEFORE' });
  await until(() => expect(JSON.stringify(fake.live.mock.calls.at(-1))).toContain('BEFORE'));
  const steer1 = message('change direction'); await o.onMessage(steer1);
  await until(() => expect(fake.final).toHaveBeenCalledTimes(1));
  const frozen1 = JSON.stringify(fake.final.mock.calls[0]![1]);
  expect(frozen1).toContain('BEFORE');
  expect(frozen1).toContain('后续输出见下一张卡片');
  expect(frozen1).not.toContain('run.stop');
  run.emit({ type: 'text', itemId: 'answer', text: 'BEFORE-AFTER' });
  await until(() => expect(JSON.stringify(fake.live.mock.calls.at(-1))).toContain('-AFTER'));
  expect(JSON.stringify(fake.live.mock.calls.at(-1))).not.toContain('BEFORE');
  const steer2 = message('another change'); await o.onMessage(steer2);
  await until(() => expect(fake.final).toHaveBeenCalledTimes(2));
  run.emit({ type: 'text', itemId: 'last', text: 'FINAL' });
  run.turns[0]!.resolve();
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  expect(fake.createCard).toHaveBeenCalledTimes(3);
  expect(fake.createCard.mock.calls[1]![3]).toMatchObject({ replyTo: steer1.messageId });
  expect(fake.createCard.mock.calls[2]![3]).toMatchObject({ replyTo: steer2.messageId });
  expect(run.consumed).toHaveLength(1);
  expect(run.t.steer).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).toContain('FINAL');
  expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).not.toContain('BEFORE');
});

it('keeps delivering on the old card if the accepted steer cannot create its card', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  fake.createCard.mockRejectedValueOnce(new Error('CardKit unavailable'));
  await o.onMessage(message('steer'));
  await until(() => expect(fake.send).toHaveBeenCalledWith('chat', expect.objectContaining({ markdown: expect.stringContaining('新卡片创建失败') }), expect.anything()));
  run.emit({ type: 'text', itemId: 'a', text: 'STILL DELIVERED' });
  run.turns[0]!.resolve();
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).toContain('STILL DELIVERED');
  expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).not.toContain('后续输出见下一张卡片');
  expect(run.consumed).toHaveLength(1);
  expect(run.t.steer).toHaveBeenCalledOnce();
});

it('buffers output and completion while the new steer card is being created', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
  await o.onMessage(message('first')); await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  const created = deferred<string>(); fake.createCard.mockReturnValueOnce(created.promise);
  await o.onMessage(message('steer'));
  await until(() => expect(fake.createCard).toHaveBeenCalledTimes(2));
  run.emit({ type: 'text', itemId: 'a', text: 'DURING CREATE' });
  run.turns[0]!.resolve();
  created.resolve('new-card');
  await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
  expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).toContain('DURING CREATE');
  expect(run.consumed).toHaveLength(1);
});


it('refreshes elapsed time during silence and stops refreshing after completion', async () => {
  vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  try {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t); const o = setup();
    const idleTimers = vi.getTimerCount();
    await o.onMessage(message('first'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.createCard).toHaveBeenCalledOnce();
    expect(run.consumed).toHaveLength(1);
    const initialWrites = fake.live.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.live).toHaveBeenCalledTimes(initialWrites + 1);
    expect(JSON.stringify(fake.live.mock.calls.at(-1)![1])).toContain('已处理 1秒');
    run.turns[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything());
    expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).toContain('用时 1秒');
    expect(vi.getTimerCount()).toBe(idleTimers);
    const writes = fake.live.mock.calls.length;
    const finalWrites = fake.final.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fake.live).toHaveBeenCalledTimes(writes);
    expect(fake.final).toHaveBeenCalledTimes(finalWrites);
    expect(JSON.stringify(fake.final.mock.calls.at(-1)![1])).toContain('用时 1秒');
  } finally {
    await orchestrator.shutdown();
    vi.useRealTimers();
  }
});


it('does not start queued follow-ups while shutdown closes an active run', async () => {
  const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
  const o = setup('queue');
  await o.onMessage(message('first'));
  await until(() => expect(fake.createCard).toHaveBeenCalledOnce());
  await o.onMessage(message('queued follow-up'));
  await o.shutdown();
  expect(run.consumed).toHaveLength(1);
  expect(run.t.close).toHaveBeenCalled();
});

describe('watermark for interjections and queued turns (s09)', () => {
  const later = (text: string, ms: number) => ({ ...message(text), createTime: Date.now() + ms });
  const ctx = (messageId: string, text: string, createTime: number) => ({ messageId, senderName: '李四', text, from: 'user', createTime });
  const finals = () => fake.log.info.mock.calls.filter((c) => c[0] === 'card' && c[1] === 'final').length;

  it('marks an interjection seen, so the next fresh run does not weave it again', async () => {
    fake.record = { lastSeenAt: 1 };
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const steered = later('steered in', 1000);
    await o.onMessage(steered);
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    run.turns[0]!.resolve();
    await until(() => expect(finals()).toBe(1));
    expect(fake.record.seen).toContainEqual({ id: steered.messageId, at: steered.createTime });
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [
      ctx(steered.messageId, 'steered in', steered.createTime), ctx('om_chat', '别人插的一句', steered.createTime + 1),
    ] });
    await o.onMessage(later('next', 2000));
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('别人插的一句');
    expect(run.consumed[1]!.text).not.toContain('steered in');
    run.turns[1]!.resolve();
  });

  it('marks an interjection seen even when the steer ACK is lost', async () => {
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const pending = deferred<void>();
    run.t.steer.mockImplementationOnce(async () => { await pending.promise; });
    const lost = later('ack lost', 1000);
    await o.onMessage(lost);
    await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('未自动重投'))).toBe(true));
    expect(fake.record.seen).toContainEqual({ id: lost.messageId, at: lost.createTime });
    run.turns[0]!.resolve(); pending.resolve();
  });

  it('unmarks a rejected interjection, so a dropped queue leaves it for the next back-fill', async () => {
    fake.record = { lastSeenAt: 1 };
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup(); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const steer = deferred<void>();
    run.t.steer.mockReturnValueOnce(steer.promise);
    const rejected = later('rejected steer', 1000);
    await o.onMessage(rejected);
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    // The host had already ended the turn: the steer is refused and the message queues on this run.
    steer.reject(new JsonRpcError('no active turn'));
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', { depth: 1 }));
    // The run then fails, and its queue is dropped.
    run.turns[0]!.reject(new Error('stream broke'));
    await until(() => expect(fake.send.mock.calls.some(c => JSON.stringify(c).includes('1 条排队消息未执行'))).toBe(true));
    const isMarked = () => ((fake.record.seen ?? []) as { id: string }[]).some((m) => m.id === rejected.messageId);
    await until(() => expect(isMarked()).toBe(false));
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx(rejected.messageId, 'rejected steer', rejected.createTime)] });
    await o.onMessage(later('next', 2000));
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(run.consumed[1]!.text).toContain('李四：rejected steer');
    run.turns[1]!.resolve();
  });

  it('marks a queued message seen when it is dequeued, not when it is queued', async () => {
    fake.record = { lastSeenAt: 1 };
    const run = thread(); fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('queue'); await o.onMessage(message('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const queued = later('queued one', 1000);
    await o.onMessage(queued);
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('intake', 'queued', expect.anything()));
    const isMarked = () => ((fake.record.seen ?? []) as { id: string }[]).some((m) => m.id === queued.messageId);
    expect(isMarked()).toBe(false);
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    await until(() => expect(isMarked()).toBe(true));
    run.turns[1]!.resolve();
    await until(() => expect(finals()).toBe(2));
    fake.history.mockResolvedValueOnce({ ok: true, complete: true, messages: [ctx(queued.messageId, 'queued one', queued.createTime)] });
    await o.onMessage(later('next', 2000));
    await until(() => expect(run.consumed).toHaveLength(3));
    expect(run.consumed[2]!.text).not.toContain('queued one');
    run.turns[2]!.resolve();
  });
});


describe('agent entry orchestration', () => {
  function human(text: string): NormalizedMessage { return { ...message(text), raw: { sender: { sender_type: 'user' } } }; }
  function entries() {
    return createAgentEntries({ appId: 'fixture', isAdmin: id => id === 'owner' });
  }
  it('attaches a fresh group grant for resume, opens the triggering turn, and closes it on done', async () => {
    const registry = entries(), open = vi.spyOn(registry, 'openTurn');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('queue', registry), first = human('first');
    await o.onMessage(first);
    await until(() => expect(run.consumed).toHaveLength(1));
    const grant: AgentEntry = fake.backend.resumeThread.mock.calls[0]![0].entry;
    await expect(grant.call('session_info', {})).resolves.toEqual({ ok: true, result: { v: 1, place: 'group', turn: 'person' } });
    expect(open).toHaveBeenCalledWith(run.t, expect.objectContaining({ requesterOpenId: 'owner', triggerMessageId: first.messageId, retry: false }));
    const second = { ...human('second'), senderId: 'other' };
    await o.onMessage(second);
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(open).toHaveBeenLastCalledWith(run.t, expect.objectContaining({ requesterOpenId: 'other', triggerMessageId: second.messageId }));
    run.turns[1]!.resolve();
    await until(() => expect(fake.final).toHaveBeenCalled());
    await until(async () => expect(await grant.call('session_info', {})).toMatchObject({ result: { turn: 'none' } }));
  });
  it('carries each actual feedback source through topic launch and queued turns', async () => {
    const registry = entries(), open = vi.spyOn(registry, 'openTurn');
    const run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const feedback: FeedbackHost = {enabled: () => true, onMessage: async () => false, onAction: async () => {}, close: async () => {},
      bind: msg => ({openId: msg.senderId, messageId: msg.messageId, chatId: msg.chatId,
        attachments: [{ref: msg.messageId, name: '截图'}], prepare: async () => {throw new Error('unused');}})};
    const o = setup('queue', registry, undefined, feedback);
    const first = human('first');
    await o.onMessage(first);
    await until(() => expect(run.consumed).toHaveLength(1));
    const second = {...human('second'), senderId: 'another'};
    await o.onMessage(second);
    run.turns[0]!.resolve();
    await until(() => expect(run.consumed).toHaveLength(2));
    expect(open.mock.calls.map(([,facts]) => [facts.feedback?.openId, facts.feedback?.messageId]))
      .toEqual([[first.senderId, first.messageId], [second.senderId, second.messageId]]);
    expect(run.consumed[1]!.text).toContain(JSON.stringify([{ref: second.messageId, name: '截图'}]));
    run.turns[1]!.resolve();
  });
  it('revokes a failed resume grant before reopening with a distinct grant', async () => {
    const registry = entries(), run = thread();
    fake.backend.resumeThread.mockRejectedValueOnce(Error('resume failed'));
    fake.backend.startThread.mockResolvedValueOnce(run.t);
    await setup('steer', registry).onMessage(human('retry saved session'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const old: AgentEntry = fake.backend.resumeThread.mock.calls[0]![0].entry;
    const next: AgentEntry = fake.backend.startThread.mock.calls[0]![0].entry;
    expect(old).not.toBe(next);
    await expect(old.call('session_info', {})).resolves.toMatchObject({ code: 'revoked' });
    await expect(next.call('session_info', {})).resolves.toMatchObject({ ok: true });
    run.turns[0]!.resolve();
  });
  it('revokes a failed start grant', async () => {
    const registry = entries();
    fake.backend.resumeThread.mockRejectedValueOnce(Error('resume failed'));
    fake.backend.startThread.mockRejectedValueOnce(Error('start failed'));
    await setup('steer', registry).onMessage(human('cannot start'));
    await until(() => expect(fake.backend.startThread).toHaveBeenCalled());
    const grant: AgentEntry = fake.backend.startThread.mock.calls[0]![0].entry;
    await until(async () => expect(await grant.call('session_info', {})).toMatchObject({ code: 'revoked' }));
  });
  it('invalidates human authority before delivering another person’s steer', async () => {
    const registry = entries(), run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('steer', registry);
    await o.onMessage(human('first'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const grant: AgentEntry = fake.backend.resumeThread.mock.calls[0]![0].entry;
    run.t.steer.mockImplementationOnce(async () => {
      await expect(grant.call('session_info', {})).resolves.toMatchObject({ result: { turn: 'other' } });
    });
    await o.onMessage({ ...human('steer'), senderId: 'other' });
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    run.turns[0]!.resolve();
  });
  it('revokes grants before shutdown closes a provider', async () => {
    const registry = entries(), run = thread();
    fake.backend.resumeThread.mockResolvedValue(run.t);
    const o = setup('steer', registry);
    await o.onMessage(human('running'));
    await until(() => expect(run.consumed).toHaveLength(1));
    const grant: AgentEntry = fake.backend.resumeThread.mock.calls[0]![0].entry;
    run.t.close.mockImplementationOnce(async () => {
      await expect(grant.call('session_info', {})).resolves.toMatchObject({ code: 'revoked' });
      run.turns[0]!.resolve();
    });
    await o.shutdown();
    expect(run.t.close).toHaveBeenCalled();
  });
});

it.each(['new message', '/clear'])('issues and attaches a group grant for a fresh start via %s', async path => {
  const registry = createAgentEntries({ appId: 'fixture', isAdmin: () => true });
  const issue = vi.spyOn(registry, 'issue'), run = thread();
  if (path === 'new message') fake.record = { absent: true };
  else fake.projectKind = 'single';
  fake.backend.startThread.mockResolvedValueOnce(run.t);
  const input = { ...message(path), raw: { sender: { sender_type: 'user' } }, ...(path === '/clear' ? { threadId: undefined } : {}) };
  await setup('queue', registry).onMessage(input);
  await until(() => expect(fake.backend.startThread).toHaveBeenCalledOnce());
  expect(fake.backend.resumeThread).not.toHaveBeenCalled();
  expect(issue).toHaveBeenCalledWith({ kind: 'group', chatId: 'chat' });
  const grant: AgentEntry = fake.backend.startThread.mock.calls[0]![0].entry;
  await until(async () => expect(await grant.call('session_info', {})).toMatchObject({ ok: true, result: { place: 'group' } }));
  if (run.turns[0]) run.turns[0].resolve();
});
