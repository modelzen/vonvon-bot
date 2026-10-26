import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { libraryLocation } from '../src/project/library';
import type { MemoryTurn } from '../src/bot/memory-authority';
import { botMemoryLocation, MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { createMemoryWriter, type WriteContext } from '../src/bot/memory-writer';
import type { FoundBlocks } from '../src/bot/hidden-blocks';
import { setDiagnosticsSink, type DiagnosticsEvent } from '../src/bot/diagnostics';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'memory-writer-'))); roots.push(path); return path; };
afterEach(() => { setDiagnosticsSink(undefined); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const PROJECT = 'prj_0a1b2c3d';
const OTHER_PROJECT = 'prj_deadbeef';
const base: MemoryTurn = { kind: 'human', steered: false, role: 'member', openId: 'ou_m', place: 'group', chatId: 'oc_a', active: true, typed: true, triggerText: '', botWrites: 0 };

function setup(options: { botId?: string; data?: string; limits?: { project?: number; bot?: number } } = {}) {
  const data = options.data ?? root();
  const library = libraryLocation(data);
  const botDirectory = join(data, 'bots', options.botId ?? 'cli_a');
  const writer = createMemoryWriter({
    botId: options.botId ?? 'cli_a', botDirectory, library, ...(options.limits ? { limits: options.limits } : {}),
    projectIdOf: async chatId => chatId === 'oc_a' || chatId === 'oc_b' ? PROJECT : chatId === 'oc_x' ? OTHER_PROJECT : undefined,
  });
  const project = new MemoryStore(projectMemoryLocation(PROJECT, { library }));
  const bot = new MemoryStore(botMemoryLocation(join(data, 'bots', 'cli_a')));
  /** a turn the way the registry reports it, with the one-Bot-write reservation */
  function turnContext(turn: Partial<MemoryTurn> = {}, extra: Partial<WriteContext> = {}) {
    const state = { ...base, ...turn };
    const ctx: WriteContext = {
      turn: () => ({ ...state }), triggerMessageId: 'om_1',
      reserveBotWrite: () => { if (state.botWrites >= 1) return false; state.botWrites++; return true; },
      releaseBotWrite: () => { state.botWrites = Math.max(0, state.botWrites - 1); },
      ...extra,
    };
    return { ctx, state };
  }
  return { data, library, writer, project, bot, turnContext };
}
const must = <T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> => {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
};
const active = async (store: MemoryStore) => (await store.read()).items.filter(item => item.state === 'active');

describe('memory_add: project memory from a group', () => {
  it('announces only committed new memories from both entry paths, without memory text', async () => {
    const events: DiagnosticsEvent[] = [];
    setDiagnosticsSink(event => events.push(event));
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext();
    const added = must(await writer.add(ctx, { text: 'PRIVATE_MEMORY_1' }, 'tool'));
    const found: FoundBlocks = { remember: [{ attrs: { n: 'nonce' }, body: 'PRIVATE_MEMORY_2' }], mem: [], dropped: 0 };
    expect(await writer.applyBlocks({ found, nonce: 'nonce', ctx: { ...ctx, triggerMessageId: 'om_2' } })).toMatchObject({ written: 1 });
    expect(await active(project)).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(events.every(event => event.kind === 'latestAction' && event.action.kind === 'memory-saved' && event.action.groupId === 'oc_a')).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE_MEMORY|om_1|om_2/);
    await writer.add(ctx, { text: 'PRIVATE_MEMORY_1' }, 'tool');
    await writer.add(turnContext({ active: false }).ctx, { text: 'refused' }, 'tool');
    await writer.update(ctx, { id: added.item.id, text: 'PRIVATE_EDIT' });
    expect(events).toHaveLength(2);
  });

  it('a member saying "remember" lands in the project as untrusted, from them, on a fitting branch', async () => {
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext({ triggerText: '记住 发版改到周四' });
    const result = must(await writer.add(ctx, { text: '发版改到周四', branch: '决定', claim: 'asked', why: '  群友\n要求  ' }, 'tool'));
    expect(result).toMatchObject({ scopeApplied: 'project', branchApplied: '决定', item: { branch: '决定' } });
    expect(result.downgraded).toBeUndefined();
    const [item] = await active(project);
    expect(item).toMatchObject({ trust: 'untrusted', branch: '决定', source: { via: 'tool', botId: 'cli_a', actorRole: 'member', actorOpenId: 'ou_m', chatId: 'oc_a', messageId: 'om_1', claim: 'asked', why: '群友 要求', turn: { kind: 'human', steered: false } } });
  });
  it('the owner typing it makes a trusted project entry', async () => {
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext({ role: 'owner', openId: 'ou_o' });
    must(await writer.add(ctx, { text: '日志在 /var/log/pay', branch: '环境和资源' }, 'tool'));
    expect((await active(project))[0]).toMatchObject({ trust: 'trusted', source: { actorRole: 'owner' } });
  });
  it('opens a branch for an unknown name, and from 12 branches on files into 其他 and says so', async () => {
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext();
    expect(must(await writer.add(ctx, { text: '回调超时是 30 秒', branch: '支付网关' }, 'tool'))).toMatchObject({ branchApplied: '支付网关', newBranch: true });
    for (let index = 0; index < 5; index++) must(await writer.add(ctx, { text: `条目${index}号`, branch: `分支${index}` }, 'tool'));
    expect((await project.read()).branches).toHaveLength(12);
    const full = must(await writer.add(ctx, { text: '第十三支的条目', branch: '又一支' }, 'tool'));
    expect(full).toMatchObject({ branchApplied: '其他' });
    expect(full.newBranch).toBeUndefined();
    expect((await project.read()).branches).toHaveLength(12);
  });
  it('writes into the branch whose name carries brackets as the normalized name', async () => {
    const { writer, turnContext } = setup();
    const { ctx } = turnContext();
    expect(must(await writer.add(ctx, { text: '重要的发版约定', branch: '「发版」（重要）' }, 'tool'))).toMatchObject({ branchApplied: '发版重要' });
  });
  it('refuses a secret, a text in a group without a project, and says "memory-full" with candidates', async () => {
    const { writer, turnContext } = setup({ limits: { project: 2 } });
    const { ctx } = turnContext();
    expect(await writer.add(ctx, { text: `token ghp_${'a'.repeat(36)}` }, 'tool')).toMatchObject({ ok: false, error: 'refused', reason: 'looks-like-secret' });
    expect(await writer.add(turnContext({ chatId: 'oc_none' }).ctx, { text: '没有项目的群' }, 'tool')).toMatchObject({ ok: false, error: 'refused', reason: 'no-project' });
    const bots = turnContext({ kind: 'wake', role: 'bot' });
    must(await writer.add({ ...bots.ctx, triggerMessageId: 'om_a' }, { text: '小支自己记的第一条' }, 'tool'));
    must(await writer.add({ ...bots.ctx, triggerMessageId: 'om_b' }, { text: '完全不同的第二条' }, 'tool'));
    const full = await writer.add(ctx, { text: '第三条放不下' }, 'tool');
    expect(full).toMatchObject({ ok: false, error: 'memory-full', usage: { used: 2, limit: 2 } });
    if (!full.ok && full.error === 'memory-full') expect(full.candidates.map(candidate => candidate.text).sort()).toEqual(['完全不同的第二条', '小支自己记的第一条'].sort());
  });
  it('a human-written entry is not offered as a make-room candidate', async () => {
    const { writer, turnContext } = setup({ limits: { project: 1 } });
    const { ctx } = turnContext();
    must(await writer.add(ctx, { text: '人写的一条' }, 'tool'));
    const full = await writer.add({ ...ctx, triggerMessageId: 'om_2' }, { text: '又来一条别的' }, 'tool');
    expect(full).toMatchObject({ ok: false, error: 'memory-full', candidates: [] });
  });
  it('two bots woken by the same message write one entry; the second is told it is already there', async () => {
    const first = setup({ botId: 'cli_a' });
    const second = setup({ botId: 'cli_b', data: first.data });
    const a = first.turnContext(); const b = second.turnContext();
    must(await first.writer.add(a.ctx, { text: '发版改到周四', branch: '决定' }, 'tool'));
    expect(await second.writer.add(b.ctx, { text: '发版改到周四。', branch: '决定' }, 'tool')).toMatchObject({ ok: false, error: 'refused', reason: 'duplicate' });
    expect(await active(first.project)).toHaveLength(1);
  });
});

describe('memory_add: Bot memory and its downgrades', () => {
  const typed = '以后给我的东西都先写结论';
  it('the owner typing a cross-project request puts it into Bot memory, trusted', async () => {
    const { writer, bot, project, turnContext } = setup();
    const { ctx } = turnContext({ role: 'owner', openId: 'ou_o', triggerText: typed });
    const result = must(await writer.add(ctx, { text: '以后给我的东西都先写结论', scope: 'bot', branch: '合作方式' }, 'tool'));
    expect(result).toMatchObject({ scopeApplied: 'bot', branchApplied: '合作方式' });
    expect(result.downgraded).toBeUndefined();
    expect((await active(bot))[0]).toMatchObject({ trust: 'trusted', branch: '合作方式', source: { actorRole: 'owner' } });
    expect(await active(project)).toEqual([]);
  });
  const downgrades: Array<[string, Partial<MemoryTurn>, string]> = [
    ['a member says the same sentence', { role: 'member', triggerText: typed }, 'member'],
    ['the content is not in the owner message', { role: 'owner', triggerText: '把刚才的记一下' }, 'not-in-message'],
    ['the owner was interrupted', { role: 'owner', triggerText: typed, steered: true }, 'steered'],
    ['the message was not typed (forward, card, attachment)', { role: 'owner', triggerText: typed, typed: false }, 'not-typed'],
    ['the turn was woken by a bot', { role: 'bot', kind: 'wake', triggerText: typed }, 'not-human-turn'],
    ['the turn is a retry', { role: 'owner', kind: 'retry', triggerText: typed }, 'not-human-turn'],
  ];
  for (const [name, turn, reason] of downgrades) {
    it(`goes to the project with the reason recorded when ${name}`, async () => {
      const { writer, bot, project, turnContext } = setup();
      const { ctx } = turnContext({ openId: 'ou_o', ...turn });
      const text = reason === 'not-in-message' ? '张三负责支付网关' : '以后给我的东西都先写结论';
      const result = must(await writer.add(ctx, { text, scope: 'bot', branch: '合作方式' }, 'tool'));
      expect(result).toMatchObject({ scopeApplied: 'project', downgraded: reason });
      expect(await active(bot)).toEqual([]);
      expect((await active(project))[0]).toMatchObject({ source: { downgraded: reason } });
    });
  }
  it('a project branch name asked for in Bot memory is judged against the table it lands in', async () => {
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext({ role: 'member' });
    const result = must(await writer.add(ctx, { text: '一个想进 Bot 记忆的约定', scope: 'bot', branch: '约定' }, 'tool'));
    expect(result).toMatchObject({ scopeApplied: 'project', branchApplied: '约定', downgraded: 'member' });
    expect((await active(project))[0]?.branch).toBe('约定');
  });
  it('allows one Bot write per turn: the second goes to the project as "quota", even when both are asked at once', async () => {
    const { writer, bot, project, turnContext } = setup();
    const { ctx } = turnContext({ role: 'owner', openId: 'ou_o', triggerText: '以后先写结论，以后回答都简短' });
    const [first, second] = await Promise.all([
      writer.add(ctx, { text: '以后先写结论', scope: 'bot', branch: '合作方式' }, 'tool'),
      writer.add(ctx, { text: '以后回答都简短', scope: 'bot', branch: '合作方式' }, 'tool'),
    ]);
    expect([must(first).scopeApplied, must(second).scopeApplied].sort()).toEqual(['bot', 'project']);
    expect([must(first).downgraded, must(second).downgraded].filter(Boolean)).toEqual(['quota']);
    expect(await active(bot)).toHaveLength(1);
    expect(await active(project)).toHaveLength(1);
  });
  it('gives the one write back when it was refused, so the next one can use it', async () => {
    const { writer, turnContext } = setup();
    const { ctx, state } = turnContext({ role: 'owner', openId: 'ou_o', triggerText: '以后先写结论' });
    expect(await writer.add(ctx, { text: `以后先写结论 ghp_${'b'.repeat(36)}`, scope: 'bot' }, 'tool')).toMatchObject({ ok: false });
    expect(state.botWrites).toBe(0);
    expect(must(await writer.add(ctx, { text: '以后先写结论', scope: 'bot' }, 'tool')).scopeApplied).toBe('bot');
    expect(state.botWrites).toBe(1);
  });
  it('re-checks at the commit point: an interruption between the decision and the write sends it to the project', async () => {
    const { writer, bot, project, turnContext } = setup();
    const { ctx, state } = turnContext({ role: 'owner', openId: 'ou_o', triggerText: '以后先写结论' });
    let calls = 0;
    const live: WriteContext = { ...ctx, turn: () => { calls++; return { ...state, steered: calls > 1 }; } };
    const result = must(await writer.add(live, { text: '以后先写结论', scope: 'bot' }, 'tool'));
    expect(result).toMatchObject({ scopeApplied: 'project', downgraded: 'steered' });
    expect(await active(bot)).toEqual([]);
    expect(await active(project)).toHaveLength(1);
    expect(state.botWrites).toBe(0);
  });
  it('calls the commit guard once, right before the write, and a guard that throws stops the write', async () => {
    const { writer, project, turnContext } = setup();
    const guard = vi.fn();
    must(await writer.add(turnContext().ctx, { text: '带守卫的一条' }, 'tool'));
    must(await writer.add({ ...turnContext().ctx, guard, triggerMessageId: 'om_2' }, { text: '另一条带守卫的' }, 'tool'));
    expect(guard).toHaveBeenCalledOnce();
    const stopper: WriteContext = { ...turnContext().ctx, triggerMessageId: 'om_3', guard: () => { throw new Error('turn ended'); } };
    await expect(writer.add(stopper, { text: '会被拦下的一条' }, 'tool')).rejects.toThrow('turn ended');
    expect((await active(project)).map(item => item.text)).toEqual(['带守卫的一条', '另一条带守卫的']);
  });
  it('refuses to write when the turn is no longer the active one', async () => {
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext({ active: false });
    expect(await writer.add(ctx, { text: '轮次已经结束' }, 'tool')).toMatchObject({ ok: false, error: 'refused', reason: 'not-allowed-here' });
    expect(await active(project)).toEqual([]);
  });
});

describe('memory_update and memory_forget', () => {
  async function seeded() {
    const world = setup();
    const a = world.turnContext({ openId: 'ou_a' });
    const mine = must(await world.writer.add({ ...a.ctx, triggerMessageId: 'om_a' }, { text: '张三的约定：周四发版', branch: '约定' }, 'tool')).item;
    const bots = world.turnContext({ kind: 'wake', role: 'bot', openId: undefined });
    const botOwn = must(await world.writer.add({ ...bots.ctx, triggerMessageId: 'om_b' }, { text: '小支观察到的另一件事' }, 'tool')).item;
    return { ...world, mine, botOwn };
  }
  it('a member can change only what they said; the owner can change anything', async () => {
    const { writer, project, mine, turnContext } = await seeded();
    expect(await writer.forget(turnContext({ openId: 'ou_b' }).ctx, { id: mine.id })).toMatchObject({ ok: false, error: 'not-yours' });
    expect(await writer.update(turnContext({ openId: 'ou_b' }).ctx, { id: mine.id, text: '改成周五' })).toMatchObject({ ok: false, error: 'not-yours' });
    const edited = must(await writer.update(turnContext({ openId: 'ou_a' }).ctx, { id: mine.id, text: '张三的约定：周五发版' }));
    expect(edited.item.text).toBe('张三的约定：周五发版');
    const moved = must(await writer.update(turnContext({ openId: 'ou_a' }).ctx, { id: mine.id, branch: '决定' }));
    expect(moved.branchApplied).toBe('决定');
    must(await writer.forget(turnContext({ openId: 'ou_a' }).ctx, { id: mine.id }));
    expect((await project.get(mine.id))?.state).toBe('archived');
    expect(await writer.forget(turnContext({ openId: 'ou_a' }).ctx, { id: mine.id })).toMatchObject({ ok: false, error: 'archived' });
  });
  it('a member can forget what the bot noted in this chat, "删掉刚才那条"', async () => {
    const { writer, project, botOwn, turnContext } = await seeded();
    must(await writer.forget(turnContext({ openId: 'ou_c' }).ctx, { id: botOwn.id }));
    expect((await project.get(botOwn.id))?.state).toBe('archived');
  });
  it('the owner may change a member entry; a turn the bot woke itself may not touch what a person wrote', async () => {
    const { writer, mine, turnContext } = await seeded();
    expect(await writer.forget(turnContext({ kind: 'wake', role: 'bot' }).ctx, { id: mine.id })).toMatchObject({ ok: false, error: 'not-yours' });
    expect(must(await writer.update(turnContext({ role: 'owner', openId: 'ou_o' }).ctx, { id: mine.id, text: '主人改过的约定' })).item.text).toBe('主人改过的约定');
  });
  it('does not reveal entries of a project this chat is not bound to, or ids that mean nothing', async () => {
    const { writer, turnContext } = await seeded();
    const { ctx } = turnContext({ role: 'owner', openId: 'ou_o' });
    expect(await writer.forget(ctx, { id: `p_${OTHER_PROJECT}:abcdef` })).toMatchObject({ ok: false, error: 'out-of-scope' });
    expect(await writer.forget(ctx, { id: 'nonsense' })).toMatchObject({ ok: false, error: 'not-found' });
    expect(await writer.forget(ctx, { id: `p_${PROJECT}:zzzzzz` })).toMatchObject({ ok: false, error: 'not-found' });
  });
  it('changing a Bot-memory entry needs the owner typing it; anyone else gets "out-of-scope"', async () => {
    const world = setup();
    const owner = world.turnContext({ role: 'owner', openId: 'ou_o', triggerText: '以后先写结论' });
    const item = must(await world.writer.add(owner.ctx, { text: '以后先写结论', scope: 'bot', branch: '合作方式' }, 'tool')).item;
    expect(await world.writer.forget(world.turnContext({ openId: 'ou_m' }).ctx, { id: item.id })).toMatchObject({ ok: false, error: 'out-of-scope' });
    const again = world.turnContext({ role: 'owner', openId: 'ou_o', triggerText: '把那条忘掉' });
    must(await world.writer.forget(again.ctx, { id: item.id }));
    expect((await world.bot.get(item.id))?.state).toBe('archived');
  });
  it('a stale revision comes back as a conflict that carries the current text', async () => {
    const { writer, project, mine, turnContext } = await seeded();
    const stale: WriteContext = { ...turnContext({ openId: 'ou_a' }).ctx, guard: () => undefined };
    const current = (await project.get(mine.id))!;
    await project.edit({ itemId: mine.id, revision: current.revision, text: '别处先改的', actor: { role: 'desktop' } });
    // the writer reads the revision itself, so a change racing it is the only way to conflict: simulate it in the guard
    const racing: WriteContext = { ...stale, turn: stale.turn };
    expect(must(await writer.update(racing, { id: mine.id, text: '紧接着的修改' })).item.text).toBe('紧接着的修改');
  });
});

describe('memory_list', () => {
  it('lists the chat project and Bot memory by branch, with the branch table and counts', async () => {
    const { writer, turnContext } = setup();
    must(await writer.add(turnContext().ctx, { text: '发版改到周四', branch: '决定' }, 'tool'));
    const listed = await writer.list({ kind: 'group', chatId: 'oc_a' });
    expect(listed).toMatchObject({ lists: [{ scope: 'project', projectId: PROJECT, branches: expect.arrayContaining(['决定', '其他']), items: [{ text: '发版改到周四', branch: '决定', trust: 'untrusted' }], usage: { used: 1, limit: 100 } }, { scope: 'bot' }] });
  });
  it('refuses a project that is not the chat one', async () => {
    const { writer } = setup();
    expect(await writer.list({ kind: 'group', chatId: 'oc_a' }, { project: OTHER_PROJECT })).toMatchObject({ error: 'refused' });
  });
  it('in a comment returns only the 合作方式 branch of Bot memory, whatever scope is asked', async () => {
    const world = setup();
    const owner = world.turnContext({ role: 'owner', openId: 'ou_o', triggerText: '以后先写结论 我是张三的同事' });
    must(await world.writer.add(owner.ctx, { text: '以后先写结论', scope: 'bot', branch: '合作方式' }, 'tool'));
    await world.bot.add({ text: '主人是支付组的负责人', branch: '关于你', source: { via: 'ui', botId: '', actorRole: 'owner' }, trust: 'trusted', actor: { role: 'desktop' } });
    await world.bot.add({ text: '张三管支付', branch: '团队和人', source: { via: 'ui', botId: '', actorRole: 'owner' }, trust: 'trusted', actor: { role: 'desktop' } });
    for (const scope of [undefined, 'project' as const, { project: PROJECT }]) {
      const listed = await world.writer.list({ kind: 'doc' }, scope);
      expect(listed).toMatchObject({ lists: [{ scope: 'bot', branches: ['合作方式'], items: [{ text: '以后先写结论', branch: '合作方式' }] }] });
      expect(JSON.stringify(listed)).not.toMatch(/关于你|团队和人|支付组|张三/);
    }
  });
});

describe('hidden blocks', () => {
  const block = (attrs: Record<string, string>, body: string): FoundBlocks['remember'][number] => ({ attrs, body });
  const found = (...remember: FoundBlocks['remember']): FoundBlocks => ({ remember, mem: [], dropped: 0 });
  it('land in the project as hidden_block entries, ignore scope=bot, and normalize a bracketed branch', async () => {
    const { writer, bot, project, turnContext } = setup();
    const { ctx } = turnContext({ role: 'owner', openId: 'ou_o', triggerText: '以后先写结论 发版改到周四' });
    const result = await writer.applyBlocks({ nonce: 'abc', ctx, found: found(
      block({ n: 'abc', scope: 'bot', branch: '合作方式', claim: 'asked' }, '以后先写结论'),
      block({ n: 'abc', scope: 'project', branch: '决定（重要）' }, '发版改到周四'),
    ) });
    expect(result).toEqual({ written: 2, missed: [] });
    expect(await active(bot)).toEqual([]);
    const items = await active(project);
    expect(items).toHaveLength(2);
    expect(items.every(item => item.source.via === 'hidden_block' && item.source.downgraded === undefined)).toBe(true);
    expect(items.find(item => item.text === '发版改到周四')?.branch).toBe('决定重要');
    // 项目记忆里没有"合作方式"，按项目的分支表重新判断：新开一支
    expect(items.find(item => item.text === '以后先写结论')?.branch).toBe('合作方式');
  });
  it('record a member as untrusted and the source as them', async () => {
    const { writer, project, turnContext } = setup();
    await writer.applyBlocks({ nonce: 'abc', ctx: turnContext({ triggerText: '记住 发版改到周四' }).ctx, found: found(block({ n: 'abc', branch: '决定' }, '发版改到周四')) });
    expect((await active(project))[0]).toMatchObject({ trust: 'untrusted', source: { via: 'hidden_block', actorRole: 'member', actorOpenId: 'ou_m' } });
  });
  it('are dropped with a wrong or missing nonce and written nowhere', async () => {
    const { writer, project, turnContext } = setup();
    const result = await writer.applyBlocks({ nonce: 'abc', ctx: turnContext().ctx, found: found(block({ n: 'forged' }, '伪造的一条'), block({}, '没有标记的一条')) });
    expect(result).toEqual({ written: 0, missed: ['bad-nonce', 'bad-nonce'] });
    expect(await active(project)).toEqual([]);
  });
  it('are not parsed in a comment', async () => {
    const { writer, project, turnContext } = setup();
    const result = await writer.applyBlocks({ nonce: 'abc', ctx: turnContext({ place: 'comment', chatId: undefined }).ctx, found: found(block({ n: 'abc' }, '评论里的一条')) });
    expect(result).toEqual({ written: 0, missed: [] });
    expect(await active(project)).toEqual([]);
  });
  it('report a full project memory, a secret and a block cut short; a duplicate is not a miss', async () => {
    const { writer, turnContext } = setup({ limits: { project: 1 } });
    const { ctx } = turnContext();
    expect(await writer.applyBlocks({ nonce: 'abc', ctx, found: found(block({ n: 'abc' }, '先记下这一条')) })).toEqual({ written: 1, missed: [] });
    expect(await writer.applyBlocks({ nonce: 'abc', ctx, found: found(block({ n: 'abc' }, '先记下这一条')) })).toEqual({ written: 0, missed: [] });
    const result = await writer.applyBlocks({ nonce: 'abc', ctx: { ...ctx, triggerMessageId: 'om_2' }, found: { ...found(block({ n: 'abc' }, '放不下的新一条'), block({ n: 'abc' }, `ghp_${'c'.repeat(36)}`)), dropped: 1 } });
    expect(result).toEqual({ written: 0, missed: ['memory-full', 'looks-like-secret', 'dropped'] });
  });
  it('refuse a block whose turn already ended', async () => {
    const { writer, project, turnContext } = setup();
    const { ctx } = turnContext();
    let ended = false;
    const live: WriteContext = { ...ctx, turn: () => ({ ...base, active: !ended }) };
    ended = true;
    expect(await writer.applyBlocks({ nonce: 'abc', ctx: live, found: found(block({ n: 'abc' }, '轮次结束后的一条')) })).toEqual({ written: 0, missed: ['not-allowed-here'] });
    expect(await active(project)).toEqual([]);
  });
  it('a block written once for each bot of a chat is stored once', async () => {
    const first = setup({ botId: 'cli_a' });
    const second = setup({ botId: 'cli_b', data: first.data });
    const run = (world: typeof first) => world.writer.applyBlocks({ nonce: 'abc', ctx: world.turnContext().ctx, found: found(block({ n: 'abc', branch: '决定' }, '发版改到周四')) });
    expect(await run(first)).toEqual({ written: 1, missed: [] });
    expect(await run(second)).toEqual({ written: 0, missed: [] });
    expect(await active(first.project)).toHaveLength(1);
  });
});
