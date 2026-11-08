import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {VonvonClient} from '@vonvon/client/browser';
import {mergeNowProvider, nowAccountLabel, NowUsageBody, readNowProviders, type NowProvider} from '../src/NowUsage';
import {usageWindowLabel, usageDays, UsageHeatmap} from '../src/management/UsageContent';
import {readUsage} from '../src/management/usage-data';

const data = {profile: {topInvocations: [], dailyBuckets: [{date: '2026-10-25', tokens: 100}], statsAsOf: '2026-10-25'}, usage: {main: {primary: {usedPercent: 32, windowSeconds: 18000, resetAt: 1793059200}}, extras: [], fetchedAt: 1}};
const codex: NowProvider = {id: 'codex-appserver', name: 'Codex', account: {kind: 'subscription', planType: 'plus'}, data};
// A daemon from now-share N2b on with no Claude subscription quota: local stats and why there is no quota.
const noQuota = {profile: {topInvocations: [], lifetimeTokens: 42, dailyBuckets: [{date: '2026-10-25', tokens: 42, messages: 2}],
  localStats: {state: 'ready' as const, models: [{id: 'claude-opus', tokens: 42}], sessions: 1, messages: 2, activeDays: 1, longestSessionSec: 60, longestSessionMessages: 2}},
  usage: {main: {}, extras: [], fetchedAt: 1, unavailable: {reason: 'api-key-mode', message: '用的是 API 接入，没有订阅额度'}}};
const entry = (id: string) => ({id, displayName: id === 'codex-appserver' ? 'Codex' : 'Claude', depState: 'installed'});
function client(logins: Record<string, unknown>) {
  return {environment: vi.fn(async request => request.type === 'backendCatalog' ? {kind: 'backends', entries: Object.keys(logins).map(entry)} : logins[request.id]), collaboration: vi.fn(async () => ({kind: 'usage', data}))} as unknown as Pick<VonvonClient, 'environment' | 'collaboration'>;
}
const login = (id: string, state = 'signedIn', kind = 'subscription') => ({kind: 'backendLogin', id, state, message: '', account: {kind}});

