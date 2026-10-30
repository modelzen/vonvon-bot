import {renderToStaticMarkup} from 'react-dom/server';
import {expect, test} from 'vitest';
import type {AdminReply, JudgeUsageDay} from '@vonvon/protocol';
import {botTotals, dayLabel, judgeSourceTotals, JudgeUsageRows, judgeUsageReader, type JudgeUsageRead, type JudgeUsageView} from '../src/management/JudgeUsage';

const days: JudgeUsageDay[] = [
  {date: '2026-10-19', total: 5, sources: [{kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 3}, {kind: 'decision', id: 'typesafe', label: 'TypeSafe', count: 2}], bots: [{agentId: 'cli_fixture', agentName: 'Bot 7', count: 3}]},
  {date: '2026-10-18', total: 0, sources: [], bots: []},
  {date: '2026-10-17', total: 1, sources: [{kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 1}], bots: [{agentId: 'cli_fixture', agentName: 'Bot 7', count: 1}]},
];
const view: JudgeUsageView = {kind: 'judgeUsage', days, unreadBots: 0};
const render = (read: JudgeUsageRead) => renderToStaticMarkup(<JudgeUsageRows read={read} onRead={() => {}}/>);

test('Jev daily totals include every decision service and exclude native language-model calls', () => {
  const mixed: JudgeUsageDay = {date: '2026-10-30', total: 30, bots: [], sources: [
    {kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 20},
    {kind: 'decision', id: 'typesafe', label: 'TypeSafe', count: 1},
    {kind: 'decision', id: 'openrouter', label: 'OpenRouter', count: 2},
    {kind: 'decision', id: 'vercel', label: 'Vercel', count: 3},
    {kind: 'decision', id: 'custom', label: '自定义 Jev', count: 4},
  ]};
  const html = renderToStaticMarkup(<JudgeUsageRows read={{kind: 'ready', view: {...view, days: [mixed]}}} onRead={() => {}} dailySource={{kind: 'decision'}}/>);
  expect(html).toContain('10 次');
  expect(html).not.toContain('30 次');
  expect(html).not.toContain('Codex');
});

test('dates use daemon today and include the year only across years', () => {
  expect(dayLabel('2026-10-19', '2026-10-19')).toBe('10月19日（今天）');
  expect(dayLabel('2026-10-05', '2026-10-19')).toBe('10月5日');
  expect(dayLabel('2025-12-31', '2026-01-02')).toBe('2025年12月31日');
});
test('daily rows show today and nonzero days, sources and bot totals', () => {
  const html = render({kind: 'ready', view});
  for (const text of ['10月19日（今天）', '5 次', '语言模型 Codex 3 次 · 决策模型 Jev 2 次', '10月17日', '按 Bot 看', '今天 3 次 · 14 天 4 次']) expect(html).toContain(text);
  expect(html).not.toContain('10月18日');
  expect(botTotals(days)).toEqual([{agentId: 'cli_fixture', agentName: 'Bot 7', today: 3, total: 4}]);
});
test('fourteen empty days show only today and the smart group explanation', () => {
  const empty = Array.from({length: 14}, (_, i) => ({date: `2026-10-${19 - i}`, total: 0, sources: [], bots: []}));
  const html = render({kind: 'ready', view: {...view, days: empty}});
  expect(html).toContain('只有智能群会判断。');
  expect(html).toContain('10月19日（今天）');
  expect(html).not.toContain('10月18日');
  expect(html).not.toContain('按 Bot 看');
});
test('unreadable bots and old daemon failures explain what happened', () => {
  const html = render({kind: 'ready', view: {...view, unreadBots: 2, botsUnreadable: true}, problem: '没连上 daemon'});
  for (const text of ['有 2 个 Bot 的判断次数读不了', 'Bot 列表读不了，判断次数都没算进来', 'judge usage-unreadable', 'judge usage-bots-unreadable', '没连上 daemon', '5 次']) expect(html).toContain(text);
  expect(render({kind: 'failed', problem: 'daemon 比网页旧，重启 daemon 后再开这一页'})).toContain('daemon 比网页旧，重启 daemon 后再开这一页');
  expect(render({kind: 'loading'})).toContain('正在读取判断次数');
});
test('only the latest requested read lands and refresh failure retains the numbers', async () => {
  const pending: ((reply: AdminReply) => void)[] = [];
  const published: JudgeUsageRead[] = [];
  const reader = judgeUsageReader(() => new Promise(resolve => pending.push(resolve)), read => published.push(read));
  const first = reader.read();
  const second = reader.read();
  pending[1]?.(view); await second;
  pending[0]?.({...view, days: []}); await first;
  expect(published).toEqual([{kind: 'ready', view}]);
  const third = reader.read();
  pending[2]?.(view); await third;
  const fourth = reader.read();
  pending[3]?.({kind: 'secrets', services: [], unreadBots: 0}); await fourth;
  expect(published.at(-1)).toEqual({kind: 'ready', view, problem: 'daemon 回的不是判断次数'});
});

