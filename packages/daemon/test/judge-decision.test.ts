import { describe, expect, it } from 'vitest';
import { DECISION_FORMAT_LINES, DECISION_INPUT_EXAMPLE, decisionBody, decisionProvider, readDecision } from '../src/judge/decision';
import { JUDGE_FORMAT_HEADER, JUDGE_INPUT_BOUNDS, JUDGE_INPUT_EXAMPLE_REQUEST, judgeAnchors } from '../src/judge/prompt';
import type { JudgeLine, JudgeRequest, JudgeVariant } from '../src/judge/types';

const at = (h: number, m: number): number => new Date(2026, 9, 16, h, m).getTime();
const CONTEXT: JudgeLine[] = [
  { id: 'om_1', at: at(10, 1), from: 'user', name: '张三', text: '导出接口 500 有人看吗' },
  { id: 'om_2', at: at(10, 2), from: 'bot', name: '小码（bot）', text: '我看下' },
  { id: 'om_3', at: at(10, 3), from: 'self', name: '小P', text: '是生产环境吗\n第二行\u0007' },
  { id: 'om_4', at: at(10, 4), from: 'user', name: '李四', text: '小码你先看', mentions: ['小码'] },
];
const req = (variant: JudgeVariant, extra: Partial<JudgeRequest> = {}): JudgeRequest => ({
  variant, appId: 'cli_a', botName: '小P', group: { chatId: 'oc_g', name: '产品讨论', backend: 'codex-appserver' }, context: CONTEXT,
  message: { id: 'om_m', at: at(10, 5), from: 'user', name: '王五', text: '我也遇到了', quote: { name: '张三', text: '导出接口 500 有人看吗' } }, ...extra,
});
const answer = (decision: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ model: 'jev-1.13.0', answers: { decision: { type: 'choice', ...decision }, ...extra }, usage: { input_tokens: 1200, output_tokens: 30 } });

