import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AdminSetupStatus, Agent, ApplicationService, DesktopSnapshot, ServiceActionReport, ToolState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {SetupChecklist} from '../src/setup/SetupChecklist';
import {WelcomeSetup} from '../src/setup/WelcomeSetup';
import {BOT_ADDED_WARNING, JOIN_SCOPE_WARNING, LINGER_OFF_WARNING, RECALL_WARNING, botSteps, linuxSteps, recentServiceFailure, remoteStepsDone, scopeStep, serviceStep, toolSteps} from '@vonvon/protocol';

const agent: Agent = {id: 'cli_setup' as Agent['id'], name: '小助手', enabled: true, running: true, connection: 'connected', activation: 'active'};
const done: AdminSetupStatus = {
  appId: 'cli_setup', tenant: 'feishu', credentials: {ok: true}, connection: {running: true},
  event: {state: 'ok', version: '1.0.2'}, scopes: {missingRequired: [], grantUrl: 'https://open.feishu.cn/app/cli_setup/auth?q=im%3Aresource'},
  eventConfigUrl: 'https://open.feishu.cn/app/cli_setup/event', consoleUrl: 'https://open.feishu.cn/app/cli_setup', cardCallback: {confirmed: true},
};
const byId = (steps: ReturnType<typeof botSteps>) => Object.fromEntries(steps.map(step => [step.id, step]));

it('shows every Feishu step green once the bot is fully set up', () => {
  const steps = botSteps(agent, done);
  expect(steps.map(step => step.id)).toEqual(['credentials', 'scopes', 'connection', 'event', 'callback', 'publish']);
  expect(steps.every(step => step.done)).toBe(true);
  expect(byId(steps).publish?.status).toBe('已发布 1.0.2');
  expect(remoteStepsDone(done)).toBe(true);
});

it('gives the reason and the button for each unfinished step', () => {
  const fresh: AdminSetupStatus = {...done, event: {state: 'unpublished'}, scopes: {...done.scopes, missingRequired: ['im:resource', 'im:message:readonly']}, cardCallback: {confirmed: false}};
  const steps = byId(botSteps({...agent, enabled: false, connection: 'disconnected'}, fresh));
  expect(steps.scopes).toMatchObject({done: false, status: '还缺 2 项', items: ['im:resource', 'im:message:readonly']});
  expect(steps.scopes?.actions).toEqual([{kind: 'open', label: '一键开权限', url: fresh.scopes.grantUrl, target: 'app-console'}]);
  expect(steps.connection?.actions).toEqual([{kind: 'enable', label: '启用 Bot'}]);
  expect(steps.event).toMatchObject({done: false, status: '上线后才能确认'});
  expect(steps.publish?.detail).toContain('等管理员审核通过');
  expect(steps.callback?.actions.map(action => action.label)).toEqual(['打开事件设置', '我已配置']);
  expect(steps.publish?.actions).toEqual([{kind: 'open', label: '打开开发者后台', url: fresh.consoleUrl, target: 'app-console'}]);
  expect(remoteStepsDone(fresh)).toBe(false);
});

it('treats a published version without the message event as published but missing the event', () => {
  const steps = byId(botSteps(agent, {...done, event: {state: 'missing', version: '1.0.0', missingRequired: ['im.message.receive_v1']}}));
  expect(steps.publish?.done).toBe(true);
  expect(steps.event).toMatchObject({done: false, status: '缺少接收消息事件'});
});

