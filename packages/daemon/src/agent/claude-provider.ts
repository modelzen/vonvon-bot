import { getSessionInfo, getSessionMessages, listSessions, query, renameSession, type EffortLevel, type Query } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../core/logger';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from './bridge-instructions';
import { ClaudeAgentClient } from './providers/claude/agent';
import type { ClaudeQueryFactory } from './providers/claude/query';
import type { Logger } from './paseo/logger';
import { checkProviderLaunchAvailable, resolveProviderLaunch } from './paseo/provider-launch-config';
import { SessionBackend, claudeSessionConfigFor } from './paseo/session-backend';
import { createClaudeSessionObservation, listClaudeThreads, readClaudeHistory, type ClaudeSessionStore } from './paseo-claude-wrapper';
import type { AgentClient, AgentModelDefinition } from './paseo/agent-sdk-types';
import type { AgentBackend, BackendProbe, GenerateSessionTitleOptions, ModelInfo, ReasoningEffort } from './types';

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
  history?: ClaudeSessionStore;
}

export type ClaudeBackend = SessionBackend & Required<Pick<AgentBackend,
  'readSessionTitle' | 'setSessionTitle' | 'generateSessionTitle'>>;

const sdkTitles: ClaudeSdkTitles = { getSessionInfo, renameSession, query };
const effortByThinkingOption = new Map<string, ReasoningEffort>([
  ['off', 'none'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['xhigh', 'xhigh'],
  ['max', 'max'],
  ['ultracode', 'ultra'],
]);
const thinkingOptionByEffort = new Map(
  Array.from(effortByThinkingOption, ([option, effort]) => [effort, option]),
);

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
  const supportedEfforts = (model.thinkingOptions ?? []).flatMap((option) => {
    const effort = effortByThinkingOption.get(option.id);
    return effort ? [effort] : [];
  });
  const providerDefault = effortByThinkingOption.get(model.defaultThinkingOptionId ?? '');
  const defaultEffort = supportedEfforts.find((effort) => effort === providerDefault)
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
  const makeClient = (queryFactory?: ClaudeQueryFactory): AgentClient => bridgeClient(new ClaudeAgentClient({
    logger: dependencies.logger ?? daemonLogger(), queryFactory,
    resolveBinary: dependencies.resolveBinary ?? resolveClaudeExecutable,
    resolveVersion: dependencies.resolveVersion,
  }));
  const client = dependencies.client ? bridgeClient(dependencies.client) : makeClient();
  const history = dependencies.history ?? { listSessions, getSessionMessages };
  const titles = dependencies.titles ?? sdkTitles;
  return new class extends SessionBackend {
    constructor() {
      super(client, {
        id: 'claude-agent', displayName: 'Claude',
        ...(!dependencies.client ? { createThreadContext: () => {
          const repair = createClaudeSessionObservation(dependencies.queryFactory);
          return { client: makeClient(repair.queryFactory), repair };
        } } : {}),
        capabilities: { goal: true, steer: true, compact: true, resume: true, approvals: false },
        supportedModes: ['qa', 'write', 'full'],
        configFor: (options) => ({
          ...claudeSessionConfigFor(options),
          ...(options.model ? { model: options.model } : {}),
          daemonAppendSystemPrompt: BRIDGE_DEVELOPER_INSTRUCTIONS,
        }),
        thinkingOptionFor: (effort) => thinkingOptionByEffort.get(effort) ?? effort,
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
        listThreads: (cwd, limit) => listClaudeThreads(history, cwd, limit),
        readHistory: (cwd, sessionId, maxTurns) => readClaudeHistory(history, cwd, sessionId, maxTurns),
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
