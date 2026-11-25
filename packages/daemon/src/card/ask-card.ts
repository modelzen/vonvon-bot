import { z } from 'zod';
import { isSensitiveAsk, type AskAnswer, type AskChoiceAnswer, type AskRequest } from '../agent/types';
import { keepAts } from './at-guard';
import { actions, button, card, form, hr, input as textInput, md, multiSelectMenu, note, noteMd, selectMenu, submitButton, type ActionValue, type CardElement, type CardObject } from './cards';

// Feishu element IDs allow only letters, digits and underscores (20 characters max).
export const ASK_CONTROLS_EID = 'ask_controls';

export type AskCardState =
  | { kind: 'pending' }
  | { kind: 'answered'; answer: AskAnswer; actor: string; at: string; by?: 'self' | 'other' }
  | { kind: 'timed-out' }
  | { kind: 'stopped' }
  | { kind: 'unavailable'; reason: 'turn-ended' | 'unavailable' | 'dm-failed' }
  // Restarted old cards are healed by replacing their controls in s33c.
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
  const clean = input.value && typeof input.value === 'object' && !Array.isArray(input.value)
    ? Object.fromEntries(Object.entries(input.value).filter(([key]) => key !== '__r')) : input.value;
  const parsed = callbackSchema.safeParse(clean);
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
  const missingAnswer: AskSubmissionResult = request.questions.every(q => q.selection === 'text')
    ? { ok: false, reason: 'empty', message: '请填写回答' } : empty;
  if (formValue === undefined) return missingAnswer;
  if (formValue === null || typeof formValue !== 'object' || Array.isArray(formValue)) return invalid;
  const fields = formSchema.safeParse(formValue);
  if (!fields.success) return invalid;
  const names = new Set(request.questions.flatMap((q, index) =>
    q.selection !== 'text' && q.other ? [`q${index}`, `q${index}_other`] : [`q${index}`]));
  if (Object.keys(formValue).some(name => !names.has(name))) return invalid;
  const answers: AskChoiceAnswer[] = [];
  let missing = false;
  for (const [index, question] of request.questions.entries()) {
    const raw = fields.data[`q${index}`];
    const typed = question.selection === 'text' ? raw : question.other ? fields.data[`q${index}_other`] : undefined;
    if (typed !== undefined && typeof typed !== 'string') return invalid;
    const text = typeof typed === 'string' ? typed.trim() : '';
    if (text.length > 1000) return invalid;
    if (text) { answers.push({ questionId: question.id, text }); continue; }
    if (question.selection === 'text') { missing = true; continue; }
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
  if (missing) return missingAnswer;
  const [first, ...rest] = answers;
  if (!first) return missingAnswer;
  return { ok: true, answer: { kind: 'choices', answers: [first, ...rest] } };
}