it('does not count unknown scopes or an unchecked event as done', () => {
  const unknown: AdminSetupStatus = {...done, scopes: {grantUrl: done.scopes.grantUrl}, event: {state: 'unchecked', reason: '网络错误：timeout'}};
  const steps = byId(botSteps(agent, unknown));
  expect(steps.scopes).toMatchObject({done: false, status: '无法确认'});
  expect(steps.event).toMatchObject({done: false, detail: '网络错误：timeout'});
  expect(steps.publish).toMatchObject({done: false, status: '无法确认'});
  expect(remoteStepsDone(unknown)).toBe(false);
  const broken = byId(botSteps(agent, {...done, credentials: {ok: false, reason: 'code=10014'}, event: {state: 'unchecked', reason: 'token code=10014'}}));
  expect(broken.credentials).toMatchObject({done: false, detail: 'code=10014', actions: [{kind: 'reauthorize', label: '重新扫码'}]});
  expect([broken.scopes?.status, broken.event?.status, broken.publish?.status]).toEqual(['等第 1 步', '等第 1 步', '等第 1 步']);
  expect(broken.callback?.done).toBe(true);
  const offline = byId(botSteps(agent, {...done, credentials: {ok: false, reason: '飞书接口 10 秒没有响应', unreachable: true}, scopes: {grantUrl: done.scopes.grantUrl}, event: {state: 'unchecked', reason: '飞书接口 10 秒没有响应'}}));
  expect(offline.credentials).toMatchObject({status: '无法确认', tone: 'neutral', actions: []});
  expect(offline.credentials?.detail).toContain('网络恢复后会自动重试');
  expect([offline.scopes?.status, offline.event?.status, offline.event?.detail]).toEqual(['无法确认', '无法确认', '飞书接口 10 秒没有响应']);
});

it('keeps the long-connection step live from the snapshot before the first read', () => {
  const steps = botSteps({...agent, connection: 'connecting'}, undefined, '没有这个 Bot。');
  expect(steps.map(step => [step.id, step.status])).toEqual([['credentials', '检测失败'], ['connection', '连接中']]);
});

const tool = (value: Partial<ToolState> & Pick<ToolState, 'tool'>): ToolState => ({installation: 'installed', authentication: 'signedIn', version: '0.162.1', ...value});

it('needs Codex or Claude installed, signed in and new enough', () => {
  expect(toolSteps([tool({tool: 'codex'}), tool({tool: 'claude', installation: 'missing', authentication: 'unknown', version: null})]).ready).toBe(true);
  const old = toolSteps([tool({tool: 'codex', compatibility: {status: 'tooOld', minimum: '0.156.1', verified: '0.156.1'}}), tool({tool: 'claude', authentication: 'signedOut'})]);
  expect(old.ready).toBe(false);
  expect(old.steps[0]).toMatchObject({status: '版本太旧 · 0.162.1', detail: '最低要 0.156.1，请在本机环境更新。'});
  expect(old.steps[1]?.actions).toEqual([{kind: 'claudeLogin', label: '检查登录'}]);
  const missing = toolSteps([tool({tool: 'codex', installation: 'missing', authentication: 'unknown', version: null})]);
  expect(missing.steps[0]?.detail).toContain('Homebrew');
  expect(toolSteps([tool({tool: 'codex', authentication: 'signedOut'})]).steps[0]?.actions).toEqual([{kind: 'codexLogin', label: '登录 Codex'}]);
  expect(toolSteps([tool({tool: 'claude', authentication: 'signedIn', message: '已登录，凭据来自 ANTHROPIC_AUTH_TOKEN。'})]).ready).toBe(true);
});

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const snapshot = (agents: Agent[]): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents, groups: [], memberships: [], tools: [tool({tool: 'codex', installation: 'missing', authentication: 'unknown', version: null})], jobs: [],
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/tmp/test'},
});
const render = (agents: Agent[], application: Partial<DesktopSnapshot['application']> = {}) => renderToStaticMarkup(<ClientProvider client={client}>
  <SetupChecklist snapshot={{...snapshot(agents), application: {...snapshot(agents).application, ...application}}} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
</ClientProvider>);

it('starts a new machine with the tools and the scan step', () => {
  const html = render([]);
  expect(html).toContain('后端');
  expect(html).toContain('还没有能用的后端');
  expect(html).toContain('第一步');
  expect(html).toContain('扫码建飞书应用');
  expect(html).toContain('注册 Bot');
  expect(html).not.toContain('添加 Bot');
});

