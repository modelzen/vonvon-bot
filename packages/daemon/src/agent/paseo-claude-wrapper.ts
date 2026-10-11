import { query, type Query, type SDKMessage, type SDKSessionInfo, type SessionMessage, type listSessions, type getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { log } from '../core/logger';
import { readEventIdentifiers } from './providers/claude/agent';
import type { ClaudeQueryFactory } from './providers/claude/query';
import type { GoalFailureStatus, SessionEventRepair } from './paseo/session-backend';
import type { AgentEvent, HistoryTool, HistoryTurn, ThreadHistory, ThreadSummary } from './types';

const blockSchema = z.object({
  type: z.string(), text: z.string().optional(), thinking: z.string().optional(),
  id: z.string().optional(), name: z.string().optional(), input: z.record(z.string(), z.unknown()).optional(),
  tool_use_id: z.string().optional(), is_error: z.boolean().optional(), content: z.unknown().optional(),
});
type Block = z.infer<typeof blockSchema>;
const contentSchema = z.object({ content: z.unknown().optional() });

function blocksOf(message: unknown): Block[] {
  const parsed = contentSchema.safeParse(message);
  if (!parsed.success) return [];
  const content = parsed.data.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value: unknown) => {
    const block = blockSchema.safeParse(value);
    return block.success ? [block.data] : [];
  });
}

export function observeClaudeQuery(target: Query, observe: (message: SDKMessage) => void): Query {
  const observed = (result: IteratorResult<SDKMessage, void>): IteratorResult<SDKMessage, void> => {
    if (!result.done) observe(result.value);
    return result;
  };
  const next: Query['next'] = async (...args) => observed(await target.next(...args));
  const finish: Query['return'] = async (...args) => observed(await target.return(...args));
  const fail: Query['throw'] = async (...args) => observed(await target.throw(...args));
  const proxy = new Proxy(target, {
    get(queryTarget, property) {
      if (property === 'next') return next;
      if (property === 'return') return finish;
      if (property === 'throw') return fail;
      if (property === Symbol.asyncIterator) return () => proxy;
      const value: unknown = Reflect.get(queryTarget, property, queryTarget);
      return typeof value === 'function' ? value.bind(queryTarget) : value;
    },
  });
  return proxy;
}

type Result = Extract<SDKMessage, { type: 'result' }>;
type Failure = Extract<AgentEvent, { type: 'error' }>;
interface TurnFacts {
  emit: (event: AgentEvent) => void;
  setGoalFailureStatus?: (status: GoalFailureStatus) => void;
  failure?: Failure;
  failedAssistantIds: Set<string>;
  result?: Result;
  toolInputs: Map<string, { name: string; input: Record<string, unknown> }>;
}

export interface ClaudeSessionObservation extends SessionEventRepair {
  readonly queryFactory: ClaudeQueryFactory;
}

export function createClaudeSessionObservation(rawQueryFactory: ClaudeQueryFactory = query): ClaudeSessionObservation {
  let turn: TurnFacts | undefined;
  let initModel: string | undefined;
  const observe = (message: SDKMessage): void => {
    if (message.type === 'system' && message.subtype === 'init') {
      initModel = message.model;
    }
    if (!turn) return;
    const rawType: string = message.type;
    if (rawType === 'api_retry' || rawType === 'system_api_retry') {
      turn.emit({ type: 'error', message: '网络波动，正在重试…', willRetry: true });
    }
    if (message.type === 'assistant' && message.parent_tool_use_id == null) {
      const blocks = blocksOf(message.message);
      const apiError = 'isApiErrorMessage' in message && message.isApiErrorMessage === true;
      if (message.error !== 'max_output_tokens' && (message.error || apiError)) {
        const messageId = readEventIdentifiers(message).messageId;
        if (messageId) turn.failedAssistantIds.add(messageId);
        const text = blocks.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n').trim();
        turn.failure ??= { type: 'error', message: text || `模型服务请求失败（${message.error ?? 'unknown'}）`, willRetry: false };
      }
      for (const block of blocks) {
        if ((block.type === 'tool_use' || block.type === 'server_tool_use') && block.id && block.name && block.input) {
          turn.toolInputs.set(block.id, { name: block.name, input: block.input });
        }
      }
    } else if (message.type === 'result') {
      turn.result = message;
    }
  };
  return {
    queryFactory: (input) => observeClaudeQuery(rawQueryFactory(input), observe),
    beginTurn(emit, setGoalFailureStatus) {
      turn = { emit, setGoalFailureStatus, toolInputs: new Map(), failedAssistantIds: new Set() };
      setGoalFailureStatus?.('blocked');
    },
    endTurn() { turn = undefined; },
    repair(event, mapped) {
      if (!turn) return mapped;
      if (event.type === 'usage_updated' && turn.result) return [];
      if (event.type === 'timeline' && event.item.type === 'assistant_message'
        && event.item.messageId && turn.failedAssistantIds.has(event.item.messageId)) return [];
      if (event.type === 'turn_completed' || event.type === 'turn_failed') {
        const usage = turn.result ? resultUsage(turn.result, initModel) : [];
        const terminal = turn.failure ?? (event.type === 'turn_failed' && turn.result
          ? { type: 'error', message: resultErrorText(turn.result), willRetry: false } satisfies Failure
          : undefined);
        if (terminal) {
          turn.setGoalFailureStatus?.(!turn.failure && turn.result?.subtype === 'error_max_budget_usd' ? 'budgetLimited' : 'blocked');
        }
        const completion = terminal ? [terminal] : mapped.filter((item) => item.type !== 'usage' && item.type !== 'context_usage');
        return turn.result ? [...usage, ...completion] : terminal ? [terminal] : mapped;
      }
      return mapped.map((item) => {
        if (item.type !== 'tool_use') return item;
        const tool = turn?.toolInputs.get(item.itemId);
        const description = tool?.name === 'Bash' ? tool.input.description : undefined;
        return typeof description === 'string' && description ? { ...item, detail: description } : item;
      });
    },
  };
}

