import { getSessionInfo, query, renameSession, type EffortLevel, type Query } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../core/logger';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from './bridge-instructions';
import { ClaudeAgentClient } from './providers/claude/agent';
import type { ClaudeQueryFactory } from './providers/claude/query';
import type { Logger } from './paseo/logger';
import { checkProviderLaunchAvailable, resolveProviderLaunch } from './paseo/provider-launch-config';
import { SessionBackend, claudeSessionConfigFor } from './paseo/session-backend';
import type { AgentClient, AgentModelDefinition, AgentSession, AgentTimelineItem } from './paseo/agent-sdk-types';
import type { AgentBackend, BackendProbe, GenerateSessionTitleOptions, HistoryTurn, ModelInfo, ThreadHistory, ThreadSummary } from './types';

type ClaudeSdkTitles = {
  getSessionInfo: typeof getSessionInfo;
  renameSession: typeof renameSession;
  query: typeof query;
};

export interface ClaudeProviderDependencies {
  client?: AgentClient;
  logger?: Logger;
  queryFactory?: ClaudeQueryFactory;
  resolveBinary?: () => Promise<string>;
  resolveVersion?: (signal?: AbortSignal) => Promise<string>;
  titles?: ClaudeSdkTitles;
}

export type ClaudeBackend = SessionBackend & Required<Pick<AgentBackend,
  'readSessionTitle' | 'setSessionTitle' | 'generateSessionTitle'>>;

const sdkTitles: ClaudeSdkTitles = { getSessionInfo, renameSession, query };
const efforts = ['low', 'medium', 'high', 'xhigh'] as const;

async function resolveClaudeExecutable(): Promise<string> {
  const launch = await resolveProviderLaunch({ defaultBinary: 'claude' });
  const availability = await checkProviderLaunchAvailable(launch);
  if (!availability.available) throw new Error('Claude Code 未安装；请安装 claude 命令并加入 PATH');
  return availability.resolvedPath ?? launch.command;
}

function daemonLogger(bindings: Record<string, unknown> = {}): Logger {
  const write = (level: 'trace' | 'debug' | 'info' | 'warn' | 'error', first: unknown, second?: string): void => {
    const fields = typeof first === 'object' && first !== null ? first as Record<string, unknown> : {};
    const message = second ?? (typeof first === 'string' ? first : 'provider event');
    const payload = { ...bindings, ...fields, message };
    if (level === 'error') log.fail('agent', fields.err ?? message, payload);
    else if (level === 'warn') log.warn('agent', 'claude.provider', payload);
    else log.info('agent', 'claude.provider', { ...payload, level });
  };
  return {
    child: (childBindings) => daemonLogger({ ...bindings, ...childBindings }),
    trace: write.bind(null, 'trace'),
    debug: write.bind(null, 'debug'),
    info: write.bind(null, 'info'),
    warn: write.bind(null, 'warn'),
    error: write.bind(null, 'error'),
  };
}

