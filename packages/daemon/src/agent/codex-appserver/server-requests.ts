import { z } from 'zod';
import { log } from '../../core/logger';
import { parseAskRequest, type AgentEntry, type AskAnswer, type AskRequest, type AskResolution } from '../types';
import { toolReplyText } from '../entry/tools';
import type { JsonRpcAnswer, JsonRpcId } from '../../provider/transport/jsonrpc';
import { ASK_USER_TOOL, offeredTool } from './dynamic-tools';
import type { DynamicToolCallResponse } from './protocol/generated/v2/DynamicToolCallResponse';
import type { PermissionsRequestApprovalResponse } from './protocol/generated/v2/PermissionsRequestApprovalResponse';
import type { ToolRequestUserInputParams } from './protocol/generated/v2/ToolRequestUserInputParams';
import type { ToolRequestUserInputResponse } from './protocol/generated/v2/ToolRequestUserInputResponse';
import type { CommandExecutionRequestApprovalResponse } from './protocol/generated/v2/CommandExecutionRequestApprovalResponse';
import type { FileChangeRequestApprovalResponse } from './protocol/generated/v2/FileChangeRequestApprovalResponse';
import type { ExecCommandApprovalResponse } from './protocol/generated/ExecCommandApprovalResponse';
import type { ApplyPatchApprovalResponse } from './protocol/generated/ApplyPatchApprovalResponse';

const inputSchema = z.object({
  threadId: z.string().min(1), turnId: z.string().min(1), itemId: z.string().min(1),
  questions: z.array(z.object({
    id: z.string().min(1).refine(value => value.trim().length > 0), header: z.string().trim().min(1), question: z.string(),
    isOther: z.boolean(), isSecret: z.boolean(),
    options: z.array(z.object({ label: z.string().min(1).refine(value => value.trim().length > 0), description: z.string() })).nullable(),
  })).min(1),
});
const unavailable = (): JsonRpcAnswer => ({ result: { answers: {} } satisfies ToolRequestUserInputResponse });
type InputQuestion = ToolRequestUserInputParams['questions'][number];

function otherAnswer(question: InputQuestion, text: string): string[] {
  if (question.options?.length && !question.isOther) log.info('agent', 'ask-text-without-other', { questionId: question.id });
  return [text];
}

/** Translate stable card IDs back to the provider's opaque question IDs and labels. */
function answerTexts(questions: InputQuestion[], answer: AskAnswer): Map<string, string[]> | undefined {
  if (answer.kind === 'text') {
    return new Map(questions.map(q => [q.id, otherAnswer(q, answer.text)]));
  }
  if (answer.kind !== 'choices' || answer.answers.length !== questions.length) return undefined;
  const texts = new Map<string, string[]>();
  for (const [qi, q] of questions.entries()) {
    const matches = answer.answers.filter(a => a.questionId === `q${qi}`);
    if (matches.length !== 1) return undefined;
    const item = matches[0];
    if (!item) return undefined;
    if ('text' in item) {
      texts.set(q.id, otherAnswer(q, item.text));
      continue;
    }
    if (item.selected.length !== 1) return undefined;
    const label = q.options?.find((_option, oi) => item.selected[0] === `o${oi}`)?.label;
    if (!label) return undefined;
    texts.set(q.id, [label]);
  }
  return texts;
}

export interface InboundQuestion {
  kind: 'request';
  rpcId: JsonRpcId;
  threadId: string;
  turnId: string;
  request: AskRequest;
  settle(resolution?: AskResolution): void;
  cancel(): void;
}

export interface InboundCancellation {
  kind: 'request_cancelled';
  requestId: string;
  owner: CodexRequestScope;
}

/** A single run owns these continuations, including requests buffered before its start ACK. */
export class CodexRequestScope {
  private readonly pending = new Map<string, InboundQuestion>();
  private readonly calls = new Set<() => void>();
  private closed = false;

  constructor(readonly threadId: string, private readonly childTurn: (id: string) => string | undefined = () => undefined) {}

  add(question: InboundQuestion): void {
    if (this.closed) question.settle();
    else this.pending.set(question.request.id, question);
  }

