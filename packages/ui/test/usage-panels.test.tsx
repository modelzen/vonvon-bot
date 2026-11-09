import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {desktopSnapshotSchema, type JudgeUsageDay} from '@vonvon/protocol';
import {createClient} from '../../client/src/client';
import {ClientProvider, type ShellCapabilities} from '../src/client-context';
import {TodayHome} from '../src/TodayHome';
import {claudeModelName, ClaudeUsagePanel, CodexUsagePanel, durationAmount, JevUsagePanel, jevUsage, tokenAmount} from '../src/UsagePanels';
import {UsageAccount, usageDays} from '../src/management/UsageContent';
import type {JudgeUsageView} from '../src/management/JudgeUsage';
import type {Usage} from '../src/management/usage-data';

// A Sunday, so the heatmap's 91 cells are all past days: day(90) … day(0).
const now = new Date('2026-11-08T07:42:00Z');
const day = (back: number) => new Date(now.getTime() - back * 86_400_000).toISOString().slice(0, 10);
const reset = Math.floor(now.getTime() / 1000) + 3600;
const buckets = Array.from({length: 91}, (_, index) => ({date: day(90 - index), tokens: 1_000_000, messages: 10}));
const codex: Usage = {
  profile: {lifetimeTokens: 257_000_000, peakDailyTokens: 4_810_000, currentStreakDays: 23, longestStreakDays: 41, longestTurnSec: 47 * 60, totalThreads: 1842,
    fastModePct: 12, mostUsedEffort: 'medium', mostUsedEffortPct: 64, dailyBuckets: buckets.map(({date, tokens}) => ({date, tokens})),
    topInvocations: [{name: 'pdf', count: 96, kind: 'skill'}, {name: 'playwright', count: 208, kind: 'skill'}, {name: 'github', count: 999, kind: 'plugin'}, {name: 'vonvon-feishu-message', count: 312, kind: 'skill'}, {name: 'xlsx', count: 3, kind: 'skill'}]},
  usage: {planType: 'pro', main: {primary: {usedPercent: 34, windowSeconds: 18000, resetAt: reset}, secondary: {usedPercent: 96, windowSeconds: 604800, resetAt: reset}}, extras: [], fetchedAt: now.getTime()},
};
const hours = Array.from({length: 24}, (_, hour) => hour === 15 ? 19 : hour % 5);
const claude: Usage = {
  profile: {lifetimeTokens: 1_262_000_000, currentStreakDays: 9, longestStreakDays: 16, topInvocations: [], dailyBuckets: buckets,
    localStats: {state: 'ready', sessions: 186, messages: 910, activeDays: 91, longestSessionSec: 24 * 3600 + 18 * 60, longestSessionMessages: 3448, hourCounts: hours,
      models: [{id: 'claude-opus-5-5', tokens: 1_087_000_000}, {id: 'claude-sonnet-4-5-20250929', tokens: 112_000_000}, {id: 'claude-fable-5-1', tokens: 54_000_000}, {id: 'claude-3-5-haiku-20241022', tokens: 9_000_000}]}},
  usage: {planType: 'max', main: {primary: {usedPercent: 1, windowSeconds: 18000, resetAt: reset}, secondary: {usedPercent: 1, windowSeconds: 604800, resetAt: reset}},
    extras: [{name: 'Fable', secondary: {usedPercent: 0, windowSeconds: 604800, resetAt: reset}}], fetchedAt: now.getTime()},
};
// Day `back`: Jev (TypeSafe) 10 + back calls, plus 5 calls of a Bot's own Codex judging that are not Jev's.
const jevDays: JudgeUsageDay[] = Array.from({length: 14}, (_, back) => ({date: day(back), total: 15 + back,
  sources: [{kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 5}, {kind: 'decision', id: 'typesafe', label: 'TypeSafe', count: 10 + back}],
  bots: [{agentId: 'cli_fixture_a', agentName: 'Bot A', count: 12 + back, sources: [{kind: 'llm', id: 'codex-appserver', count: 5}, {kind: 'decision', id: 'typesafe', count: 7 + back}]},
    {agentId: 'cli_fixture_b', agentName: 'Bot B', count: 3, sources: [{kind: 'decision', id: 'typesafe', count: 3}]}]}));
const jev: JudgeUsageView = {kind: 'judgeUsage', days: jevDays, unreadBots: 0};
const gridCells = (html: string, level: number) => html.match(new RegExp(`usage-cell--${level}" data-future`, 'g'))?.length ?? 0;
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(now);});
afterEach(() => {vi.useRealTimers();});

