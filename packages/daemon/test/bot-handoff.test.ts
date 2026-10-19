import { describe, expect, it } from 'vitest';
import { ambiguousNote, ambiguousPersonNote, incompleteNote, otherBotNames, overNote, findHandoffs, handoffSendResult, handoffNote, handoffText } from '../src/bot/bot-handoff';
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
    expect(find(text)).toEqual({ handoffs: [h(id, name, sentence)], ambiguous: [], ambiguousPeople: [], over: [], unverified: [] });
  });

  it.each(['@Vonvon Bot 80 请审', '@VonvonBot8', '@Jojo.Wang', '@Jojo_w', '@Jojo-1', '@Jojo/x', 'a@小审', '1@小审', '@小P 我自己', '@真人', '@所有人'])('ignores %s', (text) => {
    expect(find(text)).toEqual({ handoffs: [], ambiguous: [], ambiguousPeople: [], over: [], unverified: [] });
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
    expect(find(text)).toEqual({ handoffs: [h(id, name, sentence)], ambiguous: [], ambiguousPeople: [], over: [], unverified: [] });
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
    expect(find('@小审 看看', roster)).toEqual({ handoffs: [], ambiguous: ['小审'], ambiguousPeople: [], over: [], unverified: [] });
    expect(find('@小审2 看', roster).handoffs).toEqual([h('ou_审2', '小审2', '看')]);
    expect(find('@小审 @小码 看', roster)).toEqual({ handoffs: [h('ou_码', '小码', '看')], ambiguous: ['小审'], ambiguousPeople: [], over: [], unverified: [] });
    expect(find('@小审 看。@小审 再看', roster).ambiguous).toEqual(['小审']);
  });
  it('treats names colliding after bracket removal as ambiguous', () => {
    expect(find('@小审1 看', more(['ou_x', '小审(1)'], ['ou_y', '小审1']))).toEqual({ handoffs: [], ambiguous: ['小审1'], ambiguousPeople: [], over: [], unverified: [] });
  });
  it('compares duplicate ASCII names without case sensitivity', () => {
    const found = find('@Vonvon Bot 看', more(['ou_v1', 'Vonvon Bot'], ['ou_v2', 'vonvon bot']));
    expect(found).toEqual({ handoffs: [], ambiguous: ['Vonvon Bot'], ambiguousPeople: [], over: [], unverified: [] });
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
    expect(handoffNote([{ name: '小审' }, { name: '小码' }], 'failed')).toBe('→ 想 @ 小审（bot）、小码（bot），没发出：发送失败');
  });
  it('states uncertainty after timeout and removes name markup', () => {
    expect(handoffNote([{ name: '<小审>' }], 'timeout')).toBe('→ 想 @ 小审（bot），没收到发送结果：超时，可能已发出');
  });
  it('explains ambiguity without ids', () => {
    expect(ambiguousNote('<小审>')).toBe('→ 想 @ 小审（bot），没交接：群里不止一个叫 小审 的 bot');
  });
});

describe('handoff business results', () => {
  it('only treats a valid zero code as success and an explicit rejection as failed', () => {
    expect(handoffSendResult({ code: 0 })).toEqual({ kind: 'sent' });
    expect(handoffSendResult({ code: 230001 })).toEqual({ kind: 'failed', code: 230001 });
  });
  it.each([undefined, null, {}, { code: '0' }, { code: NaN }, { code: Infinity }])('keeps invalid responses unknown: %j', value => {
    expect(handoffSendResult(value)).toEqual({ kind: 'unknown' });
  });
  it('does not call a non-timeout uncertainty a timeout', () => {
    expect(handoffNote([{ name: '小审' }], 'unknown')).toBe('→ 想 @ 小审（bot），没收到发送结果：可能已发出');
  });
});

const people = ['张三', '张三丰', '李四', '王五', '赵六', '钱七', '孙八', '周九'].map(name => ({ openId: `ou_${name}`, name }));
const withPeople = (text: string, members = people, roster = bots, complete = true) => findHandoffs(text, roster, me, members, complete);

