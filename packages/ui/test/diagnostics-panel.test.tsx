import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AdminSetupStatus, Agent, DesktopSnapshot, NotReplied, ToolState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {DiagnosticsPanel, scopeView, shortTime} from '../src/management/DiagnosticsPanel';
import {diagnosticsSection, findEntries, searchEntries, settingAnchor} from '../src/search';

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const agent: Agent = {id: 'cli_diag' as Agent['id'], name: '值班助手', enabled: true, running: true, connection: 'connected', activation: 'active'};
const now = Date.now();
const record = (fields: Partial<NotReplied>): NotReplied => ({at: now, count: 1, groupId: 'oc_bound_group', place: 'main', reason: 'unbound', ref: 'a1b2c3', ...fields});
const tools: ToolState[] = [
  {tool: 'codex', installation: 'installed', authentication: 'signedIn', version: '0.156.1'},
  {tool: 'claude', installation: 'installed', authentication: 'unknown', version: '0.3.296'},
];
const snapshot = (agents: Agent[]): DesktopSnapshot => ({
  revision: 1, observedAt: now, stale: false, host: {kind: 'connected', ownership: 'owned', version: '0.9.0'},
  agents, groups: [{id: 'oc_bound_group' as never, name: '发布群'}],
  memberships: [{id: 'm' as never, agentId: agent.id, groupId: 'oc_bound_group' as never, name: '发布群', directory: '/tmp/x', backend: 'codex-appserver', conversation: 'threads', response: 'mention', permission: {administrator: 'full', member: 'qa', network: false}, stale: false}],
  tools, jobs: [], application: {platform: 'macos', version: '0.9.0', loginItem: false, dataPath: '/tmp/vonvon-home'},
});
const render = (agents: Agent[]) => renderToStaticMarkup(<ClientProvider client={client}>
  <DiagnosticsPanel snapshot={snapshot(agents)} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onOpenSetup={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}}/>
</ClientProvider>);

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
  expect(renderToStaticMarkup(<>{scopeView({scopes: {missingRequired: [], missingOptional: [], grantUrl: 'x'}} as AdminSetupStatus, agent, now).badge}</>)).toContain('没有缺的');
});

it('writes today\'s time short and another day\'s with its date, and finds each bot from search', () => {
  const at = new Date(2026, 9, 14, 14, 2).getTime();
  expect(shortTime(at, new Date(2026, 9, 14, 20, 0).getTime())).toBe('14:02');
  expect(shortTime(at, new Date(2026, 9, 15, 9, 0).getTime())).toBe('10月14日 14:02');
  const entry = findEntries(searchEntries(snapshot([agent])), '没回的消息').find(item => item.id === `${agent.id}-diagnostics`);
  expect(entry?.destination).toEqual({page: 'diagnostics', section: diagnosticsSection(agent.id)});
});
