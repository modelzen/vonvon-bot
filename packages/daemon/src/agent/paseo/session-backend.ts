import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AgentBackend, AgentCapabilities, AgentEvent, AgentInput, AgentRun, AgentThread, BackendProbe, CompactResult, ModelInfo, PermissionMode, ReasoningEffort, ResumeThreadOptions, StartThreadOptions, ThreadHistory, ThreadSummary, TurnOptions } from '../types';
import { getAgentStreamEventTurnId, type AgentClient, type AgentPromptInput, type AgentSession, type AgentSessionConfig, type AgentStreamEvent, type AgentTimelineItem } from './agent-sdk-types';

class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value, done: false });
    } else this.values.push(value);
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
      } else if (this.closed) return;
      else {
        const next = await new Promise<IteratorResult<T>>((resolve) => { this.waiting = resolve; });
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

function toolTitle(item: Extract<AgentTimelineItem, { type: 'tool_call' }>): string {
  const detail = item.detail;
  if (detail.type === 'shell' && typeof detail.command === 'string') return detail.command;
  if ((detail.type === 'read' || detail.type === 'edit' || detail.type === 'write') && typeof detail.filePath === 'string') return detail.filePath;
  return item.name;
}

function toolKind(item: Extract<AgentTimelineItem, { type: 'tool_call' }>): 'command' | 'file' | 'search' | 'tool' {
  switch (item.detail.type) {
    case 'shell': return 'command';
    case 'read':
    case 'edit':
    case 'write': return 'file';
    case 'search': return 'search';
    default: return 'tool';
  }
}

function toolOutput(item: Extract<AgentTimelineItem, { type: 'tool_call' }>): string | undefined {
  const detail = item.detail;
  if (item.status === 'failed') {
    if (item.error instanceof Error) return item.error.message;
    if (typeof item.error === 'string') return item.error;
  }
  switch (detail.type) {
    case 'shell': return detail.output;
    case 'read': return detail.content;
    case 'search': return detail.content;
    case 'fetch': return detail.result;
    case 'worktree_setup': return detail.log;
    case 'sub_agent': return detail.log;
    case 'plain_text': return detail.text;
    case 'plan': return detail.text;
    case 'unknown': return typeof detail.output === 'string' ? detail.output : detail.output == null ? undefined : JSON.stringify(detail.output);
    case 'edit':
    case 'write': return undefined;
  }
}

function appendOrReplace(current: string, next: string): string {
  if (!current) return next;
  return next.startsWith(current) ? next : `${current}${next}`;
}

function mapTimeline(item: AgentTimelineItem, textById: Map<string, string>): AgentEvent[] {
  switch (item.type) {
    case 'assistant_message': {
      const itemId = item.messageId ?? 'assistant';
      const text = appendOrReplace(textById.get(itemId) ?? '', item.text);
      textById.set(itemId, text);
      return [{ type: 'text', itemId, text }];
    }
    case 'reasoning': {
      const itemId = 'reasoning';
      const text = appendOrReplace(textById.get(itemId) ?? '', item.text);
      textById.set(itemId, text);
      return [{ type: 'thinking', itemId, text }];
    }
    case 'tool_call': {
      if (item.status === 'running') return [{ type: 'tool_use', itemId: item.callId, title: toolTitle(item), kind: toolKind(item) }];
      const output = toolOutput(item);
      const exitCode = item.detail.type === 'shell' && typeof item.detail.exitCode === 'number'
        ? item.detail.exitCode : item.status === 'failed' ? 1 : undefined;
      return [{ type: 'tool_result', itemId: item.callId, ...(output ? { output } : {}), ...(exitCode !== undefined ? { exitCode } : {}) }];
    }
    case 'compaction': return item.status === 'completed' ? [{ type: 'context_compacted' }] : [];
    case 'error': return [{ type: 'error', message: item.message, willRetry: false }];
    case 'notification': return item.level === 'error' ? [{ type: 'error', message: item.message, willRetry: false }] : [];
    case 'user_message': return [];
    case 'todo':
    case 'plugin': return [];
  }
}

function mapEvent(event: AgentStreamEvent, fallbackTurnId: string, textById: Map<string, string>): AgentEvent[] {
  switch (event.type) {
    case 'thread_started': return [{ type: 'system', threadId: event.sessionId }];
    case 'turn_started': return [{ type: 'turn_started', turnId: event.turnId ?? fallbackTurnId }];
    case 'turn_completed': {
      const usage = event.usage;
      return [
        ...(usage ? [{ type: 'usage' as const, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }] : []),
        ...(usage?.contextWindowUsedTokens !== undefined
          ? [{ type: 'context_usage' as const, usedTokens: usage.contextWindowUsedTokens, contextWindow: usage.contextWindowMaxTokens ?? null }]
          : []),
        { type: 'done', turnId: event.turnId ?? fallbackTurnId },
      ];
    }
    case 'usage_updated': return [
      { type: 'usage', inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens },
      ...(event.usage.contextWindowUsedTokens !== undefined
        ? [{ type: 'context_usage' as const, usedTokens: event.usage.contextWindowUsedTokens, contextWindow: event.usage.contextWindowMaxTokens ?? null }]
        : []),
    ];
    case 'turn_canceled': return [{ type: 'done', turnId: event.turnId ?? fallbackTurnId }];
    case 'turn_failed': return [{ type: 'error', message: event.error, willRetry: false }];
    case 'timeline': return mapTimeline(event.item, textById);
    case 'permission_requested': return [{ type: 'approval_request', requestId: event.request.id, title: event.request.title ?? event.request.name, detail: event.request.description }];
    case 'permission_resolved': return [];
    case 'attention_required':
    case 'provider_subagent':
    case 'mode_changed':
    case 'model_changed':
    case 'thinking_option_changed': return [];
  }
}

async function promptFromInput(input: AgentInput): Promise<AgentPromptInput> {
  if (!input.images?.length) return input.text ?? '';
  const blocks: Exclude<AgentPromptInput, string> = [{ type: 'text', text: input.text ?? '' }];
  for (const file of input.images) {
    const bytes = await readFile(file);
    const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg'
      : bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 ? 'image/png'
      : bytes.toString('ascii', 0, 3) === 'GIF' ? 'image/gif'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp'
      : undefined;
    if (!mimeType) throw new Error(`不支持的图片格式：${file}`);
    blocks.push({ type: 'image', data: bytes.toString('base64'), mimeType });
  }
  return blocks;
}

/** Wrap a Paseo session without changing the bot-facing AgentBackend contract. */
export class SessionBackendThread implements AgentThread {
  readonly sessionId: string;
  readonly supportsSteer: boolean;
  private activeTurnId: string | undefined;
  private activityAt = Date.now();
  private alive = true;
  private goalStopped = false;
  private activeRun: { queue: EventQueue<AgentEvent>; stop: () => void } | undefined;
  private readonly pendingPermissions = new Map<string, Promise<unknown>>();

  constructor(private readonly session: AgentSession, private readonly thinkingOptionFor: (effort: ReasoningEffort) => string = (effort) => effort) {
    this.sessionId = session.id ?? session.describePersistence()?.sessionId ?? randomUUID();
    this.supportsSteer = typeof session.steerActiveTurn === 'function';
  }

  runStreamed(input: AgentInput, turn?: TurnOptions): AgentRun {
    if (!this.alive) throw new Error('Agent 会话已关闭');
    if (this.activeRun) throw new Error('Agent 回合仍在运行');
    this.activeTurnId = undefined;
    const queue = new EventQueue<AgentEvent>();
    const pending: AgentStreamEvent[] = [];
    const textById = new Map<string, string>();
    let runTurnId: string | undefined;
    let started = false;
    let terminal = false;
    const stop = (): void => {
      if (terminal) return;
      terminal = true;
      queue.close();
      unsubscribe();
      if (this.activeRun?.queue === queue) this.activeRun = undefined;
    };
    const forward = (event: AgentStreamEvent): void => {
      if (terminal) return;
      const eventTurnId = getAgentStreamEventTurnId(event);
      if (eventTurnId && this.activeTurnId && eventTurnId !== this.activeTurnId) return;
      for (const mapped of mapEvent(event, this.activeTurnId ?? '', textById)) queue.push(mapped);
      if (event.type === 'permission_requested') {
        const requestId = event.request.id;
        const denial = this.session.respondToPermission(requestId, {
          behavior: 'deny', message: 'Vonvon Bot 不在此模式下处理交互审批；请跳过该操作并继续',
        }).catch((error: unknown) => {
          if (terminal) return;
          queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error), willRetry: false });
          stop();
        }).finally(() => { this.pendingPermissions.delete(requestId); });
        this.pendingPermissions.set(requestId, denial);
      }
      if (event.type === 'turn_completed' || event.type === 'turn_failed' || event.type === 'turn_canceled') {
        stop();
      }
    };
    const unsubscribe = this.session.subscribe((event) => {
      this.activityAt = Date.now();
      if (!started) pending.push(event);
      else forward(event);
    });
    this.activeRun = { queue, stop };
    void (async () => {
      try {
        if (turn?.model) {
          if (!this.session.setModel) throw new Error('此后端不支持切换模型');
          await this.session.setModel(turn.model);
        }
        if (turn?.effort) {
          if (!this.session.setThinkingOption) throw new Error('此后端不支持切换推理强度');
          await this.session.setThinkingOption(this.thinkingOptionFor(turn.effort));
        }
        const result = await this.session.startTurn(await promptFromInput(input));
        this.activeTurnId = result.turnId;
        runTurnId = result.turnId;
        started = true;
        for (const event of pending) forward(event);
        pending.length = 0;
      } catch (error) {
        queue.push({ type: 'error', message: error instanceof Error ? error.message : String(error), willRetry: false });
        stop();
      }
    })();
    return { events: queue, turnId: () => runTurnId, lastActivity: () => this.activityAt };
  }

  runGoal(objective: string): AgentRun {
    this.goalStopped = false;
    const prompt = [
      '【自主目标】请连续、自主地完成下面的目标：按需使用工具，一步步做到完成为止，',
      '中途不要停下来等我确认；完成后用一段话总结做了什么。',
      '',
      `目标：${objective}`,
    ].join('\n');
    const run = this.runStreamed({ text: prompt });
    const startedAt = Date.now();
    const self = this;
    const events = async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'goal_update', status: 'active', objective, tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: null };
      let tokensUsed = 0;
      for await (const event of run.events) {
        if (event.type === 'usage') tokensUsed = (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
        if (event.type === 'done' && !self.goalStopped) {
          yield { type: 'goal_update', status: 'complete', objective, tokensUsed, timeUsedSeconds: (Date.now() - startedAt) / 1000, tokenBudget: null };
        }
        if (event.type === 'error') {
          const status = event.message.includes('error_max_budget_usd') ? 'budgetLimited' : 'blocked';
          yield { type: 'goal_update', status, objective, tokensUsed, timeUsedSeconds: (Date.now() - startedAt) / 1000, tokenBudget: null };
        }
        yield event;
      }
    };
    return { events: events(), turnId: run.turnId, lastActivity: run.lastActivity };
  }
  async clearGoal(): Promise<void> {
    this.goalStopped = true;
    if (this.activeRun && this.activeTurnId) await this.abort(this.activeTurnId);
  }

  async steer(input: AgentInput, expectedTurnId: string): Promise<void> {
    const prompt = await promptFromInput(input);
    const result = await this.session.steerActiveTurn?.(prompt, { expectedTurnId, clearPendingPermissions: true });
    if (result?.status !== 'accepted') throw new Error('当前 Claude 回合无法追加消息');
  }

  async abort(turnId: string): Promise<void> {
    if (!this.activeRun || turnId !== this.activeTurnId) return;
    await Promise.all(this.pendingPermissions.values());
    await this.session.interrupt();
    if (this.activeRun) {
      this.activeRun.queue.push({ type: 'done', turnId });
      this.activeRun.stop();
    }
  }

  async compact(): Promise<CompactResult> {
    const events = this.runStreamed({ text: '/compact' }).events;
    let compacted = false;
    for await (const event of events) {
      if (event.type === 'context_compacted') compacted = true;
      if (event.type === 'error') throw new Error(event.message);
    }
    return { compacted, usage: null };
  }

  isAlive(): boolean { return this.alive && (this.session as AgentSession & { isAlive?: () => boolean }).isAlive?.() !== false; }
  async close(): Promise<void> {
    this.alive = false;
    try {
      await Promise.all(this.pendingPermissions.values());
      await this.session.close();
    }
    finally { this.activeRun?.stop(); }
  }
}

