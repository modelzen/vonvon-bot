import { expect, it, vi } from 'vitest';
import type { VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, groupIdSchema, membershipIdSchema,
  type Agent, type CollaborationReply, type CollaborationRequest, type Conversation, type DesktopSnapshot, type Membership,
} from '@vonvon/protocol';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import {
  runSessionContext, runSessionList, runSessionReminder, runSessionReset, runSessionResume, runSessionStop, runSessionStopSubagent,
} from '../src/cli/commands/session';
import { CLI_PARITY_ALLOWLIST } from '../src/cli/parity-allowlist';
import { loadCommands } from './helpers/cli-commands';

/** cli-4-sessions: vonvon session …, each through a fake client behind the real withDaemon. */
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: agentIdSchema.parse('cli_a'), name: 'Vonvon Bot', enabled: true, running: true, connection: 'connected', activation: 'active', ...extra });
const member = (groupId: string, name: string, conversation: Conversation): Membership => ({
  id: membershipIdSchema.parse(JSON.stringify(['cli_a', groupId])), agentId: agentIdSchema.parse('cli_a'), groupId: groupIdSchema.parse(groupId), name, directory: `/work/${name}`,
  backend: 'codex-appserver', conversation, response: 'mention', permission: { administrator: 'qa', member: 'qa', network: false }, stale: false,
});
/** A running bot, a 单会话 group 研发 and a 多会话 group. */
const snapshot = (bot: Agent): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents: [bot], groups: [],
  memberships: [member('oc_dev', '研发', 'shared'), member('oc_multi', '多会话群', 'threads')], tools: [], jobs: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
const at = new Date(2026, 9, 31, 14, 30).getTime();
const bound = (threadId: string, chatId = 'oc_dev', extra: object = {}) => ({ threadId, chatId: groupIdSchema.parse(chatId), sessionId: `s_${threadId}`, summary: `摘要 ${threadId}`, backend: 'codex-appserver', cwd: '/work', createdAt: at, updatedAt: at, ...extra });
type History = Extract<CollaborationReply, { kind: 'history' }>;
const history = (sessions: History['sessions'], threads: History['threads'] = []): History => ({ kind: 'history', sessions, threads, backend: 'codex-appserver' });
type Run = NonNullable<Extract<CollaborationReply, { kind: 'context' }>['run']>;
const run = (extra: Partial<Run> = {}): Run => ({ id: 'r1', goal: false, canStop: true, canEndGoal: false, canRemind: true, reminderRequested: false, ...extra });

