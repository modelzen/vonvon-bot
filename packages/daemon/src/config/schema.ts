import type { BotDefaults } from './defaults';
import type { DirectorySettings } from './directories';
import { REASONING_EFFORTS, type ReasoningEffort } from '../agent/types';
import type { JudgeSelectionStored } from '../judge/types';
import {completionTemplateSchema, type CardDisplayConfig} from '@vonvon/protocol';

export type TenantBrand = 'feishu' | 'lark';

/**
 * SecretRef points at a secret stored outside config.json (keeps the App
 * Secret out of backups/git/log dumps). Mirrors lark-cli's SecretRef shape.
 */
export interface SecretRef {
  source: 'env' | 'file' | 'exec';
  provider?: string;
  id: string;
}

export type SecretInput = string | SecretRef;

export interface AppCredentials {
  id: string;
  secret: SecretInput;
  tenant: TenantBrand;
}

export interface ProviderConfig {
  source: 'env' | 'file' | 'exec';
  allowlist?: string[];
  path?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  passEnv?: string[];
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SecretsConfig {
  providers?: Record<string, ProviderConfig>;
  defaults?: { env?: string; file?: string; exec?: string };
}

/** card: full interactive card · markdown: lightweight streaming · text: one-shot */
export type MessageReplyMode = 'card' | 'markdown' | 'text';

/** Behavior when a new message arrives mid-turn: steer(引导) or queue(排队). */
export type PendingPolicy = 'steer' | 'queue';

/** 普通群任务结束提醒策略。 */
export type CompletionReminderMode = 'manual' | 'long' | 'failures' | 'always';

/** Raw (partial) completion-reminder preferences as stored in config.json. */
export interface CompletionReminderConfig {
  /** manual=仅用户本轮手动开启；long=超过阈值；failures=失败/假死超时；always=每次结束。 */
  mode?: CompletionReminderMode;
  /** `long` 策略的耗时阈值（分钟）。默认 3，有效范围 1–1440。 */
  longTaskMinutes?: number;
  /** Run-local projection from a chat's presentation; never a Bot template setting. */
  template?: string | null;
}

/** Fully-resolved completion-reminder preferences. */
export interface ResolvedCompletionReminderConfig {
  mode: CompletionReminderMode;
  longTaskMinutes: number;
  template?: string | null;
}

/** Per-Bot copy for the group onboarding card. Empty fields use the built-in copy. */
export interface WelcomeCardPreference {
  title?: string;
  intro?: string;
}

export const COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES = 1;
export const COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES = 1440;
export const COMPLETION_REMINDER_LONG_TASK_DEFAULT_MINUTES = 3;

/**
 * 「模型显示」三档：off(关闭) · running(仅输出时，只在运行卡显示) ·
 * always(始终，运行卡 + 终态卡都保留)。控制运行卡右下角「模型 · 推理强度」脚注。
 */
export type ModelDisplayMode = 'off' | 'running' | 'always';

/**
 * Access control (see design §5):
 *   ownerOpenId   — 扫码注册的人（创建者）。只给界面的小标签和候选人用，不参与判断。
 *   admins        — 管理员名单，判断只看它（product.md 第 6 节）。至少留一个；空的是老数据。
 *   adminsVersion — 名单升级到的版本（dm-agent 3.2）。
 *   firstHelloPending — 新注册的 Bot 还欠创建者一条私聊（dm-agent 第一次见面）。
 *   allowedUsers  — @deprecated 全局响应白名单，已由项目级 Project.allowedUsers 取代。
 *   allowedChats  — chat_ids the bot responds in. Empty = all.
 */
export interface AppAccess {
  /** 扫码注册者的 open_id；被移出 admins 以后还留着，但不再是管理员。 */
  ownerOpenId?: string;
  admins?: string[];
  /** 写了 2 就不再升级，否则被移除的创建者每次启动都会被加回来（config/admins-upgrade.ts）。 */
  adminsVersion?: number;
  /** 只有扫码注册时写，发出去就删。老 Bot 和刷新凭据都没有它，所以不会补发。 */
  firstHelloPending?: boolean;
  /** @deprecated 已由项目级 Project.allowedUsers 取代；保留仅为兼容旧 config 解析，不再读取。 */
  allowedUsers?: string[];
  allowedChats?: string[];
}

export interface AppPreferences {
  /** Text shown at the top of onboarding cards for this Bot's new or newly-bound groups. */
  welcomeCard?: WelcomeCardPreference;
  /** Stored execution defaults; group/runtime inheritance is resolved separately. */
  defaults?: BotDefaults;
  /** Stored directory declarations; runtime inheritance is resolved separately. */
  directories?: DirectorySettings;
  /** Opt-in Feishu ASR; unavailable recognition preserves the original audio. */
  voice?: import('../voice/types').VoiceConfig;
  /** 空白项目的默认父目录。仅通过 config.json 配置；缺省时仍使用
   * `~/.feishu-codex-bridge/projects`。支持绝对路径或 `~` 开头的路径。 */
  projectsRootDir?: string;
  /** reply rendering for IM messages. Default 'card'. */
  messageReply?: MessageReplyMode;
  /** render tool-call blocks in output. Default true. */
  showToolCalls?: boolean;
  /** 「模型 · 推理强度」脚注的显示档位（运行卡右下角）。off/running/always，
   * 默认 running（仅输出时显示，生成完即收起）——平时能扫一眼当前模型，又不在终态
   * 卡上长期留标签。兼容历史布尔值：true→always、false→off（见 {@link getModelDisplay}）。 */
  showModel?: ModelDisplayMode | boolean;
  /** Legacy Bot-wide layout: read only for one-time group/DM migration. Runtime reads each local presentation. */
  cardDisplay?: CardDisplayConfig;
  /** cap concurrent codex turns across all threads. Default 10. */
  maxConcurrentRuns?: number;
  /** per-turn idle watchdog (seconds). 0 = off. Default 600 (on). */
  runIdleTimeoutSeconds?: number;
  /** new-message-mid-turn behavior. Default 'steer'. */
  pendingPolicy?: PendingPolicy;
  /** 普通群任务的结束提醒；默认只在失败或假死超时时发送。 */
  completionReminder?: CompletionReminderConfig;
  /** groups require @bot to respond. Default true. */
  requireMentionInGroup?: boolean;
  /** access control — see AppAccess. */
  access?: AppAccess;
  /** SIGTERM→SIGKILL grace (ms) for the app-server child. Default 5000. */
  agentStopGraceMs?: number;
  // 旧文件里可能还有 `cliBridge`（咖啡一下，s02c 删了）：没人读，存设置时原样留在文件里。
  /** 云文档评论 @bot 流的全局配置（评论链统一用这套，不按项目/文档分）。
   * 缺省时后端回落默认 codex、模型/推理强度回落后端默认（见 {@link getCommentsConfig}）。
   * 自定义提示词不在这里——它落在每 bot 的 `comment-instructions.md` 文件里，由桥同步进
   * 每个文档的评论工作目录（AGENTS.md / CLAUDE.md），见 bot/comments.ts。 */
  comments?: CommentsConfig;
  /** 所有新建聊天会话共用的标题 Provider、模型和强度。 */
  sessionTitles?: SessionTitlesConfig;
  /** 智能模式的判断模型（s23c）。带后端：只给这个后端的群用，别的后端的群用它的默认小模型。
   * 没有就是默认小模型；手改坏了当没设（parseStoredJudge），不改写。 */
  judge?: JudgeSelectionStored;
}

/** 开启 AI 的完整配置；不允许只填 model 或只填 effort。 */
export interface SessionTitleAiConfig {
  enabled: true;
  model: string;
  effort: ReasoningEffort;
}

/** 某一 agent 后端的会话标题策略。开启 AI 时 model + effort 必须成对存在。 */
export type SessionTitleBackendConfig = { enabled?: false; model?: string; effort?: ReasoningEffort } | SessionTitleAiConfig;

export type GlobalSessionTitlePolicy = { enabled: false } | (SessionTitleAiConfig & { backend: string });

/** 所有会话共用一个标题策略，byBackend 仅供旧配置迁移。 */
export interface SessionTitlesConfig {
  policy?: GlobalSessionTitlePolicy;
  byBackend?: Record<string, SessionTitleBackendConfig | undefined>;
}

/** Effort values accepted by each host protocol for an isolated title turn.
 * This constrains the transport, not the model id: third-party/custom models
 * remain unrestricted. Unknown future backends receive the full bridge ladder. */
export function getSessionTitleEfforts(backendId: string): readonly ReasoningEffort[] {
  if (backendId === 'claude-agent') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return REASONING_EFFORTS;
}

/** Claude has a finite SDK effort protocol; Codex accepts native provider IDs. */
export function acceptsBackendEffort(backendId: string, effort: unknown): effort is ReasoningEffort {
  return typeof effort === 'string' && effort.length > 0 && effort.length <= 1000 && effort === effort.trim()
    && (backendId !== 'claude-agent' || getSessionTitleEfforts(backendId).includes(effort));
}

/** 消费侧可以直接使用的完整联合：关闭时绝不携带模型参数。 */
export type ResolvedSessionTitleBackendConfig =
  | { enabled: false }
  | { enabled: true; model: string; effort: ReasoningEffort };

/**
 * 云文档评论流的全局可配项。仅三个短标量（后端 / 模型 / 推理强度），都可空——
 * 空即回落后端默认。提示词刻意不放这里（多行长文本不适合塞 config.json），而是
 * 用磁盘上的 `comment-instructions.md`，让用户像编辑 AGENTS.md 一样直接改。
 */
export interface CommentsConfig {
  /** 评论流新会话用的后端 id（如 'codex-appserver' / 'claude-agent'）。缺省 → DEFAULT_BACKEND_ID。 */
  backend?: string;
  /** 评论流新会话的默认模型 id。缺省 → 后端默认模型。 */
  model?: string;
  /** 评论流新会话的默认推理强度。缺省 → 模型默认。 */
  effort?: ReasoningEffort;
}

export interface AppConfig {
  accounts: {
    app: AppCredentials;
  };
  secrets?: SecretsConfig;
  preferences?: AppPreferences;
}

export function isComplete(cfg: Partial<AppConfig>): cfg is AppConfig {
  const app = cfg.accounts?.app;
  return Boolean(app?.id && hasSecret(app?.secret) && app?.tenant);
}

function hasSecret(s: SecretInput | undefined): boolean {
  if (!s) return false;
  if (typeof s === 'string') return s.length > 0;
  return Boolean(s.source && s.id);
}

export function isSecretRef(s: SecretInput): s is SecretRef {
  return typeof s === 'object' && s !== null;
}

/** keystore key for the bot's App Secret. */
export function secretKeyForApp(appId: string): string {
  return `app-${appId}`;
}

export function getMessageReplyMode(cfg: AppConfig): MessageReplyMode {
  const raw = cfg.preferences?.messageReply;
  if (raw === 'card' || raw === 'markdown' || raw === 'text') return raw;
  return 'card';
}

export function getShowToolCalls(cfg: AppConfig): boolean {
  return cfg.preferences?.showToolCalls !== false;
}

/**
 * 「模型显示」档位（默认 running／仅输出时）。兼容历史布尔值：true→always、
 * false→off。运行卡按此决定右下角「模型 · 推理强度」脚注：running 仅运行卡显示，
 * always 终态卡也保留，off 不显示。
 */
export function getModelDisplay(cfg: AppConfig): ModelDisplayMode {
  const v = cfg.preferences?.showModel;
  if (v === 'running' || v === 'always' || v === 'off') return v;
  if (v === true) return 'always';
  if (v === false) return 'off';
  return 'running';
}

export function getMaxConcurrentRuns(cfg: AppConfig): number {
  const raw = cfg.preferences?.maxConcurrentRuns;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) return 10;
  return Math.min(Math.floor(raw), 50);
}

