import { z } from 'zod';
import type { AskRequest } from '../agent/types';
import { actions, button, card, form, md, multiSelectMenu, note, selectMenu, submitButton, type ActionValue, type CardElement, type CardObject } from './cards';

export type AskAnswer =
  | { kind: 'choices'; answers: [{ questionId: string; selected: [string, ...string[]] }, ...{ questionId: string; selected: [string, ...string[]] }[]] }
  | { kind: 'confirmation'; decision: 'proceed' | 'explain' }
  | { kind: 'permission'; decision: 'allow-once' | 'deny' };

export type AskCardState =
  | { kind: 'pending' }
  | { kind: 'answered'; answer: AskAnswer; actor: string; at: string }
  | { kind: 'timed-out' }
  | { kind: 'stopped' }
  | { kind: 'expired'; reason: 'restart' };

export type AskSubmissionResult =
  | { ok: true; answer: AskAnswer }
  | { ok: false; reason: 'empty' | 'invalid' | 'wrong-request'; message: string };

const callbackSchema = z.object({
  a: z.literal('ask_submit'), requestId: z.string(),
  decision: z.enum(['submit', 'proceed', 'explain', 'allow-once', 'deny']),
}).strict();
const formSchema = z.record(z.string(), z.unknown());
const invalid: AskSubmissionResult = { ok: false, reason: 'invalid', message: '提交内容无效，请重新选择' };
const empty: AskSubmissionResult = { ok: false, reason: 'empty', message: '至少选一项' };

function callback(request: AskRequest, decision: z.infer<typeof callbackSchema>['decision']): ActionValue {
  return { a: 'ask_submit', requestId: request.id, decision };
}

/** Validate callbacks against the exact outstanding request; authorization belongs to the caller. */
export function parseAskSubmission(input: { request: AskRequest; value: unknown; formValue: unknown }): AskSubmissionResult {
  const parsed = callbackSchema.safeParse(input.value);
  if (!parsed.success) return invalid;
  const { request, formValue } = input;
  const { decision, requestId } = parsed.data;
  if (requestId !== request.id) return { ok: false, reason: 'wrong-request', message: '这不是当前问题的回答' };
  if (request.kind !== 'choices') {
    if (formValue !== undefined) {
      if (formValue === null || typeof formValue !== 'object' || Array.isArray(formValue)) return invalid;
      const fields = formSchema.safeParse(formValue);
      if (!fields.success || Object.keys(formValue).length) return invalid;
    }
    if (request.kind === 'confirmation' && (decision === 'proceed' || decision === 'explain')) {
      return { ok: true, answer: { kind: 'confirmation', decision } };
    }
    if (request.kind === 'permission' && (decision === 'allow-once' || decision === 'deny')) {
      return { ok: true, answer: { kind: 'permission', decision } };
    }
    return invalid;
  }
  if (decision !== 'submit') return invalid;
  if (formValue === undefined) return empty;
  if (formValue === null || typeof formValue !== 'object' || Array.isArray(formValue)) return invalid;
  const fields = formSchema.safeParse(formValue);
  if (!fields.success) return invalid;
  const names = new Set(request.questions.map((_, index) => `q${index}`));
  if (Object.keys(formValue).some(name => !names.has(name))) return invalid;
  const answers: { questionId: string; selected: [string, ...string[]] }[] = [];
  let missing = false;
  for (const [index, question] of request.questions.entries()) {
    const raw = fields.data[`q${index}`];
    if (raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
      missing = true;
      continue;
    }
    const selection = question.selection === 'single'
      ? z.string().safeParse(raw)
      : z.array(z.string()).safeParse(raw);
    if (!selection.success) return invalid;
    const selected = typeof selection.data === 'string' ? [selection.data] : selection.data;
    const [first, ...rest] = selected;
    if (first === undefined) { missing = true; continue; }
    const validIds = new Set(question.options.map(option => option.id));
    if (new Set(selected).size !== selected.length || selected.some(id => !validIds.has(id))) return invalid;
    answers.push({ questionId: question.id, selected: [first, ...rest] });
  }
  if (missing) return empty;
  const [first, ...rest] = answers;
  if (!first) return empty;
  return { ok: true, answer: { kind: 'choices', answers: [first, ...rest] } };
}

