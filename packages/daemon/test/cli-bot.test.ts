import { expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, deleteAgentDescription, groupIdSchema, jobIdSchema, membershipIdSchema,
  type AdminSetupStatus, type Agent, type DesktopSnapshot, type Job, type Membership,
} from '@vonvon/protocol';
import { withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runBotAdd, runBotCallback, runBotEnable, runBotRemove, runBotRescan, runBotStatus, stepLines, type AddDependencies } from '../src/cli/commands/bot';
import { CLI_PARITY_ALLOWLIST } from '../src/cli/parity-allowlist';
import { loadCommands } from './helpers/cli-commands';

/** cli-2-bot: bot enable / disable / remove / rescan and bot callback, each through a fake client behind the real withDaemon. */
const agent = (id: string, name = 'Vonvon Bot', extra: Partial<Agent> = {}): Agent => ({ id: agentIdSchema.parse(id), name, enabled: true, running: true, connection: 'connected', activation: 'active', ...extra });
const member = (agentId: string, groupId: string, name: string): Membership => ({
  id: membershipIdSchema.parse(JSON.stringify([agentId, groupId])), agentId: agentIdSchema.parse(agentId), groupId: groupIdSchema.parse(groupId), name, directory: `/work/${name}`,
  backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: { administrator: 'qa', member: 'qa', network: false }, stale: false,
});
const snapshot = (agents: Agent[], memberships: Membership[] = []): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents, groups: [], memberships, tools: [], jobs: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
type Fake = Partial<Record<'snapshot' | 'run' | 'admin' | 'memory' | 'watchSnapshots' | 'onError', (request: never) => unknown>>;
function harness(client: Fake) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, ...client }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, connect, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const failure = (kind: string, message?: unknown, extra: object = {}) => expect.objectContaining({ kind, ...(message === undefined ? {} : { message }), ...extra });
const caught = (promise: Promise<unknown>) => promise.then(() => { throw new Error('resolved'); }, (error: unknown) => error as { kind: string; message: string; reason?: string; partial?: Record<string, unknown> });

/** A daemon whose setAgentEnabled answers `reply` and, when applied, changes the bot it then shows. */
function switchable(reply: (enabled: boolean) => unknown = () => ({ kind: 'applied', revision: 2 }), agents = [agent('cli_a', 'Vonvon Bot', { enabled: false, running: false, connection: 'disconnected' })]) {
  let state = agents;
  const run = vi.fn(async (command: { type: string; agentId: string; enabled: boolean }) => {
    const answer = reply(command.enabled) as { kind: string };
    if (answer.kind === 'applied') state = state.map(each => each.id === command.agentId ? { ...each, enabled: command.enabled, running: command.enabled, connection: command.enabled ? 'connected' : 'disconnected' } : each);
    return answer;
  });
  return { ...harness({ run, snapshot: async () => snapshot(state, [member('cli_a', 'oc_pay', 'pay')]) }), run };
}

// main 必败: there was no bot enable
it('bot enable sends setAgentEnabled and prints the bot as the daemon shows it after the write', async () => {
  const h = switchable();
  await runBotEnable(true, 'cli_a', h.io(true), h.daemon);
  expect(h.run).toHaveBeenCalledWith({ type: 'setAgentEnabled', agentId: 'cli_a', enabled: true });
  const json = JSON.parse(h.out());
  expect(json).toEqual({ ok: true, bot: expect.objectContaining({ id: 'cli_a', enabled: true, running: true }), activation: 'active' });
  h.clear(); await runBotEnable(true, undefined, h.io(), h.daemon);
  expect(h.out()).toBe('已启用「Vonvon Bot」。\nVonvon Bot  cli_a  已启用 · 已连接 · 1 个群\n');
  expect(h.close).toHaveBeenCalledTimes(2);
});

