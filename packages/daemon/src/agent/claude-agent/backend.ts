import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  EffortLevel,
  ModelInfo as ClaudeModelInfo,
  Options,
  Query,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentCapabilities,
  AgentThread,
  BackendLogin,
  BackendProbe,
  GenerateSessionTitleOptions,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { BRIDGE_DEVELOPER_INSTRUCTIONS } from '../bridge-instructions';
import { BackendNotInstalledError, isBackendDepInstalled, installedBackendVersion, loadBackendDep } from '../backend-loader';
import { permissionOptions } from './permission';
import { findTranscript, scanTranscript } from './transcript';
import { foldSessionMessages, mapSessionSummary } from './history';
import { ClaudeAgentThread, type TranscriptMark } from './thread';
import { claudeConfigDir, readConfiguredClaudeModel } from './configured-model';
import { loginFromAccount, loginFromEnv, loginUnderService, readClaudeLogin } from './login';

/** The on-demand npm package backing this backend. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/**
 * Make every bridge-started claude session behave like Claude Code in its cwd:
 * load project + user `CLAUDE.md`, skills, and `.claude/settings.json`. Without
 * `settingSources` the SDK loads every source; helper queries load only 'user'
 * (see helperQueryOptions).
 * Turns once passed nothing here, which is why a project's CLAUDE.md / the user's
 * lark-* skills were previously ignored. The programmatic permission tier
 * (permission.ts: bypassPermissions + sandbox) still takes precedence, so a
 * loaded settings.json cannot weaken the sandbox.
 *
 * TRADEOFF (intentional): loading 'user'/'project' also loads any hooks / mcpServers
 * declared in those `.claude/settings.json` files — and the SDK WILL execute them in
 * bridge-owned sessions. The FEISHU_CODEX_BRIDGE marker below only stops a bridge's
 * cli-bridge hooks from forwarding these sessions' Stop/PermissionRequest to Feishu; it
 * does NOT suppress other user-defined hooks (PreToolUse/Stop/etc.). A user whose global
 * settings has an output-mutating hook will see it run here too. Accepted as the cost
 * of "claude backend = Claude Code in cwd"; revert to ['project'] (or drop 'user') if
 * that's undesirable. */
const BRIDGE_SETTING_SOURCES: SettingSource[] = ['user', 'project'];

/**
 * Env for the SDK's spawned CLI. The SDK does NOT merge with process.env, so we
 * spread it and add the re-entrancy marker that cli-bridge hook handlers read.
 * Vonvon's own handler is gone since s02c; the marker stays so hooks the bridge
 * (feishu-codex-bridge) installed in `~/.claude/settings.json` skip these
 * sessions instead of forwarding them to Feishu.
 *
 * Persistent Bridge chats also get a dedicated entrypoint: Claude Code's
 * native `/resume` picker intentionally filters `sdk-ts`/`sdk-py`/`sdk-cli`
 * sessions even when they have a customTitle. Plain `cli` is not usable here:
 * headless Claude normalizes it back to `sdk-cli`. An unknown, honest Bridge
 * value is preserved and currently falls through Claude's CLI client path,
 * while the stream-json/control protocol still comes from SDK CLI flags. This
 * compatibility boundary depends on Claude's upstream picker/entrypoint rules
 * and must be rechecked when upgrading the bundled Claude Code runtime.
 *
 * NOTE: FEISHU_CODEX_BRIDGE only governs cli-bridge hook forwarding — it
 * does not gate other SDK hooks loaded via settingSources (see
 * BRIDGE_SETTING_SOURCES). Mirrors the codex app-server child. */
function bridgeClaudeEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') base[k] = v;
  base.FEISHU_CODEX_BRIDGE = '1';
  base.CLAUDE_CODE_ENTRYPOINT = 'feishu-codex-bridge';
  return base;
}

/**
 * Options shared by the helper queries (login probe, model list, session title).
 * They start the same CLI with the same user settings a turn reads, so an `env`
 * key there counts (ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_BASE_URL and
 * ANTHROPIC_MODEL for DeepSeek or Kimi). With `settingSources: []` those keys were
 * ignored and the helpers reported "not logged in" on such machines. Hooks,
 * tools, MCP servers, claude.ai connectors, the transcript and the user's
 * personal CLAUDE.md stay off. The project layer is not loaded: the model list is
 * cached per backend, not per project, and titles only need the credentials.
 */
