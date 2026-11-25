import { realpath } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  EffortLevel,
  ModelInfo as ClaudeModelInfo,
  Options,
  Query,
  SDKResultMessage,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import { OwnedProviderProcess, ProviderProcessExitError } from '../owned-process';
import { log } from '../../core/logger';
import type {
  AgentBackend,
  AgentSkill,
  AgentCapabilities,
  AgentThread,
  BackendLogin,
  BackendProbe,
  GenerateSessionTitleOptions,
  JudgeCall,
  JudgeCallOutput,
  ModelInfo,
  PermissionMode,
  ReasoningEffort,
  ResumeThreadOptions,
  StartThreadOptions,
  ThreadHistory,
  ThreadSummary,
} from '../types';
import { JudgeCallError } from '../types';
import { claudeErrorKind, errorKindFromText } from '../error-kind';
import { resolveSessionProfile, type SessionProfileCapabilities } from '../session-profile';
import { BackendNotInstalledError, isBackendDepInstalled, installedBackendVersion, loadBackendDep } from '../backend-loader';
import { claudeAccess, permissionOptions } from './permission';
import { realScope, linuxReadScope } from './read-scope';
export { ReadScopeError } from './read-scope';
import { findTranscript, readCustomTitle, scanTranscript } from './transcript';
import { foldSessionMessages, mapSessionSummary } from './history';
import { ClaudeAgentThread, NATIVE_MEMORY_OFF, NATIVE_SCHEDULING_ENV, type TranscriptMark } from './thread';
import { scanClaudeLocalSkillSources } from '../group-skills';
import { claudeAccountConfigKey, claudeConfigDir, readConfiguredClaudeModel } from './configured-model';
import { loginFromAccount, loginFromEnv, loginUnderService, readClaudeLogin } from './login';
import { toolCommand } from '../../environment/tool-command';

/** The on-demand npm package backing this backend. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/**
 * Make every bridge-started claude session behave like Claude Code in its cwd:
 * load project + user `CLAUDE.md`, skills, and `.claude/settings.json`. Without
 * `settingSources` the SDK loads every source; helper queries load only 'user'
 * (see helperQueryOptions).
 * Turns once passed nothing here, which is why a project's CLAUDE.md / the user's
 * lark-* skills were previously ignored. In default/acceptEdits modes, loaded
 * permissions.allow and additionalDirectories can bypass canUseTool. The
 * PreToolUse file hook enforces the write boundary even for those calls.
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

function sessionClaudeEnv(profileEnv: Readonly<Record<string, string>>): Record<string, string> {
  // CLAUDE_CODE_DISABLE_CRON backs up thread.ts's NATIVE_SCHEDULING_TOOLS (3.13); the settings layer carries it too.
  return { ...bridgeClaudeEnv(), ...profileEnv, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...NATIVE_SCHEDULING_ENV };
}

/**
 * Options shared by the helper queries (login probe, model list, session title).
 * They start the same CLI with the same user settings a turn reads, so an `env`
 * key there counts (ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_BASE_URL and
 * ANTHROPIC_MODEL for DeepSeek or Kimi). With `settingSources: []` those keys were
 * ignored and the helpers reported "not logged in" on such machines. Hooks,
 * tools, MCP servers, claude.ai connectors, the transcript and personal CLAUDE.md
 * are disabled by the options below. Managed policy can override hook settings;
 * user apiKeyHelper may still execute to obtain credentials. The project layer is not loaded: the model list is
 * cached per process, not per project, and titles only need the credentials.
 */
