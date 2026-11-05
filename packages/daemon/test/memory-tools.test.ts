import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentThread } from '../src/agent/types';
import { createCommandTools } from '../src/agent/entry/command-tools';
import { createAgentEntries, type AgentPlace, type TurnFacts } from '../src/agent/entry/registry';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../src/agent/bridge-instructions';
import { buildHistoryCard } from '../src/card/history-card';
import { libraryLocation } from '../src/project/library';
import { botMemoryLocation, MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { createMemoryWriter } from '../src/bot/memory-writer';

vi.mock('../src/core/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), fail: vi.fn() } }));

const roots: string[] = [];
const root = (): string => { const path = realpathSync(mkdtempSync(join(tmpdir(), 'memory-tools-'))); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

const PROJECT = 'prj_0a1b2c3d';
const facts = (extra: Partial<TurnFacts> = {}): TurnFacts => ({ requesterOpenId: 'ou_m', requesterKind: 'user', triggerMessageId: 'om_1', retry: false, initiative: false, wake: false, typed: true, triggerText: '记住 发版改到周四', ...extra });
function thread(): AgentThread {
  return {
    sessionId: 'fixture', isAlive: vi.fn(() => true), close: vi.fn(async () => {}),
    runStreamed: () => { throw Error('unused'); }, runGoal: () => { throw Error('unused'); },
    clearGoal: async () => {}, steer: async () => {}, abort: async () => {},
    compact: async () => ({ compacted: false, usage: null }),
  };
}
function world() {
  const data = root();
  const library = libraryLocation(data);
  const memory = createMemoryWriter({ botId: 'cli_a', botDirectory: join(data, 'bots', 'cli_a'), library, projectIdOf: async chatId => chatId === 'oc_a' ? PROJECT : undefined });
  const tools = createCommandTools({ appId: 'cli_a', memory, groups: async () => ({ groups: [] }) as never, members: async () => ({ members: [] }) as never });
  const entries = createAgentEntries({ appId: 'cli_a', tools, isAdmin: id => id === 'ou_o' });
  function session(place: AgentPlace, turn: TurnFacts) {
    const entry = entries.issue(place); const t = thread(); entry.attach(t);
    const scope = entries.openTurn(t, turn); entry.noteToolUse('u1');
    return { entry, scope, call: (name: string, args: unknown) => entry.call(name, args, { toolUseId: 'u1' }) };
  }
  return {
    data, session,
    project: new MemoryStore(projectMemoryLocation(PROJECT, { library })),
    bot: new MemoryStore(botMemoryLocation(join(data, 'bots', 'cli_a'))),
  };
}

describe('the memory tools through the registry', () => {
  it('are registered only when a writer is given, and the comment session gets just the list', () => {
    const base = { appId: 'cli_a', groups: async () => ({}) as never, members: async () => ({}) as never };
    expect(createCommandTools(base).map(tool => tool.name)).not.toContain('memory_add');
    const w = world();
    const group = w.session({ kind: 'group', chatId: 'oc_a' }, facts());
    expect(group.entry.tools().map(tool => tool.name)).toEqual(expect.arrayContaining(['memory_add', 'memory_update', 'memory_forget', 'memory_list']));
    const doc = w.session({ kind: 'doc', docId: 'd1' }, facts());
    expect(doc.entry.tools().map(tool => tool.name).filter(name => name.startsWith('memory_'))).toEqual(['memory_list']);
  });
  it('a group member says "remember": it is stored as theirs, untrusted, and the result names the branch', async () => {
    const w = world();
    const group = w.session({ kind: 'group', chatId: 'oc_a' }, facts());
    const reply = await group.call('memory_add', { text: '发版改到周四', branch: '决定', claim: 'asked' });
    expect(reply).toMatchObject({ ok: true, result: { ok: true, scopeApplied: 'project', branchApplied: '决定', item: { text: '发版改到周四' } } });
    const [item] = (await w.project.read()).items;
    expect(item).toMatchObject({ trust: 'untrusted', source: { via: 'tool', actorRole: 'member', actorOpenId: 'ou_m', messageId: 'om_1', turn: { kind: 'human', steered: false } } });
  });
  it('"删掉刚才那条": the member forgets their own; someone else cannot; the answer is a result the model can speak from', async () => {
    const w = world();
    const mine = w.session({ kind: 'group', chatId: 'oc_a' }, facts());
    const added = await mine.call('memory_add', { text: '发版改到周四' });
    const id = (added as { result: { item: { id: string } } }).result.item.id;
    const other = w.session({ kind: 'group', chatId: 'oc_a' }, facts({ requesterOpenId: 'ou_z', triggerMessageId: 'om_2' }));
    expect(await other.call('memory_forget', { id })).toMatchObject({ ok: true, result: { ok: false, error: 'not-yours' } });
    expect(await mine.call('memory_forget', { id })).toMatchObject({ ok: true, result: { ok: true } });
    expect((await w.project.get(id))?.state).toBe('archived');
  });
  it('the owner typing a cross-project request reaches Bot memory; the same words from a member do not', async () => {
    const w = world();
    const text = '以后给我的东西都先写结论';
    const owner = w.session({ kind: 'group', chatId: 'oc_a' }, facts({ requesterOpenId: 'ou_o', triggerText: text }));
    expect(await owner.call('memory_add', { text, scope: 'bot', branch: '合作方式' })).toMatchObject({ result: { scopeApplied: 'bot' } });
    expect(await w.bot.read()).toMatchObject({ used: 1 });
    const member = w.session({ kind: 'group', chatId: 'oc_a' }, facts({ triggerText: text, triggerMessageId: 'om_9' }));
    expect(await member.call('memory_add', { text, scope: 'bot' })).toMatchObject({ result: { scopeApplied: 'project', downgraded: 'member' } });
  });
  it('memory_list in a comment shows only the 合作方式 branch, whatever the scope argument says', async () => {
    const w = world();
    await w.bot.add({ text: '给主人的东西先写结论', branch: '合作方式', source: { via: 'ui', botId: '', actorRole: 'owner' }, trust: 'trusted', actor: { role: 'desktop' } });
    await w.bot.add({ text: '主人是支付组的负责人', branch: '关于你', source: { via: 'ui', botId: '', actorRole: 'owner' }, trust: 'trusted', actor: { role: 'desktop' } });
    const doc = w.session({ kind: 'doc', docId: 'd1' }, facts());
    const reply = await doc.call('memory_list', { scope: 'project' });
    expect(reply).toMatchObject({ ok: true, result: { lists: [{ scope: 'bot', branches: ['合作方式'], items: [{ text: '给主人的东西先写结论' }] }] } });
    expect(JSON.stringify(reply)).not.toContain('支付组');
    expect(await doc.call('memory_add', { text: '评论里不能写' })).toMatchObject({ ok: false, code: 'unknown-tool' });
  });
  it('rejects a call with arguments the schema does not know', async () => {
    const w = world();
    const group = w.session({ kind: 'group', chatId: 'oc_a' }, facts());
    expect(await group.call('memory_add', { text: '', branch: 1 })).toMatchObject({ ok: false, code: 'bad-args' });
    expect(await group.call('memory_add', { text: 'x', trust: 'trusted' })).toMatchObject({ ok: false, code: 'bad-args' });
  });
});

describe('what the model is told', () => {
  const descriptions = (): string => createCommandTools({ appId: 'x', memory: {} as never, groups: async () => ({}) as never, members: async () => ({}) as never })
    .filter(tool => tool.name.startsWith('memory_')).map(tool => tool.description).join('\n');
  it('says: remember in your own words in the reply; pick the branch from the list; not a receipt, not where it was kept', () => {
    const text = descriptions();
    expect(text).toContain('像平常说话一样带一句');
    expect(text).toContain('不说记在哪个项目、哪一层');
    expect(text).toContain('分支："那一行');
    expect(text).toContain('12 字以内');
    expect(text).toContain('补充职责');
    expect(text).toContain('没记成');
    expect(text).not.toMatch(/回执|按钮|表情|参考了/);
  });
  it('the fixed prefix carries the same rule and no longer sends memory to files', () => {
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('memory_add / memory_update / memory_forget');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('<vonvon-remember>');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('像平常说话一样带一句');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).toContain('不列记了什么、记在哪，不另发消息');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).not.toContain('只写 vonvon 提供的记忆文件');
    expect(BRIDGE_DEVELOPER_INSTRUCTIONS).not.toMatch(/回执|按钮|参考了/);
  });
});

describe('the history card', () => {
  it('shows no hidden block, in the turn or in 上次停在', () => {
    const card = JSON.stringify(buildHistoryCard({
      cwd: '/p', backendName: 'Codex',
      history: { totalTurns: 1, turns: [{ userText: '记住发版改到周四', reasoning: '', tools: [], assistantText: '好，记住了。\n<vonvon-remember n="7f3a" scope="project" branch="决定">发版改到周四</vonvon-remember>' }] },
    }));
    expect(card).toContain('好，记住了。');
    expect(card).not.toContain('vonvon-remember');
    expect(card).not.toContain('7f3a');
  });
});
