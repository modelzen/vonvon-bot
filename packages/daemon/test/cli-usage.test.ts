import { expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, groupIdSchema, membershipIdSchema,
  type AdminRequest, type Agent, type CollaborationReply, type CollaborationRequest, type DesktopSnapshot, type Membership,
} from '@vonvon/protocol';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { parseSections, runUsageJudge, runUsageShare, runUsageShow } from '../src/cli/commands/usage';
import { CLI_PARITY_ALLOWLIST } from '../src/cli/parity-allowlist';
import { loadCommands } from './helpers/cli-commands';

/** cli-4-sessions: vonvon usage show / share / judge, through a fake client behind the real withDaemon. */
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: agentIdSchema.parse('cli_a'), name: 'Vonvon Bot', enabled: true, running: true, connection: 'connected', activation: 'active', ...extra });
const member: Membership = {
  id: membershipIdSchema.parse(JSON.stringify(['cli_a', 'oc_dev'])), agentId: agentIdSchema.parse('cli_a'), groupId: groupIdSchema.parse('oc_dev'), name: '研发', directory: '/work/研发',
  backend: 'codex-appserver', conversation: 'shared', response: 'mention', permission: { administrator: 'qa', member: 'qa', network: false }, stale: false,
};
const snapshot = (bot: Agent): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents: [bot], groups: [], memberships: [member], tools: [], jobs: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
const reset = new Date(2026, 10, 1, 14, 30).getTime();
type Usage = Extract<CollaborationReply, { kind: 'usage' }>['data'];
const data: Usage = {
  profile: { displayName: '小王', lifetimeTokens: 1234567, currentStreakDays: 5, topInvocations: [], dailyBuckets: [] },
  usage: {
    planType: 'pro', fetchedAt: reset,
    main: { primary: { usedPercent: 42, windowSeconds: 5 * 3600, resetAt: reset / 1000 }, secondary: { usedPercent: 10.4, windowSeconds: 7 * 86400 } },
    extras: [{ name: 'GPT-6', primary: { usedPercent: 3 } }],
  },
};

function harness(o: { bot?: Agent; collaboration?: (request: CollaborationRequest) => unknown; admin?: (request: AdminRequest) => unknown } = {}) {
  const collaboration = vi.fn(async (request: CollaborationRequest) => (o.collaboration ?? (() => ({ kind: 'applied', messageId: 'om_1' })))(request));
  const admin = vi.fn(async (request: AdminRequest) => o.admin?.(request));
  const client = { close: async () => {}, snapshot: async () => snapshot(o.bot ?? agent()), collaboration, admin };
  const daemon: Daemon = fn => withDaemon(fn, async () => client as unknown as VonvonClient, { local: 50, feishu: 50 });
  let out = '';
  return { collaboration, admin, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string });

// main 必败: there was no usage show
it('usage show reads the account, --refresh as the web page\'s 刷新, with the bot stopped too', async () => {
  const h = harness({ bot: agent({ running: false }), collaboration: () => ({ kind: 'usage', data }) });
  await runUsageShow({ refresh: true }, h.io(true), h.daemon);
  expect(h.collaboration).toHaveBeenCalledWith({ action: 'usage', force: true });
  expect(JSON.parse(h.out())).toEqual({ ok: true, data });
  h.clear(); await runUsageShow({}, h.io(), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'usage', force: false });
  expect(h.out()).toBe([
    'Codex 账号：小王 · 套餐 pro（所有 Bot 共用）',
    '5 小时限额：已用 42% · 2026-11-01 14:30 重置',
    '7 天限额：已用 10%',
    'GPT-6：已用 3%；暂不可用',
    '累计 Token：1,234,567',
    '连续活跃：5 天',
    '读取于 2026-11-01 14:30',
    '',
  ].join('\n'));
  // the daemon says why it cannot read (not logged in), with its code
  const out = harness({ collaboration: () => { throw new RpcError('usage_unavailable', '请先登录 Codex，再查看用量。'); } });
  expect(await caught(runUsageShow({}, out.io(), out.daemon))).toMatchObject({ kind: 'failed', reason: 'usage_unavailable', message: expect.stringContaining('请先登录 Codex') });
});