/** Convert V3's permission matrix to the pinned provider's strict options shape. */
export function claudeSessionConfigFor(options: StartThreadOptions): AgentSessionConfig {
  const mode = options.mode ?? 'full';
  if (mode === 'full') return { provider: 'claude', cwd: options.cwd, modeId: 'bypassPermissions', providerOptions: {} };
  const disallowedTools = [
    ...(mode === 'qa' ? ['Write', 'Edit', 'NotebookEdit'] : []),
    ...(!options.network ? ['WebFetch', 'WebSearch'] : []),
  ];
  return {
    provider: 'claude', cwd: options.cwd, modeId: 'bypassPermissions',
    providerOptions: {
      sandbox: {
        enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        ...(mode === 'qa' ? { filesystem: { denyWrite: [options.cwd] } } : {}),
      },
      ...(disallowedTools.length ? { disallowedTools } : {}),
    },
  };
}

export interface SessionBackendOptions {
  id: string;
  displayName: string;
  capabilities: AgentCapabilities;
  supportedModes: readonly PermissionMode[];
  configFor: (options: StartThreadOptions) => Parameters<AgentClient['createSession']>[0];
  thinkingOptionFor?: (effort: ReasoningEffort) => string;
  doctor?: () => Promise<BackendProbe>;
  models?: () => Promise<ModelInfo[]>;
  listThreads?: (cwd: string, limit: number) => Promise<ThreadSummary[]>;
  readHistory?: (cwd: string, sessionId: string, maxTurns: number) => Promise<ThreadHistory>;
}

