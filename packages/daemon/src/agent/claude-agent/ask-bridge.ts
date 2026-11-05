import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { parseAskRequest, type AskRequest, type AskResolution } from '../types.js';
import { resumeMode, type ClaudeAccess, type ToolCall } from './permission.js';

export interface BridgedAsk {
  request: AskRequest;
  /** The thread must apply acceptEdits before releasing the pending-plan guard. */
  planConfirmation?: boolean;
  toResult(resolution: AskResolution): PermissionResult;
}
const questionsSchema = z.object({ questions: z.array(z.object({
  question: z.string().min(1).refine(value => value.trim().length > 0), header: z.string(),
  options: z.array(z.object({ label: z.string().min(1).refine(value => value.trim().length > 0), description: z.string() })).optional(),
  multiSelect: z.boolean().optional(),
})).min(1) });
const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
const unavailable = '这个问题没法交给用户（卡片没发出去，或者这一轮已经结束）。按你自己的判断继续，或者停下来说明还需要什么。';
function unanswered(reason: Extract<AskResolution, { kind: 'unanswered' }>['reason']): PermissionResult {
  if (reason === 'timeout') return deny('用户 15 分钟没有回答。按你自己的判断继续，或者停下来说明还需要什么。');
  if (reason === 'stopped') return deny('用户停止了这一轮。');
  return deny(unavailable);
}

export function bridgeAsk(id: string, ask: 'choices' | 'confirmation' | 'permission', access: ClaudeAccess, call: ToolCall): BridgedAsk | undefined {
  const { input } = call;
  try {
    if (ask === 'choices') {
      const { questions } = questionsSchema.parse(input);
      const request = parseAskRequest({
        id, kind: 'choices',
        title: (questions.length === 1 ? questions[0]?.header : `Claude 有 ${questions.length} 个问题`) || 'Claude 有问题要问',
        acceptedConsequence: 'Claude 按你的回答接着做。',
        declinedConsequence: '15 分钟没人回答，Claude 会被告知没人回答，自己判断接着做还是停下。',
        questions: questions.map((question, index) => ({
          id: `q${index}`, title: question.header || `问题 ${index + 1}`, detail: question.question,
          ...(question.options?.length ? {
            selection: question.multiSelect ? 'multiple' : 'single', other: true,
            options: question.options.map((option, j) => ({ id: `o${j}`, ...option })),
          } : { selection: 'text' }),
        })),
      });
      return { request, toResult(resolution) {
        if (resolution.kind === 'unanswered') return unanswered(resolution.reason);
        const entries: [string, string][] = [];
        const answer = resolution.answer;
        if (answer.kind !== 'choices' && answer.kind !== 'text') return deny(unavailable);
        questions.forEach((question, index) => {
          if (answer.kind === 'text') { entries.push([question.question, answer.text]); return; }
          const item = answer.answers.find(value => value.questionId === `q${index}`);
          if (!item) return;
          entries.push([question.question, 'text' in item ? item.text : item.selected
            .flatMap(optionId => question.options?.filter((_, j) => optionId === `o${j}`).map(option => option.label) ?? []).join(', ')]);
        });
        return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(entries) } };
      } };
    }
    if (ask === 'confirmation') {
      const plan = typeof input.plan === 'string' && input.plan.trim() ? input.plan : undefined;
      const request = parseAskRequest({
        id, kind: 'confirmation', title: 'Claude 想按这个方案做。',
        detail: plan ? plan.slice(0, 2000) + (plan.length > 2000 ? '…（完整方案见上面的运行卡）' : '') : 'Claude 写好了方案，想开始按它做（方案见上面的运行卡）。',
        acceptedConsequence: 'Claude 按这个方案开始做。', declinedConsequence: 'Claude 不按这个方案做，等你说怎么改。',
      });
      return { request, planConfirmation: call.toolName === 'ExitPlanMode' && !!access.planState, toResult(resolution) {
        if (resolution.kind === 'unanswered') return resolution.reason === 'timeout'
          ? deny('用户 15 分钟没有确认这个方案，先不要按它做，停下来说明。') : unanswered(resolution.reason);
        if (resolution.answer.kind !== 'confirmation' || resolution.answer.decision !== 'proceed')
          return deny('用户不同意这个方案，会自己说想怎么做。先停下，等用户的下一条消息。');
        const mode = resumeMode(access);
        return { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] };
      } };
    }
    const action = [input.command, input.file_path, input.url].find(value => typeof value === 'string');
    const request = parseAskRequest({
      id, kind: 'permission', permissionMode: 'full', title: 'Claude 要确认这一步。',
      detail: `工具：${call.toolName}\n${typeof action === 'string' ? action.slice(0, 500) : ''}\n原因：${call.decisionReason || '命中了设置里的规则'}`,
      acceptedConsequence: '只允许这一次。', declinedConsequence: 'Claude 收到拒绝，换个办法或停下；15 分钟没人点也按拒绝。',
    });
    return { request, toResult(resolution) {
      if (resolution.kind === 'unanswered') return deny('没人允许这一步，这一步不做。换个办法，或者停下来说明。');
      return resolution.answer.kind === 'permission' && resolution.answer.decision === 'allow-once'
        ? { behavior: 'allow', updatedInput: input } : deny('管理员拒绝了这一步。换个办法，或者停下来说明。');
    } };
  } catch {
    return undefined;
  }
}
