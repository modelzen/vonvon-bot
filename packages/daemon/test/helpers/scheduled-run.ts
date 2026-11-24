import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, vi, type Mock } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput } from '../../src/agent/types';
import type { AgentEntries } from '../../src/agent/entry/registry';
import type { AppConfig } from '../../src/config/schema';
import type { ScheduledJob, ScheduledOutcome, StoredTask } from '../../src/bot/schedule/types';

/**
 * An orchestrator for scheduled runs (T2) with a fake backend and a fake Feishu, as message-queue-races has it.
 * Imported first, before the orchestrator: the mocks below apply to every later import.
 */
// Whatever the real session store or paths write lands here, never in the real data directory.
const home = mkdtempSync(join(tmpdir(), 'vonvon-scheduled-run-'));
vi.stubEnv('HOME', join(home, 'home'));
vi.stubEnv('VONVON_HOME', join(home, 'vonvon'));
afterAll(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

type Fn = Mock<(...args: any[]) => any>;
export const fake: {
  project: Record<string, unknown> | undefined; topicGroup: boolean;
  backend: { capabilities: { steer: boolean }; id: string; listModels: Fn; resumeThread: Fn; startThread: Fn };
  createCard: Fn; stream: Fn; final: Fn; send: Fn; reply: Fn; fileCreate: Fn; topicList: Fn; messageGet: Fn; chatGet: Fn; getSession: Fn; listSessions: Fn; upsertSession: Fn;
  finalizedByCard: Map<string, unknown>;
  log: { info: Fn; warn: Fn; fail: Fn };
  run?: (job: ScheduledJob) => Promise<ScheduledOutcome>;
  /** The context update every turn carries (planTurnUpdate's text); none by default. */
  contextUpdate?: string;
} = {
  project: {},
  topicGroup: false,
  backend: { capabilities: { steer: true }, id: 'codex', listModels: vi.fn(async () => []), resumeThread: vi.fn(), startThread: vi.fn() },
  createCard: vi.fn(async (..._args: unknown[]) => 'card'),
  final: vi.fn(async (..._args: unknown[]) => true),
  stream: vi.fn(),
  send: vi.fn(async (..._args: unknown[]) => ({ messageId: 'root' })),
  reply: vi.fn(async (..._args: unknown[]) => ({ code: 0, data: {} })),
  fileCreate: vi.fn(async (..._args: unknown[]) => ({ file_key: 'file_key_mock' })),
  finalizedByCard: new Map(),
  messageGet: vi.fn(),
  chatGet: vi.fn(),
  topicList: vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { items: [{ message_id: 'anchor', chat_id: 'chat', thread_id: 'topic-old' }] } })),
  getSession: vi.fn(async (key: string): Promise<Record<string, unknown> | undefined> => ({ threadId: key, chatId: 'chat', sessionId: 'host', backend: 'codex', cwd: '/test', summary: '' })),
  listSessions: vi.fn(),
  upsertSession: vi.fn(async (..._args: unknown[]) => undefined),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
};
vi.mock('../../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../../src/bot/context-assembly', async original => ({
  ...await original<object>(),
  loadContextSources: async () => ({ place: { kind: 'comment' }, botName: 'fixture', soul: '', role: { identity: '', notes: '', headed: false }, supplement: '', failed: {} }),
  planTurnUpdate: async () => ({ ...(fake.contextUpdate ? { text: fake.contextUpdate } : {}), context: { versions: {}, nonce: 'fixture' } }),
}));
vi.mock('../../src/project/registry', async (original) => ({
  ...await original<object>(), getProjectByChatId: async () => fake.project, getProjectByName: async () => fake.project,
}));
vi.mock('../../src/bot/session-store', async (original) => ({
  ...await original<object>(), getSession: fake.getSession, listSessions: fake.listSessions, patchSession: async () => undefined, upsertSession: fake.upsertSession,
}));
vi.mock('../../src/bot/context-weave', async (original) => {
  const empty = async () => ({ messages: [], ok: true, complete: true });
  return { ...await original<object>(), fetchThreadContext: empty, fetchChatContext: empty };
});
vi.mock('../../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async shutdown() {} register = async () => undefined; },
}));
vi.mock('../../src/card/run-card-stream', () => ({
  RunCardStream: class {
    private msgId = '';
    async create(...args: unknown[]) {
      const id = await fake.createCard.apply(this, args);
      this.msgId = String(id ?? '');
      return id;
    }
    getCardId() { return this.msgId ? `entity_${this.msgId}` : 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced = fake.stream;
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    async updateCard(...args: unknown[]) {
      if (this.msgId) fake.finalizedByCard.set(this.msgId, args[1]);
      return fake.final.apply(this, args);
    }
    async finalizeCard(...args: unknown[]) {
      if (this.msgId) fake.finalizedByCard.set(this.msgId, args[1]);
      return fake.final.apply(this, args);
    }
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
// The real scheduler, its runner kept for the tests to call.
vi.mock('../../src/bot/schedule/scheduler', async (original) => {
  const real = await original<typeof import('../../src/bot/schedule/scheduler')>();
  return { ...real, createScheduler: (deps: Parameters<typeof real.createScheduler>[0]) => {
    fake.run = deps.run;
    return real.createScheduler(deps);
  } };
});

export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A backend thread whose turns end when the test says, and say what the test emits. */
export function thread(releaseAfterRun?: boolean) {
  const turns: ReturnType<typeof deferred<void>>[] = [];
  const consumed: AgentInput[] = [];
  const live: { queue: AgentEvent[]; wake?: () => void; last?: AgentEvent }[] = [];
  const t = {
    sessionId: 'host', isAlive: () => true, ...(releaseAfterRun ? { releaseAfterRun: true } : {}),
    close: vi.fn(async () => { for (const turn of turns) turn.resolve(); }),
    abort: vi.fn(async () => undefined),
    steer: vi.fn(async (_input: AgentInput, _id: string): Promise<void> => undefined),
    injectContext: vi.fn(async (_text: string) => undefined),
    runStreamed(input: AgentInput) {
      consumed.push(input);
      const end = deferred<void>();
      const feed: { queue: AgentEvent[]; wake?: () => void; last?: AgentEvent } = { queue: [] };
      live.push(feed);
      const id = `turn-${turns.push(end)}`;
      return {
        turnId: () => id,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'turn_started', turnId: id };
          let done = false;
          let failure: { error: unknown } | undefined;
          void end.promise.then(() => { done = true; feed.wake?.(); }, error => { failure = { error }; done = true; feed.wake?.(); });
          while (!done || feed.queue.length) {
            const event = feed.queue.shift();
            if (event) yield event;
            else await new Promise<void>(resolve => { feed.wake = resolve; });
          }
          if (failure) throw failure.error;
          yield feed.last ?? { type: 'done', turnId: id };
        })(),
      };
    },
  };
  /** Feeds `event` to the n-th turn. */
  const emit = (event: AgentEvent, index = 0) => { live[index]!.queue.push(event); live[index]!.wake?.(); };
  return {
    t, turns, consumed, emit,
    say(text: string, index = 0) { emit({ type: 'text_delta', itemId: 'answer', delta: text }, index); },
    /** Ends the turn with `event` (an error) instead of done. */
    end(event: AgentEvent, index = 0) { live[index]!.last = event; turns[index]!.resolve(); },
  };
}

export const SLOT = Date.UTC(2026, 9, 30, 9, 0);
/** A claimed run of a daily task at 09:00 UTC, as the scheduler hands it over. */
export function job(task: Partial<StoredTask> = {}, run: Partial<ScheduledJob> = {}): ScheduledJob {
  const slot = run.slot ?? SLOT;
  return {
    task: {
      id: 'st_00000000000000a1', chatId: 'chat', revision: 'r1', name: '日报', instruction: '写今天的日报', spec: { kind: 'daily', time: '09:00' },
      timeZone: 'UTC', placement: { kind: 'follow' }, state: 'active', createdBy: { via: 'cli' }, createdAt: SLOT - 86_400_000, updatedAt: 0,
      cursor: slot, counts: { runs: 0, missed: 0, skipped: 0, consecutiveFailures: 0 }, recent: [],
      inflight: { runId: 'run-1', slot, trigger: run.trigger ?? 'schedule', startedAt: slot, revision: 'r1' }, ...task,
    },
    runId: 'run-1', slot, trigger: 'schedule', nth: 1, late: false, ...run,
  };
}

let seq = 0;
/** A person's message, @ the bot, in the main area (or in `threadId`). */
export function human(text: string, threadId?: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group', ...(threadId ? { threadId, rootId: 'r' } : {}), content: text,
    senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [],
    mentionAll: false, raw: { sender: { sender_type: 'user' } } };
}

export const topics = { note: vi.fn(async () => undefined), list: async () => [], get: async () => undefined };

/** A fresh orchestrator on a group in `kind` mode; `runScheduled` is its scheduler's runner. */
export async function setup(kind: 'single' | 'multi' | 'smart', opts: { entries?: AgentEntries; droppedFile?: string; preferences?: NonNullable<AppConfig['preferences']> } = {}) {
  vi.clearAllMocks();
  fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: kind === 'multi' ? 'multi' : 'single', ...(kind === 'smart' ? { smart: true } : {}) };
  fake.topicGroup = false;
  fake.contextUpdate = undefined;
  fake.backend.resumeThread.mockReset();
  fake.backend.startThread.mockReset();
  fake.createCard.mockResolvedValue('card');
  fake.final.mockResolvedValue(true);
  fake.send.mockResolvedValue({ messageId: 'root' });
  fake.reply.mockResolvedValue({ code: 0, data: {} });
  fake.fileCreate.mockReset().mockResolvedValue({ file_key: 'file_key_mock' });
  fake.finalizedByCard.clear();
  fake.messageGet.mockReset().mockResolvedValue({ data: { items: [{ thread_id: 'topic-new' }] } });
  fake.listSessions.mockReset().mockResolvedValue([]);
  fake.chatGet.mockReset().mockImplementation(async () => ({ code: 0, data: { chat_mode: fake.topicGroup ? 'topic' : 'group' } }));
  const { createOrchestrator } = await import('../../src/bot/handle-message');
  const cfg: AppConfig = { accounts: { app: { id: 'app', secret: 'test', tenant: 'feishu' } }, preferences: { pendingPolicy: 'steer', access: { ownerOpenId: 'owner', admins: ['owner'] }, ...opts.preferences } };
  const channel = { send: fake.send, rawClient: { im: { v1: {
    message: { get: fake.messageGet, list: fake.topicList, reply: fake.reply },
    file: { create: fake.fileCreate },
    chat: { get: fake.chatGet },
    messageReaction: { create: vi.fn(async () => ({ data: {} })), delete: async () => ({}) },
  } } } };
  // The shutdown closes the sessions once the interrupted turns end or a grace is over (owner 2026-11-02): short here.
  const orchestrator = createOrchestrator(channel as never, cfg, '/test', topics as never, { shutdownTiming: { interruptGraceMs: 20 }, ...opts });
  return { orchestrator, channel, runScheduled: fake.run! };
}

export const until = (check: () => void | Promise<void>) => vi.waitFor(check, { interval: 5 });
/** The reply options of the n-th run card created (RunCardStream.create's last argument). */
export const cardOpts = (n = 0) => fake.createCard.mock.calls[n]?.[3] as { replyTo?: string; replyInThread?: boolean } | undefined;
