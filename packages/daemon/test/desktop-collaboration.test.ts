import { pendingGroupsFile, readPendingGroups } from '../src/project/pending-groups';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { readFile, rm, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AccountUsageBundle } from '../src/agent/types';
import type { AppConfig } from '../src/config/schema';
import { paths } from '../src/config/paths';
import { addProject, getProjectByName, removeProject, updateProject } from '../src/project/registry';
import { getSession, listSessions, upsertSession } from '../src/bot/session-store';
import { createOrchestrator } from '../src/bot/handle-message';
import { parseCollaborationRequest, projectRevision } from '../src/admin/collaboration';
import { weaveSender } from '../src/bot/context-weave';
import { updateManagedCard } from '../src/card/managed';
import { readDropped } from '../src/bot/restart-dropped';
import { existsSync } from 'node:fs';
import { AdminWriteError } from '../src/admin/ops';
import { CreationOutcomeUnknownError } from '../src/project/lifecycle';
import { createAdminIpcCaller, createAdminIpcResponder, type AdminIpcOp } from '../src/admin/ipc';
import { collaborationRpc } from '../src/server/rpc/collaboration';
import { collaborationRequestSchema } from '@vonvon/protocol';
import { RpcError } from '../src/server/errors';
import { seedBots } from './helpers/bot-fixture';
import { fakeLark, httpError, stall } from './helpers/fake-lark-http';

// Keep the execution workspace physically separate from daemon data.
const workspace = await vi.hoisted(async () => {
  const { mkdtempSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return realpathSync(mkdtempSync(join(tmpdir(), 'desktop-collaboration-workspace-')));
});
afterAll(async () => {
  const { rm } = await import('node:fs/promises');
  await rm(workspace, { recursive: true, force: true });
});
vi.mock('../src/config/paths', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const appDir = mkdtempSync(join(tmpdir(), 'desktop-collaboration-'));
  return { paths: { appDir, sessionsFile: join(appDir, 'sessions.json'), projectsFile: join(appDir, 'projects.json'), botsFile: join(appDir, 'bots.json'), commentInstructionsFile: join(appDir, 'instructions.md'), commentsRootDir: join(appDir, 'comments'), projectsRootDir: join(appDir, 'projects') },
    botPaths: () => ({ projectsFile: join(appDir, 'projects.json'), configFile: join(appDir, 'config.json') }) };
});
const fixture = vi.hoisted(() => ({ failProjectsWrite: false, holdProjectsWrite: undefined as Promise<void> | undefined, reachedProjectsWrite: () => {}, backend: undefined as unknown, leave: vi.fn(), send: vi.fn(async () => ({ messageId: 'om_sent' })), usage: vi.fn<() => Promise<AccountUsageBundle>>(async () => ({ profile: { topInvocations: [], dailyBuckets: [] }, usage: { main: {}, extras: [], fetchedAt: 1 } })) }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fixture.failProjectsWrite && basename(String(args[1])) === 'projects.json') throw new Error('project disk failure');
    if (fixture.holdProjectsWrite && basename(String(args[1])) === 'projects.json') { fixture.reachedProjectsWrite(); await fixture.holdProjectsWrite; }
    return actual.rename(...args);
  } };
});
vi.mock('../src/agent', async original => ({ ...await original<object>(), createBackend: () => fixture.backend }));
vi.mock('../src/agent/usage', () => ({ fetchUsageBundle: fixture.usage }));
vi.mock('../src/project/group-ops', () => ({ leaveChat: fixture.leave, transferOwnership: vi.fn() }));
vi.mock('../src/card/managed', () => ({ sendManagedCard: fixture.send, updateManagedCard: vi.fn(async () => true) }));
vi.mock('../src/core/logger', () => ({ log: { info() {}, warn() {}, fail() {} }, withTrace: (_context: unknown, callback: () => unknown) => callback() }));
const target = { projectName: 'demo', chatId: 'oc_demo' };
const cfg: AppConfig = { accounts: { app: { id: 'cli_fixture', secret: 'fixture', tenant: 'feishu' } }, preferences: { access: { ownerOpenId: 'ou_owner' } } };
function backend() {
  const thread = { sessionId: 'fresh', isAlive: () => true, close: vi.fn(async () => {}), compact: vi.fn(async () => ({ usage: { usedTokens: 20, contextWindow: 100 } })) };
  const backend = { id: 'codex-appserver', displayName: 'Codex (app-server)', listModels: async () => [], startThread: vi.fn(async () => thread), resumeThread: vi.fn(async () => thread), listThreads: vi.fn(async () => [{ sessionId: 'past', preview: 'historic', createdAt: 1, updatedAt: 2 }]), readHistory: vi.fn(async () => ({ name: 'historic', preview: '', turns: [], totalTurns: 0 })) };
  fixture.backend = backend;
  return { ...backend, thread };
}
function orchestrator(channel: unknown = { send: fixture.send }, droppedFile?: string) { return createOrchestrator(channel as never, cfg, paths.appDir, undefined, droppedFile ? { droppedFile } : undefined); }
const bot = { appId: 'cli_fixture', tenant: 'feishu' as const, createdAt: 1, registrationId: 'fixture' };
/** An owner that can create groups: registered bot identity, a real SDK client over fake HTTP. */
function creator(rawClient: unknown) { return createOrchestrator({ send: fixture.send, rawClient } as never, cfg, paths.appDir, undefined, { bot }); }
beforeEach(async () => {
  await seedBots({ version: 1, bots: [{ ...bot, name: 'fixture' }] });
  await rm(pendingGroupsFile(paths.projectsFile), { force: true });
  await rm(paths.projectsFile, { force: true }); await rm(paths.sessionsFile, { force: true });
  fixture.failProjectsWrite = false; fixture.holdProjectsWrite = undefined;
  fixture.leave.mockReset(); fixture.send.mockClear();
  await addProject({ name: 'demo', chatId: 'oc_demo', cwd: workspace, kind: 'single', blank: false, origin: 'joined', createdAt: 1, backend: 'codex-appserver' });
  await upsertSession({ threadId: 'oc_demo', chatId: 'oc_demo', cwd: workspace, sessionId: 'old', backend: 'codex-appserver', summary: 'old', createdAt: 1, updatedAt: 1 });
});
afterAll(() => rm(paths.appDir, { recursive: true, force: true }));
it('rejects untrusted identity, extra fields and relative paths at the HTTP boundary', () => {
  expect(() => parseCollaborationRequest({ action: 'context', ...target, threadId: 'oc_demo', owner: 'ou_fake' })).toThrow();
  expect(() => parseCollaborationRequest({ action: 'editProject', ...target, expectedRevision: 'revision', directory: '../escape' })).toThrow();
  expect(parseCollaborationRequest({ action: 'usage', force: true })).toEqual({ action: 'usage', force: true });
  expect(parseCollaborationRequest({ action: 'shareUsage', ...target, sections: ['stats', 'heatmap'] })).toMatchObject({ sections: ['stats', 'heatmap'] });
  expect(() => parseCollaborationRequest({ action: 'shareUsage', ...target, sections: ['unknown'] })).toThrow('分享区块无效');
  expect(() => parseCollaborationRequest({ action: 'shareUsage', ...target, sections: 'stats' })).toThrow('分享区块无效');
});

