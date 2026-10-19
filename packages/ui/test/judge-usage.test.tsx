import {renderToStaticMarkup} from 'react-dom/server';
import {expect, test} from 'vitest';
import type {AdminReply, JudgeUsageDay} from '@vonvon/protocol';
import {botTotals, dayLabel, JudgeUsageRows, judgeUsageReader, type JudgeUsageRead, type JudgeUsageView} from '../src/management/JudgeUsage';

const days: JudgeUsageDay[] = [
  {date: '2026-10-19', total: 5, sources: [{kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 3}, {kind: 'decision', id: 'typesafe', label: 'TypeSafe', count: 2}], bots: [{agentId: 'cli_fixture', agentName: 'Bot 7', count: 3}]},
  {date: '2026-10-18', total: 0, sources: [], bots: []},
  {date: '2026-10-17', total: 1, sources: [{kind: 'llm', id: 'codex-appserver', label: 'Codex', count: 1}], bots: [{agentId: 'cli_fixture', agentName: 'Bot 7', count: 1}]},
];
const view: JudgeUsageView = {kind: 'judgeUsage', days, unreadBots: 0};
const render = (read: JudgeUsageRead) => renderToStaticMarkup(<JudgeUsageRows read={read} onRead={() => {}}/>);

test('dates use daemon today and include the year only across years', () => {
  expect(dayLabel('2026-10-19', '2026-10-19')).toBe('10月19日（今天）');
  expect(dayLabel('2026-10-05', '2026-10-19')).toBe('10月5日');
  expect(dayLabel('2025-12-31', '2026-01-02')).toBe('2025年12月31日');
});
test('daily rows show today and nonzero days, sources and bot totals', () => {
  const html = render({kind: 'ready', view});
  for (const text of ['10月19日（今天）', '5 次', '语言模型 Codex 3 次 · 决策模型 TypeSafe 2 次', '10月17日', '按 Bot 看', '今天 3 次 · 14 天 4 次']) expect(html).toContain(text);
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
  for (const text of ['有 2 个 Bot 的判断次数读不了', 'Bot 列表读不了，判断次数都没算进来', 'judge usage-unreadable', '没连上 daemon', '5 次']) expect(html).toContain(text);
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