function decisionLabel(answer: Exclude<AskAnswer, { kind: 'choices' }>): string {
  switch (answer.decision) {
    case 'proceed': return '按这个方案做';
    case 'explain': return '不行，我来说';
    case 'allow-once': return '允许这一次';
    case 'deny': return '拒绝';
    default: { const exhaustive: never = answer; return exhaustive; }
  }
}

/** Revalidate terminal results too, so a mismatched request cannot display a false answer. */
function answerSummary(request: AskRequest, answer: AskAnswer): string {
  let result: AskSubmissionResult;
  if (answer.kind === 'choices') {
    if (request.kind !== 'choices' || answer.answers.length !== request.questions.length) throw new Error('Answer does not match ask request');
    const fields: Record<string, unknown> = {};
    request.questions.forEach((question, index) => {
      const matches = answer.answers.filter(item => item.questionId === question.id);
      if (matches.length !== 1) throw new Error('Answer does not match ask request');
      const item = matches[0];
      if (!item) throw new Error('Answer does not match ask request');
      fields[`q${index}`] = question.selection === 'single' && item.selected.length === 1 ? item.selected[0] : item.selected;
    });
    result = parseAskSubmission({ request, value: callback(request, 'submit'), formValue: fields });
  } else {
    result = parseAskSubmission({ request, value: callback(request, answer.decision), formValue: undefined });
  }
  if (!result.ok) throw new Error('Answer does not match ask request');
  if (result.answer.kind !== 'choices') return decisionLabel(result.answer);
  if (request.kind !== 'choices') throw new Error('Answer does not match ask request');
  return request.questions.map(question => {
    const selected: readonly string[] = result.answer.kind === 'choices'
      ? result.answer.answers.find(item => item.questionId === question.id)?.selected ?? [] : [];
    return `${question.title}：${question.options.filter(option => selected.includes(option.id)).map(option => option.label).join('、')}`;
  }).join('\n');
}

export function buildAskCard(input: { request: AskRequest; state: AskCardState; respondents: readonly string[] }): CardObject {
  const { request, state, respondents } = input;
  const elements: CardElement[] = [];
  if (request.kind === 'choices') {
    for (const question of request.questions) {
      elements.push(md(`**${question.title}**\n${question.detail}`));
      elements.push(...question.options.map(option => md(`${option.label}${option.description ? `：${option.description}` : ''}`)));
    }
  } else elements.push(md(request.detail));
  elements.push(md(`回答后：${request.acceptedConsequence}\n\n未回答或拒绝后：${request.declinedConsequence}`));
  elements.push(note(`可回答：${respondents.length ? respondents.join('、') : '等待指定成员回答'}`));
  if (state.kind === 'pending') {
    if (request.kind === 'choices') {
      elements.push(form('ask', [
        ...request.questions.map((question, index) => {
          const opts = { name: `q${index}`, placeholder: question.title, options: question.options.map(option => ({ label: option.label, value: option.id })) };
          return question.selection === 'single' ? selectMenu(opts) : multiSelectMenu(opts);
        }),
        submitButton('提交选择', callback(request, 'submit')),
      ]));
    } else if (request.kind === 'confirmation') {
      elements.push(actions([button('按这个方案做', callback(request, 'proceed'), 'primary'), button('不行，我来说', callback(request, 'explain'))]));
    } else {
      elements.push(actions([button('允许这一次', callback(request, 'allow-once'), 'primary'), button('拒绝', callback(request, 'deny'))]));
    }
  } else {
    switch (state.kind) {
      case 'answered': elements.push(md(answerSummary(request, state.answer)), note(`${state.actor} · ${state.at}`)); break;
      case 'timed-out': elements.push(note('⏱ 15 分钟没人回答')); break;
      case 'stopped': elements.push(note('⏹ 已停止')); break;
      case 'expired': elements.push(note('已失效（后台服务重启过）')); break;
      default: { const exhaustive: never = state; return exhaustive; }
    }
  }
  return card(elements, { header: { title: request.title, template: state.kind === 'pending' ? 'blue' : 'grey' }, forward: false });
}
