import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contextPreviewReplySchema, contextPreviewRequestSchema } from '@vonvon/protocol';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config/paths', async () => {
  const { join } = await import('node:path');
  const botDir = (appId: string) => join(fixture.root, 'bots', appId);
  const botPaths = (appId: string) => {
    const dir = botDir(appId);
    return { dir, configFile: join(dir, 'config.json'), sessionsFile: join(dir, 'sessions.json'), projectsFile: join(dir, 'projects.json'),
      processesFile: join(dir, 'processes.json'), setupFile: join(dir, 'setup.json'), topicsDir: join(dir, 'topics'),
      droppedFile: join(dir, 'dropped.json'), judgeUsageFile: join(dir, 'judge-usage.json') };
  };
  return { botDir, botPaths, paths: { get appDir() { return fixture.root; } } };
});
vi.mock('../src/config/bots', async original => ({ ...await original<object>(), loadBots: async () => ({ version: 1, bots: [{ appId: 'cli_a', name: 'a' }] }) }));

import { assemble, contextOf, loadContextSources, planTurnUpdate } from '../src/bot/context-assembly';
import {writeJudgeModels} from '../src/judge/global-models';
import { contextPreview } from '../src/admin/context-preview';
import { createLibraryProject, libraryLocation } from '../src/project/library';
import { botMemoryLocation, dmMemoryLocation, MemoryStore, projectMemoryLocation } from '../src/bot/memory-store';
import { settleTurn } from '../src/bot/turn-usage';

const CHAT = 'oc_here';
let work: string;
beforeEach(() => {
  fixture.root = realpathSync(mkdtempSync(join(tmpdir(), 'context-preview-')));
  work = realpathSync(mkdtempSync(join(tmpdir(), 'context-preview-work-')));
});
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });

const botDir = (): string => join(fixture.root, 'bots', 'cli_a');
const owner = { via: 'tool', botId: 'cli_a', actorRole: 'owner', actorOpenId: 'ou_o', chatId: CHAT } as const;

async function world(options: { judge?: unknown; workRules?: string } = {}) {
  mkdirSync(botDir(), { recursive: true });
  writeFileSync(join(botDir(), 'SOUL.md'), '## 身份与职责\n支付组的发布助手\n\n## 其他说明\n先说结论\n');
  // what the project's own files say must never reach the result
  writeFileSync(join(work, 'AGENTS.md'), '项目规矩 SECRET-AGENTS-TEXT');
  writeFileSync(join(work, 'CLAUDE.md'), '项目规矩 SECRET-CLAUDE-TEXT');
  const library = libraryLocation(fixture.root);
  const project = await createLibraryProject({ name: '支付组', workspace: { primary: work, additional: [] }, createdBy: { botId: 'cli_a', chatId: CHAT } }, library);
  const row = { name: '支付组群', chatId: CHAT, cwd: work, projectId: project.id, supplement: '只管发布', ...(options.workRules !== undefined ? { workRules: options.workRules } : {}), ...(options.judge ? { judge: options.judge } : {}) };
  writeFileSync(join(botDir(), 'projects.json'), JSON.stringify({ version: 1, projects: [row] }));
  const store = new MemoryStore(projectMemoryLocation(project.id, { library }));
  const bot = new MemoryStore(botMemoryLocation(botDir()));
  const add = async (target: MemoryStore, text: string, branch: string, trust: 'trusted' | 'untrusted' = 'trusted') => {
    const result = await target.add({ text, branch, source: owner, trust, actor: { role: 'owner', openId: 'ou_o' } });
    if (!result.ok) throw new Error(result.message);
    return result.item.id;
  };
  const sources = () => loadContextSources({ appId: 'cli_a', botName: '小支', place: { kind: 'group', chatId: CHAT, chatName: '支付组群' }, row: row as never, library, botDirectory: botDir() });
  const sessions = (records: unknown[]) => writeFileSync(join(botDir(), 'sessions.json'), JSON.stringify({ version: 3, sessions: records }));
  const preview = (running: boolean, threadId?: string) => contextPreview(
    { type: 'get', agentId: 'cli_a' as never, place: { kind: 'group', groupId: CHAT as never }, ...(threadId ? { threadId } : {}) }, { running, botName: '小支', library, botDirectory: botDir() });
  return { library, project, row, store, bot, add, sources, sessions, preview };
}
const record = (extra: Record<string, unknown>) => ({ threadId: 'topic1', chatId: CHAT, cwd: work, sessionId: 'host', backend: 'codex-appserver', summary: '', createdAt: 1, updatedAt: 50, ...extra });

