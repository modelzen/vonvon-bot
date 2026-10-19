import { describe, expect, it } from 'vitest';
import { ambiguousNote, findHandoffs, handoffNote, handoffText } from '../src/bot/bot-handoff';
import type { RosterBot } from '../src/bot/bot-roster';

const bots = new Map<string, RosterBot>([
  ['ou_审', { appId: 'cli_审', name: '小审' }],
  ['ou_审2', { appId: 'cli_审2', name: '小审2' }],
  ['ou_b8', { appId: 'cli_b8', name: 'Vonvon Bot 8' }],
  ['ou_码', { appId: 'cli_码', name: '小码' }],
  ['ou_jojo', { appId: 'cli_jojo', name: 'Jojo' }],
  ['ou_me', { appId: 'cli_me', name: '小P' }],
]);
const me = { openId: 'ou_me', appId: 'cli_me' };
const find = (text: string, roster = bots) => findHandoffs(text, roster, me);
const h = (openId: string, name: string, sentence: string) => ({ openId, name, sentence });
const more = (...entries: [string, string][]) => new Map([...bots, ...entries.map(([id, name]): [string, RosterBot] => [id, { appId: `cli_${id}`, name }])]);

describe('findHandoffs', () => {
  it.each([
    ['方案在上面。@小审 请审一下。', 'ou_审', '小审', '请审一下。'],
    ['@小审帮我看', 'ou_审', '小审', '帮我看'],
    ['@小审2 看', 'ou_审2', '小审2', '看'],
    ['@小码哥 你看下', 'ou_码', '小码', '哥 你看下'],
    ['@Vonvon Bot 8 请审', 'ou_b8', 'Vonvon Bot 8', '请审'],
    ['@Vonvon Bot 8，谢谢', 'ou_b8', 'Vonvon Bot 8', '，谢谢'],
    ['@Vonvon Bot 8.', 'ou_b8', 'Vonvon Bot 8', '.'],
    ['@vonvon bot 8', 'ou_b8', 'Vonvon Bot 8', ''],
    ['@Jojo Wang 你好', 'ou_jojo', 'Jojo', 'Wang 你好'],
    ['@Jojo. 好', 'ou_jojo', 'Jojo', '. 好'],
    ['（@小审）', 'ou_审', '小审', '（）'],
    ['第一句！@小审 第二句？第三句', 'ou_审', '小审', '第二句？'],
    ['第一句\n@小审 第二句\n第三句', 'ou_审', '小审', '第二句'],
  ])('matches %s', (text, id, name, sentence) => {
    expect(find(text)).toEqual({ handoffs: [h(id, name, sentence)], ambiguous: [] });
  });

  it.each(['@Vonvon Bot 80 请审', '@VonvonBot8', '@Jojo.Wang', '@Jojo_w', '@Jojo-1', '@Jojo/x', 'a@小审', '1@小审', '@小P 我自己', '@真人', '@所有人'])('ignores %s', (text) => {
    expect(find(text)).toEqual({ handoffs: [], ambiguous: [] });
  });

  it('rejects a failed longest ASCII boundary without trying the shorter name', () => {
    const roster = more(['ou_bot', 'Bot'], ['ou_b8s', 'Bot 8'], ['ou_types', 'types']);
    expect(find('@Bot 80 看', roster).handoffs).toEqual([]);
    expect(find('@Bot 8 看', roster).handoffs).toEqual([h('ou_b8s', 'Bot 8', '看')]);
    expect(find('@Bot 看', roster).handoffs).toEqual([h('ou_bot', 'Bot', '看')]);
    expect(find('node_modules/@types/node @types/node', roster).handoffs).toEqual([]);
  });

  it.each([
    ['<at id="ou_审">小审</at> 看看', 'ou_审', '小审', '看看'],
    ['<at user_id=ou_码/>', 'ou_码', '小码', ''],
    ["<at open_id='ou_审'>", 'ou_审', '小审', ''],
  ])('reads tagged bot ids: %s', (text, id, name, sentence) => {
    expect(find(text)).toEqual({ handoffs: [h(id, name, sentence)], ambiguous: [] });
  });
  it('ignores unknown ids and prose tags', () => {
    expect(find('<at id="ou_外人"> <at least> <at').handoffs).toEqual([]);
  });
  it.each(['`@小审`', '```\n@小审\n```', '`<at id="ou_审">小审</at>`'])('skips code: %s', (text) => {
    expect(find(text).handoffs).toEqual([]);
  });
  it('recognizes mentions inside a feishu-card fence', () => {
    expect(find('```feishu-card\n@小审\n```').handoffs).toEqual([h('ou_审', '小审', '')]);
  });
  it('keeps the first sentence for repeated mentions', () => {
    expect(find('@小审 一句。@小审 两句。').handoffs).toEqual([h('ou_审', '小审', '一句。')]);
  });
  it('removes all mentions in a shared sentence and orders by occurrence', () => {
    expect(find('@小审 @小码 你们看看').handoffs).toEqual([h('ou_审', '小审', '你们看看'), h('ou_码', '小码', '你们看看')]);
    expect(find('<at id=ou_码/> @小审 看').handoffs.map((x) => x.openId)).toEqual(['ou_码', 'ou_审']);
  });
  it.each([
    ['<at user_id="all">所有人</at> 请 @小审 审一下。', '@所有人 请 审一下。'],
    ['@小审 和 <at user_id="ou_真人">张三</at> 一起看。', '和 @张三 一起看。'],
    ['@小审 <b>加粗</b> <at', 'b加粗/b at'],
    ['@小审 <file name="a.txt" path="/tmp/a.txt"/> 请看', '请看'],
  ])('sanitizes sentence: %s', (text, sentence) => {
    expect(find(text).handoffs).toEqual([h('ou_审', '小审', sentence)]);
  });
  it('excludes ourselves by app id even without an open id', () => {
    expect(findHandoffs('@小P 我自己', bots, { appId: 'cli_me' }).handoffs).toEqual([]);
    expect(findHandoffs('@小审', bots, {}).handoffs).toEqual([h('ou_审', '小审', '')]);
  });
  it('ignores names empty after personName', () => {
    expect(find('@() @（）', more(['ou_empty', ''], ['ou_brackets', '()（）'])).handoffs).toEqual([]);
  });
  it('reports duplicate names without choosing a bot, removing ambiguous mentions too', () => {
    const roster = more(['ou_审b', '小审']);
    expect(find('@小审 看看', roster)).toEqual({ handoffs: [], ambiguous: ['小审'] });
    expect(find('@小审2 看', roster).handoffs).toEqual([h('ou_审2', '小审2', '看')]);
    expect(find('@小审 @小码 看', roster)).toEqual({ handoffs: [h('ou_码', '小码', '看')], ambiguous: ['小审'] });
    expect(find('@小审 看。@小审 再看', roster).ambiguous).toEqual(['小审']);
  });
  it('treats names colliding after bracket removal as ambiguous', () => {
    expect(find('@小审1 看', more(['ou_x', '小审(1)'], ['ou_y', '小审1']))).toEqual({ handoffs: [], ambiguous: ['小审1'] });
  });
  it('compares duplicate ASCII names without case sensitivity', () => {
    const found = find('@Vonvon Bot 看', more(['ou_v1', 'Vonvon Bot'], ['ou_v2', 'vonvon bot']));
    expect(found).toEqual({ handoffs: [], ambiguous: ['Vonvon Bot'] });
  });
});

