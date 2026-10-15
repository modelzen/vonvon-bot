import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import { RpcError, type VonvonClient } from '@vonvon/client';
import {
  agentIdSchema, groupIdSchema, membershipIdSchema, settingsReplySchema,
  type AdminSetupStatus, type Agent, type DesktopSnapshot, type Membership, type SettingsReply, type ToolState,
} from '@vonvon/protocol';
import { pickBot, withDaemon, type Daemon } from '../src/cli/daemon-client';
import { runBotList, runBotStatus } from '../src/cli/commands/bot';
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
  revision: 1, observedAt: 1, stale: false, host: { kind: 'starting' }, agents, groups: [], memberships, tools, jobs: [], diagnostics: [],
  application: { platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x' },
});
const section = (stored: object, revision = `rev-${Object.keys(stored)[0]}`, effective = stored) => ({ stored, effective, revision, access: { kind: 'writable' }, apply: [] });

/** A fake client behind the real withDaemon, with timers short enough to hit. */
function harness(client: Partial<Record<'snapshot' | 'run' | 'admin' | 'settings' | 'directory', (request: never) => Promise<unknown>>>) {
  const close = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ close, ...client }) as unknown as VonvonClient);
  const daemon: Daemon = fn => withDaemon(fn, connect, { local: 50, feishu: 50 });
  let out = '';
  return { close, connect, daemon, io: (json = false) => ({ json, write: (text: string) => { out += text; } }), out: () => out, clear: () => { out = ''; } };
}
const one = (agents = [agent('cli_a')], memberships: Membership[] = [], tools: ToolState[] = []) => async () => snapshot(agents, memberships, tools);

