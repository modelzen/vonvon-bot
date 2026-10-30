import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { CodexAppServerBackend } from '../src/agent/codex-appserver/backend';
import { CodexRequestScope, userInputRequest, type InboundQuestion } from '../src/agent/codex-appserver/server-requests';
import { AskCoordinator } from '../src/bot/ask-coordinator';
import { TurnCardEvents } from '../src/bot/turn-card-events';
import { createIdlePause } from '../src/bot/watchdog';

const transport = vi.hoisted(() => ({ client: {} as object }));
vi.mock('../src/agent/codex-appserver/locate', () => ({
  refreshCodexResolution: () => 'fixture', resolveCodexBin: () => 'fixture', codexVersionAsync: async () => 'codex-cli 0.163.0',
}));
vi.mock('../src/agent/codex-appserver/client-pool', async importOriginal => ({
  ...await importOriginal<object>(), takeWarmClient: () => transport.client, refillWarmPool: async () => {},
}));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'ask-prefetch-')));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));
const flush = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };

it.each(['ordinary', 'goal'] as const)('preserves typed messages after %s backend retires the ask but done is still queued', async mode => {
  const scope = new CodexRequestScope('thread'); let question!: InboundQuestion;
  let finish!: () => void;
  const finishing = new Promise<void>(resolve => { finish = resolve; });
  const wire = userInputRequest({ threadId: 'thread', turnId: 'turn', itemId: 'item', questions: [{
    id: 'q', header: 'Pick', question: 'Pick one', isOther: true, isSecret: false,
    options: [{ label: 'One', description: '' }],
  }] }, 'rpc', 1, scope, value => { question = value; });
  transport.client = {
    openRequestScope: () => scope,
    request: async (method: string, params: { cwd: string; runtimeWorkspaceRoots: string[]; approvalPolicy: string; sandbox: string }) =>
      method === 'thread/resume' ? { thread: { id: 'thread' }, cwd: params.cwd,
        runtimeWorkspaceRoots: params.runtimeWorkspaceRoots, approvalPolicy: params.approvalPolicy,
        sandbox: params.sandbox === 'danger-full-access' ? { type: 'dangerFullAccess' } : undefined } : { turn: { id: 'turn' } },
    async *events() {
      yield { method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } };
      yield question;
      await finishing;
      yield { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn' } } };
    },
  };
  const thread = await new CodexAppServerBackend().resumeThread({ cwd, sessionId: 'thread' });
  const run = mode === 'goal' ? thread.runGoal('fixture') : thread.runStreamed({ text: 'fixture' });
  const response = vi.spyOn(run, 'respondToAsk');
  const update = vi.fn(async () => ({}));
  const channel = { rawClient: {
    cardkit: { v1: { card: { create: async () => ({ data: { card_id: 'card' } }), update } } },
    im: { v1: { message: { reply: async () => ({ data: { message_id: 'message' } }) } } },
  } };
  const coordinator = new AskCoordinator(channel as unknown as LarkChannel, {
    accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } },
    preferences: { access: { ownerOpenId: 'owner' } },
  }, { peek: () => 'Owner' });
  const pause = createIdlePause();
  const turn = coordinator.openTurn({ run, sessionKey: 'session',
    placement: { chatId: 'chat', replyTo: 'trigger', replyInThread: true },
    initiator: { kind: 'user', openId: 'owner' }, idlePause: pause, waiting: () => {}, fault: vi.fn() });
  const events = new TurnCardEvents().consume(run.events);
  try {
    let first = await events.next();
    while (first.value?.type !== 'ask' && !first.done) first = await events.next();
    if (first.value?.type !== 'ask') throw new Error('Expected ask');
    turn.enqueue(first.value.request); await flush();
    expect(run.askPending?.(question.request.id)).toBe(true);
    finish(); expect(await wire).toEqual({ result: { answers: {} } }); await flush();
    expect(run.askPending?.(question.request.id)).toBe(false);
    expect(coordinator.typed({ place: 'session', chatId: 'chat', senderId: 'owner', senderKind: 'user',
      text: 'ordinary message', createTime: Date.now() })).toBe('none');
    expect(response).not.toHaveBeenCalled(); expect(pause.held).toBe(false); await flush();
    expect(JSON.stringify(update.mock.calls)).toContain('本轮已结束');
    expect(JSON.stringify(update.mock.calls)).not.toContain('ordinary message');
    expect((await events.next()).value?.type).toBe('done');
  } finally { finish(); await events.return(undefined); coordinator.shutdown(); }
});
