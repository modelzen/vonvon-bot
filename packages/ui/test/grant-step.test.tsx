import {afterEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AdminSetupStatus, AgentId, Job, JobId} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {GRANT_POLL_MS, GrantStep, PUBLISH_NOTE, ScopeGrantRow, grantView, pollEvery, registeredAgentId} from '../src/setup/GrantStep';
import {JOIN_SCOPE_WARNING} from '../src/setup/setupPresentation';

const agentId = 'cli_grant' as AgentId;
const grantUrl = 'https://open.feishu.cn/app/cli_grant/auth?q=im%3Aresource';
const status = (scopes: Partial<AdminSetupStatus['scopes']>): AdminSetupStatus => ({
  appId: 'cli_grant', tenant: 'feishu', credentials: {ok: true}, connection: {running: true},
  event: {state: 'unpublished'}, scopes: {grantUrl, ...scopes},
  eventConfigUrl: 'https://open.feishu.cn/app/cli_grant/event', consoleUrl: 'https://open.feishu.cn/app/cli_grant', cardCallback: {confirmed: false},
});

afterEach(() => { vi.useRealTimers(); });

it('shows the missing count, then 权限已开通, with the publish note only after the link was opened', () => {
  expect(grantView({}, false)).toEqual({status: '正在检测…', tone: 'neutral', done: false});
  expect(grantView({problem: '没有这个 Bot。'}, true)).toEqual({status: '检测失败', tone: 'warning', done: false, detail: '没有这个 Bot。'});
  const missing = status({missingRequired: ['im:resource', 'im:message:readonly'], missingJoinScopes: ['im:chat:readonly']});
  expect(grantView({status: missing}, false)).toMatchObject({status: '还缺 2 项', tone: 'warning', done: false, grantUrl, items: ['im:resource', 'im:message:readonly'], warnings: [JOIN_SCOPE_WARNING]});
  expect(grantView({status: missing}, false).note).toBeUndefined();
  expect(grantView({status: missing}, true).note).toBe(PUBLISH_NOTE);
  expect(PUBLISH_NOTE).toContain('创建版本并发布');
  // Unreadable grants after opening the link still point at publishing; the stale status survives a failed read.
  expect(grantView({status: status({}), problem: 'timeout'}, true)).toMatchObject({status: '无法确认', done: false, grantUrl, note: PUBLISH_NOTE});
  const granted = grantView({status: status({missingRequired: [], missingJoinScopes: []})}, true);
  expect(granted).toMatchObject({status: '权限已开通', tone: 'success', done: true, grantUrl});
  expect(granted.note).toBeUndefined();
});

it('polls every 5 seconds until the read says stop, and stops when closed', async () => {
  vi.useFakeTimers();
  expect(GRANT_POLL_MS).toBe(5_000);
  const tick = vi.fn(async () => tick.mock.calls.length < 3);
  pollEvery(GRANT_POLL_MS, tick);
  await vi.advanceTimersByTimeAsync(0);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(tick).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(tick).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(tick).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(tick).toHaveBeenCalledTimes(3);

  const closed = vi.fn(async () => true);
  const stop = pollEvery(GRANT_POLL_MS, closed);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(closed).toHaveBeenCalledTimes(1);

  const flaky = vi.fn(async () => { throw new Error('boom'); });
  const stopFlaky = pollEvery(GRANT_POLL_MS, flaky);
  await vi.advanceTimersByTimeAsync(GRANT_POLL_MS);
  expect(flaky).toHaveBeenCalledTimes(2);
  stopFlaky();
});

it('keeps the new bot only for a first registration that succeeded', () => {
  const jobId = 'job_1' as JobId;
  const succeeded: Job = {id: jobId, type: 'registerAgent', phase: 'succeeded', message: '机器人已保存。', agentId};
  expect(registeredAgentId(succeeded, false)).toBe(agentId);
  expect(registeredAgentId(succeeded, undefined)).toBe(agentId);
  expect(registeredAgentId(succeeded, true)).toBeUndefined();
  expect(registeredAgentId({id: jobId, type: 'registerAgent', phase: 'failed', message: 'x'}, false)).toBeUndefined();
  expect(registeredAgentId({id: jobId, type: 'loginCodex', phase: 'succeeded', message: 'x', agentId}, false)).toBeUndefined();
  expect(registeredAgentId(undefined, false)).toBeUndefined();
});

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const render = (node: React.ReactNode) => renderToStaticMarkup(<ClientProvider client={client}>{node}</ClientProvider>);

it('renders the grant step with both ways out before the first read', () => {
  const html = render(<GrantStep agentId={agentId} onOpenChecklist={() => {}} onDone={() => {}}/>);
  expect(html).toContain('机器人已注册');
  expect(html).toContain('第 2 步 · 开权限');
  expect(html).toContain('正在检测…');
  expect(html).toContain('去首次运行清单');
  expect(html).toContain('完成');
});

it('renders the Bot 设置 grant row disabled until the status arrives', () => {
  const html = render(<ScopeGrantRow agentId={agentId} disabled={false} onError={() => {}}/>);
  expect(html).toContain('飞书权限');
  expect(html).toContain('data-search-title="飞书权限"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>一键开权限<\/span><\/button>/);
});