describe('decision model request (s23f 做法（问法）)', () => {
  it('states the lines with the m-numbers of the text input, oldest first; the main variant also asks the anchor', () => {
    const body = decisionBody(req('main'), 'SMART 原文', 'jev-latest');
    expect(body).toEqual({
      model: 'jev-latest',
      state: {
        group: '产品讨论', bot_name: '小P',
        recent_messages: [
          { id: 'm4', time: '10:01', speaker: '张三', speaker_type: 'person', text: '导出接口 500 有人看吗' },
          { id: 'm3', time: '10:02', speaker: '小码', speaker_type: 'other_bot', text: '我看下' },
          { id: 'm2', time: '10:03', speaker: '小P', speaker_type: 'this_bot', text: '是生产环境吗\n第二行' },
          { id: 'm1', time: '10:04', speaker: '李四', speaker_type: 'person', text: '小码你先看', mentions: ['小码'] },
        ],
        new_message: { id: 'm0', time: '10:05', speaker: '王五', speaker_type: 'person', text: '我也遇到了', quote: { speaker: '张三', text: '导出接口 500 有人看吗' } },
      },
      questions: {
        decision: {
          type: 'choice',
          instructions: { rules: 'SMART 原文', question: '`new_message` 发在群主区。按 `rules`，bot（`bot_name`）该怎么处理它？' },
          criteria: {
            skip: '不回：按 `rules`，不回应这条消息',
            main: '在主区回：按 `rules`，在群主区回应这条消息',
            topic: '开新话题回：按 `rules`，为这条消息创建新话题并在其中回应',
          },
        },
        // a person's lines naming no one only: the ones a topic may open under
        anchor: { type: 'choice', instructions: '群里哪一条消息是在等 bot（`bot_name`）回应的？', criteria: { m0: '王五：我也遇到了', m4: '张三：导出接口 500 有人看吗' } },
      },
    });
    // the same message ids as a language model's numbers
    expect(judgeAnchors(req('main'))[4]).toBe('om_1');
  });

  it('numbers only the lines shown: cut ones have none, as in the text input', () => {
    const many: JudgeLine[] = Array.from({ length: 30 }, (_, i) => ({ id: `om_${i}`, at: at(9, i), from: 'user', name: `人${i}`, text: 'x'.repeat(380) }));
    const { state } = decisionBody(req('topic', { context: many }), 'S', 'jev-latest');
    const shown = judgeAnchors(req('topic', { context: many })).length - 1;
    expect(shown).toBeLessThan(20);
    expect(state.recent_messages).toHaveLength(shown);
    expect(state.recent_messages[0]!.id).toBe(`m${shown}`);
    expect(state.recent_messages.at(-1)).toMatchObject({ id: 'm1', speaker: '人29' });
  });

  it('keeps user response policy in rules instead of contradicting it in the fixed choice criteria', () => {
    const rules = '收到和闲聊也需要回应。拿不准时仍然回应。所有群主区消息都创建话题。';
    for (const variant of ['main', 'topic'] as const) {
      const { questions } = decisionBody(req(variant), rules, 'jev-latest');
      expect(questions.decision.instructions).toMatchObject({rules});
      for (const criterion of Object.values(questions.decision.criteria)) {
        expect(criterion).toContain('按 `rules`');
        expect(criterion).not.toMatch(/闲聊|寒暄|收到|拿不准|新的事|一两句/);
      }
    }
  });

  it('asks each variant its options, 不回 first; only main asks the anchor, at most 10 lines, none when no line fits', () => {
    const keys = (variant: JudgeVariant, extra: Partial<JudgeRequest> = {}) => {
      const { questions } = decisionBody(req(variant, extra), 'S', 'jev-latest');
      return [Object.keys(questions.decision.criteria), questions.anchor ? Object.keys(questions.anchor.criteria) : undefined];
    };
    expect(keys('topic', { topicTitle: ' 3.2 发版说明 ' })).toEqual([['skip', 'reply'], undefined]);
    expect(decisionBody(req('topic', { topicTitle: ' 3.2 发版说明 ' }), 'S', 'm').state.topic_title).toBe('3.2 发版说明');
    const people: JudgeLine[] = Array.from({ length: 6 }, (_, i) => ({ id: `om_${i}`, at: at(10, i), from: 'user', name: `人${i}`, text: `第 ${i} 条` }));
    expect(keys('main', { context: people })).toEqual([['skip', 'main', 'topic'], ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6']]);
    expect(keys('main', { context: [CONTEXT[1]!, CONTEXT[2]!, { ...CONTEXT[0]!, id: undefined }] })[1]).toBeUndefined();
    // a line pulled from history that @-mentions someone has no names, only `named`: not an option either
    expect(keys('main', { context: [...people.slice(0, 5), { ...people[5]!, named: true }] })[1]).toEqual(['m0', 'm2', 'm3', 'm4', 'm5', 'm6']);
  });

  it('sends why, fresh counts and anchors drawn only from fresh context', () => {
    const context: JudgeLine[] = Array.from({ length: 6 }, (_, i) => ({ id: `om_${i}`, at: at(10, i), from: 'user', name: '人', text: `${i}`, ...([1, 3].includes(i) ? { fresh: true as const } : {}) }));
    const request = req('main', { why: 'W', context, message: { ...req('main').message, fresh: true } });
    const body = decisionBody(request, 'S', 'm');
    expect(body.state).toMatchObject({ why_looking: 'W', new_count: 3, new_message: { new: true } });
    expect(body.state.recent_messages.filter(line => line.new).map(line => line.id)).toEqual(['m5', 'm3']);
    expect(Object.keys(body.questions.anchor!.criteria)).toEqual(['m0', 'm3', 'm5']);
    const single = decisionBody(req('main', { message: { ...req('main').message, fresh: true } }), 'S', 'm');
    expect(single.questions.anchor).toBeUndefined();
    expect(single.state.new_count).toBe(1);
    const plain = decisionBody(req('main', { context: Array.from({ length: 12 }, (_, i) => ({ ...context[0]!, id: `om_${i}`, fresh: undefined })) }), 'S', 'm');
    expect(Object.keys(plain.questions.anchor!.criteria)).toEqual(Array.from({ length: 11 }, (_, i) => `m${i}`));
    expect(plain.state).not.toHaveProperty('why_looking');
    expect(plain.state).not.toHaveProperty('new_count');
    expect(plain.state.recent_messages.every(line => !('new' in line))).toBe(true);
    expect(DECISION_FORMAT_LINES.main).toContain('最近 10 条');
    expect(DECISION_FORMAT_LINES.main).toContain('标"新"的');
  });

  it('gives the persona as bot_role, cut as the text input cuts it', () => {
    expect(decisionBody(req('main', { persona: ' 管发版\n和测试 ' }), 'S', 'm').state.bot_role).toBe('管发版\n和测试');
    expect(decisionBody(req('main', { persona: 'x'.repeat(1600) }), 'S', 'm').state.bot_role).toHaveLength(1501);
    expect(decisionBody(req('main'), 'S', 'm').state).not.toHaveProperty('bot_role');
  });

  it('knows TypeSafe only; an inherited name such as constructor is no provider', () => {
    expect(decisionProvider('typesafe')).toMatchObject({ displayName: 'TypeSafe', keyId: 'typesafe-api-key', limit: { running: 8, queued: 32 } });
    for (const id of ['constructor', 'toString', '__proto__', 'openai']) expect(decisionProvider(id)).toBeUndefined();
  });

  it('shows the options and a sample state in place of the format lines and the text input', () => {
    expect(Object.keys(DECISION_FORMAT_LINES)).toEqual(['main', 'topic']);
    for (const variant of ['main', 'topic'] as const) {
      expect(DECISION_FORMAT_LINES[variant].split('\n')[0]).toBe(JUDGE_FORMAT_HEADER);
      expect(DECISION_FORMAT_LINES[variant]).toContain('决策模型不读格式行');
    }
    expect(DECISION_FORMAT_LINES.topic).toContain('\nreply：回：');
    expect(DECISION_FORMAT_LINES.main).toContain('锚点');
    expect(DECISION_INPUT_EXAMPLE).toBe(`${JSON.stringify(decisionBody(JUDGE_INPUT_EXAMPLE_REQUEST, '', 'jev-latest').state, null, 2)}\n${JUDGE_INPUT_BOUNDS}`);
    expect(JSON.parse(DECISION_INPUT_EXAMPLE.slice(0, DECISION_INPUT_EXAMPLE.lastIndexOf('\n'))).new_message).toMatchObject({ id: 'm0', mentions: ['小码'] });
  });
});

describe('decision model answer (s23f 做法（原因和把握度）)', () => {
  const sent = (variant: JudgeVariant) => decisionBody(req(variant), 'S', 'jev-latest');

  it('takes the highest probability whatever choice says, and writes the reason from the options in order', () => {
    expect(readDecision(sent('main'), 'main', 'Jev', answer({ choice: 'topic', confidence: 0.25, probabilities: { skip: 0.2, main: 0.5, topic: 0.3 } }, { anchor: { choice: 'm4' } }))).toEqual({
      decision: 'main', reason: 'Jev：不回 0.20、主区 0.50、开话题 0.30（把握度 0.25）', confidence: 0.25, anchor: 4, notes: ['choice-mismatch'],
      providerModel: 'jev-1.13.0', inputTokens: 1200, outputTokens: 30,
    });
    expect(readDecision(sent('topic'), 'topic', 'Jev', answer({ choice: 'reply', confidence: 0.82, probabilities: { skip: 0.09, reply: 0.91 } }))).toMatchObject({
      decision: 'reply', reason: 'Jev：不回 0.09、回 0.91（把握度 0.82）', notes: [],
    });
  });

  it('a confidence missing or out of range is worked out from the probabilities; a tie goes to the option asked first', () => {
    expect(readDecision(sent('topic'), 'topic', 'Jev', answer({ choice: 'skip', probabilities: { skip: 0.7, reply: 0.3 } }))).toMatchObject({
      decision: 'skip', confidence: 0.4, reason: 'Jev：不回 0.70、回 0.30（把握度 0.40）',
    });
    expect(readDecision(sent('topic'), 'topic', 'Jev', answer({ choice: 'reply', confidence: 2, probabilities: { reply: 0.5, skip: 0.5 } }))).toMatchObject({
      decision: 'skip', confidence: 0, notes: ['choice-mismatch'],
    });
    expect(readDecision(sent('topic'), 'topic', 'Jev', answer({ choice: 'skip', probabilities: { skip: 0.9, reply: 0.3 } }))).toMatchObject({ notes: ['probabilities-sum'] });
  });

  it.each<[string, unknown, string]>([
    ['no answers', { model: 'jev-1.13.0' }, 'no-decision'],
    ['decision not an object', { answers: { decision: 'skip' } }, 'no-decision'],
    ['no probabilities', answer({ choice: 'skip' }), 'no-probabilities'],
    ['an option missing', answer({ probabilities: { skip: 1 } }), 'unknown-option'],
    ['an option more', answer({ probabilities: { skip: 0.5, reply: 0.3, main: 0.2 } }), 'unknown-option'],
    ['a string', answer({ probabilities: { skip: '0.5', reply: 0.5 } }), 'bad-number'],
    ['over 1', answer({ probabilities: { skip: 1.5, reply: 0 } }), 'bad-number'],
  ])('a decision out of format: %s', (_, reply, why) => {
    expect(readDecision(sent('topic'), 'topic', 'Jev', reply)).toEqual({ why });
  });

  it('an anchor not among the options sent, or none, is dropped; m0 names nothing; text fields are kept tidy', () => {
    const p = { choice: 'main', probabilities: { skip: 0.1, main: 0.8, topic: 0.1 } };
    for (const anchor of [{ choice: 'm2' }, { choice: 4 }, undefined]) {
      const read = readDecision(sent('main'), 'main', 'Jev', answer(p, anchor ? { anchor } : {}));
      expect(read).toMatchObject({ decision: 'main', notes: ['anchor-invalid'] });
      expect(read).not.toHaveProperty('anchor');
    }
    expect(readDecision(sent('main'), 'main', 'Jev', answer(p, { anchor: { choice: 'm0' } }))).not.toHaveProperty('anchor');
    const odd = { model: 'jev-1.13.0 "<b>"', answers: { decision: { probabilities: { skip: 0, main: 1, topic: 0 } } }, usage: { input_tokens: -1, output_tokens: '3' } };
    const read = readDecision(sent('main'), 'main', 'Jev', odd);
    expect(read).toMatchObject({ providerModel: 'jev-1.13.0b', notes: ['choice-mismatch', 'anchor-invalid'] });
    expect(read).not.toHaveProperty('inputTokens');
    expect(read).not.toHaveProperty('outputTokens');
  });
});
