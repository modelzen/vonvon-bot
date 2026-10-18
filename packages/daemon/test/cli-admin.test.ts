import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { ConnectionError, RpcError, type VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, groupIdSchema, jobIdSchema, membershipIdSchema, settingsReplySchema,
  type AdminSetupStatus, type Agent, type DesktopSnapshot, type Job, type Membership, type SettingsReply, type ToolState,
} from '@vonvon/protocol';
import { pickBot, withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runBotAdd, runBotList, runBotRepairDir, runBotStatus, type AddDependencies } from '../src/cli/commands/bot';
import { runGroupBind, runGroupJoined, runGroupPending } from '../src/cli/commands/group';
import { parseAssignments, runSettingsGet, runSettingsSet } from '../src/cli/commands/settings';

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });
const agent = (id: string, name = 'Vonvon Bot', extra: Partial<Agent> = {}): Agent => ({ id: agentIdSchema.parse(id), name, enabled: true, running: true, connection: 'connected', activation: 'active', ...extra });
const member = (agentId: string, groupId: string, name: string): Membership => ({
  id: membershipIdSchema.parse(JSON.stringify([agentId, groupId])), agentId: agentIdSchema.parse(agentId), groupId: groupIdSchema.parse(groupId), name, directory: `/home/u/${name}`,
  backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: { administrator: 'qa', member: 'qa', network: false }, stale: false,
});
const snapshot = (agents: Agent[], memberships: Membership[] = [], tools: ToolState[] = []): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents, groups: [], memberships, tools, jobs: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
const section = (stored: object, revision = `rev-${Object.keys(stored)[0]}`, effective = stored) => ({ stored, effective, revision, access: { kind: 'writable' }, apply: [] });

/** A fake client behind the real withDaemon, with timers short enough to hit. */
function harness(client: Partial<Record<'snapshot' | 'run' | 'admin' | 'settings' | 'directory' | 'watchSnapshots' | 'onError', (request: never) => unknown>>) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, ...client }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, connect, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const one = (agents = [agent('cli_a')], memberships: Membership[] = [], tools: ToolState[] = []) => async () => snapshot(agents, memberships, tools);

it('picks a bot by id or a unique name and lists the choices otherwise', () => {
  const [a, b, c] = [agent('cli_a'), agent('cli_b'), agent('cli_c', '支付')];
  expect(() => pickBot([])).toThrow('还没有 Bot。');
  expect(pickBot([a])).toBe(a);
  expect(() => pickBot([a, b, c])).toThrow('有 3 个 Bot，用 --bot 指定：Vonvon Bot（cli_a）、Vonvon Bot（cli_b）、支付（cli_c）');
  expect(pickBot([a, b, c], 'cli_b')).toBe(b);
  expect(pickBot([a, b, c], '支付')).toBe(c);
  expect(() => pickBot([a, b, c], 'Vonvon Bot')).toThrow('有 2 个 Bot 都叫「Vonvon Bot」，用 id 指定：cli_a、cli_b');
  expect(() => pickBot([a], 'x')).toThrow('没有找到 Bot「x」。现有的 Bot：Vonvon Bot（cli_a）');
});

it('bot repair-dir says how many directories it recorded and which will be made again (s36c2d)', async () => {
  const h = harness({});
  const repair = vi.fn(async () => ({ handle: '研发助手', recorded: 2, missing: 1, others: ['测试', '运维'] }));
  await runBotRepairDir('研发助手', h.io(), repair);
  expect(repair).toHaveBeenCalledWith('研发助手');
  expect(h.out()).toBe('✓ 已按现在的位置重新记录「研发助手」的 2 个目录。\n另有 1 个目录不在了，下次用到时会重建一个空的。\n'
    + '同一个项目根目录下的 bot 也要各运行一次：vonvon bot repair-dir 测试；vonvon bot repair-dir 运维。\n');
  h.clear(); await runBotRepairDir('研发助手', h.io(true), repair);
  expect(JSON.parse(h.out())).toEqual({ handle: '研发助手', recorded: 2, missing: 1, others: ['测试', '运维'] });
  expect(h.connect).not.toHaveBeenCalled();
});

it('bot list shows state and connection, and its JSON has no avatars', async () => {
  const h = harness({ snapshot: one([agent('cli_a', 'Vonvon Bot', { avatarDataUrl: 'data:image/png;base64,AAAA' }), agent('cli_b', '旧的', { enabled: false, connection: 'disconnected', activation: 'restartRequired' })], [member('cli_a', 'oc_pay', 'pay')]) });
  await runBotList(h.io(), h.daemon);
  expect(h.out()).toBe('Vonvon Bot  cli_a  已启用 · 已连接 · 1 个群\n旧的  cli_b  没启用 · 未连接 · 0 个群 · 还没按新状态运行\n');
  h.clear(); await runBotList(h.io(true), h.daemon);
  expect(JSON.parse(h.out()).bots.map((bot: Agent) => bot.id)).toEqual(['cli_a', 'cli_b']);
  expect(h.out()).not.toContain('avatarDataUrl');
  expect(h.close).toHaveBeenCalledTimes(2);
});

it('bot list and bot status show a bot paused alone, and every bot of a paused daemon (s18a)', async () => {
  const paused = agent('cli_a', 'Vonvon Bot', { running: false, connection: 'disconnected', paused: { since: 1, crashes: 3 } });
  const h = harness({ snapshot: one([paused, agent('cli_b', '另一个')]), admin: vi.fn(async () => { throw new Error('读不到'); }) });
  await runBotList(h.io(), h.daemon);
  expect(h.out()).toBe('Vonvon Bot  cli_a  已暂停（10 分钟内崩溃了 3 次） · 未连接 · 0 个群\n另一个  cli_b  已启用 · 已连接 · 0 个群\n');
  h.clear(); await expect(runBotStatus('cli_a', h.io(), h.daemon)).rejects.toThrow();
  expect(h.out().split('\n').slice(0, 2)).toEqual(['Vonvon Bot（cli_a）', '已暂停：10 分钟内崩溃了 3 次，没有自动重启。查完原因后在网页的状态与诊断页点「恢复运行」，或运行 vonvon daemon restart。']);
  const host = snapshot([agent('cli_b', '另一个', { running: false, connection: 'disconnected' })]);
  const down = harness({ snapshot: async () => ({ ...host, application: { ...host.application, crashes: { paused: { since: 1, crashes: 4 }, records: [] } } }) });
  await runBotList(down.io(), down.daemon);
  expect(down.out()).toBe('另一个  cli_b  daemon 已暂停 · 未连接 · 0 个群\n');
});