describe('handoffText', () => {
  it.each([
    ['方案在上面。@小审 请审一下。', '<at user_id="ou_审">小审</at> 请审一下。'],
    ['@小审 @小码 你们看看', '<at user_id="ou_审">小审</at> <at user_id="ou_码">小码</at> 你们看看'],
    ['@小审 一句。@小码 两句。', '<at user_id="ou_审">小审</at> <at user_id="ou_码">小码</at> 一句。 两句。'],
    ['@小审', '<at user_id="ou_审">小审</at> 请看上面的回答'],
  ])('builds a single text reply for %s', (text, expected) => {
    expect(handoffText(find(text).handoffs)).toBe(expected);
  });
  it('caps sentence text independently of mention tags', () => {
    const text = handoffText([h('ou_审', '小审', '字'.repeat(300))]);
    expect(text.split('</at> ')[1]).toBe(`${'字'.repeat(200)}…`);
  });
  it('normalizes line breaks and controls, and strips markup from names', () => {
    expect(handoffText([h('ou_审', '<小&审>', '请\n\t审\u0000一下')])).toBe('<at user_id="ou_审">小审</at> 请 审一下');
  });
  it.each(['<at user_id="all">所有人</at> 请 @小审 审一下。', '@小审 和 <at user_id="ou_真人">张三</at> 一起看。'])('adds no real mentions from sentence markup: %s', (source) => {
    const text = handoffText(find(source).handoffs);
    expect(text.match(/<at/g)).toHaveLength(1);
    expect(text).not.toContain('user_id="all"');
    expect(text).not.toContain('ou_真人');
  });
});

describe('handoff notes', () => {
  it('states failed sending', () => {
    expect(handoffNote(['小审', '小码'], 'failed')).toBe('→ 想 @ 小审（bot）、小码（bot），没发出：发送失败');
  });
  it('states uncertainty after timeout and removes name markup', () => {
    expect(handoffNote(['<小审>'], 'timeout')).toBe('→ 想 @ 小审（bot），没收到发送结果：超时，可能已发出');
  });
  it('explains ambiguity without ids', () => {
    expect(ambiguousNote('<小审>')).toBe('→ 想 @ 小审（bot），没交接：群里不止一个叫 小审 的 bot');
  });
});
