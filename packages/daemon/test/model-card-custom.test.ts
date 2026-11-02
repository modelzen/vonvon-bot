import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { AgentEvent, AgentInput, TurnOptions } from '../src/agent/types';

// /model 卡的手填模型 id（3.11）走真实的编排器：表单提交锁卡，所以结果是一张新卡，
// 发在原位置；会话记下手填的 id 和 modelCustom；没有会话时不假装切换成功。

const fake = vi.hoisted(() => ({
  record: undefined as any,
  project: undefined as any,
  sendFails: false,
  channelSend: vi.fn(async () => ({})),
  backend: { capabilities: { steer: true }, id: 'claude-agent', listModels: vi.fn(async () => []), listModelsForCwd: vi.fn(async () => []), peekModels: vi.fn(() => []), resumeThread: vi.fn(), startThread: vi.fn() },
  sent: [] as { card: unknown; replyTo?: string; inThread?: boolean }[],
  update: vi.fn(async (..._args: unknown[]) => true),
  setDefault: vi.fn(async (opts: object) => ({ ok: true, project: opts })),
  log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() },
}));
vi.mock('../src/core/logger', () => ({ log: fake.log, withTrace: (_ctx: unknown, fn: () => unknown) => fn() }));
vi.mock('../src/agent', async (original) => ({ ...await original<object>(), createBackend: () => fake.backend }));
vi.mock('../src/project/registry', async (original) => ({
  ...await original<object>(),
  getProjectByChatId: async () => fake.project,
  listProjects: async () => fake.project ? [fake.project] : [],
}));
vi.mock('../src/bot/session-store', async (original) => ({
  ...await original<object>(),
  getSession: async () => fake.record,
  patchSession: async (_key: string, patch: Record<string, unknown> | ((record: any) => Record<string, unknown>)) => {
    if (!fake.record) return;
    const selected = typeof patch === 'function' ? patch(fake.record) : patch;
    for (const [k, v] of Object.entries(selected)) if (v !== undefined) fake.record[k] = v;
  },
  mutateSession: async (_key: string, mutate: (record: any) => void | Promise<void>) => {
    if (!fake.record) throw new Error('missing test session');
    await mutate(fake.record);
    return fake.record;
  },
  upsertSession: async (record: object) => { fake.record = record; },
}));
vi.mock('../src/bot/session-title-coordinator', () => ({
  SessionTitleCoordinator: class { startRecovery() {} async register() {} async shutdown() {} },
}));
vi.mock('../src/card/managed', async (original) => ({
  ...await original<object>(),
  sendManagedCard: async (_channel: unknown, _to: string, card: unknown, replyTo?: string, inThread?: boolean) => {
    if (fake.sendFails) throw new Error('rate limited');
    fake.sent.push({ card, replyTo, inThread });
    return { messageId: `card-${fake.sent.length}` };
  },
  updateManagedCard: fake.update,
}));
vi.mock('../src/admin/ops', async (original) => ({
  ...await original<object>(),
  performSetModelDefault: fake.setDefault,
}));
vi.mock('../src/card/run-card-stream', () => ({
  RunCardStream: class {
    create = vi.fn(async () => 'card');
    getCardId() { return 'card_entity'; }
    async updateElement() { return true; }
    streamCoalesced() {}
    async drain() {}
    setImageWorker() {}
    async settleImages() { return new Map(); }
    updateCard = vi.fn(async () => true);
    finalizeCard = vi.fn(async () => true);
    stats() { return { pushCount: 0, cardPushes: 0, elPushes: 0, totalRttMs: 0, maxRttMs: 0 }; }
  },
}));
import { createOrchestrator } from '../src/bot/handle-message';
import { MC } from '../src/card/command-cards';
import { GS } from '../src/card/dm-cards';
import { CUSTOM_MODEL_OPTION } from '../src/agent/model-id';
import type { AppConfig } from '../src/config/schema';

let orchestrator: ReturnType<typeof createOrchestrator>;
let seq = 0;
function message(text: string): NormalizedMessage {
  return { messageId: `msg-${++seq}`, chatId: 'chat', chatType: 'group',
    content: text, senderId: 'owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
function setup() {
  const cfg: AppConfig = { accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'owner' } } };
  const channel = { send: fake.channelSend, rawClient: { im: { v1: { messageReaction: {
    create: async () => ({ data: {} }), delete: async () => ({}),
  } } } } };
  orchestrator = createOrchestrator(channel as never, cfg, '/test');
  return orchestrator;
}
const submit = (messageId: string, customModel: string, user = 'owner') =>
  orchestrator.dispatcher.handle({
    messageId,
    chatId: 'chat',
    operator: { openId: user },
    action: { value: { a: MC.custom } },
    raw: { action: { form_value: { customModel } } },
  } as never);