function decisionLabel(answer: Exclude<AskAnswer, { kind: 'choices' | 'text' }>): string {
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
  const mismatch = () => new Error('Answer does not match ask request');
  const excerpt = (text: string) => text.length > 200 ? `${text.slice(0, 200)}…` : text;
  if (answer.kind === 'text') {
    const text = answer.text.trim();
    if (request.kind !== 'choices' || !text || text.length > 4000) throw mismatch();
    return isSensitiveAsk(request) ? '已在私聊里回答（内容不显示）' : excerpt(text);
  }
  let result: AskSubmissionResult;
  if (answer.kind === 'choices') {
    if (request.kind !== 'choices' || answer.answers.length !== request.questions.length) throw new Error('Answer does not match ask request');
    const fields: Record<string, unknown> = {};
    request.questions.forEach((question, index) => {
      const matches = answer.answers.filter(item => item.questionId === question.id);
      if (matches.length !== 1) throw new Error('Answer does not match ask request');
      const item = matches[0];
      if (!item) throw new Error('Answer does not match ask request');
      if ('text' in item) {
        if (question.selection !== 'text' && !question.other) throw mismatch();
        fields[question.selection === 'text' ? `q${index}` : `q${index}_other`] = item.text;
      } else {
        if (question.selection === 'text') throw mismatch();
        fields[`q${index}`] = question.selection === 'single' && item.selected.length === 1 ? item.selected[0] : item.selected;
      }
    });
    result = parseAskSubmission({ request, value: callback(request, 'submit'), formValue: fields });
  } else {
    result = parseAskSubmission({ request, value: callback(request, answer.decision), formValue: undefined });
  }
  if (!result.ok) throw new Error('Answer does not match ask request');
  if (result.answer.kind === 'text') throw mismatch();
  if (result.answer.kind !== 'choices') return decisionLabel(result.answer);
  if (request.kind !== 'choices') throw new Error('Answer does not match ask request');
  if (isSensitiveAsk(request)) return '已在私聊里回答（内容不显示）';
  const parsedAnswers = result.answer.answers;
  return request.questions.map(question => {
    const item = parsedAnswers.find(item => item.questionId === question.id);
    if (!item) throw mismatch();
    if ('text' in item) return `${question.title}：${excerpt(item.text)}`;
    if (question.selection === 'text') throw mismatch();
    return `${question.title}：${question.options.filter(option => item.selected.includes(option.id)).map(option => option.label).join('、')}`;
  }).join('\n');
}

