import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AdminSetupStatus, Agent, ApplicationCrashes, DesktopSnapshot, NotReplied, ToolState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {crashBars, DiagnosticsPanel, scopeView, setupView, shortTime} from '../src/management/DiagnosticsPanel';
import {diagnosticsSection, findEntries, searchEntries, settingAnchor} from '../src/search';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const agent: Agent = {id: 'cli_diag' as Agent['id'], name: '值班助手', enabled: true, running: true, connection: 'connected', activation: 'active'};
const now = Date.now();
const record = (fields: Partial<NotReplied>): NotReplied => ({at: now, count: 1, groupId: 'oc_bound_group', place: 'main', reason: 'unbound', ref: 'a1b2c3', ...fields});
const tools: ToolState[] = [
  {tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1'},
  {tool: 'claude', installation: 'installed', authentication: 'unknown', version: '0.3.296'},
];
const snapshot = (agents: Agent[], crashes?: ApplicationCrashes): DesktopSnapshot => ({
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.9.0'},
  agents, groups: [{id: 'oc_bound_group' as never, name: '发布群'}],
  memberships: [{id: 'm' as never, agentId: agent.id, groupId: 'oc_bound_group' as never, name: '发布群', directory: '/tmp/x', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false}],
  tools, jobs: [], application: {platform: 'macos', version: '0.9.0', loginItem: false, dataPath: '/tmp/vonvon-home', ...(crashes ? {crashes} : {})},
});
const render = (agents: Agent[], crashes?: ApplicationCrashes) => renderToStaticMarkup(<ClientProvider client={client}>
  <DiagnosticsPanel snapshot={snapshot(agents, crashes)} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}}/>
</ClientProvider>);

it('shows the lock holder across retries, and gives a pause priority', () => {
  const waiting = { ...agent, lockHeld: { since: now, pid: 123 } };
  expect(render([waiting])).toContain('PID 123');
  expect(render([{ ...waiting, running: false }])).toContain('等待占用的进程退出');
  expect(render([{ ...waiting, lockHeld: { since: now } }])).toContain('另一个进程占着这个 bot');
  expect(render([{ ...waiting, paused: { since: now, crashes: 3 } }])).not.toContain('等待占用的进程退出');
});

it('shows this machine, and 检查中 for Claude before its first login check', () => {
  const html = render([]);
  expect(html).toContain('这台电脑');
  expect(html).toContain('0.9.0');
  expect(html).toContain('可用 · 0.156.1');
  expect(html).toContain('检查中 · 0.3.296');
  expect(html).not.toContain('登录状态无法确认');
  expect(html).toContain('/tmp/vonvon-home');
  expect(html).toContain('daemon 日志');
});

it('lists a bot\'s not-replied messages newest first, with the group, place, sender, count and next step', () => {
  const html = render([{...agent, diagnostics: {deniedScopes: [], notReplied: [
    record({reason: 'signed-out', backend: 'claude', place: 'topic', sender: '某同事', count: 10}),
    record({groupId: 'oc_unknown_9f8e7d', reason: 'unbound'}),
  ]}}]);
  expect(html).toContain(`id="${settingAnchor(diagnosticsSection(agent.id))}"`);
  expect(html).toContain('11 条没回');
  expect(html).toContain('Claude 没登录或登录过期了');
  expect(html).toContain('10 次');
  expect(html).toContain('发布群 · 话题 · 某同事 · 消息尾号 a1b2c3');
  expect(html).toContain('用 /login 登录');
  expect(html).toContain('没绑定的群（尾号 9f8e7d） · 主区');
  expect(html.indexOf('Claude 没登录')).toBeLessThan(html.indexOf('没绑定的群'));
  expect(html).toContain('Codex 可用 · 0.156.1（1 个群）');
});

it('gives the full-only fix command, with --bot only when the host has several bots', () => {
  const refused = {...agent, diagnostics: {deniedScopes: [], notReplied: [record({reason: 'tier-unavailable', backend: 'codex'})]}};
  const one = render([refused]);
  expect(one).toContain('Linux 上的 Codex 只能用完全访问，这个群是只读或读写档，这一轮没开始');
  expect(one).toContain('在群内设置里把「权限档」改成「完全访问」，或者运行 vonvon settings set --group oc_bound_group permission.mode=full。');
  expect(one).not.toContain('guestMode');
  const two = render([refused, {...agent, id: 'cli_other' as Agent['id'], name: '另一个'}]);
  expect(two).toContain('vonvon settings set --bot cli_diag --group oc_bound_group permission.mode=full');
});