export function getRequireMentionInGroup(cfg: AppConfig): boolean {
  return cfg.preferences?.requireMentionInGroup !== false;
}

export function getPendingPolicy(cfg: AppConfig): PendingPolicy {
  return cfg.preferences?.pendingPolicy === 'queue' ? 'queue' : 'steer';
}

/**
 * Safely normalize the ordinary group-task completion reminder settings.
 * Unknown modes fall back to `failures`; invalid/non-positive thresholds use
 * the 3-minute default, while positive out-of-range values are clamped.
 */
export function getCompletionReminderConfig(cfg: AppConfig): ResolvedCompletionReminderConfig {
  const raw = cfg.preferences?.completionReminder;
  const mode: CompletionReminderMode =
    raw?.mode === 'manual' || raw?.mode === 'long' || raw?.mode === 'always'
      ? raw.mode
      : 'failures';
  const minutes = raw?.longTaskMinutes;
  const longTaskMinutes =
    typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0
      ? COMPLETION_REMINDER_LONG_TASK_DEFAULT_MINUTES
      : Math.min(
          COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
          Math.max(COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES, Math.floor(minutes)),
        );
  const template = completionTemplateSchema.safeParse(raw?.template).success ? raw!.template! : null;
  return { mode, longTaskMinutes, ...(template ? {template} : {}) };
}

