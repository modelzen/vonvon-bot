import { describe, expect, it } from 'vitest';
import { parseAskRequest, type AgentEvent, type AskAnswer, type AskRequest } from '../src/agent/types';
import { ASK_CONTROLS_EID, buildAskCard, parseAskSubmission, type AskCardState } from '../src/card/ask-card';
import { RunRender } from '../src/card/run-render';
import { initialState, reduce } from '../src/card/run-state';

const base = { id: 'ask-1', title: '需要你决定', acceptedConsequence: '继续当前操作', declinedConsequence: '暂停并等你说明' };
const choices = parseAskRequest({
  ...base, kind: 'choices', questions: [
    { id: '__proto__', title: '选一个', detail: '单选说明', selection: 'single', options: [
      { id: 'a', label: '方案 A', description: 'A 的说明' }, { id: 'b', label: '方案 B', description: '' },
    ] },
    { id: 'other', title: '选多个', detail: '多选说明', selection: 'multiple', options: [
      { id: 'x', label: '选项 X', description: '' }, { id: 'y', label: '选项 Y', description: 'Y 的说明' },
    ] },
  ],
});
const confirmation = parseAskRequest({ ...base, kind: 'confirmation', detail: '删除生成目录？' });
const permission = parseAskRequest({ ...base, kind: 'permission', permissionMode: 'full', detail: '运行这个命令？' });
const value = { a: 'ask_submit', requestId: base.id, decision: 'submit' };
const validForm = { q0: 'a', q1: ['x', 'y'] };
const answer: AskAnswer = { kind: 'choices', answers: [{ questionId: '__proto__', selected: ['a'] }, { questionId: 'other', selected: ['x', 'y'] }] };
const submit = (formValue: unknown, callback: unknown = value, request = choices) => parseAskSubmission({ request, value: callback, formValue });

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || typeof value !== 'object') return [];
  return [{ ...value }, ...Object.values(value).flatMap(nodes)];
}

function render(request: AskRequest, state: AskCardState = { kind: 'pending' }) {
  return JSON.parse(JSON.stringify(buildAskCard({ request, state, respondents: [{ openId: 'u1', name: '张三' }, { openId: 'u2', name: '李四' }] })));
}