it('human output drops control characters from Feishu names and --json keeps them', async () => {
  const name = '\u001b[2J坏\u009b31m名\r\n字';
  const h = harness({ snapshot: one([agent('cli_a', name, { readError: '读\u0007不到' })]) });
  await runBotList(h.io(), h.daemon);
  expect(h.out()).toBe('[2J坏31m名字  cli_a  已启用 · 已连接 · 0 个群 · 读取失败：读不到\n');
  h.clear(); await runBotList(h.io(true), h.daemon);
  expect(JSON.parse(h.out()).bots[0].name).toBe(name);
  await expect(h.daemon(async () => pickBot([agent('cli_a', name)], 'x'))).rejects.toThrow(/^没有找到 Bot「x」。现有的 Bot：\[2J坏31m名字（cli_a）$/);
});

it('bot status prints the checklist with its links and next steps', async () => {
  const setup: AdminSetupStatus = {
    appId: 'cli_a', tenant: 'feishu', credentials: { ok: true }, connection: { running: true, connection: 'connected' }, event: { state: 'unpublished' },
    scopes: { missingRequired: ['im:message:readonly', 'im:resource'], grantUrl: 'https://open.feishu.cn/app/cli_a/auth?q=im:resource' },
    eventConfigUrl: 'https://open.feishu.cn/app/cli_a/event', consoleUrl: 'https://open.feishu.cn/app/cli_a', cardCallback: { confirmed: false },
  };
  const admin = vi.fn(async () => ({ kind: 'setupStatus', status: setup }));
  const h = harness({ snapshot: one(undefined, [], [{ tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1' }]), admin });
  await runBotStatus(undefined, h.io(), h.daemon);
  expect(admin).toHaveBeenCalledWith({ type: 'setupStatus', agentId: 'cli_a' });
  for (const line of ['Vonvon Bot（cli_a）', '✓ 飞书应用：凭据有效', '! 权限：还缺 2 项', '    - im:message:readonly', '    - im:resource', `    一键开权限：${setup.scopes.grantUrl}`,
    '· 卡片回调：请手动确认', '    打开事件设置：https://open.feishu.cn/app/cli_a/event', '    在网页里点「我已配置」（vonvon open）', '✓ Codex：可用 · 0.156.1', '· 后台服务：不支持', '还有 4 步没完成。']) expect(h.out()).toContain(`${line}\n`);
  h.clear(); await runBotStatus('cli_a', h.io(true), h.daemon);
  const json = JSON.parse(h.out());
  expect(json.steps.map((step: { id: string }) => step.id)).toEqual(['credentials', 'scopes', 'connection', 'event', 'callback', 'publish', 'codex', 'claude', 'service']);
  expect(json).toMatchObject({ bot: { id: 'cli_a' }, setup: { appId: 'cli_a' }, ready: false });
});

it('bot status still prints the connection and tool steps when the checklist read fails, then exits 1', async () => {
  const h = harness({ snapshot: one(undefined, [], [{ tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1' }]), admin: async () => { throw new RpcError('internal', '飞书接口超时'); } });
  await expect(runBotStatus(undefined, h.io(), h.daemon)).rejects.toThrow('清单没有读全，稍后重新运行 vonvon bot status。');
  expect(h.out()).toBe(['Vonvon Bot（cli_a）', '! 飞书应用：检测失败', '    读取清单状态失败：飞书接口超时', '✓ 长连接：已连接', '✓ Codex：可用 · 0.156.1',
    '· Claude：无法确认', '    在网页里点「去本机环境」（vonvon open）', '· 后台服务：不支持', '    这台电脑不支持后台服务。', ''].join('\n'));
  h.clear(); await expect(runBotStatus(undefined, h.io(true), h.daemon)).rejects.toThrow('清单没有读全');
  const json = JSON.parse(h.out());
  expect(json).toMatchObject({ problem: '读取清单状态失败：飞书接口超时', ready: false });
  expect(json.steps.map((step: { id: string }) => step.id)).toEqual(['credentials', 'connection', 'codex', 'claude', 'service']);
});

it('bot status prints the service step after the tools without counting it', async () => {
  const setup: AdminSetupStatus = {
    appId: 'cli_a', tenant: 'feishu', credentials: { ok: true }, connection: { running: true, connection: 'connected' }, event: { state: 'ok', version: '1.0.0' },
    scopes: { missingRequired: [], grantUrl: 'https://open.feishu.cn/app/cli_a/auth' },
    eventConfigUrl: 'https://open.feishu.cn/app/cli_a/event', consoleUrl: 'https://open.feishu.cn/app/cli_a', cardCallback: { confirmed: true },
  };
  const status = (application: DesktopSnapshot['application']) => async () => ({ ...snapshot([agent('cli_a')], [], [{ tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1' }]), application });
  const mac = harness({ snapshot: status({ platform: 'macos', version: '1', loginItem: false, dataPath: '/x', service: { state: 'not-installed', skipped: false } }), admin: async () => ({ kind: 'setupStatus', status: setup }) });
  await runBotStatus(undefined, mac.io(), mac.daemon);
  expect(mac.out()).toContain(['✓ Codex：可用 · 0.156.1', '· Claude：无法确认', '    在网页里点「去本机环境」（vonvon open）',
    '! 登录电脑时自动运行 Bot（推荐）：推荐打开', '    打开后 Bot 跑在 macOS 的后台服务里：退出 app、注销再登录都在线，崩溃后自动重启。',
    '    运行 vonvon service install', '    在网页里点「跳过」（vonvon open）', '全部就绪。', ''].join('\n'));
  mac.clear(); await runBotStatus(undefined, mac.io(true), mac.daemon);
  expect(JSON.parse(mac.out())).toMatchObject({ ready: true, steps: expect.arrayContaining([expect.objectContaining({ id: 'service', done: false })]) });
  const linux = harness({ snapshot: status({ platform: 'linux', version: '1', loginItem: false, dataPath: '/x', service: { state: 'not-installed', skipped: false } }), admin: async () => ({ kind: 'setupStatus', status: setup }) });
  await runBotStatus(undefined, linux.io(), linux.daemon);
  expect(linux.out()).toContain('· 后台服务：没装\n    在终端运行 vonvon service install，装成 systemd 用户服务，崩溃后自动重启。\n全部就绪。\n');
  // s20a: the Linux steps follow the tools and are not counted either.
  const tools: ToolState[] = [{ tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1' },
    { tool: 'claude', installation: 'installed', authentication: 'unknown', version: '0.3.296', sandbox: { bwrap: '/usr/bin/bwrap', socat: true, userns: 'apparmor' } }];
  const sandboxed = harness({ snapshot: async () => ({ ...snapshot([agent('cli_a')], [], tools), application: { platform: 'linux', version: '1', loginItem: false, dataPath: '/x' } }), admin: async () => ({ kind: 'setupStatus', status: setup }) });
  await runBotStatus(undefined, sandboxed.io(), sandboxed.daemon);
  const out = sandboxed.out();
  expect(out).toMatch(/· Codex 的权限档：只能用完全访问\n    Linux 上 Codex 的沙箱只挡写/);
  expect(out).toContain("! Claude 的权限档：被 AppArmor 挡住\n");
  // The commands are not indented: an indented closing EOF would not end the heredoc when pasted into a shell.
  expect(out).toContain(["\n\nsudo tee /etc/apparmor.d/bwrap >/dev/null <<'EOF'", 'abi <abi/4.0>,', 'include <tunables/global>',
    'profile bwrap /usr/bin/bwrap flags=(unconfined) {', '  userns,', '  include if exists <local/bwrap>', '}', 'EOF',
    'sudo apparmor_parser -r /etc/apparmor.d/bwrap\n\n'].join('\n'));
  expect(out.indexOf('Claude 的权限档')).toBeLessThan(out.indexOf('后台服务'));
  expect(out).toMatch(/全部就绪。\n$/);
  sandboxed.clear(); await runBotStatus(undefined, sandboxed.io(true), sandboxed.daemon);
  expect(JSON.parse(sandboxed.out())).toMatchObject({ ready: true, steps: expect.arrayContaining([expect.objectContaining({ id: 'claude-sandbox', done: false })]) });
});

const jobId = jobIdSchema.parse('7d1f1a6e-3b8e-4d0c-9a51-2f6a0e4b9c12');
const qr = (url: string, status?: string): Job => ({ id: jobId, type: 'registerAgent', phase: 'qr', image: 'data:', url, expiresAt: new Date(2026, 9, 15, 14, 32).getTime(), ...(status ? { status } : {}) });
/**
 * A fake daemon for `bot add`: once registerAgent is answered it publishes `jobs` one snapshot each; `dropAt` drops the
 * connection before that job instead. `onQr` runs as each QR is drawn.
 */
function scanner(jobs: Job[], o: { reply?: unknown; dropAt?: number; onQr?: () => void; admin?: () => Promise<unknown>; tty?: boolean } = {}) {
  let listener: ((value: DesktopSnapshot) => void) | undefined;
  let lost: ((error: Error) => void) | undefined;
  let interrupt: (() => void) | undefined;
  let revision = 1;
  const publish = (job: Job) => listener?.({ ...snapshot([]), revision: ++revision, jobs: [job] });
  const run = vi.fn(async (command: { type: string }) => {
    if (command.type === 'cancelJob') { publish({ id: jobId, type: 'registerAgent', phase: 'cancelled', message: '已取消扫码。' }); return { kind: 'cancelled' }; }
    setTimeout(() => jobs.slice(0, o.dropAt).forEach(publish), 0);
    if (o.dropAt !== undefined) setTimeout(() => lost?.(new ConnectionError(new Error('Daemon connection closed'))), 20);
    return o.reply ?? { kind: 'started', jobId };
  });
  const h = harness({
    run, snapshot: one([agent('cli_new', '新\u001b[2Jbot')]), admin: o.admin ?? (async () => { throw new RpcError('internal', '飞书接口超时'); }),
    watchSnapshots: (next: (value: DesktopSnapshot) => void) => { listener = next; return () => { listener = undefined; }; },
    onError: (next: (error: Error) => void) => { lost = next; return () => { lost = undefined; }; },
  } as never);
  const exitCode = vi.fn();
  const deps: Partial<AddDependencies> = {
    tty: o.tty ?? true, exitCode,
    qr: async url => { setTimeout(() => o.onQr?.(), 0); return `[QR ${url}]\n`; },
    onInterrupt: handler => { interrupt = handler; return () => { interrupt = undefined; }; },
  };
  return { ...h, run, exitCode, add: () => runBotAdd(h.io(), h.daemon, deps), interrupt: () => interrupt?.(), interrupted: () => interrupt === undefined };
}

it('bot add draws the QR, draws it again for a new link, and prints the saved bot', async () => {
  const s = scanner([{ id: jobId, type: 'registerAgent', phase: 'running', message: '正在创建扫码会话。' }, qr('https://open.feishu.cn/q?a=1'), qr('https://open.feishu.cn/q?a=1', 'slow_down'),
    qr('https://open.feishu.cn/q?a=1', 'domain_switched'), qr('https://open.larksuite.com/q?a=\u0007'), { id: jobId, type: 'registerAgent', phase: 'succeeded', message: 'Bot 已保存。', agentId: agentIdSchema.parse('cli_new') }]);
  await s.add();
  expect(s.out()).toBe(['正在创建扫码会话。', '用飞书 App 扫下面的二维码，建一个新的飞书应用（14:32 前有效）：', '[QR https://open.feishu.cn/q?a=1]', '扫不了的话，在手机飞书里打开：https://open.feishu.cn/q?a=1', '等你在飞书里确认…（Ctrl-C 取消）',
    '识别到国际版租户，改用 larksuite.com。', '用飞书 App 扫下面的二维码，建一个新的飞书应用（14:32 前有效）：', '[QR https://open.larksuite.com/q?a=\u0007]', '扫不了的话，在手机飞书里打开：https://open.larksuite.com/q?a=', '等你在飞书里确认…（Ctrl-C 取消）',
    '✓ 已保存 Bot：新[2Jbot（cli_new），已启用。', '清单没读到：读取清单状态失败：飞书接口超时。稍后运行 vonvon bot status。', ''].join('\n'));
  expect(s.run).toHaveBeenCalledWith({ type: 'registerAgent' });
  expect(s.exitCode).not.toHaveBeenCalled();
  expect(s.interrupted()).toBe(true);
  expect(s.close).toHaveBeenCalledTimes(1);
  const setup: AdminSetupStatus = {
    appId: 'cli_new', tenant: 'feishu', credentials: { ok: true }, connection: { running: true, connection: 'connected' }, event: { state: 'unpublished' },
    scopes: { missingRequired: ['im:message:readonly'], grantUrl: 'https://open.feishu.cn/app/cli_new/auth' }, eventConfigUrl: 'https://open.feishu.cn/app/cli_new/event', consoleUrl: 'https://open.feishu.cn/app/cli_new', cardCallback: { confirmed: false },
  };
  const read = scanner([{ id: jobId, type: 'registerAgent', phase: 'succeeded', message: 'Bot 已保存。', agentId: agentIdSchema.parse('cli_new') }], { admin: async () => ({ kind: 'setupStatus', status: setup }) });
  await read.add();
  expect(read.out()).toContain('接下来在飞书开发者后台做完这几步，做完一步运行 vonvon bot status 看进度：\n✓ 飞书应用：凭据有效\n! 权限：还缺 1 项\n    一键开权限会预选下面这些权限，在飞书开发者后台确认即可。\n    - im:message:readonly\n');
});

it('bot add exits 1 for a failed, expired or busy scan and one cancelled elsewhere', async () => {
  await expect(scanner([{ id: jobId, type: 'registerAgent', phase: 'failed', code: 'expired_token', message: '二维码已过期，请重新生成。' }]).add()).rejects.toThrow(/^二维码已过期，请重新生成。重新运行 vonvon bot add。$/);
  await expect(scanner([{ id: jobId, type: 'registerAgent', phase: 'failed', code: 'access_denied', message: '用户拒绝了授权。' }]).add()).rejects.toThrow(/^用户拒绝了授权。$/);
  await expect(scanner([qr('https://x'), { id: jobId, type: 'registerAgent', phase: 'cancelled', message: '已取消扫码。' }]).add()).rejects.toThrow('扫码被取消了：可能在网页里又开了一次注册（同一时间只能有一个）。');
  await expect(scanner([], { reply: { kind: 'refused', code: 'registration_busy', message: '已有注册正在保存，请稍后重试。' } }).add()).rejects.toThrow(/^已有注册正在保存，请稍后重试。$/);
});

it('bot add cancels its scan on Ctrl-C, refuses a pipe, and tells a dropped connection before and after the QR', async () => {
  const s = scanner([qr('https://x')], { onQr: () => s.interrupt() });
  await s.add();
  expect(s.run.mock.calls.map(([command]) => command)).toEqual([{ type: 'registerAgent' }, { type: 'cancelJob', jobId }]);
  expect(s.out()).toMatch(/等你在飞书里确认…（Ctrl-C 取消）\n已取消扫码。\n$/);
  expect(s.exitCode).toHaveBeenCalledWith(130);
  expect(s.close).toHaveBeenCalledTimes(1);
  const piped = scanner([], { tty: false });
  await expect(piped.add()).rejects.toThrow('vonvon bot add 要在终端里运行：二维码打进日志会被别人扫走。没有终端的话，用网页注册（vonvon open --print）。');
  expect(piped.connect).not.toHaveBeenCalled();
  await expect(scanner([qr('https://x')], { dropAt: 0 }).add()).rejects.toThrow('和 daemon 的连接断了，扫码已经取消。重新运行 vonvon bot add。');
  await expect(scanner([qr('https://x'), qr('https://x')], { dropAt: 1 }).add()).rejects.toThrow('不知道扫码有没有完成：运行 vonvon bot list 看看。');
});

it('group joined follows pages, stops on a repeated cursor or at 20 pages', async () => {
  const run = vi.fn(async (command: { cursor?: string }) => command.cursor
    ? { kind: 'groups', groups: [{ id: 'oc_1', name: '一', bound: true }, { id: 'oc_2', name: '二', bound: false }], nextCursor: 'p2' }
    : { kind: 'groups', groups: [{ id: 'oc_1', name: '一', bound: true }], nextCursor: 'p2' });
  const h = harness({ snapshot: one(), run });
  await runGroupJoined({}, h.io(true), h.daemon);
  expect(run).toHaveBeenCalledTimes(2);
  expect(JSON.parse(h.out())).toEqual({ groups: [{ id: 'oc_1', name: '一', bound: true }, { id: 'oc_2', name: '二', bound: false }], complete: true });
  let page = 0;
  const endless = harness({ snapshot: one(), run: async () => ({ kind: 'groups', groups: [], nextCursor: `c${++page}` }) });
  await runGroupJoined({}, endless.io(), endless.daemon);
  expect(page).toBe(20);
  expect(endless.out()).toContain('只显示了前 1000 个群。');
});

it('group pending leaves out groups already bound to this bot', async () => {
  const run = async () => ({ kind: 'pendingGroups', groups: [{ chatId: 'oc_pay', name: '支付组', addedAt: 1 }, { chatId: 'oc_new', name: '新群', addedAt: 2 }] });
  const h = harness({ snapshot: one(undefined, [member('cli_a', 'oc_pay', 'pay'), member('cli_b', 'oc_new', 'new')]), run });
  await runGroupPending({}, h.io(true), h.daemon);
  expect(JSON.parse(h.out()).groups.map((group: { chatId: string }) => group.chatId)).toEqual(['oc_new']);
});

it('group pending reports the daemon refusal and still closes', async () => {
  const h = harness({ snapshot: one(), run: async () => { throw new RpcError('conflict', 'Bot 没启用或没在运行'); } });
  await expect(runGroupPending({}, h.io(), h.daemon)).rejects.toThrow('查待绑定的群失败：Bot 没启用或没在运行');
  expect(h.close).toHaveBeenCalledTimes(1);
});

it('group bind sends an absolute folder, the chosen token and the pending name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vonvon-cli-admin-')); dirs.push(home);
  await mkdir(join(home, 'work', 'pay'), { recursive: true }); await writeFile(join(home, 'work', 'file'), '');
  const host = { cwd: join(home, 'work'), home, platform: 'linux' as const };
  const token = '7d1f1a6e-3b8e-4d0c-9a51-2f6a0e4b9c11';
  const run = vi.fn(async (command: { type: string }) => command.type === 'listPendingGroups'
    ? { kind: 'pendingGroups', groups: [{ chatId: 'oc_pay', name: '支付组', addedAt: 1 }] } : { kind: 'applied', revision: 7 });
  const directory = vi.fn(async (request: { path: string }) => ({ kind: 'folderChosen', folder: { token, displayPath: request.path } }));
  const h = harness({ snapshot: one(), run, directory });
  await runGroupBind('oc_pay', { folder: 'pay', conversation: 'multi' }, h.io(), h.daemon, host);
  expect(directory).toHaveBeenCalledWith({ type: 'choose', path: join(home, 'work', 'pay') });
  expect(run).toHaveBeenLastCalledWith({ type: 'bindGroup', agentId: 'cli_a', groupId: 'oc_pay', projectName: '支付组', folder: { kind: 'existing', folderToken: token }, tool: 'codex', conversation: 'threads' });
  expect(h.out()).toBe(`已绑定 支付组（oc_pay）→ ${join(home, 'work', 'pay')} · Codex · 多会话（@ 我开新会话） · 免 @ 开\nLinux 上 Codex 只能用完全访问，运行：vonvon settings set --group oc_pay permission.mode=full\n`);
  await runGroupBind('oc_pay', { folder: '~/work/pay', name: '新名字', tool: 'claude', conversation: 'single' }, h.io(), h.daemon, host);
  expect(directory).toHaveBeenLastCalledWith({ type: 'choose', path: join(home, 'work', 'pay') });
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: '新名字', tool: 'claude', conversation: 'shared' }));
  expect(run.mock.lastCall?.[0]).not.toHaveProperty('response');
  // The wire names still work, and --response overrides the mode's default.
  await runGroupBind('oc_pay', { folder: 'pay', conversation: 'shared', response: 'all' }, h.io(), h.daemon, host);
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ conversation: 'shared', response: 'all' }));

  const offline = harness({});
  // 3.4: the command line must name the 会话方式; nothing is picked for the user.
  await expect(runGroupBind('oc_pay', { folder: 'pay' }, offline.io(), offline.daemon, host)).rejects.toThrow('--conversation 必须选一项：multi（@ 我开新会话）或 single（整群一条会话）。');
  await expect(runGroupBind('oc_pay', { folder: 'pay', conversation: 'smart' }, offline.io(), offline.daemon, host)).rejects.toThrow('--conversation 必须选一项');
  await expect(runGroupBind('oc_pay', { folder: 'pay', conversation: 'toString' }, offline.io(), offline.daemon, host)).rejects.toThrow('--conversation 必须选一项');
  await expect(runGroupBind('oc_pay', { folder: 'pay', conversation: 'multi', response: 'yes' }, offline.io(), offline.daemon, host)).rejects.toThrow('--response 只能是 mention');
  await expect(runGroupBind('oc_pay', { folder: 'missing', conversation: 'multi' }, offline.io(), offline.daemon, host)).rejects.toThrow(`文件夹不存在：${join(home, 'work', 'missing')}`);
  await expect(runGroupBind('oc_pay', { folder: 'file', conversation: 'multi' }, offline.io(), offline.daemon, host)).rejects.toThrow('不是文件夹：');
  await expect(runGroupBind('chat_pay', { folder: 'pay', conversation: 'multi' }, offline.io(), offline.daemon, host)).rejects.toThrow('群 id 应该以 oc_ 开头。');
  expect(offline.connect).not.toHaveBeenCalled();

  const hung = harness({ snapshot: one(), directory, run: (command: { type: string }) => command.type === 'bindGroup' ? new Promise(() => {}) : run(command) });
  await expect(runGroupBind('oc_pay', { folder: 'pay', conversation: 'multi' }, hung.io(), hung.daemon, host)).rejects.toThrow('绑定可能已经完成，运行 vonvon group list 查看。');
  expect(hung.close).toHaveBeenCalledTimes(1);
});

it('settings set parses values as JSON or text and names the bad field', () => {
  expect(parseAssignments('project', ['permission.mode=full', 'permission.network=false'])).toEqual({ section: 'permission', patch: { mode: 'full', network: false } });
  expect(parseAssignments('agent', ['run.maxConcurrentRuns=3']).patch).toEqual({ maxConcurrentRuns: 3 });
  expect(parseAssignments('agent', ['paths.projectsRootDir=null']).patch).toEqual({ projectsRootDir: null });
  expect(parseAssignments('session', ['model.selection={"kind":"explicit","model":"gpt-5.5","effort":"medium"}']).patch).toEqual({ selection: { kind: 'explicit', model: 'gpt-5.5', effort: 'medium' } });
  expect(parseAssignments('agent', ['paths.projectsRootDir=2024']).patch).toEqual({ projectsRootDir: '2024' });
  expect(parseAssignments('agent', ['comments.backend=true']).patch).toEqual({ backend: 'true' });
  for (const text of ['null', '[]', '{}']) expect(() => parseAssignments('agent', [`comments.backend=${text}`])).toThrow('comments.backend');
  for (const [kind, args, message] of [
    ['project', ['permission.mode=bad'], 'permission.mode 只能是 qa、write、full'],
    ['project', ['permission.nope=1'], 'permission 没有 nope 这一项。可以改的有：mode、network'],
    ['project', ['permission.guestMode=full'], '「普通成员权限」去掉了：一个群只有一个权限档，群里谁说话都用它。改 permission.mode。'],
    ['project', ['permission.mode=full', 'cards.showModel=off'], '一次只能改一节；permission 和 cards 分两次改。'],
    ['agent', ['cliBridge.agents={}'], '咖啡一下第一版已拿掉，不能改。'],
    ['project', ['compact.autoCompact=false'], '自动压缩现在一直开着，不能关了。'],
    ['agent', ['compact.autoCompact=false'], '没有 compact 这一节。可以改的有：'],
    ['session', ['permission.mode=full'], '没有 permission 这一节。可以改的有：model'],
    ['agent', ['run.maxConcurrentRuns=many'], 'run.maxConcurrentRuns 要填数字'],
    ['agent', ['run.maxConcurrentRuns=true'], 'run.maxConcurrentRuns 要填数字'],
    ['project', ['model.selection={"kind":"explicit","model":5,"effort":"medium"}'], 'model.selection.model 要填文字，JSON 里的文字要加双引号'],
    ['agent', ['cards.showModel=3'], 'cards.showModel 只能是 off、running、always'],
    ['project', ['model.selection={"kind":"x"}'], 'model.selection 的 kind 只能是 default 或 explicit'],
    ['project', ['mode=full'], '写成 节.项=值，例如 permission.mode=full'],
  ] as const) expect(() => parseAssignments(kind, args), message).toThrow(message);
});

it('settings set saves with the section revision and explains each refusal', async () => {
  const scope = { kind: 'project', botId: 'cli_a', projectName: 'pay' };
  const view = { scope, sections: { permission: section({ mode: 'qa', network: false }), model: section({ selection: { kind: 'default' } }) } };
  const results: unknown[] = [
    { kind: 'saved', section: { scope, section: 'permission', value: section({ mode: 'full' }) }, effects: [{ fields: ['mode'], when: 'next-turn', detail: '下一轮生效。' }] },
    { kind: 'conflict', current: {} }, { kind: 'rejected', fields: [{ field: 'mode', message: '后端不支持此权限档位' }] },
    { kind: 'unavailable', reason: { kind: 'readonly', reason: 'owner-offline', message: '这个 Bot 没在运行，运行起来后才能改设置' } },
  ];
  const settings = vi.fn(async (request: { type: string }): Promise<unknown> => request.type === 'read' ? { kind: 'view', view } : { kind: 'saved', result: results.shift() });
  const h = harness({ snapshot: one(undefined, [member('cli_a', 'oc_pay', 'pay')]), settings });
  await runSettingsSet(['permission.mode=full'], { group: 'oc_pay' }, h.io(), h.daemon);
  expect(settings).toHaveBeenNthCalledWith(1, { type: 'read', scope });
  expect(settings).toHaveBeenNthCalledWith(2, { type: 'save', edit: { scope, section: 'permission', revision: 'rev-mode', patch: { mode: 'full' } } });
  expect(h.out()).toBe('已保存 permission.mode = full。\n下一轮生效。\n');
  for (const message of ['这项设置刚在别处改过，没有保存。重新运行一次。', '没有保存：mode：后端不支持此权限档位', '这个 Bot 没在运行，运行起来后才能改设置']) {
    await expect(runSettingsSet(['permission.mode=full'], { group: 'pay' }, h.io(), h.daemon)).rejects.toThrow(message);
  }
  await expect(runSettingsSet(['permission.mode=full'], { group: 'pay', session: 'omt_x' }, h.io(), h.daemon)).rejects.toThrow('--group 和 --session 只能选一个。');
  expect(h.connect).toHaveBeenCalledTimes(4);
});

it('a blank --session is an input error, a bad request is never sent, and only an unreadable reply blames the version', async () => {
  const settings = vi.fn(async (request: { type: string }): Promise<unknown> => {
    if (request.type === 'read') return { kind: 'view', view: { scope: { kind: 'agent', botId: 'cli_a' }, sections: { cards: section({ showModel: 'off' }) } } };
    // What the client throws when replySchemas.settings.parse fails.
    const parsed = settingsReplySchema.safeParse({ kind: 'saved', result: { kind: 'nope' } });
    throw parsed.success ? new Error('parsed') : parsed.error;
  });
  const h = harness({ snapshot: one(), settings });
  for (const session of ['', '   ']) await expect(runSettingsGet(undefined, { session }, h.io(), h.daemon)).rejects.toThrow('--session 要填会话的话题 id（1 到 1000 个字）。');
  expect(h.connect).not.toHaveBeenCalled();
  const scope = { kind: 'session' as const, botId: agentIdSchema.parse('cli_a'), threadId: ' ' };
  await expect(h.daemon(call => call('读取设置', c => c.settings({ type: 'read', scope })))).rejects.toThrow(/^读取设置没有发出：命令行给的参数不对（scope\.threadId：.+）。$/);
  expect(settings).not.toHaveBeenCalled();
  await expect(runSettingsSet(['cards.showModel=always'], {}, h.io(), h.daemon))
    .rejects.toThrow(/^daemon 和命令行的版本不一致。先 vonvon daemon stop，再 vonvon daemon start。\n可能已经保存，运行 vonvon settings get 查看。$/);
  expect(settings).toHaveBeenCalledTimes(2);
});

it('settings get prints each section, gives the view as JSON, and lists a group\'s newest sessions', async () => {
  const agentView = { scope: { kind: 'agent', botId: 'cli_a' }, sections: {
    cards: section({ showToolCalls: true, showModel: 'running' }),
    comments: section({ backend: 'codex-appserver', selection: { kind: 'default' } }, 'r', { backend: 'codex-appserver', selection: { kind: 'explicit', model: 'gpt-5.5', effort: 'medium' } }),
  } };
  // guestMode: the view's deprecated mirror of the one tier (s15c), not printed.
  const projectView = { scope: { kind: 'project', botId: 'cli_a', projectName: 'pay' }, sections: { permission: { ...section({ mode: 'qa', guestMode: 'qa' }), access: { kind: 'readonly', reason: 'owner-offline', message: '这个 Bot 没在运行，运行起来后才能改设置' } } },
    identity: { chatId: 'oc_pay', backend: 'codex-appserver', cwd: '/home/u/pay', kind: 'multi', fullOnly: 'Linux 上只能选完全访问。' } };
  const sessions = [{ threadId: 'omt_old', chatId: 'oc_pay', summary: '旧的', backend: 'codex-appserver', createdAt: 1, updatedAt: 1 },
    { threadId: 'omt_new', chatId: 'oc_pay', summary: '修'.repeat(50), backend: 'codex-appserver', model: 'gpt-5.5', createdAt: 2, updatedAt: 2 }];
  const settings = vi.fn(async (request: { type: string; scope?: { kind: string } }): Promise<SettingsReply> => (request.type === 'sessions'
    ? { kind: 'sessions', sessions } : { kind: 'view', view: request.scope?.kind === 'project' ? projectView : agentView }) as SettingsReply);
  const h = harness({ snapshot: one(undefined, [member('cli_a', 'oc_pay', 'pay')]), settings });
  await runSettingsGet(undefined, {}, h.io(), h.daemon);
  expect(h.out()).toContain('Bot Vonvon Bot（cli_a）的设置\n[cards]\n  showToolCalls = true\n  showModel = running\n[comments]\n  backend = codex-appserver\n');
  expect(h.out()).toContain('  selection = {"kind":"default"}（生效：{"kind":"explicit","model":"gpt-5.5","effort":"medium"}）\n');
  h.clear(); await runSettingsGet(undefined, {}, h.io(true), h.daemon);
  expect(Object.keys(JSON.parse(h.out()).view.sections)).toEqual(['cards', 'comments']);
  h.clear(); await runSettingsGet(undefined, { group: 'pay' }, h.io(), h.daemon);
  const out = h.out();
  expect(out).toContain('群 pay（oc_pay）· Codex · 多会话（@ 我开新会话） · /home/u/pay\n[permission]（只读：这个 Bot 没在运行，运行起来后才能改设置）\n  mode = qa\n  Linux 上只能选完全访问。\n');
  expect(out).toContain('会话（最近 2 个，共 2 个；看单个会话：vonvon settings get --session <id>）');
  expect(out.indexOf('omt_new')).toBeLessThan(out.indexOf('omt_old'));
  expect(out).toContain(`gpt-5.5  ${'修'.repeat(40)}…\n`);
  await expect(runSettingsGet('nope', {}, h.io(), h.daemon)).rejects.toThrow('没有 nope 这一节。可以看的有：cards、run、completion、comments、titles、paths、access、judge');
});

it('judge: set takes the selection JSON, get prints a row per backend and the prompt source, get judge the whole prompt', async () => {
  expect(parseAssignments('agent', ['judge.selection={"kind":"llm","model":"gpt-6-luna","effort":"low"}']).patch).toEqual({ selection: { kind: 'llm', model: 'gpt-6-luna', effort: 'low' } });
  expect(parseAssignments('project', ['judge.selection={"kind":"default"}']).patch).toEqual({ selection: { kind: 'default' } });
  expect(parseAssignments('agent', ['judge.selection={"kind":"decision","provider":"typesafe","model":"jev-latest"}']).patch).toEqual({ selection: { kind: 'decision', provider: 'typesafe', model: 'jev-latest' } });
  expect(() => parseAssignments('agent', ['judge.selection={"kind":"oracle","model":"x"}'])).toThrow('judge.selection 的 kind 只能是 default 或 llm 或 decision');
  expect(() => parseAssignments('agent', ['judge.selection={"kind":"llm","model":"  "}'])).toThrow('judge.selection.model 不能为空');
  expect(() => parseAssignments('agent', [`judge.selection={"kind":"decision","provider":"typesafe","model":"${'m'.repeat(1001)}"}`])).toThrow('judge.selection.model 最多 1000 个字');
  expect(() => parseAssignments('agent', [`access.allowedChats=${JSON.stringify(Array.from({ length: 1001 }, (_, i) => `oc_${i}`))}`])).toThrow('access.allowedChats 最多 1000 项');
  expect(() => parseAssignments('session', ['judge.selection={"kind":"default"}'])).toThrow('没有 judge 这一节');

  const prompt = { source: 'default', path: '/d/bots/cli_a/SMART.md', text: '默认提示词全文\n第二行', formatLines: { main: '格式A', mentioned: '格式B\n只输出 JSON', topic: '格式C' }, inputExample: '【群】产品讨论\n【你】小P', backendNote: 'Codex 的说明\nClaude 的说明', maxLength: 8000 };
  const llm = { kind: 'llm', backend: 'codex-appserver', model: 'gpt-6-luna', effort: 'low' };
  const agentView = { scope: { kind: 'agent', botId: 'cli_a' }, sections: { judge: section({ selection: { kind: 'default' } }, 'rev-judge', { selection: llm }) },
    smartPrompt: prompt, judgeByBackend: { 'codex-appserver': { model: 'gpt-6-luna', effort: 'low', source: 'default' }, 'claude-agent': { model: 'sonnet', source: 'bot' } } };
  const projectView = { scope: { kind: 'project', botId: 'cli_a', projectName: 'pay' }, sections: { judge: section({ selection: { kind: 'default' } }, 'r', { selection: llm }) },
    identity: { chatId: 'oc_pay', backend: 'codex-appserver', cwd: '/home/u/pay', kind: 'multi' }, smartPrompt: { ...prompt, source: 'bot', path: '/d/bots/cli_a/groups/oc_pay/SMART.md' } };
  let stored: object = llm;
  const settings = vi.fn(async (request: { type: string; scope?: { kind: string } }): Promise<unknown> => request.type === 'sessions' ? { kind: 'sessions', sessions: [] }
    : request.type === 'save' ? { kind: 'saved', result: { kind: 'saved', section: { scope: agentView.scope, section: 'judge', value: section({ selection: stored }) }, effects: [{ fields: ['selection'], when: 'next-message', detail: '智能模式的下一次判断就用新模型' }] } }
    : { kind: 'view', view: request.scope?.kind === 'project' ? projectView : agentView });
  const h = harness({ snapshot: one(undefined, [member('cli_a', 'oc_pay', 'pay')]), settings });

  await runSettingsGet(undefined, {}, h.io(), h.daemon);
  expect(h.out()).toContain(['[judge]', '  selection = {"kind":"default"}', '  Codex 的群用：gpt-6-luna，推理强度 low（默认）', '  Claude 的群用：sonnet，关思考（Bot 设的）',
    '  智能提示词：内置默认。要改就新建 /d/bots/cli_a/SMART.md，删掉它就恢复默认', '  只在智能模式的群里用', ''].join('\n'));
  expect(h.out()).not.toContain('默认提示词全文');
  h.clear(); await runSettingsGet('judge', {}, h.io(), h.daemon);
  // multi-line texts keep their breaks: printing strips control characters line by line
  for (const text of ['—— 智能提示词 ——\n默认提示词全文\n第二行\n', '—— 程序附的格式行（只读）：主区被 @ ——\n格式B\n只输出 JSON\n', '—— 程序给模型的输入（示例，只读）——\n【群】产品讨论\n【你】小P\n—— 模型还会看到（只读）——\nCodex 的说明\nClaude 的说明']) expect(h.out()).toContain(text);
  h.clear(); await runSettingsGet(undefined, { group: 'pay' }, h.io(), h.daemon);
  expect(h.out()).toContain(`  selection = {"kind":"default"}（生效：${JSON.stringify(llm)}）\n  智能提示词：用 Bot 的 SMART.md。要只改这个群就新建 /d/bots/cli_a/groups/oc_pay/SMART.md，删掉它就回到 Bot 的\n`);

  // a decision model on the bot: every backend's row says so
  agentView.judgeByBackend = { 'codex-appserver': { model: 'jev-latest', provider: 'typesafe', source: 'bot' }, 'claude-agent': { model: 'jev-latest', provider: 'typesafe', source: 'bot' } } as never;
  h.clear(); await runSettingsGet('judge', {}, h.io(), h.daemon);
  expect(h.out()).toContain('  Codex 的群用：决策模型 typesafe 的 jev-latest（Bot 设的）\n  Claude 的群用：决策模型 typesafe 的 jev-latest（Bot 设的）\n');
  // s23f: the daemon lists its decision models: their names, a key not filled in, and under get judge how to choose one
  const typesafe = { provider: 'typesafe', displayName: 'TypeSafe', models: [{ id: 'jev-latest', displayName: 'Jev' }], keyId: 'typesafe-api-key', keySet: false };
  const missing = '  还没填 TypeSafe 的 key，填之前要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区）。在终端运行 vonvon secrets set typesafe-api-key < 存着 key 的文件\n';
  const choose = (keyState: string, group = '') => `  可选的决策模型：TypeSafe 的 jev-latest（Jev，key ${keyState}）。选它：vonvon settings set ${group}judge.selection='{"kind":"decision","provider":"typesafe","model":"jev-latest"}'\n`;
  Object.assign(agentView, { decisionModels: [typesafe] });
  h.clear(); await runSettingsGet('judge', {}, h.io(), h.daemon);
  expect(h.out()).toContain(`  Codex 的群用：决策模型 TypeSafe 的 jev-latest（Bot 设的）\n  Claude 的群用：决策模型 TypeSafe 的 jev-latest（Bot 设的）\n${missing}${choose('还没填')}`);
  h.clear(); await runSettingsGet(undefined, {}, h.io(), h.daemon);
  expect(h.out()).toContain(missing);
  expect(h.out()).not.toContain('可选的决策模型');
  Object.assign(agentView, { decisionModels: [{ ...typesafe, keySet: true }], judgeByBackend: { 'codex-appserver': { model: 'x', provider: 'oracle', source: 'bot' } } });
  h.clear(); await runSettingsGet('judge', {}, h.io(), h.daemon);
  expect(h.out()).toContain(`  Codex 的群用：决策模型 oracle 的 x，这个版本的 daemon 不认识这家决策模型（Bot 设的）\n${choose('已填')}`);
  expect(h.out()).not.toContain('还没填');
  // a group judging with it: the same line, and the command names the group
  const jev = { kind: 'decision', provider: 'typesafe', model: 'jev-latest' };
  Object.assign(projectView, { decisionModels: [typesafe], sections: { judge: section({ selection: jev }, 'r', { selection: jev }) } });
  h.clear(); await runSettingsGet('judge', { group: 'pay' }, h.io(), h.daemon);
  expect(h.out()).toContain(`${missing}${choose('还没填', '--group pay ')}`);
  // a keystore the daemon cannot read: said so, not taken for a missing key
  Object.assign(projectView, { decisionModels: [{ ...typesafe, keyUnreadable: true }] });
  h.clear(); await runSettingsGet('judge', { group: 'pay' }, h.io(), h.daemon);
  expect(h.out()).toContain(`  读不了密钥库，看不出填没填 TypeSafe 的 key，读得了之前要判断的消息按出错处理（没 @ Bot 的不回，@ 的回在主区）。在终端运行 vonvon secrets list 看报错\n${choose('填没填看不出，密钥库读不了', '--group pay ')}`);
  expect(h.out()).not.toContain('还没填');
  // a kind from a newer daemon: shown as sent, and said so
  const future = { kind: 'oracle', provider: 'x', model: 'y' };
  agentView.sections.judge = section({ selection: future }, 'rev-judge', { selection: future }) as never;
  h.clear(); await runSettingsGet(undefined, {}, h.io(), h.daemon);
  expect(h.out()).toContain(`  selection = ${JSON.stringify(future)}\n  这个版本的命令行不认识 oracle 这一类判断模型，上面是原样\n`);

  h.clear(); await runSettingsSet(['judge.selection={"kind":"llm","model":"gpt-6-luna","effort":"low"}'], {}, h.io(), h.daemon);
  expect(h.out()).toBe(`已保存 judge.selection = ${JSON.stringify(llm)}（Codex 的群用）。\n智能模式的下一次判断就用新模型\n`);
  stored = { kind: 'decision', provider: 'typesafe', model: 'jev-latest' };
  h.clear(); await runSettingsSet(['judge.selection={"kind":"decision","provider":"typesafe","model":"jev-latest"}'], {}, h.io(), h.daemon);
  expect(h.out()).toBe(`已保存 judge.selection = ${JSON.stringify(stored)}（各后端的群都用）。\n智能模式的下一次判断就用新模型\n`);
  const old = harness({ snapshot: one(), settings: vi.fn(async () => ({ kind: 'view', view: { scope: { kind: 'agent', botId: 'cli_a' }, sections: {} } })) });
  await expect(runSettingsSet(['judge.selection={"kind":"default"}'], {}, old.io(), old.daemon)).rejects.toThrow('daemon 没有 judge 这一节。daemon 可能比命令行旧。');
  // asked for by name, a section the daemon lacks is said, not left out
  await runSettingsGet('judge', {}, old.io(), old.daemon);
  expect(old.out()).toBe('Bot Vonvon Bot（cli_a）的设置\ndaemon 没有 judge 这一节。daemon 可能比命令行旧。\n');
  old.clear(); await runSettingsGet(undefined, {}, old.io(), old.daemon);
  expect(old.out()).toBe('Bot Vonvon Bot（cli_a）的设置\n');
});