function resultUsage(result: Result, initModel: string | undefined): AgentEvent[] {
  const usage = result.usage;
  if (!usage) return [];
  const events: AgentEvent[] = [{ type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }];
  const usedTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  if (usedTokens > 0) {
    const models = result.modelUsage ?? {};
    const exactWindow = initModel ? models[initModel]?.contextWindow : undefined;
    const singleModel = Object.values(models);
    const reportedWindow = exactWindow ?? (singleModel.length === 1 ? singleModel[0]?.contextWindow : undefined);
    const contextWindow = typeof reportedWindow === 'number' && reportedWindow > 0 ? reportedWindow
      : initModel ? initModel.toLowerCase().includes('1m') ? 1_000_000 : 200_000 : null;
    events.push({ type: 'context_usage', usedTokens, contextWindow });
  }
  return events;
}

function resultErrorText(result: Result): string {
  if ('errors' in result) {
    const errors = result.errors.filter((error) => typeof error === 'string' && error.trim());
    if (errors.length) return errors.join('\n');
  }
  if ('result' in result && result.result.trim()) return result.result.trim();
  if (result.subtype === 'error_max_turns') return '已达到最大轮次限制';
  if (result.subtype === 'error_max_budget_usd') return '已达到预算上限';
  return `运行出错（${result.subtype}）`;
}

export interface ClaudeSessionStore {
  listSessions: typeof listSessions;
  getSessionMessages: typeof getSessionMessages;
}

export async function listClaudeThreads(store: ClaudeSessionStore, cwd: string, limit: number): Promise<ThreadSummary[]> {
  try {
    return (await store.listSessions({ dir: cwd, limit })).map(mapSessionSummary).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (error) {
    log.fail('agent', error, { backend: 'claude-agent', phase: 'listSessions' });
    return [];
  }
}

export async function readClaudeHistory(store: ClaudeSessionStore, cwd: string, sessionId: string, maxTurns: number): Promise<ThreadHistory> {
  try {
    return foldSessionMessages(await store.getSessionMessages(sessionId, { dir: cwd }), maxTurns, cwd);
  } catch (error) {
    log.fail('agent', error, { backend: 'claude-agent', phase: 'getSessionMessages', sessionId });
    return { turns: [], totalTurns: 0 };
  }
}

function mapSessionSummary(s: SDKSessionInfo): ThreadSummary {
  const preview = (s.customTitle || s.summary || s.firstPrompt || '').trim();
  return {
    sessionId: s.sessionId,
    preview,
    createdAt: msToSec(s.createdAt ?? s.lastModified),
    updatedAt: msToSec(s.lastModified),
    name: s.customTitle || undefined,
  };
}

function msToSec(ms: number | undefined): number {
  return ms && ms > 0 ? Math.floor(ms / 1000) : 0;
}

function isBoilerplateUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('# AGENTS.md') ||
    t.startsWith('<system-reminder>') ||
    t.startsWith('Caveat:')
  );
}

function toolResultText(content: unknown): string | undefined {
  if (content == null) return undefined;
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    const text = content
      .map((value: unknown) => {
        const parsed = blockSchema.safeParse(value);
        return parsed.success && parsed.data.type === 'text' ? parsed.data.text ?? '' : '';
      })
      .join('')
      .trim();
    return text || undefined;
  }
  return undefined;
}