  accepts(question: InboundQuestion, turnId: string | undefined): boolean {
    if (this.pending.get(question.request.id) !== question) return false;
    if (question.turnId === (question.threadId === this.threadId ? turnId : this.childTurn(question.threadId))) return true;
    this.respond(question.request.id);
    return false;
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  respond(id: string, resolution?: AskResolution): Promise<void> {
    const question = this.pending.get(id);
    this.pending.delete(id); // Claim before returning delivery work.
    question?.settle(resolution);
    return Promise.resolve();
  }

  forget(question: InboundQuestion): void {
    if (this.pending.get(question.request.id) === question) this.pending.delete(question.request.id);
  }

  retireRpc(id: JsonRpcId, threadId: string): InboundCancellation[] {
    const cancelled: InboundCancellation[] = [];
    for (const question of this.pending.values()) {
      if (question.rpcId !== id || question.threadId !== threadId) continue;
      question.cancel();
      cancelled.push({ kind: 'request_cancelled', requestId: question.request.id, owner: this });
    }
    return cancelled;
  }

  finishThread(threadId: string): string[] {
    const ids = [...this.pending.values()].filter(q => q.threadId === threadId).map(q => q.request.id);
    for (const id of ids) void this.respond(id);
    return ids;
  }

  finishTurn(turnId: string): void {
    for (const question of this.pending.values()) {
      if (question.threadId === this.threadId && question.turnId === turnId) void this.respond(question.request.id);
    }
  }

  /** A dynamic tool call of this run: `close()` answers it, so Codex never waits on a run that is over. */
  hold(answer: () => void): (() => void) | undefined {
    if (this.closed) return undefined;
    this.calls.add(answer);
    return () => this.calls.delete(answer);
  }

  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) void this.respond(id);
    for (const answer of this.calls) answer();
  }
}

/** Protocol-specific denials, with an empty subset granting no additional permissions. */
export function approvalAnswer(method: string): JsonRpcAnswer | undefined {
  switch (method) {
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } satisfies PermissionsRequestApprovalResponse };
    case 'item/commandExecution/requestApproval':
      return { result: { decision: 'decline' } satisfies CommandExecutionRequestApprovalResponse };
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } satisfies FileChangeRequestApprovalResponse };
    case 'execCommandApproval':
      return { result: { decision: 'denied' } satisfies ExecCommandApprovalResponse };
    case 'applyPatchApproval':
      return { result: { decision: 'denied' } satisfies ApplyPatchApprovalResponse };
    default: return undefined;
  }
}

export function userInputRequest(
  params: unknown, id: JsonRpcId, serial: number, scope: CodexRequestScope | undefined,
  enqueue: (question: InboundQuestion) => void,
): Promise<JsonRpcAnswer | null> | JsonRpcAnswer {
  const parsed = inputSchema.safeParse(params);
  if (!parsed.success || !scope) return unavailable();
  const input = parsed.data satisfies ToolRequestUserInputParams;
  if (new Set(input.questions.map(q => q.id)).size !== input.questions.length) return unavailable();
  const requestId = `codex-request-${serial}`;
  const request = parseAskRequest({
    kind: 'choices', id: requestId, title: input.questions.some(q => q.isSecret || !q.options?.length) ? 'Codex 需要你回答' : 'Codex 需要你的选择',
    acceptedConsequence: '将所选选项发送给 Codex。', declinedConsequence: '不提供答案，交回 Codex 处理。',
    questions: input.questions.map((q, qi) => q.options?.length && !q.isSecret
      ? { id: `q${qi}`, title: q.header, detail: q.question, selection: 'single', other: q.isOther,
          options: q.options.map((option, oi) => ({ id: `o${oi}`, label: option.label, description: option.description })) }
      : { id: `q${qi}`, title: q.header, detail: q.question, selection: 'text', sensitive: q.isSecret }),
  });
  return new Promise(resolve => {
    let settled = false;
    const question: InboundQuestion = {
      kind: 'request', rpcId: id, threadId: input.threadId, turnId: input.turnId, request,
      cancel() {
        if (settled) return;
        settled = true;
        scope.forget(question);
        resolve(null); // The server already cleared this request; no second wire reply.
      },
      settle(resolution) {
        if (settled) return;
        settled = true;
        scope.forget(question);
        const answers = new Map<string, { answers: string[] }>();
        if (resolution?.kind === 'answered') {
          const texts = answerTexts(input.questions, resolution.answer);
          if (!texts) { resolve(unavailable()); return; }
          for (const [questionId, list] of texts) answers.set(questionId, { answers: list });
        }
        resolve({ result: { answers: Object.fromEntries(answers) } satisfies ToolRequestUserInputResponse });
      },
    };
    scope.add(question);
    enqueue(question);
  });
}

