import { describe, expect, it } from 'vitest';
import { parseAskRequest, type AgentEvent, type AskRequest } from '../src/agent/types';
import { buildAskCard, parseAskSubmission, type AskAnswer, type AskCardState } from '../src/card/ask-card';
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
  return JSON.parse(JSON.stringify(buildAskCard({ request, state, respondents: ['张三', '李四'] })));
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
    const all = nodes(render(choices));
    expect(all.filter(node => node.tag === 'select_static').map(node => node.name)).toEqual(['q0']);
    expect(all.filter(node => node.tag === 'multi_select_static').map(node => node.name)).toEqual(['q1']);
    expect(all.filter(node => node.type === 'callback').map(node => node.value)).toEqual([value]);
    expect(all.find(node => node.tag === 'button')?.form_action_type).toBe('submit');
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