const until = (check: () => void) => vi.waitFor(check);
const record = () => ({ threadId: 'chat', chatId: 'chat', sessionId: 'host', backend: 'claude-agent', cwd: '/test', summary: '', model: 'opus', effort: 'max' });

beforeEach(() => {
  vi.clearAllMocks();
  fake.sent.length = 0;
  fake.record = undefined;
  fake.sendFails = false;
  fake.backend.id = 'claude-agent';
  fake.project = { name: 'test', chatId: 'chat', cwd: '/test', kind: 'single', backend: 'claude-agent' };
  fake.backend.listModels.mockResolvedValue([
    { id: 'default', displayName: 'Default', description: '', supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', isDefault: true, hidden: false },
    { id: 'opus', displayName: 'Opus', description: '', supportedEfforts: ['low', 'high', 'max'], defaultEffort: 'high', isDefault: false, hidden: false },
  ] as never);
  fake.backend.listModelsForCwd.mockImplementation(fake.backend.listModels);
  fake.backend.peekModels.mockImplementation(() => []);
});
afterEach(async () => {
  await orchestrator?.shutdown();
});

describe('/model 卡手填模型 id', () => {
  it('记进会话，结果作为新卡发在原位置，新卡接着能用，下一轮用这个 id', async () => {
    fake.record = record();
    const o = setup();
    const ask = message('/model');
    await o.onMessage(ask);
    await until(() => expect(fake.sent).toHaveLength(1));
    expect(JSON.stringify(fake.sent[0]!.card)).toContain(MC.custom);

    await submit('card-1', ' deepseek-chat ');
    await until(() => expect(fake.sent).toHaveLength(2));
    expect(fake.record).toMatchObject({ model: 'deepseek-chat', modelCustom: true, effort: 'max' });
    expect(fake.sent[1]).toMatchObject({ replyTo: ask.messageId, inThread: false });
    const result = JSON.stringify(fake.sent[1]!.card);
    expect(result).toContain('`deepseek-chat`（手填）');
    expect(result).toContain('已切换到手填的模型');

    // The new card owns the state: picking a listed model there clears the flag.
    await o.dispatcher.handle({ messageId: 'card-2', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: MC.model }, option: 'opus' } } as never);
    await until(() => expect(fake.update).toHaveBeenCalled());
    expect(fake.record).toMatchObject({ model: 'opus', modelCustom: false });

    // and the old, locked card no longer acts
    await submit('card-1', 'kimi-k2');
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'action', expect.anything()));
    expect(fake.sent).toHaveLength(2);
    expect(fake.record.model).toBe('opus');
  });

  it('下一轮把手填的 id 交给后端', async () => {
    fake.record = { ...record(), model: 'deepseek-chat', modelCustom: true, effort: 'high' };
    const options: (TurnOptions | undefined)[] = [];
    fake.backend.resumeThread.mockResolvedValue({
      sessionId: 'host', isAlive: () => true, close: vi.fn(async () => {}), abort: vi.fn(async () => {}), steer: vi.fn(async () => {}),
      runStreamed(_input: AgentInput, turn?: TurnOptions) {
        options.push(turn);
        return { turnId: () => 't1', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'done', turnId: 't1' }; })() };
      },
    });
    const o = setup();
    await o.onMessage(message('hello'));
    await until(() => expect(options).toHaveLength(1));
    expect(options[0]).toMatchObject({ model: 'deepseek-chat', effort: 'high' });
  });

  it('不合格的 id 和没有会话时，不写记录，新卡上说明原因', async () => {
    fake.record = record();
    const o = setup();
    await o.onMessage(message('/model'));
    await until(() => expect(fake.sent).toHaveLength(1));
    await submit('card-1', 'two words');
    await until(() => expect(fake.sent).toHaveLength(2));
    expect(fake.record.model).toBe('opus');
    expect(JSON.stringify(fake.sent[1]!.card)).toContain('不能包含空格');

    fake.record = undefined;
    await submit('card-2', 'deepseek-chat');
    await until(() => expect(fake.sent).toHaveLength(3));
    expect(fake.record).toBeUndefined();
    expect(JSON.stringify(fake.sent[2]!.card)).toContain('这里还没有会话');
  });

  it('新卡发不出去时，回一句文字说明结果', async () => {
    fake.record = record();
    const o = setup();
    const ask = message('/model');
    await o.onMessage(ask);
    await until(() => expect(fake.sent).toHaveLength(1));
    fake.sendFails = true;
    await submit('card-1', 'deepseek-chat');
    await until(() => expect(fake.channelSend).toHaveBeenCalledWith(
      'chat',
      { markdown: expect.stringContaining('已切换到手填的模型') },
      { replyTo: ask.messageId, replyInThread: false },
    ));
    expect(fake.record).toMatchObject({ model: 'deepseek-chat', modelCustom: true });
  });

  it('从手填的项目默认新开的会话记下 modelCustom', async () => {
    fake.project = { ...fake.project, defaultModel: 'kimi-k2', defaultEffort: 'high', defaultModelCustom: true };
    const options: (TurnOptions | undefined)[] = [];
    fake.backend.startThread.mockResolvedValue({
      sessionId: 'host', isAlive: () => true, close: vi.fn(async () => {}), abort: vi.fn(async () => {}), steer: vi.fn(async () => {}),
      runStreamed(_input: AgentInput, turn?: TurnOptions) {
        options.push(turn);
        return { turnId: () => 't1', events: (async function* (): AsyncGenerator<AgentEvent> { yield { type: 'done', turnId: 't1' }; })() };
      },
    });
    const o = setup();
    await o.onMessage(message('hello'));
    await until(() => expect(options).toHaveLength(1));
    expect(fake.backend.startThread).toHaveBeenCalledWith(expect.objectContaining({ model: 'kimi-k2', effort: 'high' }));
    expect(fake.record).toMatchObject({ model: 'kimi-k2', modelCustom: true });
  });

  it('只有发卡的人能提交', async () => {
    fake.record = record();
    const o = setup();
    await o.onMessage(message('/model'));
    await until(() => expect(fake.sent).toHaveLength(1));
    await submit('card-1', 'deepseek-chat', 'someone-else');
    await until(() => expect(fake.log.info).toHaveBeenCalledWith('card', 'action-denied', expect.anything()));
    expect(fake.sent).toHaveLength(1);
    expect(fake.record.model).toBe('opus');
  });
});