it('does not tell a sender to resend a desktop goal interrupted during preparation', async () => {
  const be = backend();
  let prepared!: (value: typeof be.thread) => void;
  be.resumeThread.mockReturnValue(new Promise(resolve => { prepared = resolve; }));
  const file = join(paths.appDir, 'desktop-dropped.json');
  const app = orchestrator(undefined, file);
  const starting = app.collaboration({ action: 'startGoal', ...target, threadId: 'oc_demo', objective: 'Finish' });
  await vi.waitFor(() => expect(be.resumeThread).toHaveBeenCalledOnce());
  const closing = app.shutdown();
  prepared(be.thread);
  await starting;
  await closing;
  expect(be.thread.close).toHaveBeenCalled();
  expect(readDropped(file, Date.now()).entries).toEqual([]);
  expect(existsSync(file)).toBe(false);
});

it('s27a0: the desktop objective goes out without a real <at> (main fails: channel.send is not guarded)', async () => {
  const be = backend(); const app = orchestrator();
  try {
    await app.collaboration({ action: 'startGoal', ...target, threadId: 'oc_demo', objective: '让 <at id="ou_b">小审</at> 看' });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledWith('oc_demo', { markdown: '桌面端启动目标：让 @小审 看' }, undefined));
    expect(be.resumeThread).toHaveBeenCalled();
  } finally { await app.shutdown(); }
});