const toolCallSchema = z.object({
  threadId: z.string().min(1), turnId: z.string().min(1), callId: z.string(), namespace: z.string().nullish(), tool: z.string().min(1), arguments: z.unknown(),
});
const askUserArgsSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  questions: z.array(z.object({
    id: z.string().trim().min(1).max(64).optional(),
    header: z.string().trim().min(1).max(40),
    question: z.string().trim().min(1).max(1000),
    multiSelect: z.boolean().optional(),
    allowOther: z.boolean().optional(),
    options: z.array(z.object({
      label: z.string().trim().min(1).max(80),
      description: z.string().trim().max(300).optional(),
    })).max(10).optional(),
  })).min(1).max(3),
});
const toolAnswer = (text: string, success: boolean): JsonRpcAnswer => ({ result: { contentItems: [{ type: 'inputText', text }], success } satisfies DynamicToolCallResponse });

/** Bridge for `vonvon_bot.ask_user`: reuses the exact same InboundQuestion / AskCoordinator / buildAskCard pipeline. */
export interface DynamicAskHost {
  rpcId: JsonRpcId;
  nextSerial(): number;
  enqueue(question: InboundQuestion): void;
}

function dynamicAskUserCall(
  call: z.infer<typeof toolCallSchema>,
  scope: CodexRequestScope | undefined,
  askHost: DynamicAskHost | undefined,
): Promise<JsonRpcAnswer | null> | JsonRpcAnswer {
  if (!scope) return toolAnswer('这一轮已经结束了。', false);
  if (!askHost) return toolAnswer('当前会话暂不支持发飞书选择卡，请改用简洁文字向用户提问。', false);
  const parsed = askUserArgsSchema.safeParse(call.arguments);
  if (!parsed.success) {
    const detail = parsed.error.issues.map(i => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('；');
    return toolAnswer(`参数不对：${detail}`, false);
  }
  const args = parsed.data;
  const requestId = `codex-ask-${askHost.nextSerial()}`;
  const request = parseAskRequest({
    kind: 'choices',
    id: requestId,
    title: args.title || (args.questions.length === 1 ? args.questions[0]!.header : '需要你的选择'),
    acceptedConsequence: '将你的选择或填写内容发回继续处理。',
    declinedConsequence: '15 分钟未回答或取消后，本轮由模型决定继续或停下等待。',
    questions: args.questions.map((q, qi) => q.options?.length
      ? {
          id: `q${qi}`,
          title: q.header,
          detail: q.question,
          selection: q.multiSelect ? 'multiple' : 'single',
          other: q.allowOther ?? true,
          options: q.options.map((opt, oi) => ({ id: `o${oi}`, label: opt.label, description: opt.description ?? '' })),
        }
      : { id: `q${qi}`, title: q.header, detail: q.question, selection: 'text' }),
  });

  return new Promise(resolve => {
    let settled = false;
    const question: InboundQuestion = {
      kind: 'request',
      rpcId: askHost.rpcId,
      threadId: call.threadId,
      turnId: call.turnId,
      request,
      cancel() {
        if (settled) return;
        settled = true;
        scope.forget(question);
        resolve(null);
      },
      settle(resolution) {
        if (settled) return;
        settled = true;
        scope.forget(question);
        if (!resolution) {
          resolve(toolAnswer('这一轮已经结束了。', false));
          return;
        }
        if (resolution.kind === 'unanswered') {
          if (resolution.reason === 'timeout') {
            resolve(toolAnswer('用户 15 分钟没有在卡片上回答。先停下来，或简短说明还需要什么。', false));
          } else if (resolution.reason === 'stopped') {
            resolve(toolAnswer('用户停止了这一轮。', false));
          } else {
            resolve(toolAnswer('选择卡没能发出或本轮已结束。请改用简洁文字向用户提问并等待回复。', false));
          }
          return;
        }
        const answer = resolution.answer;
        if (answer.kind === 'text') {
          const mapped = args.questions.map((q, qi) => ({ id: q.id ?? `q${qi}`, header: q.header, text: answer.text }));
          resolve(toolAnswer(JSON.stringify({ answered: true, answers: mapped }), true));
          return;
        }
        if (answer.kind !== 'choices') {
          resolve(toolAnswer('收到了不匹配的卡片回答，请改用文字向用户确认。', false));
          return;
        }
        const mapped = args.questions.map((q, qi) => {
          const item = answer.answers.find(a => a.questionId === `q${qi}`);
          if (!item) return { id: q.id ?? `q${qi}`, header: q.header, unanswered: true };
          if ('text' in item) return { id: q.id ?? `q${qi}`, header: q.header, text: item.text };
          const selected = item.selected
            .map(optionId => q.options?.find((_opt, oi) => optionId === `o${oi}`)?.label)
            .filter((label): label is string => Boolean(label));
          return { id: q.id ?? `q${qi}`, header: q.header, selected };
        });
        resolve(toolAnswer(JSON.stringify({ answered: true, answers: mapped }), true));
      },
    };
    scope.add(question);
    if (!settled) askHost.enqueue(question);
  });
}

/** The thread an `item/tool/call` names: its vonvon entry, and when its turn's turn/start answered. */
export interface DynamicToolHost {
  entry: AgentEntry;
  /** true once `turnId`'s turn/start answered (the entry then knows that turn), false if it did not within `ms`. */
  turnAcked(turnId: string, ms: number): Promise<boolean>;
}

/**
 * `item/tool/call` (定时任务 T3b): run the call through the thread's entry, bound to the turn Codex names, the way
 * Claude's calls are bound by tool-use id. Every refusal is an answer with `success: false`, never a JSON-RPC error.
 */
export function dynamicToolCall(params: unknown, scope: CodexRequestScope | undefined,
  lookup: (threadId: string) => DynamicToolHost | undefined,
  askHost?: DynamicAskHost): Promise<JsonRpcAnswer | null> | JsonRpcAnswer {
  const parsed = toolCallSchema.safeParse(params);
  if (!parsed.success) return toolAnswer('vonvon 看不懂这次工具调用。', false);
  const call = parsed.data, host = lookup(call.threadId);
  log.info('agent', 'dynamic-tool-call', { callId: call.callId, tool: call.tool, known: Boolean(host) });
  const over = () => toolAnswer('这一轮已经结束了。', false);
  if (!host) return toolAnswer('这不是本 bot 的线程，vonvon 的工具在这里不能用。', false);
  if (!offeredTool(call.namespace, call.tool)) return toolAnswer('没有这个工具。', false);
  if (call.tool === ASK_USER_TOOL) {
    return dynamicAskUserCall(call, scope, askHost);
  }
  return new Promise(resolve => {
    let answered = false;
    const answer = (reply: JsonRpcAnswer) => { if (!answered) { answered = true; drop?.(); resolve(reply); } };
    const drop = scope?.hold(() => answer(over()));
    if (!drop) { answer(over()); return; }
    // A call can come in before its turn's turn/start answer; one whose turn never answered (a goal's) is unknown-origin.
    void host.turnAcked(call.turnId, 2_000).then(async acked => {
      if (answered) return;
      const reply = await host.entry.call(call.tool, call.arguments, acked ? { toolUseId: call.turnId } : undefined);
      answer(toolAnswer(toolReplyText(reply), reply.ok));
    }).catch(error => {
      log.fail('agent', error, { phase: 'dynamic-tool-call' });
      answer(toolAnswer('vonvon 这一步出错了。', false));
    });
  });
}