it('rejects an effort click from an older card after another card switches the session model', async () => {
  const catalog = [
    { id: 'a', displayName: 'A', description: '', supportedEfforts: ['low'], defaultEffort: 'low', isDefault: true, hidden: false },
    { id: 'b', displayName: 'B', description: '', supportedEfforts: ['high'], defaultEffort: 'high', isDefault: false, hidden: false },
  ];
  fake.backend.id = 'codex-appserver';
  fake.backend.listModels.mockResolvedValue(catalog as never);
  fake.backend.listModelsForCwd.mockResolvedValue(catalog as never);
  fake.record = { ...record(), backend: 'codex-appserver', model: 'a', effort: 'low' };
  fake.project = { ...fake.project, backend: 'codex-appserver', modelAccess: { backend: 'codex-appserver', models: ['a', 'b'], efforts: ['low', 'high'], modelEfforts: { a: ['low'], b: ['high'] } } };
  const o = setup();
  await o.onMessage(message('/model'));
  await until(() => expect(fake.sent).toHaveLength(1));
  await o.onMessage(message('/model'));
  await until(() => expect(fake.sent).toHaveLength(2));
  await o.dispatcher.handle({ messageId: 'card-2', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: MC.model }, option: 'b' } } as never);
  await until(() => expect(fake.record).toMatchObject({ model: 'b', effort: 'high' }));
  fake.update.mockClear();
  await o.dispatcher.handle({ messageId: 'card-1', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: MC.effort }, option: 'low' } } as never);
  await until(() => expect(fake.update).toHaveBeenCalled());
  expect(fake.record).toMatchObject({ model: 'b', effort: 'high' });
  expect(JSON.stringify(fake.update.mock.calls.at(-1)?.[2])).toContain('会话模型已变化');
});

it('accepts a normal effort click when the persisted custom flag is omitted', async () => {
  fake.record = { ...record(), effort: 'low' };
  const o = setup();
  await o.onMessage(message('/model'));
  await until(() => expect(fake.sent).toHaveLength(1));
  await o.dispatcher.handle({ messageId: 'card-1', chatId: 'chat', operator: { openId: 'owner' }, action: { value: { a: MC.effort }, option: 'high' } } as never);
  await until(() => expect(fake.update).toHaveBeenCalled());
  expect(fake.record.effort).toBe('high');
  expect(JSON.stringify(fake.update.mock.calls.at(-1)?.[2])).toContain('已设置 effort');
});