it('generates a share card with only the requested sections', async () => {
  backend(); const app = orchestrator();
  fixture.usage.mockResolvedValueOnce({
    profile: { displayName: 'Tester', lifetimeTokens: 12345, topInvocations: [], dailyBuckets: [] },
    usage: { main: { primary: { usedPercent: 25 } }, extras: [], fetchedAt: Date.now() },
  });
  try {
    await app.collaboration({ action: 'shareUsage', ...target, sections: ['stats'] });
    const card = JSON.stringify(fixture.send.mock.calls.at(-1));
    expect(card).toContain('累计 Token 数');
    expect(card).not.toContain('限额进度');
    expect(card).not.toContain('剩余 75%');
  } finally { await app.shutdown(); }
});
it('returns backend-wide history and only compacts the matching bound session', async () => {
  const be = backend(); const app = orchestrator();
  try {
    expect(await app.collaboration({ action: 'history', ...target })).toMatchObject({ threads: [{ sessionId: 'past' }], sessions: [{ sessionId: 'old' }] });
    await expect(app.collaboration({ action: 'compact', ...target, threadId: 'oc_other' })).rejects.toThrow('不属于');
    await app.collaboration({ action: 'compact', ...target, threadId: 'oc_demo' });
    expect(be.thread.compact).toHaveBeenCalledOnce();
    expect(await app.collaboration({ action: 'context', ...target, threadId: 'oc_demo' })).toMatchObject({ usage: { used: 20, window: 100 }, run: null });
  } finally { await app.shutdown(); }
});
it('clears a flat binding with its model settings and keeps old backend history resumable', async () => {
  const be = backend(); const app = orchestrator();
  try {
    await app.collaboration({ action: 'clear', ...target, threadId: 'oc_demo' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'fresh' });
    expect(be.startThread).toHaveBeenCalledWith(expect.objectContaining({ cwd: workspace }));
    await app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: 'codex-appserver' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'past' });
    await expect(app.collaboration({ action: 'resume', ...target, sessionId: 'foreign', backend: 'codex-appserver' })).rejects.toThrow('不属于');
  } finally { await app.shutdown(); }
});
it('lists resumable sessions by the person\'s words, not the woven sender line', async () => {
  backend();
  const woven = weaveSender('修一下登录', { senderId: 'ou_secret_id', senderName: '张三' });
  Object.assign(fixture.backend as object, {
    listThreads: vi.fn(async () => [
      { sessionId: 'past', preview: woven, createdAt: 1, updatedAt: 2 },
      { sessionId: 'named', preview: woven, name: '登录修复', createdAt: 1, updatedAt: 2 },
      { sessionId: 'odd', preview: '', name: woven, createdAt: 1, updatedAt: 2 },
    ]),
  });
  const app = orchestrator();
  try {
    const history = await app.collaboration({ action: 'history', ...target }) as { threads: { preview: string; name?: string }[] };
    expect(history.threads).toEqual([
      { sessionId: 'past', preview: '修一下登录', createdAt: 1, updatedAt: 2 },
      { sessionId: 'named', preview: '修一下登录', name: '登录修复', createdAt: 1, updatedAt: 2 },
      { sessionId: 'odd', preview: '', name: '修一下登录', createdAt: 1, updatedAt: 2 },
    ]);
  } finally { await app.shutdown(); }
});
it('the DM project settings card names the backend as users know it', async () => {
  backend(); // the real Codex backend calls itself "Codex (app-server)"
  vi.mocked(updateManagedCard).mockClear();
  const app = orchestrator();
  const settingsCard = () => vi.mocked(updateManagedCard).mock.calls.map(call => JSON.stringify(call)).find(json => json.includes('项目设置'));
  try {
    await app.dispatcher.handle({ messageId: 'om_settings', chatId: 'oc_dm', operator: { openId: 'ou_owner' }, action: { tag: 'button', value: { a: 'dm.projectSettings', n: 'demo' } } } as never);
    await vi.waitFor(() => expect(settingsCard()).toBeDefined(), { timeout: 3000 });
    expect(settingsCard()).toContain('当前 Codex 🔒');
    expect(settingsCard()).not.toContain('app-server');
  } finally { await app.shutdown(); }
});
const wovenBy = (text: string) => weaveSender(text, { senderId: 'ou_secret_id', senderName: '张三' });
it.each([
  { what: 'an unnamed session', name: undefined, summary: '修一下登录' },
  { what: 'a session whose name is woven too', name: wovenBy('登录修复'), summary: '登录修复' },
])("resume names the backend as users know it and keeps the woven sender line out of card and record: $what", async ({ name, summary }) => {
  backend(); // the real Codex backend calls itself "Codex (app-server)"
  const woven = wovenBy('修一下登录');
  Object.assign(fixture.backend as object, {
    readHistory: vi.fn(async () => ({ ...(name ? { name } : {}), preview: woven, turns: [{ userText: woven, assistantText: '好的', reasoning: '', tools: [] }], totalTurns: 3 })),
  });
  const app = orchestrator();
  try {
    await app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: 'codex-appserver' });
    const card = JSON.stringify(fixture.send.mock.calls.find(call => JSON.stringify(call).includes('已恢复历史会话')));
    expect(card).toContain('**🤖 Codex**');
    expect(card).toContain('更早的 2 轮 Codex 仍保留');
    expect(card).not.toMatch(/app-server|open_id|ou_secret_id|发信人/);
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'past', summary });
  } finally { await app.shutdown(); }
});
it('reserves a compacting session against clear and rejects stale run controls', async () => {
  const be = backend(); let finish!: () => void;
  be.thread.compact.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ usage: { usedTokens: 1, contextWindow: 100 } }); }));
  const app = orchestrator();
  try {
    const compact = app.collaboration({ action: 'compact', ...target, threadId: 'oc_demo' });
    await vi.waitFor(() => expect(be.thread.compact).toHaveBeenCalled());
    await expect(app.collaboration({ action: 'clear', ...target, threadId: 'oc_demo' })).rejects.toThrow('正在运行');
    await expect(app.collaboration({ action: 'stop', ...target, threadId: 'oc_demo', runId: 'obsolete' })).rejects.toThrow('已经结束');
    finish(); await compact;
  } finally { await app.shutdown(); }
});
it.each([
  { action: 'compact', smart: true },
  { action: 'compact', smart: false },
  { action: 'resume', smart: true },
  { action: 'resume', smart: false },
  { action: 'startGoal', smart: true },
  { action: 'startGoal', smart: false },
] as const)('desktop $action preparation in smart=$smart exposes no completion subscription', async ({ action, smart }) => {
  await updateProject('demo', { smart });
  const be = backend();
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const preparationError = new Error('finish suspended desktop preparation');
  if (action === 'compact') {
    be.thread.compact.mockImplementationOnce(async () => { reached(); await gate; throw preparationError; });
  } else if (action === 'resume') {
    be.readHistory.mockImplementationOnce(async () => { reached(); await gate; throw preparationError; });
  } else {
    be.startThread.mockRejectedValueOnce(preparationError);
    be.resumeThread.mockImplementationOnce(async () => { reached(); await gate; throw preparationError; });
  }
  const manualCfg: AppConfig = { ...cfg, preferences: { ...cfg.preferences, completionReminder: { mode: 'manual' } } };
  const app = createOrchestrator({ send: fixture.send } as never, manualCfg, paths.appDir);
  const operation = action === 'resume'
    ? app.collaboration({ action, ...target, sessionId: 'past', backend: 'codex-appserver' })
    : action === 'startGoal'
      ? app.collaboration({ action, ...target, threadId: 'oc_demo', objective: 'Finish' })
      : app.collaboration({ action, ...target, threadId: 'oc_demo' });
  const settled = expect(operation).rejects.toThrow(preparationError.message);
  try {
    await Promise.race([entered, settled]);
    const context = await app.collaboration({ action: 'context', ...target, threadId: 'oc_demo' });
    expect.soft(context).toMatchObject({ run: { goal: action === 'startGoal', canRemind: false, reminderRequested: false } });
    if (!context || typeof context !== 'object' || !('run' in context) || !context.run || typeof context.run !== 'object' || !('id' in context.run) || typeof context.run.id !== 'string') throw new Error('suspended desktop preparation has no run');
    await expect.soft(app.collaboration({ action: 'reminder', ...target, threadId: 'oc_demo', runId: context.run.id, requested: true })).rejects.toThrow('仅任务发起人');
    expect.soft(await app.collaboration({ action: 'context', ...target, threadId: 'oc_demo' })).toMatchObject({ run: { reminderRequested: false } });
  } finally {
    release();
    await settled;
    await app.shutdown();
  }
});
it('changes directory only after checking revision and archives old bindings without deleting history', async () => {
  backend(); const app = orchestrator();
  const directory = `${paths.appDir}/projects/new`; await mkdir(directory, { recursive: true });
  try {
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision: 'stale', directory })).rejects.toThrow('已改变');
    const revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, directory, enabled: false });
    expect(await getProjectByName('demo')).toMatchObject({ cwd: await realpath(directory), enabled: false });
    expect(await getSession('oc_demo')).toBeUndefined();
    expect(await listSessions()).toMatchObject([{ sessionId: 'old', detached: true }]);
  } finally { await app.shutdown(); }
});
it('s36c2d: admits a new directory for an old row and declares it, refusing the data directory (review R5-1)', async () => {
  backend(); const app = orchestrator();
  try {
    const bots = join(paths.appDir, 'bots'); await mkdir(bots, { recursive: true });
    const before = await readFile(paths.projectsFile, 'utf8');
    // Before s36c2d: the old row (no `directories`) moved into bots/ and to the data directory itself, ok: true.
    for (const directory of [bots, paths.appDir]) {
      const expectedRevision = projectRevision((await getProjectByName('demo'))!);
      const refused = await app.collaboration({ action: 'editProject', ...target, expectedRevision, directory }).then(() => undefined, (error: unknown) => error);
      expect(refused).toBeInstanceOf(AdminWriteError);
      expect((refused as Error).message).toContain('不能当工作目录');
      expect((refused as Error).message).not.toContain(paths.appDir);
    }
    expect(await readFile(paths.projectsFile, 'utf8')).toBe(before);
    // The old row still sits in the data directory; changing something else is not refused for it.
    let expectedRevision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision, enabled: false });
    const directory = join(paths.appDir, 'projects', 'moved'); await mkdir(directory, { recursive: true });
    expectedRevision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision, directory });
    const canonical = await realpath(directory);
    expect(await getProjectByName('demo')).toMatchObject({ cwd: canonical, directories: { workspaces: { primary: canonical, additional: [] } } });
  } finally { await app.shutdown(); }
});
it('s21: switching 会话方式 keeps 免@ as it read before (a joined 单会话 group stays off)', async () => {
  backend(); const app = orchestrator();
  try {
    expect((await getProjectByName('demo'))!.noMention).toBeUndefined(); // old row: off by default for joined single
    const revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'multi' });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'multi', noMention: false });
    const next = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: next, kind: 'single' });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single', noMention: false });
  } finally { await app.shutdown(); }
});
it('s21, s25c: a stored 智能 is kept by a save that sends it back and dropped by a switch, 免@ as it ran', async () => {
  backend(); const app = orchestrator();
  try {
    await updateProject('demo', { smart: true, noMention: true });
    let revision = projectRevision((await getProjectByName('demo'))!);
    // The page sends the 会话方式 it shows: 智能 stays 智能, says nothing and archives nothing. A hand-edited 免@ 开
    // goes back to 关, so an older daemon still runs it as 单会话、仅 @ (审查低).
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'smart', enabled: true });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single', smart: true, noMention: false });
    await updateProject('demo', { noMention: true });
    revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, enabled: true });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single', smart: true, noMention: false });
    expect(fixture.send).not.toHaveBeenCalled();
    revision = projectRevision((await getProjectByName('demo'))!);
    // Since s25c 单会话 is a real pick: the same main-area session goes on, 免@ is what it ran as (off).
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'single' });
    const after = (await getProjectByName('demo'))!;
    expect(after).toMatchObject({ kind: 'single', noMention: false });
    expect(after).not.toHaveProperty('smart');
    expect((await listSessions())[0]).toMatchObject({ sessionId: 'old' });
    expect((await listSessions())[0]?.detached).not.toBe(true);
    expect(fixture.send).not.toHaveBeenCalled();
  } finally { await app.shutdown(); }
});
it('s25c: switching to 智能 stores it with 免@ off, keeps the 单会话 session and says so once the group is unlocked', async () => {
  backend(); const app = orchestrator();
  try {
    await updateProject('demo', { noMention: true });
    // Said after the edit lets go of the group: anything else the page does meanwhile is not turned away.
    let during: unknown;
    let edit: unknown;
    fixture.send.mockImplementationOnce(async () => {
      during = await app.collaboration({ action: 'context', ...target, threadId: 'oc_demo' }).then(() => 'free', (error: Error) => error.message);
      // Another edit waits until it is said: the sentence never lands in a group switched away meanwhile (审查低).
      const fresh = projectRevision((await getProjectByName('demo'))!);
      edit = await app.collaboration({ action: 'editProject', ...target, expectedRevision: fresh, kind: 'multi' }).then(() => 'edited', (error: Error) => error.message);
      return { messageId: 'om_notice' };
    });
    const revision = projectRevision((await getProjectByName('demo'))!);
    const reply = await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'smart' });
    expect(reply).toMatchObject({ ok: true, project: { kind: 'smart' } });
    expect(reply).not.toHaveProperty('warning');
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single', smart: true, noMention: false });
    expect(fixture.send).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledWith('oc_demo', { text: '我会读群消息，合适时接话。' });
    expect(during).toBe('free');
    expect(edit).toBe('正在群里说一句，请稍后再改');
    expect((await listSessions())[0]?.detached).not.toBe(true);
  } finally { await app.shutdown(); }
});
it('s25c: a failed notice is a warning on a saved switch, and a disabled group is told nothing', async () => {
  backend(); const app = orchestrator();
  try {
    fixture.send.mockRejectedValueOnce(new Error('send refused'));
    let revision = projectRevision((await getProjectByName('demo'))!);
    expect(await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'smart' }))
      .toMatchObject({ ok: true, project: { kind: 'smart' }, warning: '已改成智能开话题，但没能在群里说一句：send refused' });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single', smart: true });
    revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'multi' });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'multi', noMention: false });
    fixture.send.mockClear();
    revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'smart', enabled: false });
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single', smart: true, enabled: false });
    revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'single', enabled: false });
    revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'smart' });
    expect(fixture.send).not.toHaveBeenCalled();
  } finally { await app.shutdown(); }
});
it('s25c: 多会话 and 智能 archive each other\'s sessions, as 多会话 and 单会话 do', async () => {
  backend(); const app = orchestrator();
  try {
    let revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'smart' });
    expect((await listSessions())[0]?.detached).not.toBe(true);
    revision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision: revision, kind: 'multi' });
    expect(await listSessions()).toMatchObject([{ sessionId: 'old', detached: true }]);
    const after = (await getProjectByName('demo'))!;
    expect(after).toMatchObject({ kind: 'multi', noMention: false });
    expect(after).not.toHaveProperty('smart');
  } finally { await app.shutdown(); }
});
it('s25c: parses 智能 from the web and refuses a 免@ with it', () => {
  expect(parseCollaborationRequest({ action: 'editProject', ...target, expectedRevision: 'x', kind: 'smart' })).toMatchObject({ kind: 'smart' });
  expect(parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', kind: 'smart', backend: 'codex-appserver' })).toMatchObject({ kind: 'smart' });
  for (const noMention of [true, false]) {
    expect(() => parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', kind: 'smart', noMention, backend: 'codex-appserver' })).toThrow('没有免 @');
  }
  expect(() => parseCollaborationRequest({ action: 'editProject', ...target, expectedRevision: 'x', kind: 'later' })).toThrow('会话类型无效');
});
it('s21: a new group from the web writes 免@ from the pick, else from the 会话方式', () => {
  expect(parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', kind: 'single', backend: 'codex-appserver' })).not.toHaveProperty('noMention');
  expect(parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', kind: 'single', noMention: undefined, backend: 'codex-appserver' })).toMatchObject({ kind: 'single' });
  expect(parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', kind: 'single', noMention: true, backend: 'codex-appserver' })).toMatchObject({ noMention: true });
  expect(() => parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', kind: 'single', noMention: 'yes', backend: 'codex-appserver' })).toThrow();
  expect(() => parseCollaborationRequest({ action: 'createProject', requestId: 'r'.repeat(16), name: 'n', backend: 'codex-appserver' })).toThrow();
});
it('unbinds a joined project, preserves sessions and reports failed external leave honestly', async () => {
  backend(); const app = orchestrator(); fixture.leave.mockRejectedValueOnce(new Error('permission denied'));
  try {
    const expectedRevision = projectRevision((await getProjectByName('demo'))!);
    expect(await app.collaboration({ action: 'removeProject', ...target, expectedRevision })).toEqual({ ok: true, groupEffect: 'failed', warning: 'permission denied' });
    expect(await getProjectByName('demo')).toBeUndefined();
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'old' });
  } finally { await app.shutdown(); }
});
it('never applies a stale project target to another binding and refreshes actual usage', async () => {
  backend(); const app = orchestrator();
  try {
    await removeProject('demo');
    await addProject({ name: 'demo', chatId: 'oc_replacement', cwd: workspace, blank: false, createdAt: 2 });
    await expect(app.collaboration({ action: 'history', ...target })).rejects.toThrow('已改变');
    expect(await app.collaboration({ action: 'usage', force: true })).toHaveProperty('data');
    expect(fixture.usage).toHaveBeenCalledWith(true);
  } finally { await app.shutdown(); }
});

it('creates in the bot\'s stable directory once and preserves idempotency across owner restart', async () => {
  backend();
  const fake = fakeLark();
  let app = creator(fake.client);
  const request = { action: 'createProject' as const, requestId: 'c848d29f-69db-4f53-849d-577453388ac7', name: 'created', kind: 'single' as const, backend: 'codex-appserver' as const };
  try {
    const replies = await Promise.all([app.collaboration(request), app.collaboration(request)]);
    expect(replies[0]).toEqual(replies[1]);
    expect(fake.creates()).toMatchObject([{ params: { user_id_type: 'open_id', uuid: request.requestId }, data: { name: 'created', user_id_list: ['ou_owner'] } }]);
    expect(await getProjectByName('created')).toMatchObject({ cwd: await realpath(join(paths.projectsRootDir, 'fixture', 'groups', 'created')), creationRequestId: request.requestId,
      origin: 'created', mode: 'full', backend: 'codex-appserver' });
    await app.shutdown(); app = creator(fake.client);
    expect(await app.collaboration(request)).toEqual(replies[0]);
    expect(fake.creates()).toHaveLength(1);
    await expect(app.collaboration({ ...request, name: 'changed' })).rejects.toThrow('其他参数');
  } finally { await app.shutdown(); }
});
it.each(['directory', 'alias'] as const)('admits an explicit %s before remote creation and retains the request after restart', async selection => {
  backend();
  const dir = join(paths.projectsRootDir, `explicit-${selection}`);
  const alias = `${dir}-alias`;
  await mkdir(dir, { recursive: true });
  await symlink(dir, alias);
  const fake = fakeLark();
  let app = creator(fake.client);
  const request = { action: 'createProject' as const, requestId: 'f0cfe579-c6bc-40c6-91f9-963fcffb2c1c', name: 'Explicit created', directory: selection === 'alias' ? alias : dir, kind: 'single' as const, backend: 'codex-appserver' as const };
  const admins = () => fake.requests.filter(r => r.path.endsWith('/managers/add_managers'));
  try {
    const first = await app.collaboration(request);
    expect(await getProjectByName(request.name)).toMatchObject({ cwd: await realpath(dir), blank: false,
      directories: { workspaces: { primary: await realpath(dir), additional: [] } }, creationRequestId: request.requestId });
    expect(await getProjectByName(request.name)).not.toHaveProperty('directories.repositories');
    expect(fake.creates()).toMatchObject([{ params: { user_id_type: 'open_id', uuid: request.requestId }, data: { name: request.name, user_id_list: ['ou_owner'] } }]);
    expect(admins()).toMatchObject([{ path: `/open-apis/im/v1/chats/oc_${request.requestId}/managers/add_managers`, params: { member_id_type: 'open_id' }, data: { manager_ids: ['ou_owner'] } }]);
    await app.shutdown(); app = creator(fake.client);
    expect(await app.collaboration(request)).toEqual(first);
    expect(fake.creates()).toHaveLength(1);
    expect(admins()).toHaveLength(1);
  } finally { await app.shutdown(); }
});
it('s36d1: keeps a result not known apart from every refusal, which crosses IPC as the bot\'s own word', async () => {
  backend();
  let answer = (): unknown => { throw httpError(503, 'unavailable'); };
  const fake = fakeLark(request => request.method === 'POST' && request.path === '/open-apis/im/v1/chats' ? answer() : undefined);
  const app = creator(fake.client);
  const request = { action: 'createProject' as const, requestId: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'Outcome', kind: 'multi' as const, backend: 'codex-appserver' as const };
  try {
    const unknown = await app.collaboration(request).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(CreationOutcomeUnknownError);
    expect(unknown).not.toBeInstanceOf(AdminWriteError);
    answer = () => { throw httpError(400, { code: 232001, msg: 'invalid name' }); };
    await expect(app.collaboration({ ...request, requestId: 'a1b2c3d4-0000-4000-8000-000000000002' })).rejects.toThrow(new AdminWriteError('飞书拒绝建群 code=232001：invalid name'));
    await expect(app.collaboration({ ...request, requestId: 'a1b2c3d4-0000-4000-8000-000000000003', name: 'demo' })).rejects.toBeInstanceOf(AdminWriteError);
    const unregistered = orchestrator({ send: fixture.send, rawClient: fake.client });
    await expect(unregistered.collaboration({ ...request, requestId: 'a1b2c3d4-0000-4000-8000-000000000004' })).rejects.toThrow(new AdminWriteError('缺少机器人注册身份，请重启后再建群'));
    await unregistered.shutdown();
    expect(fake.creates()).toHaveLength(2);
  } finally { await app.shutdown(); }
});
it('s36d1: shutdown stops a creation in flight at once and starts none of those queued or new', async () => {
  backend();
  const fake = fakeLark(request => request.method === 'POST' && request.path === '/open-apis/im/v1/chats' ? stall() : undefined);
  const app = creator(fake.client);
  const request = { action: 'createProject' as const, requestId: 'b1b2c3d4-0000-4000-8000-000000000001', name: 'In flight', kind: 'multi' as const, backend: 'codex-appserver' as const };
  const flying = app.collaboration(request).catch((error: unknown) => error);
  // Each request first reads projects.json for an earlier result of its id, so two sent together may queue in
  // either order: the second is sent once the first is out.
  await vi.waitFor(() => expect(fake.creates()).toHaveLength(1), { timeout: 10_000 });
  const queued = app.collaboration({ ...request, requestId: 'b1b2c3d4-0000-4000-8000-000000000002', name: 'Queued' }).catch((error: unknown) => error);
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now();
  await app.shutdown();
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(await flying).toBeInstanceOf(CreationOutcomeUnknownError);
  expect(await queued).toEqual(new AdminWriteError('后台服务正在关闭，没有建群'));
  await expect(app.collaboration({ ...request, requestId: 'b1b2c3d4-0000-4000-8000-000000000003', name: 'Late' })).rejects.toThrow(new AdminWriteError('后台服务正在关闭，没有建群'));
  expect(fake.creates()).toMatchObject([{ data: { name: 'In flight' } }]);
  expect(fake.open()).toBe(0);
});
it('s36d1: shutdown waits for a web creation whose group exists and whose row is still being saved', async () => {
  backend();
  let releaseCreate = () => {}, releaseSave = () => {};
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve; });
  const fake = fakeLark(request => request.method === 'POST' && request.path === '/open-apis/im/v1/chats' ? createGate.then(() => undefined) : undefined);
  const app = creator(fake.client);
  const request = { action: 'createProject' as const, requestId: 'e1b2c3d4-0000-4000-8000-000000000001', name: 'Saving', kind: 'multi' as const, backend: 'codex-appserver' as const };
  const flying = app.collaboration(request).then(value => ({ value }), (error: unknown) => ({ error }));
  let closedWhileSaving: boolean | undefined;
  try {
    await vi.waitFor(() => expect(fake.creates()).toHaveLength(1), { timeout: 10_000 });
    let reached = false;
    fixture.holdProjectsWrite = new Promise<void>(resolve => { releaseSave = resolve; });
    fixture.reachedProjectsWrite = () => { reached = true; };
    releaseCreate();
    await vi.waitFor(() => expect(reached).toBe(true), { timeout: 10_000 });
    let closed = false;
    const closing = app.shutdown().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 300));
    closedWhileSaving = closed;
    fixture.holdProjectsWrite = undefined; releaseSave();
    await closing;
  } finally { fixture.holdProjectsWrite = undefined; releaseSave(); releaseCreate(); }
  // The group exists and its row was on its way to disk: the drain must not have let the process exit under it.
  expect(closedWhileSaving).toBe(false);
  expect(await flying).toMatchObject({ value: { ok: true } });
  expect(await getProjectByName('Saving')).toMatchObject({ chatId: `oc_${request.requestId}` });
});
it('s36d1: a web creation whose group was made and not saved reaches the page as created_unsaved, over IPC or in process', async () => {
  backend();
  const fake = fakeLark();
  const app = creator(fake.client);
  // The bot's answer crosses IPC the way run.ts and the supervisor wire it.
  let receive: (message: unknown) => void = () => {};
  const respond = createAdminIpcResponder(async op => app.collaboration((op as Extract<AdminIpcOp, { kind: 'collaboration' }>).request), message => receive(message));
  const caller = createAdminIpcCaller(respond);
  receive = caller.onMessage;
  const overIpc = async (_botId: string, request: unknown) => caller.call({ kind: 'collaboration', request } as AdminIpcOp);
  const inProcess = async (_botId: string, request: unknown) => app.collaboration(request as never);
  const create = collaborationRequestSchema.parse({ action: 'createProject', agentId: bot.appId, name: 'Unsaved', folder: { kind: 'default' }, tool: 'codex', conversation: 'threads' });
  try {
    fixture.failProjectsWrite = true;
    for (const collaboration of [overIpc, inProcess]) {
      const service = { listBots: async () => [{ appId: bot.appId, active: true, running: true }], collaboration };
      const failure = await collaborationRpc(service as never, {} as never, create).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(RpcError);
      expect(failure).toMatchObject({ code: 'created_unsaved', message: expect.stringMatching(/^群「Unsaved」已建好，但没存上：.*加入现有飞书群.*不要再建。绑回来是只读，要完全访问就到群设置里改$/) });
    }
    expect(await getProjectByName('Unsaved')).toBeUndefined();
  } finally { fixture.failProjectsWrite = false; await app.shutdown(); }
});
it('leaves a key from before s15c unused and refuses unsupported goal before posting to Feishu', async () => {
  const be = backend(); fixture.backend = { ...be, capabilities: { goal: false, compact: true, resume: true } };
  await upsertSession({ threadId: 'oc_demo#guest', chatId: 'oc_demo', cwd: workspace, sessionId: 'guest-native', backend: 'codex-appserver', summary: 'guest', createdAt: 1, updatedAt: 1 });
  const app = orchestrator();
  try {
    await expect(app.collaboration({ action: 'compact', ...target, threadId: 'oc_demo#guest' })).rejects.toThrow('已停用');
    const history = await app.collaboration({ action: 'history', ...target }) as { sessions: { threadId: string }[] };
    expect(history.sessions.map((s) => s.threadId)).not.toContain('oc_demo#guest');
    await expect(app.collaboration({ action: 'startGoal', ...target, threadId: 'oc_demo', objective: 'do work' })).rejects.toThrow('不支持');
    expect(fixture.send).not.toHaveBeenCalled();
    expect(await getSession('oc_demo#guest')).toMatchObject({ sessionId: 'guest-native' });
  } finally { await app.shutdown(); }
});