/** The per-run “完成后提醒我” button only exists in manual mode. */
export function shouldShowCompletionReminderButton(cfg: AppConfig): boolean {
  return getCompletionReminderConfig(cfg).mode === 'manual';
}

/** Terminal states understood by the ordinary group-task reminder policy. */
export type CompletionReminderOutcome = 'done' | 'error' | 'idle_timeout' | 'interrupted' | 'cancelled';

export interface CompletionReminderDecision {
  outcome: CompletionReminderOutcome;
  /** Wall-clock duration for this queued/running turn, in milliseconds. */
  elapsedMs: number;
  /** Whether the initiator enabled the one-shot reminder on this run. */
  manuallyRequested?: boolean;
}

/**
 * Decide whether an ordinary task terminal should emit a separate reminder.
 * User interruption / queue cancellation never notify. `long` is based only on
 * elapsed wall-clock time; `failures` covers agent errors and the idle watchdog.
 */
export function shouldSendCompletionReminder(cfg: AppConfig, decision: CompletionReminderDecision): boolean {
  if (decision.outcome === 'interrupted' || decision.outcome === 'cancelled') return false;
  const reminder = getCompletionReminderConfig(cfg);
  switch (reminder.mode) {
    case 'manual':
      return decision.manuallyRequested === true;
    case 'long': {
      const elapsedMs = Number.isFinite(decision.elapsedMs) ? Math.max(0, decision.elapsedMs) : 0;
      return elapsedMs >= reminder.longTaskMinutes * 60_000;
    }
    case 'always':
      return true;
    case 'failures':
      return decision.outcome === 'error' || decision.outcome === 'idle_timeout';
  }
}