describe('people handoffs and safety brakes', () => {
  it('matches people, longest names, and mixed recipients in occurrence order', () => {
    expect(withPeople('做好了。@张三 请看。').handoffs).toEqual([{ ...h('ou_张三', '张三', '请看。'), person: true }]);
    expect(withPeople('@张三丰 你看').handoffs[0]?.openId).toBe('ou_张三丰');
    expect(withPeople('@张三 和张三丰').handoffs.map(x => x.openId)).toEqual(['ou_张三']);
    expect(handoffText(withPeople('@小审 @张三 一起看看').handoffs)).toBe('<at user_id="ou_审">小审</at> <at user_id="ou_张三">张三</at> 一起看看');
    expect(find('@张三').handoffs).toEqual([]);
  });
  it('accepts only known tagged people and neutralizes unknown tags', () => {
    expect(withPeople('<at user_id="ou_张三">张三</at> 请看').handoffs[0]?.person).toBe(true);
    expect(withPeople('<at id="ou_x">某人</at> 请看').handoffs).toEqual([]);
    const found = withPeople('@张三 和 <at id="ou_x">某人</at> 看');
    expect(found.handoffs[0]?.sentence).toBe('和 @某人 看');
    expect(handoffText(found.handoffs).match(/<at/g)).toHaveLength(1);
  });
  it.each(['所有人', 'all', 'All', 'everyone', '全体成员'])('never sends reserved mention %s', name => {
    const members = [...people, { openId: 'ou_reserved', name }, { openId: 'ou_prefix', name: '所有' }];
    expect(withPeople(`@${name} 看`, members, more(['ou_ball', 'all'])).handoffs).toEqual([]);
    expect(withPeople(`<at id="ou_reserved">${name}</at> 看`, members).handoffs).toEqual([]);
  });
  it('checks reserved prefixes before Chinese candidates but preserves ASCII boundaries', () => {
    const members = [...people, { openId: 'ou_prefix', name: '所有' }, { openId: 'ou_allen', name: 'allen' }];
    expect(withPeople('@所有人 开会', members).handoffs).toEqual([]);
    expect(withPeople('@所有 看', members).handoffs[0]?.openId).toBe('ou_prefix');
    expect(withPeople('@allen 看', members).handoffs[0]?.openId).toBe('ou_allen');
    const text = handoffText(withPeople('照抄：@所有人 明天开会 <at user_id="all">所有人</at>。@张三 请确认。').handoffs);
    expect(text.match(/<at/g)).toHaveLength(1);
    expect(text).not.toContain('user_id="all"');
    expect(withPeople('<at user_id="all">所有人</at> 散会').handoffs).toEqual([]);
  });
  it('skips quoted lines and code while accepting greater-than in prose', () => {
    expect(withPeople('> @张三 说要改\n\n@李四 请看').handoffs.map(x => x.name)).toEqual(['李四']);
    expect(withPeople('  > <at user_id="ou_张三">张三</at>').handoffs).toEqual([]);
    expect(withPeople('a > @张三').handoffs.map(x => x.name)).toEqual(['张三']);
    expect(withPeople('`@张三`\n```\n<at id="ou_李四"/>\n```').handoffs).toEqual([]);
  });
  it('caps distinct mixed recipients at five and removes overflow mentions from sentences', () => {
    const found = withPeople('@张三 @李四 @王五 @赵六 @钱七 @孙八 @周九 一起看');
    expect(found.handoffs.map(x => x.name)).toEqual(['张三', '李四', '王五', '赵六', '钱七']);
    expect(found.handoffs.every(x => x.sentence === '一起看')).toBe(true);
    expect(found.over).toEqual([{ name: '孙八', person: true }, { name: '周九', person: true }]);
    expect(overNote(found.over)).toBe('→ 还想 @ 孙八、周九，没发：一条最多 @ 5 个');
    const mixed = withPeople('@小审 @张三 @李四 @王五 @赵六 @小码');
    expect(mixed.over).toEqual([{ name: '小码' }]);
    expect(overNote(mixed.over)).toContain('小码（bot）');
    expect(withPeople('@张三 '.repeat(7)).over).toEqual([]);
    expect(withPeople('@张三 '.repeat(7)).handoffs).toHaveLength(1);
  });
  it('reports people collisions separately and does not consume mention capacity', () => {
    const members = [...people, { openId: 'ou_other', name: '张三' }];
    const found = withPeople('@张三 @李四 @王五 @赵六 @钱七 @孙八', members);
    expect(found.ambiguousPeople).toEqual(['张三']);
    expect(found.ambiguous).toEqual([]);
    expect(found.handoffs).toHaveLength(5);
    expect(found.over).toEqual([]);
    expect(withPeople('@张三 看', members).handoffs).toEqual([]);
    const collision = withPeople('@小审 看', [...people, { openId: 'ou_person', name: '小审' }]);
    expect(collision.ambiguousPeople).toEqual(['小审']);
    expect(collision.ambiguous).toEqual([]);
    expect(collision.handoffs).toEqual([]);
    expect(withPeople('@小P 看', [{ openId: 'ou_person', name: '小P' }]).handoffs[0]?.person).toBe(true);
  });
  it.each(['all', 'cli_x', 'ou_a"b', "ou_a'b", 'ou_a b', 'ou_a<b', 'ou_a>b', 'ou_a&b'])('rejects unsafe candidate id %s', id => {
    expect(withPeople('@坏人 <at id="'+id+'">坏人</at>', [{ openId: id, name: '坏人' }], more([id, '坏人'])).handoffs).toEqual([]);
  });
  it('withholds all recipients on an incomplete people list without losing known ambiguity', () => {
    const found = withPeople('@小审 @张三 一起看', people.filter(p => p.name === '张三'), bots, false);
    expect(found.handoffs).toEqual([]);
    expect(found.over).toEqual([]);
    expect(found.unverified).toEqual([{ name: '小审' }, { name: '张三', person: true }]);
    expect(incompleteNote(found.unverified)).toBe('→ 想 @ 小审（bot）、张三，没发：群成员名单没读全，认不准有没有重名');
    expect(withPeople('@王五 看', people.filter(p => p.name === '张三'), bots, false).unverified).toEqual([]);
    const ambiguous = withPeople('@小审', [], more(['ou_duplicate', '小审']), false);
    expect(ambiguous.ambiguous).toEqual(['小审']);
    expect(ambiguous.unverified).toEqual([]);
    expect(withPeople('@小审 @张三 一起看').handoffs).toHaveLength(2);
  });
  it('formats people and bot footnotes without leaking markup or ids', () => {
    expect(handoffNote([{ name: '张三', person: true }, { name: '小审' }], 'failed')).toBe('→ 想 @ 张三、小审（bot），没发出：发送失败');
    expect(ambiguousPersonNote('<张三>')).toBe('→ 想 @ 张三，没发：群里不止一个叫 张三 的成员');
  });
});

describe('otherBotNames', () => {
  it('preserves roster order, excludes self by either identity and tolerates no roster', () => {
    expect(otherBotNames(bots, me)).toEqual(['小审', '小审2', 'Vonvon Bot 8', '小码', 'Jojo']);
    expect(otherBotNames(bots, { appId: 'cli_me' })).toEqual(otherBotNames(bots, me));
    expect(otherBotNames(undefined, me)).toEqual([]);
  });
  it('omits duplicate, empty, and reserved names and caps at twenty', () => {
    const names = otherBotNames(more(['ou_duplicate', '小审'], ['ou_v1', 'Vonvon Bot'], ['ou_v2', 'vonvon bot'], ['ou_all', 'all'], ['ou_empty', '()']), me);
    expect(names).toEqual(['小审2', 'Vonvon Bot 8', '小码', 'Jojo']);
    const roster = new Map(Array.from({ length: 25 }, (_, n) => [`ou_${n}`, { appId: `cli_${n}`, name: `bot${n}` }]));
    expect(otherBotNames(roster, me)).toEqual(Array.from({ length: 20 }, (_, n) => `bot${n}`));
  });
});