function foldSessionMessages(messages: SessionMessage[], maxTurns: number, cwd?: string): ThreadHistory {
  const turns: HistoryTurn[] = [];
  const toolById = new Map<string, HistoryTool>();
  let cur: (HistoryTurn & { _hasContent: boolean }) | null = null;

  const flush = (): void => {
    if (cur && cur._hasContent) {
      const { _hasContent, ...turn } = cur;
      void _hasContent;
      turns.push(turn);
    }
    cur = null;
  };
  const ensure = (): HistoryTurn & { _hasContent: boolean } => {
    if (!cur) cur = { userText: '', assistantText: '', reasoning: '', tools: [], _hasContent: false };
    return cur;
  };

  for (const msg of messages) {
    const blocks = blocksOf(msg.message);
    if (msg.type === 'user') {
      const texts: string[] = [];
      let attachedResult = false;
      for (const b of blocks) {
        if (b.type === 'text' && b.text && !isBoilerplateUserText(b.text)) texts.push(b.text);
        else if (b.type === 'tool_result' && b.tool_use_id) {
          const tool = toolById.get(b.tool_use_id);
          if (tool) {
            tool.output = toolResultText(b.content);
            if (b.is_error) tool.failed = true;
            attachedResult = true;
          }
        }
      }
      const userText = texts.join('\n').trim();
      if (userText) {
        flush();
        const t = ensure();
        t.userText = userText;
        t._hasContent = true;
      } else if (attachedResult) {
        ensure()._hasContent = true;
      }
    } else if (msg.type === 'assistant') {
      const t = ensure();
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          t.assistantText = t.assistantText ? `${t.assistantText}\n\n${b.text}` : b.text;
          t._hasContent = true;
        } else if (b.type === 'thinking' && b.thinking) {
          t.reasoning = t.reasoning ? `${t.reasoning}\n\n${b.thinking}` : b.thinking;
          t._hasContent = true;
        } else if ((b.type === 'tool_use' || b.type === 'server_tool_use') && b.id) {
          const tool: HistoryTool = { title: toolTitle(b.name ?? '工具', b.input ?? {}, cwd) };
          t.tools.push(tool);
          toolById.set(b.id, tool);
          t._hasContent = true;
        }
      }
    }
  }
  flush();

  const totalTurns = turns.length;
  const kept = totalTurns > maxTurns ? turns.slice(totalTurns - maxTurns) : turns;
  return { turns: kept, totalTurns };
}

function toolTitle(name: string, input: Record<string, unknown>, cwd?: string): string {
  const s = (k: string): string => (typeof input[k] === 'string' ? input[k] : '');
  switch (name) {
    case 'Bash':
    case 'BashOutput':
      return s('command') || 'Shell 命令';
    case 'Read':
      return `读取 ${displayPath(s('file_path'), cwd)}`;
    case 'Write':
      return `写入 ${displayPath(s('file_path'), cwd)}`;
    case 'Edit':
    case 'MultiEdit':
      return `编辑 ${displayPath(s('file_path'), cwd)}`;
    case 'NotebookEdit':
      return `编辑笔记本 ${displayPath(s('notebook_path'), cwd)}`;
    case 'Glob':
      return `查找 ${s('pattern')}`.trim();
    case 'Grep':
      return `搜索 ${s('pattern')}`.trim();
    case 'WebFetch':
      return `抓取网页 ${s('url')}`.trim();
    case 'WebSearch':
      return `联网搜索 ${s('query')}`.trim();
    case 'Task':
      return `子任务：${s('description') || s('subagent_type') || ''}`.trim();
    case 'TodoWrite':
      return '更新待办清单';
    case 'ExitPlanMode':
      return '提交方案';
    default:
      return name || '工具调用';
  }
}

const PATH_TAIL_MAX = 40;
function displayPath(p: string, cwd?: string): string {
  if (!p) return '文件';
  if (cwd) {
    const sep = cwd.includes('\\') ? '\\' : '/';
    const root = cwd.endsWith(sep) ? cwd : cwd + sep;
    if (p.startsWith(root) && p.length > root.length) return p.slice(root.length);
  }
  if (p.length <= PATH_TAIL_MAX || !p.includes('/')) return p;
  const segs = p.split('/');
  let out = segs[segs.length - 1] ?? p;
  for (let i = segs.length - 2; i >= 0; i--) {
    const cand = `${segs[i]}/${out}`;
    if (cand.length > PATH_TAIL_MAX) break;
    out = cand;
  }
  return `…/${out}`;
}