it('retains bound history when the backend history source is unavailable', async () => {
  const be = backend(); be.listThreads.mockRejectedValueOnce(new Error('backend offline'));
  const app = orchestrator();
  try { expect(await app.collaboration({ action: 'history', ...target })).toMatchObject({ sessions: [{ threadId: 'oc_demo' }], threads: [], threadsError: 'backend offline' }); }
  finally { await app.shutdown(); }
});

function incoming(threadId?: string) {
  return { messageId: `message-${Date.now()}-${Math.random()}`, chatId: target.chatId, chatType: 'group' as const, threadId,
    content: 'hello', senderId: 'ou_owner', senderName: 'Owner', mentionedBot: true, createTime: Date.now(), rawContentType: 'text', resources: [], mentions: [], mentionAll: false };
}
it('restores live bindings when the project commit fails after archiving', async () => {
  backend(); const app = orchestrator();
  const expectedRevision = projectRevision((await getProjectByName('demo'))!);
  try {
    fixture.failProjectsWrite = true;
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision, kind: 'multi' })).rejects.toThrow('project disk failure');
    expect(await getProjectByName('demo')).toMatchObject({ kind: 'single' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'old' });
    expect((await listSessions())[0]?.detached).not.toBe(true);
  } finally { fixture.failProjectsWrite = false; await app.shutdown(); }
});
it('fences detached topic preparation against directory, disable and remove mutations', async () => {
  const be = backend();
  await updateProject('demo', { kind: 'multi' });
  let rejectStart!: (error: Error) => void;
  be.startThread.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectStart = reject; }));
  const app = orchestrator();
  try {
    await app.onMessage(incoming());
    await vi.waitFor(() => expect(be.startThread).toHaveBeenCalledOnce());
    const expectedRevision = projectRevision((await getProjectByName('demo'))!);
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision, directory: paths.appDir })).rejects.toThrow('正在执行');
    await expect(app.collaboration({ action: 'editProject', ...target, expectedRevision, enabled: false })).rejects.toThrow('正在执行');
    await expect(app.collaboration({ action: 'removeProject', ...target, expectedRevision })).rejects.toThrow('正在执行');
    rejectStart(new Error('controlled start failure'));
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalled());
    await vi.waitFor(async () => expect(await app.collaboration({ action: 'editProject', ...target, expectedRevision, enabled: false })).toHaveProperty('ok', true));
  } finally { await app.shutdown(); }
});
it('fences visible topic replies until resume owns the resolved topic key', async () => {
  const be = backend(); await updateProject('demo', { kind: 'multi' });
  let resolveTopic!: (value: unknown) => void;
  const get = vi.fn(() => new Promise(resolve => { resolveTopic = resolve; }));
  const app = orchestrator({ send: fixture.send, rawClient: { im: { v1: { message: { get } } } } });
  try {
    const resuming = app.collaboration({ action: 'resume', ...target, sessionId: 'past', backend: be.id });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    await app.onMessage(incoming('omt_published'));
    expect(be.startThread).not.toHaveBeenCalled();
    expect(be.resumeThread).not.toHaveBeenCalled();
    resolveTopic({ data: { items: [{ thread_id: 'omt_published' }] } });
    await expect(resuming).resolves.toMatchObject({ threadId: 'omt_published' });
    expect(await getSession('omt_published')).toMatchObject({ sessionId: 'past' });
    expect(be.thread.close).not.toHaveBeenCalled();
  } finally { await app.shutdown(); }
});
it('closes prepared backend work when a concurrent settings writer changes the project revision', async () => {
  const be = backend(); await updateProject('demo', { kind: 'multi' });
  let release!: (value: typeof be.thread) => void;
  be.startThread.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const app = orchestrator();
  try {
    await app.onMessage(incoming());
    await vi.waitFor(() => expect(be.startThread).toHaveBeenCalledOnce());
    await updateProject('demo', { enabled: false });
    release(be.thread);
    await vi.waitFor(() => expect(be.thread.close).toHaveBeenCalledOnce());
    expect(await listSessions()).toMatchObject([{ sessionId: 'old' }]);
    expect(fixture.send).not.toHaveBeenCalled();
  } finally { await app.shutdown(); }
});
it('recovers backend history after a kind change archives its old topic binding', async () => {
  const be = backend(); await updateProject('demo', { kind: 'multi' });
  const app = orchestrator();
  try {
    const expectedRevision = projectRevision((await getProjectByName('demo'))!);
    await app.collaboration({ action: 'editProject', ...target, expectedRevision, kind: 'single' });
    expect(await app.collaboration({ action: 'history', ...target })).toMatchObject({ sessions: [{ detached: true }], threads: [{ sessionId: 'past' }] });
    await app.collaboration({ action: 'resume', ...target, backend: be.id, sessionId: 'past' });
    expect(await getSession('oc_demo')).toMatchObject({ sessionId: 'past' });
  } finally { await app.shutdown(); }
});

