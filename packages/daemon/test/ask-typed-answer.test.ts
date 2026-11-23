import { throughBridgeChannel } from './helpers/lark-events';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { writeNodeExecutable } from './helpers/node-executable';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput, AskRequest } from '../src/agent/types';

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'ask-typed-answer-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
const fake = vi.hoisted(() => ({
  judge: vi.fn(async () => ({ decision: 'reply', reason: '答', ms: 0 })),
  sessionMissing: false,
  dmConsole: vi.fn(async () => undefined),
  groupMode: 'single' as 'single' | 'multi' | 'smart',
  groupPolicy: undefined as 'steer' | 'queue' | undefined,
  noMention: undefined as boolean | undefined,
  managed: new Set<string>(),
  idConvert: vi.fn<(...args: unknown[]) => Promise<{ data: { card_id?: string } }>>(async () => ({ data: {} })),
  elementUpdate: vi.fn(async (..._args: unknown[]) => ({})),
  sendManaged: vi.fn(async (..._args: unknown[]) => ({ messageId: 'ask-1', cardId: 'card-ask' })),
  updateManaged: vi.fn(async () => true),
  reply: vi.fn(async () => ({ data: {} })),
  getMessage: vi.fn<() => Promise<{ data: { items: { thread_id?: string; chat_id?: string; body?: { content: string } }[] } }>>(async () => ({ data: { items: [{ thread_id: 'new-topic' }] } })),
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  voice: vi.fn(async (_channel: unknown, msg: NormalizedMessage) => ({ text: '语音正文', voice: { messageId: msg.messageId, text: '语音正文', transcribed: true } })),
  live: vi.fn(),
  final: vi.fn(async (..._args: unknown[]) => true),
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  send: vi.fn(async () => ({})),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
  record: {} as Record<string, unknown>,
  history: vi.fn(async (..._args: unknown[]) => ({ messages: [] as unknown[], ok: true, complete: true })),
}));
// Each test owns an orchestrator, but the process registries live for this module.
vi.mock('../src/agent/owned-process', async original => ({ ...await original<object>(), closeOwnedProviderProcesses: async () => {}, stopAcceptingProviderProcesses: () => {} }));
vi.mock('../src/agent/codex-appserver/client-pool', async original => ({ ...await original<object>(), shutdownResidentClients: async () => {} }));
afterAll(async () => {
  const processes = await vi.importActual<typeof import('../src/agent/owned-process')>('../src/agent/owned-process');
  const pool = await vi.importActual<typeof import('../src/agent/codex-appserver/client-pool')>('../src/agent/codex-appserver/client-pool');
  await processes.closeOwnedProviderProcesses();
  await pool.shutdownResidentClients();
});
vi.mock('../src/bot/steer-delivery', async original => { const real = await original<typeof import('../src/bot/steer-delivery')>(); return { ...real, steerWithDeadline: (thread: any, input: any, id: string) => real.steerWithDeadline(thread, input, id, undefined, 150) }; });
vi.mock('../src/card/managed', async original => ({ ...await original<object>(), sendManagedCard: fake.sendManaged, updateManagedCard: fake.updateManaged, isManaged: (id: string) => fake.managed.has(id) }));
vi.mock('../src/judge/judge', async original => ({ ...await original<object>(), createJudge: () => ({ judge: fake.judge, shutdown: async () => {}, warm: () => {} }) }));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => ({ name: 'test', chatId: 'chat', cwd: workspace, kind: fake.groupMode === 'smart' ? 'single' : fake.groupMode, ...(fake.groupMode === 'smart' ? { smart: true } : {}), ...(fake.groupPolicy ? { pendingPolicy: fake.groupPolicy } : {}), ...(fake.noMention !== undefined ? { noMention: fake.noMention } : {}) }),
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async (key: string) => fake.sessionMissing ? undefined : ({ threadId: key, chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: workspace, summary: '', ...fake.record }),
  // Only watermark writes (the function form) land; other patches stay no-ops.
  patchSession: async (_key: string, patch: unknown) => {
    if (typeof patch === 'function') Object.assign(fake.record, patch({ ...fake.record }));
  },
  upsertSession: async () => undefined,
}));
vi.mock('../src/bot/context-weave', async (original) => ({ ...await original<object>(), fetchThreadContext: fake.history }));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} },
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
vi.mock('../src/bot/dm-console', () => ({ handleDmConsole: fake.dmConsole }));
vi.mock('../src/voice/inbound', async original => ({ ...await original<object>(), ingestVoice: fake.voice }));
import { createOrchestrator } from '../src/bot/handle-message';
import type { AppConfig } from '../src/config/schema';
import { isSeen } from '../src/bot/session-store';

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
  const respond = vi.fn(async () => {});
  const askPending = vi.fn(() => true);
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const progress: { queue: AgentEvent[]; wake?: () => void }[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true,
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const live: { queue: AgentEvent[]; wake?: () => void } = { queue: [] };
      progress.push(live);
      const id = `turn-${turns.push(end)}`;
      return {
        respondToAsk: respond,
        askPending,
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
  return { t, turns, consumed, respond, askPending, emit(event: AgentEvent, index = 0) {
    progress[index]!.queue.push(event); progress[index]!.wake?.();
  } };
}
let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string, over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', threadId: 'topic',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false, raw: { sender: { sender_type: 'user' } }, ...over } as NormalizedMessage;
}
type IntakeOptions = Parameters<typeof createOrchestrator>[4];
function setup(policy: 'steer' | 'queue' = 'steer', options?: IntakeOptions) {
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: policy, access: { ownerOpenId: 'owner', admins: ['owner'] }, completionReminder: { mode: 'manual' } } };
  const channel = { send: fake.send, rawClient: { cardkit: { v1: { card: { idConvert: fake.idConvert }, cardElement: { update: fake.elementUpdate } } }, im: { v1: { message: { reply: fake.reply, get: fake.getMessage }, messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, workspace, undefined, options);
  return orchestrator;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.groupMode = 'single';
  fake.sessionMissing = false;
  fake.groupPolicy = undefined;
  fake.noMention = undefined;
  fake.managed.clear();
  fake.idConvert.mockReset().mockResolvedValue({ data: {} });
  fake.elementUpdate.mockReset().mockResolvedValue({});
  let managedCount = 0;
  fake.sendManaged.mockReset().mockImplementation(async () => {
    const messageId = `ask-${++managedCount}`;
    fake.managed.add(messageId);
    return { messageId, cardId: `card-${messageId}` };
  });
  fake.updateManaged.mockReset().mockResolvedValue(true);
  fake.reply.mockReset().mockResolvedValue({ data: {} });
  fake.getMessage.mockReset().mockResolvedValue({ data: { items: [{ thread_id: 'new-topic' }] } });
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
// Keep synchronization polling well below the injected 150ms steer deadline.
const until = (check: () => void) => vi.waitFor(check, { interval: 5 });

const choice: AskRequest = { id: 'id', kind: 'choices', title: '选择', acceptedConsequence: '继续', declinedConsequence: '停止',
  questions: [{ id: 'q', title: '方案', detail: '', selection: 'single', other: false,
    options: [{ id: 'a', label: 'A', description: '' }, { id: 'b', label: 'B', description: '' }] }] };
const confirmation: AskRequest = { id: 'id', kind: 'confirmation', title: '确认', detail: '继续吗', acceptedConsequence: '继续', declinedConsequence: '停止' };
async function visible(run: ReturnType<typeof thread>, request: AskRequest = choice) {
  run.emit({ type: 'ask', request });
  await until(() => expect(fake.reply).toHaveBeenCalled());
}
async function started(run: ReturnType<typeof thread>, overrides: Partial<NormalizedMessage> = {}, options?: IntakeOptions) {
  fake.backend.resumeThread.mockResolvedValue(run.t);
  fake.backend.startThread.mockResolvedValue(run.t);
  const o = setup(fake.groupPolicy ?? 'steer', options);
  await o.onMessage(message('first', overrides));
  await until(() => expect(run.consumed).toHaveLength(1));
  return o;
}
function answered(run: ReturnType<typeof thread>, text = '用方案 B') {
  expect(run.respond).toHaveBeenCalledExactlyOnceWith('id', { kind: 'answered', answer: { kind: 'text', text } });
  expect(run.t.steer).not.toHaveBeenCalled();
  expect(run.consumed).toHaveLength(1);
}

describe('typed ask messages at intake', () => {
  it.each([undefined, 'topic'])('accepts a transcribed answer in %s through the text answer path', async threadId => {
    const run = thread(); const o = await started(run, { threadId });
    await visible(run);
    fake.voice.mockImplementation(async (_channel, msg) => voiceResult('用方案 B', msg.messageId));
    await o.onMessage(message('<audio/>', { threadId, rawContentType: 'audio' }));
    await until(() => answered(run));
    expect(fake.voice).toHaveBeenCalledOnce();
    run.turns[0]!.resolve();
  });

  it.each([undefined, 'topic'])('consumes the answer in %s, without steering', async threadId => {
    const run = thread(); const o = await started(run, { threadId });
    await visible(run);
    await o.onMessage(message('用方案 B', { threadId }));
    await until(() => answered(run));
    run.turns[0]!.resolve();
  });

  it.each(['other', 'all'] as const)('keeps @%s out of typed answers but sends it to smart judgement', async target => {
    fake.groupMode = 'smart';
    const run = thread();
    const o = await started(run);
    await visible(run);
    fake.judge.mockClear();
    await throughBridgeChannel(message('用方案 B', { mentionedBot: false,
      mentionAll: target === 'all', mentions: target === 'other' ? [{ key: '@_x', name: '小审', isBot: false, openId: 'ou_other' }] : [] }), o.onMessage);
    await until(() => expect(fake.judge).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('answers before a queued turn is added', async () => {
    fake.groupPolicy = 'queue';
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('用方案 B'));
    await until(() => answered(run));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    expect(run.consumed).toHaveLength(1);
    expect(fake.log.info).not.toHaveBeenCalledWith('intake', 'queued', expect.anything());
  });

  it('lets a guest message steer, because the guest cannot answer', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('guest answer', { senderId: 'guest' }));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('lets confirmation text steer and leaves its card alone', async () => {
    const run = thread(); const o = await started(run);
    await visible(run, confirmation);
    await o.onMessage(message('确认'));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    expect(fake.updateManaged).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('routes slash commands without answering the card', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('/context'));
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('accepts a typed answer while a goal turn waits for choices', async () => {
    const run = thread();
    Object.assign(run.t, { runGoal: (_objective: string) => run.t.runStreamed({ text: 'goal' }),
      clearGoal: vi.fn(async () => undefined) });
    fake.backend.resumeThread.mockResolvedValue(run.t);
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('/goal finish the work'));
    await until(() => expect(run.consumed).toHaveLength(1));
    await visible(run);
    await o.onMessage(message('用方案 B'));
    await until(() => expect(run.respond).toHaveBeenCalledExactlyOnceWith('id',
      { kind: 'answered', answer: { kind: 'text', text: '用方案 B' } }));
    expect(fake.send.mock.calls.some(args => JSON.stringify(args).includes('目标运行中'))).toBe(false);
    run.turns[0]!.resolve();
  });

  it.each(['multi', 'smart'] as const)('routes an ask-first main-area goal answer to its resulting place (%s)', async mode => {
    fake.groupMode = mode;
    if (mode === 'smart') fake.sessionMissing = true;
    // A real app-server transport, isolated executable and no account credentials.
    // Retain the fixture directory for inspection under the task's no-delete rule.
    const dir = realpathSync(execFileSync('mktemp', ['-d'], { encoding: 'utf8' }).trim());
    const { bin } = writeNodeExecutable(dir, 'codex', `
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
const fs = require('node:fs');
const path = require('node:path');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(path.join(__dirname, 'frames'), line + '\\n');
  if (!m.method) {
    send({ method: 'thread/goal/updated', params: { threadId: 'host', goal: { status: 'complete' } } });
    send({ method: 'turn/completed', params: { threadId: 'host', turn: { id: 'goal-turn' } } });
    return;
  }
  if (m.id !== undefined) {
    const thread = m.method === 'thread/start' || m.method === 'thread/resume';
    send({ id: m.id, result: thread ? {
      thread: { id: 'host' }, cwd: m.params.cwd,
      runtimeWorkspaceRoots: m.params.runtimeWorkspaceRoots, approvalPolicy: m.params.approvalPolicy,
      ...(m.params.sandbox === 'danger-full-access' ? { sandbox: { type: 'dangerFullAccess' } } : {}),
    } : {} });
  }
  if (m.method === 'thread/goal/set') {
    send({ method: 'turn/started', params: { threadId: 'host', turn: { id: 'goal-turn' } } });
    send({ id: 'provider-ask', method: 'item/tool/requestUserInput', params: {
      threadId: 'host', turnId: 'goal-turn', itemId: 'item', questions: [{ id: 'q', header: 'Pick', question: 'Which?',
      isOther: true, isSecret: false, options: [{ label: 'A', description: '' }] }] } });
  }
});
`);
    vi.stubEnv('CODEX_BIN', bin);
    const backend = new CodexAppServerBackend();
    const respond = vi.fn();
    fake.backend.startThread.mockImplementation(async opts => {
      const live = await backend.startThread({ ...opts, cwd: dir });
      const runGoal = live.runGoal!.bind(live);
      live.runGoal = objective => {
        expect(objective).not.toContain('会变成真 @');
        expect(objective).not.toContain('群里还有 bot：');
        const run = runGoal(objective);
        const original = run.respondToAsk!.bind(run);
        run.respondToAsk = (id, answer) => { respond(id, answer); return original(id, answer); };
        return run;
      };
      return live;
    });
    const o = setup();
    const initial = message('/goal finish the work', { threadId: undefined });
    await o.onMessage(initial);
    await vi.waitFor(() => expect(fake.reply).toHaveBeenCalled(), { timeout: 5000, interval: 10 });
    await o.onMessage(message('use B', { threadId: mode === 'smart' ? undefined : 'new-topic' }));
    await until(() => expect(respond).toHaveBeenCalledWith(expect.any(String), { kind: 'answered', answer: { kind: 'text', text: 'use B' } }));
    await until(() => expect(readFileSync(join(dir, 'frames'), 'utf8')).toContain('"answers":["use B"]'));
    expect(fake.backend.startThread).toHaveBeenCalledTimes(1);
    expect(fake.backend.resumeThread).not.toHaveBeenCalled();
    expect(fake.sendManaged.mock.calls[0]?.slice(3)).toEqual([mode === 'smart' ? initial.messageId : 'card', mode !== 'smart']);
  }, 10_000);

  it.each([false, true])('settles an unresolved goal topic card even when its final update rejects (%s)', async rejectUpdate => {
    fake.groupMode = 'multi';
    fake.getMessage.mockResolvedValue({ data: { items: [] } });
    if (rejectUpdate) fake.final.mockRejectedValue(new Error('card update failed'));
    const run = thread();
    const clearGoal = vi.fn(async () => undefined);
    if (rejectUpdate) clearGoal.mockRejectedValue(new Error('clear goal failed'));
    Object.assign(run.t, { runGoal: () => run.t.runStreamed({ text: 'goal' }), clearGoal });
    fake.backend.startThread.mockResolvedValue(run.t);
    const o = setup();
    await o.onMessage(message('/goal finish the work', { threadId: undefined }));
    await vi.waitFor(() => expect(run.t.close).toHaveBeenCalled(), { timeout: 3000, interval: 10 });
    expect(fake.log.warn.mock.calls.filter(call => call[1] === 'threadid-missing')).toHaveLength(3);
    expect(fake.sendManaged).not.toHaveBeenCalled();
    expect(fake.final).toHaveBeenCalledTimes(1);
    expect(clearGoal).toHaveBeenCalledTimes(1);
    const card = JSON.stringify(fake.final.mock.calls[0]);
    expect(card).toContain('Goal topic could not be resolved');
    expect(card).not.toContain('结束目标');
    expect(card).not.toContain('终止');
    expect(JSON.stringify(fake.send.mock.calls)).toContain('Goal topic could not be resolved');
  });

  it.each([undefined, 'topic'])('keeps /goal out of answers in %s and preserves goal dispatch', async threadId => {
    const run = thread();
    const runGoal = vi.fn(() => run.t.runStreamed({ text: 'goal' }));
    Object.assign(run.t, { runGoal, clearGoal: vi.fn(async () => undefined) });
    const o = await started(run, { threadId });
    await visible(run);
    await o.onMessage(message('/goal finish the work', { threadId }));
    expect(run.respond).not.toHaveBeenCalled();
    await until(() => expect(JSON.stringify(fake.send.mock.calls)).toContain('当前会话有任务在跑'));
    run.turns[0]!.resolve();
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'final', expect.anything()));
    await o.onMessage(message('/goal finish the work', { threadId }));
    await until(() => expect(runGoal).toHaveBeenCalledWith(expect.stringContaining('finish the work'), { serviceTier: 'standard' }));
    run.turns[1]!.resolve();
  });

  it.each(['image', 'file'] as const)('keeps mixed post %s attachments on ordinary intake', async type => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('use the attached example', { rawContentType: 'post',
      resources: [{ type, fileKey: 'attachment' }] as NormalizedMessage['resources'] }));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('accepts a purely textual post as an answer', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('用方案 B', { rawContentType: 'post' }));
    await until(() => answered(run));
    run.turns[0]!.resolve();
  });

  it('keeps a typed message in intake after the provider closes its ask scope', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    // Provider terminal prefetch closed the scope; its done event is not consumed yet.
    run.askPending.mockReturnValue(false);
    await o.onMessage(message('continue with this new input'));
    await until(() => expect(run.t.steer).toHaveBeenCalled());
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('records the answered message as seen', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    const answer = message('用方案 B');
    await o.onMessage(answer);
    await until(() => expect(run.respond).toHaveBeenCalled());
    await until(() => expect(isSeen(fake.record as Parameters<typeof isSeen>[0], answer.messageId, answer.createTime)).toBe(true));
    await o.onMessage(answer);
    expect(run.t.steer).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it.each([false, true])('respects the no-mention gate (%s)', async noMention => {
    fake.noMention = noMention;
    const run = thread(); const o = await started(run, { threadId: undefined });
    await visible(run);
    await o.onMessage(message('用方案 B', { threadId: undefined, mentionedBot: false }));
    if (noMention) await until(() => answered(run));
    else { expect(run.respond).not.toHaveBeenCalled(); expect(run.t.steer).not.toHaveBeenCalled(); }
    run.turns[0]!.resolve();
  });

  it('does not take an earlier message delivered after the card', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    await o.onMessage(message('早先的话', { createTime: Date.now() - 60_000 }));
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });
});


describe('inactive ask card healing', () => {
  function click(messageId = 'gone', chatId = 'chat'): CardActionEvent {
    return { messageId, chatId, operator: { openId: 'owner' }, action: {
      tag: 'button', value: { a: 'ask_submit', requestId: 'x', decision: 'submit' },
    } };
  }
  function oldCard(chatId: string | undefined = 'chat', content = '{"type":"card","data":{"card_id":"c1"}}') {
    fake.getMessage.mockResolvedValue({ data: { items: [{ chat_id: chatId, body: { content } }] } });
  }
  const healed = () => vi.waitFor(() => expect(fake.elementUpdate).toHaveBeenCalledOnce(), { timeout: 2000 });

  it('explains and replaces orphan controls once per card within 60 seconds', async () => {
    const o = setup(); oldCard();
    await o.dispatcher.handle(click());
    await healed();
    expect(fake.send).toHaveBeenCalledExactlyOnceWith('chat', {
      markdown: expect.stringContaining('已失效（后台服务重启过）'),
    }, { replyTo: 'gone' });
    expect(fake.elementUpdate).toHaveBeenCalledWith({
      path: { card_id: 'c1', element_id: 'ask_controls' },
      data: { element: expect.stringContaining('已失效（后台服务重启过）'),
        sequence: expect.any(Number), uuid: expect.any(String) },
    });
    await o.dispatcher.handle(click());
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.getMessage).toHaveBeenCalledOnce();
    expect(fake.idConvert).not.toHaveBeenCalled();
    expect(fake.elementUpdate).toHaveBeenCalledOnce();
  });

  it('leaves a locally answered card to its normal terminal update', async () => {
    const run = thread(); const o = await started(run, { threadId: undefined });
    await visible(run);
    await o.onMessage(message('用方案 B', { threadId: undefined }));
    await until(() => answered(run));
    fake.send.mockClear(); fake.getMessage.mockClear();
    await o.dispatcher.handle(click('ask-1'));
    await until(() => expect(fake.send).toHaveBeenCalledOnce());
    expect(JSON.stringify(fake.send.mock.calls)).toContain('已经有结果了');
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('重启');
    run.turns[0]!.resolve();
    await o.shutdown();
    expect(fake.getMessage).not.toHaveBeenCalled();
    expect(fake.idConvert).not.toHaveBeenCalled();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
  });

  it('ignores a forged callback for an active card in another chat', async () => {
    const run = thread(); const o = await started(run);
    await visible(run);
    fake.send.mockClear(); fake.getMessage.mockClear();
    await o.dispatcher.handle(click('ask-1', 'other'));
    expect(fake.send).not.toHaveBeenCalled();
    expect(fake.getMessage).not.toHaveBeenCalled();
    expect(fake.idConvert).not.toHaveBeenCalled();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it.each([
    ['another chat', 'other', '{"type":"card","data":{"card_id":"c1"}}'],
    ['no card id', 'chat', '{}'],
    ['malformed content', 'chat', 'invalid json'],
  ])('does not update an orphan with %s', async (_label, chatId, content) => {
    const o = setup(); oldCard(chatId, content);
    await o.dispatcher.handle(click());
    await o.shutdown();
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.getMessage).toHaveBeenCalledOnce();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
    if (chatId === 'other') expect(fake.idConvert).not.toHaveBeenCalled();
  });

  it.each([{ items: [] }, { items: [{}] }])('leaves a missing message body unchanged ($items)', async ({ items }) => {
    const o = setup();
    fake.getMessage.mockResolvedValue({ data: { items } });
    await o.dispatcher.handle(click());
    await o.shutdown();
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.getMessage).toHaveBeenCalledOnce();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
  });

  it('converts a message id when Feishu returns expanded card content', async () => {
    const o = setup(); oldCard('chat', '{"title":"选择","elements":[]}');
    fake.idConvert.mockResolvedValue({ data: { card_id: 'converted-card' } });
    await o.dispatcher.handle(click());
    await o.shutdown();
    expect(fake.idConvert).toHaveBeenCalledExactlyOnceWith({ data: { message_id: 'gone' } });
    expect(fake.elementUpdate).toHaveBeenCalledWith({
      path: { card_id: 'converted-card', element_id: 'ask_controls' },
      data: { element: expect.stringContaining('已失效（后台服务重启过）'),
        sequence: expect.any(Number), uuid: expect.any(String) },
    });
  });

  it('keeps the explanation when conversion returns no card id', async () => {
    const o = setup(); oldCard('chat', '{"title":"选择","elements":[]}');
    await o.dispatcher.handle(click());
    await o.shutdown();
    expect(fake.idConvert).toHaveBeenCalledOnce();
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
  });

  it('logs conversion rejection without rejecting dispatch or shutdown', async () => {
    const o = setup(); oldCard('chat', '{"title":"选择","elements":[]}');
    const error = new Error('conversion failed');
    fake.idConvert.mockRejectedValue(error);
    await expect(o.dispatcher.handle(click())).resolves.toBeUndefined();
    await expect(o.shutdown()).resolves.toBeUndefined();
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
    expect(fake.log.fail).toHaveBeenCalledWith('card', error, { phase: 'ask-card-heal' });
  });

  it('never converts an expanded card from another chat', async () => {
    const o = setup(); oldCard('other', '{"title":"选择","elements":[]}');
    fake.idConvert.mockResolvedValue({ data: { card_id: 'converted-card' } });
    await o.dispatcher.handle(click());
    await o.shutdown();
    expect(fake.idConvert).not.toHaveBeenCalled();
    expect(fake.elementUpdate).not.toHaveBeenCalled();
  });

  it('can heal an old message without a chat_id field', async () => {
    const o = setup(); oldCard();
    fake.getMessage.mockResolvedValue({ data: { items: [{ body: { content: '{"type":"card","data":{"card_id":"c1"}}' } }] } });
    await o.dispatcher.handle(click());
    await healed();
  });

  it.each(['get', 'update'])('logs a failed %s without rejecting dispatch or shutdown', async phase => {
    const o = setup(); oldCard();
    const error = new Error(`heal ${phase} failed`);
    if (phase === 'get') fake.getMessage.mockRejectedValue(error);
    else fake.elementUpdate.mockRejectedValue(error);
    await expect(o.dispatcher.handle(click())).resolves.toBeUndefined();
    await expect(o.shutdown()).resolves.toBeUndefined();
    expect(fake.send).toHaveBeenCalledOnce();
    expect(fake.log.fail).toHaveBeenCalledWith('card', error, { phase: 'ask-card-heal' });
    if (phase === 'get') expect(fake.elementUpdate).not.toHaveBeenCalled();
  });
});


describe('s33b sensitive ask intake', () => {
  const sensitive: AskRequest = { ...choice, questions: [{ id: 'q', title: '密码', detail: '', selection: 'text', sensitive: true }] };
  async function secretVisible(run: ReturnType<typeof thread>) {
    await visible(run, sensitive);
    await until(() => expect(fake.sendManaged.mock.calls.some(args => args[5] === 'open_id')).toBe(true));
  }

  /** The card this person got in private: the managed send to their open_id. */
  async function card(): Promise<string> {
    const index = fake.sendManaged.mock.calls.findIndex(args => args[5] === 'open_id');
    return (await fake.sendManaged.mock.results[index]!.value as { messageId: string }).messageId;
  }
  const dm = (text: string, over: Partial<NormalizedMessage> = {}) => message(text, { chatType: 'p2p', chatId: 'dm', threadId: undefined, ...over });

  it('accepts a transcribed reply to the card, before anything else', async () => {
    const run = thread(); const o = await started(run, { threadId: undefined });
    await secretVisible(run);
    fake.voice.mockImplementation(async (_channel, msg) => voiceResult('private answer', msg.messageId));
    await o.onMessage(dm('<audio/>', { rawContentType: 'audio', replyToMessageId: await card() }));
    await until(() => answered(run, 'private answer'));
    expect(fake.voice).toHaveBeenCalledOnce();
    run.turns[0]!.resolve();
  });

  it('only transcribes the reply to the live ask card when a private draft is also open', async () => {
    const onMessage = vi.fn(async (_msg: NormalizedMessage) => true);
    const run = thread();
    const o = await started(run, { threadId: undefined }, { authoring: { onMessage, onAction: async () => {}, adminRemoved: async () => {} } });
    await secretVisible(run);
    const askCard = await card();
    for (const reply of [{}, { replyToMessageId: 'om_draft' }, { replyToMessageId: askCard, createTime: 1 }]) {
      const audio = dm('<audio/>', { rawContentType: 'audio', ...reply });
      await o.onMessage(audio);
      await until(() => expect(onMessage).toHaveBeenCalledWith(audio));
    }
    expect(fake.voice).not.toHaveBeenCalled();
    expect(run.respond).not.toHaveBeenCalled();
    fake.voice.mockImplementation(async (_channel, msg) => voiceResult('private answer', msg.messageId));
    await o.onMessage(dm('<audio/>', { rawContentType: 'audio', replyToMessageId: askCard }));
    await until(() => answered(run, 'private answer'));
    expect(fake.voice).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledTimes(3);
    run.turns[0]!.resolve();
  });

  it('keeps an ask reply out of draft intake when the original question closes during transcription', async () => {
    const onMessage = vi.fn(async (_msg: NormalizedMessage) => true);
    const run = thread();
    const o = await started(run, { threadId: undefined }, { authoring: { onMessage, onAction: async () => {}, adminRemoved: async () => {} } });
    await secretVisible(run);
    const audio = dm('<audio/>', { rawContentType: 'audio', replyToMessageId: await card() });
    const transcript = deferred<ReturnType<typeof voiceResult>>();
    fake.voice.mockReturnValueOnce(transcript.promise);
    await o.onMessage(audio);
    await until(() => expect(fake.voice).toHaveBeenCalledOnce());
    run.askPending.mockReturnValue(false);
    transcript.resolve(voiceResult('private answer', audio.messageId));
    await until(() => expect(fake.send).toHaveBeenCalledWith(audio.chatId,
      { markdown: expect.stringContaining('请查看原问题卡片') }, { replyTo: audio.messageId }));
    expect(run.respond).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(run.t.steer).not.toHaveBeenCalled();
    expect(run.consumed).toHaveLength(1);
    run.turns[0]!.resolve();
  });

  it('answers with a reply to the card, and leaves everything else to the Agent (main 必败)', async () => {
    const run = thread(); const o = await started(run, { threadId: undefined });
    await secretVisible(run);
    await o.onMessage(dm('不是回答'));
    await o.onMessage(dm('回错了', { replyToMessageId: 'om_other' }));
    expect(run.respond).not.toHaveBeenCalled();
    expect(fake.dmConsole).not.toHaveBeenCalled();
    await o.onMessage(dm('private answer', { replyToMessageId: await card() }));
    await until(() => expect(run.respond).toHaveBeenCalledExactlyOnceWith('id',
      { kind: 'answered', answer: { kind: 'text', text: 'private answer' } }));
    run.turns[0]!.resolve();
  });

  it('gives the menu for /menu, a question open or not; a retired skill command is just words', async () => {
    const run = thread(); const o = await started(run, { threadId: undefined });
    await secretVisible(run);
    const menu = dm('/menu');
    await o.onMessage(menu);
    expect(fake.dmConsole).toHaveBeenCalledExactlyOnceWith(expect.anything(), expect.anything(), menu);
    await o.onMessage(dm('/skill-add chat write reports'));
    expect(fake.dmConsole).toHaveBeenCalledOnce();
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it.each(['bot', 'attachment'] as const)('takes no %s message for an answer, even as a reply', async kind => {
    const run = thread(); const o = await started(run, { threadId: undefined });
    await secretVisible(run);
    await o.onMessage(dm('not an answer', { replyToMessageId: await card(),
      ...(kind === 'bot' ? { raw: { sender: { sender_type: 'app' } } }
        : { rawContentType: 'post', resources: [{ type: 'image', fileKey: 'attachment' }] as NormalizedMessage['resources'] }),
    } as Partial<NormalizedMessage>));
    expect(run.respond).not.toHaveBeenCalled();
    await o.onMessage(dm('private answer', { replyToMessageId: await card() }));
    await until(() => expect(run.respond).toHaveBeenCalledExactlyOnceWith('id',
      { kind: 'answered', answer: { kind: 'text', text: 'private answer' } }));
    run.turns[0]!.resolve();
  });

  it.each([undefined, 'topic'])('reminds an eligible group sender once per 60 seconds and still steers in %s', async threadId => {
    const run = thread(); const o = await started(run, { threadId });
    await secretVisible(run);
    fake.send.mockClear();
    const reminders = () => fake.send.mock.calls.filter(args => JSON.stringify(args).includes('群里发的不算回答'));
    const first = message('group answer', { threadId });
    await o.onMessage(first);
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(1));
    expect(reminders()).toHaveLength(1);
    expect(reminders()[0]).toEqual(['chat', { markdown: '🔒 这题要在私聊里回答，群里发的不算回答。' },
      { replyTo: first.messageId, replyInThread: Boolean(threadId) }]);
    await o.onMessage(message('group answer again', { threadId }));
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(2));
    expect(reminders()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61_000);
    await o.onMessage(message('group answer later', { threadId }));
    await until(() => expect(run.t.steer).toHaveBeenCalledTimes(3));
    expect(reminders()).toHaveLength(2);
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });

  it('does not remind an ineligible group sender and still steers (negative control)', async () => {
    const run = thread(); const o = await started(run, { threadId: undefined });
    await visible(run, sensitive);
    fake.send.mockClear();
    await o.onMessage(message('guest message', { threadId: undefined, senderId: 'guest' }));
    await until(() => expect(run.t.steer).toHaveBeenCalledOnce());
    expect(JSON.stringify(fake.send.mock.calls)).not.toContain('在私聊里回答');
    expect(run.respond).not.toHaveBeenCalled();
    run.turns[0]!.resolve();
  });
});