// main 必败: there was no usage share
it('usage share posts the sections asked for in the group, through its running bot', async () => {
  const h = harness();
  await runUsageShare({ group: '研发', sections: 'stats, plan' }, h.io(true), h.daemon);
  expect(h.collaboration).toHaveBeenCalledWith({ action: 'shareUsage', agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev', sections: ['stats', 'plan'] });
  expect(h.out()).toBe('{"ok":true,"messageId":"om_1"}\n');
  h.clear(); await runUsageShare({ group: 'oc_dev' }, h.io(), h.daemon);
  expect(h.collaboration).toHaveBeenLastCalledWith({ action: 'shareUsage', agentId: 'cli_a', projectName: '研发', groupId: 'oc_dev' });
  expect(h.out()).toBe('已在「研发」生成可转发的用量卡片。\n');
  const calls = h.collaboration.mock.calls.length;
  expect(await caught(runUsageShare({ group: '研发', sections: 'stats,foo' }, h.io(), h.daemon))).toMatchObject({ kind: 'bad-args', message: expect.stringContaining('不认识 foo') });
  expect(h.collaboration).toHaveBeenCalledTimes(calls);
  expect(parseSections('plan,plan')).toEqual(['plan']);
  expect(() => parseSections(',')).toThrow(/--sections/);
  const stopped = harness({ bot: agent({ running: false }) });
  expect(await caught(runUsageShare({ group: '研发' }, stopped.io(), stopped.daemon))).toMatchObject({ kind: 'refused', reason: 'bot_not_running' });
  expect(stopped.collaboration).not.toHaveBeenCalled();
});

// main 必败: there was no usage judge
it('usage judge prints each day with its sources and bots, and the bots it could not read', async () => {
  const days = [
    { date: '2026-11-01', total: 0, sources: [], bots: [] },
    { date: '2026-10-31', total: 128, sources: [{ kind: 'decision' as const, id: 'typesafe', label: 'TypeSafe', count: 100 }, { kind: 'llm' as const, id: 'codex', label: 'Codex', count: 28 }], bots: [{ agentId: 'cli_a', agentName: 'Vonvon Bot', count: 128 }] },
    { date: '2026-10-30', total: 0, sources: [], bots: [] },
  ];
  const h = harness({ admin: () => ({ kind: 'judgeUsage', days, unreadBots: 0 }) });
  await runUsageJudge(h.io(true), h.daemon);
  expect(h.admin).toHaveBeenCalledWith({ type: 'judgeUsage' });
  expect(h.out()).toBe(`${JSON.stringify({ ok: true, days, unreadBots: 0 })}\n`);
  h.clear(); await runUsageJudge(h.io(), h.daemon);
  expect(h.out()).toBe([
    '2026-11-01  共 0 次',
    '2026-10-31  共 128 次', '  决策模型 Jev  100 次', '  语言模型 Codex  28 次', '  Vonvon Bot（cli_a）  128 次',
    '',
  ].join('\n'));
  const unread = harness({ admin: () => ({ kind: 'judgeUsage', days: [days[0]], unreadBots: 2 }) });
  await runUsageJudge(unread.io(), unread.daemon);
  expect(unread.out()).toContain('有 2 个 Bot 的记录读不了');
});

// main 必败: the three kinds were pending C4 in the allowlist
it('covers the web page\'s 用量 kinds, none left in the allowlist', async () => {
  const commands = await loadCommands();
  const coverers = (kind: string) => commands.filter(command => command.covers.includes(kind)).map(command => command.path);
  for (const [kind, path] of [['collaboration.usage', 'usage show'], ['collaboration.shareUsage', 'usage share'], ['admin.judgeUsage', 'usage judge']]) {
    expect(coverers(kind!), kind).toEqual([path]);
    expect(CLI_PARITY_ALLOWLIST[kind!], kind).toBeUndefined();
  }
});