it('shows a red bar per paused bot that starts it alone again, and the paused daemon\'s bar alone (s18a)', () => {
  const paused = {...agent, running: false, connection: 'disconnected', paused: {since: now, crashes: 3}};
  const other = {...agent, id: 'cli_other' as Agent['id'], name: '另一个', paused: {since: now, crashes: 4}};
  expect(crashBars(snapshot([paused, other, {...agent, id: 'cli_ok' as Agent['id']}], {records: []})).map(bar => bar.command)).toEqual([
    {type: 'setAgentEnabled', agentId: agent.id, enabled: true}, {type: 'setAgentEnabled', agentId: 'cli_other', enabled: true},
  ]);
  const html = render([paused], {records: [
    {at: now, kind: 'forced', reason: 'SIGKILL', appId: agent.id, uptimeMs: 12_000},
    {at: now - 1000, kind: 'forced', reason: '被系统强制结束', uptimeMs: 0, paused: true},
  ]});
  expect(html).toContain('role="alert"');
  expect(html).toContain('「值班助手」10 分钟内崩溃了 3 次，已停止自动重启，别的 bot 照常。');
  expect(html).toContain('恢复运行');
  expect(html).toContain('已暂停');
  expect(html).toContain('被系统强制结束（SIGKILL），运行了 12 秒');
  expect(html).toContain('被系统强制结束（kill -9、内存不够，或者关机、注销时没来得及退出）（暂停期间）');
  const host = crashBars(snapshot([paused], {paused: {since: now, crashes: 5}, records: []}));
  expect(host).toEqual([expect.objectContaining({command: {type: 'restartHost'}, text: expect.stringContaining('daemon 已暂停：10 分钟内崩溃了 5 次')})]);
  const old = render([agent]);
  expect(old).not.toContain('role="alert"');
  expect(old).not.toContain('最近的崩溃');
  expect(render([agent], {records: []})).toContain('最近 24 小时没有崩溃');
});

it('says what the list holds when a bot has nothing', () => {
  const html = render([agent]);
  expect(html).toContain('最近没有没回的消息');
  expect(html).toContain('daemon 重启后清空');
  expect(html).not.toContain('条没回');
});

it('merges the console\'s missing scopes with the ones Feishu refused at runtime', () => {
  const status = {scopes: {missingRequired: ['im:message:readonly'], missingOptional: ['contact:user.base:readonly', 'im:chat.members:write_only'], grantUrl: 'https://open.feishu.cn/app/cli_diag/auth'}} as AdminSetupStatus;
  const denied = {...agent, diagnostics: {notReplied: [], deniedScopes: [{scope: 'im:message:readonly', where: 'history' as const, at: now}, {scope: 'im:chat:readonly', where: 'chat-info' as const, at: now}]}};
  const view = scopeView(status, denied, now);
  const html = renderToStaticMarkup(<>{view.badge}<ul>{view.lines}</ul></>);
  expect(html).toContain('缺 2 项');
  expect(html).toContain('<code>im:message:readonly</code> 必需');
  expect(html).toContain('可选：叫不出群里人的真名');
  expect(html).not.toContain('im:chat.members:write_only');
  expect(html).toContain('补拉群消息时被飞书拒绝：<code>im:message:readonly</code></li>');
  expect(html).toContain('读群信息时被飞书拒绝：<code>im:chat:readonly</code>。后台显示已开，但还没生效');
  expect(renderToStaticMarkup(<>{scopeView({scopes: {grantUrl: 'x'}} as AdminSetupStatus, agent, now).badge}</>)).toContain('暂时读不到已开通的权限');
  expect(renderToStaticMarkup(<>{scopeView(undefined, agent, now, '应用凭据不对').badge}</>)).toContain('读取失败');
  expect(renderToStaticMarkup(<>{scopeView({scopes: {missingRequired: [], missingOptional: [], grantUrl: 'x'}} as AdminSetupStatus, agent, now).badge}</>)).toContain('没有缺的');
});

it('says 全部完成 with the optional events the checklist warns about, and leaves the scope warning to 缺的权限', () => {
  const status = {appId: 'cli_diag', tenant: 'feishu', credentials: {ok: true}, eventConfigUrl: 'x', consoleUrl: 'x', cardCallback: {confirmed: true},
    event: {state: 'ok', missingOptional: ['im.message.recalled_v1']},
    scopes: {missingRequired: [], missingOptional: [], missingJoinScopes: ['im:chat:readonly'], grantUrl: 'x'}} as unknown as AdminSetupStatus;
  const view = setupView(agent, {status, checking: false});
  expect(renderToStaticMarkup(<>{view.badge}</>)).toContain('全部完成');
  expect(view.warnings).toEqual([expect.stringContaining('没订阅「撤回消息」')]);
  expect(setupView(agent, {problem: '应用凭据不对', checking: false}).warnings).toEqual([]);
});

it('writes today\'s time short and another day\'s with its date, and finds each bot from search', () => {
  const at = new Date(2026, 9, 14, 14, 2).getTime();
  expect(shortTime(at, new Date(2026, 9, 14, 20, 0).getTime())).toBe('14:02');
  expect(shortTime(at, new Date(2026, 9, 15, 9, 0).getTime())).toBe('10月14日 14:02');
  const entry = findEntries(searchEntries(snapshot([agent])), '没回的消息').find(item => item.id === `${agent.id}-diagnostics`);
  expect(entry?.destination).toEqual({page: 'diagnostics', section: diagnosticsSection(agent.id)});
});