// main 必败: activationPending was a refusal everywhere (want())
it('bot enable exits 0 when the change waits for a restart, and refuses as the daemon does', async () => {
  const pending = switchable(() => ({ kind: 'activationPending', message: '已保存，要重启 daemon 才按新状态运行。' }));
  await runBotEnable(true, 'cli_a', pending.io(), pending.daemon);
  expect(pending.out()).toBe('已保存，要重启 daemon 才按新状态运行。\n');
  pending.clear(); await runBotEnable(true, 'cli_a', pending.io(true), pending.daemon);
  expect(JSON.parse(pending.out())).toMatchObject({ ok: true, activation: 'restartRequired', message: '已保存，要重启 daemon 才按新状态运行。', bot: { id: 'cli_a' } });
  const refused = switchable(() => ({ kind: 'refused', code: 'activation_failed', message: '启用失败：凭据无效。' }));
  expect(await caught(runBotEnable(true, 'cli_a', refused.io(true), refused.daemon))).toEqual(failure('refused', '启用失败：凭据无效。', { reason: 'activation_failed' }));
  expect(refused.out()).toBe('');
  // no reply in time: the switch may have flipped (6)
  const silent = harness({ snapshot: async () => snapshot([agent('cli_a')]), run: () => new Promise(() => {}) });
  expect(await caught(runBotEnable(false, 'cli_a', silent.io(), silent.daemon))).toEqual(failure('outcome-unknown', expect.stringContaining('可能已经改了，运行 vonvon bot list 查看。')));
});

// main 必败: there was no bot disable
it('bot disable sends enabled: false and needs the bot named when there are two', async () => {
  const h = switchable(undefined, [agent('cli_a'), agent('cli_b', '支付')]);
  await runBotEnable(false, '支付', h.io(), h.daemon);
  expect(h.run).toHaveBeenCalledWith({ type: 'setAgentEnabled', agentId: 'cli_b', enabled: false });
  expect(h.out()).toBe('已停用「支付」。\n支付  cli_b  没启用 · 未连接 · 0 个群\n');
  expect(await caught(runBotEnable(false, undefined, h.io(), h.daemon))).toEqual(failure('bad-args', '有 2 个 Bot，用 --bot 指定：Vonvon Bot（cli_a）、支付（cli_b）'));
  expect(h.run).toHaveBeenCalledTimes(1);
});

/** A daemon for `bot remove`: two groups and five memory entries of the bot's own. */
function removable(bot: Agent, o: { memory?: () => Promise<unknown>; deleted?: unknown } = {}) {
  const run = vi.fn(async () => o.deleted ?? { kind: 'applied', revision: 2 });
  const memory = vi.fn(o.memory ?? (async () => ({ kind: 'list', items: [], branches: [], limit: 50, used: 5, verified: true, problems: [] })));
  return { ...harness({ run, memory, snapshot: async () => snapshot([bot], [member('cli_a', 'oc_pay', 'pay'), member('cli_a', 'oc_ops', 'ops')]) }), run, memory };
}

// main 必败: there was no bot remove
it('bot remove without --yes sends nothing and says what the web page asks to confirm', async () => {
  const h = removable(agent('cli_a', '小支'));
  const error = await caught(runBotRemove('cli_a', {}, h.io(true), h.daemon));
  expect(error).toEqual(failure('bad-args', `${deleteAgentDescription('小支', 2, 5)}确认后加 --yes 再运行一次。`, { reason: 'confirm_required' }));
  expect(error.partial).toEqual({ bot: { id: 'cli_a', name: '小支', enabled: true, running: true }, groups: 2, botMemories: 5 });
  expect(h.memory).toHaveBeenCalledWith({ type: 'list', scope: { kind: 'bot', botId: 'cli_a' } });
  expect(h.run).not.toHaveBeenCalled();
  expect(h.out()).toBe('');
  // the count is left out when the memory cannot be read, as on the web page
  const unread = removable(agent('cli_a', '小支'), { memory: async () => { throw new RpcError('internal', '读不到'); } });
  const without = await caught(runBotRemove('小支', {}, unread.io(), unread.daemon));
  expect(without).toEqual(failure('bad-args', expect.not.stringContaining('条 Bot 记忆'), { reason: 'confirm_required' }));
  expect(without.partial).toEqual({ bot: expect.objectContaining({ id: 'cli_a' }), groups: 2 });
  expect(unread.run).not.toHaveBeenCalled();
});