export function getAgentStopGraceMs(cfg: AppConfig): number {
  const raw = cfg.preferences?.agentStopGraceMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 5000;
  return Math.min(30_000, Math.max(100, Math.floor(raw)));
}

/** Watchdog clamp bounds in seconds — shared by the read path and the settings
 * card's custom-input validation so stored value == effective value. */
export const RUN_IDLE_TIMEOUT_MIN_SEC = 10;
export const RUN_IDLE_TIMEOUT_MAX_SEC = 3600;
/** product.md 3.12: ten minutes without output (bridge used 120 s). Only the
 * default moved; a stored value, including an explicit 120, is kept. */
export const RUN_IDLE_TIMEOUT_DEFAULT_SEC = 600;

/** A stored or submitted watchdog value as it will take effect: 0 stays off,
 * anything else is clamped to [MIN, MAX]; unusable input gives the default. */
export function normalizeRunIdleTimeoutSeconds(raw: unknown): number {
  if (raw === 0) return 0;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return RUN_IDLE_TIMEOUT_DEFAULT_SEC;
  return Math.min(Math.max(Math.floor(raw), RUN_IDLE_TIMEOUT_MIN_SEC), RUN_IDLE_TIMEOUT_MAX_SEC);
}

/** Per-turn idle watchdog in ms, or undefined when turned off (`0`). */
export function getRunIdleTimeoutMs(cfg: AppConfig): number | undefined {
  const sec = normalizeRunIdleTimeoutSeconds(cfg.preferences?.runIdleTimeoutSeconds);
  return sec === 0 ? undefined : sec * 1000;
}

