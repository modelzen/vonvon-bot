import {expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AdminSetupStatus, Agent, DesktopSnapshot, ToolState} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {SetupChecklist} from '../src/setup/SetupChecklist';
import {BOT_ADDED_WARNING, JOIN_SCOPE_WARNING, botSteps, remoteStepsDone, scopeStep, toolSteps} from '../src/setup/setupPresentation';

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
  const old = toolSteps([tool({tool: 'codex', compatibility: {status: 'tooOld', minimum: '0.139.0', verified: '0.156.1'}}), tool({tool: 'claude', authentication: 'signedOut'})]);
  expect(old.ready).toBe(false);
  expect(old.steps[0]).toMatchObject({status: '版本太旧 · 0.162.1', detail: '最低要 0.139.0，请在本机环境更新。'});
  expect(old.steps[1]?.actions).toEqual([{kind: 'claudeLogin', label: '检查登录'}]);
  const missing = toolSteps([tool({tool: 'codex', installation: 'missing', authentication: 'unknown', version: null})]);
  expect(missing.steps[0]?.detail).toContain('Homebrew');
  expect(toolSteps([tool({tool: 'codex', authentication: 'signedOut'})]).steps[0]?.actions).toEqual([{kind: 'codexLogin', label: '登录 Codex'}]);
  expect(toolSteps([tool({tool: 'claude', authentication: 'signedIn', message: '已登录，凭据来自 ANTHROPIC_AUTH_TOKEN。'})]).ready).toBe(true);
});

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const snapshot = (agents: Agent[]): DesktopSnapshot => ({
  revision: 1, observedAt: 1, stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
  agents, groups: [], memberships: [], tools: [tool({tool: 'codex', installation: 'missing', authentication: 'unknown', version: null})], jobs: [], diagnostics: [],
  application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/tmp/test'},
});
const render = (agents: Agent[]) => renderToStaticMarkup(<ClientProvider client={client}>
  <SetupChecklist snapshot={snapshot(agents)} ready busy={false} run={async () => ({kind: 'applied', revision: 1})} onRegister={() => {}} onOpenEnvironment={() => {}} onNotice={() => {}} codexJobs={null}/>
</ClientProvider>);

it('starts a new machine with the tools and the scan step', () => {
  const html = render([]);
  expect(html).toContain('执行工具');
  expect(html).toContain('还没有可用的工具');
  expect(html).toContain('第一步');
  expect(html).toContain('扫码建飞书应用');
  expect(html).toContain('注册 Bot');
  expect(html).not.toContain('添加 Bot');
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
  expect(byId(botSteps(agent, {...done, event: {state: 'unpublished'}})).event?.warnings).toBeUndefined();
  expect(remoteStepsDone({...done, scopes: {...done.scopes, missingJoinScopes: ['im:chat:readonly']}, event: {state: 'ok', missingOptional: ['im.chat.member.bot.added_v1']}})).toBe(true);
});

it('drops the warnings while the credentials are rejected', () => {
  const steps = byId(botSteps(agent, {...done, credentials: {ok: false, reason: 'code=10014'}, scopes: {...done.scopes, missingJoinScopes: ['im:chat:readonly']}, event: {state: 'ok', missingOptional: ['im.chat.member.bot.added_v1']}}));
  expect([steps.scopes?.warnings, steps.event?.warnings]).toEqual([undefined, undefined]);
});
