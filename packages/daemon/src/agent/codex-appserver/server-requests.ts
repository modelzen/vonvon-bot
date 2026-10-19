import { z } from 'zod';
import { log } from '../../core/logger';
import { parseAskRequest, type AskAnswer, type AskRequest, type AskResolution } from '../types';
import type { JsonRpcAnswer, JsonRpcId } from '../../provider/transport/jsonrpc';
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

  close(): void {
    this.closed = true;
    for (const id of this.pending.keys()) void this.respond(id);
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
  // s33b maps isSecret to sensitive; until then, keep secret questions unavailable.
  if (input.questions.some(q => q.isSecret) || new Set(input.questions.map(q => q.id)).size !== input.questions.length) return unavailable();
  const requestId = `codex-request-${serial}`;
  const request = parseAskRequest({
    kind: 'choices', id: requestId, title: input.questions.some(q => !q.options?.length) ? 'Codex 需要你回答' : 'Codex 需要你的选择',
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