it('starts the welcome with Provider preparation before Bot scanning', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <WelcomeSetup snapshot={snapshot([])} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
  </ClientProvider>);
  expect(html).toContain('先准备一个 Provider');
  expect(html).toContain('准备 Provider');
  expect(html).toContain('创建 Bot');
  expect(html).toContain('连接群');
  expect(html).not.toContain('扫码创建 Bot');
  expect(html).toContain('Codex');
  expect(html).toContain('未安装');
  expect(html).not.toContain('工具与后台运行');
  expect(html).not.toContain('首次运行清单');
});

it('preserves existing Bot Feishu checks while its Provider still needs attention', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <WelcomeSetup snapshot={snapshot([agent])} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenGroups={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
  </ClientProvider>);
  expect(html).toContain('小助手');
  expect(html).toContain('正在检测…');
  expect(html).toContain('先准备一个 Provider');
  expect(html).toContain('企业租户里新权限可能要管理员审核');
  expect(html).not.toContain('扫码创建 Bot');
});

it('says 检查中 for Claude until its login is asked, never 无法确认 before the first ask (s19)', () => {
  const claude = tool({tool: 'claude', authentication: 'unknown', version: '0.3.296'});
  expect(toolSteps([claude], {claudeChecking: true}).steps[1]).toMatchObject({status: '检查中 · 0.3.296', tone: 'neutral', done: false});
  // The CLI's `vonvon bot status` asks nothing, so it keeps saying it cannot tell.
  expect(toolSteps([claude]).steps[1]?.status).toBe('登录状态无法确认 · 0.3.296');
  expect(toolSteps([{...claude, authentication: 'signedOut'}], {claudeChecking: true}).steps[1]?.status).toBe('未登录 · 0.3.296');
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <SetupChecklist snapshot={{...snapshot([]), tools: [claude]}} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
  </ClientProvider>);
  expect(html).toContain('检查中 · 0.3.296');
  expect(html).not.toContain('登录状态无法确认');
});

it('lists each bot with the admin-review note while its first read is pending', () => {
  const html = render([agent]);
  expect(html).toContain('小助手');
  expect(html).toContain('正在检测…');
  expect(html).toContain('企业租户里新权限可能要管理员审核');
  expect(html).toContain('再注册一个 Bot');
});

it('warns about the join-group scope without turning the 权限 step red', () => {
  const granted = scopeStep({...done, scopes: {...done.scopes, missingJoinScopes: ['im:chat:readonly', 'im:chat.members:write_only']}});
  expect(granted).toMatchObject({done: true, tone: 'success', status: '已开通', warnings: [JOIN_SCOPE_WARNING]});
  expect(granted.actions).toEqual([{kind: 'open', label: '一键开权限', url: done.scopes.grantUrl, target: 'app-console'}]);
  expect(JOIN_SCOPE_WARNING).toContain('查找已经加入的群');
  const missing = scopeStep({...done, scopes: {...done.scopes, missingRequired: ['im:resource'], missingJoinScopes: ['im:chat:readonly']}});
  expect(missing).toMatchObject({done: false, tone: 'warning', status: '还缺 1 项', items: ['im:resource'], warnings: [JOIN_SCOPE_WARNING]});
  // Only the leave-group scope missing, all granted, or unreadable grants: no warning.
  expect(scopeStep({...done, scopes: {...done.scopes, missingJoinScopes: ['im:chat.members:write_only']}}).warnings).toBeUndefined();
  expect(scopeStep({...done, scopes: {...done.scopes, missingJoinScopes: []}})).toMatchObject({done: true, actions: [], warnings: undefined});
  expect(scopeStep({...done, scopes: {grantUrl: done.scopes.grantUrl}})).toMatchObject({status: '无法确认', warnings: undefined});
  expect(byId(botSteps(agent, {...done, scopes: {...done.scopes, missingJoinScopes: ['im:chat:readonly']}})).scopes).toMatchObject({done: true, warnings: [JOIN_SCOPE_WARNING]});
});