// main 必败: there was no bot remove
it('bot remove --yes refuses an enabled bot before sending, removes a disabled one, and passes on the daemon refusal', async () => {
  const enabled = removable(agent('cli_a'));
  expect(await caught(runBotRemove('cli_a', { yes: true }, enabled.io(), enabled.daemon))).toEqual(failure('refused', '「Vonvon Bot」还启用着：先运行 vonvon bot disable cli_a，等它停下来再移除。', { reason: 'bot_enabled' }));
  expect(enabled.run).not.toHaveBeenCalled();
  const disabled = agent('cli_a', 'Vonvon Bot', { enabled: false, running: false, connection: 'disconnected' });
  const h = removable(disabled);
  await runBotRemove('cli_a', { yes: true }, h.io(true), h.daemon);
  expect(h.run).toHaveBeenCalledWith({ type: 'deleteAgent', agentId: 'cli_a' });
  expect(h.memory).not.toHaveBeenCalled();
  expect(h.out()).toBe('{"ok":true,"removed":{"id":"cli_a","name":"Vonvon Bot"}}\n');
  const refused = removable(disabled, { deleted: { kind: 'refused', code: 'delete_failed', message: 'Bot 还在运行，先停用再移除。' } });
  expect(await caught(runBotRemove('cli_a', { yes: true }, refused.io(), refused.daemon))).toEqual(failure('refused', 'Bot 还在运行，先停用再移除。', { reason: 'delete_failed' }));
});

const jobId = jobIdSchema.parse('7d1f1a6e-3b8e-4d0c-9a51-2f6a0e4b9c12');
const qr = (url: string): Job => ({ id: jobId, type: 'registerAgent', phase: 'qr', image: 'data:', url, expiresAt: new Date(2026, 9, 15, 14, 32).getTime() });
/** A fake daemon for the scan: once the start request is answered it publishes `jobs` one snapshot each. */
function scanner(jobs: Job[], o: { tty?: boolean; onQr?: () => void } = {}) {
  let listener: ((value: DesktopSnapshot) => void) | undefined;
  let interrupt: (() => void) | undefined;
  let revision = 1;
  const publish = (job: Job) => listener?.({ ...snapshot([agent('cli_a')]), revision: ++revision, jobs: [job] });
  const run = vi.fn(async (command: { type: string }) => {
    if (command.type === 'cancelJob') { publish({ id: jobId, type: 'registerAgent', phase: 'cancelled', message: '已取消扫码。' }); return { kind: 'cancelled' }; }
    setTimeout(() => jobs.forEach(publish), 0);
    return { kind: 'started', jobId };
  });
  const h = harness({
    run, snapshot: async () => snapshot([agent('cli_a')]), admin: async () => { throw new RpcError('internal', '飞书接口超时'); },
    watchSnapshots: (next: (value: DesktopSnapshot) => void) => { listener = next; return () => { listener = undefined; }; },
    onError: () => () => {},
  } as never);
  const deps: Partial<AddDependencies> = {
    tty: o.tty ?? true,
    qr: async url => { setTimeout(() => o.onQr?.(), 0); return `[QR ${url}]\n`; },
    onInterrupt: handler => { interrupt = handler; return () => { interrupt = undefined; }; },
  };
  return { ...h, run, rescan: (json = false, wanted?: string) => runBotRescan(wanted, h.io(json), h.daemon, deps), add: () => runBotAdd(h.io(), h.daemon, deps), interrupt: () => interrupt?.() };
}
const saved: Job = { id: jobId, type: 'registerAgent', phase: 'succeeded', message: 'Bot 已保存。', agentId: agentIdSchema.parse('cli_a') };

// main 必败 (the first two): there was no bot rescan
it('bot rescan follows refreshAgentCredentials as bot add follows registerAgent', async () => {
  const json = scanner([{ id: jobId, type: 'registerAgent', phase: 'running', message: '正在创建扫码会话。' }, qr('https://open.feishu.cn/q?a=1'), saved], { tty: false });
  await json.rescan(true);
  expect(json.run).toHaveBeenCalledWith({ type: 'refreshAgentCredentials', agentId: 'cli_a' });
  const lines = json.out().trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  expect(lines.map(line => line.event)).toEqual(['phase', 'qr', 'result']);
  expect(lines[2]).toMatchObject({ ok: true, event: 'result', agentId: 'cli_a', bot: { id: 'cli_a' } });
  expect(json.out()).not.toContain('[QR');
  const piped = scanner([], { tty: false });
  await expect(piped.rescan()).rejects.toEqual(failure('bad-args', expect.stringContaining('vonvon bot rescan --json')));
  expect(piped.connect).not.toHaveBeenCalled();
  const tty = scanner([qr('https://open.feishu.cn/q?a=1'), saved]);
  await tty.rescan(false, 'cli_a');
  expect(tty.out()).toContain('用飞书 App 扫下面的二维码，给「Vonvon Bot」换一套飞书凭据（14:32 前有效）：\n[QR https://open.feishu.cn/q?a=1]\n');
  expect(tty.out()).toContain('✓ 已更新「Vonvon Bot」的飞书凭据。\n');
  const expired = scanner([{ id: jobId, type: 'registerAgent', phase: 'failed', code: 'expired_token', message: '二维码已过期，请重新生成。' }]);
  await expect(expired.rescan()).rejects.toEqual(failure('failed', '二维码已过期，请重新生成。重新运行 vonvon bot rescan cli_a。', { reason: 'expired_token' }));
});