describe('real configured Provider discovery', () => {
  it('does not turn installed or selected SDKs into configured accounts', async () => {
    const c = client({'codex-appserver': login('codex-appserver', 'signedOut'), 'claude-agent': login('claude-agent', 'unknown')});
    const updates: any[] = [];
    await readNowProviders(c, update => updates.push(update));
    expect(updates.filter(item => item.kind === 'provider')).toEqual([]);
    expect(c.collaboration).not.toHaveBeenCalled();
  });
  it('keeps an explicitly configured external API even when its credentials cannot be verified', async () => {
    const c = client({'claude-agent': {...login('claude-agent', 'unknown', 'api'), account: {kind: 'api', apiProvider: 'bedrock'}}});
    vi.mocked(c.collaboration).mockResolvedValue({kind: 'usage', data: noQuota});
    const updates: any[] = [];
    await readNowProviders(c, update => updates.push(update));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({kind: 'provider', provider: {id: 'claude-agent', account: {kind: 'api', apiProvider: 'bedrock'}, problem: '账户状态暂无法确认。', loading: true}});
    expect(nowAccountLabel(updates[0].provider.account)).toBe('API 接入');
    expect(renderToStaticMarkup(<NowUsageBody provider={updates[0].provider}/>)).toContain('正在读取用量');
    // Its local stats come back; an unverifiable login does not make them stale.
    expect(updates[1]).toEqual({kind: 'provider', provider: {id: 'claude-agent', name: 'Claude', account: {kind: 'api', apiProvider: 'bedrock'}, data: noQuota}});
    const html = renderToStaticMarkup(<NowUsageBody provider={updates[1].provider}/>);
    for (const text of ['usage-heatmap__grid', '用的是 API 接入，没有订阅额度']) expect(html).toContain(text);
    for (const text of ['暂无法更新', 'data-stale="true"']) expect(html).not.toContain(text);
  });
  it('reads Claude stats for an API account but no Codex quota', async () => {
    const c = client({'codex-appserver': login('codex-appserver', 'notRequired', 'api'), 'claude-agent': login('claude-agent', 'signedIn', 'api')});
    vi.mocked(c.collaboration).mockResolvedValue({kind: 'usage', data: noQuota});
    const updates: any[] = [];
    await readNowProviders(c, update => updates.push(update));
    expect(c.collaboration).toHaveBeenCalledExactlyOnceWith({action: 'usage', force: false, backend: 'claude-agent'});
    expect(updates.filter(item => item.kind === 'provider' && item.provider.id === 'codex-appserver')).toEqual([{kind: 'provider', provider: {id: 'codex-appserver', name: 'Codex', account: {kind: 'api'}, loading: false}}]);
    expect(renderToStaticMarkup(<NowUsageBody provider={updates.find(item => item.provider.id === 'codex-appserver').provider}/>)).toContain('API 接入暂无法读取额度与每日用量');
    expect(vi.mocked(c.environment).mock.calls.filter(([request]) => request.type === 'backendLogin').every(([request]) => request.type === 'backendLogin' && !request.refresh)).toBe(true);
  });
  it("shows an older daemon's reason when it refuses a Claude API account's read", async () => {
    const c = client({'claude-agent': login('claude-agent', 'signedIn', 'api')});
    vi.mocked(c.collaboration).mockRejectedValue(new Error('当前 Claude 用的是 API 接入，没有订阅额度可读。'));
    const updates: any[] = [];
    await readNowProviders(c, update => updates.push(update));
    const provider = updates.at(-1).provider;
    expect(provider).toMatchObject({problem: '当前 Claude 用的是 API 接入，没有订阅额度可读。'});
    expect(provider.data).toBeUndefined();
    expect(renderToStaticMarkup(<NowUsageBody provider={provider}/>)).toContain('没有订阅额度可读');
  });
  it('reads Claude subscription quota from the connected daemon', async () => {
    const c = client({'claude-agent': login('claude-agent')});
    const updates: Parameters<Parameters<typeof readNowProviders>[1]>[0][] = [];
    await readNowProviders(c, update => updates.push(update));
    expect(c.collaboration).toHaveBeenCalledExactlyOnceWith({action: 'usage', force: false, backend: 'claude-agent'});
    expect(updates).toContainEqual({kind: 'provider', provider: {id: 'claude-agent', name: 'Claude', account: {kind: 'subscription'}, data}});
    const html = renderToStaticMarkup(<NowUsageBody provider={{id: 'claude-agent', name: 'Claude', account: {kind: 'subscription'}, data}}/>);
    expect(html).toContain('Claude 额度');
    expect(html).toContain('32');
    expect(html).toContain('5 小时限额');
    // A daemon from before now-share N2 sends no local stats: the quota stands alone, nothing is made up from tokens.
    expect(html).toContain('暂无 Claude Code 的使用统计');
    expect(html).not.toContain('usage-heatmap__grid');
  });
  it('publishes Codex without waiting for slow Claude and reuses the existing usage RPC', async () => {
    let resolve!: (value: unknown) => void;
    const waiting = new Promise(done => {resolve = done;});
    const c = client({'codex-appserver': login('codex-appserver'), 'claude-agent': waiting});
    const updates: any[] = [];
    const read = readNowProviders(c, update => updates.push(update));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(updates.some(item => item.provider?.data === data)).toBe(true);
    resolve(login('claude-agent', 'signedOut')); await read;
    expect(c.collaboration).toHaveBeenCalledExactlyOnceWith({action: 'usage', force: false});
  });
  it('removes logged-out accounts, retains failed reads as stale, and drops old quota on auth changes', () => {
    expect(mergeNowProvider([codex], {kind: 'remove', id: codex.id})).toEqual([]);
    expect(mergeNowProvider([codex], {kind: 'failed', id: codex.id, problem: 'offline'})[0]).toMatchObject({data, problem: 'offline'});
    expect(mergeNowProvider([], {kind: 'failed', id: codex.id, problem: 'offline'})).toEqual([]);
    expect(mergeNowProvider([codex], {kind: 'provider', provider: {...codex, data: undefined, problem: 'failed'}})[0]).toMatchObject({data, problem: 'failed'});
    expect(mergeNowProvider([codex], {kind: 'provider', provider: {id: codex.id, name: codex.name, account: {kind: 'api'}}})[0]?.data).toBeUndefined();
  });
});