test.each([{unreadBots: 1}, {botsUnreadable: true}])('empty unreadable usage does not claim only smart groups judge: %j', problem => {
  const html = render({kind: 'ready', view: {...view, days: [{date: '2026-10-19', total: 0, sources: [], bots: []}], ...problem}});
  expect(html).not.toContain('只有智能群会判断。');
  expect(html).toContain('0 次');
});
test('footer describes attempted calls including connection failures', () => {
  expect(render({kind: 'ready', view})).toContain('计入已发起的调用，包括连接失败。');
});

test('home summaries keep Jev calls separate from language models and distinguish today from history', () => {
  expect(judgeSourceTotals(days)).toEqual([
    {key: 'llm:codex-appserver', label: 'Codex', today: 3, total: 4},
    {key: 'decision:typesafe', label: 'Jev', today: 2, total: 2},
  ]);
  const olderOnly = [{...days[0]!, sources: []}, days[0]!];
  expect(judgeSourceTotals(olderOnly).find(source => source.label === 'Jev')).toMatchObject({today: 0, total: 2});
  const html = renderToStaticMarkup(<JudgeUsageRows read={{kind: 'ready', view}} onRead={() => {}} compact/>);
  expect(html).toContain('Jev');
  expect(html).toContain('每日记录');
  expect(html).toContain('今天');
  expect(html).not.toContain('重新读取判断次数');
});

test('home summaries retain partial-read warnings and do not invent Jev use for empty history', () => {
  const html = renderToStaticMarkup(<JudgeUsageRows read={{kind: 'ready', view: {...view, unreadBots: 1}}} onRead={() => {}} compact disabled/>);
  expect(html).toContain('有 1 个 Bot 的判断次数读不了');
  expect(html).toContain('当前为上次读取的数据');
  expect(html).toContain('Jev');
  expect(judgeSourceTotals([{...days[0]!, total: 0, sources: [], bots: []}])).toEqual([]);
});

test('the Jev tab shows only its daily calls without attributing language-model or Bot totals to Jev', () => {
  const html = renderToStaticMarkup(<JudgeUsageRows read={{kind: 'ready', view}} onRead={() => {}} dailySource={{kind: 'decision', id: 'typesafe'}}/>);
  expect(html).toContain('10月19日（今天）');
  expect(html).toContain('2 次');
  for (const content of ['5 次', 'Codex', '10月17日', 'Bot 7', '按 Bot 看', '每日记录', '智能模式的判断次数', '最近 14 天', '<details']) expect(html).not.toContain(content);
});

test('the Jev tab keeps real zero dates and reports incomplete or failed reads', () => {
  const current = {...view, days: [{...days[0]!, sources: days[0]!.sources.filter(source => source.kind === 'llm')}], unreadBots: 1};
  const html = renderToStaticMarkup(<JudgeUsageRows read={{kind: 'ready', view: current, problem: '没连上 daemon'}} onRead={() => {}} dailySource={{kind: 'decision', id: 'typesafe'}}/>);
  expect(html).toContain('0 次');
  expect(html).not.toContain('3 次');
  expect(html).toContain('部分记录暂时无法读取');
  expect(html).toContain('没连上 daemon');
});
