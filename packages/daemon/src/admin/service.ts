import { pendingGroupsFile, readPendingGroups, type PendingGroup } from '../project/pending-groups';
import type { CollaborationRequest } from './collaboration';
import {runtimeDistribution} from '../service/distribution';
import { createSettingsService } from './settings-service';
import { admitLibraryWorkspace, botLabel, createHostLibrary, type AdminLibraryOp, type HostLibrary } from './library';
import { routeFeishuApi, routeFeishuRead, type FeishuReach } from './feishu-route';
import type { ApiRequest } from '../feishu-read/api';
import type { FeishuReadReply, FeishuReadRequest } from '../feishu-read/reader';
import { isProjectId, readLibrary } from '../project/library';
import { projectRevision, projectView } from './collaboration';
import { AdminWriteError } from './ops';
import type { HostSettings } from './settings-types';
import type { AdminSettingsReadOp } from './ipc';
import { CodexSetupService, type CodexSetup } from '../agent/codex-appserver/setup';
import { shutdownResidentClients } from '../agent/codex-appserver/client-pool';
import { compareCodexVersions, parseCodexVersion } from '../agent/codex-appserver/version';
import { fetchUsageBundle } from '../agent/usage';
import { stopClaudeLocalStats } from '../agent/claude-agent/local-stats';
import { parseJoinedGroups, parseGroupMembers, parseGroupMembership, type GroupMembers, type AdminGroupOp, type BindGroupInput, type JoinedGroups } from './groups';
import { voiceView } from '../voice/view';
import type { VoiceAction, VoiceView } from '../voice/types';
import { readFile, realpath, rm, stat } from 'node:fs/promises';
import { botIdentity, loadBots, setBotActivation, setBotBadgeNumber, removeBot, type BotIdentity } from '../config/bots';
import { assertRecipeRemovalSafe, RecipeRecoveryRequired } from '../recipe/store';
import { dmPreparationError, prepareDmProjectForBot } from '../bot/dm-project';
import { botPaths, botDir, paths } from '../config/paths';
import { configuredProjectsRoots, directoryContext, legacyDirectoryProblems } from '../project/directory-audit';
import type { DirectoryProblem, ScheduleReply, ScheduleRequest } from '@vonvon/protocol';
import type { ScheduleActor } from './schedule-commands';
import { removeSecret } from '../config/keystore';
import {
  getCompletionReminderConfig,
  isComplete,
  secretKeyForApp,
  type AppConfig,
  type CompletionReminderMode,
  type ResolvedCompletionReminderConfig,
} from '../config/schema';
import {
  dmProject,
  noMentionOf,
  sessionModeOf,
  listProjectsIn,
  type Project,
  type SessionMode,
} from '../project/registry';
import { isRetiredKey, listSessionsIn } from '../bot/session-store';
import { loadConfig } from '../config/store';
import { groupBackendId, groupPermission } from '../config/execution';
import { resolveAppSecret } from '../config/secret-resolver';
import { createAgentAvatarProvider, createGroupAvatarProvider } from './avatar';
import { createBadgeOwnerNames } from './badge-owner';
import { getAppRoleSnapshot } from '../config/app-roles';
import { diagnoseEventSubscription, type EventDiagnosis } from '../utils/event-diagnosis';
import { diagnoseCardCallbackConfiguration, type CardCallbackConfiguration } from '../utils/card-callback-diagnosis';
import { validateAppCredentials } from '../utils/feishu-auth';
import { buildAppConsoleUrl, buildScopeGrantUrl, buildEventConfigUrl } from '../config/scopes';
import { readCardCallbackStatus, writeSetupProgress } from '../config/setup-progress';
import { refreshBotCredentials } from '../bot/refresh-bot';
import { syncBotName } from '../bot/bot-name';
import { registerBotFromCredentials } from '../bot/register-bot';
import {
  startRegistration,
  registrationErrorCode,
  registrationErrorMessage,
  type RegistrationQr,
  type RegistrationStatus,
} from '../bot/wizard';
import {
  backendIds,
  createBackend,
  DEFAULT_BACKEND_ID,
  visibleCatalog,
  catalogById,
  isInstallable,
  effectiveDefaultBackend,
  installBackendDep,
  isBackendInstalledInUserDir,
  installedBackendVersion,
  latestNpmVersion,
  type BackendCatalogEntry,
  type InstallResult,
  type UninstallResult,
  type InstallProgress,
} from '../agent';
import type { AccountUsageBundle, BackendDepState, BackendLogin, BackendProbe, PermissionMode } from '../agent/types';
import { log, readRecentLogs } from '../core/logger';
import {
  checkUpdate as checkUpdateImpl,
  readUpdateStatus,
  type UpdateCheck,
  type UpdateStatus,
} from '../service/update';
import { bridgeVersion } from '../core/version';
import { collectHostDoctor, toDaemonStatus, type DaemonStatus, type HostDoctor } from './host';
import { controlDesktopService } from '../host/service';
import type { AdminWriteOp } from './ops';

/**
 * 管理面共享服务层（设计：.plans/auto-optimize/design/admin-surface.md）。
 *
 * 【契约】DM 卡片回调与 Web API **共享同一写逻辑**：
 *   - 体验对齐原则「Web 能操作的飞书也能操作」——本接口的方法清单严格对齐
 *     DM 私聊控制台已有的 dm.* 动作（src/card/dm-cards.ts）：
 *       listBots            ← CLI `bot list` / 多 bot 聚合视图
 *       listProjects        ← dm.projects（📁 项目列表）
 *       getProject          ← dm.projectSettings（⚙️ 项目设置）
 *       switchBackend       ← dm.proj.backend.submit（🧠 后端 · 切换）
 *       setPermissionMode   ← dm.proj.perm.submit（🔐 权限 · 保存）
 *       setNoMention        ← dm.proj.noMention（✋ 免@）
 *       setCompletionReminder ← dm.set.completionReminder（🔔 完成提醒）
 *       doctorBackends      ← dm.doctor 的后端探测段（🩺 诊断）
 *       eventDiagnosis      ← dm.doctor 的事件订阅三态段（M-7）
 *       listSessions        ← dm.projectTopics（🧵 话题钻取）
 *       tailLogs            ← CLI `logs`（DM 够不着的宿主机域）
 *   - 写方法与 DM 的 dm.* 回调 handler 走**同一套共享纯函数**（admin/ops.ts 的
 *     perform*）：同样的校验、同样的会话驱逐、同样的落盘——双端行为零漂移。
 *
 * 【进程形态】写操作必须在持有该 bot registry/LIVE 会话的进程内执行：
 *   - 单 bot inline `run`：daemon 进程内直接调 Orchestrator.adminExecute。
 *   - 多 bot supervisor：经 IPC（admin/ipc.ts）转发给对应 bot 子进程执行。
 *   - 独立预览进程（`web` 命令、daemon 未跑）：无 executeWrite → 写抛
 *     {@link NotWiredYetError}（HTTP 501，只读预览）。
 *
 * 【实现注意】所有跨 bot 读取走 {@link botPaths} 的**显式路径**（listProjectsIn /
 * listSessionsIn / loadConfig(file)），绝不 useBotDir 全局切目录——daemon 进程内
 * 切目录会把在跑 bot 的 paths 指到别的 bot（第一棒遗留的坑，本棒修掉）。
 */