function helperQueryOptions(cwd: string): Options {
  return {
    cwd,
    env: { ...bridgeClaudeEnv(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    persistSession: false,
    maxTurns: 1,
    tools: [],
    skills: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: ['user'],
    settings: {
      disableAllHooks: true,
      // e02: with 'user' loaded the personal CLAUDE.md is read unless excluded;
      // the glob covers ~/.claude, the absolute path covers CLAUDE_CONFIG_DIR.
      claudeMdExcludes: [join(claudeConfigDir(), 'CLAUDE.md'), '**/.claude/CLAUDE.md'],
    },
  };
}

/** The SDK's runtime surface we use (typed off the package, erased at build). */
type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk');
export type ClaudeSdkFacade = Pick<
  ClaudeSdk,
  'query' | 'listSessions' | 'getSessionInfo' | 'getSessionMessages' | 'renameSession'
>;

// On Linux the SDK calls process.report.getReport() for every session it builds, to tell musl from glibc. The
// report looks up the name of every open socket's peer synchronously, which held the event loop for 25 to 30 s on
// JP-VPS, so every chat of the bot stalled and the record-block pull timed out. The SDK reads only the header.
(process.report as { excludeNetwork?: boolean }).excludeNetwork = true;

let sdkPromise: Promise<ClaudeSdkFacade> | undefined;
/**
 * Lazy-load the SDK via the on-demand loader (bridge/global node_modules → user
 * private install dir). Cached after first success. Throws BackendNotInstalledError
 * when absent — so a fresh install that hasn't downloaded Claude yet fails with a
 * clear "未安装" instead of crashing at module import. If the user already has the
 * package anywhere on the resolve path (e.g. a global `npm i -g`), this finds it
 * and never re-downloads.
 */
function loadSdk(): Promise<ClaudeSdkFacade> {
  // A failed load is not kept, so a download made after it is picked up.
  sdkPromise ??= loadBackendDep<ClaudeSdkFacade>(SDK_PKG).catch((err: unknown) => {
    sdkPromise = undefined;
    throw err;
  });
  return sdkPromise;
}

const TITLE_GENERATION_TIMEOUT_MS = 30_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const LOGIN_PROBE_TIMEOUT_MS = 15_000;
const TITLE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string', maxLength: 36 } },
  required: ['title'],
  additionalProperties: false,
} as const;

function parseGeneratedTitle(text: string): string | undefined {
  const clean = text.trim();
  if (!clean) return undefined;
  try {
    const parsed = JSON.parse(clean) as { title?: unknown };
    if (typeof parsed.title === 'string') return parsed.title.trim() || undefined;
  } catch {
    // Structured output is preferred, but preserve a plain-text result from an
    // older SDK/CLI so the coordinator can sanitize/fallback in one place.
  }
  return clean;
}

function titleFromStructuredOutput(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const title = (value as { title?: unknown }).title;
  return typeof title === 'string' ? title.trim() || undefined : undefined;
}

/** Consume a title query until its terminal SDK result. Exported for a mock-only
 * unit test; runtime errors deliberately propagate to the coordinator. */
export async function consumeClaudeTitleQuery(query: Query): Promise<string | undefined> {
  for await (const message of query) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success') {
      throw new Error(message.errors.join('; ') || `Claude title query failed: ${message.subtype}`);
    }
    return titleFromStructuredOutput(message.structured_output) ?? parseGeneratedTitle(message.result);
  }
  throw new Error('Claude title query closed before returning a result');
}