it('names the bot-added event in the events step as a warning only', () => {
  const ok = byId(botSteps(agent, {...done, event: {state: 'ok', version: '1.0.2', missingOptional: ['im.chat.member.bot.added_v1', 'application.bot.menu_v6']}}));
  expect(ok.event).toMatchObject({done: true, tone: 'success', items: ['im.chat.member.bot.added_v1', 'application.bot.menu_v6'], warnings: [BOT_ADDED_WARNING]});
  expect(BOT_ADDED_WARNING).toContain('机器人进群');
  const missing = byId(botSteps(agent, {...done, event: {state: 'missing', version: '1.0.0', missingRequired: ['im.message.receive_v1'], missingOptional: ['im.chat.member.bot.added_v1']}}));
  expect(missing.event).toMatchObject({done: false, status: '缺少接收消息事件', warnings: [BOT_ADDED_WARNING]});
  expect(byId(botSteps(agent, {...done, event: {state: 'ok', version: '1.0.2', missingOptional: ['application.bot.menu_v6']}})).event?.warnings).toBeUndefined();
  // s15: an unsubscribed recall event says what the bot then misses, next to bot-added.
  expect(byId(botSteps(agent, {...done, event: {state: 'ok', version: '1.0.2', missingOptional: ['im.chat.member.bot.added_v1', 'im.message.recalled_v1']}})).event?.warnings).toEqual([BOT_ADDED_WARNING, RECALL_WARNING]);
  expect(RECALL_WARNING).toContain('撤回');
  expect(byId(botSteps(agent, {...done, event: {state: 'unpublished'}})).event?.warnings).toBeUndefined();
  expect(remoteStepsDone({...done, scopes: {...done.scopes, missingJoinScopes: ['im:chat:readonly']}, event: {state: 'ok', missingOptional: ['im.chat.member.bot.added_v1']}})).toBe(true);
});

it('drops the warnings while the credentials are rejected', () => {
  const steps = byId(botSteps(agent, {...done, credentials: {ok: false, reason: 'code=10014'}, scopes: {...done.scopes, missingJoinScopes: ['im:chat:readonly']}, event: {state: 'ok', missingOptional: ['im.chat.member.bot.added_v1']}}));
  expect([steps.scopes?.warnings, steps.event?.warnings]).toEqual([undefined, undefined]);
});

const service = (fields: Partial<ApplicationService> = {}): ApplicationService => ({state: 'not-installed', skipped: false, ...fields});
const mac = (fields?: Partial<ApplicationService>, now?: number) => serviceStep({platform: 'macos', service: fields && service(fields)}, now);
const linux = (fields?: Partial<ApplicationService>) => serviceStep({platform: 'linux', service: fields && service(fields)});
const labels = (step: ReturnType<typeof serviceStep>) => step.actions.map(action => action.label);

