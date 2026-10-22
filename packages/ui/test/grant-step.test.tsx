import {afterEach, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {AdminReply, AdminSetupStatus, AgentId, Job, JobId} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider} from '../src/client-context';
import {
  GRANT_POLL_MS, GRANT_ROW_POLL_MS, GrantStep, PUBLISH_NOTE, ScopeGrantRow, grantView, jobToCancel, pollEvery,
  registeredAgentId, scopesSettled, watchScopeStatus, withRegisteredAgent, type ScopeRead,
} from '../src/setup/GrantStep';
import {JOIN_SCOPE_WARNING} from '@vonvon/protocol';

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

it('keeps the new bot in the dialog after its job view expires, and cancels nothing once it finished', () => {
  const jobId = 'job_2' as JobId;
  const qr = {kind: 'register', jobId} as const;
  const waiting: Job = {id: jobId, type: 'registerAgent', phase: 'qr', image: 'data:image/png;base64,', url: 'https://open.feishu.cn/x', expiresAt: 0};
  expect(withRegisteredAgent(qr, [waiting])).toBe(qr);
  expect(jobToCancel(qr)).toBe(jobId);
  const done = withRegisteredAgent(qr, [{id: jobId, type: 'registerAgent', phase: 'succeeded', message: '机器人已保存。', agentId}]);
  expect(done).toEqual({kind: 'register', jobId, agentId});
  expect(withRegisteredAgent(done, [])).toBe(done);
  expect(jobToCancel(done)).toBeUndefined();
  const refresh = {kind: 'register', jobId, refresh: true} as const;
  expect(withRegisteredAgent(refresh, [{id: jobId, type: 'registerAgent', phase: 'succeeded', message: 'ok', agentId}])).toBe(refresh);
  expect(jobToCancel(refresh)).toBe(jobId);
});

/** A client whose setupStatus answers come from `replies`, one per read; the last one repeats. */
function scopeClient(replies: (AdminSetupStatus | Error)[]) {
  let index = 0;
  const admin = vi.fn(async (): Promise<AdminReply> => {
    const next = replies[Math.min(index++, replies.length - 1)]!;
    if (next instanceof Error) throw next;
    return {kind: 'setupStatus', status: next} as AdminReply;
  });
  return {admin};
}
function reads(): {latest: () => ScopeRead; onRead: (update: (previous: ScopeRead) => ScopeRead) => void} {
  let read: ScopeRead = {};
  return {latest: () => read, onRead: update => { read = update(read); }};
}

it('re-reads until the required and join-group scopes are granted', async () => {
  vi.useFakeTimers();
  const missing = status({missingRequired: ['im:resource'], missingJoinScopes: ['im:chat:readonly']});
  const joinOnly = status({missingRequired: [], missingJoinScopes: ['im:chat:readonly']});
  const settled = status({missingRequired: [], missingJoinScopes: ['im:chat.members:write_only']});
  expect([missing, joinOnly, settled].map(scopesSettled)).toEqual([false, false, true]);
  const client = scopeClient([missing, joinOnly, settled]);
  const seen = reads();
  watchScopeStatus(client, agentId, GRANT_POLL_MS, seen.onRead);
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.latest().status).toBe(missing);
  await vi.advanceTimersByTimeAsync(GRANT_POLL_MS);
  expect(seen.latest().status).toBe(joinOnly);
  await vi.advanceTimersByTimeAsync(GRANT_POLL_MS);
  expect(seen.latest().status).toBe(settled);
  await vi.advanceTimersByTimeAsync(10 * GRANT_POLL_MS);
  expect(client.admin).toHaveBeenCalledTimes(3);
  expect(client.admin).toHaveBeenCalledWith({type: 'setupStatus', agentId});
});

it('retries a failed read and keeps the last good status meanwhile, so the Bot 设置 row recovers', async () => {
  vi.useFakeTimers();
  expect(GRANT_ROW_POLL_MS).toBe(30_000);
  const missing = status({missingRequired: ['im:resource']});
  const granted = status({missingRequired: [], missingJoinScopes: []});
  const client = scopeClient([new Error('daemon restarting'), missing, new Error('timeout'), granted]);
  const seen = reads();
  watchScopeStatus(client, agentId, GRANT_ROW_POLL_MS, seen.onRead);
  await vi.advanceTimersByTimeAsync(0);
  expect(seen.latest()).toEqual({problem: 'daemon restarting'});
  expect(grantView(seen.latest(), false).grantUrl).toBeUndefined();
  await vi.advanceTimersByTimeAsync(GRANT_ROW_POLL_MS);
  expect(seen.latest()).toEqual({status: missing});
  expect(grantView(seen.latest(), false).grantUrl).toBe(grantUrl);
  await vi.advanceTimersByTimeAsync(GRANT_ROW_POLL_MS);
  expect(seen.latest()).toEqual({status: missing, problem: 'timeout'});
  await vi.advanceTimersByTimeAsync(GRANT_ROW_POLL_MS);
  expect(grantView(seen.latest(), false)).toMatchObject({status: '权限已开通', done: true});
  await vi.advanceTimersByTimeAsync(10 * GRANT_ROW_POLL_MS);
  expect(client.admin).toHaveBeenCalledTimes(4);
});

it('stops reading when the dialog closes and drops the answer of a read still in flight', async () => {
  vi.useFakeTimers();
  let answer: (reply: AdminReply) => void = () => {};
  const admin = vi.fn(() => new Promise<AdminReply>(resolve => { answer = resolve; }));
  const onRead = vi.fn();
  const stop = watchScopeStatus({admin}, agentId, GRANT_POLL_MS, onRead);
  await vi.advanceTimersByTimeAsync(0);
  stop();
  answer({kind: 'setupStatus', status: status({missingRequired: ['im:resource']})} as AdminReply);
  await vi.advanceTimersByTimeAsync(10 * GRANT_POLL_MS);
  expect(admin).toHaveBeenCalledTimes(1);
  expect(onRead).not.toHaveBeenCalled();
});

const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
const render = (node: React.ReactNode) => renderToStaticMarkup(<ClientProvider client={client}>{node}</ClientProvider>);

it('renders the grant step with both ways out before the first read', () => {
  const html = render(<GrantStep agentId={agentId} onOpenChecklist={() => {}} onDone={() => {}}/>);
  expect(html).toContain('Bot 已注册');
  expect(html).toContain('第 2 步 · 开权限');
  expect(html).toContain('正在检测…');
  expect(html).toContain('查看连接与设置');
  expect(html).toContain('完成');
});

it('renders the Bot 设置 grant row disabled until the status arrives', () => {
  const html = render(<ScopeGrantRow agentId={agentId} disabled={false} onError={() => {}}/>);
  expect(html).toContain('飞书权限');
  expect(html).toContain('data-search-title="飞书权限"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span>一键开权限<\/span><\/button>/);
});