describe('/model 闪电单击切换速度', () => {
  const tiers = (ultrafast: boolean) => [
    { id: 'fast', name: 'Fast', description: '' },
    ...(ultrafast ? [{ id: 'ultrafast', name: 'Ultrafast', description: '' }] : []),
  ];
  async function open(ultrafast = true) {
    fake.backend.id = 'codex-appserver';
    fake.project = { ...fake.project, backend: 'codex-appserver' };
    fake.record = { ...record(), backend: 'codex-appserver', model: 'sol' };
    const models = [{ id: 'sol', displayName: 'Sol', description: '', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, hidden: false, serviceTiers: tiers(ultrafast) }];
    fake.backend.listModels.mockResolvedValue(models as never);
    fake.backend.listModelsForCwd.mockResolvedValue(models as never);
    fake.backend.peekModels.mockReturnValue(models as never);
    const o = setup();
    await o.onMessage(message('/model'));
    await until(() => expect(fake.sent).toHaveLength(1));
    return o;
  }
  const click = (user = 'owner', value: object = { a: MC.speedOpen }) =>
    orchestrator.dispatcher.handle({ messageId: 'card-1', chatId: 'chat', operator: { openId: user }, action: { value } } as never);
  async function expectClick(count: number, tier: string, color: string) {
    await click();
    await until(() => expect(fake.update).toHaveBeenCalledTimes(count));
    const card = JSON.stringify(fake.update.mock.calls.at(-1)?.[2]);
    expect(fake.record.serviceTier ?? 'standard', card).toBe(tier);
    expect(card).toContain(`"color":"${color}"`);
    expect(card).not.toContain('"tier":"fast"');
  }

  it('cycles Standard → Fast → Ultrafast → Standard using the saved session', async () => {
    await open();
    await expectClick(1, 'fast', 'yellow');
    await expectClick(2, 'ultrafast', 'orange');
    await expectClick(3, 'standard', 'grey-400');
  });

  it('skips Ultrafast when only Fast is currently supported', async () => {
    await open(false);
    await expectClick(1, 'fast', 'yellow');
    await expectClick(2, 'standard', 'grey-400');
  });

  it('serializes two rapid clicks and advances twice from the saved tier', async () => {
    await open();
    await Promise.all([click(), click()]);
    await vi.waitFor(() => expect(fake.update).toHaveBeenCalledTimes(2), { timeout: 3000 });
    expect(fake.record.serviceTier).toBe('ultrafast');
    expect(JSON.stringify(fake.update.mock.calls.at(-1)?.[2])).toContain('"color":"orange"');
  });

  it('cycles a resumed session whose model is inherited from the current default', async () => {
    await open();
    delete fake.record.model;
    // The open card and the live catalog still agree on the inherited default.
    await expectClick(1, 'fast', 'yellow');
  });

  it('rejects another user, stale backend and unavailable model evidence without saving', async () => {
    await open();
    await click('someone-else');
    expect(fake.update).not.toHaveBeenCalled();
    expect(fake.record.serviceTier).toBeUndefined();
    fake.record.backend = 'claude-agent';
    await click();
    await until(() => expect(fake.update).toHaveBeenCalledTimes(1));
    expect(fake.record.serviceTier).toBeUndefined();
    expect(JSON.stringify(fake.update.mock.calls.at(-1)?.[2])).toContain('会话后端已切换');
    fake.record.backend = 'codex-appserver';
    fake.backend.peekModels.mockReturnValue([]);
    await click();
    await until(() => expect(fake.update).toHaveBeenCalledTimes(2));
    expect(fake.record.serviceTier).toBeUndefined();
    expect(JSON.stringify(fake.update.mock.calls.at(-1)?.[2])).toContain('实时模型目录不可用');
  });
});

describe('群设置里的默认模型手填 id', () => {
  const submitDefault = (formValue: Record<string, unknown>) =>
    orchestrator.dispatcher.handle({
      messageId: 'gs-card',
      chatId: 'chat',
      operator: { openId: 'owner' },
      action: { value: { a: GS.modelDefaultSubmit } },
      raw: { action: { form_value: formValue } },
    } as never);

  it('合格就按手填保存；不合格就带提示重发默认模型卡，不保存', async () => {
    setup();
    await submitDefault({ model: CUSTOM_MODEL_OPTION, customModel: 'a b', effort: 'high' });
    await until(() => expect(fake.sent).toHaveLength(1));
    expect(fake.setDefault).not.toHaveBeenCalled();
    const retry = JSON.stringify(fake.sent[0]!.card);
    expect(retry).toContain('不能包含空格');
    expect(retry).toContain(GS.modelDefaultSubmit);

    await submitDefault({ model: CUSTOM_MODEL_OPTION, customModel: 'deepseek-chat', effort: 'max' });
    await until(() => expect(fake.setDefault).toHaveBeenCalledOnce());
    expect(fake.setDefault).toHaveBeenCalledWith({ projectName: 'test', model: 'deepseek-chat', effort: 'max', custom: true });
    await until(() => expect(fake.sent).toHaveLength(2));

    await submitDefault({ model: 'gone', effort: 'high' });
    await until(() => expect(fake.sent).toHaveLength(3));
    expect(fake.setDefault).toHaveBeenCalledOnce();
    expect(JSON.stringify(fake.sent[2]!.card)).toContain('所选模型无效或已下架');
  });
});