/** Common backend shell; provider-specific policy stays with the provider. */
export class SessionBackend implements AgentBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilities;
  readonly supportedModes: readonly PermissionMode[];

  constructor(private readonly client: AgentClient, private readonly options: SessionBackendOptions) {
    if (options.capabilities.approvals) {
      throw new Error(`${options.displayName} 当前不能回传交互审批结果`);
    }
    if (options.capabilities.resume && (!options.listThreads || !options.readHistory)) {
      throw new Error(`${options.displayName} 必须提供历史会话读取器`);
    }
    this.id = options.id;
    this.displayName = options.displayName;
    this.capabilities = options.capabilities;
    this.supportedModes = options.supportedModes;
  }

  async isAvailable(): Promise<boolean> { return this.client.isAvailable(); }

  async doctor(): Promise<BackendProbe> {
    try {
      if (this.options.doctor) return this.options.doctor();
      const ok = await this.client.isAvailable();
      return { ok, version: null, ...(!ok ? { hint: `${this.displayName} CLI 未安装或不可用` } : {}) };
    } catch (error) {
      return { ok: false, version: null, hint: error instanceof Error ? error.message : `${this.displayName} 探测失败` };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.options.models) return this.options.models();
    const catalog = await this.client.fetchCatalog({ scope: 'global', force: false });
    return catalog.models.filter((model) => model.isSelectable !== false).map((model) => ({
      id: model.id,
      displayName: model.label,
      description: model.description ?? '',
      supportedEfforts: [],
      defaultEffort: 'none',
      isDefault: model.isDefault === true,
      hidden: false,
    }));
  }

  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    if (this.options.listThreads) return this.options.listThreads(cwd, limit);
    const sessions = await this.client.listImportableSessions?.({ cwd, limit });
    return (sessions ?? []).map((session) => ({
      sessionId: session.providerHandleId,
      preview: session.firstPromptPreview ?? '',
      createdAt: Math.floor(session.lastActivityAt.getTime() / 1000),
      updatedAt: Math.floor(session.lastActivityAt.getTime() / 1000),
      ...(session.title ? { name: session.title } : {}),
    }));
  }

  async readHistory(cwd: string, sessionId: string, maxTurns = 10): Promise<ThreadHistory> {
    try {
      if (this.options.readHistory) return await this.options.readHistory(cwd, sessionId, maxTurns);
    } catch { /* history cards are best-effort */ }
    return { turns: [], totalTurns: 0 };
  }

  async startThread(options: StartThreadOptions): Promise<SessionBackendThread> {
    this.assertMode(options.mode);
    return new SessionBackendThread(await this.client.createSession(this.configFor(options)), this.options.thinkingOptionFor);
  }

  async resumeThread(options: ResumeThreadOptions): Promise<SessionBackendThread> {
    this.assertMode(options.mode);
    const config = this.configFor(options);
    const handle = { provider: this.client.provider, sessionId: options.sessionId, metadata: { cwd: options.cwd } };
    return new SessionBackendThread(await this.client.resumeSession(handle, config), this.options.thinkingOptionFor);
  }

  private assertMode(mode: PermissionMode | undefined): void {
    if (mode && !this.supportedModes.includes(mode)) throw new Error(`${this.displayName} 不支持 ${mode} 权限档`);
  }

  private configFor(options: StartThreadOptions) {
    const config = this.options.configFor(options);
    return options.effort && !config.thinkingOptionId
      ? { ...config, thinkingOptionId: (this.options.thinkingOptionFor ?? ((effort) => effort))(options.effort) }
      : config;
  }
}