export function buildAskCard(input: { request: AskRequest; from?: { name?: string }; state: AskCardState; respondents: readonly { openId: string; name: string }[]; scope?: 'group' | 'dm' | 'own' }): CardObject {
  const { request, state, respondents, scope = 'group' } = input;
  const elements: CardElement[] = [];
  if (scope === 'dm') elements.push(note('这是群里 agent 问的问题，答案只交给 agent，不会出现在群里。'));

  const isPendingChoicesForm = state.kind === 'pending' && request.kind === 'choices' && !(scope === 'group' && isSensitiveAsk(request));

  if (isPendingChoicesForm) {
    // Group each question's heading, concise option notes, and full-width controls together inside the form
    // so multi-question cards stay cleanly separated with zero ambiguous unlabeled boxes.
    const multi = request.questions.length > 1;
    const formElements: CardElement[] = [];
    request.questions.forEach((question, index) => {
      if (index > 0) formElements.push(hr());
      const prefix = multi ? `${index + 1}. ` : '';
      const modeHint = question.selection === 'multiple' ? '（可多选）' : '';
      formElements.push(md(`**${prefix}${question.title}${modeHint}**${question.detail ? `\n${question.detail}` : ''}`));

      if (question.selection === 'text') {
        formElements.push(textInput({
          name: `q${index}`,
          width: 'fill',
          placeholder: `请输入「${question.title}」`,
          inputType: 'multiline_text',
          rows: 2,
          maxLength: 1000,
        }));
        return;
      }

      const described = question.options.filter(option => option.description);
      if (described.length > 0) {
        formElements.push(noteMd(described.map(option => `· **${option.label}**：${option.description}`).join('\n')));
      }
      const opts = {
        name: `q${index}`,
        width: 'fill' as const,
        placeholder: question.selection === 'multiple' ? `请选择「${question.title}」（可多选）` : `请选择「${question.title}」`,
        options: question.options.map(option => ({ label: option.label, value: option.id })),
      };
      formElements.push(question.selection === 'single' ? selectMenu(opts) : multiSelectMenu(opts));
      if (question.other) {
        formElements.push(textInput({
          name: `q${index}_other`,
          width: 'fill',
          placeholder: `或输入「${question.title}」的自定义内容（选填）`,
          maxLength: 1000,
        }));
      }
    });
    if (multi) formElements.push(hr());
    formElements.push(submitButton(request.questions.every(q => q.selection === 'text') ? '提交回答' : '提交选择', callback(request, 'submit')));
    elements.push(form('ask', formElements, ASK_CONTROLS_EID));
  } else if (request.kind === 'choices') {
    // Terminal states or sensitive-in-group notice: keep compact summary without repeating full option walls.
    if (state.kind === 'pending') {
      for (const question of request.questions) {
        elements.push(md(`**${question.title}**${question.detail ? `\n${question.detail}` : ''}`));
      }
    } else if (state.kind !== 'answered') {
      elements.push(noteMd(request.questions.map(q => `· **${q.title}**${q.detail ? `：${q.detail}` : ''}`).join('\n')));
    }
  } else {
    elements.push(md(request.detail));
  }

  if (scope === 'group') elements.push(md(`可回答：${respondents.length ? respondents.map(person => `<at id="${person.openId}">${person.name}</at>`).join('、') : '等待指定成员回答'}`));

  if (state.kind === 'pending') {
    if (scope === 'dm') elements.push(note('点卡片回答，或直接回复这条消息'));
    if (scope === 'group' && isSensitiveAsk(request)) {
      elements.push(md('🔒 这个问题要填敏感信息，不在群里显示输入框。我已经私聊了能回答的人，请在和我的私聊里回答；答完这里会更新。'));
    } else if (request.kind === 'confirmation') {
      elements.push(actions([button('按这个方案做', callback(request, 'proceed'), 'primary'), button('不行，我来说', callback(request, 'explain'))], ASK_CONTROLS_EID));
    } else if (request.kind === 'permission') {
      elements.push(actions([button('允许这一次', callback(request, 'allow-once'), 'primary'), button('拒绝', callback(request, 'deny'))], ASK_CONTROLS_EID));
    }
  } else {
    switch (state.kind) {
      case 'answered': {
        const summary = answerSummary(request, state.answer);
        const attribution = scope === 'dm'
          ? state.by === 'self' ? `已提交 · ${state.at}（内容不显示）` : `已由 ${state.actor} 回答 · ${state.at}`
          : `${state.actor} · ${state.at}`;
        elements.push(md(summary), note(attribution));
        break;
      }
      case 'timed-out': elements.push(note('⏱ 15 分钟没人回答')); break;
      case 'stopped': elements.push(note('⏹ 已停止')); break;
      case 'unavailable': elements.push(note(state.reason === 'dm-failed' ? '没能私聊到能回答的人，这题没法回答' : state.reason === 'turn-ended' ? '本轮已结束' : '暂时无法回答')); break;
      case 'expired': elements.push(note('已失效（后台服务重启过）')); break;
      default: { const exhaustive: never = state; return exhaustive; }
    }
  }

  // Keep consequence notes subtle at the bottom; in private own-chat choices, show a clean interaction hint instead of boilerplate.
  if (scope === 'own' && request.kind === 'choices') {
    if (state.kind === 'pending') elements.push(note('选完点「提交选择」即可，也可以直接在聊天里打字回复'));
  } else {
    elements.push(note(`回答后：${request.acceptedConsequence} · 未回答或拒绝后：${request.declinedConsequence}`));
  }

  const headerTag = state.kind === 'pending'
    ? [{ text: request.kind === 'permission' ? '待授权' : '待选择', color: request.kind === 'permission' ? 'orange' : 'blue' }]
    : state.kind === 'answered'
      ? [{ text: '已回答', color: 'green' }]
      : [{ text: '已结束', color: 'neutral' }];

  // The respondents' @ is the program's own: it stays real even when the chat's bot list cannot be read (s27a0).
  return keepAts(card(elements, {
    header: {
      title: input.from ? `子 agent${input.from.name ? ` ${input.from.name}` : ''} 问：${request.title}` : request.title,
      template: state.kind === 'pending' ? (request.kind === 'permission' ? 'orange' : 'wathet') : 'grey',
      textTags: headerTag,
    },
    forward: false,
  }), respondents.map(person => person.openId));
}