export interface AdminService {
  /** true only in the read-only preview process: it refuses every write, memory writes included */
  readonlyPreview?: boolean;
  collaboration?(botId: string, request: CollaborationRequest): Promise<unknown>;
  /** Scheduled tasks of one bot, as `actor`; the bot process checks scope and roles (admin/schedule-commands.ts). Refusals are replies, not errors. */
  executeSchedule?(botId: string, actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply>;
  /** The project library (admin/library.ts): its workspace is changed only through here. */
  library?: HostLibrary;
  accountUsage(force: boolean, backend?: 'codex-appserver' | 'claude-agent'): Promise<AccountUsageBundle>;
  settings?: HostSettings;
  codexSetup?(opts?: { refresh?: boolean }): Promise<CodexSetup>;
  close?(): Promise<void>;
  pendingGroups?(botId: string): Promise<{ groups: PendingGroup[] }>;
  joinedGroups?(botId: string, cursor?: string): Promise<JoinedGroups>;
  groupMembers?(botId: string, chatId: string, cursor?: string): Promise<GroupMembers>;
  recipeAuthoring?: (botId: string, op: import('../recipe/authoring-service').AuthoringIpc) => Promise<unknown>;
  assertGroupMembership?(botId: string, chatId: string, identity: BotIdentity): Promise<void>;
  /** dm-agent 7.3: a Feishu read, on the Bot `reach` comes to (admin/feishu-route.ts). Refusals are replies, not errors. */
  feishuRead?(reach: FeishuReach, request: Omit<FeishuReadRequest, 'only'>): Promise<FeishuReadReply>;
  /** dm-agent 7.6: `feishu_api` on the Bot named. A private chat's tool only, through the host: no RPC reaches it. */
  feishuApi?(bot: string, request: ApiRequest): Promise<FeishuReadReply>;
  bindGroup?(botId: string, input: BindGroupInput): Promise<AdminProject>;
  getVoice(botId: string): Promise<VoiceView>;
  setVoice(botId: string, action: VoiceAction): Promise<void>;
  /** 全部已注册 bot + 进程在跑状态（daemon 内 = 真实 WS 状态；预览 = 锁文件探测）。 */
  listBots(): Promise<AdminBot[]>;
  /** 某 bot 的项目列表（含话题数等聚合字段），对齐 DM 📁 项目列表。 */
  listProjects(botId: string): Promise<AdminProject[]>;
  /** 这个 Bot 的私聊那一行，不在 listProjects 里；Bot 还没跑过时没有。 */
  dmRow?(botId: string): Promise<AdminProject | undefined>;
  /** 单个项目详情；不存在返回 undefined。 */
  getProject(botId: string, name: string): Promise<AdminProject | undefined>;
  /** 🧠 切换项目后端（写）。与 DM dm.proj.backend.submit 同一套校验+落盘。 */
  switchBackend(botId: string, projectName: string, backendId: string): Promise<void>;
  /** 🔐 设置权限档（权限档/联网）（写），含驱逐活跃会话的既有语义。 */
  setPermissionMode(
    botId: string,
    projectName: string,
    opts: { mode: PermissionMode },
  ): Promise<void>;
  /** ✋ 免@ 开关（写）。 */
  setNoMention(botId: string, projectName: string, on: boolean): Promise<void>;
  /** 🔔 每 bot 的普通任务结束提醒（写）；经 bot 进程落盘并热更新 LIVE cfg。 */
  setCompletionReminder(
    botId: string,
    value: { mode: CompletionReminderMode; longTaskMinutes: number },
  ): Promise<void>;
  /** 🩺 对全部注册后端做环境体检（doctor 探测，绝不抛错）。 */
  doctorBackends(): Promise<AdminBackendStatus[]>;
  /** 事件订阅三态诊断（ok / missing / unpublished / unchecked，绝不抛错）。 */
  eventDiagnosis(botId: string): Promise<EventDiagnosis>;
  /** 某项目的话题（会话）列表，新→旧，对齐 DM 🧵 话题钻取。 */
  listSessions(botId: string, projectName: string): Promise<AdminSession[]>;
  /** 最近文件日志尾部（JSON lines 文本）。 */
  tailLogs(opts?: { maxBytes?: number }): Promise<string>;

  // ── Web 专属：扫码初始化 / 添加机器人（day-0 场景）─────────────────────────
  /**
   * 某 bot 的初始化 checklist 聚合三/四态：密钥有效（探活）/ 长连接在线 / 事件订阅
   * 三态诊断（复用 M-7）/ 缺失 scope 清单 + 一键深链。向导页 5s 轮询它直到「事件已
   * 生效」。绝不 throw——每段独立降级。
   */
  getSetupStatus(botId: string): Promise<AdminSetupStatus>;
  /** Local receipt evidence and manual confirmation only; no Feishu API calls. */
  getCardCallbackStatus?(botId: string): Promise<AdminSetupStatus['cardCallback']>;
  /** 人工确认仅修改手动标记；撤销不能清除已收到真实回调的证据。 */
  confirmCardCallback(botId: string, confirmed: boolean): Promise<void>;
  /**
   * 扫码注册一个机器人（day-0 主路径）：编排 SDK registerApp 扫码会话 → 拿明文密钥
   * → 复用 registerBotFromCredentials 写盘（keystore + config + bots.json），扫码人
   * open_id 自动落成 owner+admin。绝不 throw——失败落 {@link QrRegisterFailure}
   * （HTTP/SSE 层据 code 映射）。callbacks 把 SDK 的 onQr/onStatus 透传给上层做 SSE，
   * signal 取消（abort → SDK reject code='abort'，本方法返回 {ok:false,code:'abort'}）。
   * 拿不到扫码人的 open_id 时拒绝落盘，避免产生无人可管理的机器人配置。
   * 新 Bot 默认启用：加进活跃集并启动连接，启动失败不算注册失败。
   */
  registerBotByQr(opts: {
    signal: AbortSignal;
    onQr: (info: RegistrationQr) => void;
    onStatus?: (info: RegistrationStatus) => void;
  }): Promise<QrRegisterResult | QrRegisterFailure>;

  refreshBotByQr(botId: string, opts: { signal: AbortSignal; onQr: (info: RegistrationQr) => void; onStatus?: (info: RegistrationStatus) => void }): Promise<QrRegisterResult | QrRegisterFailure>;

  // ── Web 专属：后端 catalog 预览 + 按需安装（backend-catalog-ondemand.md）──────
  /**
   * 列出后端 catalog，每条附依赖状态（installed/not-installed/external-missing）+
   * installable + approxSizeMB + version + 是否当前全局默认。读路径，绝不抛错，
   * 与 daemon/预览进程形态无关（只探本机装配，不写）。Web GET /api/backends 用它。
   */
  listBackendCatalog(): Promise<AdminBackendCatalog>;
  /**
   * 按需安装一个后端依赖（npm-ondemand 包）到用户私装目录。
   * 仅 installable 的后端可装；external-cli（codex）调用即 {ok:false} 带手动装法。
   * onProgress 透传 npm 输出（SSE {type:'log'}），signal 取消（kill 子进程 + 回滚半装）。
   * **install 是 daemon 注入态能力**（owns runtime）：只读预览进程无 installer 注入 →
   * 抛 {@link NotWiredYetError}（HTTP 501），引导先起 daemon。绝不 throw 其它错。
   */
  installBackend(
    id: string,
    onProgress?: InstallProgress,
    signal?: AbortSignal,
    opts?: { update?: boolean },
  ): Promise<InstallResult>;
  /**
   * 卸载一个装在用户私装目录的后端依赖（rm node_modules/<pkg> + 删 package.json 条目）。
   * 仅 canUninstall 的可卸（npm-ondemand + 确实装在用户目录）。卸载是 daemon 注入态能力
   * （owns runtime）→ 只读预览无注入 → 抛 {@link NotWiredYetError}（HTTP 501）。绝不 throw 其它。
   */
  uninstallBackend(id: string): Promise<{ ok: boolean; message: string }>;
  /**
   * 某后端的版本信息：已装版本（用户私装目录 package.json）+ npm 上最新版 + 有无更新。
   * 网络查询（npm view），较慢，按需调（不进 listBackendCatalog 以免拖慢每次刷新）。
   * 绝不抛错：查不到 latest → null、hasUpdate=false。
   */
  backendVersion(id: string): Promise<{ installed: string | null; latest: string | null; hasUpdate: boolean }>;
  /** 后端的登录状态（已登录 / 未登录 / 无法确认）。要起一次 CLI，按需调；`refresh` 跳过缓存。绝不抛错。 */
  backendLogin(id: string, refresh: boolean): Promise<BackendLogin>;

  // ── Web 专属：daemon 生命周期 / 升级 / 多 bot 管理 / 宿主机体检 ──────────────
  getDaemonStatus(): Promise<DaemonStatus>;
  restartDaemon(): Promise<void>;
  startDaemon(): Promise<void>;
  stopDaemon(): Promise<void>;
  /** 检查 npm 上有无新版（current / latest / hasUpdate / dev）。绝不抛错（latest=null 兜底）。 */
  checkUpdate(): Promise<UpdateCheck>;
  /**
   * 读最近一次升级的进度/结果（installing/restarting/done/error），供 Web 轮询——尤其
   * 失败：detached helper 的失败否则对网页端完全静默。无记录返回 null。绝不抛错。
   */
  updateStatus(): UpdateStatus | null;
  applyUpdate(): Promise<UpdateStatus | void>;
  /** 宿主机体检：后端环境（复用 doctorBackends）+ Node/平台/配置目录/日志体量。绝不抛错。 */
  hostDoctor(): Promise<AdminHostDoctor>;
  setBotEnabled(appId: string, enabled: boolean): Promise<BotActivationResult>;
  setBotBadgeNumber(appId: string, badgeNumber: string): Promise<BotMutationResult>;
  /**
   * 删除某 bot：注册表 + keystore 密钥 + 状态目录。**拒绝删除当前唯一 bot 或带
   * 运行中会话的 bot**——返回 { ok:false, reason } 让 UI 给清晰提示，绝不 throw。
   */
  deleteBot(appId: string): Promise<BotMutationResult>;
}

/** setBotEnabled / deleteBot 的统一返回：ok 或带中文拒因（HTTP 层映射 409）。 */
export type BotActivationResult = { ok: true; activation: 'applied' | 'restartRequired'; message: string } | { ok: false; reason: string };

export type BotMutationResult = { ok: true } | { ok: false; reason: string };

/** 宿主机体检聚合：宿主机域（host.ts）+ 后端环境探测（doctorBackends 同源）。 */
export interface AdminHostDoctor extends HostDoctor {
  backends: AdminBackendStatus[];
}

/** 只读预览（daemon 未跑 / 独立 `web` 进程）里写方法统一抛它；HTTP 层映射 501。 */
export class NotWiredYetError extends Error {
  readonly code = 'NOT_WIRED_YET';
  constructor(action: string) {
    super(
      `「${action}」需要 daemon 在跑：当前是只读预览（直读本机文件）。` +
        '请先运行 `vonvon daemon start` 启动 daemon，再用 `vonvon open` 打开控制台执行写操作。',
    );
    this.name = 'NotWiredYetError';
  }
}

export interface AdminBot {
  registeredAt?: number;
  ownerName?: string;
  name: string;
  badgeNumber?: string;
  appId: string;
  tenant: 'feishu' | 'lark';
  botName?: string;
  avatarDataUrl?: string;
  /** run/start 会带起它（bot use 的多选活跃集） */
  active: boolean;
  /** bots.json 的 current（单 bot 代码路径的主 bot） */
  current: boolean;
  /** bridge 进程在跑吗。daemon 进程内 = 本进程/子进程的真实状态；预览进程 =
   * 单实例锁文件 + signal 0 探测。 */
  running: boolean;
  pid?: number;
  startedAt?: number;
  /** 真实 WS 长连接状态（connected / connecting / reconnecting / …）。仅 daemon
   * 进程内（本进程的 channel / 子进程 IPC 上报）可用；预览进程缺省。 */
  connection?: string;
  /** 每 bot 的普通任务结束提醒 effective 配置（缺省 = failures / 3 分钟）。 */
  completionReminder: ResolvedCompletionReminderConfig;
}

/** daemon 进程内的实时运行状态（注入 {@link AdminServiceDeps.liveStatus}）。 */
export interface BotLiveStatus {
  running: boolean;
  pid?: number;
  startedAt?: number;
  connection?: string;
}

/** 项目快照——effective 值（缺省已按 registry 的单一事实源解析），UI 直接渲染。 */
export interface AdminProject {
  enabled?: boolean;
  avatarDataUrl?: string;
  name: string;
  chatId: string;
  cwd: string;
  /** The library project this binding belongs to (project/library.ts); absent until the daemon has linked the row. */
  projectId?: string;
  blank: boolean;
  branch?: string;
  kind: SessionMode;
  origin: 'created' | 'joined';
  /** effective 免@（noMentionOf） */
  noMention: boolean;
  /** effective 权限档，群里所有人都用它 */
  mode: PermissionMode;
  /** @deprecated since s15c always equal to the group's one tier; kept so clients from before s15c still parse */
  guestMode: PermissionMode;
  network: boolean;
  /** effective 后端 id（显式 backend ?? Codex，与运行时路由同源，见 config/execution.ts） */
  backend: string;
  allowedUsersCount: number;
  /** 🧵 话题数（该群名下的会话记录数） */
  sessionCount: number;
  createdAt: number;
  /** Where an old creation entry put the directory wrongly (s36c2d); absent when it is fine. */
  directoryProblem?: DirectoryProblem;
}

export interface AdminSession {
  threadId: string;
  chatId: string;
  summary: string;
  backend: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AdminBackendStatus {
  id: string;
  name: string;
  ok: boolean;
  version: string | null;
  location?: string;
  hint?: string;
  /** 全局默认后端（项目未显式选择时用它） */
  isDefault: boolean;
}

/** 添加机器人向导的 checklist 聚合（GET /api/bots/:appId/setup-status）。 */
export interface AdminSetupStatus {
  appId: string;
  tenant: 'feishu' | 'lark';
  botName?: string;
  /** ① 密钥有效（tenant_access_token 探活）；undefined = 该 bot 配置缺失，没法探。 */
  credentials: { ok: boolean; reason?: string; unreachable?: boolean };
  /** ② bridge 长连接在线状态：running（进程在跑吗）+ connection（真实 WS，仅 daemon 内有）。 */
  connection: { running: boolean; connection?: string };
  /** ③ 事件订阅三态诊断（复用 M-7 event-diagnosis）。 */
  event: EventDiagnosis;
  /**
   * ④ 必需 scope 中尚未授权的（undefined = 没查成；空 = 已齐全）+ 一键授权深链。
   * missingJoinScopes 是加入现有群要的 scope（同样三态）：缺了只提醒——拉进群不会提醒绑定，查找已加入的群会失败。
   * grantUrl 始终给（预选全部 scope，缺啥点一次补齐）。
   * missingTools 是 Bot 自己的飞书工具要的 scope，不进 grantUrl，缺的时候由 toolsGrantUrl 单独预选（dm-agent 6.5）。
   */
  scopes: {
    missingRequired?: string[];
    missingJoinScopes?: string[];
    missingOptional?: string[];
    missingTools?: string[];
    grantUrl: string;
    toolsGrantUrl?: string;
  };
  /** 开发者后台「事件与回调」配置页深链。 */
  eventConfigUrl: string;
  /** 开发者后台这个应用的首页（版本管理与发布在里面）。 */
  consoleUrl: string;
  /** ⑤ 飞书配置、真实回调证据和本机人工确认分别记录，配置查询不写入本机确认。 */
  cardCallback: { confirmed: boolean; verifiedAt?: number; configuration?: CardCallbackConfiguration };
}

/** 扫码注册成功：基本信息 + adminOpenId（扫码人 = owner）。
 * 绝不含 client_secret（已进 keystore）。Web SSE 的 done 事件 payload 据此组装。 */
export interface QrRegisterResult {
  ok: true;
  appId: string;
  name: string;
  tenant: 'feishu' | 'lark';
  botName?: string;
  /** 扫码人 open_id（已落成 owner+admin）。 */
  adminOpenId: string;
  /** 必需 scope 中尚未授权的（undefined = 没查成；空 = 已齐全）。 */
  missingScopes?: string[];
}

/** 扫码注册失败：code 来自 SDK reject（abort/expired_token/access_denied）或身份缺失
 * （identity_missing）/ 写盘（persist_failed）/ 校验（credential_rejected）。 */
export interface QrRegisterFailure {
  ok: false;
  code:
    | 'abort'
    | 'expired_token'
    | 'access_denied'
    | 'identity_missing'
    | 'already_registered'
    | 'stale_target'
    | 'persist_failed'
    | 'credential_rejected'
    | 'network'
    | 'unknown';
  reason: string;
}

/** GET /api/backends 的聚合：catalog 全条目（含安装态）+ 当前全局默认后端 id。 */
export interface AdminBackendCatalog {
  /** 当前有效全局默认后端 id（项目未显式选择时路由到它）。 */
  defaultBackend: string;
  entries: AdminBackendCatalogEntry[];
}

/** 一条后端 catalog 的管理面投影：catalog 元数据 + 本机探测出的安装/可用态。 */
export interface AdminBackendCatalogEntry {
  id: string;
  agentFamily: string;
  displayName: string;
  /** 接入方式短名（app-server / sdk / acp）。 */
  access: string;
  blurb?: string;
  /** 依赖类型（external-cli / npm-ondemand / npm-external）。 */
  depKind: string;
  /** 安装态三态：installed / not-installed（可一键装）/ external-missing（手动装）。 */
  depState: BackendDepState;
  /** 可一键按需下载（npm-ondemand 且当前未装 → true）。 */
  installable: boolean;
  /** 体积提示 MB（下载确认用）。 */
  approxSizeMB?: number;
  /** 探测到的版本（external-cli 的 codex --version 等；未装/无版本 → null）。 */
  version: string | null;
  /** 实际优先加载的包版本（开发依赖或用户托管安装）。 */
  installedVersion: string | null;
  /** 能否一键卸载（仅用户目录中的托管安装）。 */
  canUninstall: boolean;
  /** !installed 时的人读提示（external 给手动装法 / npm-ondemand 给「点下载」）。 */
  hint?: string;
  /** 是否当前全局默认。 */
  isDefault: boolean;
  /** 本后端支持的权限档（undefined ⇒ 全档）。 */
  supportedModes?: readonly PermissionMode[];
}

/** daemon/预览两种进程形态的差异全部收进这几个注入点；读路径完全同源。 */
export interface AdminServiceDeps {
  fetchAccountUsage?: (force: boolean, backend?: 'codex-appserver' | 'claude-agent') => Promise<AccountUsageBundle>;
  applyBotActivation?: (appId: string, enabled: boolean) => Promise<void>;
  executeSettingsRead?: (botId: string, op: AdminSettingsReadOp) => Promise<unknown>;
  codexTools?: CodexSetupService;
  executeCollaboration?: (botId: string, request: CollaborationRequest) => Promise<unknown>;
  recipeAuthoring?: AdminService['recipeAuthoring'];
  executeGroups?: (botId: string, op: AdminGroupOp) => Promise<unknown>;
  executeWrite?: (botId: string, op: AdminWriteOp) => Promise<unknown>;
  /** Asks a running bot process to follow a project's new workspace (admin/library.ts `AdminLibraryOp`). */
  executeLibrary?: (botId: string, op: AdminLibraryOp) => Promise<unknown>;
  /** Forwards a scheduled-task request to the bot process; a bot that is not running replies `refused bot-not-running`. */
  executeSchedule?: (botId: string, actor: ScheduleActor, request: ScheduleRequest) => Promise<ScheduleReply>;
  /** Runs a Feishu read in the bot's process, undefined when it has none: its answer is unchecked until the route parses it. */
  executeFeishuRead?: (botId: string, request: FeishuReadRequest) => Promise<unknown>;
  executeFeishuApi?: (botId: string, request: ApiRequest) => Promise<unknown>;
  /** Tells a running bot that its scopes look granted; it sends what it still owes its creator (dm-agent 第一次见面). */
  firstHello?: (botId: string) => Promise<void>;
  /** 实时运行状态（daemon 进程内：本进程 channel / 子进程 IPC）。返回 undefined
   * 或缺省 → 回退锁文件探测（该 bot 不归本 daemon 管，如未激活的 bot）。 */
  liveStatus?: (botId: string) => Promise<BotLiveStatus | undefined>;
  /** daemon 进程启动时刻（内嵌 web 注入）；只读预览不传 → uptime 缺省。 */
  daemonStartedAt?: number;
  restartDaemon?: () => void;
  applyUpdate?: () => UpdateStatus | void | Promise<UpdateStatus | void>;
  startDaemon?: () => void;
  stopDaemon?: () => void;
  /**
   * 只读预览标记（仅 {@link createReadonlyAdminService} 置 true）。置 true 时扫码注册机器人
   * （registerBotByQr，属写操作）一律 NotWiredYetError——「没启动只读」：加机器人
   * 必须先有 daemon 在跑。daemon 托管的服务不置此标记，注册照常。
   */
  readonlyPreview?: boolean;
  /**
   * 按需后端依赖的安装执行器（npm-ondemand → 用户私装目录）。daemon 进程注入
   * {@link installBackendDep}（它 owns runtime，装完即能解析加载）；只读预览进程
   * 不注入 → installBackend 抛 {@link NotWiredYetError}（HTTP 501）。测试可注入 mock
   * 推进度 / 模拟失败，不真跑 npm。
   */
  installBackend?: (
    pkg: string,
    onProgress?: InstallProgress,
    signal?: AbortSignal,
    opts?: { binName?: string },
  ) => Promise<InstallResult>;
  /** 卸载执行器（rm 用户私装目录里的包 + 清 package.json 条目）。daemon 进程注入
   * {@link uninstallBackendDep}；只读预览不注入 → uninstallBackend 抛 NotWiredYetError。 */
  uninstallBackend?: (pkg: string, opts?: { binName?: string }) => Promise<UninstallResult>;
}

// pendingGroupsSchema accepts at most 1,000 groups; stored records are retained.
const MAX_PENDING_GROUPS = 1000;

/**
 * AdminService 的统一实现：读路径直读 ~/.feishu-codex-bridge/bots/<appId>/ 下的
 * 注册表/会话文件（复用 registry / session-store / store 模块的显式路径导出，
 * 不自己解析 JSON；不碰全局 currentBotDir）；写路径与实时状态由 deps 注入。
 */
/** A project row with its effective values, before the counts and the avatar that depend on who is asking. */
function adminRow(p: Project): Omit<AdminProject, 'sessionCount'> {
  const permission = groupPermission(p);
  return {
    name: p.name,
    enabled: p.enabled !== false,
    chatId: p.chatId,
    cwd: p.cwd,
    ...(isProjectId(p.projectId) ? { projectId: p.projectId } : {}),
    blank: p.blank,
    branch: p.branch,
    kind: sessionModeOf(p),
    origin: p.origin ?? 'created',
    noMention: noMentionOf(p),
    mode: permission.effect.mode,
    guestMode: permission.effect.mode,
    network: permission.effect.network,
    // What the group's sessions actually start on: its own backend, else Codex (s36d2).
    backend: groupBackendId(p),
    allowedUsersCount: p.allowedUsers?.length ?? 0,
    createdAt: p.createdAt,
  };
}

export function createAdminService(deps: AdminServiceDeps = {}): AdminService {
  let activationQueue: Promise<unknown> = Promise.resolve();
  const codexTools = deps.codexTools ?? new CodexSetupService();
  const inFlightUsage = new Set<Promise<AccountUsageBundle>>();
  let closing: Promise<void> | undefined;
  const credentials = async (botId: string) => {
    const cfg = await loadConfig(botPaths(botId).configFile);
    if (!isComplete(cfg)) throw new Error('这个 Bot 的配置不完整');
    return { appId: botId, tenant: cfg.accounts.app.tenant, appSecret: await resolveAppSecret(cfg) };
  };
  const avatars = createAgentAvatarProvider({ credentials });
  const executeGroups = deps.executeGroups;
  const owners = createBadgeOwnerNames(executeGroups
    ? async (botId, chatId, cursor) => parseGroupMembers(await executeGroups(botId, { kind: 'groupMembers', chatId, cursor }))
    : undefined);
  const groupAvatars = createGroupAvatarProvider({ credentials });
  /**
   * 扫码注册的新 Bot 默认启用，和用户自己打开「启用 Bot」一样：在 setBotEnabled 的同一条队列里把它加进
   * 活跃集（其余 bot 的启停原样保留，旧安装按 current 回退的语义也保留），再启动它的连接。返回的 Promise
   * 只等落盘，不等启动：权限、事件还没配时启动可能失败，注册照样成功，Bot 仍算启用，界面按真实的运行和
   * 连接状态显示。
   */
  function enableRegisteredBot(appId: string): Promise<void> {
    const saved = activationQueue.then(async () => {
      await setBotActivation(appId, true);
    });
    const started = saved.then(async () => {
      try {
        await deps.applyBotActivation?.(appId, true);
      } catch (error) {
        log.warn('register-bot', 'start-failed', { appId, reason: error instanceof Error ? error.message : String(error) });
      }
    });
    activationQueue = started.catch(() => undefined);
    return saved;
  }
  async function projectsWithCounts(botId: string): Promise<AdminProject[]> {
    const files = botPaths(botId);
    const projects = await listProjectsIn(files.projectsFile);
    const sessions = await listSessionsIn(files.sessionsFile);
    const countByChat = new Map<string, number>();
    for (const s of sessions) {
      if (!isRetiredKey(s.threadId)) countByChat.set(s.chatId, (countByChat.get(s.chatId) ?? 0) + 1);
    }
    groupAvatars.retainChats(botId, new Set(projects.map(p => p.chatId).filter(Boolean)));
    const problems = await legacyDirectoryProblems(projects.map(p => p.cwd), await directoryContext(undefined, await configuredProjectsRoots(files.configFile)))
      .catch(() => projects.map(() => undefined));
    const result = projects.map((p, index) => ({
      ...adminRow(p),
      avatarDataUrl: groupAvatars.get(botId, p.chatId),
      sessionCount: p.chatId ? (countByChat.get(p.chatId) ?? 0) : 0,
      ...(problems[index] ? { directoryProblem: problems[index] } : {}),
    }));
    for (const project of projects) if (project.chatId) void groupAvatars.refresh(botId, project.chatId);
    return result;
  }

  /** 单实例锁文件（processes.json）→「bridge 进程在跑吗」。损坏/缺失一律视为
   * 未在跑（预览级探测，绝不抛错）。daemon 进程内只用于「不归本 daemon 管」的
   * bot（如未激活但被别的终端单独 run 起来的）。 */
  async function lockFileRunState(botId: string): Promise<BotLiveStatus> {
    try {
      const raw = await readFile(botPaths(botId).processesFile, 'utf8');
      const rec = JSON.parse(raw) as { pid?: number; startedAt?: number };
      if (typeof rec.pid === 'number' && isAlive(rec.pid)) {
        return { running: true, pid: rec.pid, startedAt: rec.startedAt };
      }
    } catch {
      /* 没锁文件 / 损坏 → 未在跑 */
    }
    return { running: false };
  }

  const routeBots = async () => (await loadBots()).bots.map(bot => ({ id: bot.appId, label: botLabel(bot), name: bot.name }));
  async function runState(botId: string): Promise<BotLiveStatus> {
    const live = await deps.liveStatus?.(botId).catch(() => undefined);
    return live ?? lockFileRunState(botId);
  }

  /** config 损坏/缺失不能拖垮整个 /api/state；按 schema 的安全默认值降级。 */
  async function completionReminderFor(botId: string): Promise<ResolvedCompletionReminderConfig> {
    try {
      return getCompletionReminderConfig((await loadConfig(botPaths(botId).configFile)) as AppConfig);
    } catch {
      return getCompletionReminderConfig({} as AppConfig);
    }
  }

  const library = createHostLibrary({ liveStatus: deps.liveStatus, executeLibrary: deps.executeLibrary, readonlyPreview: deps.readonlyPreview });
  /**
   * `editProject` with a folder for a group of a library project: the folder is the project's, so it goes through the
   * library (every group and bot of the project follows, §2.1) instead of the bot's own row. Left to the bot as it is
   * when the row has no project. The rest of the edit (会话方式, 启停) goes on to the bot afterwards, on the row as the
   * workspace change left it.
   */
  async function editProjectFolder(botId: string, request: Extract<CollaborationRequest, { action: 'editProject' }>): Promise<unknown | undefined> {
    const files = botPaths(botId);
    const row = (await listProjectsIn(files.projectsFile)).find(item => item.name === request.projectName && item.chatId === request.chatId);
    if (!row || !isProjectId(row.projectId)) return undefined;
    const project = (await readLibrary()).projects.find(item => item.id === row.projectId);
    if (!project) return undefined;
    if (projectRevision(row) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
    let directory: string;
    try { directory = await realpath(request.directory!); } catch { throw new AdminWriteError('所选文件夹不存在'); }
    if (!(await stat(directory)).isDirectory()) throw new AdminWriteError('所选文件夹不是目录');
    const { primary } = await admitLibraryWorkspace({ primary: directory, additional: [] });
    const change = await library.workspace({ projectId: project.id, refuseWhenBusy: true,
      workspace: { ...project.workspace, primary, additional: project.workspace.additional.filter(path => path !== primary) } });
    const fresh = (await listProjectsIn(files.projectsFile)).find(item => item.name === request.projectName && item.chatId === request.chatId);
    if (!fresh) throw new AdminWriteError('项目已移除，请刷新');
    const lagging = change.rebound.filter(item => item.state === 'failed').length;
    const warning = lagging ? `工作区已改，但有 ${lagging} 个绑定没跟上，下次启动 daemon 时会修好` : undefined;
    if (request.kind === undefined && request.enabled === undefined && request.project === undefined) return { ok: true, project: projectView(fresh), ...(warning ? { warning } : {}) };
    const { directory: _directory, ...rest } = request;
    const reply = await deps.executeCollaboration!(botId, { ...rest, expectedRevision: projectRevision(fresh) }) as Record<string, unknown>;
    return warning && typeof reply === 'object' && reply !== null ? { ...reply, warning: [reply.warning, warning].filter(Boolean).join('；') } : reply;
  }

  function executeWrite(botId: string, action: string, op: AdminWriteOp): Promise<void> {
    if (!deps.executeWrite) throw new NotWiredYetError(action);
    return deps.executeWrite(botId, op).then(() => undefined);
  }

  return {
    readonlyPreview: deps.readonlyPreview === true,
    accountUsage(force, backend) {
      if (closing) return Promise.reject(new Error('daemon 正在退出'));
      const read = Promise.resolve().then(() => (deps.fetchAccountUsage ?? fetchUsageBundle)(force, backend));
      inFlightUsage.add(read);
      void read.then(
        () => { inFlightUsage.delete(read); },
        () => { inFlightUsage.delete(read); },
      );
      return read;
    },
    settings: createSettingsService(deps, library),
    library,
    codexSetup: opts => codexTools.setup(opts),
    close: () => {
      closing ??= (async () => {
        owners.retain(new Set());
        await Promise.allSettled([...inFlightUsage]);
        const results = await Promise.allSettled([codexTools.close(), shutdownResidentClients(), stopClaudeLocalStats()]);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
      })();
      return closing;
    },
    async collaboration(botId, request) {
      if (!deps.executeCollaboration) throw new NotWiredYetError('协作管理');
      if (request.action === 'editProject' && request.directory !== undefined && !deps.readonlyPreview) {
        const handled = await editProjectFolder(botId, request);
        if (handled !== undefined) return handled;
      }
      return deps.executeCollaboration(botId, request);
    },
    async executeSchedule(botId, actor, request) {
      if (!deps.executeSchedule) throw new NotWiredYetError('定时任务');
      return deps.executeSchedule(botId, actor, request);
    },
    async pendingGroups(botId) {
      const registry = await loadBots();
      const bot = registry.bots.find(item => item.appId === botId);
      const active = registry.bots.some(item => item.active !== undefined) ? bot?.active === true : registry.current === botId;
      if (!bot || !active || !(await runState(botId)).running) return { groups: [] };
      const files = botPaths(botId);
      const cfg = await loadConfig(files.configFile);
      if (!isComplete(cfg)) return { groups: [] };
      const bound = new Set((await listProjectsIn(files.projectsFile)).map(project => project.chatId));
      const groups = (await readPendingGroups(pendingGroupsFile(files.projectsFile)))
        .flatMap(group => group.state === 'ready' && !bound.has(group.chatId)
          ? [{ chatId: group.chatId, name: group.name, addedAt: group.addedAt, ...(group.topic === undefined ? {} : { topic: group.topic }), ...(group.hasOtherBots === undefined ? {} : { hasOtherBots: group.hasOtherBots }) }] : []);
      return { groups: groups.length > MAX_PENDING_GROUPS
        ? groups.sort((a, b) => b.addedAt - a.addedAt).slice(0, MAX_PENDING_GROUPS) : groups };
    },
    async joinedGroups(botId, cursor) {
      if (!deps.executeGroups) throw new NotWiredYetError('群列表');
      return parseJoinedGroups(await deps.executeGroups(botId, { kind: 'joinedGroups', cursor }));
    },
    async groupMembers(botId, chatId, cursor) {
      if (!deps.executeGroups) throw new NotWiredYetError('群成员');
      return parseGroupMembers(await deps.executeGroups(botId, { kind: 'groupMembers', chatId, cursor }));
    },
    recipeAuthoring: deps.recipeAuthoring,
    async assertGroupMembership(botId, chatId, identity) {
      if (!deps.executeGroups) throw new NotWiredYetError('群成员身份');
      parseGroupMembership(await deps.executeGroups(botId, {kind: 'groupMembership', chatId, identity}));
    },
    async feishuApi(bot, request) {
      const execute = deps.executeFeishuApi;
      if (!execute) throw new NotWiredYetError('飞书接口');
      return routeFeishuApi({ bots: routeBots, execute }, bot, request);
    },
    async feishuRead(reach, request) {
      const execute = deps.executeFeishuRead;
      if (!execute) throw new NotWiredYetError('飞书读取');
      return routeFeishuRead({
        bots: routeBots,
        chats: async botId => (await listProjectsIn(botPaths(botId).projectsFile)).map(project => project.chatId),
        running: async botId => (await runState(botId)).running,
        execute,
      }, reach, request);
    },
    async bindGroup(botId, input) {
      if (!deps.executeGroups) throw new NotWiredYetError('绑定群聊');
      await deps.executeGroups(botId, { kind: 'bindGroup', input });
      const project = (await projectsWithCounts(botId)).find(p => p.chatId === input.chatId);
      if (!project) throw new Error('群绑定结果读取失败');
      return project;
    },
    async getVoice(botId: string): Promise<VoiceView> {
      const cfg = await loadConfig(botPaths(botId).configFile);
      if (!isComplete(cfg)) throw new Error('这个 Bot 的配置不完整');
      return voiceView(cfg);
    },
    async setVoice(botId: string, value: VoiceAction): Promise<void> {
      await executeWrite(botId, '语音转文字', { kind: 'voice', value });
    },
    async listBots(): Promise<AdminBot[]> {
      const reg = await loadBots();
      const botIds = new Set(reg.bots.map(bot => bot.appId));
      avatars.retain(botIds);
      owners.retain(botIds);
      groupAvatars.retainBots(botIds);
      const configured = reg.bots.some((b) => b.active !== undefined);
      const out: AdminBot[] = [];
      for (const b of reg.bots) {
        const [run, completionReminder] = await Promise.all([runState(b.appId), completionReminderFor(b.appId)]);
        out.push({
          name: b.name,
          badgeNumber: b.badgeNumber,
          appId: b.appId,
          tenant: b.tenant,
          botName: b.botName,
          registeredAt: b.createdAt,
          ownerName: owners.get(b.appId, getAppRoleSnapshot(b.appId, b.tenant), run.running && !closing),
          avatarDataUrl: avatars.get(b.appId),
          // 与 config/bots.activeBots 同语义：从未配置过活跃集 → 回退 current。
          active: configured ? b.active === true : reg.current === b.appId,
          current: reg.current === b.appId,
          running: run.running,
          pid: run.pid,
          startedAt: run.startedAt,
          connection: run.connection,
          completionReminder,
        });
        void avatars.refresh(b.appId);
      }
      return out;
    },

    listProjects(botId: string): Promise<AdminProject[]> {
      return projectsWithCounts(botId);
    },

    async dmRow(botId: string): Promise<AdminProject | undefined> {
      const files = botPaths(botId);
      // Preparation records a localized failure if the file cannot be read, instead of exposing a raw OS/JSON error.
      let row = await dmProject(files.projectsFile).catch(() => undefined);
      // Also covers registration after host startup and recovery after a transient filesystem failure.
      // Preparation is local and never starts a Provider or a stopped Bot.
      if (!row || dmPreparationError(botId)) {
        const bot = (await loadBots()).bots.find(bot => bot.appId === botId);
        if (bot) row = await prepareDmProjectForBot(bot);
        const failure = dmPreparationError(botId);
        if (failure) throw new Error(failure);
      }
      if (!row) throw new Error('私聊尚未准备好，请重启 Bot 后重试。');
      const chats = new Set(Object.keys(row.dm?.people ?? {}));
      const sessions = await listSessionsIn(files.sessionsFile);
      return { ...adminRow(row), sessionCount: sessions.filter(session => chats.has(session.chatId) && !isRetiredKey(session.threadId)).length };
    },

    async getProject(botId: string, name: string): Promise<AdminProject | undefined> {
      return (await projectsWithCounts(botId)).find((x) => x.name === name);
    },

    async switchBackend(botId: string, projectName: string, backendId: string): Promise<void> {
      await executeWrite(botId, '🧠 切换后端', { kind: 'switchBackend', project: projectName, backend: backendId });
    },

    async setPermissionMode(
      botId: string,
      projectName: string,
      opts: { mode: PermissionMode },
    ): Promise<void> {
      await executeWrite(botId, '🔐 设置权限', {
        kind: 'setPermissionMode',
        project: projectName,
        mode: opts.mode,
      });
    },

    async setNoMention(botId: string, projectName: string, on: boolean): Promise<void> {
      await executeWrite(botId, '✋ 免@ 开关', { kind: 'setNoMention', project: projectName, on });
    },

    async setCompletionReminder(
      botId: string,
      value: { mode: CompletionReminderMode; longTaskMinutes: number },
    ): Promise<void> {
      await executeWrite(botId, '🔔 完成提醒', {
        kind: 'setCompletionReminder',
        mode: value.mode,
        longTaskMinutes: value.longTaskMinutes,
      });
    },

    doctorBackends(): Promise<AdminBackendStatus[]> {
      return probeAllBackends();
    },

    async eventDiagnosis(botId: string): Promise<EventDiagnosis> {
      try {
        const cfg = await loadConfig(botPaths(botId).configFile);
        if (!isComplete(cfg)) return { state: 'unchecked', reason: '配置缺失（这个 Bot 还没初始化完）' };
        const { app } = cfg.accounts;
        const secret = await resolveAppSecret(cfg);
        return await diagnoseEventSubscription(app.id, secret, app.tenant);
      } catch (err) {
        return { state: 'unchecked', reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async listSessions(botId: string, projectName: string): Promise<AdminSession[]> {
      const files = botPaths(botId);
      const p = (await listProjectsIn(files.projectsFile)).find((x) => x.name === projectName);
      if (!p?.chatId) return [];
      const sessions = await listSessionsIn(files.sessionsFile);
      return sessions
        .filter((s) => s.chatId === p.chatId && !isRetiredKey(s.threadId))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((s) => ({
          threadId: s.threadId,
          chatId: s.chatId,
          summary: s.summary,
          backend: s.backend,
          model: s.model,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }));
    },

    tailLogs(opts?: { maxBytes?: number }): Promise<string> {
      return readRecentLogs({ maxBytes: opts?.maxBytes ?? 64 * 1024 });
    },

    async getCardCallbackStatus(botId: string): Promise<AdminSetupStatus['cardCallback']> {
      if (!(await loadBots()).bots.some(bot => bot.appId === botId)) throw new Error('没有这个 Bot。');
      return readCardCallbackStatus(botId);
    },

    async getSetupStatus(botId: string): Promise<AdminSetupStatus> {
      const reg = await loadBots();
      const entry = reg.bots.find((b) => b.appId === botId);
      const tenant: 'feishu' | 'lark' = entry?.tenant ?? 'feishu';
      const base: Pick<AdminSetupStatus, 'appId' | 'tenant' | 'botName' | 'eventConfigUrl' | 'consoleUrl' | 'cardCallback'> = {
        appId: botId,
        tenant,
        botName: entry?.botName,
        eventConfigUrl: buildEventConfigUrl(botId, tenant),
        consoleUrl: buildAppConsoleUrl(botId, tenant),
        cardCallback: await readCardCallbackStatus(botId),
      };

      // ② 长连接：真实状态优先（daemon 内），否则锁文件探测——绝不抛错。
      const run = await runState(botId);

      // 配置缺失（注册一半 / 损坏）→ 探活、事件、scope 都没法查，统一降级。
      let cfg;
      try {
        cfg = await loadConfig(botPaths(botId).configFile);
      } catch {
        cfg = undefined;
      }
      if (!cfg || !isComplete(cfg)) {
        return {
          ...base,
          credentials: { ok: false, reason: '配置缺失（这个 Bot 还没注册完，或者文件损坏了）' },
          cardCallback: { ...base.cardCallback, configuration: { state: 'unchecked', reason: '配置缺失，无法诊断卡片回调' } },
          connection: { running: run.running, connection: run.connection },
          event: { state: 'unchecked', reason: '配置缺失，无法诊断事件订阅' },
          scopes: { grantUrl: buildScopeGrantUrl(botId, tenant) },
        };
      }

      // 各项远程诊断都要密钥——解析一次，共用凭据调用各自的只读 API。
      let secret: string | undefined;
      try {
        secret = await resolveAppSecret(cfg);
      } catch (err) {
        return {
          ...base,
          credentials: { ok: false, reason: err instanceof Error ? err.message : String(err) },
          cardCallback: { ...base.cardCallback, configuration: { state: 'unchecked', reason: '密钥不可解析' } },
          connection: { running: run.running, connection: run.connection },
          event: { state: 'unchecked', reason: '密钥不可解析' },
          scopes: { grantUrl: buildScopeGrantUrl(botId, tenant) },
        };
      }

      const { app } = cfg.accounts;
      // 探活、事件订阅、卡片回调配置并发；本地回调证据保持独立。
      const [validation, event, configuration] = await Promise.all([
        validateAppCredentials(app.id, secret, app.tenant).catch((err) => ({
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
          unreachable: true,
        })),
        diagnoseEventSubscription(app.id, secret, app.tenant).catch(
          (err): EventDiagnosis => ({ state: 'unchecked', reason: err instanceof Error ? err.message : String(err) }),
        ),
        diagnoseCardCallbackConfiguration(app.id, secret, app.tenant).catch(
          (): CardCallbackConfiguration => ({ state: 'unchecked', reason: '无法读取卡片回调配置，请稍后重试' }),
        ),
      ]);
      // 飞书后台改了名：检查连接时就把新名字写进 bots.json，Bot 列表、群设置不用等 Bot 重启。只读预览不写；
      // config.json 里的应用不是这个 Bot 的（文件被换过）也不写，免得把别的应用的名字记到它头上。
      if (validation.ok && entry && app.id === entry.appId && !deps.readonlyPreview) {
        await syncBotName('setup-status', botIdentity(entry), entry.botName, validation.botName);
      }
      // The client watches this while the user publishes, so the hello need not wait for the bot's own slow check.
      if (validation.ok && validation.missingScopes?.length === 0 && cfg.preferences?.access?.firstHelloPending && !deps.readonlyPreview) {
        void deps.firstHello?.(app.id).catch(() => undefined);
      }

      return {
        ...base,
        botName: validation.ok ? (validation.botName ?? entry?.botName) : entry?.botName,
        credentials: validation.ok ? { ok: true } : { ok: false, reason: validation.reason, ...(validation.unreachable ? { unreachable: true } : {}) },
        connection: { running: run.running, connection: run.connection },
        event,
        cardCallback: { ...base.cardCallback, configuration },
        scopes: {
          missingRequired: validation.ok ? validation.missingScopes : undefined,
          missingJoinScopes: validation.ok ? validation.missingJoinScopes : undefined,
          missingOptional: validation.ok ? validation.missingOptional : undefined,
          missingTools: validation.ok ? validation.missingTools : undefined,
          grantUrl: buildScopeGrantUrl(app.id, app.tenant),
          ...(validation.ok && validation.missingTools?.length
            ? { toolsGrantUrl: buildScopeGrantUrl(app.id, app.tenant, validation.missingTools) }
            : {}),
        },
      };
    },

    async confirmCardCallback(botId: string, confirmed: boolean): Promise<void> {
      if (deps.readonlyPreview) throw new NotWiredYetError('卡片回调勾选');
      if (!(await loadBots()).bots.some((b) => b.appId === botId)) throw new Error('没有这个 Bot。');
      await writeSetupProgress(botId, { cardCallbackConfirmed: confirmed });
    },

    async registerBotByQr(opts): Promise<QrRegisterResult | QrRegisterFailure> {
      // 「没启动只读」：只读预览不许扫码加机器人——必须先有 daemon 在跑。
      if (deps.readonlyPreview) throw new NotWiredYetError('注册 Bot');
      // ① 扫码会话：透传 onQr/onStatus 给上层做 SSE；signal 取消 → SDK reject code='abort'。
      let creds;
      try {
        creds = await startRegistration({ signal: opts.signal, onQr: opts.onQr, onStatus: opts.onStatus });
      } catch (err) {
        const code = registrationErrorCode(err);
        return mapQrFailure(code, registrationErrorMessage(err));
      }
      const ownerOpenId = creds.operatorOpenId?.trim();
      if (!ownerOpenId) {
        return {
          ok: false,
          code: 'identity_missing',
          reason: '未获取到扫码人的飞书身份，未保存 Bot。请重新扫码并确认授权。',
        };
      }
      // ② 入库：「探活→keystore→config→bots.json」，扫码人 open_id 落成 owner+admin。
      //    明文 client_secret 只此一次喂进去，绝不回显——done payload 永不含它。
      const r = await registerBotFromCredentials({
        appId: creds.clientId,
        appSecret: creds.clientSecret,
        tenant: creds.tenant,
        ownerOpenId,
      });
      if (!r.ok) {
        // 写盘 / 探活失败 → 据 register-bot 的 code 映射（invalid_input 理论不该出现，
        // 扫码拿到的 appId 必合法，归为 unknown 兜底）。
        const code: QrRegisterFailure['code'] =
          r.code === 'already_registered' ? 'already_registered' : r.code === 'credential_rejected' ? 'credential_rejected' : r.code === 'persist_failed' ? 'persist_failed' : 'unknown';
        return { ok: false, code, reason: r.reason };
      }
      // ③ 默认启用并启动。落盘失败只记日志：Bot 已经保存，清单里显示"没有启用"，可以手动打开。
      await enableRegisteredBot(r.appId).catch((error) => log.fail('register-bot', error, { phase: 'enable', appId: r.appId }));
      return {
        ok: true,
        appId: r.appId,
        name: r.name,
        tenant: r.tenant,
        botName: r.botName,
        adminOpenId: ownerOpenId,
        missingScopes: r.missingScopes,
      };
    },

    async refreshBotByQr(botId, opts) {
      if (deps.readonlyPreview) throw new NotWiredYetError('刷新 Bot 凭据');
      return refreshBotCredentials(botId, opts);
    },

    async listBackendCatalog(): Promise<AdminBackendCatalog> {
      // force：用户刚装完后要看「现在」的默认（绕过探测缓存）。
      const defaultBackend = await effectiveDefaultBackend().catch(() => DEFAULT_BACKEND_ID);
      const entries = await Promise.all(
        visibleCatalog().map((entry) => catalogEntryStatus(entry, defaultBackend)),
      );
      return { defaultBackend, entries };
    },

    async installBackend(id, onProgress, signal, opts): Promise<InstallResult> {
      const entry = catalogById(id);
      if (!entry) {
        return { ok: false, code: null, aborted: false, tail: `未知后端「${id}」` };
      }
      // 仅 installable（npm-ondemand）可一键装；external-cli（codex）给手动装法。
      if (!isInstallable(entry)) {
        return {
          ok: false,
          code: null,
          aborted: false,
          tail: `「${entry.displayName}」不支持一键下载。手动安装：${entry.dep.installCmd ?? entry.dep.detectHint}`,
        };
      }
      // 有 pin 的（Claude Agent SDK）下载和更新都装 pin，不装 latest；没 pin 的，更新装 latest。
      const spec = entry.dep.version ?? (opts?.update ? 'latest' : undefined);
      const pkg = spec ? `${entry.dep.pkg}@${spec}` : entry.dep.pkg!;
      const verb = opts?.update ? '🔄 更新' : '⬇️ 下载';
      // install/update 是 daemon 注入态能力（owns runtime）；只读预览无注入 → 501 引导起 daemon。
      if (!deps.installBackend) throw new NotWiredYetError(`${verb}「${entry.displayName}」`);
      // binName ⇒ bin 类后端：装完按 .bin 校验而非 require.resolve。
      return deps.installBackend(pkg, onProgress, signal, { binName: entry.dep.binName });
    },

    async uninstallBackend(id): Promise<{ ok: boolean; message: string }> {
      const entry = catalogById(id);
      if (!entry) return { ok: false, message: `未知后端「${id}」` };
      if (entry.dep.kind === 'external-cli') {
        // codex 等外部 CLI 是你系统自管的（全局 npm / Codex.app / CODEX_BIN），桥只用不卸，
        // 删了会破坏运行中的会话。引导用户自行处置，绝不替删。
        return {
          ok: false,
          message: `「${entry.displayName}」是你本机自管的全局 CLI（不是桥下载的包），无法在这里卸载。如需移除，请自行 \`npm uninstall -g\` 或卸载 Codex.app。`,
        };
      }
      if (!entry.dep.pkg || !isInstallable(entry)) {
        return { ok: false, message: `「${entry.displayName}」不是可一键管理的按需后端，无法卸载。` };
      }
      if (!deps.uninstallBackend) {
        if (!isBackendInstalledInUserDir(entry)) {
          return { ok: false, message: `「${entry.displayName}」并未装在用户目录，无需卸载。` };
        }
        throw new NotWiredYetError(`🗑️ 卸载「${entry.displayName}」`);
      }
      const result = await deps.uninstallBackend(entry.dep.pkg, { binName: entry.dep.binName });
      if (result === 'not-installed') {
        return { ok: false, message: `「${entry.displayName}」并未装在用户目录，无需卸载。` };
      }
      return result === 'uninstalled'
        ? { ok: true, message: `已卸载「${entry.displayName}」。` }
        : { ok: false, message: `卸载「${entry.displayName}」失败（可能仍被占用），可稍后重试。` };
    },

    async backendVersion(id): Promise<{ installed: string | null; latest: string | null; hasUpdate: boolean }> {
      const entry = catalogById(id);
      if (!entry?.dep.pkg) return { installed: null, latest: null, hasUpdate: false };
      // Codex is an executable (managed, PATH, app bundle or CODEX_BIN), not a
      // library resolved from our node_modules. Force the runtime's own probe so
      // an upgrade at the same path cannot leave this explicit check cached.
      const installed = entry.id === 'codex-appserver'
        ? parseCodexVersion((await createBackend(entry.id).doctor({ force: true, permissions: false }).catch(() => null))?.version)
        : installedBackendVersion(entry.dep.pkg);
      // 有 pin 时目标就是 pin：装的版本和它不同（更新或更旧）都提示更新，更新会装回 pin。
      const pinned = entry.dep.version;
      if (pinned) return { installed, latest: pinned, hasUpdate: !!installed && installed !== pinned };
      const published = await latestNpmVersion(entry.dep.pkg).catch(() => null);
      const latest = entry.id === 'codex-appserver' ? parseCodexVersion(published) : published;
      const hasUpdate = !!installed && !!latest && (entry.id === 'codex-appserver'
        ? compareCodexVersions(latest, installed)
        : cmpSemver(latest, installed)) > 0;
      return { installed, latest, hasUpdate };
    },

    async backendLogin(id, refresh): Promise<BackendLogin> {
      if (!catalogById(id)) return { state: 'unknown', message: '没有这个后端。' };
      const backend = createBackend(id);
      if (!backend.loginStatus) return { state: 'unknown', message: `「${backend.displayName}」的配置在它自己的设置里看。` };
      return backend.loginStatus({ refresh }).catch(() => ({ state: 'unknown' as const, message: '无法确认配置，请重新检测。' }));
    },

    async getDaemonStatus(): Promise<DaemonStatus> {
      const foreground = deps.daemonStartedAt === undefined
        ? undefined
        : { pid: process.pid, startedAt: deps.daemonStartedAt };
      const service = await controlDesktopService('status');
      return {
        ...toDaemonStatus({ foreground, version: bridgeVersion() }),
        installed: service.installed, supported: service.supported,
        ...(service.platformName ? { platformName: service.platformName } : {}),
        ...(service.servicePath ? { servicePath: service.servicePath, stdoutPath: service.stdoutPath, stderrPath: service.stderrPath } : {}),
        distribution: await runtimeDistribution(),
      };
    },

    async restartDaemon(): Promise<void> {
      if (!deps.restartDaemon) throw new NotWiredYetError('🔁 重启 daemon');
      deps.restartDaemon();
    },

    async startDaemon(): Promise<void> {
      if (!deps.startDaemon) throw new NotWiredYetError('▶️ 启动 daemon');
      deps.startDaemon();
    },

    async stopDaemon(): Promise<void> {
      if (!deps.stopDaemon) throw new NotWiredYetError('⏹ 停止 daemon');
      deps.stopDaemon();
    },

    checkUpdate(): Promise<UpdateCheck> {
      return checkUpdateImpl().catch(() => ({
        current: bridgeVersion(),
        latest: null,
        hasUpdate: false,
        dev: false,
      }));
    },

    updateStatus(): UpdateStatus | null {
      return readUpdateStatus();
    },

    async applyUpdate(): Promise<UpdateStatus | void> {
      if (!deps.applyUpdate) throw new NotWiredYetError('⬆️ 升级');
      if ((await runtimeDistribution()).kind !== 'global-npm') throw new Error('This Core is not owned by the global npm installation. Update its desktop app or source distribution instead.');
      return await deps.applyUpdate();
    },

    async hostDoctor(): Promise<AdminHostDoctor> {
      const [host, backends] = await Promise.all([collectHostDoctor(), probeAllBackends()]);
      return { ...host, backends };
    },

    setBotBadgeNumber(appId, badgeNumber) {
      if (deps.readonlyPreview) throw new NotWiredYetError('修改工号');
      return setBotBadgeNumber(appId, badgeNumber);
    },

    setBotEnabled(appId: string, enabled: boolean): Promise<BotActivationResult> {
      const operation = activationQueue.then(async (): Promise<BotActivationResult> => {
        const reg = await loadBots();
        if (!reg.bots.some((bot) => bot.appId === appId)) {
          return { ok: false, reason: `Bot「${appId}」不存在。` };
        }
        await setBotActivation(appId, enabled);
        if (!deps.applyBotActivation) {
          return { ok: true, activation: 'restartRequired', message: '已保存。重启 daemon 后才会按新的启停状态运行。' };
        }
        try {
          await deps.applyBotActivation(appId, enabled);
          return { ok: true, activation: 'applied', message: enabled ? 'Bot 已启用。' : 'Bot 已停用。' };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return { ok: false, reason: `已保存${enabled ? '启用' : '停用'}状态，但未能确认运行状态。${reason}` };
        }
      });
      activationQueue = operation.catch(() => undefined);
      return operation;
    },

    async deleteBot(appId: string): Promise<BotMutationResult> {
      const reg = await loadBots();
      const target = reg.bots.find((b) => b.appId === appId);
      if (!target) return { ok: false, reason: `Bot「${appId}」不存在。` };
      const expected = botIdentity(target);
      let result;
      try {
        result = await removeBot(expected, {
          isRunning: async () => (await runState(appId)).running,
          cleanup: async () => {
            await assertRecipeRemovalSafe({file: botPaths(appId).projectsFile, dataRoot: paths.appDir});
            await removeSecret(secretKeyForApp(appId));
            await rm(botDir(appId), { recursive: true, force: true });
          },
        });
      } catch (error) {
        if (error instanceof RecipeRecoveryRequired) return {ok: false, reason: error.message};
        log.fail('bot-remove', error, { appId });
        return { ok: false, reason: '移除未完成，部分本地数据可能已经改变，请检查后重试。' };
      }
      if (result.kind !== 'removed') {
        const reason = result.kind === 'active' ? '请先停用这个 Bot，等它停止运行，再移除。'
          : result.kind === 'running' ? `Bot「${target.name}」仍在运行。请先停用它并重启 daemon，确认已停止后再移除。`
          : '这个 Bot 已移除或重新注册，请重新加载后再操作。';
        return { ok: false, reason };
      }
      avatars.retain(new Set(result.registry.bots.map(bot => bot.appId)));
      return { ok: true };
    },
  };
}

/** 比较两个 x.y.z 版本：a>b →1，a<b →-1，相等→0。非法段按 0。后端「有无更新」判定用。 */
function cmpSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** SDK registerApp reject 的 code → 扫码失败结果（前端文案归 UI/SSE，这里给中文兜底）。 */
function mapQrFailure(code: string, description: string): QrRegisterFailure {
  switch (code) {
    case 'abort':
      return { ok: false, code: 'abort', reason: '已取消扫码。' };
    case 'expired_token':
      return { ok: false, code: 'expired_token', reason: '二维码已过期，请重新生成。' };
    case 'access_denied':
      return { ok: false, code: 'access_denied', reason: '你在飞书里取消或拒绝了创建。' };
    default:
      // 网络/TLS 抖动（SDK reject 的不是结构化码，是底层 socket/DNS/TLS 错）——别把英文原文
      // 甩给用户。常见：切 VPN/代理、断网重连、公司网拦截开放平台。统一归一成可操作的中文。
      if (isNetworkErrorText(code, description)) {
        return {
          ok: false,
          code: 'network',
          reason: '连不上飞书开放平台（网络中断或超时）。检查网络 / VPN / 代理后，点「重新生成」重试。',
        };
      }
      return { ok: false, code: 'unknown', reason: description ? `创建失败：${description}` : '创建失败，请重试。' };
  }
}

/** 识别「网络/TLS/DNS 层」失败：code 或 description 命中常见信号即算。切飞书账号本身不会触发，
 * 真因多是切 VPN/代理或网络抖动让到开放平台的 HTTPS 握手中断。 */
function isNetworkErrorText(code: string, description: string): boolean {
  const hay = `${code} ${description}`;
  return /socket disconnected|secure TLS|\bTLS\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|network socket|fetch failed|socket hang up|ECONNABORTED|EPIPE/i.test(
    hay,
  );
}

/**
 * 一条 catalog 的管理面投影：catalog 元数据 + 本机探测态。external-cli（codex）走
 * doctor 拿版本/可用；npm-ondemand / npm-external 走 isBackendDepInstalled 判装没装。
 * 绝不抛错——探测失败按「未装/未知」降级。
 */
async function catalogEntryStatus(
  entry: BackendCatalogEntry,
  defaultBackend: string,
): Promise<AdminBackendCatalogEntry> {
  const probe: BackendProbe | undefined = await createBackend(entry.id)
    .doctor({ permissions: false })
    .catch(() => undefined);
  const ok = probe?.ok === true;
  // depState：installed（探测通过）/ not-installed（npm-ondemand 可一键装）/
  // external-missing（external-cli / npm-external 缺失，需手动装）。优先用 doctor
  // 自报的 depState（npm-ondemand 未装时的 not-installed），否则按 ok + installable 推。
  const installable = ok ? false : isInstallable(entry);
  const depState: BackendDepState =
    probe?.depState ?? (ok ? 'installed' : installable ? 'not-installed' : 'external-missing');
  return {
    id: entry.id,
    agentFamily: entry.agentFamily,
    displayName: entry.displayName,
    access: entry.access,
    blurb: entry.blurb,
    depKind: entry.dep.kind,
    depState,
    installable: depState === 'not-installed' && isInstallable(entry),
    approxSizeMB: entry.dep.approxSizeMB,
    version: probe?.version ?? null,
    installedVersion: entry.id === 'codex-appserver'
      ? parseCodexVersion(probe?.version)
      : entry.dep.pkg ? installedBackendVersion(entry.dep.pkg) : null,
    canUninstall: isInstallable(entry) && isBackendInstalledInUserDir(entry),
    hint: ok ? undefined : (probe?.hint ?? entry.dep.detectHint),
    isDefault: entry.id === defaultBackend,
    supportedModes: entry.supportedModes,
  };
}

/** 与 DM 🧠 后端检测卡同源：按注册表动态探测全部后端，绝不硬编码列表；绝不抛错。 */
async function probeAllBackends(): Promise<AdminBackendStatus[]> {
  // 只探**用户可见**后端（visibleCatalog 过滤 hidden 闸）：与 listBackendCatalog /
  // host.doctorBackends 同口径，走 visibleCatalog 单一过滤源。
  return Promise.all(
    visibleCatalog().map((e) => e.id).map(async (id) => {
      const backend = createBackend(id);
      const probe = await backend.doctor({ force: true }).catch(() => undefined);
      return {
        id,
        name: backend.displayName,
        ok: probe?.ok === true,
        version: probe?.version ?? null,
        location: probe?.location,
        hint: probe?.ok ? undefined : (probe?.hint ?? '环境探测失败（没装、没配置好或探测超时）'),
        isDefault: id === DEFAULT_BACKEND_ID,
      };
    }),
  );
}

/** 只读预览（独立 `web` 进程，daemon 未跑）：无写执行器、状态靠锁文件探测。 */
/**
 * 只读预览用的 AdminService：项目写 / 重启 / 升级 / 后端装卸全部缺省（抛 NotWiredYetError
 * → 501）。唯一例外是 {@link AdminServiceDeps.startDaemon}——预览态下 daemon 没在跑，
 * 「启动」是预览唯一该能做的宿主级动作（detached helper 把 service 装起来，与预览进程脱钩），
 * 故允许调用方注入。其余 deps 一律不放行，保持「只读」语义。
 */
export function createReadonlyAdminService(deps: Pick<AdminServiceDeps, 'startDaemon' | 'applyUpdate'> = {}): AdminService {
  // 只读预览能做的宿主级写操作只有「启动」和「更新」（没启动只读，但这俩是为了让用户能
  // 起 / 升级 daemon）；readonlyPreview 闸挡掉扫码注册等其余写。
  return createAdminService({ startDaemon: deps.startDaemon, applyUpdate: deps.applyUpdate, readonlyPreview: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