function bridgeClient(client: AgentClient): AgentClient {
  const launchEnv = { FEISHU_CODEX_BRIDGE: '1', CLAUDE_CODE_ENTRYPOINT: 'feishu-codex-bridge' };
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'createSession') {
        const create: AgentClient['createSession'] = (config, context, options) =>
          target.createSession(config, { ...context, env: { ...context?.env, ...launchEnv } }, options);
        return create;
      }
      if (property === 'resumeSession') {
        const resume: AgentClient['resumeSession'] = (handle, overrides, context, options) =>
          target.resumeSession(handle, overrides, { ...context, env: { ...context?.env, ...launchEnv } }, options);
        return resume;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function mapModel(model: AgentModelDefinition): ModelInfo {
  const supportedEfforts = efforts.filter((effort) => model.thinkingOptions?.some((option) => option.id === effort));
  const defaultEffort = supportedEfforts.find((effort) => effort === model.defaultThinkingOptionId)
    ?? supportedEfforts.find((effort) => effort === 'high') ?? supportedEfforts[0] ?? 'medium';
  return {
    id: model.id,
    displayName: model.label,
    description: model.description ?? '',
    supportedEfforts: [...supportedEfforts],
    defaultEffort,
    isDefault: model.isDefault === true,
    hidden: false,
  };
}

function historyFromItems(items: AgentTimelineItem[], maxTurns: number): ThreadHistory {
  const turns: HistoryTurn[] = [];
  let current: HistoryTurn | undefined;
  let toolsById = new Map<string, HistoryTurn['tools'][number]>();
  const start = (): HistoryTurn => current ??= { userText: '', assistantText: '', reasoning: '', tools: [] };
  for (const item of items) {
    if (item.type === 'user_message') {
      if (current && (current.userText || current.assistantText || current.tools.length)) turns.push(current);
      current = { userText: item.text, assistantText: '', reasoning: '', tools: [] };
      toolsById = new Map();
    } else if (item.type === 'assistant_message') {
      start().assistantText += item.text;
    } else if (item.type === 'reasoning') {
      start().reasoning += item.text;
    } else if (item.type === 'tool_call') {
      const turn = start();
      let tool = toolsById.get(item.callId);
      if (!tool) {
        tool = { title: item.detail.type === 'shell' && typeof item.detail.command === 'string' ? item.detail.command : item.name };
        turn.tools.push(tool);
        toolsById.set(item.callId, tool);
      }
      const output = item.detail.type === 'shell' ? item.detail.output : undefined;
      if (typeof output === 'string') tool.output = output;
      else if (typeof item.error === 'string') tool.output = item.error;
      if (item.status === 'failed') tool.failed = true;
      if (item.detail.type === 'shell' && typeof item.detail.exitCode === 'number') tool.exitCode = item.detail.exitCode;
    }
  }
  if (current && (current.userText || current.assistantText || current.tools.length)) turns.push(current);
  return { turns: turns.slice(-maxTurns), totalTurns: turns.length };
}

async function readProviderHistory(client: AgentClient, cwd: string, sessionId: string, maxTurns: number): Promise<ThreadHistory> {
  let session: AgentSession | undefined;
  try {
    session = await client.resumeSession(
      { provider: 'claude', sessionId, metadata: { cwd } },
      { provider: 'claude', cwd },
      undefined,
      { purpose: 'history' },
    );
    const items: AgentTimelineItem[] = [];
    for await (const event of session.streamHistory()) if (event.type === 'timeline') items.push(event.item);
    return historyFromItems(items, maxTurns);
  } catch (error) {
    log.fail('agent', error, { backend: 'claude-agent', phase: 'streamHistory', sessionId });
    return { turns: [], totalTurns: 0 };
  } finally {
    try { await session?.close(); }
    catch (error) { log.fail('agent', error, { backend: 'claude-agent', phase: 'closeHistorySession', sessionId }); }
  }
}

async function generateTitle(sdk: ClaudeSdkTitles, options: GenerateSessionTitleOptions): Promise<string | undefined> {
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort)) {
    throw new Error(`Claude SDK does not support title effort ${options.effort}`);
  }
  const effort = options.effort as EffortLevel;
  const abortController = new AbortController();
  const titleQuery = sdk.query({
    prompt: options.prompt,
    options: {
      cwd: options.cwd, model: options.model, effort,
      abortController, persistSession: false, maxTurns: 1,
      tools: [], skills: [], mcpServers: {}, settingSources: [],
      outputFormat: {
        type: 'json_schema',
        schema: { type: 'object', properties: { title: { type: 'string', maxLength: 36 } }, required: ['title'], additionalProperties: false },
      },
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      consumeTitle(titleQuery),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new Error('Claude title generation timed out after 30000ms'));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    abortController.abort();
    titleQuery.close();
  }
}