it.each([
  [{action: {action: 'install', phase: 'running', startedAt: 1}}, '正在打开…', 'neutral', false, '页面会断开几秒再连上。', []],
  [{state: 'running', action: {action: 'uninstall', phase: 'running', startedAt: 1}}, '正在关闭…', 'neutral', false, '页面会断开几秒再连上。', []],
  [{blocked: 'development'}, '开发版不能装', 'neutral', false, '从源码运行的 daemon 不能装后台服务。用打包的 Vonvon Bot，或用 npm 装的 vonvon。', []],
  [{blocked: 'translocated'}, '先移到"应用程序"', 'warning', false, 'Vonvon Bot 正从临时位置运行，装成后台服务后下次会找不到它。把它拖到"应用程序"文件夹，从那里打开，再回到这一步。', ['重新检测']],
  [{state: 'running'}, '已开启', 'success', true, 'Bot 跑在后台服务里：退出 app、注销再登录都在线，崩溃后自动重启。', []],
  [{state: 'detached'}, '已开启 · 这次没交给后台服务', 'warning', true, '现在的 daemon 是单独启动的，崩溃后不会自动重启；下次登录电脑时会由后台服务启动。', ['交给后台服务']],
  [{state: 'stopped'}, '已开启 · 这次没交给后台服务', 'warning', true, '现在的 daemon 是单独启动的，崩溃后不会自动重启；下次登录电脑时会由后台服务启动。', ['交给后台服务']],
  [{state: 'disabled'}, '已在系统设置里关掉', 'warning', false, '在"系统设置 › 通用 › 登录项与扩展"的"允许在后台"里打开 Vonvon Bot，再点「重新检测」。', ['重新检测']],
  [{skipped: true}, '已跳过', 'neutral', true, 'Bot 跑在单独启动的 daemon 里，退出 app 不停，但这样崩溃后不会自动重启；注销或重启电脑后要重新打开 app。', ['改为自动运行']],
  [{}, '推荐打开', 'warning', false, '打开后 Bot 跑在 macOS 的后台服务里：退出 app、注销再登录都在线，崩溃后自动重启。', ['打开', '跳过']],
  [{state: 'conflict', detail: 'The service belongs to another data directory, /x.'}, '要处理', 'danger', false, 'The service belongs to another data directory, /x.', ['重新检测']],
  [{state: 'unknown', detail: 'launchctl timed out'}, '无法确认', 'neutral', false, '暂时问不到 launchd：launchctl timed out', ['重新检测']],
  [undefined, '无法确认', 'neutral', false, '暂时问不到 launchd。', ['重新检测']],
] as const)('macOS service step for %j', (fields, status, tone, done, detail, actions) => {
  const step = mac(fields as Partial<ApplicationService> | undefined);
  expect(step).toMatchObject({id: 'service', title: '登录电脑时自动运行 Bot（推荐）', status, tone, done, detail, warnings: undefined});
  expect(labels(step)).toEqual(actions);
});

it('wires the macOS service buttons to install, skip and recheck', () => {
  expect(mac({}).actions).toEqual([{kind: 'serviceInstall', label: '打开', primary: true}, {kind: 'serviceSkip', label: '跳过'}]);
  expect(mac({state: 'detached'}).actions).toEqual([{kind: 'serviceInstall', label: '交给后台服务'}]);
  expect(mac({skipped: true}).actions).toEqual([{kind: 'serviceInstall', label: '改为自动运行'}]);
  expect(mac({state: 'disabled'}).actions).toEqual([{kind: 'serviceRecheck', label: '重新检测'}]);
  // A blocked install wins over the state, a running action over everything.
  expect(mac({state: 'running', blocked: 'development'}).status).toBe('开发版不能装');
  expect(mac({blocked: 'translocated', action: {action: 'install', phase: 'running', startedAt: 1}}).status).toBe('正在打开…');
});

it.each([
  [{state: 'running'}, '在运行', 'success', true, 'Bot 跑在 systemd 用户服务里，崩溃后自动重启。'],
  [{}, '没装', 'neutral', false, '在终端运行 vonvon service install，装成 systemd 用户服务，崩溃后自动重启。'],
  [{state: 'disabled'}, '没启用', 'neutral', false, '在终端运行 vonvon service install。'],
  [{state: 'detached'}, '已装 · 这次没交给后台服务', 'warning', true, '在终端运行 vonvon daemon stop，再运行 vonvon daemon start。'],
  [{state: 'conflict', detail: 'An uninstall did not finish. Run vonvon service uninstall.'}, '要处理', 'danger', false, 'An uninstall did not finish. Run vonvon service uninstall.'],
  [{state: 'unknown', detail: 'User manager unavailable'}, '无法确认', 'neutral', false, '暂时问不到 systemd：User manager unavailable'],
  [{state: 'unknown', detail: 'Failed to connect to bus', hint: '当前终端没有 XDG_RUNTIME_DIR。'}, '无法确认', 'neutral', false, '当前终端没有 XDG_RUNTIME_DIR。'],
  [{state: 'running', linger: 'on'}, '在运行', 'success', true, 'Bot 跑在 systemd 用户服务里，崩溃后自动重启；开机就启动，退出 SSH 也在线。'],
] as const)('Linux service step for %j has no buttons', (fields, status, tone, done, detail) => {
  const step = linux(fields as Partial<ApplicationService>);
  expect(step).toMatchObject({id: 'service', title: '后台服务', status, tone, done, detail, actions: []});
});