/**
 * @deprecated 全局响应白名单已由项目级 {@link isUserAllowedInProject} 取代，不再使用。
 * 保留以防外部引用；新代码请用 isUserAllowedInProject。
 */
export function isUserAllowed(cfg: AppConfig, senderId: string): boolean {
  const list = cfg.preferences?.access?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

/** True when `chatId` is one the bot responds in. Empty list = all. */
export function isChatAllowed(cfg: AppConfig, chatId: string): boolean {
  const list = cfg.preferences?.access?.allowedChats;
  if (!list || list.length === 0) return true;
  return list.includes(chatId);
}

/** The only role (product.md section 6): on the list or not. Feishu's own roles and who scanned do not count. */
export function isAdmin(cfg: AppConfig, senderId: string): boolean {
  return Boolean(senderId) && Boolean(cfg.preferences?.access?.admins?.includes(senderId));
}

/** 替 Bot 说话时要一个人：创建者还是管理员就是创建者，否则是名单第一个。不代表权限比别人大。 */
export function primaryAdmin(cfg: AppConfig): string | undefined {
  const { ownerOpenId, admins = [] } = cfg.preferences?.access ?? {};
  return ownerOpenId && admins.includes(ownerOpenId) ? ownerOpenId : admins[0];
}

/** True when `senderId` may make the bot respond in a project group. admin
 * 恒豁免；项目白名单空/缺省 = 所有人。project 用结构化 Pick 类型避免 schema→registry
 * 循环依赖。 */
export function isUserAllowedInProject(
  cfg: AppConfig,
  project: { allowedUsers?: string[]; dm?: unknown } | undefined,
  senderId: string,
): boolean {
  if (isAdmin(cfg, senderId)) return true;
  // A private chat has no allow list: its only door is the admin list (dm-agent 5).
  if (project?.dm) return false;
  const list = project?.allowedUsers;
  if (!list || list.length === 0) return true;
  return list.includes(senderId);
}

/** 云文档评论流的全局配置（每个字段都可空，消费侧自带回落）。缺字段不崩——
 * loadConfig 返回 Partial 时这里返回空对象。 */
export function getCommentsConfig(cfg: AppConfig): CommentsConfig {
  return cfg.preferences?.comments ?? {};
}

/** Resolve the Bot-wide policy. A present global policy always wins, including disabled.
 * Legacy selection is stable and never depends on the conversation's backend. */
export function getSessionTitleConfig(cfg: AppConfig, _sessionBackend?: string): GlobalSessionTitlePolicy {
  const titles = cfg.preferences?.sessionTitles;
  const resolve = (raw: SessionTitleBackendConfig | undefined, backend: string): GlobalSessionTitlePolicy => {
    if (raw?.enabled !== true || typeof raw.model !== 'string' || !raw.model.trim() ||
      !acceptsBackendEffort(backend, raw.effort)) return { enabled: false };
    return { enabled: true, backend, model: raw.model.trim(), effort: raw.effort };
  };
  const known = ['codex-appserver', 'claude-agent'];
  if (titles && Object.hasOwn(titles, 'policy')) {
    const policy = titles.policy;
    return policy?.enabled && known.includes(policy.backend) ? resolve(policy, policy.backend) : { enabled: false };
  }
  const preferred = cfg.preferences?.defaults?.backend ?? 'codex-appserver';
  for (const backend of [...new Set([preferred, ...known])].filter(id => known.includes(id))) {
    const policy = resolve(titles?.byBackend?.[backend], backend);
    if (policy.enabled) return policy;
  }
  return { enabled: false };
}

export function summarizeSessionTitleConfig(cfg: AppConfig, _backendId?: string): string {
  const resolved = getSessionTitleConfig(cfg);
  return resolved.enabled ? `AI 精炼：${resolved.model} · ${resolved.effort}` : '不使用模型（截断首句）';
}

export function summarizeSessionTitles(
  cfg: AppConfig,
  effortLabel: (effort: string) => string = (effort) => effort,
): string {
  const policy = getSessionTitleConfig(cfg);
  if (!policy.enabled) return '截断首句';
  const backend = policy.backend === 'claude-agent' ? 'Claude Code' : 'Codex';
  return `${backend}：AI 精炼 · ${policy.model} · ${effortLabel(policy.effort)}`;
}