function helperQueryOptions(cwd: string): Options {
  return {
    cwd,
    env: { ...bridgeClaudeEnv(), ...NATIVE_MEMORY_OFF.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    persistSession: false,
    maxTurns: 1,
    tools: [],
    skills: [],
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: ['user'],
    settings: {
      ...NATIVE_MEMORY_OFF,
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
> & Partial<Pick<ClaudeSdk, 'createSdkMcpServer' | 'tool'>>;

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
// A default-loader cache is shared by transient Provider details and persistent Bot backends.
// Injected loaders get independent caches, without retaining test SDKs for the process lifetime.
type ClaudeModelCache = { key: string; refresh: boolean; models?: ModelInfo[]; flight?: Promise<ModelInfo[]> };
const modelCaches = new WeakMap<() => Promise<ClaudeSdkFacade>, ClaudeModelCache>();

function modelFileVersion(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  } catch { return 'missing'; }
}

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

/**
 * A judge failure: an `assistant.error` code is structured (it may start a cooldown), a kind only
 * read from the text is not (design 3.1). Only codes saying the whole machine or the whole model
 * cannot be used are structured: auth (`authentication_failed`, `oauth_org_not_allowed`,
 * `cloud_credential_error`), quota (`rate_limit`, `billing_error`) and `model_not_found`; overloaded
 * and server errors are structured `network`, which never cools. The other codes fall back to the
 * text and so never cool: `account_on_hold` and `verification_required` need the owner to act in the
 * account, which a 5-minute pause does not help, and the error detail still carries their text;
 * `invalid_request` comes from this one input (too long, a bad character), not from the backend;
 * `unknown` says nothing.
 */
function claudeJudgeError(code: unknown, message: string): JudgeCallError {
  const coded = code === 'model_not_found' ? 'model' : claudeErrorKind(code);
  if (coded) return new JudgeCallError(coded, message, true);
  return new JudgeCallError(errorKindFromText(message) ?? 'failed', message, false);
}

/** The CLI's own names for the judge and title-job sessions. Without one, the CLI starts its own
 * title request on the first user message, resending the whole input to haiku: about 60% more tokens
 * for a judgement (e12). The login probe and the model list send no user message, so start none (s23e). */
const JUDGE_SESSION_TITLE = 'vonvon judge';
const TITLE_JOB_SESSION_TITLE = 'vonvon title';

/** Tokens of the whole query: `modelUsage` counts every model call of it, `usage` only the main loop
 * (sdk.d.ts); `usage` only when there is no `modelUsage`. */
function judgeUsage(message: SDKResultMessage): NonNullable<JudgeCallOutput['usage']> {
  const models = Object.values(message.modelUsage ?? {});
  if (models.length) {
    const sum = (pick: (m: (typeof models)[number]) => number | undefined): number => models.reduce((n, m) => n + (pick(m) ?? 0), 0);
    const cached = sum(m => m.cacheReadInputTokens);
    return {
      input: sum(m => m.inputTokens) + sum(m => m.cacheCreationInputTokens) + cached,
      cached, output: sum(m => m.outputTokens), reasoning: sum(m => m.thinkingTokens),
    };
  }
  const u = message.usage as Partial<SDKResultMessage['usage']> & { output_tokens_details?: { thinking_tokens?: number } } | undefined;
  return {
    input: (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0),
    cached: u?.cache_read_input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    reasoning: u?.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/**
 * Consume a judge query to its result. Exported for the mock-only unit test. `maxTurns`: haiku answered
 * in text instead of calling the StructuredOutput tool, which ends the turn on `error_max_turns` (e12:
 * 13 of 137, often in a ```json block); its last text goes to `parseVerdict` like any answer, and the
 * CLI then exits 1.
 */
export async function consumeClaudeJudgeQuery(query: Query): Promise<{ output: JudgeCallOutput; maxTurns: boolean }> {
  let code: unknown;
  let lastText = '';
  try {
    for await (const message of query) {
      if (message.type === 'assistant') {
        if (message.error) code = message.error;
        const text = (message.message?.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').trim();
        if (text) lastText = text;
      }
      if (message.type !== 'result') continue;
      if (message.subtype === 'error_max_turns' && lastText && !code) {
        return { output: { text: lastText, usage: judgeUsage(message) }, maxTurns: true };
      }
      if (message.subtype !== 'success') throw claudeJudgeError(code, message.errors.join('; ') || `Claude 判断失败：${message.subtype}`);
      // `success` with is_error: the turn ended on an API error, and `result` is its text (sdk.d.ts)
      if (message.is_error) throw claudeJudgeError(code, message.result || 'Claude 判断失败：API 出错');
      return { output: { text: message.result, structured: message.structured_output, usage: judgeUsage(message) }, maxTurns: false };
    }
  } catch (error) {
    throw error instanceof JudgeCallError ? error : claudeJudgeError(code, error instanceof Error ? error.message : String(error));
  }
  throw claudeJudgeError(code, 'Claude 判断没有返回结果');
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
  readonly profileCapabilities = {
    instructions: { channel: 'system-append', replaceOnResume: false },
    additionalRoots: true, directoryAccess: true, capabilityPackages: true, mcpServers: false,
    env: true, disableNativeMemory: true,
    reapplyOnResume: ['env', 'nativeSettings', 'additionalRoots', 'directoryAccess'],
  } satisfies SessionProfileCapabilities;
  readonly id = 'claude-agent';
  readonly displayName = 'Claude';
  private modelSettingsKey(): string {
    const dir = claudeConfigDir();
    // Hash credentials rather than retaining their values in cache keys. Keychain changes
    // cannot be observed cheaply; the explicit refresh also invalidates those catalogs.
    const env = Object.entries(process.env).filter(([key]) =>
      /^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_|CLOUD_ML_)/.test(key)).sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([homedir(), dir, this.configuredModel(),
      modelFileVersion(join(dir, 'settings.json')), modelFileVersion(join(dir, '.credentials.json')),
      claudeAccountConfigKey(), installedBackendVersion(SDK_PKG),
      createHash('sha256').update(JSON.stringify(env)).digest('hex')]);
  }

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
    approvals: true, // Claude emits questions, confirmations and full-access permissions via canUseTool (s31).
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
      hint: `复用本机 Claude 登录态（未登录请先 \`${toolCommand('claude')}\` 登录，或设置 ANTHROPIC_API_KEY）`,
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
    // The Claude Code CLI a terminal starts: a managed copy is on no PATH (0.9.0 Linux acceptance).
    const command = toolCommand('claude');
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
      return loginUnderService(loginFromAccount(init.account, command) ?? loginFromEnv(process.env, 'Claude 没有报告账号信息。'), process.env, command);
    } catch (err) {
      if (err instanceof BackendNotInstalledError) throw err;
      log.fail('agent', err, { backend: 'claude-agent', phase: 'loginStatus' });
      if (err instanceof Error && err.message.includes('Native CLI binary')) {
        return { state: 'unknown', message: `Claude Agent SDK 的运行程序缺失，请重新安装 SDK。也请在终端运行 \`${command}\`，确认本机 Claude Code 可以使用。` };
      }
      return { state: 'unknown', message: `Claude Agent SDK 无法启动。请在终端运行 \`${command}\`，确认本机 Claude Code 可以使用，然后重新检测。` };
    } finally {
      abortController.abort();
      query?.close();
    }
  }

  async listSkills({ cwd, directories = [] }: { cwd: string; directories?: string[] }): Promise<AgentSkill[]> {
    const sdk = await this.sdkLoader();
    const abortController = new AbortController();
    const localSourcesPromise = scanClaudeLocalSkillSources({ cwd, directories }).catch(() => undefined);
    const query = sdk.query({ prompt: idleClaudeInput(abortController.signal), options: {
      ...helperQueryOptions(cwd), settingSources: BRIDGE_SETTING_SOURCES,
      skills: 'all', additionalDirectories: directories, abortController,
    } });
    try {
      const [commands, localSources] = await Promise.all([
        withAbortDeadline(query.supportedCommands(), abortController, MODEL_DISCOVERY_TIMEOUT_MS, 'skill discovery'),
        localSourcesPromise,
      ]);
      // The SDK is authoritative about user, workspace, plugin and bundled sources.
      // Its public catalog gives no paths; cross-match local workspace/user directories for attribution and viewing.
      return commands.filter(command => !command.builtin).map(command => {
        const local = localSources?.get(command.name);
        const source: AgentSkill['source'] = local
          ? local.source
          : command.name.includes(':')
            ? 'plugin'
            : localSources
              ? 'system'
              : 'provider';
        return {
          path: `claude:${command.name}`,
          name: command.name,
          description: command.description,
          source,
          enabled: true,
          ...(local ? { location: local.location } : {}),
        };
      });
    } finally { abortController.abort(); query.close(); }
  }

  async listModels(opts: { refresh?: boolean } = {}): Promise<ModelInfo[]> {
    const key = this.modelSettingsKey();
    const existing = modelCaches.get(this.sdkLoader);
    if (existing?.key === key) {
      // A click after ordinary discovery began needs new evidence. Concurrent clicks
      // share that refresh, but must not reuse the earlier background request.
      if (existing.flight && (!opts.refresh || existing.refresh)) return existing.flight;
      if (!opts.refresh && existing.models) return existing.models;
    }
    const entry: ClaudeModelCache = { key, refresh: opts.refresh === true };
    modelCaches.set(this.sdkLoader, entry);
    entry.flight = this.discoverModels(entry).finally(() => { entry.flight = undefined; });
    return entry.flight;
  }

  private async discoverModels(entry: ClaudeModelCache): Promise<ModelInfo[]> {
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
      if (entry.key !== this.modelSettingsKey() || modelCaches.get(this.sdkLoader) !== entry) {
        throw new Error('Claude model discovery was superseded or configuration changed');
      }
      entry.models = withConfiguredDefault(discovered.map(mapClaudeModel), this.configuredModel());
      return entry.models;
    } catch (err) {
      log.fail('agent', err, { backend: 'claude-agent', phase: 'supportedModels' });
      return withConfiguredDefault(OFFLINE_CLAUDE_MODELS, this.configuredModel());
    } finally {
      abortController.abort();
      query?.close();
    }
  }

  /** Only a successful catalog for the current inputs; fallback is never cached. */
  peekModels(): ModelInfo[] | undefined {
    const entry = modelCaches.get(this.sdkLoader);
    return entry?.key === this.modelSettingsKey() ? entry.models : undefined;
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

  async readSessionTitle(_cwd: string, sessionId: string): Promise<string | undefined> {
    // getSessionInfo().customTitle also includes CLI-generated ai-title records.
    // Only explicit custom-title records should stop vonvon from naming a session.
    const file = await findTranscript(sessionId);
    return file ? readCustomTitle(file) : undefined;
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
        title: TITLE_JOB_SESSION_TITLE,
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

  /** One tool-less judge turn. User credential helpers and managed-policy hooks may still run.
   * The shared provider registry retains ownership until the child process group is gone. */
  async judge(call: JudgeCall): Promise<JudgeCallOutput> {
    let sdk: ClaudeSdkFacade;
    try {
      sdk = await this.sdkLoader();
    } catch (error) {
      if (error instanceof BackendNotInstalledError) throw new JudgeCallError('unavailable', '还没下载 Claude Agent SDK', false);
      throw error;
    }
    // aborted while the SDK loaded: start no CLI
    if (call.signal.aborted) throw new JudgeCallError('aborted', '判断已放弃', false);
    const abortController = new AbortController();
    let query: Query | undefined;
    let owned: OwnedProviderProcess | undefined;
    let judgeError: JudgeCallError | undefined;
    // the CLI exits 1 after error_max_turns, also when its text still gave the answer
    let exitMayFail = false;
    // On abort the SDK only ends stdin and sends its own SIGTERM 2 s later, and a CLI waiting on the
    // API ignores the EOF: stop the whole group now, so the judge slot is not held for nothing.
    // The finally awaits the same close and reports how it went.
    const stopOwned = (): void => { void owned?.close().catch(() => undefined); };
    const onAbort = (): void => {
      abortController.abort(call.signal.reason);
      stopOwned();
    };
    call.signal.addEventListener('abort', onAbort, { once: true });
    try {
      query = sdk.query({
        prompt: call.input,
        options: {
          ...helperQueryOptions(call.cwd),
          // Not the SDK's forwarded `signal`: Node would kill only the direct child with it and report
          // an AbortError. The owned process kills the group itself.
          spawnClaudeCodeProcess: ({ command, args, signal: _forwarded, ...options }) => {
            owned = new OwnedProviderProcess(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }, 'Claude');
            owned.child.stderr?.resume();
            if (call.signal.aborted) stopOwned();
            if (!owned.child.stdin || !owned.child.stdout) throw new Error('Claude child pipes are missing');
            return Object.assign(owned.child, { stdin: owned.child.stdin, stdout: owned.child.stdout });
          },
          systemPrompt: call.system,
          title: JUDGE_SESSION_TITLE,
          model: call.model,
          ...(call.effort ? { effort: call.effort as EffortLevel } : { thinking: { type: 'disabled' as const } }),
          outputFormat: { type: 'json_schema', schema: call.schema },
          abortController,
        },
      });
      const { output, maxTurns } = await consumeClaudeJudgeQuery(query);
      exitMayFail = maxTurns;
      return output;
    } catch (error) {
      if (error instanceof JudgeCallError) judgeError = error;
      throw error;
    } finally {
      call.signal.removeEventListener('abort', onAbort);
      try { query?.close(); }
      finally {
        try { await owned?.close(); }
        catch (error) {
          if (!(error instanceof ProviderProcessExitError) || !(judgeError || exitMayFail)) throw error;
          if (judgeError) log.fail('agent', error, { backend: 'claude-agent', phase: 'judge-exit' });
          else log.info('agent', 'judge-exit', { backend: 'claude-agent', after: 'error_max_turns' });
        }
      }
    }
  }

  async startThread(opts: StartThreadOptions): Promise<AgentThread> {
    const profile = resolveSessionProfile(opts.profile, { additionalRoots: true, capabilityPackages: true });
    const sdk = await this.sdkLoader();
    const realCwd = await realpath(opts.cwd).catch(() => opts.cwd);
    const access = claudeAccess(opts.mode, opts.network, opts.cwd, realCwd, await Promise.all(profile.additionalRoots.map(async root => ({ ...root, path: await realpath(root.path) }))), opts.native);
    if (access.mode !== 'full' && opts.readScope) {
      access.read = await realScope(opts.readScope, opts.cwd, realCwd);
      if (process.platform === 'linux') access.sandboxRead = await linuxReadScope(access.read, realCwd);
    }
    return new ClaudeAgentThread({
      sessionId: randomUUID(),
      resume: false,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      access,
      permission: permissionOptions(access),
      systemPromptAppend: profile.instructions,
      settingSources: BRIDGE_SETTING_SOURCES,
      additionalDirectories: profile.additionalRoots.map(root => root.path),
      ...(profile.skills?.enabledNames ? { skills: [...profile.skills.enabledNames] } : {}),
      ...(profile.skills?.disabledBuiltinNames?.length ? { disabledBuiltinNames: [...profile.skills.disabledBuiltinNames] } : {}),
      plugins: profile.capabilityPackages.map(pkg => pkg.path),
      env: sessionClaudeEnv(profile.env),
      query: sdk.query,
      entry: opts.entry,
      scheduleTools: profile.tools?.schedule === true,
      feishuTools: profile.tools?.feishu === true,
      feishuEditTools: profile.tools?.feishuEdit === true,
      feishuApiTools: profile.tools?.feishuApi === true,
      createSdkMcpServer: sdk.createSdkMcpServer,
      tool: sdk.tool,
    });
  }

  async resumeThread(opts: ResumeThreadOptions): Promise<AgentThread> {
    const profile = resolveSessionProfile(opts.profile, { additionalRoots: true, capabilityPackages: true });
    const sdk = await this.sdkLoader();
    const transcript = await transcriptMark(await assertSessionSaved(opts.sessionId), opts.sessionId);
    const realCwd = await realpath(opts.cwd).catch(() => opts.cwd);
    const access = claudeAccess(opts.mode, opts.network, opts.cwd, realCwd, await Promise.all(profile.additionalRoots.map(async root => ({ ...root, path: await realpath(root.path) }))), opts.native);
    if (access.mode !== 'full' && opts.readScope) {
      access.read = await realScope(opts.readScope, opts.cwd, realCwd);
      if (process.platform === 'linux') access.sandboxRead = await linuxReadScope(access.read, realCwd);
    }
    return new ClaudeAgentThread({
      sessionId: opts.sessionId,
      resume: true,
      transcript,
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      access,
      permission: permissionOptions(access),
      systemPromptAppend: profile.instructions,
      settingSources: BRIDGE_SETTING_SOURCES,
      additionalDirectories: profile.additionalRoots.map(root => root.path),
      ...(profile.skills?.enabledNames ? { skills: [...profile.skills.enabledNames] } : {}),
      ...(profile.skills?.disabledBuiltinNames?.length ? { disabledBuiltinNames: [...profile.skills.disabledBuiltinNames] } : {}),
      plugins: profile.capabilityPackages.map(pkg => pkg.path),
      env: sessionClaudeEnv(profile.env),
      query: sdk.query,
      entry: opts.entry,
      scheduleTools: profile.tools?.schedule === true,
      feishuTools: profile.tools?.feishu === true,
      feishuEditTools: profile.tools?.feishuEdit === true,
      feishuApiTools: profile.tools?.feishuApi === true,
      createSdkMcpServer: sdk.createSdkMcpServer,
      tool: sdk.tool,
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
export const OFFLINE_CLAUDE_MODELS: ModelInfo[] = [
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