it('keeps a running Linux service done without linger, with a warning, and says when a platform has no service', () => {
  expect(linux({state: 'running', linger: 'off'})).toMatchObject({status: '在运行', tone: 'success', done: true, warnings: [LINGER_OFF_WARNING]});
  expect(linux({state: 'running', linger: 'unknown'}).warnings).toBeUndefined();
  expect(serviceStep({platform: 'unsupported', service: service()})).toMatchObject({status: '不支持', done: false, detail: '这台电脑不支持后台服务。', actions: []});
});

const sandboxed = (sandbox?: NonNullable<ToolState['sandbox']>) => linuxSteps([tool({tool: 'codex'}), tool({tool: 'claude', ...(sandbox ? {sandbox} : {})})]);
it('adds the Codex note and the Claude sandbox on Linux, only for tools that are installed', () => {
  expect(linuxSteps([tool({tool: 'codex', installation: 'missing'}), tool({tool: 'claude', installation: 'missing'})])).toEqual([]);
  const [codex, claude] = sandboxed({bwrap: '/usr/bin/bwrap', socat: true, userns: 'ok'});
  expect(codex).toMatchObject({id: 'codex-linux', title: 'Codex 的权限', status: '只能用完全访问', tone: 'neutral', done: true, actions: []});
  expect(codex?.detail).toContain('vonvon settings set --group <群 id> permission.mode=full');
  expect(claude).toMatchObject({id: 'claude-sandbox', status: '可以用', tone: 'success', done: true, commands: undefined});
  expect(linuxSteps([tool({tool: 'codex', installation: 'unknown'})]).map(step => step.id)).toEqual(['codex-linux']);
  expect(sandboxed()[1]).toMatchObject({status: '无法确认', tone: 'neutral'});
  expect(sandboxed({bwrap: null, socat: false, userns: 'unchecked'})[1]).toMatchObject({status: '缺 bwrap、socat', tone: 'warning', commands: ['sudo apt install bubblewrap socat']});
  expect(sandboxed({bwrap: '/usr/bin/bwrap', socat: false, userns: 'ok'})[1]).toMatchObject({status: '缺 socat', commands: ['sudo apt install socat']});
  const apparmor = sandboxed({bwrap: '/home/u/bin/bwrap', socat: true, userns: 'apparmor'})[1];
  expect(apparmor).toMatchObject({status: '被 AppArmor 挡住', tone: 'warning', done: false});
  expect(apparmor?.commands).toContain('profile bwrap /home/u/bin/bwrap flags=(unconfined) {');
  expect(apparmor?.commands?.at(-1)).toBe('sudo apparmor_parser -r /etc/apparmor.d/bwrap');
  expect(sandboxed({bwrap: '/usr/bin/bwrap', socat: true, userns: 'disabled', detail: 'kernel.unprivileged_userns_clone'})[1]).toMatchObject({status: '用户命名空间被关掉了', commands: ['sudo sysctl -w kernel.unprivileged_userns_clone=1']});
  expect(sandboxed({bwrap: '/usr/bin/bwrap', socat: true, userns: 'disabled', detail: 'user.max_user_namespaces'})[1]?.commands).toEqual(['sudo sysctl -w user.max_user_namespaces=15000']);
  const failed = sandboxed({bwrap: '/usr/bin/bwrap', socat: true, userns: 'failed', detail: 'bwrap: setting up uid map: Permission denied'})[1];
  expect(failed).toMatchObject({status: '沙箱起不来', commands: ['/usr/bin/bwrap --ro-bind / / --dev /dev --unshare-all --die-with-parent true']});
  expect(failed?.detail).toContain('bwrap 试跑失败：bwrap: setting up uid map: Permission denied。');
});