async function consumeTitle(titleQuery: Query): Promise<string | undefined> {
  for await (const message of titleQuery) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') throw new Error(message.errors.join('; ') || `Claude title query failed: ${message.subtype}`);
    const structured = message.structured_output;
    if (structured && typeof structured === 'object' && 'title' in structured && typeof structured.title === 'string') return structured.title.trim() || undefined;
    const text = message.result.trim();
    if (!text) return undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'title' in parsed && typeof parsed.title === 'string') return parsed.title.trim() || undefined;
    } catch { /* Older SDKs may return plain text. */ }
    return text;
  }
  throw new Error('Claude title query closed before returning a result');
}

export function createClaudeBackend(dependencies: ClaudeProviderDependencies = {}): ClaudeBackend {
  const client = bridgeClient(dependencies.client ?? new ClaudeAgentClient({
    logger: dependencies.logger ?? daemonLogger(),
    queryFactory: dependencies.queryFactory,
    resolveBinary: dependencies.resolveBinary ?? resolveClaudeExecutable,
    resolveVersion: dependencies.resolveVersion,
  }));
  const titles = dependencies.titles ?? sdkTitles;
  return new class extends SessionBackend {
    constructor() {
      super(client, {
        id: 'claude-agent', displayName: 'Claude',
        capabilities: { goal: true, steer: true, compact: true, resume: true, approvals: false },
        supportedModes: ['qa', 'write', 'full'],
        configFor: (options) => ({
          ...claudeSessionConfigFor(options),
          ...(options.model ? { model: options.model } : {}),
          daemonAppendSystemPrompt: BRIDGE_DEVELOPER_INSTRUCTIONS,
        }),
        thinkingOptionFor: (effort) => effort === 'ultra' ? 'ultracode' : effort,
        doctor: async (): Promise<BackendProbe> => {
          try {
            const ok = await client.isAvailable();
            return { ok, version: null, location: 'claude', depState: ok ? 'installed' : 'external-missing',
              hint: ok ? '复用本机 Claude 登录态（未登录请先 `claude` 登录，或设置 ANTHROPIC_API_KEY）' : 'Claude Code 未安装；请安装 claude 命令并加入 PATH' };
          } catch (error) {
            return { ok: false, version: null, depState: 'external-missing', hint: error instanceof Error ? error.message : 'Claude Code 未安装' };
          }
        },
        models: async () => (await client.fetchCatalog({ scope: 'global', force: false })).models
          .filter((model) => model.isSelectable !== false).map(mapModel),
        listThreads: async (cwd, limit): Promise<ThreadSummary[]> => {
          try {
            const sessions = await client.listImportableSessions?.({ cwd, limit }) ?? [];
            return sessions.map((session) => ({
              sessionId: session.providerHandleId,
              preview: session.firstPromptPreview ?? '',
              createdAt: Math.floor(session.lastActivityAt.getTime() / 1000),
              updatedAt: Math.floor(session.lastActivityAt.getTime() / 1000),
              ...(session.title ? { name: session.title } : {}),
            }));
          } catch (error) {
            log.fail('agent', error, { backend: 'claude-agent', phase: 'listImportableSessions' });
            return [];
          }
        },
        readHistory: (cwd, sessionId, maxTurns) => readProviderHistory(client, cwd, sessionId, maxTurns),
      });
    }

    async readSessionTitle(cwd: string, sessionId: string): Promise<string | undefined> {
      const session = await titles.getSessionInfo(sessionId, { dir: cwd });
      return session?.customTitle?.trim() || undefined;
    }

    async setSessionTitle(cwd: string, sessionId: string, title: string): Promise<void> {
      const clean = title.trim();
      if (!clean) throw new Error('Cannot set an empty Claude session title');
      await titles.renameSession(sessionId, clean, { dir: cwd });
    }

    generateSessionTitle(options: GenerateSessionTitleOptions): Promise<string | undefined> {
      return generateTitle(titles, options);
    }
  }();
}