it('bot rescan cancels its job on Ctrl-C, and bot add still starts registerAgent', async () => {
  const s = scanner([qr('https://x')], { onQr: () => s.interrupt() });
  await expect(s.rescan()).rejects.toEqual(failure('interrupted', '已取消扫码。'));
  expect(s.run.mock.calls.map(([command]) => command)).toEqual([{ type: 'refreshAgentCredentials', agentId: 'cli_a' }, { type: 'cancelJob', jobId }]);
  const add = scanner([saved]);
  await add.add();
  expect(add.run.mock.calls.map(([command]) => command)).toEqual([{ type: 'registerAgent' }]);
  expect(add.out()).toContain('✓ 已保存 Bot：Vonvon Bot（cli_a），已启用。\n');
});

const verifiedAt = new Date(2026, 9, 15, 14, 32).getTime();
// main 必败: there was no bot callback
it('bot callback status prints what this computer recorded and what the console has', async () => {
  const cases: Array<[AdminSetupStatus['cardCallback'], string[]]> = [
    [{ confirmed: true, verifiedAt }, ['卡片回调：已收到过真实回调（2026-10-15 14:32）', '开发者后台：没检查']],
    [{ confirmed: true }, ['卡片回调：你已确认配置，还没收到真实回调', '开发者后台：没检查']],
    [{ confirmed: false, configuration: { state: 'wrong-mode', mode: 'webhook' } }, ['卡片回调：还没确认', '开发者后台：配成了 webhook，要改成长连接']],
    [{ confirmed: false, configuration: { state: 'configured', mode: 'websocket' } }, ['卡片回调：还没确认', '开发者后台：已配置（长连接）']],
    [{ confirmed: false, configuration: { state: 'missing' } }, ['卡片回调：还没确认', '开发者后台：没配置']],
    [{ confirmed: false, configuration: { state: 'unchecked', reason: '没权限' } }, ['卡片回调：还没确认', '开发者后台：没检查']],
  ];
  for (const [cardCallback, lines] of cases) {
    const admin = vi.fn(async () => ({ kind: 'cardCallbackStatus', cardCallback }));
    const h = harness({ snapshot: async () => snapshot([agent('cli_a')]), admin });
    await runBotCallback('status', undefined, h.io(), h.daemon);
    expect(h.out()).toBe(`${lines.join('\n')}\n`);
    expect(admin).toHaveBeenCalledWith({ type: 'cardCallbackStatus', agentId: 'cli_a' });
  }
  const h = harness({ snapshot: async () => snapshot([agent('cli_a')]), admin: async () => ({ kind: 'cardCallbackStatus', cardCallback: { confirmed: true, verifiedAt } }) });
  await runBotCallback('status', 'cli_a', h.io(true), h.daemon);
  expect(JSON.parse(h.out())).toEqual({ ok: true, bot: expect.objectContaining({ id: 'cli_a', name: 'Vonvon Bot' }), cardCallback: { confirmed: true, verifiedAt } });
});

// main 必败: there was no bot callback confirm / unconfirm
it('bot callback confirm and unconfirm write, then read the status again', async () => {
  let confirmed = false;
  const admin = vi.fn(async (request: { type: string; confirmed?: boolean }) => {
    if (request.type === 'confirmCardCallback') { confirmed = Boolean(request.confirmed); return { kind: 'applied', revision: 2 }; }
    return { kind: 'cardCallbackStatus', cardCallback: { confirmed } };
  });
  const h = harness({ snapshot: async () => snapshot([agent('cli_a')]), admin });
  await runBotCallback('confirm', 'cli_a', h.io(true), h.daemon);
  expect(admin.mock.calls.map(([request]) => request)).toEqual([{ type: 'confirmCardCallback', agentId: 'cli_a', confirmed: true }, { type: 'cardCallbackStatus', agentId: 'cli_a' }]);
  expect(JSON.parse(h.out())).toMatchObject({ ok: true, bot: { id: 'cli_a' }, confirmed: true, cardCallback: { confirmed: true } });
  h.clear(); await runBotCallback('unconfirm', undefined, h.io(), h.daemon);
  expect(admin).toHaveBeenLastCalledWith({ type: 'cardCallbackStatus', agentId: 'cli_a' });
  expect(admin.mock.calls[2]?.[0]).toEqual({ type: 'confirmCardCallback', agentId: 'cli_a', confirmed: false });
  expect(h.out()).toBe('卡片回调：还没确认\n开发者后台：没检查\n');
  const refused = harness({ snapshot: async () => snapshot([agent('cli_a')]), admin: async () => ({ kind: 'refused', code: 'not_found', message: '没有这个 Bot。' }) });
  expect(await caught(runBotCallback('confirm', 'cli_a', refused.io(), refused.daemon))).toEqual(failure('refused', '没有这个 Bot。', { reason: 'not_found' }));
});

