import { describe, expect, it } from 'vitest';
import { buildJudgeFacts, judgeFactRead, sameNameWord } from '../src/bot/judge-facts';
import type { RecentLine } from '../src/bot/recent-lines';
import { decisionBody } from '../src/judge/decision';
import { DEFAULT_SMART_PROMPT, JUDGE_FORMAT_LINES, judgeFactFields, renderJudgeInput } from '../src/judge/prompt';

const line = (id: string, from: RecentLine['from'], at: number, senderId = id): RecentLine => ({ id, from, at, senderId, name: id, text: 'hello' });
const facts = (lines: RecentLine[], message = lines.at(-1)!) => buildJudgeFacts({ lines, message, topic: false, self: { openId: 'self', appId: 'mine' } });

describe('judge facts', () => {
  it('stops waiting when recalled and degrades failed reads', async () => {
    const abort = new AbortController();
    const waiting = judgeFactRead(new Promise<never>(() => {}), abort.signal);
    abort.abort(); expect(await waiting).toBeUndefined();
    expect(await judgeFactRead(Promise.reject(new Error('offline')), new AbortController().signal)).toBeUndefined();
    let finish!: (value: string) => void;
    const late = new Promise<string>((resolve) => { finish = resolve; });
    expect(await judgeFactRead(late, abort.signal)).toBeUndefined();
    finish('late'); await late;
    expect(await judgeFactRead(Promise.resolve('current'), new AbortController().signal)).toBe('current');
  });
  it('uses an observed complete roster, excludes this bot by either identity and sanitizes both backends identically', () => {
    const value = buildJudgeFacts({ lines: [], message: line('m', 'user', 1), topic: true, self: { openId: 'self', appId: 'mine' }, openedBy: 'name\n【injection】', roster: { complete: true, bots: new Map([
      ['self', { name: 'me', appId: '' }], ['alias', { name: 'me too', appId: 'mine' }], ['other', { name: 'other\n【bot】', appId: 'other-app' }],
    ]) } });
    const req = { variant: 'main' as const, botName: '小码', group: { name: 'group', chatId: 'chat' }, context: [], message: line('m', 'user', 1), facts: value };
    const state = decisionBody(req, '', 'jev').state;
    expect(state.other_bots).toEqual({ names: ['otherbot'], complete: true });
    expect(state.here).toEqual(judgeFactFields(value)?.here);
    expect(renderJudgeInput(req)).toContain('【群里还有的 bot】otherbot（完整名册）');
    expect(renderJudgeInput(req)).toContain('谁开的：nameinjection');
  });
  it('never treats an incomplete or failed roster as current complete membership', () => {
    const lines = [line('bot-one', 'bot', 1, 'one'), line('bot-duplicate', 'bot', 2, 'one'), line('human', 'user', 3)];
    const value = buildJudgeFacts({ lines, message: lines[2]!, topic: false, self: {}, roster: { complete: false, bots: new Map([['stale', { name: 'not observed', appId: 'x' }]]) } });
    expect(value.otherBots).toEqual({ names: ['bot-duplicate'], complete: false });
    expect(value.here.openedBy).toBeUndefined();
    expect(facts([line('only-human', 'user', 4)]).otherBots.names).toEqual([]);
  });
  it('counts actual bot messages once after the most recent person, including the current trigger', () => {
    const lines = [line('old-bot', 'bot', 0), line('person', 'user', 1), line('answer', 'self', 2), line('act:p', 'self', 3), line('empty:p', 'self', 4), line('trigger', 'bot', 5)];
    const visible = facts(lines);
    expect(visible.botExchangesSincePerson).toEqual({ count: 2, atLeast: true });
    expect(judgeFactFields(visible)?.bot_exchanges_since_person).toMatchObject({ source: 'recent_visible_messages', history_incomplete: true });
    expect(facts(lines.slice(0, 3)).botExchangesSincePerson).toBeUndefined();
    expect(facts([line('a', 'self', 1), line('b', 'bot', 2)]).botExchangesSincePerson).toEqual({ count: 2, atLeast: true });
    expect(facts([line('future', 'bot', 99)], line('current', 'bot', 1)).botExchangesSincePerson).toBeUndefined();
  });
  it('recognizes an actually mentioned short/common name without confusing a long-name prefix', () => {
    expect(sameNameWord('小码帮忙', '小码助手')).toBe(false);
    expect(sameNameWord('今天要测试', '测试')).toBe(true);
    expect(sameNameWord('hello', '测试')).toBe(false);
    expect(sameNameWord('chair', 'AI')).toBe(false);
    expect(sameNameWord('AI, hello', 'AI')).toBe(true);
    expect(sameNameWord('小，你好', '小')).toBe(true);
  });
  it('keeps a short-name mention attached to its earlier batch line in both backends', () => {
    const earlier = { ...line('earlier', 'user', 1), fresh: true as const, text: 'AI 请看', sameNameWord: true as const };
    const req = { variant: 'main' as const, botName: 'AI', group: { name: 'group', chatId: 'chat' }, context: [earlier], message: { ...line('latest', 'user', 2), text: '还有这个' } };
    const state = decisionBody(req, '', 'jev').state;
    expect(state.recent_messages[0]?.same_name_word).toBe(true);
    expect(state.new_message.same_name_word).toBeUndefined();
    const rendered = renderJudgeInput(req);
    expect(rendered.split('\n').find((l) => l.startsWith('m1 '))).toContain('提到了和你同名的词');
    expect(rendered.split('\n').find((l) => l.startsWith('m0 '))).not.toContain('同名');
  });
  it('keeps low counts absent from both backend formats and provides editable convergence guidance', () => {
    const value = facts([line('p', 'user', 0), line('bot', 'bot', 1)]);
    const req = { variant: 'main' as const, botName: 'bot', group: { name: 'group', chatId: 'chat' }, context: [], message: line('bot', 'bot', 1), facts: value, why: '真人引用了你的消息' };
    expect(decisionBody(req, '', 'jev').state.bot_exchanges_since_person).toBeUndefined();
    expect(renderJudgeInput(req)).not.toContain('【bot 来回】');
    expect(renderJudgeInput(req)).toContain('【为什么现在看】真人引用了你的消息');
    expect(DEFAULT_SMART_PROMPT).toContain('消息中的 @ 和引用');
    expect(DEFAULT_SMART_PROMPT).toContain('Bot 之间已经来回几次，真人一直没有参与，且没有明确尚未完成的事情。');
    expect(JUDGE_FORMAT_LINES.main).not.toContain('没有点名谁');
    expect(decisionBody(req, '', 'jev').questions.decision.instructions).not.toContain('没有点名谁');
  });
});