it('captures real bot-added events for desktop while retaining DM binding and clearing unbound removals', async () => {
  backend();
  const membership = vi.fn(async () => ({ code: 0, data: { is_in_chat: true } }));
  const chatInfo = vi.fn(async (chatId: string) => ({ chatId, name: 'New research group', chatType: 'group', ownerId: 'ou_owner' }));
  const channel = { send: fixture.send, botIdentity: { openId: 'ou_bot' }, getChatInfo: chatInfo, rawClient: { im: { v1: { chatMembers: { isInChat: membership } } } } };
  const app = orchestrator(channel);
  const file = pendingGroupsFile(paths.projectsFile);
  try {
    await app.onBotAddedToChat({ chatId: 'oc_nonadmin', operator: { openId: 'ou_guest' } });
    await app.onBotAddedToChat({ chatId: 'oc_demo', operator: { openId: 'ou_owner' } });
    await vi.waitFor(async () => expect(await readPendingGroups(file)).toEqual([expect.objectContaining({ chatId: 'oc_nonadmin', operator: 'ou_guest', state: 'ready' })]));
    expect(fixture.send).toHaveBeenCalledWith(channel, 'ou_owner', expect.any(Object), undefined, false, 'open_id');
    await app.onBotRemovedFromChat('oc_nonadmin');
    fixture.send.mockClear();
    await app.onBotAddedToChat({ chatId: 'oc_new_event', operator: { openId: 'ou_owner' } });
    await vi.waitFor(async () => expect(await readPendingGroups(file)).toEqual([
      expect.objectContaining({ chatId: 'oc_new_event', operator: 'ou_owner', state: 'ready', name: 'New research group', addedAt: expect.any(Number) }),
    ]));
    expect(membership).toHaveBeenCalledWith({ path: { chat_id: 'oc_new_event' } });
    expect(fixture.send).toHaveBeenCalledWith(channel, 'ou_owner', expect.any(Object), undefined, false, 'open_id');
    expect(JSON.stringify(fixture.send.mock.calls)).toContain('oc_new_event');
    expect(JSON.stringify(fixture.send.mock.calls)).toContain('New research group');
    await app.onBotRemovedFromChat('oc_new_event');
    expect(await readPendingGroups(file)).toEqual([]);
    expect(fixture.send).toHaveBeenCalledTimes(1);
    await writeFile(file, '{');
    await app.onBotAddedToChat({ chatId: 'oc_queue_failure', operator: { openId: 'ou_owner' } });
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(fixture.send.mock.calls.at(-1))).toContain('oc_queue_failure');
  } finally { await app.shutdown(); }
});