describe('numbers as people say them', () => {
  it('rounds tokens to 亿 and 万 and durations to minutes or hours', () => {
    expect(tokenAmount(257_000_000)).toEqual(['2.57', '亿']);
    expect(tokenAmount(1_262_000_000)).toEqual(['12.6', '亿']);
    expect(tokenAmount(4_810_000)).toEqual(['481', '万']);
    expect(tokenAmount(12_345)).toEqual(['1.2', '万']);
    expect(tokenAmount(812)).toEqual(['812', '']);
    expect(durationAmount(47 * 60)).toEqual(['47', '分钟']);
    expect(durationAmount(0)).toEqual(['0', '分钟']);
    expect(durationAmount(20)).toEqual(['<1', '分钟']);
    expect(durationAmount(5400)).toEqual(['1.5', '小时']);
    expect(durationAmount(24 * 3600 + 18 * 60)).toEqual(['24', '小时']);
  });
  it('names Claude models the way Claude Code does and leaves unknown ids alone', () => {
    expect(claudeModelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(claudeModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(claudeModelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(claudeModelName('claude-3-5-haiku-20241022')).toBe('Haiku 3.5');
    expect(claudeModelName('<synthetic>')).toBe('<synthetic>');
  });
});

describe('Codex panel', () => {
  it('shows the four numbers, the heatmap, the quota and the habits row', () => {
    const html = renderToStaticMarkup(<CodexUsagePanel data={codex}/>);
    for (const text of ['2.57<small>亿</small>', '1,842 个会话', '23<small>天</small>', '最长 41 天', '481<small>万 Token</small>', '47<small>分钟</small>',
      'usage-heatmap__grid', '每日 Token · 最近 13 周', '<strong>Codex Pro</strong>', '读取于', '5 小时限额', '7 天限额', '推理强度 <b>medium</b> 64%', 'Fast 模式 <b>12%</b>']) expect(html).toContain(text);
    // Skills only, busiest first, three of them.
    expect(html.indexOf('vonvon-feishu-message')).toBeLessThan(html.indexOf('playwright'));
    expect(html.indexOf('playwright')).toBeLessThan(html.indexOf('>pdf<'));
    for (const text of ['github', 'xlsx']) expect(html).not.toContain(text);
    // 90% and up turns to the warning colour.
    expect(html.match(/data-high="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-high="true"><div class="usage-board-window-line"><span>7 天限额/);
  });
  it('says what an older or partial account report leaves out instead of making it up', () => {
    const sparse: Usage = {profile: {topInvocations: [], dailyBuckets: []}, usage: {main: {}, extras: [], fetchedAt: now.getTime()}};
    const html = renderToStaticMarkup(<CodexUsagePanel data={sparse}/>);
    expect(html.match(/data-missing="true">未提供/g)).toHaveLength(4);
    for (const text of ['Codex 暂未提供每日活动记录', '主要限额、额外限额暂不可用']) expect(html).toContain(text);
    for (const text of ['usage-board-habits', 'progressbar', '个会话']) expect(html).not.toContain(text);
  });
  it('leaves out what the share card turns off', () => {
    const html = renderToStaticMarkup(<CodexUsagePanel data={codex} sections={{habits: false, quota: false}}/>);
    for (const text of ['usage-board-quota', 'usage-board-habits', '推理强度']) expect(html).not.toContain(text);
    expect(html).toContain('2.57<small>亿</small>');
  });
  it('builds up day by day at progress 0.5: hidden days are empty and leave the total', () => {
    const html = renderToStaticMarkup(<CodexUsagePanel data={codex} progress={0.5}/>);
    // 45 of 91 days shown; the 46 hidden ones held 46 million tokens.
    expect(gridCells(html, 4)).toBe(45);
    expect(gridCells(html, 0)).toBe(46);
    expect(html).toContain('2.11<small>亿</small>');
    expect(html).toContain('921 个会话');
    expect(html).toContain('481<small>万 Token</small>');
    expect(gridCells(renderToStaticMarkup(<CodexUsagePanel data={codex} progress={0}/>), 4)).toBe(0);
  });
});

describe('Claude Code panel', () => {
  it('shows the local stats, the message heatmap, the model split and the start hours', () => {
    const html = renderToStaticMarkup(<ClaudeUsagePanel data={claude}/>);
    for (const text of ['12.6<small>亿</small>', '最常用 Opus 5.5', '9<small>天</small>', '最长 16 天 · 共活跃 91 天', '186<small>个</small>', '910 条消息',
      '24<small>小时</small>', '3,448 条消息', '每日消息 · 最近 13 周', '<strong>Claude Max</strong>',
      'Opus 5.5<b>86%</b>', 'Sonnet 4.5<b>9%</b>', 'Fable 5.1<b>4%</b>', 'Haiku 3.5<b>1%</b>', '最常在 <b>15 点</b>开工']) expect(html).toContain(text);
    // Hours 0, 5, 10 and 20 had no sessions: an empty slot, not a short bar.
    expect(html.match(/<i data-zero="true" title="\d+ 点 · 0 个会话"/g)).toHaveLength(4);
  });
  it('shows a Fable limit with only a weekly window as a normal 7-day row', () => {
    const html = renderToStaticMarkup(<ClaudeUsagePanel data={claude}/>);
    expect(html).toContain('<span>Fable 7 天限额</span><strong>0<small>%</small></strong>');
    expect(html).not.toContain('暂不可用');
    const settings = renderToStaticMarkup(<UsageAccount data={claude} provider="Claude"/>);
    expect(settings).toContain('Fable 7 天限额');
    expect(settings).toContain('已用 0%');
    expect(settings).not.toContain('暂不可用');
  });
  it('grades days by the p25/p50/p75 of active days and counts a day without messages as zero', () => {
    const graded = usageDays([1, 2, 3, 4, 5, 6, 7, 8].map((messages, back) => ({date: day(back + 1), tokens: 0, messages})), now, 'messages');
    expect([1, 3, 5, 7].map(messages => graded.find(cell => cell.date === day(messages))?.level)).toEqual([1, 2, 3, 4]);
    expect(graded.find(cell => cell.date === day(0))).toMatchObject({value: 0, level: 0});
  });
  it.each([
    ['scanning', '正在统计本机的 Claude Code 记录'],
    ['unavailable', '本机没有 Claude Code 的使用记录'],
    [undefined, '暂无 Claude Code 的使用统计'],
  ] as const)('keeps the quota while the local stats are %s', (state, text) => {
    const profile = {...claude.profile, localStats: state && {...claude.profile.localStats!, state}};
    const html = renderToStaticMarkup(<ClaudeUsagePanel data={{...claude, profile}}/>);
    expect(html).toContain(text);
    expect(html).toContain('<strong>Claude Max</strong>');
    for (const absent of ['usage-board-stats', 'usage-heatmap__grid', 'usage-board-habits']) expect(html).not.toContain(absent);
  });
  // now-share N2b: without subscription quota the daemon says why, and the local stats stay.
  const gap = (reason: string, message: string): Usage['usage'] => ({main: {}, extras: [], fetchedAt: now.getTime(), unavailable: {reason, message}});
  it.each([
    ['api-key-mode', '用的是 API 接入，没有订阅额度'],
    ['no-auth', '没有读到 Claude 订阅登录，看不到额度'],
    ['need-relogin', '订阅凭据过期了，在终端运行 `claude` 后再看'],
    ['transient', '额度暂时读不到'],
  ])('keeps the local stats and says why there is no quota: %s', (reason, message) => {
    const html = renderToStaticMarkup(<ClaudeUsagePanel data={{...claude, usage: gap(reason, message)}}/>);
    for (const text of ['12.6<small>亿</small>', '186<small>个</small>', 'usage-heatmap__grid', 'usage-board-habits',
      '<strong>Claude</strong>', `<p class="usage-board-unavailable" role="status" data-reason="${reason}">${message}</p>`]) expect(html).toContain(text);
    // Neither a read time nor empty windows: there was no quota to read.
    for (const text of ['读取于', '暂不可用', 'progressbar', '限额']) expect(html).not.toContain(text);
  });
  it('says why there is no quota while the local stats are scanning or missing', () => {
    for (const [state, text] of [['scanning', '正在统计本机的 Claude Code 记录'], ['unavailable', '本机没有 Claude Code 的使用记录']] as const) {
      const profile = {...claude.profile, localStats: {...claude.profile.localStats!, state}};
      const html = renderToStaticMarkup(<ClaudeUsagePanel data={{profile, usage: gap('api-key-mode', '用的是 API 接入，没有订阅额度')}}/>);
      for (const shown of [text, '用的是 API 接入，没有订阅额度']) expect(html).toContain(shown);
      expect(html).not.toContain('读取于');
    }
  });
  it('builds up day by day at progress 0.5', () => {
    const html = renderToStaticMarkup(<ClaudeUsagePanel data={claude} progress={0.5}/>);
    for (const text of ['12.2<small>亿</small>', '450 条消息', '共活跃 45 天', '93<small>个</small>', '24<small>小时</small>']) expect(html).toContain(text);
    expect(gridCells(html, 0)).toBe(46);
  });
});

describe('Jev panel', () => {
  it('counts only decision services, by day and by Bot', () => {
    const html = renderToStaticMarkup(<JevUsagePanel view={jev} asOf={now.getTime()}/>);
    for (const text of ['今天判断', '10<small>次</small>', '截至 ', '14 天合计', '231<small>次</small>', '日均 17 次', '最忙一天', '23<small>次</small>', '10月26日',
      '昨天', '11<small>次</small>', '11月7日', '按 Bot · 14 天', 'Bot A</span><b>189</b>', 'Bot B</span><b>42</b>', 'data-count="10"']) expect(html).toContain(text);
    // Codex judging is the Provider's own usage: neither the day nor Bot A's total includes it.
    for (const text of ['301', '259']) expect(html).not.toContain(text);
  });
  it('adds every decision service and none of the language models', () => {
    const mixed: JudgeUsageDay = {date: day(0), total: 30, bots: [], sources: [
      {kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 20}, {kind: 'decision', id: 'typesafe', label: 'TypeSafe', count: 1},
      {kind: 'decision', id: 'openrouter', label: 'OpenRouter', count: 2}, {kind: 'decision', id: 'custom', label: '自定义 Jev', count: 7}]};
    expect(jevUsage({...jev, days: [mixed]}).today).toMatchObject({count: 10});
  });
  it('hides the Bot column without per-Bot sources from an older daemon, or with one Bot', () => {
    const older = jevDays.map(({bots, ...day}) => ({...day, bots: bots.map(({sources: _sources, ...bot}) => bot)}));
    expect(renderToStaticMarkup(<JevUsagePanel view={{...jev, days: older}}/>)).not.toContain('按 Bot');
    const single = jevDays.map(day => ({...day, bots: day.bots.slice(0, 1)}));
    expect(renderToStaticMarkup(<JevUsagePanel view={{...jev, days: single}}/>)).not.toContain('按 Bot');
    expect(renderToStaticMarkup(<JevUsagePanel view={jev} sections={{habits: false}}/>)).not.toContain('按 Bot');
  });
  it('builds up from the oldest day at progress 0.5', () => {
    const html = renderToStaticMarkup(<JevUsagePanel view={jev} progress={0.5}/>);
    // Days 13 … 7 back: 23 + 22 + … + 17 calls; today and yesterday not shown yet.
    expect(html).toContain('140<small>次</small>');
    expect(html.match(/今天判断<\/dt><dd>0<small>/)).not.toBeNull();
    expect(html.match(/data-zero="true"/g)).toHaveLength(7);
    expect(html).toContain('Bot B</span><b>21</b>');
  });
  it('says when some Bots could not be read and keeps real zero days', () => {
    const empty = jevDays.map(day => ({...day, sources: [], bots: []}));
    const html = renderToStaticMarkup(<JevUsagePanel view={{...jev, days: empty, unreadBots: 1}}/>);
    expect(html).toContain('部分 Bot 的判断记录暂时无法读取');
    expect(html.match(/data-zero="true"/g)).toHaveLength(14);
    expect(html).toContain('data-count="0"');
  });
});

describe('此刻 page', () => {
  const client = createClient({isOpen: () => true, onMessage: () => {}, onClose: () => {}, onError: () => {}, send: () => {}, close: async () => {}});
  const snapshot = desktopSnapshotSchema.parse({attentionModel: 'group', revision: 1, observedAt: now.getTime(), stale: false, host: {kind: 'connected', ownership: 'owned', version: 'test'},
    agents: [{id: 'cli_fixture_a', name: 'Bot A', enabled: true, running: true, connection: 'connected', activation: 'active'}], groups: [], memberships: [], tools: [], jobs: [],
    application: {platform: 'macos', version: 'test', loginItem: false, dataPath: '/tmp/now'}});
  const home = (shell?: ShellCapabilities) => renderToStaticMarkup(<ClientProvider client={client} shell={shell}>
    <TodayHome snapshot={snapshot} onSetup={() => {}} onRegister={() => {}} onOpenUsage={() => {}} disabled={false}/>
  </ClientProvider>);
  it('puts usage above 群动态', () => {
    const web = home();
    expect(web.indexOf('aria-label="用量"')).toBeLessThan(web.indexOf('aria-label="群动态"'));
    expect(web).toContain('./agent-icons/typesafe.png');
  });
});