it('picks a bot by id or a unique name and lists the choices otherwise', () => {
  const [a, b, c] = [agent('cli_a'), agent('cli_b'), agent('cli_c', '支付')];
  expect(() => pickBot([])).toThrow('还没有 bot。');
  expect(pickBot([a])).toBe(a);
  expect(() => pickBot([a, b, c])).toThrow('有 3 个 bot，用 --bot 指定：Vonvon Bot（cli_a）、Vonvon Bot（cli_b）、支付（cli_c）');
  expect(pickBot([a, b, c], 'cli_b')).toBe(b);
  expect(pickBot([a, b, c], '支付')).toBe(c);
  expect(() => pickBot([a, b, c], 'Vonvon Bot')).toThrow('有 2 个 bot 都叫「Vonvon Bot」，用 id 指定：cli_a、cli_b');
  expect(() => pickBot([a], 'x')).toThrow('没有找到 bot「x」。现有的 bot：Vonvon Bot（cli_a）');
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

it('human output drops control characters from Feishu names and --json keeps them', async () => {
  const name = '\u001b[2J坏\u009b31m名\r\n字';
  const h = harness({ snapshot: one([agent('cli_a', name, { readError: '读\u0007不到' })]) });
  await runBotList(h.io(), h.daemon);
  expect(h.out()).toBe('[2J坏31m名字  cli_a  已启用 · 已连接 · 0 个群 · 读取失败：读不到\n');
  h.clear(); await runBotList(h.io(true), h.daemon);
  expect(JSON.parse(h.out()).bots[0].name).toBe(name);
  await expect(h.daemon(async () => pickBot([agent('cli_a', name)], 'x'))).rejects.toThrow(/^没有找到 bot「x」。现有的 bot：\[2J坏31m名字（cli_a）$/);
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
    '· 卡片回调：请手动确认', '    打开事件设置：https://open.feishu.cn/app/cli_a/event', '    在网页里点「我已配置」（vonvon open）', '✓ Codex：可用 · 0.156.1', '· 后台服务：无法确认', '还有 4 步没完成。']) expect(h.out()).toContain(`${line}\n`);
  h.clear(); await runBotStatus('cli_a', h.io(true), h.daemon);
  const json = JSON.parse(h.out());
  expect(json.steps.map((step: { id: string }) => step.id)).toEqual(['credentials', 'scopes', 'connection', 'event', 'callback', 'publish', 'codex', 'claude', 'service']);
  expect(json).toMatchObject({ bot: { id: 'cli_a' }, setup: { appId: 'cli_a' }, ready: false });
});

it('bot status still prints the connection and tool steps when the checklist read fails, then exits 1', async () => {
  const h = harness({ snapshot: one(undefined, [], [{ tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1' }]), admin: async () => { throw new RpcError('internal', '飞书接口超时'); } });
  await expect(runBotStatus(undefined, h.io(), h.daemon)).rejects.toThrow('清单没有读全，稍后重新运行 vonvon bot status。');
  expect(h.out()).toBe(['Vonvon Bot（cli_a）', '! 飞书应用：检测失败', '    读取清单状态失败：飞书接口超时', '✓ 长连接：已连接', '✓ Codex：可用 · 0.156.1',
    '· Claude：无法确认', '    在网页里点「去本机环境」（vonvon open）', '· 后台服务：无法确认', '    暂时问不到 systemd。', ''].join('\n'));
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
    '! 登录电脑时自动运行 bot（推荐）：推荐打开', '    打开后 bot 跑在 macOS 的后台服务里：退出 app、注销再登录都在线，崩溃后自动重启。',
    '    运行 vonvon service install', '    在网页里点「跳过」（vonvon open）', '全部就绪。', ''].join('\n'));
  mac.clear(); await runBotStatus(undefined, mac.io(true), mac.daemon);
  expect(JSON.parse(mac.out())).toMatchObject({ ready: true, steps: expect.arrayContaining([expect.objectContaining({ id: 'service', done: false })]) });
  const linux = harness({ snapshot: status({ platform: 'unsupported', version: '1', loginItem: false, dataPath: '/x', service: { state: 'not-installed', skipped: false } }), admin: async () => ({ kind: 'setupStatus', status: setup }) });
  await runBotStatus(undefined, linux.io(), linux.daemon);
  expect(linux.out()).toContain('· 后台服务：没装\n    在终端运行 vonvon service install，装成 systemd 用户服务，崩溃后自动重启。\n全部就绪。\n');
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
  const h = harness({ snapshot: one(), run: async () => { throw new RpcError('conflict', '机器人未启用或尚未运行'); } });
  await expect(runGroupPending({}, h.io(), h.daemon)).rejects.toThrow('查待绑定的群失败：机器人未启用或尚未运行');
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
  await runGroupBind('oc_pay', { folder: 'pay' }, h.io(), h.daemon, host);
  expect(directory).toHaveBeenCalledWith({ type: 'choose', path: join(home, 'work', 'pay') });
  expect(run).toHaveBeenLastCalledWith({ type: 'bindGroup', agentId: 'cli_a', groupId: 'oc_pay', projectName: '支付组', folderToken: token, tool: 'codex', conversation: 'threads' });
  expect(h.out()).toBe(`已绑定 支付组（oc_pay）→ ${join(home, 'work', 'pay')} · Codex · 按话题独立会话\nLinux 上 Codex 只能用完全访问，运行：vonvon settings set --group oc_pay permission.mode=full\n`);
  await runGroupBind('oc_pay', { folder: '~/work/pay', name: '新名字', tool: 'claude' }, h.io(), h.daemon, host);
  expect(directory).toHaveBeenLastCalledWith({ type: 'choose', path: join(home, 'work', 'pay') });
  expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ projectName: '新名字', tool: 'claude' }));

  const offline = harness({});
  await expect(runGroupBind('oc_pay', { folder: 'missing' }, offline.io(), offline.daemon, host)).rejects.toThrow(`文件夹不存在：${join(home, 'work', 'missing')}`);
  await expect(runGroupBind('oc_pay', { folder: 'file' }, offline.io(), offline.daemon, host)).rejects.toThrow('不是文件夹：');
  await expect(runGroupBind('chat_pay', { folder: 'pay' }, offline.io(), offline.daemon, host)).rejects.toThrow('群 id 应该以 oc_ 开头。');
  expect(offline.connect).not.toHaveBeenCalled();

  const hung = harness({ snapshot: one(), directory, run: (command: { type: string }) => command.type === 'bindGroup' ? new Promise(() => {}) : run(command) });
  await expect(runGroupBind('oc_pay', { folder: 'pay' }, hung.io(), hung.daemon, host)).rejects.toThrow('绑定可能已经完成，运行 vonvon group list 查看。');
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
    ['project', ['permission.nope=1'], 'permission 没有 nope 这一项。可以改的有：mode、guestMode、network'],
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
  const view = { scope, sections: { permission: section({ mode: 'qa', guestMode: 'qa', network: false }), model: section({ selection: { kind: 'default' } }) } };
  const results: unknown[] = [
    { kind: 'saved', section: { scope, section: 'permission', value: section({ mode: 'full' }) }, effects: [{ fields: ['mode'], when: 'next-turn', detail: '下一轮生效。' }] },
    { kind: 'conflict', current: {} }, { kind: 'rejected', fields: [{ field: 'mode', message: '后端不支持此权限档位' }] },
    { kind: 'unavailable', reason: { kind: 'readonly', reason: 'owner-offline', message: '请先启动此 Agent，再编辑设置' } },
  ];
  const settings = vi.fn(async (request: { type: string }): Promise<unknown> => request.type === 'read' ? { kind: 'view', view } : { kind: 'saved', result: results.shift() });
  const h = harness({ snapshot: one(undefined, [member('cli_a', 'oc_pay', 'pay')]), settings });
  await runSettingsSet(['permission.mode=full'], { group: 'oc_pay' }, h.io(), h.daemon);
  expect(settings).toHaveBeenNthCalledWith(1, { type: 'read', scope });
  expect(settings).toHaveBeenNthCalledWith(2, { type: 'save', edit: { scope, section: 'permission', revision: 'rev-mode', patch: { mode: 'full' } } });
  expect(h.out()).toBe('已保存 permission.mode = full。\n下一轮生效。\n');
  for (const message of ['这项设置刚在别处改过，没有保存。重新运行一次。', '没有保存：mode：后端不支持此权限档位', '请先启动此 Agent，再编辑设置']) {
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

it('settings get hides cliBridge for people, keeps it in JSON, and lists a group\'s newest sessions', async () => {
  const agentView = { scope: { kind: 'agent', botId: 'cli_a' }, sections: {
    cards: section({ showToolCalls: true, showModel: 'running' }), cliBridge: section({ agents: { claude: false, codex: false } }),
    comments: section({ backend: 'codex-appserver', selection: { kind: 'default' } }, 'r', { backend: 'codex-appserver', selection: { kind: 'explicit', model: 'gpt-5.5', effort: 'medium' } }),
  } };
  const projectView = { scope: { kind: 'project', botId: 'cli_a', projectName: 'pay' }, sections: { permission: { ...section({ mode: 'qa' }), access: { kind: 'readonly', reason: 'owner-offline', message: '请先启动此 Agent，再编辑设置' } } } };
  const sessions = [{ threadId: 'omt_old', chatId: 'oc_pay', summary: '旧的', backend: 'codex-appserver', createdAt: 1, updatedAt: 1 },
    { threadId: 'omt_new', chatId: 'oc_pay', summary: '修'.repeat(50), backend: 'codex-appserver', model: 'gpt-5.5', createdAt: 2, updatedAt: 2 }];
  const settings = vi.fn(async (request: { type: string; scope?: { kind: string } }): Promise<SettingsReply> => (request.type === 'sessions'
    ? { kind: 'sessions', sessions } : { kind: 'view', view: request.scope?.kind === 'project' ? projectView : agentView }) as SettingsReply);
  const h = harness({ snapshot: one(undefined, [member('cli_a', 'oc_pay', 'pay')]), settings });
  await runSettingsGet(undefined, {}, h.io(), h.daemon);
  expect(h.out()).toContain('bot Vonvon Bot（cli_a）的设置\n[cards]\n  showToolCalls = true\n  showModel = running\n[comments]\n  backend = codex-appserver\n');
  expect(h.out()).toContain('  selection = {"kind":"default"}（生效：{"kind":"explicit","model":"gpt-5.5","effort":"medium"}）\n');
  expect(h.out()).not.toContain('cliBridge');
  h.clear(); await runSettingsGet(undefined, {}, h.io(true), h.daemon);
  expect(JSON.parse(h.out()).view.sections.cliBridge).toBeDefined();
  h.clear(); await runSettingsGet(undefined, { group: 'pay' }, h.io(), h.daemon);
  const out = h.out();
  expect(out).toContain('群 pay（oc_pay）· Codex · 按话题独立会话 · /home/u/pay\n[permission]（只读：请先启动此 Agent，再编辑设置）\n  mode = qa\n');
  expect(out).toContain('会话（最近 2 个，共 2 个；看单个会话：vonvon settings get --session <id>）');
  expect(out.indexOf('omt_new')).toBeLessThan(out.indexOf('omt_old'));
  expect(out).toContain(`gpt-5.5  ${'修'.repeat(40)}…\n`);
  await expect(runSettingsGet('nope', {}, h.io(), h.daemon)).rejects.toThrow('没有 nope 这一节。可以看的有：cards、run、completion、comments、titles、paths、access');
});