describe('provider request boundary', () => {
  it.each([choices, confirmation, permission])('round trips $kind requests', request => {
    expect(parseAskRequest(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it.each([
    { ...base, kind: 'choices', questions: [] },
    { ...confirmation, id: '' },
    { ...confirmation, acceptedConsequence: ' ' },
    { ...confirmation, declinedConsequence: '' },
    { ...permission, permissionMode: 'write' },
    { ...confirmation, kind: 'unknown' },
    { ...confirmation, extra: true },
  ])('rejects malformed known requests %#', request => {
    expect(() => parseAskRequest(request)).toThrow();
  });

  it('rejects duplicate question and option ids, and empty options', () => {
    if (choices.kind !== 'choices') throw new Error('fixture');
    const first = choices.questions[0];
    if (first.selection === 'text') throw new Error('fixture');
    for (const questions of [
      [first, first],
      [{ ...first, options: [] }],
      [{ ...first, options: [first.options[0], first.options[0]] }],
    ]) expect(() => parseAskRequest({ ...choices, questions })).toThrow();
  });
});

describe('schema 2.0 presentation', () => {
  it.each([choices, confirmation, permission])('renders consequences and respondents for $kind', request => {
    const card = render(request);
    expect(card.schema).toBe('2.0');
    expect(card.body.elements.length).toBeGreaterThan(0);
    const json = JSON.stringify(card);
    for (const text of [request.title, request.acceptedConsequence, request.declinedConsequence, '张三', '李四']) expect(json).toContain(text);
    expect(card.config.enable_forward).toBe(false);
  });

  it('renders independent single and multiple selectors with structural names', () => {
    const card = render(choices);
    const all = nodes(card);
    expect(all.filter(node => node.tag === 'select_static').map(node => node.name)).toEqual(['q0']);
    expect(all.filter(node => node.tag === 'multi_select_static').map(node => node.name)).toEqual(['q1']);
    expect(all.find(node => node.tag === 'select_static')?.width).toBe('fill');
    expect(all.find(node => node.tag === 'multi_select_static')?.width).toBe('fill');
    expect(all.filter(node => node.type === 'callback').map(node => node.value)).toEqual([value]);
    expect(all.find(node => node.tag === 'button')?.form_action_type).toBe('submit');
    // Multi-question choices cards group each question with its own controls inside the form separated by dividers.
    const formEl = all.find(node => node.tag === 'form');
    const formChildren = Array.isArray(formEl?.elements) ? formEl.elements as Record<string, unknown>[] : [];
    const q0HeadingIdx = formChildren.findIndex(el => el.tag === 'markdown' && String(el.content).includes('1. 选一个'));
    const q0SelectIdx = formChildren.findIndex(el => el.name === 'q0');
    const q1HeadingIdx = formChildren.findIndex(el => el.tag === 'markdown' && String(el.content).includes('2. 选多个'));
    const q1SelectIdx = formChildren.findIndex(el => el.name === 'q1');
    expect(q0HeadingIdx).toBeGreaterThanOrEqual(0);
    expect(q0SelectIdx).toBeGreaterThan(q0HeadingIdx);
    expect(q1HeadingIdx).toBeGreaterThan(q0SelectIdx);
    expect(q1SelectIdx).toBeGreaterThan(q1HeadingIdx);
  });

  it.each([
    [confirmation, ['按这个方案做', '不行，我来说']],
    [permission, ['允许这一次', '拒绝']],
  ] as const)('renders decision buttons for $0.kind', (request, labels) => {
    const buttons = nodes(render(request)).filter(node => node.tag === 'button');
    expect(buttons.map(node => node.text)).toEqual(labels.map(content => ({ tag: 'plain_text', content })));
    for (const callback of nodes(buttons).filter(node => node.type === 'callback')) {
      expect(parseAskSubmission({ request, value: callback.value, formValue: undefined }).ok).toBe(true);
    }
  });

  it.each<AskCardState>([
    { kind: 'answered', answer, actor: '张三', at: '2026-10-17T00:00:00Z' },
    { kind: 'timed-out' }, { kind: 'stopped' }, { kind: 'expired', reason: 'restart' },
  ])('strips every interactive element in terminal $kind', state => {
    const card = render(choices, state);
    expect(nodes(card).filter(node => ['form', 'input', 'select_static', 'multi_select_static', 'button'].includes(String(node.tag)) || node.type === 'callback')).toEqual([]);
    if (state.kind === 'answered') {
      expect(JSON.stringify(card)).toContain(state.at);
      expect(JSON.stringify(card)).toContain('方案 A');
      expect(JSON.stringify(card)).toContain('选项 X、选项 Y');
    }
  });

  it.each([choices, confirmation, permission])('renders expired lifecycle text for $kind without controls', request => {
    for (const [state, text] of [
      [{ kind: 'timed-out' }, '⏱ 15 分钟没人回答'],
      [{ kind: 'stopped' }, '⏹ 已停止'],
      [{ kind: 'expired', reason: 'restart' }, '已失效（后台服务重启过）'],
    ] as const) {
      const card = render(request, state);
      expect(JSON.stringify(card)).toContain(text);
      expect(nodes(card).some(node => node.type === 'callback' || ['form', 'button', 'input', 'select_static', 'multi_select_static'].includes(String(node.tag)))).toBe(false);
    }
  });

  it.each([confirmation, permission])('has no interactive controls after $kind answered', request => {
    const completed: AskAnswer = request.kind === 'confirmation' ? { kind: 'confirmation', decision: 'explain' } : { kind: 'permission', decision: 'deny' };
    const card = render(request, { kind: 'answered', answer: completed, actor: '李四', at: 'now' });
    expect(nodes(card).some(node => node.tag === 'button' || node.type === 'callback')).toBe(false);
    expect(JSON.stringify(card)).toContain('李四 · now');
  });

  it('rejects terminal results from another request kind or containing fabricated choices', () => {
    const state = (answer: AskAnswer): AskCardState => ({ kind: 'answered', answer, actor: '张三', at: 'now' });
    expect(() => render(permission, state(answer))).toThrow('Answer does not match');
    expect(() => render(choices, state({ kind: 'permission', decision: 'deny' }))).toThrow('Answer does not match');
    expect(() => render(choices, state({ kind: 'choices', answers: [{ questionId: '__proto__', selected: ['made-up'] }, { questionId: 'other', selected: ['x'] }] }))).toThrow('Answer does not match');
    expect(() => render(choices, state({ kind: 'choices', answers: [{ questionId: '__proto__', selected: ['a', 'b'] }, { questionId: 'other', selected: ['x'] }] }))).toThrow('Answer does not match');
  });
});

describe('submission boundary', () => {
  it('returns domain ids for all questions without mutating input', () => {
    expect(submit(validForm)).toEqual({ ok: true, answer });
    expect(validForm).toEqual({ q0: 'a', q1: ['x', 'y'] });
  });

  it.each([undefined, {}, { q0: '' }, { q0: 'a' }, { q0: 'a', q1: [] }])('reports empty required answers %#', fields => {
    expect(submit(fields)).toEqual({ ok: false, reason: 'empty', message: '至少选一项' });
  });

  it.each([
    null, [], 'text', 12,
    { q0: ['a'], q1: ['x'] }, { q0: 'a', q1: 'x' },
    { q0: 'a', q1: ['x', 'x'] }, { q0: 'a', q1: ['foreign'] },
    { q0: 'foreign', q1: ['x'] }, { q0: 'a', q1: [1] },
    { ...validForm, q2: 'a' }, { ...validForm, other: ['x'] },
    JSON.parse('{"q0":"a","q1":["x"],"__proto__":"bad"}'),
  ])('rejects malformed or fabricated form content %#', fields => {
    expect(submit(fields)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it.each([null, {}, { ...value, a: 'other' }, { ...value, decision: 'deny' }, { ...value, injected: true }])('rejects malformed or incompatible callback %#', callback => {
    expect(submit(validForm, callback)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('distinguishes a callback for a different request', () => {
    expect(submit(validForm, { ...value, requestId: 'old-request' })).toMatchObject({ ok: false, reason: 'wrong-request' });
  });

  it.each([
    [confirmation, 'proceed'], [confirmation, 'explain'],
    [permission, 'allow-once'], [permission, 'deny'],
  ] as const)('accepts only matching $1 decision', (request, decision) => {
    expect(submit(undefined, { ...value, decision }, request)).toEqual({ ok: true, answer: { kind: request.kind, decision } });
    expect(submit({}, { ...value, decision }, request).ok).toBe(true);
    expect(submit({ q0: 'a' }, { ...value, decision }, request)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('rejects cross-kind decisions and malformed binary forms', () => {
    expect(submit(undefined, { ...value, decision: 'allow-once' }, confirmation)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(submit(undefined, { ...value, decision: 'proceed' }, permission)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(submit(null, { ...value, decision: 'deny' }, permission)).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('asks stay separate from streaming cards', () => {
  const event: AgentEvent = { type: 'ask', request: choices };
  it('leaves reducer running and terminal state identical', () => {
    expect(reduce(initialState, event)).toBe(initialState);
    const terminal = reduce(initialState, { type: 'done', turnId: 'turn' });
    expect(reduce(terminal, event)).toBe(terminal);
  });

  it('leaves RunRender state and frozen terminal clock unchanged', () => {
    const run = new RunRender();
    const running = run.snapshot();
    run.apply(event);
    expect(run.snapshot()).toBe(running);
    run.apply({ type: 'done', turnId: 'turn' });
    const terminal = run.snapshot();
    expect(terminal.completedAt).toEqual(expect.any(Number));
    run.apply(event);
    expect(run.snapshot()).toBe(terminal);
    expect(run.snapshot().completedAt).toBe(terminal.completedAt);
  });
});

it.each(['__proto__', 'constructor', 'prototype'])('rejects extra own callback key %s even beside managed metadata', key => {
  const request = { id: 'metadata', kind: 'confirmation', title: '确认', detail: '继续', acceptedConsequence: '继续', declinedConsequence: '停止' } satisfies AskRequest;
  const value: unknown = JSON.parse(`{"a":"ask_submit","requestId":"metadata","decision":"proceed","__r":"managed","${key}":"foreign"}`);
  expect(parseAskSubmission({ request, value, formValue: undefined }).ok).toBe(false);
});

describe('s33 typed questions and answers', () => {
  const textQuestion = { id: 'text', title: '路径', detail: '说明', selection: 'text' };
  const choiceQuestion = { id: 'pick', title: '方案', detail: '', selection: 'single', options: [{ id: 'a', label: 'A', description: '' }] };
  const request = (questions: unknown[]) => parseAskRequest({ ...base, kind: 'choices', questions });
  const finish = (request: AskRequest, answer: AskAnswer) => render(request, { kind: 'answered', answer, actor: '答题人', at: 'now' });
  const parse = (request: AskRequest, formValue: unknown) => parseAskSubmission({ request, value, formValue });

  it('accepts text without options and rejects mixed or incomplete schemas', () => {
    expect(request([textQuestion])).toMatchObject({ questions: [{ selection: 'text', sensitive: false }] });
    expect(request([choiceQuestion])).toMatchObject({ questions: [{ other: false }] });
    expect(() => request([{ ...textQuestion, options: choiceQuestion.options }])).toThrow();
    expect(() => request([{ ...choiceQuestion, options: undefined }])).toThrow();
  });

  it('renders optional other input and multiline text with stable controls', () => {
    expect(ASK_CONTROLS_EID).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,19}$/);
    const mixed = request([{ ...choiceQuestion, other: true }, textQuestion]);
    const all = nodes(render(mixed));
    expect(all.find(n => n.tag === 'select_static')?.name).toBe('q0');
    expect(all.filter(n => n.tag === 'input').map(n => n.name)).toEqual(['q0_other', 'q1']);
    expect(all.find(n => n.name === 'q1')).toMatchObject({ input_type: 'multiline_text', max_length: 1000 });
    expect(JSON.stringify(render(mixed))).toContain('提交选择');
    expect(JSON.stringify(render(request([textQuestion])))).toContain('提交回答');
    expect(nodes(render(request([choiceQuestion]))).some(n => n.name === 'q0_other')).toBe(false);
    for (const req of [mixed, confirmation, permission]) {
      expect(nodes(render(req)).filter(n => n.element_id === 'ask_controls')).toHaveLength(1);
      expect(nodes(render(req, { kind: 'stopped' })).some(n => n.element_id === 'ask_controls')).toBe(false);
    }
  });

  it('prefers other text, trims answers and validates text lengths and field names', () => {
    const other = request([{ ...choiceQuestion, other: true }]);
    expect(parse(other, { q0: 'a', q0_other: '  ' })).toMatchObject({ ok: true, answer: { answers: [{ selected: ['a'] }] } });
    for (const q0 of ['', 'a']) expect(parse(other, { q0, q0_other: ' 手写 ' })).toMatchObject({ ok: true, answer: { answers: [{ questionId: 'pick', text: '手写' }] } });
    const text = request([textQuestion]);
    for (const fields of [undefined, {}, { q0: '' }, { q0: '  ' }]) expect(parse(text, fields)).toEqual({ ok: false, reason: 'empty', message: '请填写回答' });
    expect(parse(text, { q0: ' 答 ' })).toMatchObject({ ok: true, answer: { answers: [{ questionId: 'text', text: '答' }] } });
    for (const fields of [{ q0: 'x'.repeat(1001) }, { q0: ['a'] }, { q0: '答', q0_other: 'bad' }]) expect(parse(text, fields)).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parse(other, { q0: 'a', q0_other: 'x'.repeat(1001) })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(parse(other, { q0_other: 1 })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('validates terminal text and choice-text answers before displaying excerpts', () => {
    const mixed = request([{ ...choiceQuestion, other: true }, textQuestion]);
    const json = JSON.stringify(finish(mixed, { kind: 'text', text: 'x'.repeat(300) }));
    expect(json).toContain('x'.repeat(200) + '…');
    expect(json).not.toContain('x'.repeat(201));
    const answered = JSON.stringify(finish(mixed, { kind: 'choices', answers: [{ questionId: 'pick', text: ' 手写 ' }, { questionId: 'text', text: ' /tmp ' }] }));
    expect(answered).toContain('方案：手写');
    expect(answered).toContain('路径：/tmp');
    for (const req of [confirmation, permission]) expect(() => finish(req, { kind: 'text', text: 'yes' })).toThrow('Answer does not match');
    for (const text of ['  ', 'x'.repeat(4001)]) expect(() => finish(mixed, { kind: 'text', text })).toThrow('Answer does not match');
    for (const answers of [
      [{ questionId: 'foreign', text: 'bad' }],
      [{ questionId: 'text', selected: ['a'] }],
      [{ questionId: 'text', text: 'x'.repeat(1001) }],
    ]) expect(() => finish(request([textQuestion]), { kind: 'choices', answers: answers as Extract<AskAnswer, { kind: 'choices' }>['answers'] })).toThrow('Answer does not match');
    expect(() => finish(request([choiceQuestion]), { kind: 'choices', answers: [{ questionId: 'pick', text: 'bad' }] })).toThrow('Answer does not match');
  });
});


it.each([{ name: 'reviewer' }, {}])('keeps child origin in pending and terminal titles: %j', from => {
  for (const state of [{ kind: 'pending' }, { kind: 'timed-out' }] satisfies AskCardState[]) {
    const card = buildAskCard({ request: confirmation, state, respondents: [], from });
    expect(JSON.stringify(card)).toContain(`子 agent${'name' in from ? ' reviewer' : ''} 问：${confirmation.title}`);
  }
  expect(JSON.stringify(buildAskCard({ request: confirmation, state: { kind: 'pending' }, respondents: [] }))).not.toContain('子 agent');
});

describe('s33b sensitive ask cards', () => {
  const request = parseAskRequest({ ...base, kind: 'choices', questions: [
    { id: 'password', title: '密码', detail: '填写密码', selection: 'text', sensitive: true },
  ] });
  const secret = 'sensitive-answer-must-stay-private';
  const build = (scope: 'group' | 'dm', state: AskCardState = { kind: 'pending' }) => buildAskCard({
    request, scope, state, respondents: [{ openId: 'u1', name: '张三' }],
  });

  it('keeps sensitive controls only in DMs and explains where to answer', () => {
    for (const group of [build('group'), buildAskCard({ request, state: { kind: 'pending' }, respondents: [] })]) {
      expect(nodes(group).some(node => node.tag === 'form' || node.tag === 'input' || node.element_id === ASK_CONTROLS_EID)).toBe(false);
      expect(JSON.stringify(group)).toContain('不在群里显示输入框');
    }
    const dm = build('dm');
    expect(nodes(dm).some(node => node.tag === 'form')).toBe(true);
    expect(nodes(dm).find(node => node.tag === 'input')).toMatchObject({ input_type: 'multiline_text' });
    expect(nodes(dm).some(node => node.element_id === ASK_CONTROLS_EID)).toBe(true);
    expect(JSON.stringify(dm)).toContain('答案只交给 agent');
    expect(JSON.stringify(dm)).not.toContain('可回答');
  });

  it('redacts validated sensitive answers in group and both DM terminal states', () => {
    const answers: AskAnswer[] = [{ kind: 'text', text: secret }, { kind: 'choices', answers: [{ questionId: 'password', text: secret }] }];
    for (const answer of answers) {
      const state = { kind: 'answered', answer, actor: '张三', at: 'now' } satisfies AskCardState;
      const group = JSON.stringify(build('group', state));
      const self = JSON.stringify(build('dm', { ...state, by: 'self' }));
      const other = JSON.stringify(build('dm', { ...state, by: 'other' }));
      expect(group).toContain('已在私聊里回答（内容不显示）');
      expect(group).toContain('张三 · now');
      expect(self).toContain('已提交 · now（内容不显示）');
      expect(other).toContain('已由 张三 回答 · now');
      for (const json of [group, self, other]) {
        expect(json).not.toContain(secret);
        expect(json).not.toContain(ASK_CONTROLS_EID);
      }
    }
    for (const answer of [{ kind: 'text', text: ' ' }, { kind: 'choices', answers: [{ questionId: 'wrong', text: secret }] }] satisfies AskAnswer[]) {
      expect(() => build('group', { kind: 'answered', answer, actor: '张三', at: 'now' })).toThrow('Answer does not match');
    }
  });

  it('explains failed DM delivery and shares stopped and timed-out states across scopes', () => {
    for (const scope of ['group', 'dm'] as const) {
      expect(JSON.stringify(build(scope, { kind: 'unavailable', reason: 'dm-failed' }))).toContain('没能私聊到能回答的人，这题没法回答');
      expect(JSON.stringify(build(scope, { kind: 'stopped' }))).toContain('⏹ 已停止');
      expect(JSON.stringify(build(scope, { kind: 'timed-out' }))).toContain('⏱ 15 分钟没人回答');
    }
  });
});