it('ignores the macOS-only parts of the snapshot on Linux', () => {
  const failed: ServiceActionReport = {action: 'install', phase: 'done', ok: false, reason: 'busy', startedAt: 1, finishedAt: 2};
  const step = linux({blocked: 'development', action: failed});
  expect([step.status, step.warnings]).toEqual(['没装', undefined]);
  expect(linux({skipped: true, action: {action: 'install', phase: 'running', startedAt: 1}}).status).toBe('没装');
});

it('warns about a failed service action for 10 minutes', () => {
  const finishedAt = 1_000_000;
  const failed: ServiceActionReport = {action: 'install', phase: 'done', ok: false, kind: 'install_refused', reason: 'turned-off', startedAt: finishedAt - 5_000, finishedAt};
  const text = '系统设置里关掉了 Vonvon Bot 的后台运行。到"系统设置 › 通用 › 登录项与扩展"的"允许在后台"里打开它，再点「重新检测」。';
  expect(mac({state: 'disabled', action: failed}, finishedAt + 60_000)).toMatchObject({status: '已在系统设置里关掉', warnings: [text]});
  expect(mac({state: 'disabled', action: failed}, finishedAt + 10 * 60_000).warnings).toBeUndefined();
  expect(recentServiceFailure(service({action: {...failed, ok: true, kind: 'installed', reason: undefined}}), finishedAt)).toBeUndefined();
  expect(recentServiceFailure(service({action: {action: 'uninstall', phase: 'running', startedAt: finishedAt}}), finishedAt)).toBeUndefined();
});

it('puts the service step in its own group after the tools', () => {
  const html = render([], {service: service()});
  expect(html.indexOf('后台运行')).toBeGreaterThan(html.indexOf('后端'));
  expect(html).toContain('装成 macOS 的后台服务（LaunchAgent）。');
  expect(html).toContain('1. 登录电脑时自动运行 Bot（推荐）');
  expect(html).toMatch(/ui-button--primary[^>]*><span>打开<\/span>/);
  const other = render([], {platform: 'unsupported', service: service()});
  expect(other).toContain('1. 后台服务');
  expect(other).not.toContain('LaunchAgent');
  expect(other).not.toContain('<span>打开</span>');
  expect(other).not.toContain('Linux 上的权限');
  expect(html).not.toContain('Linux 上的权限');
});

it('shows the Linux group between the tools and the service, with commands in a block', () => {
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <SetupChecklist snapshot={{...snapshot([]), tools: [tool({tool: 'claude', sandbox: {bwrap: null, socat: true, userns: 'unchecked'}})], application: {...snapshot([]).application, platform: 'linux', service: service()}}}
      ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
  </ClientProvider>);
  expect(html.indexOf('后端')).toBeLessThan(html.indexOf('Linux 上的权限'));
  expect(html.indexOf('Linux 上的权限')).toBeLessThan(html.indexOf('后台运行'));
  expect(html).not.toContain('Linux 上的权限档');
  expect(html).toContain('1. Claude 的权限');
  expect(html).toContain('<pre class="setup-step-commands">sudo apt install bubblewrap</pre>');
  expect(html).toContain('systemd 用户服务。退出 SSH 后也要在线，安装时打开 linger。');
  expect(html).not.toContain('Codex 的权限档');
});

it('shows connection settings without first-use progress after a group is bound', () => {
  const current = snapshot([agent]);
  // Losing Provider readiness after binding must not restart first-use onboarding.
  current.tools = [tool({tool: 'codex', authentication: 'signedOut'})];
  current.memberships = [{id: 'bound', agentId: agent.id, groupId: 'oc_bound'}] as DesktopSnapshot['memberships'];
  const html = renderToStaticMarkup(<ClientProvider client={client}>
    <WelcomeSetup snapshot={current} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenGroups={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
  </ClientProvider>);
  expect(html).toContain('飞书连接');
  expect(html).not.toContain('连接到群聊');
  expect(html).not.toContain('aria-label="开始使用"');
});