function withAbortDeadline<T>(
  work: Promise<T>,
  abortController: AbortController,
  timeoutMs = TITLE_GENERATION_TIMEOUT_MS,
  what = 'title generation',
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      reject(new Error(`Claude ${what} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Start the SDK in streaming-input mode but never submit a user turn. The CLI
 * still emits its initialization payload (which contains supportedModels), and
 * aborting after discovery releases the waiting input iterator. */
async function* idleClaudeInput(signal: AbortSignal): AsyncGenerator<never, void, unknown> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Claude Agent SDK backend — drives Claude Code in-process via
 * `@anthropic-ai/claude-agent-sdk`'s `query()`. Mirrors the codex app-server
 * backend's contract (see ../codex-appserver/backend.ts) so the bot orchestrator,
 * card streamer, watchdog and session store work unchanged.
 *
 * Packaging: the SDK is an ON-DEMAND dependency (not bundled with the bridge) —
 * loaded lazily via {@link loadSdk}. When absent, the Web 后端页 shows a「下载」
 * button (catalog marks it npm-ondemand); an already-installed copy (bridge /
 * global / user dir) is detected and reused, never re-downloaded.
 *
 * Auth: the SDK's bundled CLI reuses the host's Claude login (verified: a query
 * runs with apiKeySource=none when the machine is logged in), else
 * ANTHROPIC_API_KEY. No separate login step in the bridge; {@link loginStatus}
 * reads the state for the environment page and the desktop snapshot.
 */
export class ClaudeAgentBackend implements AgentBackend {
  readonly id = 'claude-agent';
  readonly displayName = 'Claude';
  /** Successful SDK discovery is stable for this backend process and avoids
   * spawning an auxiliary Claude CLI on every topic start/settings render.
   * Failures are deliberately not cached so installation/login recovery can
   * retry on the next call (same policy as the Codex backend). */
  private modelCache: ModelInfo[] | null = null;

  constructor(
    private readonly sdkLoader: () => Promise<ClaudeSdkFacade> = loadSdk,
    /** injectable so tests do not read the machine's ~/.claude/settings.json */
    private readonly configuredModel: () => string | undefined = readConfiguredClaudeModel,
  ) {}

  readonly capabilities: AgentCapabilities = {
    // /goal：goal-like —— 一个自主轮跑完目标 + 合成状态 + abort 硬停可终止续聊
    // （非 codex 的多轮目标引擎，差异见 thread.runGoal）。
    goal: true,
    steer: false,
    // /compact：Claude Code 原生斜杠命令（发 "/compact" 即触发，见 thread.compact）。
    compact: true,
    // resume 历史卡：读 ~/.claude/projects 会话存储（与 `claude -r` 同源，双向可见）。
    resume: true,
    approvals: false,
  };

  // Claude's sandbox supports macOS (Seatbelt) and Linux (bubblewrap), so all
  // three tiers are offered; qa/write fail-closed at runtime if the sandbox can't
  // start (permission.ts sets sandbox.failIfUnavailable). See the security delta
  // documented in permission.ts / CLAUDE_AGENT_PROGRESS.md.
  readonly supportedModes: readonly PermissionMode[] = ['qa', 'write', 'full'];

  async isAvailable(): Promise<boolean> {
    return (await this.doctor()).ok;
  }

  async doctor(): Promise<BackendProbe> {
    // "available" = the on-demand SDK is installed (bridge/global/user dir). When
    // not, report installable so the Web shows a「下载」button. Login is read by
    // loginStatus(), not here: it spawns the CLI and callers race doctor() against 3 s.
    if (!isBackendDepInstalled(SDK_PKG)) {
      return {
        ok: false,
        version: null,
        installable: true,
        depState: 'not-installed',
        hint: '点「下载」安装 Claude Agent SDK（零 sudo，装到用户目录）',
      };
    }
    return {
      ok: true,
      version: installedBackendVersion(SDK_PKG),
      location: SDK_PKG,
      depState: 'installed',
      hint: '复用本机 Claude 登录态（未登录请先 `claude` 登录，或设置 ANTHROPIC_API_KEY）',
    };
  }

  loginStatus(opts?: { refresh?: boolean }): Promise<BackendLogin> {
    // Not cached, so the answer changes as soon as the SDK is downloaded.
    return readClaudeLogin(() => this.probeLogin(), opts).catch((err: unknown) => {
      if (err instanceof BackendNotInstalledError) return { state: 'unknown', message: '还没下载 Claude Agent SDK。' };
      throw err;
    });
  }

  /** Reads the account the SDK's CLI reports at initialize, with no turn and no
   * tokens, using {@link helperQueryOptions} (an apiKeyHelper or `env` key in the
   * user settings counts, and plugins enabled there load). If it cannot start,
   * `claude auth status` from a separate CLI would not say whether turns can run, so
   * only the env is checked. */
  private async probeLogin(): Promise<BackendLogin> {
    let query: Query | undefined;
    const abortController = new AbortController();
    try {
      const sdk = await this.sdkLoader();
      query = sdk.query({
        prompt: idleClaudeInput(abortController.signal),
        options: { ...helperQueryOptions(homedir()), abortController },
      });
      const init = await withAbortDeadline(
        query.initializationResult(),
        abortController,
        LOGIN_PROBE_TIMEOUT_MS,
        'login probe',
      );
      return loginUnderService(loginFromAccount(init.account) ?? loginFromEnv(process.env, 'Claude 没有报告账号信息。'), process.env);
    } catch (err) {
      if (err instanceof BackendNotInstalledError) throw err;
      log.fail('agent', err, { backend: 'claude-agent', phase: 'loginStatus' });
      return loginFromEnv(process.env, 'Claude 起不来，看不到登录状态。');
    } finally {
      abortController.abort();
      query?.close();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (this.modelCache) return this.modelCache;
    let query: Query | undefined;
    const abortController = new AbortController();
    try {
      const sdk = await this.sdkLoader();
      // supportedModels() is exposed on an initialized SDK Query rather than as
      // a package-level function. An idle streaming input lets the CLI initialize
      // without submitting a user turn or spending model tokens. Same settings as
      // the login probe, so a model configured in the user settings is listed.
      query = sdk.query({
        prompt: idleClaudeInput(abortController.signal),
        options: { ...helperQueryOptions(homedir()), abortController },
      });
      const discovered = await withAbortDeadline(
        query.supportedModels(),
        abortController,
        MODEL_DISCOVERY_TIMEOUT_MS,
        'model discovery',
      );
      if (!discovered.length) throw new Error('Claude SDK returned an empty model catalog');
      this.modelCache = withConfiguredDefault(discovered.map(mapClaudeModel), this.configuredModel());
      return this.modelCache;
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'supportedModels' });
      return withConfiguredDefault(STATIC_MODELS, this.configuredModel());
    } finally {
      abortController.abort();
      query?.close();
    }
  }

  /** 最近会话（newest first），读 ~/.claude/projects/<cwd-hash> 的 JSONL 存储——
   * 与 `claude -r` 同源，故能列出本机用 `claude` 手开的会话。绝不抛错（契约）。 */
  async listThreads(cwd: string, limit = 15): Promise<ThreadSummary[]> {
    try {
      const sdk = await this.sdkLoader();
      const sessions = await sdk.listSessions({ dir: cwd, limit });
      return sessions
        .map(mapSessionSummary)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'listSessions' });
      return [];
    }
  }

  /** 某会话的转写摘要（resume 历史卡）——读 getSessionMessages 折叠成 turns，不起会话、
   * 无 token 成本。绝不抛错（返回空）。 */
  async readHistory(cwd: string, sessionId: string, maxTurns = 10): Promise<ThreadHistory> {
    try {
      const sdk = await this.sdkLoader();
      const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
      const history = foldSessionMessages(messages, maxTurns, cwd);
      try {
        const name = await this.readSessionTitle(cwd, sessionId);
        return { ...history, ...(name ? { name } : {}) };
      } catch (err) {
        log.fail('agent', err, { backend: 'claude-agent', phase: 'getSessionInfo', sessionId });
        return history;
      }
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'getSessionMessages', sessionId });
      return { turns: [], totalTurns: 0 };
    }
  }

  async readSessionTitle(cwd: string, sessionId: string): Promise<string | undefined> {
    const sdk = await this.sdkLoader();
    // Read the exact transcript metadata instead of a bounded list page: an old
    // resumed session may no longer be in the newest N entries. Only customTitle
    // counts here; summary/firstPrompt do not make Claude Code's resume picker
    // treat the session as explicitly named.
    const session = await sdk.getSessionInfo(sessionId, { dir: cwd });
    const title = session?.customTitle?.trim();
    return title || undefined;
  }

  async setSessionTitle(cwd: string, sessionId: string, title: string): Promise<void> {
    const clean = title.trim();
    if (!clean) throw new Error('Cannot set an empty Claude session title');
    const sdk = await this.sdkLoader();
    await sdk.renameSession(sessionId, clean, { dir: cwd });
  }

  async generateSessionTitle(opts: GenerateSessionTitleOptions): Promise<string | undefined> {
    const sdk = await this.sdkLoader();
    const abortController = new AbortController();
    const query = sdk.query({
      prompt: opts.prompt,
      options: {
        ...helperQueryOptions(opts.cwd),
        model: opts.model,
        // Pass through verbatim. If a stale configuration names an effort the
        // installed SDK rejects, that error must reach the coordinator; never
        // downgrade or substitute behind the administrator's back.
        effort: opts.effort as EffortLevel,
        abortController,
        outputFormat: { type: 'json_schema', schema: TITLE_OUTPUT_SCHEMA },
      },
    });
    try {
      return await withAbortDeadline(
        consumeClaudeTitleQuery(query),
        abortController,
      );
    } finally {
      query.close();
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const sdk = await this.sdkLoader();
    return new ClaudeAgentThread({
      sessionId: randomUUID(),
      resume: false,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permission: permissionOptions(opts.mode, opts.network, opts.cwd),
      systemPromptAppend: BRIDGE_DEVELOPER_INSTRUCTIONS,
      settingSources: BRIDGE_SETTING_SOURCES,
      env: bridgeClaudeEnv(),
      query: sdk.query,
    });
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const sdk = await this.sdkLoader();
    const transcript = await transcriptMark(await assertSessionSaved(opts.sessionId), opts.sessionId);
    return new ClaudeAgentThread({
      sessionId: opts.sessionId,
      resume: true,
      transcript,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      permission: permissionOptions(opts.mode, opts.network, opts.cwd),
      systemPromptAppend: BRIDGE_DEVELOPER_INSTRUCTIONS,
      settingSources: BRIDGE_SETTING_SOURCES,
      env: bridgeClaudeEnv(),
      query: sdk.query,
    });
  }
}

/**
 * A first turn that failed before Claude Code wrote its transcript (sandbox tools missing, not logged in) leaves
 * a session id with nothing behind it, and resuming it fails every later turn with "No conversation found".
 * Throwing here sends the caller down its resume-failed path instead: a fresh session, and in a group a line on
 * the run card saying so.
 *
 * Only a missing `<id>.jsonl` counts. The SDK's getSessionInfo is no test: it reads 64 KB at each end of the
 * file and returns nothing when no summary is there, which a long saved session can hit. Every project folder is
 * searched, so how Claude Code names the folder for a cwd (case, symlinks, long paths) does not matter. A folder
 * that cannot be read does not block the resume.
 */
async function assertSessionSaved(sessionId: string): Promise<string | undefined> {
  if (!/^[\w-]+$/.test(sessionId)) return undefined;
  let file: string | undefined;
  try {
    file = await findTranscript(sessionId);
  } catch (err) {
    log.fail('agent', err, { backend: 'claude-agent', phase: 'resume-lookup', sessionId });
    return undefined;
  }
  if (!file) throw new Error(`Claude 会话 ${sessionId} 没有保存下来，无法恢复`);
  return file;
}

/**
 * Where a resumed thread starts watching its file (s15b): everything there now is what the
 * new process loads, so only what comes after can be someone else's. The last compaction
 * in it is reported, so a terminal `/compact` made while no bot process was up still counts.
 * A file that cannot be read starts the watch unset; the first check then reads it whole.
 */
async function transcriptMark(file: string | undefined, sessionId: string): Promise<TranscriptMark | undefined> {
  if (!file) return undefined;
  try {
    const scan = await scanTranscript(file, 0);
    return { file, to: scan.to, ...(scan.compaction ? { compaction: scan.compaction } : {}) };
  } catch (err) {
    log.fail('agent', err, { backend: 'claude-agent', phase: 'transcript-mark', sessionId });
    return undefined;
  }
}

const EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

function mapClaudeModel(model: ClaudeModelInfo, index: number): ModelInfo {
  const reported = model.supportedEffortLevels as ReasoningEffort[] | undefined;
  const supportedEfforts = model.supportsEffort === false ? [] : (reported?.length ? reported : EFFORTS);
  const defaultEffort: ReasoningEffort = supportedEfforts.includes('high')
    ? 'high'
    : (supportedEfforts[0] ?? 'medium');
  return {
    id: model.value,
    displayName: model.displayName || model.value,
    description: model.description ?? '',
    supportedEfforts,
    defaultEffort,
    // The SDK does not currently expose an explicit default bit. Its catalog is
    // ordered for the picker, so mark the leading model as the bridge default.
    isDefault: index === 0,
    hidden: false,
  };
}

/**
 * Make the model Claude Code is configured to start on (see
 * {@link readConfiguredClaudeModel}) the list's default and put it first, adding a
 * row when the list lacks it (the SDK lists an ANTHROPIC_MODEL as "Custom model",
 * the static fallback does not). Without one the list is returned unchanged, so a
 * plain Claude login keeps the SDK's leading "default" row.
 */
export function withConfiguredDefault(models: ModelInfo[], configured: string | undefined): ModelInfo[] {
  if (!configured) return models;
  const hit = models.find((m) => m.id === configured);
  const row: ModelInfo = hit
    ? { ...hit, isDefault: true, hidden: false }
    : {
        id: configured,
        displayName: configured,
        description: '来自 Claude 设置',
        supportedEfforts: EFFORTS,
        defaultEffort: 'high',
        isDefault: true,
        hidden: false,
      };
  return [row, ...models.filter((m) => m !== hit).map((m) => ({ ...m, isDefault: false }))];
}

/** Failure-only fallback when SDK model discovery cannot initialize. Successful
 * discovery is cached above and remains the normal model-picker source. */
const STATIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    description: '最强，复杂推理 / 长程 agentic',
    supportedEfforts: EFFORTS,
    defaultEffort: 'high',
    isDefault: true,
    hidden: false,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    description: '均衡，日常编码',
    supportedEfforts: EFFORTS,
    defaultEffort: 'medium',
    isDefault: false,
    hidden: false,
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    description: '最快，轻量任务',
    supportedEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'low',
    isDefault: false,
    hidden: false,
  },
];