describe('quota and daily history semantics', () => {
  it('distinguishes a real zero from absent history and excludes future days', () => {
    const cells = usageDays([{date: '2026-10-24', tokens: 0}, {date: '2026-10-25', tokens: 100}, {date: '2026-10-27', tokens: 999999}], new Date(2026, 9, 26));
    expect(cells).toHaveLength(91);
    expect(cells.find(cell => cell.date === '2026-10-24')).toMatchObject({level: 0, value: 0, future: false});
    expect(cells.find(cell => cell.date === '2026-10-25')).toMatchObject({level: 4});
    expect(cells.find(cell => cell.date === '2026-10-26')).toMatchObject({level: -1, value: undefined});
    expect(cells.find(cell => cell.date === '2026-10-27')).toMatchObject({future: true});
  });
  it('labels free and unknown accounts honestly and uses actual rate-limit windows', () => {
    expect(nowAccountLabel({kind: 'free'})).toBe('免费账户');
    expect(nowAccountLabel({kind: 'unknown'})).toBe('账户类型未知');
    expect(nowAccountLabel({kind: 'api'})).toBe('API 接入');
    expect(usageWindowLabel(604800, 'fallback')).toBe('7 天限额');
    expect(usageWindowLabel(18000, 'fallback')).toBe('5 小时限额');
    const html = renderToStaticMarkup(<NowUsageBody provider={codex}/>);
    expect(html).toContain('32'); expect(html).toContain('aria-label="5 小时限额已用"'); expect(html).toContain('重置');
    expect(html).not.toContain('% 剩余');
  });
  it('does not render a synthetic heatmap or quota for Claude or missing Codex history', () => {
    const html = renderToStaticMarkup(<NowUsageBody provider={{id: 'claude-agent', name: 'Claude', account: {kind: 'subscription', planType: 'max'}}}/>);
    expect(html).toContain('暂无法读取额度与每日用量'); expect(html).not.toContain('usage-heatmap__grid'); expect(html).not.toContain('progressbar');
    const empty = renderToStaticMarkup(<NowUsageBody provider={{...codex, data: {...data, profile: {...data.profile, dailyBuckets: []}, usage: {...data.usage, main: {}}}}}/>);
    expect(empty).toContain('暂未提供每日活动记录'); expect(empty).toContain('主要限额、额外限额暂不可用'); expect(empty).not.toContain('progressbar');
  });
  it('announces stale data and supports keyboard day inspection without turning missing dates into zero', () => {
    expect(renderToStaticMarkup(<NowUsageBody provider={codex} stale/>)).toContain('当前为上次读取的数据');
    const html = renderToStaticMarkup(<UsageHeatmap profile={data.profile} provider="Codex"/>);
    expect(html).toContain('方向键查看日期'); expect(html).toContain('tabindex="0"'); expect(html).toContain('暂无数据'); expect(html).toContain('aria-live="polite"');
  });
});


describe('settings usage presentation reused on home', () => {
  it('shows the Codex panel on home and keeps expanded details in settings', () => {
    const profile = {...data.profile, lifetimeTokens: 56_774_727_759, currentStreakDays: 35, totalThreads: 214, totalSkillsUsed: 87};
    const html = renderToStaticMarkup(<NowUsageBody provider={{...codex, data: {...data, profile}}}/>);
    for (const content of ['usage-board', 'data-provider="codex"', '累计 Token', '568<small>亿</small>', '214 个会话', '连续活跃', '35<small>天</small>', 'Codex 额度']) expect(html).toContain(content);
    for (const content of ['<details', '详细统计', '会话总数', '技能调用总数']) expect(html).not.toContain(content);
  });
  it('shares the settings request contract and preserves explicit refresh and refusal', async () => {
    const request = vi.fn(async () => ({kind: 'usage' as const, data}));
    expect(await readUsage(request)).toBe(data);
    expect(await readUsage(request, true)).toBe(data);
    expect(request.mock.calls).toEqual([[{action: 'usage', force: false}], [{action: 'usage', force: true}]]);
    await expect(readUsage(async () => ({kind: 'refused', code: 'offline', message: '请先登录'}))).rejects.toThrow('请先登录');
  });
});