describe('contextPreview', () => {
  it('describes the actual host-default decision route instead of the task provider',async()=>{
    const w=await world({judge:{kind:'default'}});
    await writeJudgeModels({defaultProvider:'typesafe',byProvider:{typesafe:{model:'jev-latest'}}});
    expect((await w.preview(false)).judge).toMatchObject({via:'third-party',label:'typesafe jev-latest'});
    await writeJudgeModels({defaultProvider:'claude-agent',byProvider:{'claude-agent':{model:'custom-judge',custom:true}}});
    expect((await w.preview(false)).judge).toMatchObject({via:'local',label:'claude-agent custom-judge'});
  });
  it('is the same assembly the session is handed, and the reply parses', async () => {
    const w = await world();
    await w.add(w.store, '发版改到周四', '决定');
    await w.add(w.store, '日志在 /var/log/pay', '环境和资源', 'untrusted');
    await w.add(w.bot, '先说结论', '合作方式');
    const reply = await w.preview(false);
    expect(contextPreviewReplySchema.parse(reply)).toEqual(reply);
    const a = assemble(await w.sources());
    expect(reply.next.sections.map(section => [section.key, section.version])).toEqual(Object.entries(a.versions));
    expect(reply.next.items).toEqual({ bot: 1, trusted: 1, untrusted: 1 });
    expect(reply.next.sections.find(section => section.key === 'projectMemory')).toMatchObject({ items: 2 });
    expect(reply.next.sections.find(section => section.key === 'role')!.chars).toBeGreaterThan(10);
    expect(reply.next.sections.find(section => section.key === 'supplement')!.chars).toBe(4);
    // a Codex group has no memory tools: it leaves hidden blocks instead
    expect(reply.next.tools).toEqual([]);
  });

  it('shows the live session column only while the bot runs, and says which sections the session has not been handed yet', async () => {
    const w = await world();
    await w.add(w.store, '发版改到周四', '决定');
    const delivered = contextOf(assemble(await w.sources()), 'n0n0n0', 10);
    w.sessions([record({ context: delivered })]);
    expect((await w.preview(false)).session).toBeUndefined();
    const fresh = (await w.preview(true)).session!;
    expect(fresh).toMatchObject({ threadId: 'topic1', legacy: false, redeliverDue: false });
    expect(fresh.sections.every(section => !section.stale)).toBe(true);
    await w.add(w.store, '回滚窗口是晚上十点后', '决定');
    writeFileSync(join(botDir(), 'SOUL.md'), '## 身份与职责\n新的职责\n');
    const behind = (await w.preview(true)).session!;
    expect(behind.sections.filter(section => section.stale).map(section => section.key)).toEqual(['identity', 'role', 'projectMemory']);
    expect(behind.sections.find(section => section.key === 'projectMemory')).toMatchObject({ items: 1 });
    expect((await w.preview(true)).next.items.trusted).toBe(2);
  });

  it('marks a session without a record of what it got as an old one, and a compaction as due', async () => {
    const w = await world();
    w.sessions([record({})]);
    expect((await w.preview(true)).session).toMatchObject({ legacy: true, sections: [] });
    w.sessions([record({ context: { ...contextOf(assemble(await w.sources()), 'abc123'), fullRedeliverDue: true } })]);
    expect((await w.preview(true)).session).toMatchObject({ legacy: false, redeliverDue: true });
  });

  it('reads lastTurn from the record: counts by kind, and used entries with their text', async () => {
    const w = await world();
    const kept = await w.add(w.store, '发版改到周四', '决定');
    const note = await w.add(w.store, '日志在 /var/log/pay', '环境和资源', 'untrusted');
    const mine = await w.add(w.bot, '先说结论', '合作方式');
    const src = await w.sources();
    const settled = settleTurn(contextOf(assemble(src), 'n0n0n0', 10), `好\n<vonvon-mem n="n0n0n0" used="${kept},${mine},p_x:nope"/>`, 40);
    w.sessions([record({ context: settled.context })]);
    const turn = (await w.preview(true)).session!.lastTurn!;
    expect(turn).toMatchObject({ at: 40, injected: 3, items: { bot: 1, trusted: 1, untrusted: 1 } });
    expect(turn.used).toEqual([{ id: kept, text: '发版改到周四' }, { id: mine, text: '先说结论' }]);
    expect(turn.used.map(entry => entry.id)).not.toContain(note);
    await w.store.archive({ itemId: kept, revision: 1, actor: { role: 'owner', openId: 'ou_o' } });
    expect((await w.preview(true)).session!.lastTurn!.used[0]).toEqual({ id: kept });
  });

  it('carries the hidden blocks the daemon did not take, as reasons only', async () => {
    const w = await world();
    const src = await w.sources();
    const settled = settleTurn(contextOf(assemble(src), 'n0n0n0', 10), '好', 40).context;
    w.sessions([record({ context: { ...settled, lastTurn: { ...settled.lastTurn!, missed: ['像密钥', '项目记忆满了'] } } })]);
    expect((await w.preview(true)).session!.lastTurn!.missed).toEqual(['像密钥', '项目记忆满了']);
    w.sessions([record({ context: settled })]);
    expect((await w.preview(true)).session!.lastTurn).not.toHaveProperty('missed');
  });

  // dm-agent 10 (D4). main 必败: there was no preview of a private chat
  it('shows one person\'s private chat: their memory, no project\'s, no judge', async () => {
    const { bot, add, library } = await world();
    await add(bot, '大家都用的', '约定');
    const people = { oc_old: { openId: 'ou_a', name: '张三', at: 1 }, oc_new: { openId: 'ou_a', at: 5 }, oc_b: { openId: 'ou_b', at: 2 } };
    const rows = JSON.parse(readFileSync(join(botDir(), 'projects.json'), 'utf8')) as { projects: object[] };
    writeFileSync(join(botDir(), 'projects.json'), JSON.stringify({ ...rows, projects: [...rows.projects, { name: '私聊', chatId: 'oc_dm_cli_a', cwd: work, blank: true, createdAt: 1, backend: 'claude-agent', dm: { people } }] }));
    const mine = new MemoryStore(dmMemoryLocation(botDir(), 'ou_a'));
    const source = { via: 'tool', botId: 'cli_a', actorRole: 'admin', actorOpenId: 'ou_a', chatId: 'oc_new' } as const;
    for (const [text, trust] of [['张三的事', 'trusted'], ['张三没确认的事', 'untrusted']] as const) await mine.add({ text, branch: '其他', source, trust, actor: { role: 'admin', openId: 'ou_a' } });
    await new MemoryStore(dmMemoryLocation(botDir(), 'ou_b')).add({ text: '别人的事', branch: '其他', source: { ...source, actorOpenId: 'ou_b' }, trust: 'trusted', actor: { role: 'admin', openId: 'ou_b' } });
    writeFileSync(join(botDir(), 'sessions.json'), JSON.stringify({ version: 3, sessions: [
      { threadId: 'th_old', chatId: 'oc_old', sessionId: 's1', backend: 'claude-agent', cwd: work, createdAt: 1, updatedAt: 9 },
      { threadId: 'th_new', chatId: 'oc_new', sessionId: 's2', backend: 'claude-agent', cwd: work, createdAt: 1, updatedAt: 2 },
    ] }));
    const preview = (openId: string, running = true) => contextPreview({ type: 'get', agentId: 'cli_a' as never, place: { kind: 'dm', openId } }, { running, botName: '小支', library, botDirectory: botDir() });
    const reply = contextPreviewReplySchema.parse(await preview('ou_a'));
    expect(reply.next.sections.map(section => section.key)).toEqual(['identity', 'role', 'supplement', 'botMemory', 'dmMemory']);
    expect(reply.next.sections.at(-1)).toMatchObject({ items: 2 });
    expect(reply.next.items).toEqual({ bot: 1, trusted: 1, untrusted: 1 });
    expect(reply.session?.threadId).toBe('th_new'); // the chat they use now, not an old one
    expect(reply.judge).toMatchObject({ roleChars: 0, memoryItems: 0 });
    expect((await preview('ou_b')).next.items).toEqual({ bot: 1, trusted: 1, untrusted: 0 });
    await expect(preview('ou_stranger')).rejects.toThrow('这个人没有和这个 Bot 私聊过');
  });

  it('shows the newest live session of the group unless one is asked for', async () => {
    const w = await world();
    w.sessions([record({ threadId: 'old', updatedAt: 10 }), record({ threadId: 'new', updatedAt: 90 }), record({ threadId: 'gone', updatedAt: 99, detached: true }), record({ threadId: 'other', chatId: 'oc_other', updatedAt: 99 })]);
    expect((await w.preview(true)).session!.threadId).toBe('new');
    expect((await w.preview(true, 'old')).session!.threadId).toBe('old');
    expect((await w.preview(true, 'other')).session).toBeUndefined();
  });

  it('says what the decision model gets: the group\'s trusted entries only, and whether the model is a third party', async () => {
    const w = await world({ judge: { kind: 'decision', provider: 'typesafe', model: 'jev' } });
    await w.add(w.store, '发版改到周四', '决定');
    await w.add(w.store, '日志在 /var/log/pay', '环境和资源', 'untrusted');
    await w.add(w.bot, '先说结论', '合作方式');
    const judge = (await w.preview(false)).judge;
    expect(judge).toMatchObject({ via: 'third-party', label: 'typesafe jev', memoryItems: 1 });
    expect(judge.roleChars).toBe(Array.from('只管发布\n\n支付组的发布助手').length);
  });

  it('has nothing of the project\'s own instruction files: no content, no path', async () => {
    const w = await world();
    await w.add(w.store, '发版改到周四', '决定');
    w.sessions([record({ context: contextOf(assemble(await w.sources()), 'n0n0n0') })]);
    const text = JSON.stringify(await w.preview(true));
    for (const needle of ['SECRET-AGENTS-TEXT', 'SECRET-CLAUDE-TEXT', 'AGENTS.md', 'CLAUDE.md', work, fixture.root]) expect(text).not.toContain(needle);
  });

  it('refuses a group the bot has no row for, and a request with more than it asks for', async () => {
    const w = await world();
    await expect(contextPreview({ type: 'get', agentId: 'cli_a' as never, place: { kind: 'group', groupId: 'oc_nope' as never } }, { running: false, library: w.library, botDirectory: botDir() })).rejects.toThrow('没有这个群');
    expect(contextPreviewRequestSchema.safeParse({ type: 'get', agentId: 'cli_a', place: { kind: 'group', groupId: CHAT }, path: '/x' }).success).toBe(false);
    expect(readdirSync(work).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    expect(readFileSync(join(work, 'AGENTS.md'), 'utf8')).toContain('SECRET');
  });
});

describe('the turn update stays the one assembly', () => {
  it('a turn with lastTurn recorded still gets only what changed', async () => {
    const w = await world();
    await w.add(w.store, '发版改到周四', '决定');
    const src = await w.sources();
    const settled = settleTurn(contextOf(assemble(src), 'n0n0n0', 10), '没用记忆', 20).context;
    const update = await planTurnUpdate(src, assemble(src), settled);
    expect(update.text).toBeUndefined();
    expect(update.context.lastTurn?.used).toEqual([]);
  });
});


it('counts ordinary work rules in the supplement delivery section without adding them to the judge', async () => {
  const plain = await world();
  const before = await plain.preview(false);
  const w = await world({ workRules: '先核对😀\n再执行' });
  const reply = await w.preview(false);
  expect(reply.next.sections.find(section => section.key === 'supplement')?.chars).toBe(4 + Array.from('先核对😀\n再执行').length);
  expect(reply.judge.roleChars).toBe(before.judge.roleChars);
  expect(reply.next.sections.find(section => section.key === 'supplement')?.version).not.toBe(before.next.sections.find(section => section.key === 'supplement')?.version);
});