// main 必败: these steps said 在网页里点「…」
it('bot status gives the command for the steps the terminal can do now', async () => {
  const setup: AdminSetupStatus = {
    appId: 'cli_a', tenant: 'feishu', credentials: { ok: false, reason: '凭据无效。' }, connection: { running: false }, event: { state: 'ok' },
    scopes: { missingRequired: [], grantUrl: 'https://open.feishu.cn/app/cli_a/auth' },
    eventConfigUrl: 'https://open.feishu.cn/app/cli_a/event', consoleUrl: 'https://open.feishu.cn/app/cli_a', cardCallback: { confirmed: false },
  };
  const h = harness({ snapshot: async () => snapshot([agent('cli_a', 'Vonvon Bot', { enabled: false, running: false, connection: 'disconnected' })]), admin: async () => ({ kind: 'setupStatus', status: setup }) });
  await runBotStatus(undefined, h.io(), h.daemon);
  const out = h.out();
  expect(out).toContain('✗ 飞书应用：凭据无效\n    凭据无效。\n    运行 vonvon bot rescan cli_a\n');
  expect(out).toContain('! 长连接：没有启用\n    启用后 Bot 会连上飞书，事件设置页才能保存长连接方式。\n    运行 vonvon bot enable cli_a\n');
  expect(out).toContain('    运行 vonvon bot callback confirm cli_a\n');
  expect(out).not.toContain('在网页里点「启用 Bot」');
  expect(out).not.toContain('在网页里点「重新扫码」');
  expect(out).not.toContain('在网页里点「我已配置」');
  // 撤销确认 sits on a finished step, so no status prints it today; the line is there for when one does
  expect(stepLines({ id: 'callback', title: '卡片回调', status: '已手动确认', tone: 'success', done: false, actions: [{ kind: 'confirmCallback', label: '撤销确认', confirmed: false }] }, 'cli_a'))
    .toEqual(['✓ 卡片回调：已手动确认', '    运行 vonvon bot callback unconfirm cli_a']);
  expect(stepLines({ id: 'claude', title: 'Claude', status: '无法确认', tone: 'neutral', done: false, actions: [{ kind: 'environment', label: '去本机环境' }] }, 'cli_a'))
    .toEqual(['· Claude：无法确认', '    运行 vonvon env scan']);
});

// main 必败: the five kinds were pending C2 in the allowlist
it('covers the five kinds of the web page\'s bot actions, none left in the allowlist', async () => {
  const commands = await loadCommands();
  const coverers = (kind: string) => commands.filter(command => command.covers.includes(kind)).map(command => command.path);
  expect(coverers('command.setAgentEnabled')).toEqual(['bot enable', 'bot disable']);
  expect(coverers('command.deleteAgent')).toEqual(['bot remove']);
  expect(coverers('command.refreshAgentCredentials')).toEqual(['bot rescan']);
  expect(coverers('admin.cardCallbackStatus')).toEqual(['bot callback status']);
  expect(coverers('admin.confirmCardCallback')).toEqual(['bot callback confirm', 'bot callback unconfirm']);
  for (const kind of ['command.setAgentEnabled', 'command.deleteAgent', 'command.refreshAgentCredentials', 'admin.cardCallbackStatus', 'admin.confirmCardCallback']) expect(CLI_PARITY_ALLOWLIST[kind], kind).toBeUndefined();
  expect(commands.find(command => command.path === 'bot remove')?.options).toEqual(expect.arrayContaining(['--yes', '--json']));
});