/** `answers` per action; a write not listed is applied. */
function harness(answers: Partial<Record<CollaborationRequest['action'], (request: CollaborationRequest) => unknown>>, o: { bot?: Agent; feishu?: number } = {}) {
  const collaboration = vi.fn(async (request: CollaborationRequest) => (answers[request.action] ?? (() => ({ kind: 'applied' })))(request));
  const close = vi.fn(async () => {});
  const client = { close, snapshot: async () => snapshot(o.bot ?? agent()), collaboration };
  const daemon: Daemon = fn => withDaemon(fn, async () => client as unknown as VonvonClient, { local: 50, feishu: o.feishu ?? 50 });
  let out = '';
  return { collaboration, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; }, actions: () => collaboration.mock.calls.map(([request]) => request.action) };
}
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string });
const target = { agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev' };

// main 必败: there was no session list
it('session list asks the group\'s history and prints both parts; --resumable leaves out what is bound', async () => {
  const reply = history([bound('oc_dev'), bound('t_old', 'oc_dev', { detached: true, sessionId: 's_old' })], [
    { sessionId: 's_oc_dev', preview: '已经绑着的', createdAt: 1, updatedAt: at / 1000 },
    { sessionId: 's_old', preview: '归档了的', createdAt: 1, updatedAt: at / 1000 },
    { sessionId: 'th_1', preview: '旧的', name: '修登录', createdAt: 1, updatedAt: at / 1000 },
  ]);
  const h = harness({ history: () => reply });
  await runSessionList({ group: '研发' }, h.io(true), h.daemon);
  expect(h.collaboration).toHaveBeenCalledWith({ action: 'history', ...target });
  expect(JSON.parse(h.out())).toEqual({ ok: true, backend: 'codex-appserver', sessions: reply.sessions, threads: reply.threads });
  h.clear(); await runSessionList({ group: 'oc_dev', resumable: true }, h.io(), h.daemon);
  expect(h.out()).toBe([
    '群里的会话：',
    '  oc_dev  摘要 oc_dev  Codex  更新于 2026-10-31 14:30',
    '  t_old  摘要 t_old  Codex  更新于 2026-10-31 14:30（已归档）',
    '可以接上的会话：',
    '  s_old  归档了的  更新于 2026-10-31 14:30',
    '  th_1  修登录  更新于 2026-10-31 14:30',
    '接上：vonvon session resume <sessionId> --group oc_dev',
    '',
  ].join('\n'));
  // without --resumable, only the group's own sessions
  h.clear(); await runSessionList({ group: '研发' }, h.io(), h.daemon);
  expect(h.out()).not.toContain('可以接上');
  const failing = harness({ history: () => ({ ...history([]), threadsError: '读不到 Codex 的历史' }) });
  await runSessionList({ group: '研发', resumable: true }, failing.io(), failing.daemon);
  expect(failing.out()).toBe('群里的会话：\n  还没有会话。\n可以接上的会话：\n  读不到可以接上的会话：读不到 Codex 的历史\n');
});

// main 必败: there was no session context
it('picks the group\'s only live session, lists several for --session, and never guesses', async () => {
  const one = harness({ history: () => history([bound('oc_dev'), bound('t_old', 'oc_dev', { detached: true })]), context: () => ({ kind: 'context', threadId: 'oc_dev', usage: { used: 12345, window: 200000 }, run: null }) });
  await runSessionContext({ group: '研发' }, one.io(), one.daemon);
  expect(one.collaboration).toHaveBeenLastCalledWith({ action: 'context', ...target, threadId: 'oc_dev' });
  expect(one.out()).toBe('会话 oc_dev  摘要 oc_dev\n上下文 12,345 / 200,000（6%）\n现在没有在跑的任务。\n');
  one.clear(); await runSessionContext({ group: '研发' }, one.io(true), one.daemon);
  expect(JSON.parse(one.out())).toEqual({ ok: true, threadId: 'oc_dev', usage: { used: 12345, window: 200000 }, run: null });

  const two = harness({ history: () => history([bound('t_1', 'oc_multi'), bound('t_2', 'oc_multi')]), context: () => ({ kind: 'context', threadId: 't_2', usage: null, run: null }) });
  const several = await caught(runSessionContext({ group: '多会话群' }, two.io(), two.daemon));
  expect(several).toMatchObject({ kind: 'bad-args', message: expect.stringContaining('t_1  摘要 t_1') });
  expect(several.message).toContain('t_2  摘要 t_2');
  expect(two.actions()).toEqual(['history']);
  // --session picks one of them; one not in this group is an argument error
  await runSessionContext({ group: '多会话群', session: 't_2' }, two.io(), two.daemon);
  expect(two.collaboration).toHaveBeenLastCalledWith({ action: 'context', agentId: 'cli_a', projectName: '多会话群', groupId: 'oc_multi', threadId: 't_2' });
  expect(await caught(runSessionContext({ group: '多会话群', session: 't_9' }, two.io(), two.daemon))).toMatchObject({ kind: 'bad-args', message: '这个群没有会话 t_9。vonvon session list --group oc_multi 列出全部。' });

  const none = harness({ history: () => history([bound('t_old', 'oc_dev', { detached: true })]) });
  expect(await caught(runSessionContext({ group: '研发' }, none.io(), none.daemon))).toMatchObject({ kind: 'bad-args', reason: 'no_session', message: '这个群还没有会话。' });
});

it('session context prints what runs and the commands that act on it', async () => {
  const h = harness({
    history: () => history([bound('t_1', 'oc_multi'), bound('t_2', 'oc_multi')]),
    context: () => ({ kind: 'context', threadId: 't_1', usage: { used: 500, window: null }, run: run({ goal: true, canEndGoal: true, subagents: [
      { id: 's9', name: '查日志', task: 'x', status: 'running', stoppable: true }, { id: 's8', name: '写测试', task: 'y', status: 'completed', stoppable: false },
    ] }) }),
  });
  await runSessionContext({ group: '多会话群', session: 't_1' }, h.io(), h.daemon);
  expect(h.out()).toBe([
    '会话 t_1  摘要 t_1', '上下文 500 · 窗口未知', '正在运行：自主目标',
    '  子 agent s9  查日志  运行中', '    停止它：vonvon session stop-subagent s9 --session t_1 --group oc_multi',
    '  子 agent s8  写测试  已完成', '完成时提醒：未开启',
    '停止任务：vonvon session stop --session t_1 --group oc_multi', '结束目标：vonvon session end-goal --session t_1 --group oc_multi',
    '开启提醒：vonvon session reminder --on --session t_1 --group oc_multi', '',
  ].join('\n'));
  const empty = harness({ history: () => history([bound('oc_dev')]), context: () => ({ kind: 'context', threadId: 'oc_dev', usage: null, run: null }) });
  await runSessionContext({ group: '研发' }, empty.io(), empty.daemon);
  expect(empty.out()).toContain('上下文：暂无可用统计\n');
});

// main 必败: there was no session command
it('refuses a bot that is not running before any collaboration request, not as a conflict', async () => {
  const h = harness({}, { bot: agent({ running: false, connection: 'disconnected' }) });
  for (const command of [
    () => runSessionList({ group: '研发' }, h.io(), h.daemon),
    () => runSessionStop('stop', { group: '研发' }, h.io(), h.daemon),
    () => runSessionReset('clear', { group: '研发' }, h.io(), h.daemon),
  ]) {
    expect(await caught(command())).toMatchObject({ kind: 'refused', reason: 'bot_not_running', message: 'Bot「Vonvon Bot」没在运行。运行 vonvon bot enable cli_a，或者 vonvon bot status cli_a 看原因。' });
  }
  expect(h.collaboration).not.toHaveBeenCalled();
});

// main 必败: there was no session clear
it('session clear refuses a 多会话 group without a request and clears the main-area session of a 单会话 one', async () => {
  const h = harness({ history: () => history([bound('oc_dev')]), clear: () => ({ kind: 'applied', threadId: 'oc_dev', message: '已开始新会话。' }) });
  expect(await caught(runSessionReset('clear', { group: '多会话群' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'not_for_threads', message: '多会话支持压缩上下文；清空仅适用于主区会话。' });
  expect(h.collaboration).not.toHaveBeenCalled();
  await runSessionReset('clear', { group: '研发' }, h.io(true), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'clear', ...target, threadId: 'oc_dev' });
  expect(h.out()).toBe('{"ok":true,"threadId":"oc_dev","message":"已开始新会话。"}\n');
  // a refusal the daemon answers in words passes on as exit 4 with its code
  const refused = harness({ history: () => history([bound('oc_dev')]), clear: () => ({ kind: 'refused', code: 'busy', message: '会话正在运行，请完成后重试' }) });
  expect(await caught(runSessionReset('clear', { group: '研发' }, refused.io(), refused.daemon))).toMatchObject({ kind: 'refused', reason: 'busy', message: '会话正在运行，请完成后重试' });
});

// main 必败: there was no session compact
it('session compact that does not answer in time may have run (6), and says how to look', async () => {
  const h = harness({ history: () => history([bound('oc_dev')]), compact: () => new Promise(() => {}) }, { feishu: 10 });
  const error = await caught(runSessionReset('compact', { group: '研发' }, h.io(), h.daemon));
  expect(error).toMatchObject({ kind: 'outcome-unknown', message: expect.stringContaining('可能已经在压缩，运行 vonvon session context --group oc_dev 看。') });
  const done = harness({ history: () => history([bound('oc_dev')]), compact: () => ({ kind: 'applied', threadId: 'oc_dev', message: '上下文已压缩。', warning: '飞书没回' }) });
  await runSessionReset('compact', { group: '研发' }, done.io(), done.daemon);
  expect(done.out()).toBe('上下文已压缩。\n飞书回执未确认：飞书没回\n');
});

// main 必败: there was no session stop
it('session stop reads the run first: none is exit 0, one that cannot stop is refused, else it stops that run', async () => {
  let current: Run | null = null;
  const h = harness({ history: () => history([bound('oc_dev')]), context: () => ({ kind: 'context', threadId: 'oc_dev', usage: null, run: current }) });
  await runSessionStop('stop', { group: '研发' }, h.io(true), h.daemon);
  expect(h.out()).toBe('{"ok":true,"stopped":false}\n');
  expect(h.actions()).toEqual(['history', 'context']);
  h.clear(); await runSessionStop('stop', { group: '研发' }, h.io(), h.daemon);
  expect(h.out()).toBe('现在没有在跑的任务。\n');
  current = run({ canStop: false });
  expect(await caught(runSessionStop('stop', { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'cannot_stop' });
  expect(h.actions()).not.toContain('stop');
  current = run({ id: 'r1', canStop: true });
  h.clear(); await runSessionStop('stop', { group: '研发' }, h.io(true), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'stop', ...target, threadId: 'oc_dev', runId: 'r1' });
  expect(h.out()).toBe('{"ok":true,"stopped":true,"runId":"r1"}\n');
  // end-goal: a run that is not a goal has none to end
  expect(await caught(runSessionStop('endGoal', { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'cannot_end_goal' });
  current = run({ id: 'r2', goal: true, canEndGoal: true });
  h.clear(); await runSessionStop('endGoal', { group: '研发' }, h.io(), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'endGoal', ...target, threadId: 'oc_dev', runId: 'r2' });
  expect(h.out()).toBe('已结束目标。\n');
});

// main 必败: there was no session reminder
it('session reminder needs a run it can remind of, and --on or --off', async () => {
  let current: Run | null = null;
  const h = harness({ history: () => history([bound('oc_dev')]), context: () => ({ kind: 'context', threadId: 'oc_dev', usage: null, run: current }) });
  expect(await caught(runSessionReminder({ on: true }, { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'cannot_remind', message: '现在没有在跑的任务，完成时提醒只对在跑的任务有用。' });
  current = run({ canRemind: false });
  expect(await caught(runSessionReminder({ on: true }, { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'cannot_remind' });
  current = run();
  await runSessionReminder({ on: true }, { group: '研发' }, h.io(), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'reminder', ...target, threadId: 'oc_dev', runId: 'r1', requested: true });
  expect(h.out()).toBe('已开启提醒。\n');
  h.clear(); await runSessionReminder({ off: true }, { group: '研发' }, h.io(true), h.daemon);
  expect(h.out()).toBe('{"ok":true,"runId":"r1","requested":false}\n');
  const calls = h.collaboration.mock.calls.length;
  for (const switches of [{ on: true, off: true }, {}]) {
    expect(await caught(runSessionReminder(switches, { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'bad-args' });
  }
  expect(h.collaboration).toHaveBeenCalledTimes(calls);
});

// main 必败: there was no session stop-subagent
it('session stop-subagent stops only a running, stoppable subagent of the run', async () => {
  let status: 'running' | 'completed' = 'completed';
  const h = harness({ history: () => history([bound('oc_dev')]), context: () => ({ kind: 'context', threadId: 'oc_dev', usage: null, run: run({ subagents: [{ id: 's9', name: '查日志', task: 'x', status, stoppable: true }] }) }) });
  expect(await caught(runSessionStopSubagent('s9', { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'cannot_stop_subagent' });
  expect(await caught(runSessionStopSubagent('s7', { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'refused', reason: 'cannot_stop_subagent', message: expect.stringContaining('没有子 agent s7') });
  expect(h.actions()).not.toContain('stopSubagent');
  status = 'running';
  await runSessionStopSubagent('s9', { group: '研发' }, h.io(true), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'stopSubagent', ...target, threadId: 'oc_dev', runId: 'r1', subagentId: 's9' });
  expect(h.out()).toBe('{"ok":true,"runId":"r1","subagentId":"s9"}\n');
});

// main 必败: there was no session resume
it('session resume sends the backend the history names, and only a session it lists and has not bound', async () => {
  const h = harness({
    history: () => ({ ...history([bound('oc_dev')], [{ sessionId: 'th_1', preview: 'x', createdAt: 1, updatedAt: 1 }, { sessionId: 's_oc_dev', preview: 'y', createdAt: 1, updatedAt: 1 }]), backend: 'claude-agent' }),
    resume: () => ({ kind: 'applied', threadId: 'oc_dev', message: '已恢复会话。' }),
  });
  await runSessionResume('th_1', { group: '研发' }, h.io(), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'resume', ...target, sessionId: 'th_1', backend: 'claude-agent' });
  expect(h.out()).toBe('已恢复会话。\n');
  expect(await caught(runSessionResume('th_9', { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'bad-args', message: expect.stringContaining('vonvon session list --resumable --group oc_dev') });
  expect(await caught(runSessionResume('s_oc_dev', { group: '研发' }, h.io(), h.daemon))).toMatchObject({ kind: 'bad-args', message: '这条会话已经接在群里了。' });
  expect(h.actions().filter(action => action === 'resume')).toHaveLength(1);
});

// main 必败: the nine kinds were pending C4 in the allowlist
it('covers the web page\'s 会话管理 kinds, none left in the allowlist', async () => {
  const commands = await loadCommands();
  const coverers = (kind: string) => commands.filter(command => command.covers.includes(kind)).map(command => command.path);
  const kinds = { history: 'list', context: 'context', clear: 'clear', compact: 'compact', resume: 'resume', stop: 'stop', endGoal: 'end-goal', stopSubagent: 'stop-subagent', reminder: 'reminder' };
  for (const [kind, command] of Object.entries(kinds)) {
    expect(coverers(`collaboration.${kind}`), kind).toEqual([`session ${command}`]);
    expect(CLI_PARITY_ALLOWLIST[`collaboration.${kind}`], kind).toBeUndefined();
  }
  for (const path of Object.values(kinds)) expect(commands.find(command => command.path === `session ${path}`)?.options, path).toEqual(expect.arrayContaining(['--group', '--bot', '--json']));
});
