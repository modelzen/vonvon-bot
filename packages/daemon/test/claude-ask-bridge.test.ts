import { describe, expect, it } from 'vitest';
import { bridgeAsk } from '../src/agent/claude-agent/ask-bridge.js';
import type { ClaudeAccess, ToolCall } from '../src/agent/claude-agent/permission.js';
import { parseAskRequest, type AskResolution } from '../src/agent/types.js';

const access: ClaudeAccess = { mode: 'full', network: false, cwd: '/w', realCwd: '/w' };
const options = ['A', 'B', 'C'].map(label => ({ label, description: `说明 ${label}` }));
const input = { questions: [
  { question: '题一？', header: '第一题', options, multiSelect: false },
  { question: '题二？', header: '第二题', options, multiSelect: true },
] };
function bridge(kind: 'choices' | 'confirmation' | 'permission', value: Record<string, unknown>, tier = access, extra: Partial<ToolCall> = {}) {
  const result = bridgeAsk('c1', kind, tier, { toolName: 'Bash', input: value, extra: {}, ...extra });
  if (!result) throw new Error('Expected bridge');
  return result;
}
const answered = (answer: Extract<AskResolution, { kind: 'answered' }>['answer']): AskResolution => ({ kind: 'answered', answer });

describe('Claude ask bridge', () => {
  it('maps questions, choices and free text into valid requests', () => {
    const request = bridge('choices', input).request;
    expect(parseAskRequest(request)).toEqual(request);
    expect(request).toMatchObject({ kind: 'choices', title: 'Claude 有 2 个问题', questions: [
      { id: 'q0', title: '第一题', detail: '题一？', selection: 'single', other: true, options: options.map((option, i) => ({ id: `o${i}`, ...option })) },
      { id: 'q1', title: '第二题', detail: '题二？', selection: 'multiple', other: true },
    ] });
    expect(bridge('choices', { questions: [{ question: '说什么？', header: '', options: [] }] }).request).toMatchObject({
      title: 'Claude 有问题要问', questions: [{ title: '问题 1', selection: 'text', sensitive: false }],
    });
  });
  it.each([{}, { questions: 'bad' }, { questions: [] }, { questions: [{ question: '', header: '' }] }])('rejects malformed input %j', value => {
    expect(bridgeAsk('c1', 'choices', access, { toolName: 'AskUserQuestion', input: value, extra: {} })).toBeUndefined();
  });
  it('returns labels keyed by original question and preserves input', () => {
    const ask = bridge('choices', input);
    expect(ask.toResult(answered({ kind: 'choices', answers: [
      { questionId: 'q0', selected: ['o1'] }, { questionId: 'q1', selected: ['o0', 'o2'] },
    ] }))).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { '题一？': 'B', '题二？': 'A, C' } } });
    expect(ask.toResult(answered({ kind: 'choices', answers: [{ questionId: 'q1', text: '自己写' }] }))).toMatchObject({ updatedInput: { answers: { '题二？': '自己写' } } });
    expect(ask.toResult(answered({ kind: 'choices', answers: [{ questionId: 'q0', selected: ['o0'] }] }))).toMatchObject({ updatedInput: { answers: { '题一？': 'A' } } });
    expect(ask.toResult(answered({ kind: 'text', text: '都行' }))).toMatchObject({ updatedInput: { answers: { '题一？': '都行', '题二？': '都行' } } });
  });
  it('preserves a __proto__ question as an own answer key', () => {
    const ask = bridge('choices', { questions: [{ question: '__proto__', header: '题目', options }] });
    const result = ask.toResult(answered({ kind: 'choices', answers: [{ questionId: 'q0', selected: ['o1'] }] }));
    expect(JSON.stringify(result)).toContain('"answers":{"__proto__":"B"}');
    expect(JSON.stringify(ask.toResult(answered({ kind: 'text', text: '文字' })))).toContain('"__proto__":"文字"');
  });
  it.each([
    ['timeout', '用户 15 分钟没有回答。按你自己的判断继续，或者停下来说明还需要什么。'],
    ['stopped', '用户停止了这一轮。'],
    ['turn-ended', '这个问题没法交给用户（卡片没发出去，或者这一轮已经结束）。按你自己的判断继续，或者停下来说明还需要什么。'],
    ['unavailable', '这个问题没法交给用户（卡片没发出去，或者这一轮已经结束）。按你自己的判断继续，或者停下来说明还需要什么。'],
  ] satisfies [Extract<AskResolution, { kind: 'unanswered' }>['reason'], string][])('denies unanswered %s without interrupting', (reason, message) => {
    expect(bridge('choices', input).toResult({ kind: 'unanswered', reason })).toEqual({ behavior: 'deny', message });
  });
  it.each([
    ['qa', 'default'], ['write', 'acceptEdits'], ['full', 'bypassPermissions'],
  ] satisfies [ClaudeAccess['mode'], string][])('restores %s after confirming the plan, only for the session', (mode, expected) => {
    const ask = bridge('confirmation', { plan: 'x'.repeat(2500) }, { ...access, mode });
    expect(ask.request).toMatchObject({ detail: `${'x'.repeat(2000)}…（完整方案见上面的运行卡）` });
    expect(ask.toResult(answered({ kind: 'confirmation', decision: 'proceed' }))).toEqual({ behavior: 'allow', updatedInput: { plan: 'x'.repeat(2500) }, updatedPermissions: [{ type: 'setMode', mode: expected, destination: 'session' }] });
  });
  it('handles absent plan, declined plan and confirmation timeout', () => {
    const ask = bridge('confirmation', {});
    expect(ask.request).toMatchObject({ detail: 'Claude 写好了方案，想开始按它做（方案见上面的运行卡）。' });
    expect(ask.toResult(answered({ kind: 'confirmation', decision: 'explain' }))).toEqual({ behavior: 'deny', message: '用户不同意这个方案，会自己说想怎么做。先停下，等用户的下一条消息。' });
    expect(ask.toResult({ kind: 'unanswered', reason: 'timeout' })).toEqual({ behavior: 'deny', message: '用户 15 分钟没有确认这个方案，先不要按它做，停下来说明。' });
  });
  it('limits permission details and allows exactly the supplied input', () => {
    const ask = bridge('permission', { command: 'rm -r x' }, access, { decisionReason: 'safety' });
    expect(ask.request).toMatchObject({ kind: 'permission', permissionMode: 'full', detail: '工具：Bash\nrm -r x\n原因：safety' });
    expect(ask.toResult(answered({ kind: 'permission', decision: 'allow-once' }))).toEqual({ behavior: 'allow', updatedInput: { command: 'rm -r x' } });
    expect(ask.toResult(answered({ kind: 'permission', decision: 'deny' }))).toEqual({ behavior: 'deny', message: '主人或管理员拒绝了这一步。换个办法，或者停下来说明。' });
    expect(ask.toResult({ kind: 'unanswered', reason: 'timeout' })).toEqual({ behavior: 'deny', message: '没人允许这一步，这一步不做。换个办法，或者停下来说明。' });
    expect(bridge('permission', { command: 'x'.repeat(600) }).request).toMatchObject({ detail: `工具：Bash\n${'x'.repeat(500)}\n原因：命中了设置里的规则` });
  });
});
