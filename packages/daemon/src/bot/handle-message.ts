import type { FeedbackSource } from '../agent/entry/feedback-tool';
import { FEEDBACK_ACTION } from '../feedback/events';
import type { FeedbackHost } from '../feedback/host';
import { NOT_DM_MESSAGE, type AgentEntries, type AgentPlace, type TurnMemory, type TurnScope } from '../agent/entry/registry';
import { createHiddenBlockFilter, escapeInboundMarkers, memoryNonce, noteMissedBlocks, takeLastMissed, takeMemoryNotices, type FoundBlocks, type RawBlock } from './hidden-blocks';
import type { MemoryWriter } from './memory-writer';
import { redactAgentEvents } from '../core/token-redact';
import { buildJudgeFacts, judgeFactRead, sameNameWord } from './judge-facts';
import { bareText, smartSalience, type Salience, type SalienceDeps } from './salience';
import { createChatPeople } from './chat-people';
import { findHandoffs, handoffSendResult, type HandoffSendResult, handoffText, handoffNote, ambiguousNote, ambiguousPersonNote, overNote, incompleteNote, otherBotNames, HANDOFF_SEND_MS, type HandoffMiss } from './bot-handoff';
import { AskCoordinator, type AskTurn } from './ask-coordinator';
import { createPendingGroups, pendingGroupsFile } from '../project/pending-groups';
import { realpath, stat } from 'node:fs/promises';
import type { BotIdentity } from '../config/bots';
import { createHash, randomUUID } from 'node:crypto';
import { settleTurn, recordUsage, type TurnStores } from './turn-usage';
import { assemble, judgeContext, loadContextSources, openingInstructions, planTurnUpdate, contextOf, newNonce, type ContextPlace } from './context-assembly';
import { groupSkillProfile } from '../agent/group-skills';
import { completeBuiltinPackage, ensureBuiltinPackage } from '../agent/builtin-skills/package';
import { builtinSkillsOfSet } from '../agent/builtin-skills/registry';
import type { SessionProfile } from '../agent/session-profile';
import { SESSION_BOT_ENV, SESSION_CLI_ENV, SESSION_ENV, SESSION_SCOPE_ENV, sessionScope } from '../config/session-env';
import type { HostApi } from '../admin/ipc';
import { parseStoredJudge } from '../judge/model';
import { presentationConfig } from './group-presentation';
import { projectRevision, projectView, projectSettingsRevision, type CollaborationRequest } from '../admin/collaboration';
import { AdminWriteError } from '../admin/ops';
import { applyMirror, mirrorProjectIntoBot, siblingProjectOfChat, type AdminLibraryOp } from '../admin/library';
import { isProjectId, readLibrary, type LibraryProject } from '../project/library';
import { createSettingsOwner, materializeGroupSettings } from '../admin/settings';
import { snapshotDefaultJudge, snapshotProviderJudge, requireDecisionKey } from '../project/initial-settings';
import type { HostSettings } from '../admin/settings-types';
import type { AdminWriteResult, AppPreferencesWriter } from '../admin/ops';
import { registerVoiceConsole } from './voice-console';
import { createVoiceService } from '../voice/service';
import { ingestVoice, createIntakeQueue, type IngestedContext } from '../voice/inbound';
import type { VoiceReply } from '../voice/types';
import { VoiceMessages } from '../voice/messages';
import { steerWithDeadline, isRejectedSteer } from './steer-delivery';
import { TurnCardEvents, type SteerCardEvent } from './turn-card-events';
import { runSegment } from '../card/run-segment';
import type {
  BotAddedEvent,
  CardActionEvent,
  CommentEvent,
  LarkChannel,
  NormalizedMessage,
  ReactionEvent,
} from '@larksuiteoapi/node-sdk';
import { DEFAULT_BACKEND_ID, effectiveDefaultBackend, backendIds, createBackend, isBackendEntryInstalled } from '../agent';
import { BackendNotInstalledError } from '../agent/backend-loader';
import { CodexFullOnlyError } from '../agent/codex-appserver/full-only';
import { CodexServiceTierError } from '../agent/codex-appserver/backend';
import { permissionTable, tableEnv, tierInfo, unavailableTierReply } from '../agent/permission';
import { errorKindFromText, type AgentErrorKind } from '../agent/error-kind';
import { feishuError, scopeDenial } from '../utils/feishu-error';
import type { NotReplied, NotRepliedReason, ScheduleReply, ScheduleRequest } from '@vonvon/protocol';
import { DEFAULT_DM_SMART_RULES, FULL_ACCESS_WARNING } from '@vonvon/protocol';
import type { JudgeErrorKind, JudgeDecision, JudgeResult, JudgeVariant } from '../judge/types';
import { JUDGE_INPUT_LIMITS, oneLine } from '../judge/prompt';
import { deniedScopeName, errorDetail, fitDetail, reportAttention, reportDecision, reportLatestAction, reportNotReplied, reportScopeDenied, type ScheduleDiagnosticEvent } from './diagnostics';
import { clampUnits, createScheduleStore } from './schedule/store';
import type { ScheduledHook, ScheduledJob, ScheduledOutcome } from './schedule/types';
import { createScheduler, nextRunAfterFailure } from './schedule/scheduler';
import { hostTimeZone } from './schedule/time';
import { botNotRunning, createScheduleCommands, type ScheduleActor } from '../admin/schedule-commands';
import type { StoredTask } from './schedule/types';
import { createRunActivity } from './activity';
import { createDroppedReplies, originFor, originOf, type DroppedOrigin } from './restart-dropped';
import { catalogById, projectCreatableBackends, visibleCatalog } from '../agent/catalog';
import {
  DEFAULT_PERMISSION_MODE,
  type AgentBackend,
  type StartThreadOptions,
  type ResumeThreadOptions,
  type AgentInput,
  type AgentRun,
  type AgentThread,
  type ModelInfo,
  type PermissionMode,
  type ReasoningEffort,
  type ServiceTier,
  type ThreadHistory,
  type ThreadSummary,
} from '../agent/types';
import { card, md, note, type CardObject, type SelectOption } from '../card/cards';
import { ASK_CONTROLS_EID } from '../card/ask-card';
import {
  createAppPreferencesWriter,
  createAdminWriteExecutor,
  performBackendSwitch,
  performSetCompletionReminder,
  performSetModelDefault,
  performSetNoMention,
  performSetPermissionMode,
  probeBackends,
  type AdminWriteOp,
} from '../admin/ops';
import { CodexWorkspaceLayoutError } from '../agent/codex-appserver/workspace-admission';
import { isGoalTerminal, SessionInUseError, UsageError } from '../agent/types';
import { parseModelId } from '../agent/model-id';
import {
  getMaxConcurrentRuns,
  getModelDisplay,
  getRunIdleTimeoutMs,
  getSessionTitleConfig,
  getSessionTitleEfforts,
  getShowToolCalls,
  getCommentsConfig,
  getCompletionReminderConfig,
  isAdmin,
  isChatAllowed,
  isUserAllowedInProject,
  normalizeRunIdleTimeoutSeconds,
  primaryAdmin,
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  secretKeyForApp,
  type AppConfig,
  type AppPreferences,
  type CommentsConfig,
  type CompletionReminderMode,
  type PendingPolicy,
  type SessionTitleBackendConfig,
} from '../config/schema';
import { CardDispatcher, type CardActionHandler } from '../card/dispatcher';
import { closeOwnedProviderProcesses, stopAcceptingProviderProcesses } from '../agent/owned-process';
import type { StopReason } from '../host/lifecycle';
import { shutdownResidentClients } from '../agent/codex-appserver/client-pool';
import { JUDGE_NAMED_TIMEOUT_MS, createJudge } from '../judge/judge';
import { createJudgeUsage } from '../judge/usage';
import { installAtGuard } from '../card/at-guard';
import { isManaged, sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import { finalMessageText, initialState, markInterrupted, reduce, type RunState, type SubagentRow } from '../card/run-state';
import {
  buildClearedCard,
  buildHelpCard,
  buildModelCard,
  serviceTierLabel,
  buildResumeCard,
  buildResumeDoneCard,
  buildResumeErrorCard,
  buildResumeLaunchingCard,
  MC,
  modelIdCode,
  reasoningEffortLabel,
  RES,
  type HelpScope,
  type ModelCardState,
  type ResumeCardState,
} from '../card/command-cards';
import { buildHistoryCard, type HistoryCardState } from '../card/history-card';
import {
  ANSWER_EID,
  buildQueuedCard,
  buildRunCard,
  buildRunCardBase,
  buildRunCardPlain,
  CONTROLS_EID,
  RC,
  attachRunImages,
  failureText,
  idleLabel,
  type RunCardState,
} from '../card/run-card';
import { runCardDisplayScripts } from '../card/card-display-scripts';
import { CARD_DISPLAY_STOP_EID, CARD_DISPLAY_REMINDER_EID } from '@vonvon/protocol';
import { buildGoalDoneCard } from '../card/goal-card';
import { RunCardStream } from '../card/run-card-stream';
import { buildCleanCard } from '../card/markdown-render';
import { extractCardFences } from '../card/md-scan';
import { uploadOutboundImages } from '../card/outbound-images';
import {
  buildCompactFailedCard,
  buildCompactedCard,
  buildCompactingCard,
  buildContextCard,
} from '../card/context-gauge';
import { log, withTrace } from '../core/logger';
import {
  AUTO_COMPACT_RETIRED,
  buildAddAllowedCard,
  buildAdminsCard,
  buildCommentPromptCard,
  buildCommentSettingsCard,
  buildAllowlistCard,
  buildDmMenuCard,
  buildDoctorCard,
  buildJoinGroupFormCard,
  parseProjectPick,
  parseNoMentionPick,
  buildModelDefaultCard,
  parseModelDefaultFormValue,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
  buildNewProjectUncertainCard,
  buildPermissionCard,
  PERMISSION_CARD_VERSION,
  buildProjectListCard,
  buildProjectTopicsCard,
  buildProjectSettingsCard,
  buildReconnectCard,
  buildForegroundRestartCard,
  buildRmConfirmCard,
  buildCompletionReminderCustomCard,
  buildSessionTitleSettingsCard,
  buildSettingsCard,
  buildForegroundUpdateCard,
  buildWatchdogCustomCard,
  COFFEE_RETIRED,
  COFFEE_RETIRED_ACTIONS,
  DM,
  GS,
  parseSessionTitleFormValue,
  resolveCommentModelFormValue,
  type BackendProbeRow,
  type DoctorInfo,
} from '../card/dm-cards';
import {
  sendCompletionReminderReply,
  reminderButtonOffered,
  type CompletionReminderReplyInput,
} from './completion-reminder';
import { currentVersion } from '../service/update';
import { fetchUsageBundle } from '../agent/usage';
import {
  buildShareConfigCard,
  buildUsageCard,
  buildUsageShareCard,
  parseShareSections,
  type UsageCardState,
} from '../card/usage-cards';
import { serviceStdoutPath, serviceStderrPath } from '../service/common';
import { bridgeVersion } from '../core/version';
import { desktopDownloadForHost } from '../service/desktop-release';
import { runtimeDistribution } from '../service/distribution';
import { join } from 'node:path';
import { recipeSlot } from '../recipe/rich-admission';
import { isRecipeSession, managedThreadOwner, recipeHistoryId } from '../recipe/rich-thread';
import { botPaths, paths } from '../config/paths';
import { claudeReadScope } from '../config/read-scope';
import { resolveProjectsRootDir } from '../config/directories';
import { loadBots } from '../config/bots';
import { admitDirectorySettings } from '../config/directories';
import { DirectoryError, directoryFailure } from '../config/directory-errors';
import { botBackendId, groupBackendId, groupPermission, resolveCommentsExecution, resolveExecution, resolveModelPreference, resolveProjectModelAccess, executionSessionProfile, projectModelAllowed, projectModelCatalog, projectSpeedAllowed, type ModelPreference } from '../config/execution';
import { ensureDmProject, storedDmDefaults } from './dm-project';
import { fileClaimMode, messageLink, OutboundFiles } from './outbound-files';
import { getSecret } from '../config/keystore';
import { buildScopeGrantUrl, JOIN_GROUP_SCOPES } from '../config/scopes';
import { validateAppCredentials } from '../utils/feishu-auth';
import {
  dmPersonOf,
  dmProject,
  getProjectByChatId,
  getProjectByChatIdSync,
  getProjectByName,
  cardDisplayPresentationDefaults,
  materializeCardDisplaySettings,
  listProjects,
  noMentionOf,
  rememberDmChat,
  ruleKind,
  sessionModeOf,
  storedMode,
  mutateProject,
  removeProject,
  updateProject,
  type Project,
  type SessionMode,
} from '../project/registry';
import { bindModeFor, createProject, CreatedButUnsavedError, CreationOutcomeUnknownError, joinExistingGroup, type GroupInvitee } from '../project/lifecycle';
export { bindModeFor } from '../project/lifecycle';
import { refreshBranch } from '../project/announcement';
import { leaveChat, transferOwnership } from '../project/group-ops';
import {
  addRecall,
  backfillFrom,
  bindSession,
  clearSessionTitleJobKey,
  detachSessionsForChat,
  getSession,
  isDelivered,
  isRetiredKey,
  RETIRED_KEY_TEXT,
  isSeen,
  isUnread,
  listSessions,
  nextSeen,
  nothingSeen,
  patchSession,
  acceptedNonces,
  type SessionContext,
  sessionHolder,
  sessionTitleJobKey,
  upsertSession,
  type RecallNote,
  type SeenHow,
  type SeenMark,
  type SessionRecord,
  type SessionTitlePolicySnapshot,
} from './session-store';
import { isTopicReply, reachedAt } from './recall';
import { SessionTitleCoordinator } from './session-title-coordinator';
import { topicTitle, type TopicPerson, type TopicRegistry, type TopicSighting, type TopicView } from './topic-registry';
import { createTopicContext, localBots, personOf, topicQuotes, topicRows, type ChatInfo } from './topic-context';
import { audienceOf, fromBot, quotedId, rawSender } from './baselines';
import {
  BOT_WAKE_NOTE,
  AT_HINT_NOTE,
  INITIATIVE_NOTE,
  sessionTitleSourceFromMessage,
  stripBridgeMessageEnvelope,
  type SessionTitleSource,
} from './session-title';
import { lineOfMessage, quotedLine, RecentLines, type RecentLine } from './recent-lines';
import { JudgeBudget, SmartLanes, JUDGE_GLANCE_CAP, JUDGE_BUDGET, JUDGE_BUDGET_WINDOW_MS, type LaneEntry, type LaneKind } from './smart-intake';
import { Attention, outcomeOf, type PlaceRef, type PlaceView, type LookKind, type AttentionTicket, type AttentionGroupToken } from './attention';
import { handleDmConsole } from './dm-console';
import { upgradeAdmins } from '../config/admins-upgrade';
import { createSyncCopyGate } from './sync-copy';
import { fetchInteractiveCardText, isDegradedCardContent } from './card-content';
import {
  collectInboundFiles,
  collectInboundImages,
  messageHasFiles,
  messageHasImages,
  stripFileTokens,
  weaveFileManifest,
  inboundChatDir,
  prepareInboundDir,
} from './media';
import {
  BACKFILL_MAX,
  OPENING_MAIN_MAX,
  STREAMING_RECHECK_MS,
  fetchChatContext as pullChatContext,
  fetchMessageMeta,
  fetchTopicLastBot,
  fetchQuotedMessage as pullQuotedMessage,
  fetchThreadContext as pullThreadContext,
  keepRecent,
  OPENING_MAX,
  weaveQuote,
  weaveRecordBlock,
  weaveSender,
  scheduledHeader,
  scheduledLabel,
  scheduledOpening,
  scheduledRootText,
  plainTaskName,
  type ContextMessage,
  type PullOpts,
  type RecordBlock,
  type ThreadPull,
  type Who,
  wakeTriggerText,
} from './context-weave';
import {
  addCommentReaction,
  buildCommentPrompt,
  commentCwd,
  commentSessionKey,
  DEFAULT_COMMENT_INSTRUCTIONS,
  fitCommentReply,
  loadCommentInstructions,
  postCommentReply,
  removeCommentReaction,
  renderCommentInstructions,
  resolveComment,
  type ResolvedTarget,
  stripMarkdown,
  SUPPORTED_FILE_TYPES,
  syncCommentInstructions,
} from './comments';
import { createEarlyInterrupt, createGracefulInterrupt, createIdlePause, Semaphore, withIdleTimeout, type IdlePause } from './watchdog';
import { createBotRoster } from './bot-roster';
import { readResponseRoster, responseMemberLabel } from './response-members';
import { createNameBook, createPersonNames, fetchChatMembers, resolveNames, withDeadline } from './names';
import { createDmRefusal } from './dm-refused';

/** 所有项目群成员的并集（去重）—— admins 加人的候选源（admins 通常是项目相关的人）。
 * 逐群调 fetchChatMembers，失败的群跳过；不含 bot/应用（接口保证）。 */
async function fetchAllProjectMembers(channel: LarkChannel): Promise<{ openId: string; name: string }[]> {
  const projects = await listProjects();
  // 并发拉各项目群成员（原串行 for-await 在项目多时单次渲染放大成 O(N) 串行调用）。
  const lists = await Promise.all(projects.filter((p) => p.chatId).map((p) => fetchChatMembers(channel, p.chatId)));
  const seen = new Map<string, string>();
  for (const members of lists) {
    for (const m of members) if (!seen.has(m.openId)) seen.set(m.openId, m.name);
  }
  return [...seen].map(([openId, name]) => ({ openId, name }));
}

/** The profile a session starts with, its env carrying `env` too; a session with no profile gets one with only that. */
export function withSessionEnv(profile: SessionProfile | undefined, env: Record<string, string>): SessionProfile {
  return profile ? { ...profile, env: { ...profile.env, ...env } }
    : { instructions: '', env, nativeSettings: { automaticMemory: false }, additionalRoots: [], capabilityPackages: [], mcpServers: [] };
}

/**
 * 从 select_person 的提交值（form_value['pick']）里取出 open_id。单选格式飞书未在
 * 类型中声明（可能是字符串 / 数组 / {open_id|id|value}），故 best-effort 兼容多形态，
 * 取第一个 ou_ 开头的 id；取不到时返回 undefined（回调据此跳过写入）。
 */
function pickOpenId(formValue: Record<string, unknown> | undefined): string | undefined {
  const raw = formValue?.pick;
  const cands: unknown[] = Array.isArray(raw) ? raw : [raw];
  for (const c of cands) {
    if (typeof c === 'string' && c.startsWith('ou_')) return c;
    if (c && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      for (const v of [o.open_id, o.id, o.value]) if (typeof v === 'string' && v.startsWith('ou_')) return v;
    }
  }
  return undefined;
}

/** Read a selectMenu's submitted value (form_value[name]) — best-effort across
 * string / array / {value} shapes, mirroring {@link pickOpenId}. */
function selectValue(formValue: Record<string, unknown> | undefined, name: string): string | undefined {
  const c = (() => {
    const raw = formValue?.[name];
    return Array.isArray(raw) ? raw[0] : raw;
  })();
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object') {
    const o = c as Record<string, unknown>;
    for (const v of [o.value, o.id]) if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Top line of a settings card redrawn after its 免@ button was refused (s25c). */
function noMentionRefused(p: Project | undefined, reason: string): string {
  return `⚠️ 没有改：${p && sessionModeOf(p) === 'smart' ? '这个群现在是智能开话题' : reason}。`;
}

/** The 会话方式 a bind or new-project button carries; anything else reads as 多会话, as before s25c. */
function pickedMode(v: unknown): SessionMode {
  return v === 'single' || v === 'smart' ? v : 'multi';
}

/** Narrow an arbitrary string to a PermissionMode, else undefined. */
function asTier(v: string | undefined): PermissionMode | undefined {
  return v === 'qa' || v === 'write' || v === 'full' ? v : undefined;
}

/** The live provider catalog validates native effort ids at the save boundary. */
function asEffort(v: string | undefined): ReasoningEffort | undefined {
  return v && v.trim() ? v : undefined;
}

/**
 * Pick a NEW session's starting model + effort from a backend's LIVE model list.
 * A project default (`prefer`) wins ONLY when still valid against that live list —
 * its model must be present and non-hidden, and (to carry its effort) that model
 * must support the preferred effort. A stale / wrong-backend pref (a codex id on a
 * claude project, a delisted model, an effort the model dropped) is silently
 * ignored and we fall back to the backend's own default model + effort, so defaults
 * stay self-healing and the CLI is never handed a bad id. The one exception is a
 * hand-typed id (`custom`, product.md 3.11): third-party models are often missing
 * from the list, so it is used verbatim with its stored effort and a wrong id
 * fails in the turn instead. Module-level + exported so the resolution stays
 * unit-testable independent of the orchestrator.
 */
export function pickDefault(
  models: ModelInfo[],
  prefer?: { model?: string; effort?: ReasoningEffort; custom?: boolean },
): { model: string; effort: ReasoningEffort } {
  if (prefer?.custom && prefer.model) return { model: prefer.model, effort: prefer.effort ?? 'medium' };
  const preferred = prefer?.model ? models.find((m) => m.id === prefer.model && !m.hidden) : undefined;
  const def = preferred ?? models.find((m) => m.isDefault && !m.hidden) ?? models.find((m) => !m.hidden) ?? models[0];
  // Carry the preferred effort onto the chosen model only if that model actually
  // supports it — and only when WE kept the preferred model (a fallback model gets
  // its own default, never an effort that was meant for a different model).
  const supported = def?.supportedEfforts ?? [];
  const effort =
    preferred && prefer?.effort && supported.includes(prefer.effort) ? prefer.effort : (def?.defaultEffort ?? 'medium');
  return { model: def?.id ?? 'gpt-5.5', effort };
}

/** A saved explicit acceleration must match the live native Codex catalog. */
export function assertSupportedServiceTier(models: ModelInfo[], model: string | undefined, tier: ServiceTier | undefined): void {
  if (!tier || tier === 'standard') return;
  if (!models.length) throw new CodexServiceTierError('暂时无法读取 Codex 模型的响应速度支持情况，当前设置未更改，请稍后重试。');
  const selected = model ? models.find(item => item.id === model)
    : models.find(item => item.isDefault && !item.hidden) ?? models.find(item => !item.hidden);
  if (!selected?.serviceTiers?.some(item => item.id === tier)) {
    throw new CodexServiceTierError(`模型 ${model ?? '当前模型'} 不支持 ${tier} 响应速度，请改用普通速度或选择支持该档位的模型。`);
  }
}

/** Whether `model` is the hand-typed default it started from (3.11): a session started
 * on it records `modelCustom`, so the /model card and the web keep showing it as
 * hand-typed after the default changes. */
function isCustomDefault(prefer: ModelPreference | undefined, model: string | undefined): boolean {
  return Boolean(model && prefer?.custom && prefer.model === model);
}

/**
 * 新建/绑定项目卡的后端下拉选项：列出该权限档兼容的**全部**（非隐藏）后端——已下载的
 * 正常显示；**未下载的（如 Claude）也列出并标注「未下载·去控制台下载」**，让用户知道它
 * 存在、并去 Web「后端 Agent」页下载（Feishu 下拉无法对单项置灰，故用标注 + 提交时
 * {@link assertBackendUsable} 友好拦截，等价于「置灰 + 提示」）。新建默认档 'full'、绑定
 * 外部群默认档 'qa'，按 supportedModes 过滤（claude 仅 full，qa 下自然只剩 codex）。
 */
function backendOptionsFor(mode: PermissionMode): SelectOption[] {
  const opts: SelectOption[] = visibleCatalog()
    .filter((e) => !e.supportedModes || e.supportedModes.includes(mode))
    .map((e) => {
      const installed = e.id === DEFAULT_BACKEND_ID || isBackendEntryInstalled(e);
      return { label: installed ? e.displayName : `${e.displayName}（未下载·去控制台下载）`, value: e.id };
    });
  // 只剩默认 codex（无真实选择）时不渲染后端区，卡片回到「无后端概念」形态。
  return opts.length > 1 ? opts : [];
}

/**
 * Feishu's chat.create `uuid` for one DM card click (s36d1): the card message, the clicker and the render token
 * stamped into that card's buttons. A click Feishu delivers again, even after a restart, sends the same uuid;
 * a fresh card, or the same card rendered again, makes a new one. 32 hex characters, within Feishu's 50.
 */
export function dmCreationId(messageId: string, operator: string, renderToken: unknown): string {
  return createHash('sha256').update(JSON.stringify([messageId, operator, typeof renderToken === 'string' ? renderToken : ''])).digest('hex').slice(0, 32);
}

/** Said when a creation reaches its turn after shutdown began: nothing was sent to Feishu. */
const CREATION_STOPPING = '后台服务正在关闭，没有建群';

/** 把卡片提交的 backend 收成安全值：必须是注册表里的 id，否则丢弃（落回默认 codex），防伪造。 */
export function safeBackendId(formValue: Record<string, unknown> | undefined): string | undefined {
  const v = selectValue(formValue, 'backend');
  return v && backendIds().includes(v) ? v : undefined;
}

// 后端切换校验 + 探测已抽到管理面共享层（admin/ops.ts）——DM 回调与 Web 控制台
// 写同一套逻辑的单一事实源。原处 re-export 保持既有 import 路径（含测试）不变。
export { BACKEND_PROBE_TIMEOUT_MS, probeBackends, validateBackendSwitch } from '../admin/ops';

/** One ordinary turn waiting behind the current turn in the same session. The
 * requester and enqueue clock travel with the input so completion @ mentions,
 * manual-reminder ownership and long-task timing never leak from turn one. */
export interface QueuedTurn {
  feedback?: FeedbackSource;
  attentionAcceptance?: AttentionAcceptance;
  voice?: VoiceReply;
  input: AgentInput;
  /** Un-woven SDK message source used only if this becomes the first accepted
   * host turn. Never recover a title from AgentInput.text. */
  titleSource: SessionTitleSource;
  requesterOpenId?: string;
  requesterKind?: 'user' | 'bot' | 'unknown';
  /** The requester's name, recorded as a scheduled task's creator (agent/entry/registry.ts TurnFacts.requesterName). */
  requesterName?: string;
  requestedAt: number;
  /** Clean user-authored label; never derive reminder copy from woven input. */
  summary?: string;
  /** Set on a 🔁 重试 turn: the original input it wraps (see {@link retryPrompt}). */
  replayText?: string;
  /** The inbound message, marked seen once the host accepts its turn
   * (turn_started), never when it is queued or dequeued: a dropped queue or a
   * refused turn/start must leave it for the next back-fill. */
  seen?: SeenMark;
  /** The message that triggered this turn, when {@link seen} is not set (a new topic's first turn): what the turn's
   * memory facts count as typed by a person (agent/entry/registry.ts `openTurn`). */
  triggerMessageId?: string;
  /** How {@link seen} moves the watermark (session-store.nextSeen); 'id' when unset. */
  seenHow?: SeenHow;
  /** Other bots' cards its record block wove while they were still streaming (SessionRecord.streaming). */
  streaming?: SeenMark[];
  /** Ids of the messages its record block carried (see ActiveState.woven). */
  woven?: string[];
  /** The topics its record block quoted, marked seen with {@link seen} so each is quoted once. */
  seenExtra?: SeenMark[];
  /** The private chat's messages it stands for, while a recall can still change what it says. */
  burst?: DmBurst;
  /** Its record block carried the recent topics (SessionRecord.topicsDue), cleared once it starts. */
  tableShown?: boolean;
  /** The recall notes its block said (SessionRecord.recalls), dropped once it starts (s15). */
  recallsShown?: string[];
  /** An opening turn's oldest line, written as SessionRecord.from once it starts (s15). */
  from?: number;
  /** The message's place, for the reply asking to send it again when a shutdown drops it (s18c). */
  origin?: DroppedOrigin;
  /** The smart mode joined in on its own (TurnExtra.initiative): its card goes if it ends with nothing to say (s25b). */
  initiative?: true;
  wake?: TurnExtra['wake'];
  /** The trigger message as typed, for the memory provenance check (记忆设计 §3.2); absent for a bot's message and a retry. */
  memoryTrigger?: MemoryTrigger;
  /** A scheduled task's run (T2): settled when this turn ends or is dropped; its cards go to the hook's target. */
  scheduled?: ScheduledHook;
}
/** What the memory write rules look at in the trigger message: that a person typed it, and its own words (no quote, forward or record block). */
export interface MemoryTrigger { typed: boolean; text: string }

/** A resumed session's title for its record and topic. Without a native name
 * the backend's preview is the first prompt as the bot wove it, record block
 * and the sender's open_id included, so only the person's words are kept; the
 * name goes through the same stripping, as the desktop list does. */
function resumedTitle(history: ThreadHistory): string | undefined {
  return stripBridgeMessageEnvelope(history.name ?? '').trim() || stripBridgeMessageEnvelope(history.preview ?? '').trim() || undefined;
}

/** The backend's name as users know it, from the catalog (Codex, Claude): the
 * backend's own displayName can carry an implementation tag ("Codex (app-server)"). */
function backendLabel(be: Pick<AgentBackend, 'id' | 'displayName'>): string {
  return catalogById(be.id)?.displayName ?? be.displayName;
}

/** A resumable session as the desktop lists it (`name`, else `preview`): the
 * same stripping, so an unnamed one shows the person's words, not the envelope. */
function resumableThread(thread: ThreadSummary): ThreadSummary {
  const { name, ...rest } = thread;
  const title = name && stripBridgeMessageEnvelope(name).trim();
  return { ...rest, preview: stripBridgeMessageEnvelope(thread.preview).trim(), ...(title ? { name: title } : {}) };
}

/** How long ago the message was sent (0 when its createTime is unknown). */
function deliveryLagMs(msg: Pick<NormalizedMessage, 'createTime'>): number {
  return msg.createTime ? Date.now() - msg.createTime : 0;
}

/** Switch the mutable session control state to a queued follow-up. Exported as
 * a tiny pure-ish seam so requester isolation (and manual-override reset) stays
 * testable without booting a real agent process. */
export function activateQueuedTurn(
  state: { requesterOpenId?: string; requesterKind?: 'user' | 'bot' | 'unknown'; completionReminderRequested?: boolean },
  turn: QueuedTurn,
): void {
  state.requesterOpenId = turn.requesterOpenId;
  state.requesterKind = turn.requesterKind;
  state.completionReminderRequested = false;
}

/** Only the exact turn initiator may opt that turn into the manual reminder. */
export function isCompletionReminderRequester(operatorOpenId?: string, requesterOpenId?: string): boolean {
  return Boolean(operatorOpenId && requesterOpenId && operatorOpenId === requesterOpenId);
}

function logSubagentChanges(before: RunState['subagents'] = [], after: RunState['subagents'] = []): void {
  for (const row of after) {
    const previous = before.find(old => old.id === row.id);
    if (!previous || (row.status !== 'running' && row.status !== previous.status)) {
      log.info('agent', 'subagent', { id: row.id.slice(-6), status: previous ? row.status : 'start', steps: row.steps.length });
    }
  }
}

/**
 * Settle an ordinary turn after its event stream closes. A dead backend can
 * close the async iterator without ever emitting `done` or a fatal `error`; in
 * that case treating a still-running render as success produces a false
 * “completed” card and success reminder. Preserve every explicit terminal
 * emitted by the backend, but turn an otherwise-unexplained process exit into
 * a fatal error.
 */
export function settleOrdinaryTurnRender(
  render: RunRender,
  input: { interrupted: boolean; timedOut: boolean; idleTimeoutSeconds: number; procDead: boolean },
): void {
  const subagents = render.snapshot().subagents;
  if (input.interrupted) render.interrupt();
  else if (input.timedOut) render.timeout(input.idleTimeoutSeconds);
  else if (input.procDead && render.terminal() === 'running') {
    render.apply({ type: 'error', message: 'agent 进程异常退出，请重发本条消息', willRetry: false });
  } else {
    // finalize() is a no-op for explicit done/error terminals.
    render.finalize();
  }
  logSubagentChanges(subagents, render.snapshot().subagents);
}

/** A turn that started but did not answer: the error it threw, or the run state it ended in. */
interface TurnFailure { error?: unknown; rs?: RunState; procDead?: boolean }
/** The message a not-replied record is about. */
type NotedMessage = Pick<NormalizedMessage, 'chatId' | 'messageId' | 'senderId' | 'createTime' | 'threadId'>;

/** How long a group's full-only explanation quiets 免@ and bot messages; a person's @ always gets one. */
const FULL_ONLY_QUIET_MS = 10 * 60_000;
/**
 * A stop, restart or update interrupts every turn at once (owner 2026-11-02) and gives Codex and Claude this long to
 * end them, and the shell commands they started, before their processes are closed. Codex answers within milliseconds.
 */
export const SHUTDOWN_INTERRUPT_GRACE_MS = 3_000;
/** How long a shutdown waits for the interrupted turns' cards, the grace above included; the Bot child is killed at 15 s. */
export const SHUTDOWN_DRAIN_MS = 8_000;
const UNBOUND_QUIET_MS = 10 * 60_000;
/** Each 三条底线 lookup's limit (s22): the group's later messages wait behind it. */
const LOOKUP_DEADLINE_MS = 3000;
/** How far back a topic may open under an earlier line than the judged one (s25b): one of the batch, or one of the
 * last 5 lines and 10 minutes before it. Further back, the asker may not see it. */
const ANCHOR_LINES = 5;
const ANCHOR_WINDOW_MS = 10 * 60_000;
/** Deleting an empty card (s25b): the turn's end waits this long at most. Feishu: 230110, deleted already. */
const DELETE_DEADLINE_MS = 5000;
const MESSAGE_GONE = 230110;
/** Feishu's no-permission answers to a delete: the platform's and the endpoint's own. */
const DELETE_DENIED_CODES: ReadonlySet<number> = new Set([99991672, 230027]);

const REASON_BY_ERROR_KIND = {
  auth: 'signed-out', version: 'codex-too-old', quota: 'quota', network: 'network',
} as const satisfies Record<AgentErrorKind, NotRepliedReason>;

/** Why a turn that started did not answer, for the 状态与诊断 page (s19): a scope Feishu refused, a missing
 * backend, the watchdog, the error's kind, a dead process, else the error's first line. */
export function failureReason(failure: TurnFailure): { reason: NotRepliedReason; detail?: string; scope?: string } {
  const denial = failure.error === undefined ? undefined : scopeDenial(failure.error);
  if (denial) {
    const scope = deniedScopeName(denial.accepted);
    return scope ? { reason: 'missing-scope', detail: scope, scope } : { reason: 'missing-scope' };
  }
  if (failure.error instanceof BackendNotInstalledError) return { reason: 'tool-missing' };
  if (failure.error instanceof CodexFullOnlyError) return { reason: 'tier-unavailable' };
  if (failure.rs?.terminal === 'idle_timeout') return { reason: 'idle-timeout' };
  const message = failure.error === undefined ? failure.rs?.errorMsg : errorDetail(failure.error);
  const kind = failure.rs?.errorKind ?? (message ? errorKindFromText(message) : undefined);
  if (kind) return { reason: REASON_BY_ERROR_KIND[kind] };
  if (failure.procDead) return { reason: 'agent-exited' };
  const detail = message ? errorDetail(message) : undefined;
  return detail ? { reason: 'failed', detail } : { reason: 'failed' };
}

function backendTool(id: string | undefined): NotReplied['backend'] {
  if (id === 'claude-agent') return 'claude';
  if (id === 'codex-appserver') return 'codex';
  return undefined;
}

/** Failure feedback includes unprocessed follow-ups; they must never disappear
 * behind an error referring only to the original message. A session-change
 * notice no card showed yet rides along, so the switch is never silent. */
function runFailureMessage(err: unknown, dropped: number, sessionNotice?: string): string {
  const error = `❌ ${err instanceof Error ? err.message : String(err)}`;
  const parts = [error];
  if (dropped > 0) parts.push(`⚠️ ${dropped} 条排队消息未执行，请重发。`);
  if (sessionNotice) parts.push(sessionNotice);
  return parts.join('\n\n');
}

/** Why a location's stored session couldn't be continued (see resolveThread). */
type ToolRefresh = 'feedback-tool' | 'resource-tools';
export type RecreateReason = 'resume-failed' | 'cwd-changed' | 'provider-changed' | ToolRefresh;

function requiredCodexTools(extra?: TurnExtra): ToolRefresh | undefined {
  if (extra?.resourceSelected) return 'resource-tools';
  if (extra?.feedback) return 'feedback-tool';
}

function missingCodexTools(required: ToolRefresh | undefined, rec?: SessionRecord, live?: AgentThread): boolean {
  if (!required || rec?.backend !== 'codex-appserver') return false;
  return required === 'resource-tools'
    ? !live?.startedWithResourceTools && rec.resourceToolSessionId !== rec.sessionId
    : !live?.startedWithFeedbackTool && rec.feedbackToolSessionId !== rec.sessionId;
}

interface ResolvedThread { thread: AgentThread | undefined; recreated: boolean; reason?: RecreateReason }

/** The run-card line for a forced session change: never switch sessions
 * silently (product.md 3.5). A topic re-weaves its recent messages into the new
 * session; the main area has nothing to re-weave. */
export function sessionChangeNotice(reason: RecreateReason, topic: boolean): string {
  if (reason === 'resource-tools') return '本轮已启用配方资料工具。原 Codex 会话保留在历史记录中。';
  if (reason === 'feedback-tool') return '本轮已启用群反馈工具。原 Codex 会话保留在历史记录中。';
  const why = reason === 'cwd-changed' ? '本群的工作目录改了' : reason === 'provider-changed' ? 'Provider 换了' : '原来的会话接不上了（恢复失败）';
  const carried = topic ? '，话题里最近的消息已重新带上' : '';
  return `⚠️ ${why}，这一轮起换了一条新会话，之前的对话记不得${carried}。`;
}

interface ActiveState {
  steerReply?: { run: AgentRun; accept: (messageId: string, voice?: VoiceReply) => boolean };
  presentation?: AppConfig;
  /** The run's group, set by startReservedRun, launchRun and launchGoalRun; the edit lock looks at this group's runs only (see runningIn). */
  chatId?: string;
  /** Captured with the steer target so a late ACK cannot decorate another turn. */
  voiceReply?: { run: AgentRun; add: (voice: VoiceReply) => void };
  /** Prevent a late ASR result from restarting a stopped conversation. */
  intakeCancelled?: boolean;
  /** unset only during the brief "reserved, still resolving the thread" window */
  thread?: AgentThread;
  run?: AgentRun;
  runCard?: RunCardState;
  subagents?: () => SubagentRow[];
  /** follow-up turns queued mid-run; each carries its own text + downloaded images */
  queue: QueuedTurn[];
  /** who started this run — gates destructive ⏹ (design §5) */
  requesterOpenId?: string;
  /** A bot-started turn sends no completion reminder and shows no reminder button. */
  requesterKind?: 'user' | 'bot' | 'unknown';
  /** Group mode captured for this run, including its global-slot wait. */
  smart?: boolean;
  /** Manual mode, current turn only. May be set while the initial run is still
   * waiting in the global concurrency queue; reset when a queued follow-up
   * becomes the current turn. */
  completionReminderRequested?: boolean;
  /** ⏹ 终止: interrupt the in-flight codex turn. Set per-turn while a run is in
   * flight. codex 0.139+ 在 turn/interrupt 后以 turn/completed(status:
   * "interrupted") 干净收尾（08b 探针实测；旧版「no mappable terminal」行为已
   * 证伪），所以正常路径发 interrupt 后等事件流自然 done、线程与进程留用；只有
   * turnId 未到手或 5s 没收尾才强停本地循环 + 杀进程（createGracefulInterrupt）。
   * For a goal run this instead clears the goal first (so it won't reactivate on
   * resume)、按既有设计每轮回收进程, and suppresses the goal summary card. */
  interrupt?: () => void;
  /** 🎯 结束目标 (goal runs only): clear the goal so codex stops auto-continuing,
   * but let the in-flight turn finish streaming; the loop then ends after that
   * turn's `done` (or immediately if no turn is in flight). No summary card. */
  endGoal?: () => void;
  /** The messages the record block of this run's first turn carried, set once
   * the host took that turn. Feishu does not keep events in order, so a message
   * queued while the block was pulled can be one of them: it is not run again. */
  woven?: Set<string>;
  /** goal run (launchGoalRun): turns are auto-continued by codex and the queue
   * is never consumed — incoming messages get a prompt instead of queueing
   * (they'd be dropped silently at the end otherwise). */
  isGoal?: boolean;
  /** The in-flight turn's idle watchdog. s30 holds it while a card waits on a
   * person (product.md 3.8). An ordinary turn gets a fresh one; a /goal run
   * resets its one at every turn boundary. Either way a hold never outlives
   * the turn that took it. */
  idlePause?: IdlePause;
  /** A run loop drains this state's queue and {@link compactAfter} (startReservedRun, launchRun). */
  runLoop?: true;
  /** A request requiring new native tools waits for an old native session's current run before changing its tools. */
  settled?: Promise<void>;
  /** A /compact sent while this run was busy: done right after the current turn (product.md 3.5). */
  compactAfter?: { msg: NormalizedMessage; inThread: boolean };
  /** A compaction runs on this session now (an idle /compact, or a queued one between turns). */
  compacting?: boolean;
  /** Set while /compact or /new holds the session with no run: input waits here and
   * goes through intake again once the command is done (s15). `early` tells one
   * sent before a /new that swapped ({@link newAt}) instead. */
  deferred?: { id: string; at?: number; go: () => void; early: () => void; origin?: DroppedOrigin }[];
  /** The /new command's send time, once its swap is done: input sent before it belongs to the old session. */
  newAt?: number;
  /** The run's trigger while it waits for a global slot (acquireRunSlot), for a shutdown to keep (s18c). */
  waiting?: DroppedOrigin;
  /**
   * A person's turn in flight, from the moment its run reserves the session (a first turn still being prepared: its
   * session resumed, its images downloaded) or takes it off the queue, until its final card is written: what a shutdown
   * or a crash cuts short (review 260).
   */
  inFlight?: DroppedOrigin;
  /** A main-area run's trigger time: until {@link woven} is known, its record block will carry the unread
   * messages before it (a smart verdict to open a topic checks this, s25). */
  triggerAt?: number;
  /** A scheduled turn is running: a message arriving now queues, never steers into it (总设计 7.1). */
  scheduled?: true;
  /** A settings change closed this run's thread (evictLiveSessionsForChat, or startReservedRun when it was closed before
   * the run began): a turn of it that fails or is yet to start is dropped with the turns queued behind, a scheduled one
   * skipped, the group having changed (launchRun's settleGone). */
  evicted?: true;
  /** launchRun dropped the queue for that change, not for a ⏹: a scheduled turn still in intake is skipped too (intakeStopped). */
  evictedDrop?: true;
}

/** Run scripts at turn boundaries only; card repaint ticks reuse this snapshot. */
async function refreshRunCardDisplayValues(rc:RunCardState,cwd:string):Promise<void> {
  if (!rc.cardDisplay) return;
  try {
    const result = await runCardDisplayScripts(rc.cardDisplay,{cwd,values:buildRunCardBase({...rc,cardDisplay:undefined}).values});
    rc.cardDisplayValues = result.values;
    for (const error of result.errors) log.info('card','display-script-error',{block:error.id,message:error.message});
  } catch (error) {
    rc.cardDisplayValues={};
    log.fail('card',error,{phase:'display-script-prepare'});
  }
}

/** Element IDs removed from an orphan CardKit entity after a stale run action. */
export function deadRunCardElementIds(actionId:string,extraElementId?:string):string[] {
  const movedStop=actionId===RC.stop||actionId===RC.endGoal||actionId===RC.remind;
  return [CONTROLS_EID,...(movedStop?[CARD_DISPLAY_STOP_EID,CARD_DISPLAY_REMINDER_EID]:[]),...(extraElementId?[extraElementId]:[])];
}

interface AttentionAcceptance {
  accept(): void;
  opened(topicId: string): void;
}

/** Inputs a synthetic turn (🔁 重试) carries that a real message would not. */
interface TurnExtra {
  /** The ordinary DM router verified a delivered resource for this SDK message. */
  resourceSelected?: true;
  feedback?: FeedbackSource;
  /** A smart judgement's one-use acknowledgement of actual session intake. */
  attentionAcceptance?: AttentionAcceptance;
  /** Local image paths to send instead of downloading the message's own. */
  images?: string[];
  /** Clean label for titles and reminders, instead of the prompt text. */
  summary?: string;
  /** Never steer into a running turn. */
  queueOnly?: boolean;
  /** The failed turn's own input, kept unwrapped so a retry of a retry wraps it once. */
  replayText?: string;
  /** Asked right before the turn is reserved (see startReservedRun). */
  retry?: RetryGate;
  /** The smart mode joined in on its own (s25): the agent gets {@link INITIATIVE_NOTE} before the message. */
  initiative?: true;
  wake?: { name: string };
  /** A private chat's burst this turn stands for: its lines are in the text, so the record block leaves them out. */
  burst?: DmBurst;
  /** A scheduled task's run (T2): never steers, nothing is ingested, every drop settles it. */
  scheduled?: ScheduledHook;
}

/** A smart group's message on its lane (s25). */
/** The messages of a private chat that go on as one (see holdDm). */
export interface DmBurst {
  place: string;
  msgs: NormalizedMessage[];
  timer?: unknown;
  /** One of them was recalled before the landing: the others went round again. */
  gone?: true;
}

const burstMarks = (burst: DmBurst | undefined): SeenMark[] => (burst?.msgs ?? []).map((msg) => ({ id: msg.messageId, at: msg.createTime }));

interface SmartItem extends LaneEntry {
  at: number;
  attentionGroup?: AttentionGroupToken;
  /** One short-lived continuation opportunity after a real reply. */
  priority?: true;
  wake?: true;
  msg: NormalizedMessage;
  variant: JudgeVariant;
  /** The reaction a named message got while it waits on its judgement. */
  ack?: Promise<string | undefined>;
  /** Why this human message is judged immediately. */
  signal?: 'at-me' | 'quote-me' | 'name' | 'dm';
  /** It stands for several messages of a private chat. */
  burst?: DmBurst;
  quoteBy?: 'quote' | 'root';
}

interface WakeFacts { text: string; sender: { openId?: string; name?: string } }

/** What a smart group's lane decided for a batch (s25). */
type SmartVerdict =
  | { kind: 'judged'; result: JudgeResult; wake?: WakeFacts; look?: string[] }
  /** Answered after a failed or timed-out judgement: named, or a topic only its sender talks in. */
  | { kind: 'direct' }
  /** Not judged: the group's hourly budget is spent. */
  | { kind: 'budget' }
  /** Not answered, nothing noted: a 同时发送到群 copy, or a group no longer bound. */
  | { kind: 'drop' };

/** A 🔁 重试 turn's say in its own reservation. */
interface RetryGate {
  /** False once the button was taken away (newer input, a swapped thread). */
  current(): boolean;
  /** Tell the tapper the button went stale; nothing was queued. */
  stale(): void;
  /** Tell the tapper something else holds the session; the button stays. */
  busy(): void;
  /** Tell the tapper the group takes no turns right now (see turnRefusal); the button stays. */
  refused(note: string): void;
  /** The session reserved the retry as a fresh run. */
  accepted(): void;
}

/** A turn whose terminal card offers [重试] (idle watchdog or network failure). */
interface RetryTurn {
  sessionKey: string;
  chatId: string;
  flat: boolean;
  turn: QueuedTurn;
  /** What the agent got for that turn, before any retry wrapper. */
  replayText: string;
  reason: 'idle' | 'network';
  idleSeconds: number;
  /** Set when the button is taken away (the session took newer input, or the
   * tap was used): a tap still in flight holding this record sees it. */
  expired?: boolean;
  /** Settles once the failed run finished wrapping up that turn. */
  settled: Promise<void>;
}

/** Reply to an @ (or a 🔁 重试) in a group not bound to any project. */
const UNBOUND_GROUP_REPLY = '主人还没设置好这个群，设置好就能用。';

/** What the agent receives when [重试] is tapped: why the last turn stopped,
 * then that turn's input as it was sent. */
export function retryPrompt(retry: Pick<RetryTurn, 'reason' | 'idleSeconds'>, text: string): string {
  const why = retry.reason === 'idle' ? `${idleLabel(retry.idleSeconds)}没有输出，被自动停止了` : '网络失败，中断了';
  return `（重试）上一轮因为${why}。下面是上一轮收到的消息，请重新处理。上一轮可能已经做了一部分，先看看做到哪了再继续，别重复做。\n\n${text}`;
}

/** Message-reaction lifecycle controller (see {@link runReaction}). */
interface RunReaction {
  /** the run acquired a concurrency slot and is now running → Typing */
  started: () => void;
  /** the run ended (complete / ⏹ / timeout / error) → DONE */
  done: () => void;
}

/** A recall event's fields (it has no sender, time or topic). */
export interface RecallEvent {
  messageId?: string;
  chatId?: string;
  /** message_owner, group_owner, group_manager or enterprise_manager. */
  recallType?: string;
}

export interface Orchestrator {
  /** Called by the production bridge before event intake; never runs in unit harnesses implicitly. */
  initialize?(): Promise<void>;
  collaboration: (request: CollaborationRequest) => Promise<unknown>;
  onMessage: (msg: NormalizedMessage) => Promise<void>;
  /** `comment` event handler: @bot in a cloud-doc comment → reply in-thread. */
  onComment: (evt: CommentEvent) => Promise<void>;
  /** `botAdded` event: a human added the bot to a group → DM the (admin) adder
   * a bind card to register it as a `joined` project. */
  onBotAddedToChat: (evt: BotAddedEvent) => Promise<void>;
  /** bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher) → auto-unbind the bound project, if any. */
  onBotRemovedFromChat: (chatId: string) => Promise<void>;
  /** `reaction` event (im.message.reaction.created_v1)：终态 run 卡 👍 = 续轮，
   * 运行中 run/排队卡 OK/DONE = ⏹ 终止（M-6 零打字驱动）。 */
  onReaction: (evt: ReactionEvent) => Promise<void>;
  /** application.bot.menu_v6（raw-tap）：bot 单聊菜单点击 → DM 管理台菜单卡。 */
  onBotMenu: (evt: { openId?: string; eventKey?: string; eventId?: string }) => Promise<void>;
  /** im.message.recalled_v1 (raw-tap): note the recall for the sessions the message reached (s15). */
  onRecall: (evt: RecallEvent) => Promise<void>;
  dispatcher: CardDispatcher;
  adminExecute: (op: AdminWriteOp) => Promise<AdminWriteResult>;
  /** This bot's one writer of its preferences. */
  writePreferences: AppPreferencesWriter;
  /** The host changed a library project's workspace: this bot's rows of it follow, their groups' sessions archived (admin/library.ts). */
  libraryExecute: (op: AdminLibraryOp) => Promise<unknown>;
  settings: HostSettings;
  /**
   * Scheduled tasks through the command core (admin/schedule-commands.ts): the agent tools' actor comes from the turn's
   * grant (agent/entry/schedule-tools.ts), the wire's is the local owner's or a Bot session's turn.
   */
  scheduleAs: (actor: ScheduleActor, request: ScheduleRequest) => Promise<ScheduleReply>;
  /** A bound group's permission tier now; undefined for a chat not bound. */
  permissionOf: (chatId: string) => Promise<PermissionMode | undefined>;
  /** The scheduled-task tick (bot/schedule/scheduler.ts), outside admit; bridge.ts starts it once Feishu is connected. */
  scheduler: { start(): Promise<void>; stop(): void; drain(ms: number): Promise<void> };
  /** Interrupts every turn, gives the agents a moment to end them, then closes every live session so a graceful exit
   *  leaves no orphan processes (owner 2026-11-02). `reason` is read as each cut-short turn's card is written. */
  shutdown: (reason?: () => StopReason) => Promise<void>;
  /** Persist queued messages before an uncaught failure exits the bot. */
  saveDroppedSync: (why: 'shutdown' | 'crash') => void;
  /** Once connected: ask the senders of what the last shutdown dropped to send again (s18c). Not after shutdown. */
  replyDropped: () => void;
}

/**
 * The group orchestrator owns all per-bridge run state (codex threads, active
 * turns, concurrency, pending command cards) and exposes both the inbound
 * message handler and the card-action dispatcher so they share that state.
 *
 * Flow (design §3):
 *   p2p                       → an administrator's own Agent (dm-agent 5); `/menu` and the card answers stop before it.
 *   group @bot, no thread     → reply_in_thread creates the topic → run codex
 *                               (default model/effort; tune later with /model).
 *   group @bot /resume        → history picker → resume a codex thread in a new topic.
 *   group @bot, inside thread → a turn in that session (steer/queue mid-turn);
 *                               /model opens the model/effort picker for it.
 *
 * Group kinds (project.kind): 'multi' (default) = a topic per session, keyed by
 * threadId (the flow above); 'single' = the main area is one session keyed by
 * chatId, replies quote the message (no topic, runs serialize). A topic someone
 * opens in a single group is its own session keyed by threadId, like multi. 免@ (noMention,
 * default on) lets non-@ messages run too — multi only inside a topic, single
 * whole-group (needs the im:message.group_msg scope). @bot /settings toggles it.
 */

/**
 * Detect a `/goal` trigger ANYWHERE in the message (not just a leading command):
 * a standalone, whitespace-delimited `/goal` token. Returns the objective — the
 * message with the token stripped and whitespace collapsed — or null if there's
 * no token or nothing left after it. The token must be whitespace-bounded so
 * paths and URLs containing `/goal` (e.g. `src/goal/x.ts`, `cmd/goal/main.go`,
 * `https://x/goal`) never trigger. No /goal pause|resume|clear|status slash
 * subcommands — manual control is via the run card's ⏹ 终止 / 🎯 结束目标 buttons.
 */
export function parseGoalTrigger(text: string): string | null {
  if (!/(^|\s)\/goal(?=\s|$)/i.test(text)) return null;
  const objective = text
    .replace(/(^|\s)\/goal(?=\s|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return objective.length > 0 ? objective : null;
}

// ── M-6 Reaction 入站：零打字驱动 ────────────────────────────────────
/** 运行中卡片上「⏹ 类」表情 → 终止。飞书 reaction 面板没有 ⏹，取语义最近的
 * OK（👌「到此为止」，synthesis 验收用例）与 DONE（✅）。 */
export const STOP_EMOJIS: ReadonlySet<string> = new Set(['OK', 'DONE']);
/** 终态卡片上 👍 → 续轮（等价于在话题里发一句「继续」）。 */
export const CONTINUE_EMOJIS: ReadonlySet<string> = new Set(['THUMBSUP']);
export type ReactionIntent = 'stop' | 'continue';

/**
 * Reaction → 意图的纯决策（exported for tests）：运行中的 run/排队卡只认
 * STOP_EMOJIS（👍 在运行中无意义，忽略）；终态卡只认 CONTINUE_EMOJIS（终态卡
 * 没有可终止的东西）。其余 emoji 一律 null —— 群友的日常表情不该有副作用。
 */
export function classifyReaction(emojiType: string, running: boolean): ReactionIntent | null {
  if (running) return STOP_EMOJIS.has(emojiType) ? 'stop' : null;
  return CONTINUE_EMOJIS.has(emojiType) ? 'continue' : null;
}

/**
 * 入站事件去重（飞书事件 at-least-once：WS 重连窗口会重推同一事件）。卡片回调
 * SDK 自带 12h 去重，消息/评论侧没有 —— 重推的指令会排队后双跑 codex（写盘类
 * 指令二次执行）。Map 的插入序即 LRU 序：TTL 内命中视为重复；超容量剔除最旧。
 */
export class RecentIdCache {
  private readonly entries = new Map<string, number>();
  constructor(
    private readonly maxEntries = 2048,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  /** Record `id`; true ⇔ already seen within the TTL (i.e. a duplicate). */
  seen(id: string): boolean {
    const now = Date.now();
    const at = this.entries.get(id);
    if (at !== undefined && now - at < this.ttlMs) return true;
    this.entries.delete(id); // re-insert so the Map's order stays oldest-first
    this.entries.set(id, now);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return false;
  }
}

/** How long and how many recalled message ids a process keeps (s15). */
const RECALLED_TTL_MS = 24 * 60 * 60_000;
const RECALLED_MAX = 2000;

/** Remove the items `hit` picks from `list` in place; how many went. */
function removeWhere<T>(list: T[], hit: (item: T) => boolean): number {
  let removed = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (hit(list[i]!)) {
      list.splice(i, 1);
      removed++;
    }
  }
  return removed;
}

/**
 * card_id of a CardKit-entity message (a run card's carrier message body is
 * `{"type":"card","data":{"card_id":…}}`), or undefined for any other shape.
 * Used to heal a post-restart orphan run card whose in-process entity mapping
 * is gone (M-4 ⏹ 静默失败反馈).
 */
export function cardIdFromMessageContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content) as { type?: string; data?: { card_id?: string } };
    return parsed?.type === 'card' && typeof parsed.data?.card_id === 'string' ? parsed.data.card_id : undefined;
  } catch {
    return undefined;
  }
}

// ── M-3 空闲进程 reaper 参数 ─────────────────────────────────────────
/** 超过这个时长没有任何轮次的 LIVE 会话进程被回收（close + 驱逐缓存）。持久化
 * 记录保留，下一条消息经 resolveThread 的 resume 兜底自愈（~250ms–1.6s），对话
 * 无感衔接。synthesis 给的区间 30–60min，取中值。 */
const SESSION_REAP_IDLE_MS = 45 * 60_000;
/** How long a resume waits for the bot's own released Codex process to exit (s15b). */
const RELEASE_WAIT_MS = 10_000;
/** reaper 清扫周期。 */
const SESSION_REAP_SWEEP_MS = 5 * 60_000;

/**
 * M-3 空闲进程 reaper 的纯决策：从 LIVE 会话 key 里挑出可回收的 —— 跳过 busy
 * 的（运行/排队中的 active、评论串行链的 docLocks）与最近 idleMs 内有过轮次
 * （touchedAt 打点）的；没有打点的 key 不回收（调用方先补记，下一轮再评估）。
 */
export function pickIdleSessions(
  keys: Iterable<string>,
  touchedAt: ReadonlyMap<string, number>,
  isBusy: (key: string) => boolean,
  idleMs: number,
  now: number,
): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (isBusy(key)) continue;
    const at = touchedAt.get(key);
    if (at === undefined || now - at < idleMs) continue;
    out.push(key);
  }
  return out;
}

export interface IntakeTime {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export function createOrchestrator(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
  /** The topic registry (s13); without it nothing is recorded (tests). */
  topics?: TopicRegistry,
  /** `droppedFile`: where a shutdown keeps the queued messages it drops (s18c). No default: without it, nothing is
   * kept or answered (tests, and every caller but `daemon run`). */
  // Only daemon run supplies judgeUsageFile; tests that omit it do not persist usage.
  options?: { feedback?: FeedbackHost; authoring?: Pick<import('../recipe/authoring-service').AuthoringService, 'onMessage' | 'onAction' | 'adminRemoved'> & Partial<Pick<import('../recipe/authoring-service').AuthoringService,'resources'>>; entries?: AgentEntries; memory?: MemoryWriter; droppedFile?: string; judgeUsageFile?: string; bot?: BotIdentity; time?: IntakeTime; attention?: Attention;
    /** devices-4a 4.3: where each new session's token comes from (the host, over IPC). Without it a session gets none (tests). */
    host?: Pick<HostApi, 'issueSessionToken'>;
    /** The launcher this Bot wrote for its sessions (agent/session-cli.ts); without one a session's PATH stays as it was. */
    sessionCli?: string;
    /** A shutdown's two waits (owner 2026-11-02); tests shorten them. */
    shutdownTiming?: { interruptGraceMs?: number; drainMs?: number } },
): Orchestrator {
  const entries = options?.entries;
  const host = options?.host;
  const sessionCli = options?.sessionCli;
  const memory = options?.memory;
  const bindingBot = options?.bot ? { ...options.bot } : undefined;
  /** Lazily-constructed backends by id — one instance per backend for the whole
   * bridge (mirrors the old single-instance shape; codex stays the default). */
  const backends = new Map<string, AgentBackend>();
  function backendFor(id?: string): AgentBackend {
    // 指向已移除后端（如历史 claude-*）的旧项目配置回退到默认 codex，避免 createBackend
    // 抛「未知后端」让该群消息处理崩。
    const key = id && catalogById(id) ? id : DEFAULT_BACKEND_ID;
    let be = backends.get(key);
    if (!be) {
      be = createBackend(key);
      backends.set(key, be);
    }
    return be;
  }

  /** The group's execution values (s36d2): its tier, network, workspace and 运行中来了消息. */
  function execOf(project: Project | undefined) {
    return resolveExecution({ bot: cfg.preferences, group: project });
  }
  /** What vonvon hands a session of `project` (a comment session when there is none): see bot/context-assembly.ts. */
  async function contextSourcesFor(project: Project | undefined, options: { skipBotMemory?: boolean } = {}) {
    const dmPerson = project?.dm?.people[project.chatId];
    const place: ContextPlace = project?.dm ? { kind: 'dm', person: dmPerson?.name ?? (dmPerson ? names.peek(dmPerson.openId) : undefined), ...(dmPerson ? { openId: dmPerson.openId } : {}) }
      : project ? { kind: 'group', chatId: project.chatId, chatName: project.name } : { kind: 'comment' };
    return loadContextSources({
      appId: cfg.accounts.app.id, botName: channel.botIdentity?.name, place, ...(project ? { row: project } : {}),
      nameOf: openId => names.peek(openId), chatNames: async () => new Map((await listProjects()).map(row => [row.chatId, row.name] as const)), ...(options.skipBotMemory ? { skipBotMemory: true } : {}),
    });
  }
  /** Claude has the memory tools and never hidden blocks (3.4); every other backend is told how to leave a block and gets it parsed. */
  const hiddenBlocksFor = (backendId: string | undefined): boolean => backendFor(backendId).id !== 'claude-agent';
  /**
   * The one mark of a session (4.1): the opening, the update blocks, `<vonvon-mem>` and `<vonvon-remember>` all carry
   * `SessionContext.nonce`. A thread with no context yet (a private chat, a comment) falls back to the per-session value.
   */
  const sessionNonce = (thread: AgentThread): string => contextDelivered.get(thread)?.nonce ?? memoryNonce(thread.sessionId);
  /** Every mark the thread's model may be using (the opening's and earlier redeliveries' too). */
  const sessionNonces = (thread: AgentThread): string[] => {
    const context = contextDelivered.get(thread);
    return context ? acceptedNonces(context) : [memoryNonce(thread.sessionId)];
  };
  /** The context a new session was opened with, by the profile object it was opened from (4.2: the record exists only later). */
  const openings = new WeakMap<object, SessionContext>();
  /** What each live thread has been handed; a resumed thread reads its record on its first turn. */
  const contextDelivered = new WeakMap<AgentThread, SessionContext>();
  const sessionFields = (thread: AgentThread): Pick<SessionRecord, 'context' | 'feedbackToolSessionId' | 'resourceToolSessionId'> => {
    const context = contextDelivered.get(thread);
    return {
      ...(context ? {context} : {}),
      ...(thread.startedWithFeedbackTool ? {feedbackToolSessionId: thread.sessionId} : {}),
      ...(thread.startedWithResourceTools ? {resourceToolSessionId: thread.sessionId} : {}),
    };
  };
  async function profileOf(project: Project | undefined, cwd: string, backend: AgentBackend, permission?: PermissionMode, place?: 'comment', commentedFile?: string) {
    const execution = execOf(project);
    const sources = project || place === 'comment' ? await contextSourcesFor(project) : undefined;
    const assembled = sources ? assemble(sources, project ? 'work' : 'comment') : undefined;
    const nonce = newNonce();
    const skills = project ? await groupSkillProfile({ backend, cwd, directories: execution.workspaces.additional, disabledPaths: project.skills?.disabledPaths }) : undefined;
    // A bound group's and a private chat's sessions get the schedule tools (3.13) and the Feishu read tools (dm-agent 7.2),
    // read-only tier too; a comment's never do.
    const schedule = Boolean(project) && place !== 'comment';
    // A comment's session has the document column, and the edit tool when it is on a docx (7.4); a group's edits in any tier but read-only (7.2).
    const comment = place === 'comment';
    const feishuEdit = comment ? commentedFile === 'docx' : schedule && (permission ?? execution.permission) !== 'qa';
    // The generic tool is a private chat's alone: a group cannot reach other groups or write to Feishu through it (7.6).
    const feishuApi = schedule && Boolean(project?.dm);
    // The task skill goes with the tools (T4b); a package that cannot be written leaves the last whole one, or none.
    const capabilityPackages = schedule && backend.profileCapabilities?.capabilityPackages ? await builtinPackage(project?.chatId, project?.dm ? 'dm' : 'group') : [];
    // What the Feishu tools download must be readable outside full access too.
    const downloads = schedule && project ? inboundChatDir(project.chatId) : undefined;
    if (downloads) await prepareInboundDir(downloads);
    const profile = assembled || skills ? { instructions: assembled ? openingInstructions(assembled, nonce, { hiddenBlocks: Boolean(project) && hiddenBlocksFor(backend.id) }) : '', env: {}, nativeSettings: { automaticMemory: false as const }, additionalRoots: downloads ? [{ path: downloads, access: 'read' as const }] : [], capabilityPackages, mcpServers: [],
      tools: { schedule, ...(schedule && !project?.dm && options?.feedback ? {feedback: true} : {}), feishu: schedule || comment, ...(feishuEdit ? { feishuEdit } : {}), ...(feishuApi ? { feishuApi } : {}), ...(comment ? { documentsOnly: true } : {}), ...(project?.dm ? { acrossBots: true } : {}) }, ...(skills ? { skills } : {}) } : undefined;
    const built = await executionSessionProfile({ execution: { ...execution, permission: permission ?? execution.permission }, cwd, backend: backend.id, scope: project ? 'group' : 'ungrouped', profile });
    if (assembled && built) openings.set(built, contextOf(assembled, nonce));
    return built;
  }
  async function builtinPackage(chatId: string | undefined, set: 'group' | 'dm'): Promise<SessionProfile['capabilityPackages']> {
    try {
      const { path } = await ensureBuiltinPackage(cfg.accounts.app.id, set, builtinSkillsOfSet(set));
      return [{ path, kind: 'builtin' }];
    } catch (error) {
      // A resumed Codex thread still lists the skills from its rollout, so the package already there must stay
      // handed over (and readable); only without a whole one does the session start without the skill.
      const kept = await completeBuiltinPackage(cfg.accounts.app.id, set);
      log.fail('agent', error, { phase: 'builtin-package-failed', chatId, kept: Boolean(kept) });
      return kept ? [{ path: kept, kind: 'builtin' }] : [];
    }
  }
  /** A compaction ended on this thread: the next turn hands over everything again, under a new mark (4.4). */
  function markContextDue(thread: AgentThread, key: string | undefined): void {
    const known = contextDelivered.get(thread);
    if (known) contextDelivered.set(thread, { ...known, fullRedeliverDue: true });
    if (key && !key.startsWith('pending:')) {
      void trackTask(patchSession(key, s => ({ context: { ...(s.context ?? known ?? { versions: {}, nonce: newNonce() }), fullRedeliverDue: true } })).catch(() => undefined));
    }
  }
  /** The memories a thread's turn was assembled from: where the entries the model says it used are counted (4.5). */
  const turnStores = new WeakMap<AgentThread, TurnStores>();
  /** The `<vonvon-mem>` markers the stream filter took out of this turn's reply: the final card text no longer has them. */
  const turnMarks = new WeakMap<AgentThread, RawBlock[]>();
  /** Hidden blocks not taken this turn, kept until the turn's usage is settled (the order of the two is not fixed). */
  const lastMissed = new WeakMap<AgentThread, string[]>();
  /** The end of a turn: which entries the model said it used goes into the session's `lastTurn` and the memory's `usage.json`. */
  function noteTurnUsage(thread: AgentThread, replyText: string, key: string | undefined): void {
    const marks = turnMarks.get(thread);
    turnMarks.delete(thread);
    const delivered = contextDelivered.get(thread);
    if (!delivered) return;
    const { context, used } = settleTurn(delivered, replyText, Date.now(), marks);
    const missed = lastMissed.get(thread);
    lastMissed.delete(thread);
    if (missed?.length && context.lastTurn) context.lastTurn = { ...context.lastTurn, missed };
    contextDelivered.set(thread, { ...delivered, lastTurn: context.lastTurn });
    if (key && !key.startsWith('pending:') && context.lastTurn) {
      // The record may be behind the thread (a turn that ran under a pending key never saved what it was handed): the thread's
      // context wins, except that a compaction marked meanwhile stays marked.
      void trackTask(patchSession(key, s => ({ context: { ...context, ...(s.context?.fullRedeliverDue ? { fullRedeliverDue: true as const } : {}) } })).catch(() => undefined));
    }
    void trackTask(recordUsage(context, used, turnStores.get(thread)));
  }
  async function preparePersonality(thread: AgentThread, chatId: string, input: AgentInput, key?: string, backendId?: string): Promise<AgentInput> {
    const project = await getProjectByChatId(chatId);
    if (!project) return input;
    const persisted = key && !key.startsWith('pending:');
    // A thread resumed from disk has no entry yet: its record says what it got. A record without one is an older session.
    const delivered = contextDelivered.get(thread) ?? (persisted ? (await getSession(key))?.context : undefined);
    const sources = await contextSourcesFor(project);
    const assembled = assemble(sources);
    // What the last turn's hidden blocks could not record goes into this turn's update (3.4); the update carries the entries
    // written since because the sources above are read now, at the start of the turn.
    const update = await planTurnUpdate(sources, assembled, delivered, Date.now(), { notices: takeMemoryNotices(thread.sessionId), hiddenBlocks: hiddenBlocksFor(backendId) });
    contextDelivered.set(thread, update.context);
    turnStores.set(thread, { ...(assembled.cur.bot ? { bot: assembled.cur.bot.store } : {}), ...(assembled.cur.project ? { project: assembled.cur.project.store } : {}), ...(assembled.cur.dm ? { dm: assembled.cur.dm.store } : {}) });
    if (!update.text) return input;
    if (persisted) void trackTask(patchSession(key, { context: update.context }).catch(() => undefined));
    if (thread.injectContext) { await thread.injectContext(update.text); return input; }
    // Claude's system append is frozen on resume; a clearly scoped update accompanies the task.
    return { ...input, text: `${update.text}\n\n${input.text ?? ''}` };
  }
  /** The private-chat row's first creation, which a message in the meantime waits for. */
  let dmReady: Promise<unknown> = Promise.resolve();
  async function pickGroupDefault(project: Project | undefined, backend: AgentBackend, prefer?: ModelPreference) {
    const models = projectModelCatalog(project, backend.id, await listModels(backend));
    if (project?.modelAccess && !models.length) throw new Error('本群没有可用的模型与 Effort 组合，请先在群设置中选择');
    return pickDefault(models, project?.modelAccess ? { ...prefer, custom: false } : prefer);
  }
  /**
   * A private chat has one session and no new topic to change in, so its next turn follows the page (dm-agent 4.1): a model
   * taken off the list moves to the row's default, another Provider starts over there. True in that last case: what the
   * old one holds cannot be resumed.
   */
  async function followDmRow(threadId: string, chatId: string, project: Project): Promise<boolean> {
    const rec = project.modelAccess ? await getSession(threadId) : undefined;
    if (!rec) return false;
    const be = groupBackend(project);
    const moved = rec.backend !== be.id;
    if (!moved && projectModelAllowed(project, be.id, rec.model, rec.effort, await listModels(be))) return false;
    const prefer = modelPrefOf(project, be.id);
    const { model, effort } = await pickGroupDefault(project, be, prefer);
    await patchSession(threadId, { backend: be.id, model, effort, modelCustom: isCustomDefault(prefer, model) });
    if (moved) {
      await evictLiveSessionsForChat(chatId);
      lastUsage.delete(threadId); // a new session: the meter starts over
    }
    return moved;
  }
  /** The group's backend: its own, else Codex; not the bot default (product.md 3.2). */
  function groupBackend(project: Pick<Project, 'backend'> | undefined): AgentBackend {
    return backendFor(groupBackendId(project));
  }
  /** A session runs on its record's backend; a new one on the group's. */
  function sessionBackendOf(rec: Pick<SessionRecord, 'backend'> | undefined, project: Project | undefined): AgentBackend {
    return backendFor(rec?.backend ?? groupBackendId(project));
  }
  /** Where a session of `project` runs: the group's primary workspace (3.3). Without a group,
   * the record's cwd, else fallbackCwd: the bot's own workspace waits for 私聊 (s49). */
  function workCwd(project: Project | undefined, rec?: Pick<SessionRecord, 'cwd'>): string {
    return project ? execOf(project).workspaces.primary ?? project.cwd : rec?.cwd ?? fallbackCwd;
  }
  /** The model a new session on `backendId` starts from: the group's, else the bot's on the same backend. */
  function modelPrefOf(project: Project | undefined, backendId: string): ModelPreference | undefined {
    return resolveModelPreference({ bot: cfg.preferences, group: project }, backendId);
  }

  /** 会话后端是否支持 `/goal` 自治目标（codex caps undefined ⇒ true）：已有会话看记录里的后端。 */
  async function goalCapable(project: Project | undefined, sessionKey?: string): Promise<boolean> {
    const rec = sessionKey ? await getSession(sessionKey).catch(() => undefined) : undefined;
    return sessionBackendOf(rec, project).capabilities?.goal ?? true;
  }

  /** 后端不支持 `/goal` 时的统一回执。关键：在「加 OKR reaction / 起 reserved run」之前
   * 拦截 —— 否则会先贴上 🎯OKR 受理回执、再被能力守卫拒绝，留下一个自相矛盾的假信号
   * （e2e 实测发现）。引导用户直接派活即可。 */
  async function denyGoal(msg: NormalizedMessage, inThread: boolean): Promise<void> {
    await channel
      .send(
        msg.chatId,
        { markdown: '当前后端不支持 `/goal` 自治目标。直接 @我描述任务即可。' },
        { replyTo: msg.messageId, replyInThread: inThread },
      )
      .catch(() => undefined);
  }
  /** The default backend (codex app-server). Call sites that aren't project-
   * routed yet (status card, /usage, models prewarm, resume-picker pick) keep
   * using it directly — identical to the pre-registry behavior. */
  const backend = backendFor();
  const sessionTitles = new SessionTitleCoordinator({ backendFor: (id) => backendFor(id) });
  /** Smart-mode judgements (s23), for groups in 智能 (s25). */
  const judgeUsage = options?.judgeUsageFile ? createJudgeUsage({ file: options.judgeUsageFile }) : undefined;
  const judge = createJudge({ backendFor: (id) => backendFor(id), onResult: (_req, result, call) => {
    if (call.sent) judgeUsage?.add(result);
  } });
  /** What smart groups' judgements read, and how many each group may make in an hour (s25). */
  const recent = new RecentLines();
  const budget = new JudgeBudget();
  const time: IntakeTime = options?.time ?? {
    now: Date.now,
    setTimer: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; },
    clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
  const attention = options?.attention ?? new Attention();
  let attentionTimer: unknown;
  function publishAttention(): void {
    if (attentionTimer !== undefined) time.clearTimer(attentionTimer);
    attentionTimer = undefined;
    if (shuttingDown) return;
    const now = time.now();
    let next = attention.nextExpiryAt() ?? Infinity;
    const groups = attention.snapshot().map(group => {
      const used = budget.used(group.groupId, now);
      if (used < JUDGE_GLANCE_CAP) return group;
      const cap = used >= JUDGE_BUDGET ? JUDGE_BUDGET : JUDGE_GLANCE_CAP;
      const until = budget.freeAt(group.groupId, now, cap);
      next = Math.min(next, until);
      return { ...group, budget: { kind: used >= JUDGE_BUDGET ? 'named-only' as const : 'no-glance' as const, until } };
    });
    reportAttention(groups);
    if (Number.isFinite(next)) attentionTimer = time.setTimer(() => {
      if (shuttingDown) return;
      // Expiry notifies the observer synchronously, which publishes and rearms once.
      // Budget-only deadlines still need a fresh publication when no place expired.
      if (!attention.expire(time.now())) publishAttention();
      smartLanes.rearmWhere(() => true);
    }, Math.max(1, next - now));
  }
  const placeOf = (msg: NormalizedMessage): PlaceRef => ({ chatId: msg.chatId, place: msg.threadId ?? msg.chatId });
  const takenTo = new Map<string, { chatId: string; at: number }>();
  const budgetNotedAt = new Map<string, number>();
  /** The lines a smart topic is being opened under, until its start ends (s25b): neither the registry nor Feishu
   * knows that topic yet, so a second judgement naming one meanwhile opens on its own message. */
  const openingUnder = new Set<string>();

  /** Snapshot the Bot-wide title provider, independently of the native session provider. */
  function sessionTitlePolicy(): SessionTitlePolicySnapshot {
    const selected = getSessionTitleConfig(cfg);
    return selected.enabled
      ? { strategy: 'model', backend: selected.backend, model: selected.model, effort: selected.effort }
      : { strategy: 'truncate' };
  }

  /** Title bookkeeping is auxiliary: disk/backend failures never block the
   * user's main conversation. */
  async function registerSessionTitle(
    be: AgentBackend,
    sessionId: string,
    cwd: string,
    source?: SessionTitleSource,
  ): Promise<string | undefined> {
    try {
      return await sessionTitles.register({
        backend: be.id,
        sessionId,
        cwd,
        source,
        policy: sessionTitlePolicy(),
      });
    } catch (err) {
      log.fail('agent', err, { phase: 'session-title-register', backend: be.id, sessionId });
      return undefined;
    }
  }

  async function attachSessionTitleSource(
    backendId: string,
    sessionId: string,
    source: SessionTitleSource,
  ): Promise<string | undefined> {
    const key = sessionTitleJobKey(backendId, sessionId);
    try {
      return (await sessionTitles.attachSource(key, source)) ? key : undefined;
    } catch (err) {
      log.fail('agent', err, { phase: 'session-title-attach', backend: backendId, sessionId });
      return undefined;
    }
  }
  /** 后端 id → 展示名（项目设置卡）。手编 projects.json 写了未知 id 时原样显示。 */
  const backendDisplayName = (id?: string): string => {
    try {
      return backendLabel(backendFor(id));
    } catch {
      return id ?? DEFAULT_BACKEND_ID;
    }
  };
  const sessions = new Map<string, AgentThread>();
  const threadPermissions = new WeakMap<AgentThread, string>();
  class ThreadPermissionChanged extends Error {}
  const DM_CLOSED = '你已经不是这个 Bot 的管理员，这一轮没有开始。';
  function permissionFingerprint(opts: Pick<StartThreadOptions, 'mode' | 'network' | 'native' | 'readScope'>): string {
    const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
      : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
    return JSON.stringify(stable({mode: opts.mode ?? 'full', network: opts.network ?? false, native: opts.native ?? null, readScope: opts.readScope ?? null}));
  }
  async function closeForPermission(thread: AgentThread): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = thread.close();
    void trackTask(closing.catch(error => log.fail('agent', error, {phase: 'thread-close'})));
    try {
      await Promise.race([closing, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ThreadPermissionChanged('旧权限会话还没关闭，请稍后重试。')), RELEASE_WAIT_MS); })]);
    } catch (error) {
      if (error instanceof ThreadPermissionChanged) throw error;
      throw new ThreadPermissionChanged('旧权限会话没能关闭，请稍后重试。', {cause: error});
    } finally { clearTimeout(timer); }
  }
  /**
   * The token a new session's `vonvon` commands carry (devices 5.3), in place of the bare marker, and beside it the
   * `--scope` its command line copies: a group's reach is its group, a comment's the bot. A private chat has one reach
   * and needs no `--scope` (dm-agent 6.1); it sees every Bot, so its command line is told which one is its own.
   */
  async function sessionEnv(api: Pick<HostApi, 'issueSessionToken'>, sessionId: string, place: AgentPlace): Promise<Record<string, string>> {
    const chatId = place.kind !== 'doc' && place.chatId ? place.chatId : undefined;
    const token = await api.issueSessionToken({
      appId: cfg.accounts.app.id, place: place.kind === 'p2p' ? 'dm' : place.kind === 'group' ? 'group' : 'comment', sessionId,
      ...(chatId ? { chatId } : {}),
    });
    return place.kind === 'p2p' ? { [SESSION_ENV]: token, [SESSION_BOT_ENV]: cfg.accounts.app.id } : { [SESSION_ENV]: token, [SESSION_SCOPE_ENV]: sessionScope(cfg.accounts.app.id, place.kind === 'group' ? chatId : undefined) };
  }
  /** Where a session of `chatId` runs: a private chat's row answers for a real p2p chat, so its token and its tools are a private chat's. */
  const sessionPlace = (project: Project | undefined, chatId: string): AgentPlace => ({ kind: project?.dm ? 'p2p' : 'group', chatId });
  /** Whether the person of a private chat is still on the list. Asked where a turn or a session starts: the list can change while one is on its way (dm-agent 3.3). */
  const dmOpen = (project: Project): boolean => isAdmin(cfg, project.dm?.people[project.chatId]?.openId ?? '');
  /** Who a private chat's task runs as (dm-agent 6.3): its creator, or when this Bot has no open_id for them (the desktop, another Bot's private chat) the chat's person. */
  const dmRunner = (task: Pick<StoredTask, 'createdBy'>, project: Project): string => task.createdBy.openId ?? dmPersonOf(project, project.chatId)?.openId ?? '';
  /** The profile a thread was actually started with: a permission save can swap in a rebuilt one (and its opening). */
  const profileUsed = new WeakMap<AgentThread, object>();
  /** A save can finish while a provider is starting, before eviction can see its thread. */
  async function createWithPermission<T extends StartThreadOptions>(be: AgentBackend, original: T, place: AgentPlace, create: (opts: T) => Promise<AgentThread>): Promise<AgentThread> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let opts = original;
      const project = place.kind !== 'doc' && place.chatId ? await getProjectByChatId(place.chatId) : undefined;
      if (project?.dm && !dmOpen(project)) throw new ThreadPermissionChanged(DM_CLOSED);
      if (project) {
        const perm = turnPerm(project);
        if (permissionFingerprint(opts) !== permissionFingerprint(perm))
          opts = {...opts, ...perm, native: perm.native, readScope: perm.readScope, profile: await profileOf(project, opts.cwd, be, perm.mode)};
      }
      const entry = entries?.issue(place);
      let thread: AgentThread;
      try {
        // devices 5.3: the session's shell gets its token, never the bare marker; no token, no session (the host is gone).
        const session = entry && host ? await sessionEnv(host, entry.sessionId, place) : undefined;
        // Every session finds `vonvon`, whichever Provider and place (dm-agent 9): on the PATH it inherits, or by this.
        const env = { ...(sessionCli ? { [SESSION_CLI_ENV]: sessionCli } : {}), ...session };
        thread = await create({...opts, ...(entry ? {entry} : {}), ...(Object.keys(env).length ? {profile: withSessionEnv(opts.profile, env)} : {})});
        entry?.attach(thread);
      }
      catch (error) { entry?.revoke('start-failed'); throw error; }
      if (opts.profile) profileUsed.set(thread, opts.profile);
      const fingerprint = permissionFingerprint(opts);
      threadPermissions.set(thread, fingerprint);
      let current: Project | undefined;
      try { current = place.kind !== 'doc' && place.chatId ? await getProjectByChatId(place.chatId) : undefined; }
      catch (error) { entry?.revoke('start-failed'); await closeForPermission(thread); throw error; }
      if (current?.dm && !dmOpen(current)) {
        entry?.revoke('closed');
        await closeForPermission(thread);
        throw new ThreadPermissionChanged(DM_CLOSED);
      }
      if (!current || permissionFingerprint(turnPerm(current)) === fingerprint) return thread;
      entry?.revoke('closed');
      await closeForPermission(thread);
    }
    throw new ThreadPermissionChanged('群的权限在准备会话时变了，请重新发一次。');
  }
  /** M-3 空闲 reaper 的轮次时钟：每次进 LIVE 缓存（trackSession）/ 每轮收尾
   * （touchSession）打点；空闲时长 = now − 最后打点。 */
  const sessionTouchedAt = new Map<string, number>();
  const historicalSessionsRoot = () => join(paths.appDir, 'bots', cfg.accounts.app.id);
  async function scopedThreads(be: AgentBackend, chatId: string, cwd: string, limit?: number) {
    const threads = await be.listThreads(cwd, limit);
    const scoped = await Promise.all(threads.map(async thread => {
      const owner = await managedThreadOwner(historicalSessionsRoot(), thread.sessionId);
      if (!owner) return thread;
      if (owner.slot === recipeSlot(cfg.accounts.app.id, chatId)) return {...thread, sessionId: owner.alias};
    }));
    return scoped.filter(thread => thread !== undefined);
  }
  async function scopedHistory(be: AgentBackend, chatId: string, cwd: string, id: string) {
    const nativeId = await recipeHistoryId(historicalSessionsRoot(), id, recipeSlot(cfg.accounts.app.id, chatId));
    return be.readHistory(cwd, nativeId);
  }
  async function startWith(be: AgentBackend, opts: StartThreadOptions, place: AgentPlace): Promise<AgentThread> {
    const thread = await createWithPermission(be, opts, place, actual => be.startThread(actual));
    const used = profileUsed.get(thread);
    const opening = used ? openings.get(used) : undefined;
    if (opening) contextDelivered.set(thread, opening);
    return thread;
  }
  async function resumeWith(be: AgentBackend, opts: ResumeThreadOptions, place: AgentPlace): Promise<AgentThread> {
    if (place.kind === 'group') {
      // Experimental sessions retain their original capability roots. Their topic gets a fresh ordinary session.
      if (isRecipeSession(opts.sessionId)) {
        const {sessionId: _old, ...fresh} = opts;
        return startWith(be, fresh, place);
      }
      if (await managedThreadOwner(historicalSessionsRoot(), opts.sessionId))
        throw new ThreadPermissionChanged('请使用本群的历史会话入口。');
    }
    return createWithPermission(be, opts, place, actual => be.resumeThread(actual));
  }

  /**
   * 助手正文里的隐藏块（记忆设计 §3.4）：所有出口都剥；只有群和私聊里普通的一轮、会话用的是 Codex（Claude 有工具，不认隐藏块）
   * 时，才在 `done` 之前解析最后一条消息里的块。评论里不解析（`applyBlocks` 里按位置再关一道）。
   */
  function hiddenBlockFilter(thread: AgentThread, backendId: string | undefined, turn: TurnMemory | undefined, recordKey: () => string | undefined = () => undefined) {
    const parse = memory && turn && turn.place.kind !== 'doc' && hiddenBlocksFor(backendId);
    turnMarks.delete(thread);
    return createHiddenBlockFilter({
      onTurnEnd: async found => {
        // Usage markers are read for every backend, whatever the blocks do: the text the card ends with no longer has them.
        if (found.mem.length) turnMarks.set(thread, found.mem);
        if (parse) await applyHiddenBlocks(thread, turn, found, recordKey());
      },
    });
  }
  async function applyHiddenBlocks(thread: AgentThread, turn: TurnMemory, found: FoundBlocks, recordKey?: string): Promise<void> {
    if (!memory) return;
    const key = thread.sessionId;
    const current = sessionNonce(thread);
    const accepted = sessionNonces(thread);
    // A block under any mark this session was given counts as the current one (a compaction does not unsay the opening).
    const normalized: FoundBlocks = { ...found, remember: found.remember.map(block => (block.attrs.n !== undefined && accepted.includes(block.attrs.n) ? { ...block, attrs: { ...block.attrs, n: current } } : block)) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 写不进去也不拖住这一轮的收尾；超时以后轮次一结束，提交点前的重判会把这次写入拒掉
      const outcome = await Promise.race([
        memory.applyBlocks({ found: normalized, nonce: current, ctx: { turn: turn.turn, ...(turn.triggerMessageId ? { triggerMessageId: turn.triggerMessageId } : {}) } }),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 15_000); timer.unref?.(); }),
      ]);
      if (outcome) {
        noteMissedBlocks(key, outcome.missed);
        // The turn's usage may already be settled: its `lastTurn` gets the reasons too (taken here, not left for the next turn).
        const reasons = takeLastMissed(key);
        if (reasons.length && recordKey && !recordKey.startsWith('pending:')) {
          void trackTask(patchSession(recordKey, s => (s.context?.lastTurn ? { context: { ...s.context, lastTurn: { ...s.context.lastTurn, missed: reasons } } } : {})).catch(() => undefined));
          lastMissed.set(thread, reasons);
        }
      }
      else log.warn('memory', 'hidden-block-timeout', {});
    } catch (error) {
      log.fail('memory.hidden-block', error, {});
    } finally { clearTimeout(timer); }
  }

  function trackSession(key: string, thread: AgentThread): void {
    if (shuttingDown) {
      void trackTask(thread.close());
      return;
    }
    sessions.set(key, thread);
    sessionTouchedAt.set(key, Date.now());
  }
  /** 轮次收尾打点：刷新会话的空闲时钟（不在 LIVE 缓存则忽略）。 */
  function touchSession(key: string): void {
    if (sessions.has(key)) sessionTouchedAt.set(key, Date.now());
  }
  /**
   * Let a Codex session go once nothing holds its key (s15b, product.md 3.5 D6): only closing
   * the app-server lets go of the thread, so a terminal or the Codex app can open it between
   * turns. The next turn resumes it from disk, which costs 0.24 to 0.37 s on JP-VPS with a
   * warm process (measured 2026-10-16). A run, a /compact or a /new holding the key keeps it.
   * `always`: any backend's, for a scheduled run's hidden topic nobody joined (T2 4.1 第 6 条).
   */
  function releaseIdle(key: string | undefined, thread: AgentThread | undefined, always = false): void {
    if (!key || !thread || !(always || thread.releaseAfterRun) || active.has(key) || sessions.get(key) !== thread) return;
    sessions.delete(key);
    sessionTouchedAt.delete(key);
    const closed = thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' }));
    releasing.set(key, closed);
    void trackTask(closed.finally(() => { if (releasing.get(key) === closed) releasing.delete(key); }));
    log.info('agent', 'session-release', { threadId: key });
  }
  /** Releases still closing, by key: the next resume waits for its own process to let go of the writer. */
  const releasing = new Map<string, Promise<void>>();
  /** Wait for a release of `key` still closing. Bounded: close() escalates to SIGKILL after 4 s,
   * so the limit only guards a close that never settles. */
  async function waitReleased(key: string): Promise<void> {
    const closing = releasing.get(key);
    if (!closing) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([closing, new Promise<void>((r) => { timer = setTimeout(r, RELEASE_WAIT_MS); })]);
    clearTimeout(timer);
  }
  const active = new Map<string, ActiveState>();
  /** Per-doc serialization for comment runs (see {@link withDocLock}). */
  const docLocks = new Map<string, Promise<void>>();
  /** Comment session → the instructions content its LIVE thread was created/resumed
   * with. A live thread reads AGENTS.md/CLAUDE.md only at start/resume, so when the
   * user edits the master prompt mid-thread we must evict the live thread to make the
   * edit take effect (see resolveDocThread). Cleared alongside the session. */
  const commentInstrUsed = new Map<string, string>();
  const sema = new Semaphore(getMaxConcurrentRuns(cfg));
  let shuttingDown = false;
  attention.observe(publishAttention);
  let shutdownPromise: Promise<void> | undefined;
  /** Why the shutdown came, read as each cut-short turn's card is written (the host's message may come after its SIGTERM). */
  let shutdownReason: () => StopReason = () => 'stop';
  /**
   * The people's turns a shutdown cut short (owner 2026-11-02), by trigger message: each card says so and asks for the
   * message again; one whose card is not confirmed when the shutdown stops waiting goes to dropped.json, so its sender
   * hears once the bot is back.
   */
  const cutShort = new Map<string, DroppedOrigin>();
  /**
   * What this shutdown settled for each person's message, by id: saved as it began (collectLost), appended later
   * (keepForResend), or answered by its card. A message is kept once however many paths reach it, its preparation ending
   * after the drain, say (review 260); an appended one a late card answers leaves dropped.json again (review 259).
   */
  const resendKept = new Map<string, 'saved' | 'appended' | 'answered'>();
  const interruptGraceMs = options?.shutdownTiming?.interruptGraceMs ?? SHUTDOWN_INTERRUPT_GRACE_MS;
  const shutdownDrainMs = options?.shutdownTiming?.drainMs ?? SHUTDOWN_DRAIN_MS;
  const droppedReplies = options?.droppedFile ? createDroppedReplies({
    appId: cfg.accounts.app.id, file: options.droppedFile, log,
    // The raw API, not channel.send: with the message gone, that sends a new one to the main area instead.
    reply: async (entry, text, uuid) => {
      const body = await channel.rawClient.im.v1.message.reply({
        path: { message_id: entry.messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: entry.replyInThread, uuid },
      });
      // The SDK resolves a 2xx with Feishu's error code in it.
      if (body?.code !== 0) throw Object.assign(new Error(`Feishu did not take the reply (code ${String(body?.code)})`), { code: body?.code, msg: body?.msg });
    },
    report: (entry, times, detail, scope) => {
      if (scope) reportScopeDenied(scope, 'send');
      reportNotReplied({ at: entry.at, groupId: entry.chatId, place: entry.place, reason: 'restarted', ref: entry.messageId.slice(-6), ...(detail ? { detail } : {}) }, times);
    },
  }) : undefined;
  const onStop = new Set<() => void>();
  /** `p`, or `fallback` once shutdown starts: shutdown does not wait on a back-fill's Feishu calls. */
  function orStop<T>(p: Promise<T>, fallback: T): Promise<T> {
    if (shuttingDown) return Promise.resolve(fallback);
    let stop!: () => void;
    const stopped = new Promise<T>((resolve) => { stop = () => resolve(fallback); });
    onStop.add(stop);
    return Promise.race([p, stopped]).finally(() => onStop.delete(stop));
  }
  /** s27a0: no card or markdown post of this bot carries a real `<at>` of a bot; the chat's bot list is read on the
   * first `<at>` there (D/card/at-guard.ts). Rule groups too: a rule bot's card wakes a smart bot just the same. */
  const roster = createBotRoster(channel, { stop: orStop });
  const people = createChatPeople(channel, { stop: orStop });
  installAtGuard(channel, roster);
  const acceptedTasks = new Set<Promise<unknown>>();
  const shutdownErrors = new Set<unknown>();

  function trackTask<T>(task: Promise<T>): Promise<T> {
    acceptedTasks.add(task);
    void task.then(() => acceptedTasks.delete(task), error => {
      acceptedTasks.delete(task);
      if (shuttingDown) shutdownErrors.add(error);
      else log.fail('bridge', error, { phase: 'background-task' });
    });
    return task;
  }

  function admit<Args extends unknown[], Result>(handler: (...args: Args) => Promise<Result>): (...args: Args) => Promise<Result> {
    return (...args) => {
      if (shuttingDown) return Promise.reject(new Error('Bridge is shutting down'));
      return trackTask(handler(...args));
    };
  }

  function admitEvent<Args extends unknown[]>(handler: (...args: Args) => Promise<void> | void): (...args: Args) => Promise<void> {
    return (...args) => {
      if (shuttingDown) return Promise.resolve();
      return trackTask(Promise.resolve(handler(...args)));
    };
  }
  const runTasks = new Set<Promise<void>>();
  async function trackRun(task: Promise<void>): Promise<void> {
    runTasks.add(task);
    try { await task; } finally { runTasks.delete(task); }
  }
  // Read live per run (not frozen at startup) so the settings card's change to
  // the idle timeout applies immediately to every group/thread — no daemon
  // restart. `cfg` is the same object `applyPref` mutates, so this sees edits.
  const currentIdleMs = (): number => getRunIdleTimeoutMs(cfg) ?? 0;
  // One queue for every DM/Web mutation of this bot's preferences. Each write
  // reads the latest committed LIVE snapshot, persists its own next snapshot,
  // then commits it to LIVE — concurrent clicks cannot erase one another.
  const writePreferences = createAppPreferencesWriter({ cfg });
  const voice = createVoiceService(cfg, writePreferences);
  const voiceMessages = new VoiceMessages();
  // A known transcript remains text when Feishu later returns the audio in
  // a quote, topic opening or history backfill. Read access still goes through
  // the ordinary fetch, so a missing/deleted message is never resurrected.
  const fetchQuotedMessage: typeof pullQuotedMessage = async (...args) => {
    const message = await pullQuotedMessage(...args);
    return message ? voiceMessages.context(message) : message;
  };
  const fetchThreadContext: typeof pullThreadContext = async (...args) => {
    const pulled = await pullThreadContext(...args);
    return { ...pulled, messages: pulled.messages.map(message => voiceMessages.context(message)) };
  };
  const fetchChatContext: typeof pullChatContext = async (...args) => {
    const pulled = await pullChatContext(...args);
    return { ...pulled, messages: pulled.messages.map(message => voiceMessages.context(message)) };
  };
  const orderContext = createIntakeQueue();
  const orderTurns = createIntakeQueue();
  // pendingPolicy is read per-message (settings card can change it live)
  /** pending /resume cards, keyed by the card's messageId */
  const resumePending = new Map<string, ResumeCardState>();
  /** pending /model cards, keyed by the card's messageId */
  const modelPending = new Map<string, ModelCardState>();
  /** active runs indexed by their run card's messageId (for ⏹ 中止) */
  const runsByCard = new Map<string, ActiveState>();
  /** latest run-card state by messageId (to demote a previous turn's card) */
  const runCards = new Map<string, RunCardState>();
  /** [重试] targets by terminal card messageId. In memory only; a session keeps
   * at most its newest one, and any input that session accepts drops it. */
  const retryTurns = new Map<string, RetryTurn>();
  /** Cards whose [重试] tap is being handled: a second tap must not queue twice. */
  const retrying = new Set<string>();
  /** Every removal goes through here: a tap in flight keeps its own reference
   * to the record, so it learns from `expired`, not from the map. */
  const expireRetry = (cardId: string): void => {
    const retry = retryTurns.get(cardId);
    if (retry) retry.expired = true;
    retryTurns.delete(cardId);
  };
  const expireRetries = (match: (retry: RetryTurn) => boolean): void => {
    for (const [cardId, retry] of retryTurns) if (match(retry)) expireRetry(cardId);
  };
  /** The session took input (a run reserved, a follow-up queued, a steer sent,
   * a /goal started) or swapped its thread (/clear, /resume): replaying its
   * [重试] now would land after that, or in another conversation. */
  const dropRetries = (sessionKey: string | undefined): void => {
    if (sessionKey) expireRetries((retry) => retry.sessionKey === sessionKey);
  };
  /** CardKit entity backing each run card, by messageId — drives the native
   * typewriter stream and whole-card (button/settings) updates. */
  const runStreams = new Map<string, RunCardStream>();
  /** Live manual-reminder card repaint, keyed like runsByCard. The closure is
   * swapped when a queue placeholder flips into a run card, so a double click
   * can only mutate the one current turn and never an older/future card. */
  const completionReminderRefreshers = new Map<string, () => void>();
  /** Repaint every live queue/run card after the global mode changes. This makes
   * the product rule immediate: manual shows the one-shot button; every other
   * mode removes it without waiting for the agent's next streamed event. */
  const refreshCompletionReminderCards = (): void => {
    for (const refresh of completionReminderRefreshers.values()) refresh();
  };
  /** Network attempts are marked before awaiting Feishu: one terminal card can
   * never produce duplicate reminder replies, even if a surrounding cleanup or
   * callback path is re-entered. */
  const completionReminderSent = new RecentIdCache(4096, 24 * 60 * 60_000);
  /** the latest settings-bearing run card per topic thread */
  const lastRunCard = new Map<string, string>();
  /** latest context usage per session (sessionKey → tokens), for `/context` and
   * the next turn's meter. Fed from the run card's usage in the run loop; keyed
   * like topicThreadId. */
  const lastUsage = new Map<string, { used: number; window: number | null }>();
  /** inbound message/comment dedup (at-least-once delivery, see RecentIdCache) */
  const seenInbound = new RecentIdCache();
  /** The main-area copy of a reply sent with 「同时发送到群」 (s14d). */
  const syncCopy = createSyncCopyGate(channel);
  /** Messages recalled in this process (s15), oldest first: one whose recall came
   * first is not run. Kept {@link RECALLED_TTL_MS}, at most {@link RECALLED_MAX}. */
  const recalled = new Map<string, number>();
  function noteRecalled(id: string): void {
    const now = Date.now();
    recalled.delete(id);
    recalled.set(id, now);
    for (const [old, at] of recalled) {
      if (recalled.size <= RECALLED_MAX && now - at < RECALLED_TTL_MS) break;
      recalled.delete(old);
    }
  }
  /** Real names for this bot's open_ids (open_id is per app, so per orchestrator). */
  const names = createNameBook(channel);

  /** Record that a message reached the session (see session-store.nextSeen).
   * Fire-and-forget like every watermark write; the function form keeps
   * concurrent marks from overwriting each other. A turn's start also drops
   * the recall notes it said, adds one for a trigger recalled meanwhile and
   * moves `from` to an opening's oldest line (s15). */
  function markSeen(sessionKey: string, mark: SeenMark | undefined, how: SeenHow = 'id', streaming?: SeenMark[], extra: SeenMark[] = [],
    also: { recallsShown?: string[]; from?: number; late?: RecallNote } = {}): void {
    // The 引用行 its block carried, by topic id, in the same write (s14b).
    const next = (rec: SessionRecord): Partial<SessionRecord> => {
      let patch: Partial<SessionRecord> = mark ? nextSeen(rec, mark, how, streaming) : {};
      for (const x of extra) patch = { ...patch, ...nextSeen({ ...rec, ...patch }, x, 'id') };
      if (also.from) patch.from = Math.max(rec.from ?? 0, also.from);
      if (also.recallsShown?.length || also.late) {
        const left = (rec.recalls ?? []).filter((r) => !also.recallsShown?.includes(r.id));
        patch.recalls = also.late ? addRecall(left, also.late) : left;
      }
      return patch;
    };
    void trackTask(patchSession(sessionKey, next).catch(() => undefined));
  }
  /** Take back an `id` mark whose message did not reach the session after all. */
  function unmarkSeen(sessionKey: string, id: string): void {
    void trackTask(patchSession(sessionKey, (rec) => ({ seen: (rec.seen ?? []).filter((s) => s.id !== id) })).catch(() => undefined));
  }

  function topicPerson(kind: 'user' | 'bot', openId: string | undefined): TopicPerson {
    return openId ? { kind, openId } : { kind };
  }
  function askRequesterKind(msg: NormalizedMessage): 'user' | 'bot' | 'unknown' {
    if (fromBot(msg)) return 'bot';
    const senderType = rawSender(msg)?.sender_type;
    return senderType === 'user' ? 'user' : 'unknown';
  }
  function typedCandidate(msg: NormalizedMessage): boolean {
    return (msg.rawContentType === 'text' || msg.rawContentType === 'post') && msg.content.trim().length > 0
      && !messageHasImages(msg) && !messageHasFiles(msg)
      && !msg.mentionAll && !msg.mentions.some((m) => !m.isBot);
  }
  /** A turn's trigger for the memory write rules; none for a bot's message or a retry (neither is a person typing). */
  function memoryTriggerOf(msg: NormalizedMessage, extra: Partial<Pick<TurnExtra, 'replayText' | 'wake' | 'initiative' | 'scheduled'>> | undefined): { memoryTrigger?: MemoryTrigger } {
    if (fromBot(msg) || extra?.replayText !== undefined || extra?.scheduled) return {};
    return { memoryTrigger: { typed: typedCandidate(msg), text: msg.content.trim() } };
  }
  /** Who sent a message, as the topic registry records it. */
  function senderOf(msg: NormalizedMessage): TopicPerson {
    return topicPerson(fromBot(msg) ? 'bot' : 'user', msg.senderId);
  }
  /** First messages looked up for the registry in this process (at most once each). */
  const rootLookups = new Set<string>();
  /** Record a topic message of a bound group in the topic registry, addressed
   * to the bot or not. Fire-and-forget: the registry logs its own failures and
   * never touches the turn. A topic first seen through a reply in it gets its
   * first message (sender, time, title) from one `message.get`. */
  function noteTopicMessage(msg: NormalizedMessage): void {
    if (!topics || !msg.threadId) return;
    const from = senderOf(msg);
    // A topic group's post names no root and replies to nothing. A reply that
    // lacks root_id says nothing about the first message; a later one fills it.
    const isFirst = msg.rootId === msg.messageId || (!msg.rootId && !msg.replyToMessageId);
    const sighting: TopicSighting = {
      topicId: msg.threadId,
      at: msg.createTime || Date.now(),
      from,
      ...(isFirst
        ? { first: { id: msg.messageId, from, at: msg.createTime || undefined, text: msg.content } }
        : msg.rootId ? { first: { id: msg.rootId } } : {}),
    };
    const fail = (err: unknown) => log.fail('intake', err, { phase: 'topic-registry' });
    void trackTask(topics.note(msg.chatId, sighting).then((rec) => {
      if (!rec?.firstId || rec.firstFrom || rootLookups.has(rec.firstId) || shuttingDown) return;
      if (rootLookups.size >= 1000) rootLookups.clear();
      const firstId = rec.firstId;
      rootLookups.add(firstId);
      // Shutdown waits for the writes, never for Feishu: the lookup can outlast
      // the supervisor's 8 s grace. One lost to a stop is retried next start.
      void withDeadline(fetchQuotedMessage(channel, firstId, names), 10_000, 'topic-root').then((root) => {
        if (!root || shuttingDown) return;
        const rootFrom: TopicPerson = root.from === 'self' ? { kind: 'self' } : topicPerson(root.from, root.senderId);
        void trackTask(topics.note(msg.chatId, { ...sighting, first: { id: firstId, from: rootFrom, at: root.createTime || undefined, text: root.text } }));
      }).catch(fail);
    }).catch(fail));
  }
  /** This bot opened `topicId` (a reply in thread, or a resumed session's topic). */
  function noteOpenedTopic(chatId: string, topicId: string, first: TopicSighting['first'], accepted?: AttentionAcceptance): void {
    accepted?.opened(topicId);
    smartLanes.rearm(topicId);
    if (topics) void trackTask(topics.note(chatId, { topicId, at: Date.now(), from: { kind: 'self' }, first }));
  }
  /** The session's last meter reading: in memory, else the one saved with its
   * record while the record still points at this native session (s13). */
  function meterOf(key: string | undefined, rec: SessionRecord | undefined, thread: AgentThread): { used: number; window: number | null } | undefined {
    if (!key) return undefined;
    const live = lastUsage.get(key);
    if (live) return live;
    const saved = rec?.usage;
    return saved?.sessionId === thread.sessionId ? { used: saved.used, window: saved.window } : undefined;
  }
  /** The meter reading saved with the record at the end of a turn. */
  function savedMeter(key: string, thread: AgentThread): Pick<SessionRecord, 'usage'> {
    const u = lastUsage.get(key);
    return u ? { usage: { sessionId: thread.sessionId, used: u.used, window: u.window } } : {};
  }

  /** A message this session already took in, as a turn or as a line of a
   * record block, is skipped. Feishu re-pushes messages sent while the bot was
   * offline, minutes late (e10), and does not keep events in order: a message's
   * own event can come in seconds after a later message's back-fill carried it.
   * So every message pays for the disk read, not only late ones. */
  async function alreadySeen(msg: NormalizedMessage, sessionKey: string): Promise<boolean> {
    if (!msg.createTime) return false;
    const rec = await getSession(sessionKey).catch(() => undefined);
    const taken = isSeen(rec, msg.messageId, msg.createTime);
    if (taken) log.info('intake', 'late-redelivery-skipped', { msgId: msg.messageId, lateMs: deliveryLagMs(msg) });
    return taken;
  }

  /** A main @ in a multi group that Feishu re-pushed after a restart, when the
   * bot already opened its topic: not opened again. Re-pushes come minutes late (e10). */
  async function reopenedTopic(msg: NormalizedMessage): Promise<boolean> {
    if (!topics || deliveryLagMs(msg) < 60_000) return false;
    const hit = (await topics.list(msg.chatId)).some((t) => t.firstId === msg.messageId && t.openedBy?.kind === 'self');
    if (hit) log.info('intake', 'late-redelivery-skipped', { msgId: msg.messageId, lateMs: deliveryLagMs(msg), reopen: true });
    return hit;
  }

  const topicCtx = createTopicContext(channel, topics, names,
    { stopping: () => shuttingDown, track: trackTask, localBots: () => localBots(cfg.accounts.app.id) });
  const knownIds = (list: TopicView[]) => new Set(list.map((t) => t.topicId));
  /** Who sent a message, as a record block's pointer names them. */
  const senderWho = (msg: NormalizedMessage): Who => ({ kind: senderOf(msg).kind, name: names.peek(msg.senderId) ?? msg.senderName });
  /** Recall notes as a record block's 〔撤回〕 lines (s15). */
  const recallLines = (notes: RecallNote[]): NonNullable<RecordBlock['recalls']> =>
    notes.map((r) => ({ at: r.at, who: personOf(r.who, names), ...(r.other ? { other: true } : {}) }));
  const isMainKey = (key: string, chatId: string) => key === chatId;
  /** Main sessions that compacted, by key: the native session id, '' once the
   * table was shown (in memory first, then SessionRecord.topicsDue). */
  const topicsDue = new Map<string, string>();
  function setTopicsDue(key: string, sessionId: string): void {
    topicsDue.set(key, sessionId);
    void trackTask(patchSession(key, { topicsDue: sessionId }).catch(() => undefined));
  }
  function markTopicsDue(key: string | undefined, chatId: string, sessionId: string): void {
    if (!key || !isMainKey(key, chatId)) return;
    setTopicsDue(key, sessionId);
    ownCompacted.add(key);
  }
  /** Main sessions the bot saw compact since their last {@link noteCompaction}. */
  const ownCompacted = new Set<string>();
  function topicsDueFor(key: string, chatId: string, rec: SessionRecord | undefined, sessionId: string): boolean {
    return isMainKey(key, chatId) && (topicsDue.get(key) ?? rec?.topicsDue) === sessionId;
  }
  /** Main sessions' newest compaction seen, by key (in memory first, then SessionRecord.compactSeen). */
  const compactSeen = new Map<string, string>();
  /**
   * A main session about to speak compacted since the daemon last looked, whoever compacted
   * it: the table is due (s15b, product.md 3.5 D4). The bot's own compactions were marked
   * when it saw them; seen here again, they mark the same session once more, which is the same.
   */
  function noteCompaction(key: string, chatId: string, thread: AgentThread, rec: SessionRecord | undefined): void {
    const id = thread.lastCompaction;
    // The bot's own compaction whose table a queued turn of the same run already showed:
    // only remember it. A terminal compaction right after such a run is missed (rare).
    const shown = ownCompacted.delete(key) && topicsDue.get(key) === '';
    if (!id || !isMainKey(key, chatId) || (compactSeen.get(key) ?? rec?.compactSeen) === id) return;
    compactSeen.set(key, id);
    if (shown) {
      void trackTask(patchSession(key, { compactSeen: id }).catch(() => undefined));
      return;
    }
    topicsDue.set(key, thread.sessionId);
    void trackTask(patchSession(key, { topicsDue: thread.sessionId, compactSeen: id }).catch(() => undefined));
    log.info('agent', 'native-compaction', { threadId: key, sessionId: thread.sessionId });
  }

  /** Render the one-shot affordance only while the current global mode is
   * manual. Non-manual modes return undefined, so their cards have no button;
   * neither has a scheduled turn's, which has nobody to remind. */
  const completionReminderView = (state: ActiveState): 'available' | 'requested' | undefined =>
    reminderButtonOffered(state.presentation ?? cfg, state) && !state.scheduled
      ? state.completionReminderRequested
        ? 'requested'
        : 'available'
      : undefined;

  /** 模型列表直通后端：两个后端内部都已缓存成功结果（codex 的 modelCache、
   * claude 的静态常量），这层不再缓存——codex 瞬时不可用时返回的 STATIC_MODELS
   * 兜底一旦缓存在这层，会被钉死整个 daemon 生命周期（backend 故意不缓存失败
   * 结果，让下次调用重试；见 codex-appserver/backend.listModels）。 */
  const listModels = (be: AgentBackend = backend): Promise<ModelInfo[]> => be.listModels();
  const listModelsAt = (be: AgentBackend, cwd?: string): Promise<ModelInfo[]> =>
    cwd && be.listModelsForCwd ? be.listModelsForCwd(cwd) : listModels(be);
  /** A saved acceleration is usable only while the live catalog confirms it.
   * Discovery failures use ordinary speed for this request, but only a confirmed
   * catalog change clears the saved preference. */
  const reconcileStoredSpeed = async (be: AgentBackend, threadId: string | undefined, cwd: string, model: string | undefined, tier: ServiceTier | undefined): Promise<ServiceTier> => {
    if (!tier || tier === 'standard') return 'standard';
    if (be.id !== 'codex-appserver') return 'standard';
    const session = threadId ? await getSession(threadId) : undefined;
    const project = session?.chatId ? await getProjectByChatId(session.chatId) : undefined;
    if (!projectSpeedAllowed(project, model, tier)) return 'standard';
    const contextual = be.listModelsForCwd
      ? await be.listModelsForCwd(cwd).catch(() => undefined)
      : await listModels(be).catch(() => undefined);
    if (!contextual) return 'standard';
    const confirmed = be.peekModels?.();
    if (!confirmed?.length) return 'standard';
    const selected = contextual.find(item => item.id === model && !item.hidden);
    if (selected?.serviceTiers?.some(item => item.id === tier)) return tier;
    if (threadId && selected?.serviceTiers !== undefined) {
      await patchSession(threadId, current => current.serviceTier === tier ? { serviceTier: undefined } : {});
      log.info('agent', 'speed-reset', { threadId, model, tier });
    }
    return 'standard';
  };

  // Feishu gives bots no way to mark a message "已读" (read receipts are a
  // human-client signal), so a reaction stands in for one. Best-effort — a
  // missing im:message.reactions:write_only scope just means no reaction appears.
  async function addReaction(messageId: string, emoji: string): Promise<string | undefined> {
    try {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      return (r as { data?: { reaction_id?: string } }).data?.reaction_id;
    } catch (err) {
      log.fail('card', err, { phase: 'reaction-add', emoji });
      return undefined;
    }
  }
  function removeReaction(messageId: string, reactionId: string): void {
    void trackTask(channel.rawClient.im.v1.messageReaction
      .delete({ path: { message_id: messageId, reaction_id: reactionId } })
      .catch((err) => log.fail('card', err, { phase: 'reaction-del' })));
  }

  /**
   * Reaction lifecycle on the triggering message: ⏳ OneSecond while the run
   * waits for a free concurrency slot, 🫳 Typing while it's actually running,
   * then the emoji is removed entirely when it ends (complete / ⏹ 终止 /
   * timeout / error) — no "done" emoji. Transitions are serialized through
   * `chain` so each step removes the prior emoji first.
   */
  function runReaction(messageId: string, queued: boolean): RunReaction {
    let chain: Promise<string | undefined> = trackTask(addReaction(messageId, queued ? 'OneSecond' : 'Typing'));
    let phase = queued ? 0 : 1; // 0 = waiting(OneSecond), 1 = running(Typing), 2 = done(cleared)
    const swap = (emoji: string): void => {
      chain = trackTask(chain.then(async (prevId) => {
        if (prevId) removeReaction(messageId, prevId);
        return addReaction(messageId, emoji);
      }));
    };
    return {
      started: () => {
        if (phase < 1) {
          phase = 1;
          swap('Typing');
        }
      },
      done: () => {
        if (phase < 2) {
          phase = 2;
          chain = trackTask(chain.then((prevId) => {
            if (prevId) removeReaction(messageId, prevId);
            return undefined;
          }));
        }
      },
    };
  }

  /** A message to this bot that got no answer, for the 状态与诊断 page (s19). The sender only from the
   * name cache, never looked up; no text. Rule mode's messages not meant for it are never noted, nor a
   * recalled one whose turn failed after the recall (s15). */
  function noteNotReplied(msg: NotedMessage, reason: NotRepliedReason,
    extra: { place?: NotReplied['place']; backendId?: string | undefined; detail?: string | undefined; times?: number } = {}): void {
    if (recalled.has(msg.messageId)) return;
    const sender = names.peek(msg.senderId)?.slice(0, 64);
    const backend = backendTool(extra.backendId);
    reportNotReplied({
      at: msg.createTime || Date.now(), groupId: msg.chatId, place: extra.place ?? (msg.threadId ? 'topic' : 'main'), reason,
      ...(sender ? { sender } : {}), ...(backend ? { backend } : {}), ...(extra.detail ? { detail: fitDetail(extra.detail) } : {}), ref: msg.messageId.slice(-6),
    }, extra.times);
  }
  function dropBotMessage(msg: NormalizedMessage, why: string, detail: string): boolean {
    if (!fromBot(msg)) return false;
    log.info('intake', 'bot-wake-dropped', { ref: msg.messageId.slice(-6), why });
    if (!shuttingDown) noteNotReplied(msg, 'bot-wake-dropped', { detail });
    return true;
  }

  /** Only people are asked to resend; bot messages leave diagnostics instead, and a scheduled turn is settled by
   * `scheduledWhy` (droppedScheduled). */
  function askAgain(queue: readonly QueuedTurn[], chatId: string, place: NotReplied['place'], why: string, detail: string,
    scheduledWhy = why): number {
    let people = 0;
    for (const turn of queue) {
      if (turn.scheduled) { turn.scheduled.settle(droppedScheduled(scheduledWhy)); continue; }
      if (turn.requesterKind !== 'bot') { people++; continue; }
      const id = turn.seen?.id ?? '';
      log.info('intake', 'bot-wake-dropped', { ref: id.slice(-6), why });
      if (!shuttingDown) noteNotReplied({ chatId, messageId: id, senderId: turn.requesterOpenId ?? '', createTime: turn.requestedAt },
        'bot-wake-dropped', { place, detail });
    }
    return people;
  }

  /** A turn that started but did not answer; a refused scope also goes to the page's 缺的权限. */
  function noteFailure(msg: NotedMessage, place: NotReplied['place'], backendId: string | undefined, failure: TurnFailure): void {
    const { reason, detail, scope } = failureReason(failure);
    if (scope) reportScopeDenied(scope, 'send');
    noteNotReplied(msg, reason, { place, backendId, detail });
  }

  const hasAudience = (project: Project): boolean => (project.allowedUsers?.length ?? 0) > 0;
  function isMe(msg: NormalizedMessage): boolean {
    const sender = rawSender(msg)?.sender_id;
    const own = channel.botIdentity?.openId;
    return Boolean((own && (msg.senderId === own || sender?.open_id === own)) || (sender?.app_id && sender.app_id === cfg.accounts.app.id));
  }

  // ── the smart mode's intake (s25) ─────────────────────────────────
  /** Judgements by place, off the SDK's per-chat queue (smart-intake.ts). */
  const smartLanes = new SmartLanes<SmartItem, SmartVerdict>({
    judge: judgeSmart,
    priority: entry => entry.priority === true,
    due: (place, waiting, now) => {
      if (waiting.some(item => item.entry.priority)) return undefined;
      const at = attention.due(place, waiting.map((w) => w.at), now);
      if (at === undefined || at > now) return at;
      const { msg } = waiting[0]!.entry;
      if (budget.used(msg.chatId, now) < JUDGE_GLANCE_CAP) return at;
      const until = budget.freeAt(msg.chatId, now, JUDGE_GLANCE_CAP);
      log.info('intake', 'glance-deferred', { place: place.slice(-6), n: waiting.length, inMs: until - now });
      return Math.max(until, now + 1);
    },
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    overflow: (dropped) => log.info('intake', 'lane-overflow', { place: dropped[0]?.place.slice(-6), n: dropped.length }),
    // Into the place's session: after the earlier named messages there (design H1).
    ordered: (v) => v.kind === 'direct' || (v.kind === 'judged' && (v.result.decision === 'main' || v.result.decision === 'reply')),
    land: landSmart,
    fail: (error) => log.fail('intake', error, { phase: 'smart-lane' }),
    track: (task) => { void trackTask(task); },
  });

  const rootKinds = new Map<string, 'self' | 'other'>();
  const salienceDeps: SalienceDeps = {
    get botName() { return channel.botIdentity?.name; },
    quoted: (m) => quotedLine(recent, m),
    lookup: (id) => fetchMessageMeta(channel, id, names, { event: 'quote-lookup-failed', deadlineMs: LOOKUP_DEADLINE_MS }),
    rootFrom: async (chatId, threadId, rootId) => {
      const known = rootKinds.get(threadId);
      if (known) return known;
      const noted = (await topics?.get(chatId, threadId))?.firstFrom?.kind;
      const from = noted ?? recent.get(rootId)?.from ?? (await fetchMessageMeta(channel, rootId, names, { event: 'root-lookup-failed', deadlineMs: LOOKUP_DEADLINE_MS }))?.from;
      if (!from) return undefined;
      const kind = from === 'self' ? 'self' : 'other';
      rootKinds.set(threadId, kind);
      if (rootKinds.size > 200) rootKinds.delete(rootKinds.keys().next().value!);
      return kind;
    },
  };

  /**
   * A private chat's messages wait here for the person to pause, then go on as one message: judged once, answered once,
   * and a closing word cannot drop the question before it. One of them may carry files or a quote: only the message that
   * holds them can bring them into a turn, so the burst hangs on it and a second such message starts a new burst.
   */
  const DM_QUIET_MS = 1500;
  const dmBursts = new Map<string, DmBurst>();
  /** Bursts of several messages on their way to a turn, by each message: a recalled one sends the others round again. */
  const dmSent = new Map<string, DmBurst>();
  const carriesMore = (msg: NormalizedMessage): boolean => Boolean(msg.resources?.length || msg.replyToMessageId);
  const burstTrigger = (burst: DmBurst): NormalizedMessage => burst.msgs.find(carriesMore) ?? burst.msgs[burst.msgs.length - 1]!;

  function holdDm(msg: NormalizedMessage): void {
    if (shuttingDown) { submitSmart(msg, { kind: 'plain' }); return; }
    const place = msg.threadId ?? msg.chatId;
    let burst = dmBursts.get(place);
    if (burst && carriesMore(msg) && burst.msgs.some(carriesMore)) { sendBurst(burst); burst = undefined; }
    if (!burst) { burst = { place, msgs: [] }; dmBursts.set(place, burst); }
    burst.msgs.push(msg);
    time.clearTimer(burst.timer);
    const gathering = burst;
    burst.timer = time.setTimer(() => sendBurst(gathering), DM_QUIET_MS);
  }

  function sendBurst(burst: DmBurst): void {
    time.clearTimer(burst.timer);
    dmBursts.delete(burst.place);
    if (burst.msgs.length === 1) { submitSmart(burst.msgs[0]!, { kind: 'plain' }); return; }
    for (const msg of burst.msgs) dmSent.set(msg.messageId, burst);
    log.info('intake', 'dm-burst', { ref: burstTrigger(burst).messageId.slice(-6), n: burst.msgs.length });
    const joined = burst.msgs.map((msg) => msg.content.trim()).filter(Boolean).join('\n');
    submitSmart({ ...burstTrigger(burst), content: joined, createTime: Math.max(...burst.msgs.map((msg) => msg.createTime)) }, { kind: 'plain' }, burst);
  }

  /** Before a judgement says anything about the words, one of them may go: what is left is looked at again. */
  function recallFromBurst(id: string): void {
    for (const burst of dmBursts.values()) {
      if (!burst.msgs.some((msg) => msg.messageId === id)) continue;
      burst.msgs = burst.msgs.filter((msg) => msg.messageId !== id);
      if (!burst.msgs.length) { time.clearTimer(burst.timer); dmBursts.delete(burst.place); }
      return;
    }
    for (const state of active.values()) {
      const queued = state.queue.find((turn) => turn.burst?.msgs.some((msg) => msg.messageId === id));
      if (!queued) continue;
      state.queue.splice(state.queue.indexOf(queued), 1);
      resendBurst(queued.burst!);
      return;
    }
    const burst = dmSent.get(id);
    if (!burst) return;
    burst.gone = true;
    for (const msg of burst.msgs) dmSent.delete(msg.messageId);
    smartLanes.abort(burstTrigger(burst).messageId);
    resendBurst(burst);
  }
  function resendBurst(burst: DmBurst): void {
    for (const msg of burst.msgs) if (!recalled.has(msg.messageId)) holdDm(msg);
  }

  function submitSmart(msg: NormalizedMessage, salience: Salience, burst?: DmBurst): void {
    const dm = msg.chatType === 'p2p';
    const kind: LaneKind = dm || salience.kind === 'at-me' || salience.kind === 'quote-me' ? 'named' : salience.kind === 'name' ? 'aside' : 'chat';
    if (shuttingDown) {
      if (kind === 'named') droppedReplies?.appendSync(originOf(msg, !msg.threadId));
      return;
    }
    const now = time.now();
    const ref = placeOf(msg);
    if (!dm) attention.arrive(ref, now);
    const priority = kind === 'chat' && attention.followup(ref, now, msg.senderId);
    const item: SmartItem = { at: now, ...(dm ? {} : { attentionGroup: attention.captureGroup(msg.chatId) }), id: msg.messageId, place: msg.threadId ?? msg.chatId, kind, msg,
      variant: msg.threadId ? 'topic' : dm ? 'dm' : 'main', ...(priority ? { priority: true as const } : {}), ...(dm ? { signal: 'dm' as const } : salience.kind !== 'plain' ? { signal: salience.kind } : {}), ...(burst ? { burst } : {}), ...(salience.kind === 'quote-me' ? { quoteBy: salience.by } : {}) };
    if (kind === 'named') item.ack = trackTask(addReaction(msg.messageId, 'THINKING'));
    smartLanes.submit(item);
  }

  function submitWake(msg: NormalizedMessage): void {
    if (recalled.has(msg.messageId)) return;
    if (shuttingDown) {
      log.info('intake', 'bot-wake-dropped', { ref: msg.messageId.slice(-6), why: 'shutdown' });
      return;
    }
    const now = time.now();
    attention.arrive(placeOf(msg), now);
    const item: SmartItem = { at: now, attentionGroup: attention.captureGroup(msg.chatId), id: msg.messageId, place: msg.threadId ?? msg.chatId, kind: 'aside', wake: true, msg,
      variant: msg.threadId ? 'topic' : 'main' };
    smartLanes.submit(item);
  }

  function forgetAttention(chatId: string, why: 'mode' | 'unbind' | 'prompt'): void {
    attention.forget(chatId);
    log.info('intake', 'attention-forget', { chat: chatId.slice(-6), why });
  }

  /** An unbound group's active scheduled tasks pause as unavailable: kept, not deleted (3.13). Not waited for: a failed
   * write is logged and the unbind goes on. */
  function markUnavailable(chatId: string): void {
    void trackTask((async () => {
      await loadStore();
      if (!scheduleStore.byChat(chatId).some(task => task.state === 'active')) return;
      await scheduleStore.mutateConfig((tasks, touch) => {
        for (const task of tasks) {
          if (task.chatId !== chatId || task.state !== 'active') continue;
          task.state = 'paused';
          task.pausedReason = 'unavailable';
          touch(task);
        }
      });
    })().catch(error => log.fail('schedule', error, { phase: 'mark-unavailable', chat: chatId.slice(-6) })));
  }

  function takeUpTo(ref: PlaceRef, at: number): void {
    const to = Math.max(takenTo.get(ref.place)?.at ?? 0, at);
    takenTo.delete(ref.place);
    takenTo.set(ref.place, { chatId: ref.chatId, at: to });
    if (takenTo.size > 1_000) takenTo.delete(takenTo.keys().next().value!);
    const pruned = smartLanes.prune(ref.place, (e) => e.msg.createTime <= to);
    if (pruned.length) log.info('intake', 'lane-pruned', { place: ref.place.slice(-6), n: pruned.length });
  }

  function freezeOnBudget(item: SmartItem, n: number): void {
    const now = time.now();
    const ref = placeOf(item.msg);
    if (attention.freeze(ref, now)) log.info('intake', 'attention-freeze', { ref: item.msg.messageId.slice(-6), place: item.msg.threadId ? 'topic' : 'main' });
    const last = budgetNotedAt.get(ref.chatId);
    log.info('intake', 'unjudged', { ref: item.msg.messageId.slice(-6), place: item.msg.threadId ? 'topic' : 'main', why: 'budget', n, noted: last === undefined || now - last >= JUDGE_BUDGET_WINDOW_MS });
    if (last !== undefined && now - last < JUDGE_BUDGET_WINDOW_MS) return;
    budgetNotedAt.set(ref.chatId, now);
    noteNotReplied(item.msg, 'judge-budget', { times: n });
  }

  function whyLooking(before: PlaceView | undefined, kind: LookKind, now: number, n: number): string | undefined {
    if (kind === 'focus' && before?.mode === 'focus') {
      if (before.repliedAt !== undefined) {
        const age = now - before.repliedAt;
        return age < 60_000 ? '你刚在这里说过话，正在跟着看' : `你 ${Math.round(age / 60_000)} 分钟前在这里说过话，正在跟着看`;
      }
      return before.topic ? '你在这个话题里说过话，正在跟着看' : '你在这里说过话，正在跟着看';
    }
    if (kind !== 'glance') return undefined;
    if (before?.lookedAt === undefined) return `你第一次看这里，标"新"的 ${n} 条是新来的`;
    const age = now - before.lookedAt;
    return age < 60_000 ? `你刚看过这里，标"新"的 ${n} 条是这之后来的` : `你有 ${Math.round(age / 60_000)} 分钟没看这里了，标"新"的 ${n} 条是这期间来的`;
  }

  /** Judges the newest message of a batch (the others came while the one before was judged: its context). Never
   * rejects: a lookup that throws answers a named message in the main area, as a failed judgement would. */
  async function judgeSmart(batch: SmartItem[], signal: AbortSignal, glance: boolean): Promise<SmartVerdict> {
    const item = batch[batch.length - 1]!;
    const ref = placeOf(item.msg);
    const now = time.now();
    const kind: LookKind = item.kind === 'chat' ? (glance ? 'glance' : 'focus') : 'signal';
    let look = batch;
    let why: string | undefined;
    if (item.kind === 'chat') {
      const before = attention.state(ref.place);
      let old: SmartItem[] = [];
      if (glance) ({ look, old } = attention.pickGlance(batch, now));
      const where = item.msg.threadId ? 'topic' : 'main';
      if (old.length) log.info('intake', 'unjudged', { ref: item.msg.messageId.slice(-6), place: where, why: 'old', n: old.length });
      if (!look.length) return { kind: 'drop' };
      attention.glanced(ref, now);
      smartLanes.rearmWhere(entry => entry.msg.chatId === ref.chatId);
      log.info('intake', 'attention', { ref: item.msg.messageId.slice(-6), place: where, kind, mode: before?.mode ?? 'watch', intervalMs: before?.intervalMs, n: look.length, old: old.length });
      why = whyLooking(before, kind, now, look.length);
    }
    try {
      const verdict = item.wake ? await judgeWake(item, signal)
        : await judgeItem(item, signal, { glance, fresh: new Set(look.map((b) => b.id)), why, n: look.length });
      if (verdict.kind === 'judged') {
        // This records the model's intent, before the landing guards. Never
        // promote a failed judgement's fallback into an intelligent decision,
        // or retain its reason (which can repeat the original message).
        if (item.signal !== 'dm' && !verdict.result.error && !signal.aborted && !shuttingDown) reportDecision({
          id: randomUUID(), groupId: item.msg.chatId, place: item.msg.threadId ? 'topic' : 'main',
          decision: verdict.result.decision, decidedAt: time.now(), messageAt: item.msg.createTime,
          trigger: item.wake ? 'bot-mention' : item.signal === 'at-me' ? 'mention' : item.signal === 'quote-me' ? 'quote'
            : item.signal === 'name' || item.kind === 'aside' ? 'name' : glance ? 'glance' : 'focus',
          ...(item.kind === 'chat' && glance ? { messageCount: Math.min(10_000, look.length) } : {}),
        });
        if (verdict.result.promptHash && attention.isCurrentGroup(ref.chatId, item.attentionGroup)
          && attention.notePrompt(ref.chatId, verdict.result.promptHash)) {
          forgetAttention(ref.chatId, 'prompt');
          attention.arrive(ref, time.now());
          item.attentionGroup = attention.captureGroup(ref.chatId);
        }
        if (item.signal !== 'dm') attention.verdict(ref, kind, outcomeOf(verdict.result), now);
        const why = unjudgedAnswer(item, verdict.result.error?.kind);
        if (why) {
          log.info('intake', 'judge-fallback', { ref: item.msg.messageId.slice(-6), place: item.msg.threadId ? 'topic' : 'main', why, error: verdict.result.error?.kind, backend: verdict.result.backend });
          return { kind: 'direct' };
        }
      }
      return glance && verdict.kind === 'judged' ? { ...verdict, look: look.map((b) => b.id) } : verdict;
    } catch (error) {
      if (item.kind === 'chat') attention.verdict(ref, kind, 'error', time.now());
      if (item.wake) {
        if (shuttingDown) {
          log.info('intake', 'bot-wake-dropped', { ref: item.msg.messageId.slice(-6), why: 'shutdown' });
          return { kind: 'drop' };
        }
        if (signal.aborted || recalled.has(item.msg.messageId)) return { kind: 'drop' };
        // Transport/storage errors may carry message bodies or ids; detail stays on the diagnostics page.
        log.fail('intake', 'bot-wake-failed', { phase: 'bot-wake', ref: item.msg.messageId.slice(-6) });
        noteNotReplied(item.msg, 'bot-wake-failed', { detail: errorDetail(error) });
        return { kind: 'drop' };
      }
      log.fail('intake', error, { phase: 'smart-judge', ref: item.msg.messageId.slice(-6) });
      if (shuttingDown || signal.aborted || recalled.has(item.msg.messageId)) return { kind: 'drop' };
      const why = unjudgedAnswer(item, 'failed');
      if (why) {
        log.info('intake', 'judge-fallback', { ref: item.msg.messageId.slice(-6), place: item.msg.threadId ? 'topic' : 'main', why, error: 'failed' });
        return { kind: 'direct' };
      }
      if (glance) noteNotReplied(item.msg, 'judge-failed', { detail: errorDetail(error), times: look.length });
      else for (const b of batch) noteNotReplied(b.msg, 'judge-failed', { detail: errorDetail(error) });
      return { kind: 'drop' };
    } finally {
      publishAttention();
    }
  }

  async function judgeWake(item: SmartItem, signal: AbortSignal): Promise<SmartVerdict> {
    const { msg } = item;
    const ref = msg.messageId.slice(-6);
    const gone = (): boolean => shuttingDown || signal.aborted || recalled.has(msg.messageId);
    const dropped = (): SmartVerdict => {
      if (shuttingDown) log.info('intake', 'bot-wake-dropped', { ref, why: 'shutdown' });
      return { kind: 'drop' };
    };
    // 不补拉历史、不数次数（owner 2026-10-19 去掉 6 次保险）。卡片正文和发信人并行，合起来最多 3 秒；读不到都不挡
    const [fetched, sender] = await Promise.all([
      msg.rawContentType === 'interactive'
        ? orStop(withDeadline(fetchQuotedMessage(channel, msg.messageId, names, { refOnly: true }), LOOKUP_DEADLINE_MS, 'wake-trigger'), undefined).then((m) => m?.text)
        : Promise.resolve(undefined),
      wakeSender(msg),
    ]);
    if (gone()) return dropped();
    log.info('intake', 'bot-wake', { ref, place: msg.threadId ? 'topic' : 'main' });
    const text = wakeTriggerText(msg, undefined, fetched);
    const trig = wakeTrigger(msg, sender);
    const project = await getProjectByChatId(msg.chatId);
    if (gone()) return dropped();
    // 查询期间设置可能改变：先挡住，不花判断预算；落地再复核判断期间的变化。
    const gate = (why: string, detail: string): SmartVerdict => {
      log.info('intake', 'bot-wake-dropped', { ref, why });
      noteNotReplied(trig, 'bot-wake-dropped', { detail });
      return { kind: 'drop' };
    };
    if (!project) { log.info('intake', 'bot-wake-dropped', { ref, why: 'unbound' }); return { kind: 'drop' }; }
    if (project.enabled === false) { noteNotReplied(trig, 'group-disabled'); return { kind: 'drop' }; }
    if (projectMutations.has(msg.chatId)) return gate('updating', '群正在改设置');
    if (resumePublications.has(msg.chatId)) return gate('resuming', '群正在恢复会话');
    if (sessionModeOf(project) !== 'smart') return gate('rule-mode', '群切成了规则模式');
    // 名单在判断前判：名单外的不判断、不占预算（3.4"bot 之间"）。认不出发信人的按名单外。落地再查一次，判断期间改了名单也对。
    if (hasAudience(project) && !(sender.openId && isUserAllowedInProject(cfg, project, sender.openId))) {
      log.info('intake', 'bot-wake-not-allowed', { ref });
      noteNotReplied(trig, 'bot-wake-not-allowed');
      return { kind: 'drop' };
    }
    // 预算在过了上面几道门之后拿：名单外的、停用和改设置中的都不占 60 次。不另设被 bot @ 的子上限（owner 2026-10-19）。
    if (!budget.take(msg.chatId, time.now(), 'bot')) {
      log.info('intake', 'judge-budget', { ref, wake: true });
      noteNotReplied(trig, 'judge-budget');
      return { kind: 'drop' };
    }
    const result = await callJudge(item, project, trig, trig.senderName ?? '某人', true, signal);
    return { kind: 'judged', result, wake: { text, sender } };
  }

  /** 发信的 bot 在我命名空间里的 open_id 和名字。open_id 先看消息查询（它的 open_bot_id 就是名册的 member_id，P3），
   * 再看事件里的 ou_；名字先看名册（10 分钟缓存），再看查询带回的。两样读不到都不挡：不数次数了（s27a）。 */
  async function wakeSender(msg: NormalizedMessage): Promise<{ openId?: string; name?: string }> {
    const [meta, bots] = await Promise.all([
      orStop(fetchMessageMeta(channel, msg.messageId, names, { event: 'wake-sender-lookup-failed', deadlineMs: LOOKUP_DEADLINE_MS, refOnly: true }), undefined),
      orStop(roster.load(msg.chatId).then(() => roster.peek(msg.chatId), () => undefined), undefined),
    ]);
    const openId = meta?.senderId ?? (msg.senderId.startsWith('ou_') ? msg.senderId : undefined);
    const name = openId ? bots?.get(openId)?.name || names.peek(openId) : undefined;
    if (openId && name) names.remember(openId, name);
    return { ...(openId ? { openId } : {}), ...(name ? { name } : {}) };
  }

  function wakeTrigger(msg: NormalizedMessage, sender: WakeFacts['sender']): NormalizedMessage {
    return { ...msg, resources: [], senderId: sender.openId ?? '', senderName: sender.name ?? msg.senderName };
  }

  function unjudgedAnswer(item: SmartItem, errorKind: JudgeErrorKind | undefined): 'named' | 'solo' | undefined {
    if (!errorKind || errorKind === 'aborted' || errorKind === 'closed') return undefined;
    if (item.kind === 'named') return 'named';
    if (item.kind === 'chat' && item.msg.threadId && soloInRing(item.place, item.msg)) return 'solo';
    return undefined;
  }

  function soloInRing(place: string, msg: NormalizedMessage): boolean {
    let lastBot: 'self' | 'bot' | undefined;
    for (const l of recent.lines(place)) {
      if (l.from !== 'user') lastBot = l.from;
      else if (!l.senderId || l.senderId !== msg.senderId) return false;
    }
    return lastBot === 'self';
  }

  async function judgeItem(item: SmartItem, signal: AbortSignal, look: { glance: boolean; fresh: Set<string>; why?: string; n: number }): Promise<SmartVerdict> {
    const { msg } = item;
    // A 同时发送到群 copy is looked up here, not on the chat's queue (s14d); a private chat's was, on arrival.
    if (item.signal !== 'dm' && !msg.threadId && !msg.mentionedBot && (await syncCopy.skip(msg, true))) return { kind: 'drop' };
    const project = await getProjectByChatId(msg.chatId);
    const dropped = (why: string): SmartVerdict => {
      log.info('intake', 'judge-dropped', { ref: msg.messageId.slice(-6), why });
      return { kind: 'drop' };
    };
    if (!project) return item.kind === 'chat' ? dropped('unbound') : { kind: 'drop' };
    if (item.kind === 'chat') {
      if (project.enabled === false) return dropped('disabled');
      if (sessionModeOf(project) !== 'smart') return dropped('rule-mode');
      if (projectMutations.has(msg.chatId)) return dropped('updating');
      if (resumePublications.has(msg.chatId)) return dropped('resuming');
    }
    if (item.kind === 'aside' && !budget.take(msg.chatId, time.now(), 'name')) {
      log.info('intake', 'judge-budget', { ref: msg.messageId.slice(-6), kind: 'name' });
      noteNotReplied(msg, 'judge-budget');
      return { kind: 'budget' };
    }
    if (item.kind === 'chat' && !budget.take(msg.chatId, time.now(), look.glance ? 'glance' : 'focus')) {
      if (!look.glance || budget.used(msg.chatId, time.now()) >= JUDGE_BUDGET) freezeOnBudget(item, look.n);
      else log.info('intake', 'unjudged', { ref: msg.messageId.slice(-6), why: 'glance-cap', n: look.n });
      return { kind: 'budget' };
    }
    // Other bots' messages reach this one only through a pull (3.11): read them where there may be some.
    const others = item.signal !== 'dm' && await topicCtx.chatInfo(msg.chatId).then((r) => !r.ok || r.bots === undefined || r.bots > 1);
    const name = names.peek(msg.senderId) ?? msg.senderName ?? '某人';
    const result = await callJudge(item, project, msg, name, others, signal, look);
    return { kind: 'judged', result };
  }

  async function callJudge(item: SmartItem, project: Project, msg: NormalizedMessage, name: string, others: boolean, signal: AbortSignal, look?: { glance: boolean; fresh: Set<string>; why?: string }): Promise<JudgeResult> {
    const reads = await judgeFactRead(withDeadline(Promise.all([orStop(recent.fill(item.place, msg.createTime, (o) => {
      const opts = { ...o, before: msg.createTime, keepSelf: true, names };
      return withDeadline(msg.threadId ? fetchThreadContext(channel, msg.threadId, opts) : fetchChatContext(channel, msg.chatId, opts), LOOKUP_DEADLINE_MS, 'recent-context');
    }, others), undefined), item.signal === 'dm' ? undefined : orStop(withDeadline(roster.load(msg.chatId).then(() => roster.selection(msg.chatId)), LOOKUP_DEADLINE_MS, 'judge-roster').catch(() => undefined), undefined)]), LOOKUP_DEADLINE_MS, 'judge-facts'), signal);
    const topic = !signal.aborted && msg.threadId && topics ? (await judgeFactRead(orStop(withDeadline(topics.list(msg.chatId), LOOKUP_DEADLINE_MS, 'judge-topic'), undefined), signal))?.find((t) => t.topicId === msg.threadId) : undefined;
    const title = topic?.title;
    let context = recent.context(item.place, { id: msg.messageId, at: msg.createTime });
    if (look && (look.fresh.size > 1 || look.glance)) context = context.map((l) => l.id && look.fresh.has(l.id) ? { ...l, fresh: true as const } : l);
    const line = lineOfMessage(msg, name, quotedLine(recent, msg), JUDGE_INPUT_LIMITS.messageChars);
    if (item.burst) {
      context = context.filter((l) => !item.burst!.msgs.some((m) => m.messageId === l.id));
      line.text = item.burst.msgs.map((m) => lineOfMessage(m, name, undefined, JUDGE_INPUT_LIMITS.messageChars).text).filter(Boolean).join('\n');
    }
    const botName = channel.botIdentity?.name ?? '';
    context = context.map((l) => sameNameWord(l.text, botName) ? { ...l, sameNameWord: true as const } : l);
    if (sameNameWord(bareText(msg), botName)) line.sameNameWord = true;
    const root = msg.threadId ? recent.get(msg.rootId ?? '') : undefined;
    const opener = topic?.openedBy;
    const openedBy = opener?.kind === 'self' ? '你' : opener?.name ?? (opener?.openId ? names.peek(opener.openId) : undefined)
      ?? (root?.from === 'self' ? '你' : root?.name) ?? (rootKinds.get(item.place) === 'self' ? '你' : undefined);
    const facts = item.signal === 'dm' ? undefined : buildJudgeFacts({
      lines: recent.lines(item.place), message: line, topic: !!msg.threadId,
      roster: reads?.[1], self: { openId: channel.botIdentity?.openId, appId: cfg.accounts.app.id },
      ...(openedBy ? { openedBy } : {}),
    });
    const why = item.wake ? '别的 bot @ 了你'
      : item.signal === 'at-me' ? '真人 @ 了你'
      : item.signal === 'quote-me' ? (item.quoteBy === 'root' ? '真人回答了你发起的话题根消息' : '真人引用了你的消息')
      : item.signal === 'name' ? '真人叫了你的完整名字' : item.signal === 'dm' ? '这是私聊，这句话是对你说的' : look?.why;
    const judged = judgeContext(await contextSourcesFor(project, { skipBotMemory: true }));
    return judge.judge({
      persona: judged.role, memory: judged.memory,
      ...(facts ? { facts } : {}),
      variant: item.variant, appId: cfg.accounts.app.id, botName: channel.botIdentity?.name ?? '',
      group: { chatId: project.chatId, name: project.dm ? `和 ${name} 的私聊` : project.name, backend: project.backend, judge: project.judge, smartRules: project.smartRules ?? (project.dm ? DEFAULT_DM_SMART_RULES : undefined) },
      botJudge: cfg.preferences?.judge, ...(title ? { topicTitle: title } : {}),
      context, message: look?.glance ? { ...line, fresh: true as const } : line,
      ...(why ? { why } : {}),
      ref: msg.messageId, signal, ...(item.kind === 'named' ? { timeoutMs: JUDGE_NAMED_TIMEOUT_MS } : {}),
    });
  }

  /** Whether the main session's turn being prepared carries `msg` in its record block (design M5). */
  function mainWillWeave(msg: NormalizedMessage): boolean {
    const state = active.get(msg.chatId);
    if (!state) return false;
    if (state.woven) return state.woven.has(msg.messageId);
    return (state.triggerAt ?? 0) > msg.createTime;
  }

  async function landSmart(batch: SmartItem[], verdict: SmartVerdict, _glance: boolean): Promise<void> {
    const item = batch[batch.length - 1]!;
    try {
      if (item.burst?.gone) return;
      for (const msg of item.burst?.msgs ?? []) dmSent.delete(msg.messageId);
      await landVerdict(item, batch, verdict);
    } catch (error) {
      if (!item.wake) throw error;
      const ref = item.msg.messageId.slice(-6);
      if (shuttingDown) log.info('intake', 'bot-wake-dropped', { ref, why: 'shutdown' });
      else if (!recalled.has(item.msg.messageId)) {
        log.fail('intake', 'bot-wake-land-failed', { phase: 'bot-wake-land', ref });
        const msg = verdict.kind === 'judged' && verdict.wake ? wakeTrigger(item.msg, verdict.wake.sender) : item.msg;
        noteNotReplied(msg, 'bot-wake-failed', { detail: errorDetail(error) });
      }
    } finally {
      dropAck(item);
      smartLanes.rearmWhere(entry => entry.msg.chatId === item.msg.chatId);
    }
  }

  /** Takes a named message's THINKING off, once (a shutdown may come while it lands). */
  function dropAck(item: SmartItem): void {
    const ack = item.ack;
    item.ack = undefined;
    if (ack) void trackTask(ack.then((id) => { if (id) removeReaction(item.msg.messageId, id); }));
  }

  /**
   * The earlier line a judged main-area message follows up on, when its topic may open there (s25b): a person's line
   * that names no one, one of the batch or of the last few minutes, still there and with no topic under it yet (the
   * registry knows the topics this bot saw; Feishu is asked for the rest; {@link openingUnder} the ones it is opening).
   * Else undefined: it opens on the message. A line returned is in {@link openingUnder}: startTopicDirectly takes it out.
   */
  async function anchorLine(msg: NormalizedMessage, batch: SmartItem[], anchor: string | undefined): Promise<RecentLine | undefined> {
    if (!anchor) return undefined;
    const dropped = (why: string): undefined => {
      log.info('intake', 'anchor-dropped', { ref: msg.messageId.slice(-6), why });
      return undefined;
    };
    const line = recent.get(anchor);
    // Not counting what this landing wrote about itself.
    const lines = recent.context(msg.chatId, { id: msg.messageId, at: msg.createTime }).filter((l) => l.id !== `act:${msg.messageId}`);
    const back = lines.length - lines.findIndex((l) => l.id === anchor);
    if (!line || recalled.has(anchor) || back > lines.length) return dropped('gone');
    if (line.from !== 'user' || line.named) return dropped('not-plain');
    if (!batch.some((b) => b.id === anchor) && (back > ANCHOR_LINES || msg.createTime - line.at > ANCHOR_WINDOW_MS)) return dropped('old');
    if ((await topics?.list(msg.chatId))?.some((t) => t.firstId === anchor)) return dropped('has-topic');
    const meta = await fetchMessageMeta(channel, anchor, names, { event: 'anchor-lookup-failed', deadlineMs: LOOKUP_DEADLINE_MS });
    if (!meta) return dropped('lookup-failed');
    // Checked and taken with no await between: two landings never both open under it.
    if (meta.threadId || openingUnder.has(anchor)) return dropped('has-topic');
    openingUnder.add(anchor);
    return line;
  }

  /**
   * A verdict lands: noted on the page when it is not to answer, else handed to the place's session or a new
   * topic as any message would be, the place's 运行中来了消息 setting included (product.md 3.5). Checked first,
   * and only this: the message was not recalled, the bot is not stopping, the group is still bound, enabled,
   * smart and not being changed, and the message did not land already (Rakazo A2).
   */
  async function landVerdict(item: SmartItem, batch: SmartItem[], verdict: SmartVerdict): Promise<void> {
    const look = verdict.kind === 'judged' ? verdict.look : undefined;
    const wake = verdict.kind === 'judged' ? verdict.wake : undefined;
    const msg = wake ? wakeTrigger(item.msg, wake.sender) : item.msg;
    const { variant } = item;
    const ref = msg.messageId.slice(-6);
    const stopped = (): boolean => {
      if (!shuttingDown || !wake) return false;
      log.info('intake', 'bot-wake-dropped', { ref, why: 'shutdown' });
      return true;
    };
    const wakeDropped = (why: string, detail: string): void => {
      log.info('intake', 'bot-wake-dropped', { ref, why });
      noteNotReplied(msg, 'bot-wake-dropped', { detail });
    };
    const superseded = (): void => {
      if (wake) {
        log.info('intake', 'bot-wake-superseded', { ref, at: 'land' });
        noteNotReplied(msg, 'bot-wake-dropped', { detail: '已随后来的消息进了会话' });
      } else noteNotReplied(msg, 'judge-superseded', look ? { times: look.length } : {});
    };
    if (stopped()) return;
    if (verdict.kind === 'drop') return;
    if (verdict.kind === 'budget') {
      log.info('intake', 'judge-budget', { ref, batch: batch.length, kind: item.kind });
      return;
    }
    let decision: JudgeDecision = msg.threadId ? 'reply' : 'main';
    if (verdict.kind === 'judged') {
      const { result } = verdict;
      if (result.decision === 'skip') {
        const kind = result.error?.kind;
        // Recalled meanwhile, or the bot is stopping: nothing to say.
        if (kind === 'aborted' || kind === 'closed') return;
        const reason: NotRepliedReason = kind ? 'judge-failed' : 'judge-skip';
        // Nobody else is in a private chat, and silence reads as a dead Bot: it says it saw this.
        if (item.signal === 'dm' && !kind) void trackTask(addReaction(msg.messageId, 'OK'));
        // The model's reason goes on the page only (3.4); a decision model may give its confidence alone (s23f).
        const detail = kind ? result.error?.detail ?? kind
          : result.reason || (result.confidence !== undefined ? `把握度 ${result.confidence.toFixed(2)}` : undefined);
        if (look) noteNotReplied(msg, reason, { backendId: result.backend, detail, times: look.length });
        else for (const b of batch) noteNotReplied(wake ? msg : b.msg, reason, { backendId: result.backend, detail });
        return;
      }
      decision = result.decision;
    }
    if (recalledSkip(msg) || stopped() || shuttingDown) return;
    const project = await getProjectByChatId(msg.chatId);
    if (stopped()) return;
    if (!project || project.enabled === false) {
      if (wake && !project) log.info('intake', 'bot-wake-dropped', { ref, why: 'unbound' });
      else noteNotReplied(msg, project ? 'group-disabled' : 'group-updating');
      return;
    }
    if (projectMutations.has(msg.chatId) || resumePublications.has(msg.chatId)) {
      if (wake) {
        const updating = projectMutations.has(msg.chatId);
        wakeDropped(updating ? 'updating' : 'resuming', updating ? '群正在改设置' : '群正在恢复会话');
      } else noteNotReplied(msg, 'group-updating');
      return;
    }
    const text = wake?.text ?? escapeInboundMarkers(msg.content.trim());
    if (project.dm && !isAdmin(cfg, msg.senderId)) { log.info('intake', 'dm-admin-gone', { ref }); return; }
    if (!project.dm && sessionModeOf(project) !== 'smart') { noteNotReplied(msg, 'group-updating'); return; }
    // A list changed during judgement must still exclude this bot before it starts a turn.
    if (wake && hasAudience(project) && !(wake.sender.openId && isUserAllowedInProject(cfg, project, wake.sender.openId))) {
      log.info('intake', 'bot-wake-not-allowed', { ref });
      noteNotReplied(msg, 'bot-wake-not-allowed');
      return;
    }
    const place = msg.threadId ?? msg.chatId;
    const ts = turnSession(place, project);
    const anchorId = decision === 'main' && look && verdict.kind === 'judged' ? verdict.result.anchor : undefined;
    const anchored = anchorId && look?.includes(anchorId) ? batch.find((b) => b.id === anchorId) : undefined;
    if (anchorId && !anchored) log.info('intake', 'anchor-not-in-batch', { ref });
    let trig = anchored?.msg ?? msg;
    if (trig !== msg && recalled.has(trig.messageId)) { log.info('intake', 'anchor-dropped', { ref, why: 'recalled' }); trig = msg; }
    const turnText = trig === msg ? text : trig.content.trim();
    const takenAt = (): number => takenTo.get(place)?.at ?? 0;
    const initiative = item.kind === 'chat' && variant === 'main';
    const proposed = decision === 'topic' && item.kind === 'chat' && verdict.kind === 'judged' ? verdict.result.anchor : undefined;
    // Not twice: an unnamed message a later turn's record block carried is not answered on its own. A named one is
    // never dropped so; landings into the session wait for it (SmartLanes), and a re-push was checked on intake.
    if (decision === 'topic') {
      const reopened = await reopenedTopic(msg);
      if (stopped() || reopened) return;
      if (item.kind !== 'named') {
        const seen = msg.createTime <= takenAt() || mainWillWeave(msg) || await alreadySeen(msg, msg.chatId);
        if (stopped()) return;
        if (seen || msg.createTime <= takenAt()) { superseded(); return; }
        if (proposed && (openingUnder.has(proposed) || (await topics?.list(msg.chatId))?.some((t) => t.firstId === proposed))) { superseded(); return; }
      }
    } else if (item.kind !== 'named') {
      const seen = await alreadySeen(trig, ts.sessionKey);
      if (stopped()) return;
      if (trig.createTime <= takenAt() || seen || (wake && active.get(ts.sessionKey)?.woven?.has(msg.messageId))) { superseded(); return; }
    }
    const refused = await refuseUnavailableTier(trig, project, ts);
    if (stopped() || refused) return;
    // A settings/resume lock may have arrived during the final read, before this turn was reserved.
    if (wake && (projectMutations.has(msg.chatId) || resumePublications.has(msg.chatId))) {
      const updating = projectMutations.has(msg.chatId);
      wakeDropped(updating ? 'updating' : 'resuming', updating ? '群正在改设置' : '群正在恢复会话');
      return;
    }
    // The next judgement here sees what this bot is doing, before its answer comes and before the line it opens
    // under is looked up: written for the person's line the judgement named, again if that one is dropped.
    const actId = `act:${msg.messageId}`;
    const actAt = Date.now();
    const actText = (line: RecentLine | undefined): string => {
      const who = oneLine(line?.name ?? names.peek(trig.senderId) ?? trig.senderName ?? '某人');
      return decision === 'topic' ? `（在 ${who} 的这条下开了话题来回）` : `（在回 ${who} 的这条）`;
    };
    const guess = proposed ? recent.get(proposed) : undefined;
    const guessed = actText(guess?.from === 'user' ? guess : undefined);
    recent.addOwn(place, msg.chatId, { id: actId, at: actAt, text: guessed });
    const under = proposed ? await anchorLine(msg, look ? batch.filter((b) => look.includes(b.id)) : batch, proposed) : undefined;
    if (stopped()) return;
    // The anchor lookup can outlive a later main reply. Recheck after the final await;
    // this check, the start registration and dispatch below must stay synchronous.
    if (item.kind !== 'named' && (trig.createTime <= takenAt() || (decision === 'topic' && mainWillWeave(msg)))) {
      recent.remove(actId);
      if (under) openingUnder.delete(under.id);
      superseded();
      return;
    }
    const landed = actText(under);
    if (landed !== guessed) {
      recent.remove(actId);
      recent.addOwn(place, msg.chatId, { id: actId, at: actAt, text: landed });
    }
    if (decision !== 'topic') takeUpTo({ chatId: msg.chatId, place }, trig.createTime);
    const accepted = acceptAttention({ chatId: msg.chatId, place }, under?.senderId ?? trig.senderId, !wake, item.attentionGroup);
    log.info('intake', 'judge-landed', { ref, decision, variant, ...(look ? { glance: true, looked: look.length } : {}), ...(trig !== msg ? { trigger: trig.messageId.slice(-6) } : {}), ...(wake ? { wake: true } : {}), ...(under ? { anchor: under.id.slice(-6) } : {}) });
    const namedSource = batch.length === 1 && item.kind === 'named' && !item.burst
      && !wake && !initiative && !(verdict.kind === 'judged' && verdict.result.anchor);
    const extra: TurnExtra = {attentionAcceptance: accepted, ...(namedSource ? directFeedback(msg) : {}),
      ...(wake ? {wake: {name: wake.sender.name ?? ''}} : initiative ? {initiative: true as const} : {}),
      ...(item.burst ? {burst: item.burst} : {})};
    if (decision === 'topic') startTopicDirectly(msg, text, project, false, extra, under);
    else void trackTask(handleTurn(trig, turnText, ts.sessionKey, !trig.threadId, project, ts, extra)
      .catch((err) => log.fail('intake', err)));
  }

  /** Hold a specific reply's ticket through host startup and asynchronous topic creation. */
  function acceptAttention(ref: PlaceRef, senderId: string | undefined, participation: boolean, group: AttentionGroupToken | undefined): AttentionAcceptance {
    let accepted = false;
    let ticket: AttentionTicket | undefined;
    let topicId: string | undefined;
    const inherit = (): void => {
      if (topicId && ticket && attention.isCurrentGroup(ref.chatId, group)) attention.openedTopic(ref.chatId, topicId, ticket, time.now());
    };
    return {
      accept: () => {
        if (accepted || shuttingDown || !attention.isCurrentGroup(ref.chatId, group)) return;
        accepted = true;
        if (!participation) return;
        ticket = attention.replied(ref, time.now(), { senderId });
        inherit();
        smartLanes.rearmWhere(entry => entry.msg.chatId === ref.chatId);
      },
      opened: id => { topicId = id; inherit(); },
    };
  }

  // ── inbound messages ──────────────────────────────────────────────
  const intakeChats = new Map<string, number>();
  const pendingTopics = new Map<string, number>();
  const resumePublications = new Set<string>();
  /** `chatId` is taking a message in while `work` runs: the group's settings are not edited meanwhile. */
  async function duringIntake<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    intakeChats.set(chatId, (intakeChats.get(chatId) ?? 0) + 1);
    try { return await work(); } finally {
      const remaining = (intakeChats.get(chatId) ?? 1) - 1;
      if (remaining) intakeChats.set(chatId, remaining); else intakeChats.delete(chatId);
    }
  }
  // ASR must precede text routing without pinning the SDK's per-chat queue.
  // Only a place with pending audio is held; sibling topics and card actions
  // remain available, and later text cannot overtake an earlier voice message.
  type IntakeStatus = Pick<ActiveState, 'intakeCancelled'>;
  const pendingVoiceIntake = new Map<string, Promise<void>>();
  const pendingVoiceMessages = new Map<string, Set<IntakeStatus>>();
  function cancelIntake(state: ActiveState): void {
    if (state.intakeCancelled) return;
    state.intakeCancelled = true;
    // Include messages received before this run was reserved. Only the entries
    // already waiting at Stop are cancelled; a later resend remains eligible.
    for (const [place, running] of active) {
      if (running === state) for (const pending of pendingVoiceMessages.get(place) ?? []) pending.intakeCancelled = true;
    }
  }
  const onMessage = (msg: NormalizedMessage): Promise<void> => {
    if (seenInbound.seen(msg.messageId)) {
      log.info('intake', 'reject', { reason: 'duplicate', msgId: msg.messageId });
      return Promise.resolve();
    }
    if (recalledSkip(msg)) return Promise.resolve();
    const place = msg.threadId ?? msg.chatId;
    const previous = pendingVoiceIntake.get(place);
    const owner = active.get(place);
    if (msg.rawContentType !== 'audio' && !previous) return duringIntake(msg.chatId, () => handleMessage(msg, owner));
    const status: IntakeStatus = { intakeCancelled: owner?.intakeCancelled };
    const pending = pendingVoiceMessages.get(place) ?? new Set<IntakeStatus>();
    pending.add(status);
    pendingVoiceMessages.set(place, pending);
    const task = duringIntake(msg.chatId, () => (previous ?? Promise.resolve()).then(() => handleMessage(msg, status)))
      .finally(() => {
        pending.delete(status);
        if (!pending.size) pendingVoiceMessages.delete(place);
      });
    const tail = task.catch(() => undefined);
    pendingVoiceIntake.set(place, tail);
    void tail.then(() => { if (pendingVoiceIntake.get(place) === tail) pendingVoiceIntake.delete(place); });
    void trackTask(task);
    return Promise.resolve();
  };
  async function intakeStoppedBeforeText(msg: NormalizedMessage, owner?: IntakeStatus): Promise<boolean> {
    if (shuttingDown || recalledSkip(msg)) return true;
    if (!owner?.intakeCancelled) return false;
    await channel.send(msg.chatId, { markdown: '排队期间会话已停止，请重发本条消息。' },
      { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) }).catch(() => undefined);
    return true;
  }
  async function transcribeMessage(msg: NormalizedMessage, owner?: IntakeStatus, project?: Project): Promise<NormalizedMessage | undefined> {
    const ingested = await orStop<IngestedContext | undefined>(ingestVoice(channel, msg, {
      transcribe: (audio, durationMs) => voice.transcribe(audio, durationMs, project?.presentation?.voiceEnabled),
    }), undefined);
    if (!ingested || await intakeStoppedBeforeText(msg, owner)) return undefined;
    return voiceMessages.remember(msg, ingested);
  }
  const resourceMessages = new WeakSet<NormalizedMessage>();
  const feedbackSources = new WeakMap<NormalizedMessage, FeedbackSource>();
  const directFeedback = (msg: NormalizedMessage): Pick<TurnExtra, 'feedback'> => ({feedback: feedbackSources.get(msg)});
  const handleMessage = async (msg: NormalizedMessage, intakeOwner?: IntakeStatus): Promise<void> => {
    // Feishu does not keep events in order: a recall can come before its message (s15).
    if (await intakeStoppedBeforeText(msg, intakeOwner)) return;
    // No message text (3.5); the ids' last 6 characters match the 状态与诊断 page's 消息尾号.
    log.info('intake', 'recv', {
      senderType: rawSender(msg)?.sender_type,
      senderIdKind: msg.senderId.startsWith('ou_') ? 'ou_' : msg.senderId.startsWith('cli_') ? 'cli_' : msg.senderId ? 'other' : 'empty',
      chatType: msg.chatType,
      mentionedBot: msg.mentionedBot,
      threadId: msg.threadId ? msg.threadId.slice(-6) : null,
      chat: msg.chatId.slice(-6),
      ref: msg.messageId.slice(-6),
    });

    // The main-area copy of a reply 「同时发送到群」 or 「同时发送到会话」 is dropped here,
    // before any reply, record, watermark or note; its topic message is answered (s14d).
    if (msg.chatType === 'p2p') {
      if (await syncCopy.skip(msg, true)) return;
      if (fromBot(msg)) return;
      // Whoever a group's agent asked may reply to their card; everything else stops here, before any transcription (dm-agent 3.5).
      if (options?.feedback && /^\/feedback (?:authorize|authorized)$/.test(msg.content.trim()) && await options.feedback.onMessage(msg)) return;
      if (!isAdmin(cfg, msg.senderId)) {
        if (!askAnswered(msg)) await refuseDm(msg);
        return;
      }
      if (msg.rawContentType === 'audio') {
        const askReply = options?.authoring && asks.hasPendingDmReply({ openId: msg.senderId, quoted: quotedId(msg), createTime: msg.createTime });
        if (options?.authoring && !askReply && await options.authoring.onMessage(msg)) return;
        const textMessage = await transcribeMessage(msg, intakeOwner, await dmProject().catch(() => undefined));
        if (!textMessage) return;
        if (askReply) {
          // The card may have closed during transcription. Its private answer still belongs to that card.
          if (!askAnswered(textMessage)) await channel.send(msg.chatId, { markdown: '这条语音未能用于回答问题，请查看原问题卡片。' }, { replyTo: msg.messageId }).catch(() => undefined);
          return;
        }
        msg = textMessage;
      }
      if (askAnswered(msg)) return;
      if (options?.authoring && await options.authoring.onMessage(msg)) return;
      // route() only records a trigger after matching the trusted DM and the delivered account selection.
      if (options?.authoring?.resources?.hasTrigger(msg.messageId)) resourceMessages.add(msg);
      if (isMenuCommand(msg)) { await handleDmConsole(channel, cfg, msg); return; }
      const dm = await openDmChat(msg);
      if (!dm) {
        await channel.send(msg.chatId, { markdown: '私聊项目没建好，请到 Vonvon Bot 的诊断页看看。' }, { replyTo: msg.messageId }).catch(() => undefined);
        return;
      }
      if (msg.threadId) noteTopicMessage(msg);
      const smartDm = sessionModeOf(dm) === 'smart';
      if (smartDm) recent.add(msg.threadId ?? msg.chatId, lineOfMessage(msg, names.peek(msg.senderId) ?? msg.senderName ?? '某人', quotedLine(recent, msg)));
      await routeMessage(msg, dm, smartDm);
      return;
    }

    let project = await getProjectByChatId(msg.chatId);
    // @门：没 @ 时只在「项目群 + 免@ 适用」才响应。免@默认开,但 multi 仅话题内、
    // single 整群;非项目群一律不响应非 @ 消息。Another bot's message never is (s22:
    // rule mode's bots do not see each other). Who an unnamed message is for (三条
    // 底线) is looked up below, after the cheap gates; this is what may be for it.
    // A smart group's every message from a person may be (s25).
    let smart = project !== undefined && sessionModeOf(project) === 'smart';
    const bot = fromBot(msg);
    const wakeable = bot && smart && msg.mentionedBot;
    let maybe = !bot && (msg.mentionedBot || Boolean(project && (smart || shouldRespondWithoutMention(project, msg)
      || (noMentionOf(project) && quotedId(msg) !== undefined))));
    // Audio may contain a command, so only metadata can exclude it before ASR.
    const voiceCandidate = msg.rawContentType === 'audio' && !bot && Boolean(project && (msg.mentionedBot || smart
      || (noMentionOf(project) && !msg.mentionAll && !msg.mentions.some(mention => !mention.isBot))));
    // Resolve audio copies before spending a transcription on the duplicate.
    if (await syncCopy.skip(msg, voiceCandidate || (smart ? msg.mentionedBot : maybe) || resumePublications.has(msg.chatId))) return;
    if (options?.feedback && project && !bot && project.enabled !== false && !projectMutations.has(msg.chatId)
      && !resumePublications.has(msg.chatId) && isChatAllowed(cfg, msg.chatId) && isUserAllowedInProject(cfg, project, msg.senderId)) {
      if (/^\/feedback(?:\s|$)/.test(msg.content.trim()) && await options.feedback.onMessage(msg)) return;
      const source = options.feedback.bind(msg, project);
      if (source) feedbackSources.set(msg, source);
    }
    if (voiceCandidate && project && project.enabled !== false
      && !resumePublications.has(msg.chatId) && !projectMutations.has(msg.chatId)
      && isChatAllowed(cfg, msg.chatId) && isUserAllowedInProject(cfg, project, msg.senderId)) {
      // The audience gates do not need the spoken words: a voice in another
      // bot's topic is rejected before downloading, just like other media.
      if (!smart && !msg.mentionedBot && !(await forThisBot(msg, project, false))) return;
      intakeOwner ??= active.get(msg.threadId ?? msg.chatId);
      const textMessage = await transcribeMessage(msg, intakeOwner, project);
      if (!textMessage) return;
      msg = textMessage;
      // An external settings edit may have landed while recognition was pending.
      project = await getProjectByChatId(msg.chatId);
      if (await intakeStoppedBeforeText(msg, intakeOwner)) return;
      smart = project !== undefined && sessionModeOf(project) === 'smart';
      maybe = msg.mentionedBot || Boolean(project && (smart || shouldRespondWithoutMention(project, msg)
        || (noMentionOf(project) && quotedId(msg) !== undefined)));
    }
    // Every message of a smart group is a line its judgements may read, said to this bot or not (product.md 3.5).
    if (smart && isChatAllowed(cfg, msg.chatId)) {
      recent.add(msg.threadId ?? msg.chatId, lineOfMessage(msg, names.peek(msg.senderId) ?? msg.senderName ?? '某人', quotedLine(recent, msg)));
    }
    if (resumePublications.has(msg.chatId)) {
      if (bot) { if (wakeable) noteNotReplied(msg, 'bot-wake-dropped', { detail: '群正在恢复会话' }); }
      else await channel.send(msg.chatId, { markdown: '正在恢复历史会话，请完成后重发此消息。' }, { replyTo: msg.messageId });
      return;
    }
    if (project?.enabled === false) {
      if (msg.mentionedBot && (!bot || smart)) noteNotReplied(msg, 'group-disabled');
      return;
    }
    if (projectMutations.has(msg.chatId)) {
      if (wakeable) noteNotReplied(msg, 'bot-wake-dropped', { detail: '群正在改设置' });
      // A smart group's chatter is not noted: it was not said to this bot.
      if (!bot && (msg.mentionedBot || (project && !smart && shouldRespondWithoutMention(project, msg)))) noteNotReplied(msg, 'group-updating');
      return;
    }
    if (project && msg.threadId && isChatAllowed(cfg, msg.chatId)) noteTopicMessage(msg);
    if (bot) {
      const ref = msg.messageId.slice(-6);
      if (!msg.mentionedBot || !project || !smart || isMe(msg)) {
        if (msg.mentionedBot) log.info('intake', 'reject', { reason: 'bot-sender', ref });
        return;
      }
      if (!isChatAllowed(cfg, msg.chatId)) { noteNotReplied(msg, 'chat-not-allowed'); return; }
      const ts = turnSession(msg.threadId ?? msg.chatId, project);
      if (await alreadySeen(msg, ts.sessionKey)) {
        log.info('intake', 'bot-wake-superseded', { ref, at: 'intake' });   // 重推，或真人那一轮已织进会话；不记诊断
        return;
      }
      submitWake(msg);
      return;
    }
    if (!maybe) return;
    let refused: NotRepliedReason | undefined;
    if (!isChatAllowed(cfg, msg.chatId)) refused = 'chat-not-allowed';
    else if (!isUserAllowedInProject(cfg, project, msg.senderId)) refused = 'user-not-allowed';
    if (refused) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      if (!smart || msg.mentionedBot) noteNotReplied(msg, refused);
      return;
    }
    if (smart && !msg.threadId && !msg.mentionedBot && isCommandLike(msg.content.trim()) && !(await lonely(msg.chatId))) {
      log.info('intake', 'audience', { to: 'other', by: 'command-needs-at', ref: msg.messageId.slice(-6) });
      const r = await topicCtx.chatInfo(msg.chatId);
      if (!r.ok || r.bots === undefined) noteNotReplied(msg, 'lookup-failed', { detail: '群里有几个 bot' });
      return;
    }
    const audience = smart ? 'me' : project && !msg.mentionedBot ? await forThisBot(msg, project) : 'me';
    if (!audience) return;

    // The bot is in a group not bound to any project (e.g. it was just added and
    // the admin hasn't finished binding in DM yet). Don't run codex in the
    // fallback cwd for an unbound group — only nudge toward binding when @ed.
    if (!project) {
      log.info('intake', 'unbound-group', { chatId: msg.chatId.slice(-6), atBot: msg.mentionedBot });
      if (msg.mentionedBot) {
        // It got only a hint, so the owner sees why on the page.
        noteNotReplied(msg, 'unbound');
        const now = Date.now();
        const last = unboundNoted.get(msg.chatId);
        if (now - (last ?? -Infinity) < UNBOUND_QUIET_MS) {
          log.info('intake', 'unbound-quiet', { chatId: msg.chatId.slice(-6) });
          return;
        }
        unboundNoted.delete(msg.chatId);
        unboundNoted.set(msg.chatId, now);
        if (unboundNoted.size > 1000) {
          const oldest = unboundNoted.keys().next().value;
          if (oldest !== undefined) unboundNoted.delete(oldest);
        }
        const sent = await channel.send(msg.chatId, { markdown: UNBOUND_GROUP_REPLY }, {
          replyTo: msg.messageId, replyInThread: Boolean(msg.threadId),
        }).then(() => true, () => false);
        if (!sent && unboundNoted.get(msg.chatId) === now) {
          if (last === undefined) unboundNoted.delete(msg.chatId);
          else unboundNoted.set(msg.chatId, last);
        }
      }
      return;
    }
    await routeMessage(msg, project, smart);
  };

  /** A person's private chat is a door of its own (dm-agent 3.5): the refusal is worded and the candidate kept by {@link createDmRefusal}. */
  async function refuseDm(msg: NormalizedMessage): Promise<void> {
    await dmRefusal({ openId: msg.senderId, chatId: msg.chatId, replyTo: msg.messageId });
  }
  /** A reply to the card a group's agent sent this person: only that answers it (dm-agent 5). The rest is for their own Agent. */
  function askAnswered(msg: NormalizedMessage): boolean {
    const quoted = quotedId(msg);
    if (!quoted || !typedCandidate(msg)) return false;
    if (!asks.dmText({ openId: msg.senderId, text: msg.content.trim(), quoted, createTime: msg.createTime })) return false;
    markSeen(msg.threadId ?? msg.chatId, { id: msg.messageId, at: msg.createTime });
    return true;
  }
  /** `/menu`; `/settings` is not listed and does the same (dm-agent 5). */
  function isMenuCommand(msg: NormalizedMessage): boolean {
    return /^\/(menu|settings)(?![\w/])/i.test(msg.content.trim());
  }
  /** Each person's private chats since this process started: taking them off the list reaches a running turn even when the files cannot be read. */
  const dmChatsOf = new Map<string, Set<string>>();
  /** The private chat's row as this person's chat, noted before the turn so that a task can find the chat again. Undefined when there is no row. */
  async function openDmChat(msg: NormalizedMessage): Promise<Project | undefined> {
    const chats = dmChatsOf.get(msg.senderId) ?? new Set<string>();
    dmChatsOf.set(msg.senderId, chats.add(msg.chatId));
    await orStop(dmReady, undefined);
    try {
      await rememberDmChat(msg.chatId, msg.senderId, await names.senderName(msg), rawSender(msg)?.sender_id?.union_id);
      return await getProjectByChatId(msg.chatId);
    } catch (error) {
      log.fail('project', error, { phase: 'dm-remember' });
      return undefined;
    }
  }

  /** A message past the gates of its place: a command, or a turn in the session of where it was said. */
  async function routeMessage(msg: NormalizedMessage, project: Project, smart: boolean): Promise<void> {
    // 多维表格「发送消息卡片」等 card 2.0 交互卡片：推送事件 / 旧版 content 只给降级
    // 占位（SDK 归一化成 "[interactive card]"，或「请升级至最新版本客户端…」），真正的
    // 卡片正文（含 Base 记录链接）要带 card_msg_content_type=raw_card_content 回查才拿得
    // 到。命中降级时回查并把正文塞回 msg.content，让 codex 读到「请处理这条记录
    // [查看…](base链接)」并据此（配合 lark-cli skill）继续处理。
    if (msg.rawContentType === 'interactive' && isDegradedCardContent(msg.content)) {
      const full = await fetchInteractiveCardText(channel, msg.messageId);
      if (full) {
        log.info('intake', 'card-content-enriched', { msgId: msg.messageId, len: full.length });
        msg.content = full;
      }
    }

    const text = escapeInboundMarkers(msg.content.trim());
    const cmd = parseCommand(text);
    // `/goal <objective>` anywhere in the message → a persistent autonomous goal
    // run (OKR reaction as the receipt, streaming cards, then a terminal card).
    // Explicit slash COMMANDS above still take priority (clear, leading intent).
    const goalObjective = parseGoalTrigger(text);

    // Single-session group: the main area is one session keyed by chatId. No
    // topics — reply by quoting (引用回复); runs serialize per chatId (active[chatId]).
    // Commands: /model, /resume and the session ones; /settings is a private chat's (s1b). /resume has no topic list here.
    // A topic opened in the group (msg.threadId) falls through to the topic path
    // below and gets its own session (product.md 3.5); an old topic that used to
    // share the chat session starts fresh from its next message, nothing migrated.
    if (project && ruleKind(project) === 'single' && !msg.threadId) {
      if (cmd === 'help') {
        await postHelpCard(msg, 'single', false, project);
        return;
      }
      if (cmd === 'settings') {
        await refuseGroupSettings(msg);
        return;
      }
      const ts = turnSession(msg.chatId, project);
      if (cmd === 'resume') {
        // 单会话群：就地切回历史会话（重绑本群 session key，不另起话题）。admin 门控在 postResumeCard 内。
        postResumeCard(msg, ts.sessionKey);
        return;
      }
      if (cmd === 'clear' || cmd === 'new') {
        // 单会话群：停泊当前会话 + 重绑到全新 thread（旧 thread 留档可 /resume）。admin 门控在 runClear 内。
        runClear(msg, ts.sessionKey, ts, cmd);
        return;
      }
      if (cmd === 'model') {
        postModelCard(msg, ts.sessionKey, false); // 单会话群：扁平引用回复，卡片直接出现在会话里，不另起话题
        return;
      }
      if (cmd === 'compact') {
        runCompact(msg, ts.sessionKey, false, ts);
        return;
      }
      if (cmd === 'context') {
        await postContextCard(msg, ts.sessionKey, false);
        return;
      }
      if (!cmd && !goalObjective && typedCandidate(msg)) {
        const typed = asks.typed({ chatId: msg.chatId, place: ts.sessionKey, senderId: msg.senderId,
          senderKind: askRequesterKind(msg), text, createTime: msg.createTime });
        if (typed === 'answered') { markSeen(ts.sessionKey, { id: msg.messageId, at: msg.createTime }); return; }
        if (typed === 'sensitive') noteSensitiveInGroup(msg, ts.sessionKey);
      }
      // Smart: a judgement decides (s25); the refusal of a tier the backend cannot run waits for it to say reply.
      if (smart && !goalObjective) {
        if (await alreadySeen(msg, ts.sessionKey)) return;
        if (msg.chatType === 'p2p') holdDm(msg); else submitSmart(msg, await classifySalience(msg));
        return;
      }
      if (await refuseUnavailableTier(msg, project, ts)) return;
      if (goalObjective) {
        if (!(await goalCapable(project, ts.sessionKey))) {
          await denyGoal(msg, false);
          return;
        }
        void trackTask(addReaction(msg.messageId, 'OKR'));
        startReservedRun(msg, goalObjective, ts.sessionKey, true, project, ts, undefined, undefined, undefined, true);
        return;
      }
      if (await alreadySeen(msg, ts.sessionKey)) return;
      void trackTask(handleTurn(msg, text, ts.sessionKey, true, project, ts, directFeedback(msg)).catch((err) => log.fail('intake', err)));
      return;
    }

    // Inside a topic (multi, or a topic in a single group) → a turn in that session. /resume isn't
    // topic-scoped — redirect to the main area instead of feeding it to codex as a normal turn
    // (烧一轮还无人能懂); /settings is a private chat's (s1b).
    if (msg.threadId) {
      if (cmd === 'help') {
        await postHelpCard(msg, 'topic', true, project);
        return;
      }
      if (cmd === 'settings') {
        await refuseGroupSettings(msg, true);
        return;
      }
      const mainArea = project.dm ? '主区' : '主群区';
      if (cmd === 'resume') {
        await channel
          .send(msg.chatId, { markdown: `\`/${cmd}\` 请到${mainArea}使用（话题外发）。` }, { replyTo: msg.messageId, replyInThread: true })
          .catch(() => undefined);
        return;
      }
      if (cmd === 'clear' || cmd === 'new') {
        await channel
          .send(
            msg.chatId,
            { markdown: `话题里不换会话。要新的会话，就开一个新话题；\`/resume\` 请到${mainArea}使用。` },
            { replyTo: msg.messageId, replyInThread: true },
          )
          .catch(() => undefined);
        return;
      }
      const ts = turnSession(msg.threadId, project);
      if (cmd === 'model') {
        postModelCard(msg, ts.sessionKey, true); // 已在话题里：卡片就发在当前话题内
        return;
      }
      if (cmd === 'compact') {
        runCompact(msg, ts.sessionKey, true, ts);
        return;
      }
      if (cmd === 'context') {
        await postContextCard(msg, ts.sessionKey, true);
        return;
      }
      if (!cmd && !goalObjective && typedCandidate(msg)) {
        const typed = asks.typed({ chatId: msg.chatId, place: ts.sessionKey, senderId: msg.senderId,
          senderKind: askRequesterKind(msg), text, createTime: msg.createTime });
        if (typed === 'answered') { markSeen(ts.sessionKey, { id: msg.messageId, at: msg.createTime }); return; }
        if (typed === 'sensitive') noteSensitiveInGroup(msg, ts.sessionKey);
      }
      // Smart: every human topic message is judged; named signals only shorten the wait.
      if (smart && !goalObjective) {
        if (await alreadySeen(msg, ts.sessionKey)) return;
        if (msg.chatType === 'p2p') holdDm(msg); else submitSmart(msg, await classifySalience(msg));
        return;
      }
      if (await refuseUnavailableTier(msg, project, ts)) return;
      if (goalObjective) {
        if (!(await goalCapable(project, ts.sessionKey))) {
          await denyGoal(msg, true);
          return;
        }
        void trackTask(addReaction(msg.messageId, 'OKR'));
        startReservedRun(msg, goalObjective, ts.sessionKey, false, project, ts, undefined, undefined, undefined, true);
        return;
      }
      if (await alreadySeen(msg, ts.sessionKey)) return;
      void trackTask(handleTurn(msg, text, ts.sessionKey, false, project, ts, directFeedback(msg)).catch((err) => log.fail('intake', err)));
      return;
    }
    // Main group area: /resume opens the history picker; /settings is a private
    // chat's (s1b); /model only makes sense inside a topic; anything else
    // directly creates a topic + runs.
    if (cmd === 'help') {
      await postHelpCard(msg, 'main', false, project);
      return;
    }
    if (cmd === 'resume') {
      postResumeCard(msg);
      return;
    }
    if (cmd === 'settings') {
      await refuseGroupSettings(msg);
      return;
    }
    if (cmd === 'clear' || cmd === 'new') {
      await channel
        .send(
          msg.chatId,
          { markdown: `这个群的主区不留会话，不用 \`/${cmd}\`：@我 加内容就开一个新话题，每个话题是一条新会话。` },
          { replyTo: msg.messageId },
        )
        .catch(() => undefined);
      return;
    }
    if (cmd === 'model' || cmd === 'compact' || cmd === 'context') {
      await channel
        .send(msg.chatId, { markdown: `\`/${cmd}\` 需要在话题里使用（先 @我 开个话题）。` }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    if (await reopenedTopic(msg)) return;
    if (goalObjective) {
      if (!(await goalCapable(project))) {
        await denyGoal(msg, false);
        return;
      }
      if (await refuseUnavailableTier(msg, project, turnPerm(project))) return;
      void trackTask(addReaction(msg.messageId, 'OKR'));
      startTopicDirectly(msg, goalObjective, project, true);
      return;
    }
    // 拼错/臆想的斜杠命令（/stop /compat…）会直接烧一轮 codex 新开话题 —— 拦下。
    // 已知命令在上面全部 return 了，走到这里的 /单词 只剩裸 `/goal`（缺目标）和
    // 未知命令。仅限「整条消息就是一个 /纯字母单词」的形态，以 / 开头的路径、
    // 带参数的正文（用户真想让 codex 处理的）不受影响。
    if (/^\/[a-z]+$/i.test(text)) {
      const name = text.slice(1).toLowerCase();
      await channel
        .send(
          msg.chatId,
          { markdown: name === 'goal' ? '用法：`/goal <目标>`，例如 `/goal 把所有单测跑绿`。' : `未知命令 \`/${name}\`，可用命令见 \`/help\`。` },
          { replyTo: msg.messageId },
        )
        .catch(() => undefined);
      log.info('intake', 'unknown-cmd', { name });
      return;
    }
    if (await refuseUnavailableTier(msg, project, turnPerm(project))) return;
    startTopicDirectly(msg, text, project, false, directFeedback(msg));
  }

  /**
   * A message was recalled (im.message.recalled_v1, s15). Not in a session yet:
   * queued or held input of it is dropped, and its own late event is not run.
   * Already in one: each session it reached says so at its next turn, from what
   * the daemon records (see recall.reachedAt). Idempotent: Feishu may push twice.
   */
  async function onRecall({ messageId: id, chatId, recallType }: RecallEvent): Promise<void> {
    if (!id || !chatId) return;
    const say = (lookup: string, sessions = 0, noted = 0): void =>
      log.info('intake', 'recall', { chat: chatId.slice(-6), msg: id.slice(-6), type: recallType ?? null, lookup, sessions, noted });
    // Pushed again: the first event's notes stand (once said, a second lookup would add them back).
    if (recalled.has(id)) { say('repeat'); return; }
    noteRecalled(id);
    // Out of what later judgements read; a judgement made for it stops (its landing checks again).
    recent.remove(id);
    voiceMessages.forget(id);
    recallFromBurst(id);
    smartLanes.abort(id);
    let dropped = 0;
    for (const state of active.values()) {
      dropped += removeWhere(state.queue, (turn) => turn.seen?.id === id);
      if (state.deferred) dropped += removeWhere(state.deferred, (held) => held.id === id);
    }
    if (dropped) log.info('intake', 'recall-queued-dropped', { msgId: id, dropped });
    const bindings = (await listSessions().catch(() => [])).filter((s) => s.chatId === chatId && !s.detached && !isRetiredKey(s.threadId));
    if (!bindings.length) { say('skipped'); return; }
    const x = await orStop(fetchMessageMeta(channel, id, names), undefined);
    if (x?.from === 'self') { say('self', bindings.length); return; } // the bot's own: its native history has it
    const list = x && !isTopicReply(x, id) && topics && bindings.some((b) => !isMainKey(b.threadId, chatId)) ? await topics.list(chatId) : [];
    const other = recallType !== undefined && recallType !== 'message_owner';
    const who = x ? { kind: x.from, ...(x.senderId ? { openId: x.senderId } : {}) } : undefined;
    let noted = 0;
    for (const rec of bindings) {
      const rootAt = list.find((t) => t.topicId === rec.threadId)?.firstAt;
      const at = reachedAt(rec, chatId, id, x, rootAt);
      if (at === undefined) continue;
      noted++;
      const note: RecallNote = { id, at, ...(who ? { who } : {}), ...(other ? { other: true } : {}) };
      // Only while the binding still points at the session the message reached.
      void trackTask(patchSession(rec.threadId, (r) => (r.sessionId === rec.sessionId ? { recalls: addRecall(r.recalls, note) } : {})).catch(() => undefined));
    }
    say(x ? 'ok' : 'failed', bindings.length, noted);
  }

  /** Parse a leading slash command; null otherwise. */
  function parseCommand(text: string): 'resume' | 'model' | 'settings' | 'help' | 'compact' | 'context' | 'clear' | 'new' | null {
    const m = /^\/(\w+)/.exec(text);
    const name = m?.[1]?.toLowerCase();
    return name === 'resume' ||
      name === 'model' ||
      name === 'settings' ||
      name === 'help' ||
      name === 'compact' ||
      name === 'context' ||
      name === 'clear' ||
      name === 'new'
      ? name
      : null;
  }

  /** Whether to respond to a non-@ message in a project group (免@ default on).
   * single: whole group. multi: inside a topic, OR a slash command in the main
   * area — plain chatter in the main area still needs @ (开新话题 是明确意图，
   * 不能让随便一句话就开话题)，but explicit commands (/help /resume /settings
   * /model) and a `/goal` trigger respond without @ since they're unambiguous intent.
   * 即使开了免@，若消息 @了所有人 或 @了具体的(非机器人)用户,说明是定向给别人的,
   * bot 不插话。(此函数仅在 !mentionedBot 时调用,故 @到 bot 的情况已被排除。)
   */
  function shouldRespondWithoutMention(project: Project, msg: NormalizedMessage): boolean {
    if (!noMentionOf(project)) return false;
    if (msg.mentionAll || msg.mentions.some((m) => !m.isBot)) return false;
    if (ruleKind(project) === 'single') return true;
    const content = msg.content.trim();
    return Boolean(msg.threadId) || parseCommand(content) !== null || parseGoalTrigger(content) !== null;
  }

  async function classifySalience(msg: NormalizedMessage): Promise<Salience> {
    const salience = await smartSalience(msg, salienceDeps);
    const info = { ref: msg.messageId.slice(-6), place: msg.threadId ? 'topic' : 'main' };
    if (salience.kind !== 'plain') log.info('intake', 'salience', { ...info, kind: salience.kind, ...(salience.kind === 'quote-me' ? { by: salience.by } : {}) });
    else if (salience.partial) log.info('intake', 'name-partial', info);
    return salience;
  }

  function isCommandLike(text: string): boolean {
    return parseCommand(text) !== null || parseGoalTrigger(text) !== null;
  }

  function lonely(chatId: string): Promise<boolean> {
    return topicCtx.chatInfo(chatId).then((r) => r.ok && r.bots === 1);
  }

  /**
   * Whether a message without an @ of this bot, in a bound group whose 免@ may
   * answer it, is for this bot (三条底线, s22). Answers what the mode would,
   * except: a quote of this bot's message names it (免@, even in a 多会话 main
   * area); a quote of someone else's, or a topic another bot spoke in last, is
   * someone else's; with other bots in the group (or the count unread) a 多会话
   * main-area command needs an @. A lookup that
   * fails leaves the message unanswered and noted.
   * The group's only bot looks nothing up and answers as before s22.
   * 'me': it names this bot; 'nobody': the mode decides; undefined: not answered.
   */
  async function forThisBot(msg: NormalizedMessage, project: Project, textReady = true): Promise<'me' | 'nobody' | undefined> {
    let info: Promise<ChatInfo> | undefined;
    const chat = (): Promise<ChatInfo> => (info ??= topicCtx.chatInfo(msg.chatId));
    const who = await audienceOf(msg, { noMention: noMentionOf(project) }, {
      lonely: () => lonely(msg.chatId),
      quoted: (id) => fetchMessageMeta(channel, id, names, { event: 'quote-lookup-failed', deadlineMs: LOOKUP_DEADLINE_MS }),
      lastBot: (threadId) => fetchTopicLastBot(channel, threadId, LOOKUP_DEADLINE_MS),
    });
    const ref = msg.messageId.slice(-6);
    switch (who.to) {
      case 'me':
        if (who.by === 'quote') log.info('intake', 'audience', { to: 'me', by: 'quote', ref });
        return 'me';
      case 'other':
        log.info('intake', 'audience', { to: 'other', by: who.by, ref });
        return undefined;
      case 'unknown':
        log.info('intake', 'audience', { to: 'unknown', why: who.why, ref });
        noteNotReplied(msg, 'lookup-failed', { detail: who.why === 'quote' ? '引用的消息' : '话题里谁在说话' });
        return undefined;
      case 'nobody': {
        // Audio intake checks the same audience first, then this content gate after ASR.
        if (textReady && !shouldRespondWithoutMention(project, msg)) return undefined;
        // A main-area command or /goal of a 多会话 group (nothing else gets here): each bot would answer it.
        if (!msg.threadId && ruleKind(project) === 'multi' && !(await lonely(msg.chatId))) {
          log.info('intake', 'audience', { to: 'other', by: 'command-needs-at', ref });
          // Unread, the count may be just this bot: the page says why the command got nothing.
          const r = await chat();
          if (!r.ok || r.bots === undefined) noteNotReplied(msg, 'lookup-failed', { detail: '群里有几个 bot' });
          return undefined;
        }
        return 'nobody';
      }
    }
  }

  /** 非管理员触发管理命令(/resume、/new、/clear)时的统一无权限提示。
   * 管理类命令仅管理员可用；对话类(/model、/help)对所有人开放。 */
  async function denyAdminCommand(msg: NormalizedMessage, cmd: 'resume' | 'clear' | 'new'): Promise<void> {
    const why = cmd === 'clear' || cmd === 'new' ? '主区的会话是大家共用的。' : '';
    await channel
      .send(msg.chatId, { markdown: `⚠️ \`/${cmd}\` 只有管理员能用。${why}` }, { replyTo: msg.messageId })
      .catch(() => undefined);
    log.info('intake', 'cmd-denied', { cmd });
  }

  /**
   * @bot /settings in a group (s1b, owner 2026-11-02): no group settings card any more, whoever sends it. Settings are
   * changed in a private chat, the client or the command line, which the sentence says.
   */
  async function refuseGroupSettings(msg: NormalizedMessage, inThread = false): Promise<void> {
    await channel
      .send(msg.chatId, { markdown: NOT_DM_MESSAGE }, { replyTo: msg.messageId, ...(inThread ? { replyInThread: true } : {}) })
      .catch(() => undefined);
    log.info('intake', 'cmd-denied', { cmd: 'settings', reason: 'not-dm' });
  }

  /** A turn's resolved permission: the group's one tier, whoever sends (s15c). */
  type TurnPerm = Pick<StartThreadOptions, 'mode' | 'network' | 'native' | 'readScope'>;

  /** The group's tier and network for `project`, a private chat's row too (always 完全访问); none without a row. */
  function turnPerm(project: Project | undefined): TurnPerm {
    if (!project) return {};
    const exec = execOf(project);
    return { readScope: claudeReadScope({ dataRoot: paths.appDir, projectsRoot: resolveProjectsRootDir(cfg.preferences?.projectsRootDir), appId: cfg.accounts.app.id, chatId: project.chatId }), mode: exec.permission, network: exec.network, ...(exec.custom ? { native: exec.custom } : {}) };
  }

  /** As {@link turnPerm}, plus the session key: the place itself, one session for everyone. */
  function turnSession(baseKey: string, project: Project | undefined): { sessionKey: string } & TurnPerm {
    return { sessionKey: baseKey, ...turnPerm(project) };
  }

  /** When each group last got the unavailable-tier explanation (see refuseUnavailableTier). */
  const unavailableTierNoted = new Map<string, number>();
  const unboundNoted = new Map<string, number>();
  /** A turn in a tier unavailable on this backend: no session starts and
   * nothing is downloaded or woven first. The message is noted and the group told why, in place: every
   * human @, and a bot or 免@ message only when the group got no explanation in the last {@link FULL_ONLY_QUIET_MS}. */
  async function refuseUnavailableTier(msg: NormalizedMessage, project: Project, perm: TurnPerm): Promise<boolean> {
    const mode = perm.mode ?? 'full';
    const be = groupBackend(project);
    const table = permissionTable(be.id);
    const env = tableEnv(be);
    if (!tierInfo(table, env, mode).unavailable) return false;
    log.info('intake', 'reject', { reason: 'tier-unavailable', mode });
    noteNotReplied(msg, 'tier-unavailable', { backendId: be.id });
    const now = Date.now();
    const last = unavailableTierNoted.get(msg.chatId);
    if (!project.dm && (!msg.mentionedBot || fromBot(msg)) && now - (last ?? -Infinity) < FULL_ONLY_QUIET_MS) return true;
    // Stamped before sending so 免@ messages arriving meanwhile stay quiet; put back if the send fails.
    unavailableTierNoted.set(msg.chatId, now);
    // The command needs --bot when the host has several bots (pickBot); an unreadable registry counts as one.
    const several = await loadBots().then((reg) => reg.bots.length > 1, () => false);
    const markdown = project.dm ? `ℹ️ 这一轮没有开始：私聊固定用「${tierInfo(table, env, mode).name}」，${tierInfo(table, env, mode).unavailable}\n这时私聊里只有 \`/menu\` 能用。`
      : unavailableTierReply(msg.chatId, table, env, mode, several ? cfg.accounts.app.id : undefined);
    const sent = await channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) }).then(() => true, () => false);
    if (!sent && unavailableTierNoted.get(msg.chatId) === now) {
      if (last === undefined) unavailableTierNoted.delete(msg.chatId);
      else unavailableTierNoted.set(msg.chatId, last);
    }
    return true;
  }

  /** A line of the bot's own in the group's main area, kept for the main session's context. */
  async function sayInMain(chatId: string, input: { text: string } | { post: object }, text: string): Promise<void> {
    const sent = await channel.send(chatId, input);
    recent.addOwn(chatId, chatId, { id: sent.messageId, at: Date.now(), text });
  }

  /** When each scheduled task last said in its group that its tier is unavailable: once an hour at most. */
  const gateFailureNoted = new Map<string, number>();
  /** The scheduler recorded a run its group's tier could not start (scheduleGate): one line in the main area, not a card. */
  function notifyGateFailure(task: StoredTask): void {
    const project = getProjectByChatIdSync(task.chatId);
    const reason = project && tierUnavailable(project);
    const now = Date.now();
    if (!project || !reason || shuttingDown || now - (gateFailureNoted.get(task.id) ?? -Infinity) < 60 * 60_000) return;
    gateFailureNoted.set(task.id, now);
    // A text message's `<at>` is a real mention and no at-guard reads it; the task's name is anybody's words, so no tag
    // in it survives (as in the scheduled topic's root). Only the name: an unclosed tag would run to the end of the sentence.
    const text = `⏰ 定时任务「${plainTaskName(task.name)}」这次没跑：${project.dm ? '私聊' : '本群'}的权限档现在用不了（${reason.replace(/。$/, '')}）。连续 10 次会自动暂停。`;
    void trackTask(sayInMain(task.chatId, { text }, text).catch(error => {
      if (gateFailureNoted.get(task.id) === now) gateFailureNoted.delete(task.id); // the next failure tries again
      log.fail('schedule', error, { phase: 'gate-notice', taskId: task.id });
    }));
  }

  /** The scheduler paused a task after 10 failures in a row: one post in the main area, the creator at-ed when known; a
   * private chat has only them to tell, and a task made from another Bot's private chat only their name (dm-agent 6.4).
   * Throws when it is not sent, so the scheduler keeps the notice pending and tries again. */
  async function notifyAutoPause(task: StoredTask): Promise<void> {
    const project = await getProjectByChatId(task.chatId);
    if (!project || project.enabled === false) return; // the bot says nothing in a group it no longer serves
    const failure = [...task.recent].reverse().find(run => run.status === 'failed' || run.by === 'crash');
    const why = (failure?.error ?? '运行中 Bot 进程退出了').replace(/。$/, '');
    const { name } = task.createdBy, openId = project.dm ? undefined : task.createdBy.openId;
    // Feishu's post format reads a text element as plain text (not tried here); the name is anybody's words, so no tag
    // stays in it either way.
    const head = `定时任务「${plainTaskName(task.name)}」连续 10 次失败，已自动暂停。`;
    const named = name && !openId && !project.dm ? `${plainTaskName(name)} ` : '';
    const tail = `${named}看一下：${why}。${project.dm ? '跟我说一声，或者到 Bot 页的"任务"里' : '到群设置的"任务"里'}能恢复。`;
    const row = openId ? [{ tag: 'text', text: head }, { tag: 'at', user_id: openId }, { tag: 'text', text: ` ${tail}` }] : [{ tag: 'text', text: head + tail }];
    await sayInMain(task.chatId, { post: { zh_cn: { content: [row] } } }, openId ? `${head}@${name ?? '创建人'} ${tail}` : head + tail);
  }

  /** Keep the bot's trust-boundary note before any subsequently woven history. */
  function weaveTurnRecordBlock(text: string, extra: Pick<TurnExtra, 'initiative' | 'wake'> | undefined, block: Parameters<typeof weaveRecordBlock>[1]): string {
    const note = extra?.wake ? BOT_WAKE_NOTE(extra.wake.name) : undefined;
    if (!note || !text.startsWith(note)) return weaveRecordBlock(text, block);
    return `${note}\n\n${weaveRecordBlock(text.slice(note.length).trimStart(), block)}`;
  }

  /**
   * Per-message context ingest: fold this message's attachments AND any quoted
   * message into the prompt text codex receives.
   *   - File attachments → a local-path manifest (codex has no native file input,
   *     so an upload is only visible as an on-disk path — see weaveFileManifest).
   *   - 引用消息 (quote reply) → the quoted message's content, pulled by id and
   *     PREPENDED as a fenced block (see context-weave.weaveQuote) so codex sees
   *     上文 the bare @ doesn't carry. Best-effort: a deleted/unreadable quote is
   *     skipped, never thrown.
   * Both are gated (messageHasFiles / replyToMessageId) so the common text path
   * stays await-free. The record block is woven separately in startReservedRun (it is
   * session-scoped, not per-message). Voice display metadata stays separate
   * from the woven agent input.
   */
  function ingestContext(msg: NormalizedMessage, text: string, extra?: Pick<TurnExtra, 'initiative' | 'wake' | 'scheduled'>, project?: Project): Promise<IngestedContext> {
    // A scheduled turn has no sender, attachment or quote: its text is the daemon's own (总设计 7.2).
    if (extra?.scheduled) return Promise.resolve({ text });
    return orderContext(msg.threadId ?? msg.chatId, () => ingestContextImpl(msg, text, extra, project));
  }
  async function ingestContextImpl(msg: NormalizedMessage, text: string, extra?: Pick<TurnExtra, 'initiative' | 'wake'>, project?: Project): Promise<IngestedContext> {
    names.learnMentions(msg.mentions);
    // Started first so the lookup overlaps the voice, file and quote fetches;
    // bounded, and undefined on failure (the block then says 某用户, as before).
    const senderNameP = extra?.wake ? Promise.resolve(extra.wake.name || undefined) : names.senderName(msg);
    const hintP = project && sessionModeOf(project) === 'smart'
      ? orStop(roster.load(msg.chatId), undefined)
        .then(() => AT_HINT_NOTE(otherBotNames(roster.peek(msg.chatId), { openId: channel.botIdentity?.openId, appId: channel.rawClient?.appId })))
        .catch(() => AT_HINT_NOTE([]))
      : undefined;
    const preparedVoice = voiceMessages.get(msg);
    // Successful voice already took the same escaping/command path as text.
    // Failed recognition retains its explicit audio fallback, never as a command.
    const ingested = preparedVoice
      ? { ...preparedVoice, text: preparedVoice.voice?.transcribed ? text : preparedVoice.text }
      : { text };
    let body = ingested.text;
    if (messageHasFiles(msg)) {
      const { files, failed } = await collectInboundFiles(channel, msg);
      // With text, the manifest ends with a line per file that did not download, and why (s14e).
      body = weaveFileManifest(text, files, failed);
      // A file-ONLY message whose download failed (oversize / Feishu reject /
      // transient) strips to '' — don't hand codex a blank turn (wasted run +
      // empty card). Tell it the attachment couldn't be read so it can say so.
      if (!body.trim()) {
        body =
          '用户发来一个附件，但没能下载下来（可能超过 50MB 上限或被飞书拒绝）。请告诉用户附件没读到，可以重发，或改为粘贴文本 / 发图片。';
      }
    }
    // In a topic, a message posted straight into it has parent_id = root_id (the
    // topic's first message); only a reply to another message in it is a quote
    // (e10). Outside topics a reply has parent = root = the replied message.
    if (msg.replyToMessageId && (!msg.threadId || msg.replyToMessageId !== msg.rootId)) {
      const quoted = await fetchQuotedMessage(channel, msg.replyToMessageId, names);
      body = weaveQuote(body, quoted);
    }
    // Identity weave (outermost within ingestContext): fold WHO sent this turn so
    // codex can match the roster (approve-gate) and @ them back. Covers both the
    // first-turn (startReservedRun) and mid-turn (handleTurn) paths.
    const senderName = (await senderNameP) ?? msg.senderName;
    body = weaveSender(body, { senderId: msg.senderId, senderName }, deliveryLagMs(msg), { bot: fromBot(msg) });
    const hint = await hintP;
    if (hint) body = `${hint}\n\n${body}`;
    // A turn the smart mode joined on its own (s25): a fixed line, never the judge model's reason, which was
    // written by a small model that read untrusted group messages (Rakazo 第二轮 5).
    if (extra?.initiative) body = `${INITIATIVE_NOTE}\n\n${body}`;
    if (extra?.wake) body = `${BOT_WAKE_NOTE(extra.wake.name)}\n\n${body}`;
    return { ...ingested, text: body };
  }

  /**
   * A turn in a session keyed by `sessionKey` — the topic's threadId (multi) or
   * the chatId (single, `flat`). steer/queue mid-turn; otherwise reserve + run.
   * `flat` = reply by quoting (no reply_in_thread / topic), for single groups.
   */
  function handleTurn(
    msg: NormalizedMessage, text: string, sessionKey: string, flat: boolean, project: Project | undefined, perm: TurnPerm,
    extra?: TurnExtra,
  ): Promise<void> {
    // No project = an unbound group: never run (or resume a session) with no
    // tier, which backends read as full access. Messages stop earlier; this
    // also covers the card-originated turns (👍 继续, 🔁 重试).
    if (refusedTurn(project, msg.chatId, extra) || dmShut(project, msg, extra)) return Promise.resolve();
    const source = extra?.burst ? burstTrigger(extra.burst) : msg;
    if (project?.dm && source.messageId === msg.messageId && resourceMessages.has(source) &&
      !extra?.initiative && !extra?.wake && !extra?.scheduled && !extra?.retry && extra?.replayText === undefined) {
      // A selection belongs to a real new turn. Steering text into somebody's existing tool scope cannot bind it.
      extra = {...extra, resourceSelected: true, queueOnly: true};
    }
    const required = requiredCodexTools(extra);
    const owner = active.get(sessionKey);
    return orderTurns(sessionKey, async () => {
      if (staleRetry(extra)) return;
      const running = active.get(sessionKey);
      if (required && running?.settled && !running.isGoal && missingCodexTools(required, await getSession(sessionKey), running.thread)) {
        await running.settled;
        if (shuttingDown) {
          const origin = originFor(msg, flat);
          if (origin) keepForResend(origin);
          return;
        }
      }
      const cancelled = [owner, running].find(state => state?.intakeCancelled);
      if (cancelled) {
        if (dropScheduled(extra, intakeStopped(cancelled)) || dropBotMessage(msg, 'intake-cancelled', '会话被停下了')) return;
        await channel.send(msg.chatId, { markdown: '排队期间会话已停止，请重发本条消息。' }, { replyTo: msg.messageId, replyInThread: !flat }).catch(() => undefined);
        return;
      }
      await prepareTurn(msg, text, sessionKey, flat, project, perm, extra);
    });
  }

  async function prepareTurn(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project: Project | undefined,
    perm: TurnPerm,
    extra?: TurnExtra,
  ): Promise<void> {
    // Mid-turn: steer (引导) or queue (排队).
    const existing = active.get(sessionKey);
    if (existing) {
      // 🎯 goal 会话不接外部输入（turns 由 codex 自续，queue 永远不被消费），
      // 入队只会在收尾被静默丢弃 —— 直接告知而不是黑洞。
      if (existing.isGoal) {
        await replyGoalBusy(msg, flat, extra);
        return;
      }
      // Download any images first (best-effort) so the steered/queued turn can
      // carry them. Awaited here — the session is already held by a running
      // turn, so there's no reservation race to protect; gated on
      // messageHasImages so the common text path stays await-free and fast.
      // A retry brings its own saved images instead.
      let pendingImages: Promise<string[] | undefined> = Promise.resolve(extra?.images);
      if (!extra?.images && messageHasImages(msg)) pendingImages = collectInboundImages(channel, msg);
      const [images, woven] = await Promise.all([pendingImages, ingestContext(msg, text, extra, project)]);
      if (existing.intakeCancelled) {
        if (dropScheduled(extra, intakeStopped(existing)) || dropBotMessage(msg, 'intake-cancelled', '会话被停下了')) return;
        await channel.send(msg.chatId, { markdown: '本条消息处理期间会话已停止，请重发。' }, { replyTo: msg.messageId, replyInThread: !flat }).catch(() => undefined);
        return;
      }
      // The turn may have finished while media downloaded — re-read the session.
      // If it's gone, start a fresh run (carrying what we already fetched).
      const cur = active.get(sessionKey);
      if (!cur) {
        startReservedRun(msg, woven.text, sessionKey, flat, project, perm, images, woven, extra?.summary ?? text, undefined, extra);
        return;
      }
      // A goal may have started while media downloaded — same prompt as above.
      if (cur.isGoal) {
        await replyGoalBusy(msg, flat, extra);
        return;
      }
      void trackTask(deliverPreparedTurn(msg, woven, images, extra?.summary ?? text, sessionKey, flat, project, perm, cur, extra)
        .catch((err) => { log.fail('intake', err); extra?.scheduled?.settle(scheduleFailed(extra.scheduled, err)); }));
      return;
    }

    startReservedRun(msg, text, sessionKey, flat, project, perm, extra?.images, undefined, extra?.summary, undefined, extra);
  }

  /** A 🔁 重试 whose session took newer input since: say so, queue nothing. */
  function staleRetry(extra?: TurnExtra): boolean {
    if (!extra?.retry || extra.retry.current()) return false;
    extra.retry.stale();
    return true;
  }

  /** Whether the group takes no turn now (see turnRefusal); a 🔁 重试 is told why. */
  function refusedTurn(project: Project | undefined, chatId: string, extra?: TurnExtra): boolean {
    const refused = turnRefusal(project, chatId);
    if (refused) extra?.retry?.refused(refused);
    // The gate let a scheduled run through, so the group changed since: a race (T2 4.2).
    if (refused) dropScheduled(extra, SCHEDULE_UPDATING);
    return refused !== undefined;
  }

  /** Past the door and removed since (dm-agent 3.3): the first gate said yes to someone the list no longer has. A task's run has its creator as sender. */
  function dmShut(project: Project | undefined, msg: NormalizedMessage, extra?: TurnExtra): boolean {
    if (!project?.dm || isAdmin(cfg, msg.senderId)) return false;
    log.info('intake', 'reject', { reason: 'dm-admin-removed', ref: msg.messageId.slice(-6) });
    dropScheduled(extra, SCHEDULE_UPDATING);
    return true;
  }

  // Keep preparation ordered, but do not pin the lane on an uncertain steer ACK.
  // Explicit stale-turn rejection may still requeue onto a replacement owner.
  async function deliverPreparedTurn(
    msg: NormalizedMessage, woven: IngestedContext, images: string[] | undefined, text: string,
    sessionKey: string, flat: boolean, project: Project | undefined, perm: TurnPerm, cur: ActiveState,
    extra?: TurnExtra,
  ): Promise<void> {
    // Already a line of the running turn's record block (see ActiveState.woven): not steered in again.
    if (wovenSkip(cur, msg) || recalledSkip(msg)) return;
    if (!extra?.queueOnly && !cur.scheduled && execOf(project).pendingPolicy === 'steer' && cur.run && cur.thread && cur.thread.supportsSteer !== false) {
      const tid = cur.run.turnId();
      if (tid) {
        const voiceReply = cur.voiceReply?.run === cur.run ? cur.voiceReply : undefined;
        const steerReply = cur.steerReply?.run === cur.run ? cur.steerReply : undefined;
        // Dropped before the RPC: once sent, the input may reach the model even
        // if the ACK is lost. Marked seen for the same reason, so the next
        // back-fill does not weave it again.
        dropRetries(sessionKey);
        markSeen(sessionKey, { id: msg.messageId, at: msg.createTime }, 'id', undefined, burstMarks(extra?.burst));
        try {
          entries?.noteSteer(cur.thread, { openId: msg.senderId, kind: askRequesterKind(msg) });
          await steerWithDeadline(cur.thread, { text: woven.text, images }, tid);
          extra?.attentionAcceptance?.accept();
          const split = steerReply?.accept(msg.messageId, woven.voice);
          if (!split && woven.voice) voiceReply?.add(woven.voice);
          log.info('intake', 'steer', { tid, images: images?.length ?? 0 });
          return;
        } catch (err) {
          log.warn('intake', 'steer-failed', { err: String(err) });
          if (!isRejectedSteer(err)) {
            void trackTask(channel.send(msg.chatId,
              { markdown: '⚠️ 本条消息的接收确认失败，可能已进入模型。为避免重复执行，未自动重投；请先核对本轮结果。' },
              { replyTo: msg.messageId, replyInThread: !flat }).catch(() => undefined));
            return;
          }
          // Refused outright, so it never reached the model: take the mark back.
          // Queued or run below, it is marked again once its turn starts.
          unmarkSeen(sessionKey, msg.messageId);
        }
      }
    }
    if (cur.intakeCancelled) {
      dropScheduled(extra, scheduleStopped());
      return;
    }
    // steer() awaited an RPC: the previous run may have ended, or a new
    // run/goal may now own this key. Re-enter the synchronous reservation
    // path so the input is queued on the current owner or starts a new run.
    // A pre-write rejection can race a dead consumer's terminal cleanup.
    if (cur.thread && !cur.thread.isAlive() && active.get(sessionKey) === cur) {
      active.delete(sessionKey);
      if (sessions.get(sessionKey) === cur.thread) sessions.delete(sessionKey);
    }
    startReservedRun(msg, woven.text, sessionKey, flat, project, perm, images, woven, text, undefined, extra);
  }

  /** Whether `msg` was recalled while it was prepared: it reached no session, so it is dropped (s15). */
  function recalledSkip(msg: NormalizedMessage): boolean {
    if (!recalled.has(msg.messageId)) return false;
    log.info('intake', 'reject', { reason: 'recalled', msgId: msg.messageId });
    return true;
  }

  /** Whether `msg` is a line of the record block `state`'s running turn carried (logged then). */
  function wovenSkip(state: ActiveState, msg: NormalizedMessage): boolean {
    if (!state.woven?.has(msg.messageId)) return false;
    log.info('intake', 'queued-seen-skipped', { msgId: msg.messageId });
    return true;
  }

  /** 🎯 goal 运行中收到消息的统一提示（goal 会话不入队，见 ActiveState.isGoal）。 */
  async function replyGoalBusy(msg: NormalizedMessage, flat: boolean, extra?: TurnExtra): Promise<void> {
    if (dropScheduled(extra, SCHEDULE_UPDATING) || dropBotMessage(msg, 'goal-busy', '会话在跑 /goal')) return;
    await channel
      .send(
        msg.chatId,
        { markdown: '🎯 目标运行中，消息不会进入会话；可在卡片上 **⏹ 终止** 或 **🎯 结束目标** 后重发。' },
        { replyTo: msg.messageId, replyInThread: !flat },
      )
      .catch(() => undefined);
    log.info('intake', 'goal-busy', { msgId: msg.messageId });
  }

  /**
   * Reserve `sessionKey` synchronously (before any await) so a second message
   * racing in through the SDK's per-chatId queue sees it and queues instead of
   * double-launching — including a message whose image download just finished
   * and discovered the prior run had ended (handleTurn's fall-through). The
   * synchronous check-then-set is the critical section; everything slow (image
   * download, thread resolution, the codex run) runs **detached** so onMessage
   * returns fast — holding the chatId queue would block sibling topics and the
   * ⏹ card-action (design: 话题=独立 session，应并行).
   */
  function startReservedRun(
    msg: NormalizedMessage,
    text: string,
    sessionKey: string,
    flat: boolean,
    project: Project | undefined,
    perm: TurnPerm,
    preloadedImages?: string[],
    preIngested?: IngestedContext,
    summaryText?: string,
    goal?: boolean,
    extra?: TurnExtra,
  ): void {
    // A goal title is the already-extracted objective. Ordinary turns retain
    // the SDK content type so merge-forward/media envelopes can be decoded
    // without applying broad regexes to normal user text.
    const titleSource: SessionTitleSource = goal
      ? { text, rawContentType: 'text' }
      : sessionTitleSourceFromMessage(msg, summaryText ?? text);
    if (refusedTurn(project, msg.chatId, extra) || dmShut(project, msg, extra)) return;
    // A retry re-checks here, in the same synchronous step that reserves it: a
    // message may have reserved the session while it waited.
    if (staleRetry(extra)) return;
    if (recalledSkip(msg)) return;
    // A scheduled turn's synthetic message is nobody's to answer after a restart (T2 4.2).
    const origin = extra?.scheduled ? undefined : originFor(msg, flat);
    const existing = active.get(sessionKey);
    if (existing) {
      // A /compact or /new holds the session: wait, then go through here again (s15).
      if (existing.deferred && !extra?.retry) {
        existing.deferred.push({ id: msg.messageId, at: msg.createTime, origin, go: () =>
          startReservedRun(msg, text, sessionKey, flat, project, perm, preloadedImages, preIngested, summaryText, goal, extra), early: () => {
          if (dropScheduled(extra, SCHEDULE_UPDATING) || dropBotMessage(msg, 'before-new', '会话换成了新的（/new）')) return;
          log.info('intake', 'reject', { reason: 'before-new', msgId: msg.messageId });
          void trackTask(channel.send(msg.chatId, { markdown: '⚠️ 这条在 `/new` 之前发的，新会话不带它，要问就再发一次。' },
            { replyTo: msg.messageId, replyInThread: !flat }).catch(() => undefined));
        } });
        log.info('intake', 'deferred', { msgId: msg.messageId });
        return;
      }
      // A goal can't co-run with (or queue behind) a turn on the same session —
      // it's an autonomous multi-turn run, not a follow-up. Tell the user and skip.
      if (goal) {
        void trackTask(channel
          .send(msg.chatId, { markdown: '当前会话有任务在跑，请等它结束后再发 `/goal`。' }, { replyTo: msg.messageId, replyInThread: !flat })
          .catch(() => undefined));
        return;
      }
      // A goal appeared in that window — its queue is never consumed, so prompt
      // instead of queueing (same as handleTurn's isGoal gate).
      if (existing.isGoal) {
        void trackTask(replyGoalBusy(msg, flat, extra));
        return;
      }
      // A current retry only starts as a fresh run: whatever holds the session
      // now is a /compact, /new or /resume.
      if (extra?.retry) {
        extra.retry.busy();
        return;
      }
      if (wovenSkip(existing, msg)) return;
      // A run appeared between handleTurn's check and here (we awaited an image
      // download) — queue onto it rather than launch a second turn. `text` is
      // already file-woven when preIngested (handleTurn's fall-through).
      existing.queue.push({
        input: { text, images: preloadedImages },
        voice: preIngested?.voice,
        titleSource,
        requesterOpenId: msg.senderId, requesterKind: askRequesterKind(msg),
        requesterName: senderWho(msg).name,
        requestedAt: msg.createTime || Date.now(),
        summary: stripFileTokens(summaryText ?? text).slice(0, 80) || undefined,
        seen: { id: msg.messageId, at: msg.createTime },
        ...(extra?.burst ? { burst: extra.burst, seenExtra: burstMarks(extra.burst) } : {}),
        origin,
        ...(extra?.initiative ? { initiative: true as const } : {}),
        wake: extra?.wake,
        feedback: extra?.feedback,
        ...memoryTriggerOf(msg, extra),
        ...(extra?.scheduled ? { scheduled: extra.scheduled } : {}),
      });
      dropRetries(sessionKey);
      extra?.attentionAcceptance?.accept();
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }
    const reserved: ActiveState = { queue: [], chatId: msg.chatId, requesterOpenId: msg.senderId, requesterKind: askRequesterKind(msg), smart: project && sessionModeOf(project) === 'smart', isGoal: goal, runLoop: true,
      ...(flat && !msg.threadId && !goal ? { triggerAt: msg.createTime } : {}),
      // A shutdown keeps it from now on, however long its preparation takes past the drain (review 260).
      ...(origin ? { inFlight: origin } : {}) };
    active.set(sessionKey, reserved);
    dropRetries(sessionKey);
    extra?.retry?.accepted();
    reserved.settled = trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // Goal runs use the OKR reaction (added at dispatch) as their only receipt,
      // not the ⏳/🫳 run-reaction lifecycle.
      const reaction = goal || extra?.scheduled ? undefined : runReaction(msg.messageId, !sema.hasFree());
      // Where a scheduled turn's card goes instead of its synthetic message (T2 4.2).
      const replyTo = extra?.scheduled ? landingOf(extra.scheduled) : msg.messageId;
      let launchOpts: LaunchOpts | undefined;
      try {
        const tIntake = Date.now();
        // ── 入站三路并行（M-1）── 飞书 API（图片下载 / 文件+引用织入）、本地
        // spawn（resolveThread）与话题上文拉取互不依赖，Promise.all 把串行 RTT
        // 全部重叠掉。失败语义与串行版一致：resolve/ingest/getSession 失败走外层
        // catch 终止本轮并回 ❌（Promise.all 自带对其余分支 rejection 的观察，
        // 不会产生 unhandled rejection）；images/history 内部 best-effort（吞错
        // 返回空），永不拖死其他路。
        // Images preloaded by handleTurn's fall-through, else fetch them now
        // (inside the detached run, after the synchronous reservation).
        const imagesP = preloadedImages
          ? Promise.resolve(preloadedImages)
          : messageHasImages(msg)
            ? collectInboundImages(channel, msg)
            : Promise.resolve(undefined);
        // File attachments / quoted message woven into the prompt. Skipped when
        // preIngested (handleTurn already wove them into `text`).
        const ingestP = preIngested ? Promise.resolve(preIngested) : ingestContext(msg, text, extra, goal ? undefined : project);
        let tResolveDone = tIntake;
        const moved = project?.dm && await followDmRow(sessionKey, msg.chatId, project);
        const resolveP = (moved ? Promise.resolve<ResolvedThread>({ thread: undefined, recreated: true, reason: 'provider-changed' }) : resolveThread(sessionKey, msg.chatId, {
          mode: perm.mode,
          network: perm.network, native: perm.native, readScope: perm.readScope,
        }, requiredCodexTools(extra))).then((r) => {
          tResolveDone = Date.now();
          return r;
        });
        // For an already-resumed session the high-water mark (lastSeenAt) tells us
        // which messages codex hasn't seen — a pure local read, NOT dependent on
        // resolveThread's outcome, so it rides the same Promise.all.
        const priorP = getSession(sessionKey);
        // 上文投机拉取（话题，或连续群的主区）：不等 resolveThread 的 codexEmpty，按已有
        // 水位翻页拉到水位为止（水位前有上次还没答完的别的 bot 卡片时，拉到最早那张；没有
        // 记录就按开场拉最近的），汇合后在本地按水位和已送达的 id 收敛成增量。只拉比触发
        // 消息早的，之后到的消息各自成轮或插话，不重复。不拉的情况：有记录但无水位（resume
        // 上来的旧会话，codex 已带历史，只在 recreated 罕见路径补拉）；开话题群的主区不留
        // 会话（3.5），也不拉。
        const topicId = goal ? undefined : msg.threadId;
        let place: 'topic' | 'main' | undefined;
        if (topicId) place = 'topic';
        else if (!goal && flat && !msg.threadId) place = 'main';
        const pullFor = (opts: Pick<PullOpts, 'stopAt' | 'enough'>): Promise<ThreadPull> => {
          const o = { before: msg.createTime || undefined, excludeMessageId: msg.messageId, names, ...opts };
          // Cut short by a shutdown, it fails: the turn will not run (launchRun), and the watermark stays.
          return orStop(topicId ? fetchThreadContext(channel, topicId, { ...o, keepId: msg.rootId }) : fetchChatContext(channel, msg.chatId, o),
            { messages: [], ok: false, complete: false });
        };
        const historyP: Promise<ThreadPull | undefined> = place
          ? priorP.then((p) =>
              p && p.lastSeenAt === undefined
                ? undefined
                : pullFor({ stopAt: p ? backfillFrom(p) : 0, ...(p?.lastSeenAt ? {} : { enough: OPENING_MAX + (p?.seen?.length ?? 0) }) }),
            )
          : Promise.resolve(undefined);
        // The group's topics: the topic's title for the header, the 引用行 and the
        // table (s14b). The registry never throws.
        const listP = place && topics ? topics.list(msg.chatId) : Promise.resolve([]);
        // A user-opened topic with no session yet: its opening's lookups need only the
        // group and the topic's first message, so they overlap the session start and
        // the model list (s14b). Never rejects; a recreated session does them later.
        const rootId = topicId && msg.rootId && msg.rootId !== msg.messageId ? msg.rootId : undefined;
        const isRoot = (m: ContextMessage) => m.messageId === rootId;
        const openingP = rootId
          ? priorP.then((p) => p ? undefined : topicOpening(msg, historyP.then((h) => h?.messages.find(isRoot)
            ?? orStop(fetchQuotedMessage(channel, rootId, names), undefined)), listP, project)).catch(() => undefined)
          : undefined;
        const [images, ingested, { thread: resolved, recreated, reason: recreateReason }, prior, specHistory, list] = await Promise.all([
          imagesP,
          ingestP,
          resolveP,
          priorP,
          historyP,
          listP,
        ]);
        const title = topicId ? list.find((t) => t.topicId === topicId)?.title : undefined;
        let firstText = ingested.text;
        let thread = resolved;
        let titleJobKey: string | undefined;
        const neverSeen = !thread;
        let model = prior?.model;
        let effort = prior?.effort;
        let modelCustom = prior?.modelCustom;
        // Match new-topic initialization for single-session groups. Older flat
        // sessions may also lack these fields; bind the next ordinary turn to
        // explicit defaults so the card describes what we actually request.
        if (!thread || (flat && !goal && !model)) {
          // The backend the session runs on: the record's (also when rebuilt in a new cwd), else the group's.
          const be = sessionBackendOf(prior, project);
          const prefer = modelPrefOf(project, be.id);
          const defaults = await pickGroupDefault(project, be, prefer);
          if (!model) {
            model = defaults.model;
            modelCustom = isCustomDefault(prefer, model);
          }
          effort ??= defaults.effort;
          if (prior) await patchSession(sessionKey, { model, effort, modelCustom });
        }
        // codex's history is EMPTY when the session is brand-new (neverSeen) OR a
        // resume failed and we fell back to a new thread (recreated) — both want
        // the opening woven, not just the delta.
        const codexEmpty = neverSeen || recreated;
        // A session that never spoke since a /new forgets nothing when it is rebuilt: no notice (s15).
        const unused = prior?.from !== undefined && (prior.lastSeenAt ?? 0) < prior.from && !prior.seen?.length;
        // 对话记录块：把 bot 还没喂给 codex 的消息补进这一轮。codexEmpty（新会话 /
        // resume 失败重建）→ 开场带最近 20 条，话题再加第一条；已有会话 → 只带没见过的
        // （水位之后、不是插话或排队送过的），最多 40 条。Goals skip the record block
        // (place=undefined above): the objective must stay self-contained (and under
        // codex's ~4000-char goal limit), and a resumed thread already carries codex's
        // own history.
        let pull = specHistory;
        let streaming: SeenMark[] = [];
        let woven: string[] | undefined;
        let seenExtra: SeenMark[] = [];
        let tableShown = false;
        let openFrom: number | undefined;
        // A rebuilt session's opening goes back no further than the old one's `from`:
        // after a /new, nothing before the command (s15).
        const floor = codexEmpty ? prior?.from ?? 0 : 0;
        // Recalled messages the session got are said once (s15); a rebuilt one never had them.
        const notes = place && !codexEmpty ? prior?.recalls ?? [] : [];
        const recalls = recallLines(notes);
        if (place && codexEmpty && prior && prior.lastSeenAt !== 0) {
          // The speculative pull stopped at the old session's watermark (or was
          // skipped): the new session needs the whole opening.
          pull = await pullFor({ enough: OPENING_MAX, ...(floor ? { stopAt: floor } : {}) });
        }
        if (place && pull) {
          let history = codexEmpty
            ? pull.messages.filter((m) => m.createTime >= floor)
            : pull.messages.filter((m) => isUnread(prior, m.messageId, m.createTime));
          if (extra?.burst) history = history.filter((m) => !extra.burst!.msgs.some((line) => line.messageId === m.messageId));
          const spec = codexEmpty ? await openingP : undefined;
          if (codexEmpty && rootId && !history.some(isRoot)) {
            // The topic's first message is no longer re-quoted every turn, so a new
            // session gets it here once, even when the listing leaves it out.
            const root = spec ? spec.root : await orStop(fetchQuotedMessage(channel, rootId, names), undefined);
            if (root) history = [root, ...history];
          }
          const kept = keepRecent(history, codexEmpty ? rootId : undefined, codexEmpty ? OPENING_MAX : BACKFILL_MAX);
          const earlier = pull.complete ? history.length - kept.length : 'some';
          const now = msg.createTime || Date.now();
          // Another bot's card still streaming is woven as not done, and read again
          // next turn for its final answer (3.5), for ten minutes; one that never
          // finishes is then taken as it was.
          streaming = kept
            .filter((m) => m.streaming && now - m.createTime < STREAMING_RECHECK_MS)
            .map((m) => ({ id: m.messageId, at: m.createTime }));
          woven = kept.map((m) => m.messageId);
          const root = rootId ? history.find(isRoot) : undefined;
          let topicsPart: Pick<RecordBlock, 'opening' | 'quotes' | 'moreTopics' | 'table' | 'refs'> = {};
          let openingLog = {};
          if (place === 'main') {
            // 引用行 for topics opened since the session last spoke (a new one: since its
            // oldest line), each sent once; after a compaction, the recent topics too.
            const known = await topicCtx.quotable(msg.chatId, list);
            // This bot's own replies are not woven, but another bot's topic under one
            // sends no event, so they are looked at too (s14c).
            const from = kept[0]?.createTime ?? floor;
            const mine = (pull.ownRoots ?? []).filter((m) => m.createTime >= from && (codexEmpty || isUnread(prior, m.messageId, m.createTime)));
            const roots = [...kept, ...mine].sort((a, b) => a.createTime - b.createTime);
            const found = await orStop(topicCtx.discover(msg.chatId, roots, knownIds(known)), []);
            const since = codexEmpty ? undefined : prior?.lastSeenAt;
            const skip = codexEmpty ? undefined : (t: TopicView) => isDelivered(prior, t.topicId);
            const { quotes, more } = topicQuotes([...known, ...found],
              { ...(since ? { after: since } : { from }), to: now, skip }, names);
            const table = thread && topicsDueFor(sessionKey, msg.chatId, prior, thread.sessionId) ? topicRows(list.slice(0, 5), names) : [];
            topicsPart = { quotes, moreTopics: more, table, refs: mine };
            seenExtra = quotes.map((q) => ({ id: q.topicId, at: q.at }));
            tableShown = table.length > 0;
          } else if (codexEmpty && rootId) {
            const opening = spec && spec.root === root ? spec : await topicOpening(msg, Promise.resolve(root), Promise.resolve(list), project);
            ({ part: topicsPart, log: openingLog } = opening);
          }
          firstText = weaveTurnRecordBlock(firstText, extra, {
            place: { group: project?.name, me: channel.botIdentity?.name, ...(topicId ? { topic: { title: title ?? topicTitle(root?.text) } } : {}) },
            entries: kept,
            earlier,
            now,
            rootId,
            ...topicsPart,
            recalls,
          });
          // The oldest line the new session got (s15), the trigger without one.
          const times = [...kept, ...topicsPart.opening?.main ?? []].map((m) => m.createTime).filter((t) => t > 0);
          if (codexEmpty && pull.ok) openFrom = Math.min(now, ...times, ...burstMarks(extra?.burst).map((mark) => mark.at));
          log.info('intake', 'record-block', { place, lines: kept.length, earlier, opening: codexEmpty, ok: pull.ok, streaming: streaming.length,
            quotes: topicsPart.quotes?.length ?? 0, moreTopics: topicsPart.moreTopics ?? 0, table: topicsPart.table?.length ?? 0,
            ownRoots: topicsPart.refs?.length ?? 0, recalls: recalls.length, ...openingLog });
        } else if (place && recalls.length) {
          // No back-fill (a resumed session without a watermark): a block with the notes only.
          const header = { group: project?.name, me: channel.botIdentity?.name, ...(topicId ? { topic: { title } } : {}) };
          firstText = weaveTurnRecordBlock(firstText, extra, { place: header, entries: [], now: msg.createTime || Date.now(), recalls });
          log.info('intake', 'record-block', { place, lines: 0, recalls: recalls.length });
        }
        // The watermark moves to the trigger only when everything before it reached
        // the session: the back-fill succeeded, or there is none (a resumed
        // session, or a multi group's main area, which keeps no session). After a
        // failed back-fill, or a goal (no record block woven), only the trigger
        // counts; a new session then restarts from 0 so its next turn pulls the
        // whole opening. The cards still streaming are recorded with an advance
        // (session-store's `streaming`). Written once the host accepts the turn
        // (launchRun), not here.
        const behind = place ? Boolean(pull && !pull.ok) : Boolean(goal && (msg.threadId || flat));
        let seenHow: SeenHow = 'advance';
        if (behind) seenHow = codexEmpty ? 'restart' : 'id';
        const seenMark: SeenMark = { id: msg.messageId, at: msg.createTime };
        if (!thread) {
          // Unknown session (created before this bridge, or store lost): treat as
          // a fresh session bound to the resolved cwd, on the project's backend.
          // Rebuilt after the cwd changed: the record's backend, as its model is (s36d2).
          const cwd = workCwd(project);
          const be = sessionBackendOf(prior, project);
          const freshSpeed = await reconcileStoredSpeed(be, sessionKey, cwd, model, prior?.serviceTier);
          const savedSpeed = prior ? (await getSession(sessionKey))?.serviceTier : undefined;
          thread = await startWith(be, { cwd, model, effort, serviceTier: freshSpeed, mode: perm.mode, network: perm.network, native: perm.native, readScope: perm.readScope, profile: await profileOf(project, cwd, be, perm.mode) }, sessionPlace(project, msg.chatId));
          trackSession(sessionKey, thread);
          // 自愈观测：来源=全新会话（无持久化记录），与 resume-ok/resume-recreate
          // 互斥——三者其一 + agent 层的 spawn/prewarm-hit 即可还原完整恢复路径。
          log.info('agent', 'session-fresh', { sessionKey, sessionId: thread.sessionId, backend: be.id });
          titleJobKey = await registerSessionTitle(be, thread.sessionId, cwd, titleSource);
          await upsertSession({
            threadId: sessionKey,
            chatId: msg.chatId,
            cwd,
            sessionId: thread.sessionId,
            backend: be.id,
            titleJobKey,
            model,
            effort,
            serviceTier: savedSpeed,
            modelCustom,
            // `text` is already file-woven when preIngested; use the raw
            // `summaryText` (handleTurn's original) so the session label isn't
            // manifest boilerplate + a temp path.
            summary: stripFileTokens(summaryText ?? text).slice(0, 80),
            // Nothing reached it yet; the trigger is marked once the turn starts.
            ...nothingSeen(),
            ...sessionFields(thread),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        } else if (recreated) {
          // resume 失败后创建的是一个全新的 HOST 会话；它属于升级后的新会话，
          // 应独立登记标题任务（旧 sessionId 的 ledger/标题绝不复用）。
          const be = sessionBackendOf(prior, project);
          const cwd = workCwd(project, prior);
          titleJobKey = await registerSessionTitle(be, thread.sessionId, cwd, titleSource);
          // Full replacement drops the old session's titleJobKey even if title
          // registration failed; carrying it across would let a later turn attach
          // source to the wrong native session.
          if (prior) {
            await upsertSession({
              ...prior,
              // A new native session: the old watermark does not cover it.
              ...nothingSeen(),
              ...sessionFields(thread),
              model,
              effort,
              modelCustom,
              cwd,
              sessionId: thread.sessionId,
              backend: be.id,
              ...(titleJobKey ? { titleJobKey } : { titleJobKey: undefined }),
              updatedAt: Date.now(),
            });
          }
        } else {
          // `/clear` 先创建一个没有首条提问的 waiting_source job；只有它能在
          // 此处被补源。手动 `/resume` 没有 ledger row，attach 返回 false，因而
          // 不会给导入/历史会话自动改名。
          const be = sessionBackendOf(prior, project);
          const expected = sessionTitleJobKey(be.id, thread.sessionId);
          if (prior?.titleJobKey === expected) {
            await attachSessionTitleSource(be.id, thread.sessionId, titleSource);
            // Even when the source was attached by an earlier run that got
            // cancelled before runStreamed, carry the durable key forward so
            // this first actually-issued turn can activate it.
            titleJobKey = expected;
          }
        }
        reserved.thread = thread;
        // A settings change closed the session while this turn was being prepared (evictLiveSessionsForChat cannot see a
        // reservation's thread yet): a scheduled turn queued behind it is skipped, as after the run's own eviction. This
        // turn still runs on it (T2 做法).
        if (sessions.get(sessionKey) !== thread) reserved.evicted = true;
        launchOpts = {
          smart: project && sessionModeOf(project) === 'smart' ? true : undefined,
          attentionAcceptance: extra?.attentionAcceptance,
          chatId: msg.chatId,
          replyTo,
          origin,
          replyInThread: !flat,
          flat,
          thread,
          model,
          effort,
          firstText,
          voice: ingested.voice,
          images,
          knownThreadId: sessionKey,
          // The run's cwd: the project directory the agent works in. MUST be
          // carried here — it is also what resolves a reply's relative
          // `![](images/plot.png)` before upload, and what gets persisted as this
          // session's cwd. Omitting it silently fell back to the bridge process's
          // own cwd (the launchd service has none → `/`), so every relative image
          // ref was resolved against `/` and rejected as image-outside-cwd.
          cwd: workCwd(project, prior),
          mode: perm.mode,
          network: perm.network, native: perm.native, readScope: perm.readScope,
          // The backend resolveThread routed by: the record's, else the project's.
          backendId: sessionBackendOf(prior, project).id,
          serviceTier: prior?.serviceTier,
          summary: stripFileTokens(summaryText ?? text).slice(0, 80) || '(本轮任务)',
          requesterOpenId: msg.senderId, requesterKind: askRequesterKind(msg),
          requesterName: senderWho(msg).name,
          requestedAt: msg.createTime || tIntake,
          replayText: extra?.replayText,
          seen: seenMark,
          seenHow,
          streaming,
          woven,
          seenExtra: [...seenExtra, ...burstMarks(extra?.burst)],
          tableShown,
          recallsShown: notes.map((r) => r.id),
          from: openFrom,
          // 编织完成 → turn/start 之间不再读盘：首轮直接用预取的会话记录
          // （新会话及旧单会话的缺失值由上面的 model/effort 补齐）。
          firstRec: prior ?? null,
          titleJobKey,
          titleSource,
          timing: { tResolve: tResolveDone - tIntake, tWeave: Date.now() - tIntake },
          ...(recreateReason && !unused ? { sessionNotice: sessionChangeNotice(recreateReason, Boolean(topicId)) } : {}),
          ...(extra?.initiative ? { initiative: true as const } : {}),
          wake: extra?.wake,
          feedback: extra?.feedback,
          ...memoryTriggerOf(msg, extra),
          ...(extra?.scheduled ? { scheduled: extra.scheduled } : {}),
        };
        if (recreateReason) log.info('agent', 'session-changed', { sessionKey, reason: recreateReason, ...(unused ? { unused } : {}) });
        if (goal) await trackRun(launchGoalRun(launchOpts));
        else await trackRun(launchRun(launchOpts, reaction));
      } catch (err) {
        if (active.get(sessionKey) === reserved) active.delete(sessionKey);
        releaseIdle(sessionKey, sessions.get(sessionKey));
        const dropped = askAgain(reserved.queue.splice(0), msg.chatId, flat ? 'main' : 'topic', 'run-failed', '前一轮出错，排队的没跑');
        dropCompact(reserved);
        reaction?.done();
        log.fail('intake', err);
        // Stopping: the shutdown's, not this turn's failure, as in launchRun (settleGone); the shutdown took the queue.
        if (shuttingDown) {
          if (extra?.scheduled) extra.scheduled.settle(scheduleStopped());
          else if (origin) keepForResend(origin);
          return;
        }
        if (!goal) noteFailure(msg, flat ? 'main' : 'topic', launchOpts?.backendId ?? groupBackend(project).id, { error: err });
        if (extra?.scheduled) extra.scheduled.settle(scheduleFailed(extra.scheduled, err));
        await channel
          .send(msg.chatId, { markdown: runFailureMessage(err, dropped, launchOpts?.sessionNotice) }, { replyTo, replyInThread: !flat })
          .catch(() => undefined);
      }
    }));
  }

  /** The main area's last lines before an opening's first message: 10, with this bot's own. */
  function pullMainBefore(chatId: string, before: number, excludeMessageId: string): Promise<ThreadPull> {
    return orStop(fetchChatContext(channel, chatId, { before, excludeMessageId, enough: OPENING_MAIN_MAX, names, keepSelf: true }),
      { messages: [], ok: false, complete: false });
  }

  /** An opening's main-area section: its lines and the 引用行 among them,
   * with the topics other bots opened there found first. */
  async function mainSection(chatId: string, pull: ThreadPull, list: TopicView[], to: number, exclude: string | undefined) {
    const main = pull.ok ? keepRecent(pull.messages, undefined, OPENING_MAIN_MAX) : [];
    const known = await topicCtx.quotable(chatId, list);
    const found = await orStop(topicCtx.discover(chatId, main, knownIds(known)), []);
    const { quotes, more } = topicQuotes([...known, ...found], { from: main[0]?.createTime ?? 0, to, exclude }, names);
    return { main, quotes, moreTopics: more };
  }

  /**
   * A user-opened topic session's opening (product.md 3.5, s14b): a pointer to
   * the message the topic hangs under, and the main area's 10 lines before it
   * with the 引用行 among them; in a single group the pointer names the main
   * session. A topic group has no main area: none of it. Each
   * lookup starts once its inputs (the first message, the group's topics) arrive.
   */
  async function topicOpening(msg: NormalizedMessage, rootP: Promise<ContextMessage | undefined>, listP: Promise<TopicView[]>, project: Project | undefined) {
    const mainRecP = project && ruleKind(project) === 'single' ? getSession(msg.chatId).catch(() => undefined) : undefined;
    // The group's mode first (cached), so a topic group pulls no main area.
    const [noMain, root] = await Promise.all([orStop(topicCtx.noMainArea(msg.chatId), false), rootP]);
    if (noMain) return { root, part: {}, log: { topicGroup: true } };
    const pull = root?.createTime ? await pullMainBefore(msg.chatId, root.createTime, root.messageId) : undefined;
    const section = pull && root ? await mainSection(msg.chatId, pull, await listP, root.createTime, msg.threadId) : { main: [] };
    const mainRec = await mainRecP;
    const pointer = {
      ...(root ? { root: { at: root.createTime, who: { kind: root.from, name: root.senderName } } } : {}),
      ...(mainRec?.sessionId ? { mainSessionId: mainRec.sessionId } : {}),
    };
    const { main, ...quoted } = section;
    return {
      root,
      part: { opening: { pointer, main }, ...quoted },
      log: { pointer: true, mainLines: main.length, mainSession: Boolean(pointer.mainSessionId), topicGroup: false, mainOk: pull?.ok ?? false },
    };
  }

  /**
   * Whether a live thread's session was written by something else since it last looked
   * (s15b, product.md 3.5 D6). A check that fails counts as not written: the turn goes on
   * with the live thread, as before s15b.
   */
  async function writtenElsewhere(threadId: string, live: AgentThread): Promise<boolean> {
    if (!live.checkNative) return false;
    try {
      const { foreign } = await live.checkNative();
      if (foreign) log.info('agent', 'native-changed', { threadId, sessionId: live.sessionId });
      return foreign;
    } catch (err) {
      log.fail('agent', err, { phase: 'native-check', threadId });
      return false;
    }
  }

  /** Reuse a LIVE thread only while its bound permission fingerprint still matches.
   * Always reread the group: the caller's permission snapshot may predate a save,
   * and an in-flight provider start may not have been visible to that save's eviction.
   *
   * Returns `recreated: true` ONLY when the stored session can't be continued:
   * the resume FAILED and we fell back to a brand-new codex thread (`reason:
   * 'resume-failed'`), or the project's cwd changed and the caller must start
   * one in the new directory (`thread: undefined`, `reason: 'cwd-changed'`).
   * Either way the history is empty, so the caller re-feeds full topic context
   * (not just the delta) and tells the user on the run card. Otherwise an
   * `undefined` thread means "never seen" (caller starts + persists it fresh). */
  async function resolveThread(
    threadId: string,
    chatId: string,
    perm: TurnPerm,
    required?: ToolRefresh,
  ): Promise<ResolvedThread> {
    let project: Project | undefined;
    const live = sessions.get(threadId);
    if (live) {
      if (live.isAlive()) {
        const elsewhere = await writtenElsewhere(threadId, live);
        const prior = elsewhere ? undefined : await getSession(threadId).catch(() => undefined);
        project = await getProjectByChatId(chatId);
        if (project) perm = turnPerm(project);
        const permissionChanged = threadPermissions.get(live) !== permissionFingerprint(perm);
        // Evicted while it looked (a tier change, the reaper): resume below like any other.
        if (sessions.get(threadId) === live && live.isAlive()) {
          if (!elsewhere && !permissionChanged && !missingCodexTools(required, prior, live)) {
            noteCompaction(threadId, chatId, live, prior);
            return { thread: live, recreated: false };
          }
          // Someone else wrote the session (a terminal turn or /compact, s15b): this
          // process never rereads it, so reconnect from the file below.
          sessions.delete(threadId);
          if (required && missingCodexTools(required, prior, live)) {
            await closeForPermission(live);
            lastUsage.delete(threadId);
            return {thread: undefined, recreated: true, reason: required};
          }
          if (permissionChanged) await closeForPermission(live);
          else void trackTask(live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
        }
      } else {
        // app-server 子进程已死（崩溃/被 kill）：死线程留在缓存只会反复失败，
        // 清掉让它落入下面既有的 resume-or-recreate 兜底（持久化的 sessionId
        // 还在，话题自愈而不是僵死到重启）。
        sessions.delete(threadId);
        log.info('agent', 'dead-thread-evict', { threadId });
        // Closed all the same: its entry, and the session's token with it, ends (devices 5.3).
        void trackTask(live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
      }
    }
    const rec = await getSession(threadId);
    if (!rec) return { thread: undefined, recreated: false };
    // Route by the RECORD's backend — the backend that created the session (old
    // v1 records read back as the codex default). A project switching backends
    // later must not strand existing sessions on the wrong runtime; the project
    // is still consulted for cwd / tier defaults on the recreate path below.
    project = await getProjectByChatId(chatId);
    if (project) perm = turnPerm(project);
    if (project && rec.cwd !== project.cwd) {
      lastUsage.delete(threadId); // a new session: the meter starts over
      return { thread: undefined, recreated: true, reason: 'cwd-changed' };
    }
    const be = backendFor(rec.backend);
    await waitReleased(threadId);
    const resumedSpeed = await reconcileStoredSpeed(be, threadId, rec.cwd, rec.model, rec.serviceTier);
    try {
      const resumeProfile = await profileOf(project, rec.cwd, be, perm.mode);
      const resumed = await resumeWith(be, {
        cwd: rec.cwd,
        sessionId: rec.sessionId,
        profile: resumeProfile,
        model: rec.model,
        effort: rec.effort,
        serviceTier: resumedSpeed,
        mode: perm.mode,
        network: perm.network, native: perm.native, readScope: perm.readScope,
      }, sessionPlace(project, chatId));
      if (resumed.sessionId !== rec.sessionId) {
        const freshProfile=profileUsed.get(resumed);
        const opening=freshProfile && openings.get(freshProfile);
        if (opening) contextDelivered.set(resumed,opening);
        await patchSession(threadId,{sessionId:resumed.sessionId,context:opening,...sessionFields(resumed),usage:undefined});
        trackSession(threadId,resumed);lastUsage.delete(threadId);
        return {thread:resumed,recreated:false};
      }
      if (required && missingCodexTools(required, rec)) {
        // Resume first so an active native writer can still refuse. A new thread gets recent Feishu history via the ordinary recreation path.
        await closeForPermission(resumed);
        lastUsage.delete(threadId);
        return {thread: undefined, recreated: true, reason: required};
      }
      trackSession(threadId, resumed);
      // The opening handed to a resumed session carries a new mark. Claude takes its system append again on resume, so that
      // opening is what it now holds (the record's mark stays accepted); Codex keeps the instructions it was started with,
      // so it keeps the record's context and also accepts the mark of the opening that was built.
      const reopenedProfile = profileUsed.get(resumed) ?? resumeProfile;
      const reopened = reopenedProfile ? openings.get(reopenedProfile) : undefined;
      if (reopened) {
        if (!hiddenBlocksFor(be.id)) {
          const context: SessionContext = { ...reopened, previousNonces: [...new Set(acceptedNonces(rec.context))].slice(0, 6) };
          contextDelivered.set(resumed, context);
          void trackTask(patchSession(threadId, { context }).catch(() => undefined));
        } else if (rec.context) {
          contextDelivered.set(resumed, { ...rec.context, previousNonces: [...new Set([...(rec.context.previousNonces ?? []), reopened.nonce])].slice(0, 6) });
        }
      }
      // 自愈观测：resume 来源=持久化记录（区分「resume 自愈」与 LIVE 快路径的
      // 普通续轮——后者不经过这里，stream.timing 的 tResolve≈0 是它的指纹）。
      log.info('agent', 'resume-ok', { threadId, sessionId: rec.sessionId, backend: be.id });
      noteCompaction(threadId, chatId, resumed, rec);
      return { thread: resumed, recreated: false };
    } catch (err) {
      log.fail('agent', err, { phase: 'resume-on-turn', threadId });
      // Open in a terminal or the Codex app (s15b): say so and keep the session.
      if (err instanceof SessionInUseError || err instanceof CodexWorkspaceLayoutError || err instanceof ThreadPermissionChanged || err instanceof CodexServiceTierError) throw err;
      const cwd = workCwd(project, rec);
      const fresh = await startWith(be, {
        cwd,
        profile: await profileOf(project, cwd, be, perm.mode),
        model: rec.model,
        effort: rec.effort,
        serviceTier: resumedSpeed,
        mode: perm.mode,
        network: perm.network, native: perm.native, readScope: perm.readScope,
      }, sessionPlace(project, chatId));
      trackSession(threadId, fresh);
      lastUsage.delete(threadId);
      // The resumed codex thread is gone — repoint the persisted record at the
      // new thread id so a later restart doesn't keep resuming the dead one.
      await patchSession(threadId, { sessionId: fresh.sessionId, ...sessionFields(fresh) }).catch(() => undefined);
      // 自愈观测：resume 失败已重建全新线程（codex 历史为空，调用方会回灌话题上文）。
      log.info('agent', 'resume-recreate', { threadId, sessionId: fresh.sessionId, backend: be.id });
      return { thread: fresh, recreated: true, reason: 'resume-failed' };
    }
  }

  /**
   * Close every LIVE codex thread under `chatId` so a permission-tier change
   * actually rebinds. The codex sandbox is fixed at thread/start|resume and is
   * immutable for the thread's life — so an already-running 'full' thread would
   * keep full-disk read access even after the admin switches the project to
   * read-only (the card would claim read-only while the runtime stays full
   * access, reading ~/.ssh etc.). Evicting forces the next turn's resolveThread
   * to re-resume under the new tier (or fail-closed where it can't be enforced).
   */
  async function evictLiveSessionsForChat(chatId: string): Promise<void> {
    let closed = 0;
    for (const rec of await listSessions()) {
      if (rec.chatId !== chatId) continue;
      const live = sessions.get(rec.threadId);
      if (!live) continue;
      const running = active.get(rec.threadId);
      if (running?.thread === live) running.evicted = true;
      sessions.delete(rec.threadId); // synchronous: next turn can't reuse it
      void trackTask(live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
      closed++;
    }
    if (closed) log.info('console', 'tier-evict', { chatId, closed });
  }

  /** Group @bot (no topic): create the topic + run with the default model.
   * Detached — onMessage must return fast (see {@link handleTurn}); a new
   * topic has a unique reply target so no same-topic reservation is needed.
   * `under`: the earlier line the smart mode opens it on instead (s25b). */
  function startTopicDirectly(msg: NormalizedMessage, text: string, project?: Project, goal?: boolean, extra?: Pick<TurnExtra, 'initiative' | 'wake' | 'attentionAcceptance' | 'feedback'>, under?: RecentLine): void {
    // When this start ends, the registry or Feishu knows the topic under that line, or it did not open (anchorLine put it in).
    const opened = (): void => { if (under) openingUnder.delete(under.id); };
    if (resumePublications.has(msg.chatId) || projectMutations.has(msg.chatId)) {
      opened();
      noteNotReplied(msg, 'group-updating');
      return;
    }
    pendingTopics.set(msg.chatId, (pendingTopics.get(msg.chatId) ?? 0) + 1);
    const titleSource: SessionTitleSource = goal
      ? { text, rawContentType: 'text' }
      : sessionTitleSourceFromMessage(msg, text);
    void trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // 🫳 Typing on receive (⏳ OneSecond if a slot isn't free) → ✅ DONE once
      // the topic is created (onTopicCreated, below). For this path the acked
      // action is "建话题", not the full reply — so DONE fires on first card,
      // unlike an in-topic turn (see handleTurn). Goal runs skip this lifecycle —
      // the OKR reaction (added at dispatch) is their receipt.
      const reaction = goal ? undefined : runReaction(msg.messageId, !sema.hasFree());
      const cwd = workCwd(project);
      const perm = turnPerm(project);
      // lazy banner branch refresh (design §3.2) — best-effort, non-blocking
      if (project) void trackTask(refreshBranch(channel, project).catch(() => undefined));
      // Pick the default model FROM THE PROJECT'S BACKEND — a claude project must
      // not be handed codex's default ('gpt-5.5'). Unset backend → codex, as before.
      const be = groupBackend(project);
      const prefer = modelPrefOf(project, be.id);
      // ── 入站并行（M-1）── listModels+startThread（本地 spawn，实测 250ms–1.6s）
      // 与图片下载 / 文件+引用织入（飞书 API）互不依赖。任何一路失败都终止本轮
      // 并回 ❌（原先 ingest 失败只进日志、reaction 卡死——顺带修正），但已起的
      // 进程必须回收：它还不在 sessions 里，不关就是孤儿 app-server。
      const tIntake = Date.now();
      let tResolveDone = tIntake;
      const threadP = (async () => {
        const { model, effort } = await pickGroupDefault(project, be, prefer);
        const thread = await startWith(be, { cwd, model, effort, serviceTier: 'standard', mode: perm.mode, network: perm.network, native: perm.native, readScope: perm.readScope, profile: await profileOf(project, cwd, be, perm.mode) }, sessionPlace(project, msg.chatId));
        tResolveDone = Date.now();
        return { thread, model, effort };
      })();
      // Download any attached/forwarded images so the opening turn can see them,
      // and any file attachments (their paths get woven into the prompt text).
      const imagesP = messageHasImages(msg) ? collectInboundImages(channel, msg) : Promise.resolve(undefined);
      const ingestP = ingestContext(msg, text, extra, goal ? undefined : project);
      // The opening's main-area lines before the trigger and the 引用行 among them
      // (not for a goal: its objective stays self-contained). Never rejects.
      const listP = !goal && topics ? topics.list(msg.chatId) : Promise.resolve([]);
      const sectionP = goal ? undefined : Promise.all([pullMainBefore(msg.chatId, msg.createTime, msg.messageId), listP])
        .then(async ([pull, list]) => ({ pull, ...await mainSection(msg.chatId, pull, list, msg.createTime, undefined) }));
      let thread: AgentThread;
      let model: string;
      let effort: ReasoningEffort;
      let images: string[] | undefined;
      let firstText: string;
      let voiceReply: VoiceReply | undefined;
      let section: Awaited<typeof sectionP>;
      try {
        const [started, imgs, ingested, opened] = await Promise.all([threadP, imagesP, ingestP, sectionP]);
        ({ thread, model, effort } = started);
        images = imgs;
        firstText = ingested.text || '你好，我们开始吧。';
        voiceReply = ingested.voice;
        section = opened;
      } catch (err) {
        reaction?.done();
        // Keep the project reserved until any delayed backend process has closed.
        await threadP.then((s) => s.thread.close()).catch(error => log.fail('agent', error, { phase: 'unadopted-thread-close' }));
        log.fail('card', err, { phase: 'start-topic' });
        if (!goal) noteFailure(msg, 'topic', be.id, { error: err });
        await channel
          .send(msg.chatId, { markdown: `❌ 启动失败：${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
        return;
      }
      // Recalled while this was prepared: the topic opens on the message after all.
      const anchor = under && !recalled.has(under.id) ? under : undefined;
      if (section) {
        // The bot-opened topic's opening (s14b): where it hangs, and the main area before it.
        const { pull, main, quotes, moreTopics } = section;
        firstText = weaveTurnRecordBlock(firstText, extra, {
          place: { group: project?.name, me: channel.botIdentity?.name, topic: { title: topicTitle(anchor?.text ?? msg.content) } },
          entries: [],
          now: msg.createTime || Date.now(),
          opening: { pointer: { botOpened: true, ...(anchor
            ? { earlier: true, root: { at: anchor.at, who: { kind: 'user', name: anchor.name } } }
            : { root: { at: msg.createTime, who: senderWho(msg) } }) }, main },
          quotes,
          moreTopics,
        });
        log.info('intake', 'record-block', { place: 'topic', lines: 0, opening: true, botOpened: true, ok: pull.ok,
          pointer: true, mainLines: main.length, quotes: quotes.length, moreTopics });
      }
      log.info('card', 'start', { project: project?.name ?? '(unregistered)', model, effort, images: images?.length ?? 0, goal: Boolean(goal) });
      const titleJobKey = await registerSessionTitle(be, thread.sessionId, cwd, titleSource);
      if (project) {
        const current = await getProjectByChatId(project.chatId);
        if (!current || current.enabled === false || projectRevision(current) !== projectRevision(project)) {
          await thread.close();
          reaction?.done();
          return;
        }
      }
      const launchOpts: LaunchOpts = {
        smart: project && sessionModeOf(project) === 'smart' ? true : undefined,
        attentionAcceptance: extra?.attentionAcceptance,
        chatId: msg.chatId,
        replyTo: anchor?.id ?? msg.messageId,
        triggerId: msg.messageId,
        origin: originFor(msg, false),
        replyInThread: true,
        thread,
        firstText,
        voice: voiceReply,
        images,
        model,
        effort,
        serviceTier: 'standard',
        modelCustom: isCustomDefault(prefer, model),
        cwd,
        mode: perm.mode,
        network: perm.network, native: perm.native, readScope: perm.readScope,
        summary: stripFileTokens(text).slice(0, 80) || '(空)',
        requesterOpenId: msg.senderId, requesterKind: askRequesterKind(msg),
        requesterName: senderWho(msg).name,
        requestedAt: msg.createTime || tIntake,
        seenAt: msg.createTime,
        triggerMessageId: msg.messageId,
        // The topic session's oldest line: the opening's first main line, else the trigger (s15).
        from: section ? section.main[0]?.createTime || msg.createTime : undefined,
        openTopic: anchor
          ? { id: anchor.id, from: topicPerson('user', anchor.senderId), at: anchor.at || undefined, text: anchor.text }
          : { id: msg.messageId, from: senderOf(msg), at: msg.createTime || undefined, text: msg.content },
        ...(extra?.initiative ? { initiative: true as const } : {}),
        wake: extra?.wake,
        feedback: extra?.feedback,
        ...memoryTriggerOf(msg, extra),
        backendId: be.id,
        titleJobKey,
        titleSource,
        timing: { tResolve: tResolveDone - tIntake, tWeave: Date.now() - tIntake },
      };
      if (goal) await trackRun(launchGoalRun(launchOpts));
      else
        await trackRun(launchRun(
          launchOpts,
          reaction,
          () => reaction?.done(), // topic created → ✅ DONE (don't wait for the reply)
        ));
    }).catch((err) => log.fail('intake', err)).finally(() => {
      opened();
      const remaining = (pendingTopics.get(msg.chatId) ?? 1) - 1;
      if (remaining) pendingTopics.set(msg.chatId, remaining); else pendingTopics.delete(msg.chatId);
    }));
  }

  /** The title a holder's topic goes by (s15f): its record's summary, the topic's first message
   * or the resumed session's name. Unset for a placeholder such as `(新会话)`. */
  function holderTopicTitle(holder: Pick<SessionRecord, 'summary'>): string | undefined {
    return /^\(.*\)$/.test(holder.summary) ? undefined : topicTitle(holder.summary);
  }
  /** Where in the group a `/resume` found its session in use (s15f): the main area, or a topic by
   * its title so it can be found, never an id. */
  function inUseText(holder: Pick<SessionRecord, 'threadId' | 'chatId' | 'summary'>): string {
    if (isMainKey(holder.threadId, holder.chatId)) return '这条会话正在本群的主区用着，到那里接着聊。';
    const title = holderTopicTitle(holder);
    return `这条会话正在本群的${title ? `话题「${title}」` : '一个话题'}里用着，到那里接着聊。`;
  }
  /** The places of the picker's sessions left off (s15f): `主区、话题「…」、2 个话题`. */
  function inUsePlaces(holders: readonly SessionRecord[]): string {
    const topics = holders.filter((h) => !isMainKey(h.threadId, h.chatId));
    const titled = topics.map(holderTopicTitle).filter((t): t is string => Boolean(t)).map((t) => `话题「${t}」`);
    const untitled = topics.length - titled.length;
    return [
      ...(holders.length > topics.length ? ['主区'] : []),
      ...titled,
      ...(untitled ? [untitled === 1 ? '一个话题' : `${untitled} 个话题`] : []),
    ].join('、');
  }
  /** The place of the group other than `key` that holds the session (s15f). A look before the
   * slow steps; {@link bindSession} decides. */
  async function resumeHolder(chatId: string, key: string | undefined, backend: string, sessionId: string): Promise<SessionRecord | undefined> {
    return sessionHolder(await listSessions(), { chatId, key, backend, sessionId });
  }
  /** A topic a `/resume` opened without binding the session says why (s15f): another place took
   * it meanwhile, or the topic started a session of its own first. */
  function noteUnbound(chatId: string, topicMsgId: string, why: string): Promise<unknown> {
    return channel
      .send(chatId, { markdown: `这个话题没有接上会话：${why}` }, { replyTo: topicMsgId, replyInThread: true })
      .catch(() => undefined);
  }
  /** How many sessions of the shared folder a private chat's `/resume` looks through for its own, and how many a card shows. */
  const DM_RESUME_SCAN = 200;
  const RESUME_LIST_MAX = 15;
  /** Why a card `/resume` left its new topic unbound when a message there started a session first. */
  const RESUME_TOPIC_BUSY = '新话题里已经开始了新的会话，没有接上这条。';

  /** Group @bot /resume: post the history picker for this project's cwd. Owner-only
   * (admins[]) — 恢复会话会改变上下文，属管理类命令；非管理员收到无权限提示。
   * Detached — listThreads spawns an app-server (slow); holding onMessage on it
   * would pin the SDK's per-chat queue (sibling topics + ⏹ card-actions stall). */
  function postResumeCard(msg: NormalizedMessage, singleSessionKey?: string): void {
    void trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      if (!isAdmin(cfg, msg.senderId)) {
        await denyAdminCommand(msg, 'resume');
        return;
      }
      try {
        const project = await getProjectByChatId(msg.chatId);
        const cwd = workCwd(project);
        // Routed so a no-resume backend surfaces its clear "not supported" error
        // here. The resolved backend id rides the card state AND each pick
        // button's callback value (`b`), so the pick → readHistory → rebind path
        // stays on the same backend that listed the sessions.
        const be = groupBackend(project);
        const listed = await scopedThreads(be,msg.chatId,cwd,project?.dm ? DM_RESUME_SCAN : undefined);
        // Sessions another place of this group holds are left off (s15f): resuming one here
        // would give it two writers. The key being resumed may pick its own again.
        const records = await listSessions();
        // A private chat's folder is shared by its admins: this window lists what it held itself, nobody else's and no terminal's (dm-agent 4.3).
        const own = project?.dm ? new Set(records.filter(rec => rec.chatId === msg.chatId).flatMap(rec => [rec.sessionId, ...rec.earlier ?? []])) : undefined;
        const holders: SessionRecord[] = [];
        const threads = listed.filter((t) => {
          if (own && !own.has(t.sessionId)) return false;
          const holder = sessionHolder(records, { chatId: msg.chatId, key: singleSessionKey, backend: be.id, sessionId: t.sessionId });
          if (holder) holders.push(holder);
          return !holder;
        }).slice(0, RESUME_LIST_MAX);
        const state: ResumeCardState = {
          chatId: msg.chatId,
          originalMsgId: msg.messageId,
          requesterOpenId: msg.senderId,
          cwd,
          projectName: project?.name,
          backend: be.id,
          threads,
          ...(holders.length ? { inUse: holders.length, inUseAt: inUsePlaces(holders) } : {}),
          createdAt: Date.now(),
          // Single-session group: pick rebinds this key flat (no new topic).
          ...(singleSessionKey ? { flat: true, sessionKey: singleSessionKey } : {}),
        };
        const res = await sendManagedCard(channel, msg.chatId, buildResumeCard(state), msg.messageId);
        pruneResumePending();
        resumePending.set(res.messageId, state);
        log.info('card', 'resume', { project: project?.name ?? '(unregistered)', threads: threads.length });
      } catch (err) {
        // detached: surface the failure as a reply, never die silently
        log.fail('card', err, { cmd: 'resume' });
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
      }
    }));
  }

  /** @bot /model: post the model/effort picker for the session keyed by
   * `sessionKey` (topic threadId for multi, chatId for single).
   * Detached — listModels can cold-spawn an app-server; see postResumeCard. */
  function postModelCard(msg: NormalizedMessage, sessionKey: string, inThread: boolean): void {
    void trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      try {
        // 按会话/项目后端路由（已有会话以记录为准，未开张的用项目配置）：
        // claude 项目的 /model 卡绝不能列 codex 模型——选中即经 patchSession
        // 持久化，重启 resume 会把 codex model id 喂给 claude CLI，会话坏死。
        const [rec, project] = await Promise.all([getSession(sessionKey), getProjectByChatId(msg.chatId)]);
        const be = sessionBackendOf(rec, project);
        const models = projectModelCatalog(project, be.id, await listModelsAt(be, rec?.cwd ?? project?.cwd));
        if (!models.length) throw new Error('本群没有可用的模型与 Effort 组合，请先在群设置中选择');
        // Seed the /model card's "current" from the default (when this topic has
        // no session record yet) so a fresh topic shows what it WILL start on;
        // pickDefault validates it against the live list.
        const prefer = modelPrefOf(project, be.id);
        const def = pickDefault(models, project?.modelAccess ? { ...prefer, custom: false } : prefer);
        // 记录里跨后端污染的 model id（旧版未路由的 /model 卡写入）不在本后端
        // 列表里——回落默认，别把坏值当 select 初值渲染。手填的 id（会话上标了
        // modelCustom）不在列表里也照显示。
        const recModel =
          rec?.model && (rec.modelCustom || models.some((m) => m.id === rec.model)) ? rec.model : undefined;
        const state: ModelCardState = {
          allowCustom: !project?.modelAccess,
          chatId: msg.chatId,
          threadId: sessionKey,
          requesterOpenId: msg.senderId,
          models,
          model: recModel ?? def.model,
          modelCustom: rec?.modelCustom ?? (!recModel && def.model === prefer?.model && prefer?.custom === true),
          effort: rec?.effort ?? def.effort,
          serviceTier: rec?.serviceTier,
          backend: be.id,
          inThread,
          replyTo: msg.messageId,
          createdAt: Date.now(),
        };
        const res = await sendManagedCard(channel, msg.chatId, buildModelCard(state), msg.messageId, inThread);
        pruneModelPending();
        modelPending.set(res.messageId, state);
        log.info('card', 'model', { threadId: sessionKey, model: state.model, effort: state.effort });
      } catch (err) {
        // detached: surface the failure as a reply, never die silently
        log.fail('card', err, { cmd: 'model' });
        await channel
          .send(msg.chatId, { markdown: `❌ ${err instanceof Error ? err.message : String(err)}` }, { replyTo: msg.messageId })
          .catch(() => undefined);
      }
    }));
  }

  /** `/context`: show the session's current context-window usage (always — even
   * below the run card's threshold). Reads the last usage seen on this session;
   * empty until the session has run at least one turn. */
  async function postContextCard(msg: NormalizedMessage, sessionKey: string, inThread: boolean): Promise<void> {
    const u = lastUsage.get(sessionKey);
    await sendManagedCard(channel, msg.chatId, buildContextCard(u?.used ?? 0, u?.window ?? null), msg.messageId, inThread).catch(
      (err) => log.fail('card', err, { phase: 'context' }),
    );
  }

  /** Spinner cadence for the "压缩中" card. ~0.8s reads as live without spamming
   * card updates (each is a round-trip). */
  const COMPACT_ANIM_INTERVAL_MS = 800;

  /** `/compact`: summarize the session's history to free context; resumes the
   * session under its current tier if it isn't live. While a turn runs it waits:
   * the run loop compacts right after that turn, before the turns already queued
   * (product.md 3.5, s15). One waits per session; during a goal or another
   * operation it is refused.
   *
   * Idle, it is detached (startReservedRun 同模式): the session is reserved
   * SYNCHRONOUSLY so a message racing in mid-compaction waits on the reservation
   * (ActiveState.deferred) instead of launching a turn that would steal the
   * thread's single event stream, and runs once the compaction is done. Holding
   * onMessage here would pin the SDK's per-chat queue — sibling topics and the ⏹
   * card-action would stall for the whole compaction. */
  function runCompact(
    msg: NormalizedMessage,
    sessionKey: string,
    inThread: boolean,
    perm: TurnPerm,
  ): void {
    const reply = (markdown: string): Promise<void> =>
      channel
        .send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: inThread })
        .then(() => undefined, () => undefined);
    const existing = active.get(sessionKey);
    if (existing) {
      let busy = '⏳ 正在处理别的操作，结束后再 `/compact`。';
      if (existing.compacting) busy = '正在压缩，不用再发 `/compact`。';
      else if (existing.compactAfter) busy = '已经排上了，这一轮结束后就压缩。';
      else if (existing.isGoal) busy = '🎯 目标运行中，结束后再 `/compact`。';
      else if (existing.runLoop) {
        existing.compactAfter = { msg, inThread };
        busy = '⏳ 等这一轮结束就压缩，不用再发。';
        log.info('intake', 'compact-queued', { sessionKey });
      }
      void trackTask(reply(busy));
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId, compacting: true, deferred: [] };
    active.set(sessionKey, reserved);
    void trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      let thread: AgentThread | undefined;
      try {
        ({ thread } = await resolveThread(sessionKey, msg.chatId, {
          mode: perm.mode,
          network: perm.network, native: perm.native, readScope: perm.readScope,
        }));
        if (!thread) {
          await reply('这个会话还没开始，先发条消息聊两句再 `/compact`。');
          return;
        }
        await compactWithCard(msg, inThread, thread, sessionKey);
      } catch (err) {
        // pre-card failures (resolveThread 等) have no card to land on — surface
        // them as a plain reply rather than dying silently in the detached task.
        log.fail('intake', err, { phase: 'compact-detached' });
        await reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        releaseHold(sessionKey, reserved);
        releaseIdle(sessionKey, thread);
      }
    }));
  }

  /** End a /compact or /new hold: the input that waited on it goes through intake again, in order.
   * After a swap, input sent before the /new is told instead: the new session starts at the command (product.md 3.5). */
  function releaseHold(sessionKey: string, reserved: ActiveState): void {
    if (active.get(sessionKey) === reserved) active.delete(sessionKey);
    const newAt = reserved.newAt;
    if (!shuttingDown) for (const d of reserved.deferred?.splice(0) ?? []) (newAt && d.at && d.at < newAt ? d.early : d.go)();
  }

  /** Tell the sender a /compact that waited on a run that stopped did not happen (not at shutdown). */
  function dropCompact(state: ActiveState): void {
    const c = state.compactAfter;
    state.compactAfter = undefined;
    if (!c || shuttingDown) return;
    log.info('intake', 'compact-dropped', { msgId: c.msg.messageId });
    void trackTask(channel.send(c.msg.chatId, { markdown: '⚠️ 前面那一轮停了，`/compact` 没有执行，要压缩就再发一次。' },
      { replyTo: c.msg.messageId, replyInThread: c.inThread }).catch(() => undefined));
  }

  /** Compact `thread` behind a "压缩中" card flipped in place to the result (an idle
   * /compact, or one the run loop does between turns). Never throws. */
  async function compactWithCard(msg: NormalizedMessage, inThread: boolean, thread: AgentThread, sessionKey: string): Promise<void> {
    // "压缩中" card we flip in place to the result. Keep its messageId so the
    // settle step can update the same entity; fall back to a fresh card if the
    // initial send (or the in-place update) fails.
    let cardMsgId: string | undefined;
    try {
      const sent = await sendManagedCard(channel, msg.chatId, buildCompactingCard(0), msg.messageId, inThread);
      cardMsgId = sent.messageId;
    } catch (err) {
      log.fail('card', err, { phase: 'compact-start-card' });
    }

    // Spin the "压缩中" card so it visibly keeps working (compaction can take a
    // while). Self-rescheduling tick — never overlaps an in-flight update, and
    // checks `stop` right before each render so no frame can clobber the result;
    // the card has no buttons, so these updates can't hit an interaction lock.
    let stop = false;
    const wakers: Array<() => void> = [];
    const sleep = (ms: number): Promise<void> =>
      new Promise((res) => {
        const t = setTimeout(res, ms);
        wakers.push(() => {
          clearTimeout(t);
          res();
        });
      });
    const anim = (async () => {
      let tick = 0;
      while (!stop && cardMsgId) {
        await sleep(COMPACT_ANIM_INTERVAL_MS);
        if (stop || !cardMsgId) break;
        tick++;
        await updateManagedCard(channel, cardMsgId, buildCompactingCard(tick)).catch(() => undefined);
      }
    })();

    const settle = async (result: object): Promise<void> => {
      stop = true;
      wakers.forEach((w) => w()); // cut the current sleep so the result shows promptly
      await anim; // let the in-flight frame finish so it can't land after the result
      if (cardMsgId && (await updateManagedCard(channel, cardMsgId, result))) return;
      await sendManagedCard(channel, msg.chatId, result, msg.messageId, inThread).catch((err) =>
        log.fail('card', err, { phase: 'compact-settle' }),
      );
    };

    // Pre-compaction occupancy, so the result card can show 旧% → 新%.
    const before = lastUsage.get(sessionKey) ?? null;
    try {
      // Resolves only when codex's compaction turn truly finishes (compact()
      // drains the stream to turn/completed), so the card flips at the right
      // time AND no stale `done` leaks into the next turn.
      const { usage } = await thread.compact();
      markTopicsDue(sessionKey, msg.chatId, thread.sessionId);
      markContextDue(thread, sessionKey);
      if (usage) lastUsage.set(sessionKey, { used: usage.usedTokens, window: usage.contextWindow });
      else lastUsage.delete(sessionKey); // refreshes on the next turn's usage event
      log.info('intake', 'compact', { sessionKey, used: usage?.usedTokens ?? null, before: before?.used ?? null });
      await settle(buildCompactedCard(usage, before));
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      const unsupported = /method not found|-32601|unknown (method|request)/i.test(m);
      log.fail('intake', err, { phase: 'compact' });
      await settle(buildCompactFailedCard(unsupported ? '当前 codex 版本不支持 /compact，请升级后再试。' : m));
    }
  }

  /**
   * `/new` or `/clear` (single-session groups only, admin-gated): park the current session
   * and rebind the group to a BRAND-NEW backend thread, preserving the session's
   * model / effort / backend while the group's list allows them. The parked thread stays on disk (resumable via
   * `/resume`) — non-destructive; Feishu chat history is untouched, and the card
   * says so. Reserves the session SYNCHRONOUSLY (like {@link runCompact}) so a
   * message racing in through the SDK's per-chat queue waits (then runs on the new
   * thread, or the old one when the swap failed) instead of
   * launching a turn on the about-to-be-replaced thread; the slow work
   * (startThread) runs detached so onMessage returns fast.
   */
  function runClear(msg: NormalizedMessage, sessionKey: string, perm: TurnPerm, cmd: 'clear' | 'new'): void {
    const reply = (markdown: string): Promise<void> =>
      channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId }).then(
        () => undefined,
        () => undefined,
      );
    if (!isAdmin(cfg, msg.senderId)) {
      void trackTask(denyAdminCommand(msg, cmd));
      return;
    }
    const existing = active.get(sessionKey);
    if (existing) {
      void trackTask(reply(existing.compacting ? `⏳ 正在压缩，压完再 \`/${cmd}\`。` : `⏳ 这一轮还在跑，结束后再 \`/${cmd}\`。`));
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId, deferred: [] };
    active.set(sessionKey, reserved);
    void trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      try {
        const [rec, project] = await Promise.all([getSession(sessionKey), getProjectByChatId(msg.chatId)]);
        // Route by the session's backend (fall back to the project's) — a fresh
        // codex thread for a codex session, claude for a claude one. The cwd is the
        // group's current one, not the record's (s36d2).
        const held = sessionBackendOf(rec, project);
        // What the group's list no longer holds would be refused at the first turn, and this command is the way out of that.
        const stays = !project?.modelAccess || projectModelAllowed(project, held.id, rec?.model, rec?.effort, await listModels(held));
        const be = stays ? held : groupBackend(project);
        const cwd = workCwd(project, rec);
        // Carry the session's chosen model/effort into the new thread so /clear
        // resets the CONVERSATION, not the user's model pick; a session without one
        // starts on the default, as its next turn would. Tier (mode/network) comes
        // from the caller's live perm.
        let model = stays ? rec?.model : undefined;
        let effort = stays ? rec?.effort : undefined;
        let modelCustom = stays ? rec?.modelCustom : undefined;
        if (!model) {
          const prefer = modelPrefOf(project, be.id);
          const picked = await pickGroupDefault(project, be, prefer);
          model = picked.model;
          effort ??= picked.effort;
          modelCustom = isCustomDefault(prefer, model);
        }
        const clearedSpeed = await reconcileStoredSpeed(be, sessionKey, cwd, model, rec?.serviceTier);
        const savedSpeed = rec ? (await getSession(sessionKey))?.serviceTier : undefined;
        const fresh = await startWith(be, {
          cwd,
          model,
          effort,
          serviceTier: clearedSpeed,
          mode: perm.mode,
          network: perm.network, native: perm.native, readScope: perm.readScope,
          profile: await profileOf(project, cwd, be, perm.mode),
        }, sessionPlace(project, msg.chatId));
        // Close + evict the parked live thread (a separate app-server proc); its
        // on-disk session survives for /resume. Then track the fresh one.
        const old = sessions.get(sessionKey);
        if (old && old !== fresh) {
          sessions.delete(sessionKey);
          void trackTask(old.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
        }
        trackSession(sessionKey, fresh);
        lastUsage.delete(sessionKey); // context gauge → 0 until the next turn
        dropRetries(sessionKey); // a [重试] from the old conversation must not replay into this one
        // `/clear` has no user question to title from. Park a policy-snapshotted
        // waiting job; the next real message supplies the source and activates it
        // only after that host turn is issued.
        const titleJobKey = await registerSessionTitle(be, fresh.sessionId, cwd);
        await upsertSession({
          threadId: sessionKey,
          chatId: msg.chatId,
          cwd,
          sessionId: fresh.sessionId,
          backend: be.id,
          titleJobKey,
          model,
          effort,
          serviceTier: savedSpeed,
          modelCustom,
          summary: '(新会话)',
          // The new session starts at this command (product.md 3.5 "命令"), also
          // when it is rebuilt before its first turn (from).
          lastSeenAt: msg.createTime || Date.now(),
          from: (msg.createTime || Date.now()) + 1,
          ...sessionFields(fresh),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        reserved.newAt = msg.createTime;
        await sendManagedCard(channel, msg.chatId, buildClearedCard(), msg.messageId, false).catch((err) =>
          log.fail('card', err, { phase: 'clear' }),
        );
        log.info('intake', 'clear', { sessionKey, sessionId: fresh.sessionId, backend: be.id, cmd });
      } catch (err) {
        log.fail('intake', err, { phase: 'clear' });
        await reply(`❌ ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        releaseHold(sessionKey, reserved);
      }
    }));
  }

  /** `/help`: post the command cheat-sheet for the caller's current scope. */
  async function postHelpCard(
    msg: NormalizedMessage,
    scope: HelpScope,
    inThread = false,
    project?: Project,
  ): Promise<void> {
    const noMention = project ? noMentionOf(project) : true;
    // 按本群项目的后端能力裁剪命令清单：不支持的后端不列 /goal、/compact、/resume
    // （能力守卫会拒），避免「列了点了才发现不支持」。codex(capabilities undefined)=全列。
    const caps = groupBackend(project).capabilities;
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const card = buildHelpCard(scope, noMention, isAdmin(cfg, msg.senderId), caps, project ? sessionModeOf(project) : 'multi', Boolean(project?.dm));
      await sendManagedCard(channel, msg.chatId, card, msg.messageId, inThread).catch((err) =>
        log.fail('card', err, { cmd: 'help', scope }),
      );
      log.info('card', 'help', { scope });
    });
  }

  // ── card actions ──────────────────────────────────────────────────
  const dispatcher = new class extends CardDispatcher {
    override on(actionId: string, handler: CardActionHandler): this {
      return super.on(actionId, admitEvent(handler));
    }
  }(channel, cfg);
  if (options?.feedback) dispatcher.on(FEEDBACK_ACTION, ({evt}) => options.feedback!.onAction(evt));
  const authoring = options?.authoring;
  if (authoring) dispatcher.on('recipe.authoring', ({evt}) => {
    // ACK before authoring can update its card, outside Feishu's interaction window.
    void trackTask((async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await orStop(new Promise<void>(resolve => { timer = setTimeout(resolve, CARD_SETTLE_MS); }), undefined);
      } finally {
        clearTimeout(timer);
      }
      if (!shuttingDown) await authoring.onAction(evt);
    })());
  });
  const asks = new AskCoordinator(channel, cfg, names);
  dispatcher.on('ask_submit', ({ evt, value, formValue }) => {
    const result = asks.submit({ messageId: evt.messageId, chatId: evt.chatId, operatorOpenId: evt.operator?.openId, value, formValue });
    if (result === 'inactive') healDeadAskCard(evt);
  });
  const outboundFiles = new OutboundFiles(paths.outboundFilesDir);
  void trackTask(outboundFiles.recover(channel));
  outboundFiles.register(dispatcher, async (record, openId) =>
    fileClaimMode(cfg, await getProjectByChatId(record.chatId), record, openId));
  const PENDING_TTL_MS = 30 * 60_000; // abandoned config cards expire after 30 min
  // Goal runs have NO total wall-clock cap (a healthy goal may legitimately run
  // for days — matching codex's native behavior). The only automatic backstop is
  // an IDLE watchdog: if codex emits NO raw notification at all for this long
  // (run.lastActivity — unmapped notifications like command output deltas count
  // as liveness), the run is presumed wedged and torn down to free its
  // concurrency slot. A live goal streams notifications continuously, so this
  // never fires on real work; manual control is the run card's ⏹ 终止 /
  // 🎯 结束目标 buttons.
  const GOAL_IDLE_MS = 30 * 60_000;

  // A card update issued from inside a cardAction handler must land AFTER Feishu
  // is done with the click's interaction window — Feishu locks the card during
  // that window and discards an update that arrives inside it (official "处理卡片
  //回调"). A hard collision throws cardkit err 200810 (caught + retried below);
  // but a near-miss returns HTTP 200 yet the *client* still snaps the card back
  // to its pre-click state — silent, so the 200810 retry never fires and the
  // update is simply lost (symptom: "点一下没反应 / 要点两下"). We learned 150ms is
  // inside that soft window; 500ms clears it reliably. These console cards aren't
  // high-frequency, so the latency is worth the determinism. Cards must be
  // CardKit entities (sendManagedCard) for the update to target them —
  // im.v1.message.patch only does "unconditional".
  const CARD_SETTLE_MS = 500;
  // `c` may be a card object or a (possibly async) builder. Passing a builder
  // lets a handler return *immediately* (so the SDK acks the click's callback
  // right away, closing the interaction window) while any slow work — API
  // calls, createProject — runs inside the settle, after the ack. Awaiting slow
  // work in the handler instead holds the callback open and the next click's
  // update collides with the still-open window (err 200810 → revert).
  //
  // `fallbackChatId`: byMessageId mappings are per-process (lost on restart), so
  // a card sent before a restart is an orphan — updateManagedCard finds no entity
  // and no-ops, leaving a dead card (the "返回菜单又没用了" after I restart). When a
  // chatId is given we self-heal by posting a fresh managed card instead (no
  // recall — the stale one just sits above).
  const settleUpdate = (
    msgId: string,
    c: object | (() => object | Promise<object>),
    fallbackChatId?: string,
  ): Promise<void> => {
    const armedAt = Date.now();
    const settled = (async () => {
      // Wrap the WHOLE flow: a throwing builder (`c()`), a rejected card update,
      // or a rejected fallback must never die silently — that surfaces to the user
      // as a dead button ("点击没反应") with nothing in the log to diagnose it.
      try {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        const card = typeof c === 'function' ? await c() : c;
        const ok = await updateManagedCard(channel, msgId, card);
        log.info('console', 'settle-update', { msgId, ok, waitedMs: Date.now() - armedAt, fallback: !ok && !!fallbackChatId });
        if (!ok && fallbackChatId) {
          await sendManagedCard(channel, fallbackChatId, card);
        }
      } catch (err) {
        log.fail('console', err, { phase: 'settle-update', msgId });
      }
    })();
    void trackTask(settled);
    return settled;
  };
  function pruneResumePending(): void {
    const now = Date.now();
    for (const [k, s] of resumePending) if (now - s.createdAt > PENDING_TTL_MS) resumePending.delete(k);
  }
  function pruneModelPending(): void {
    const now = Date.now();
    for (const [k, s] of modelPending) if (now - s.createdAt > PENDING_TTL_MS) modelPending.delete(k);
  }

  /** A card's chat gate: a group's allow list, a private chat's admin list (dm-agent 5). */
  function placeOpen(chatId: string, openId: string): boolean {
    return getProjectByChatIdSync(chatId)?.dm ? isAdmin(cfg, openId) : isChatAllowed(cfg, chatId);
  }

  /**
   * Resolve + authorize a command-card (/model, /resume) action. Only the
   * original requester may act on their card (design §5); chat/user must still
   * be allowed; expired cards are dropped.
   */
  function authPending<T extends { createdAt: number; requesterOpenId: string; chatId: string }>(
    map: Map<string, T>,
    evt: CardActionEvent,
  ): T | undefined {
    const state = map.get(evt.messageId);
    if (!state) return undefined;
    if (Date.now() - state.createdAt > PENDING_TTL_MS) {
      map.delete(evt.messageId);
      return undefined;
    }
    const op = evt.operator?.openId ?? '';
    if (op !== state.requesterOpenId || !placeOpen(state.chatId, op)) {
      log.info('card', 'action-denied', { reason: 'not-allowed' });
      return undefined;
    }
    return state;
  }

  /** Why a `/model` card can no longer write its session, or undefined. Without a
   * record patchSession is a no-op, so saying "已切换" would be a lie. A changed
   * backend means this card lists the wrong backend's models: writing one into
   * the record would make resume hand the CLI a foreign id. */
  function modelCardStale(state: ModelCardState, rec: SessionRecord | undefined): string | undefined {
    if (!rec) return '⚠️ 这里还没有会话，先发一条消息，再用 /model 切换。';
    if (state.backend && rec.backend !== state.backend) return '⚠️ 会话后端已切换，这张卡已过期——请重新发 /model';
    return undefined;
  }

  const speedClicks = new Map<string, Promise<void>>();
  /** Resolve each click against the saved session and current model catalog, not the
   * card's old icon. The explicit tier path serves buttons sent before this update. */
  function saveModelCardSpeed(evt: CardActionEvent, state: ModelCardState, requested?: ServiceTier): void {
    const prior = speedClicks.get(evt.messageId) ?? Promise.resolve();
    const queued = prior.then(() => settleUpdate(evt.messageId, async () => {
      const rec = await getSession(state.threadId);
      const stale = modelCardStale(state, rec);
      if (stale) { state.note = stale; return buildModelCard(state); }
      try {
        if (rec!.backend !== 'codex-appserver' || rec!.modelCustom || state.modelCustom) {
          state.note = '会话模型已变化，请重新打开 /model。';
          return buildModelCard(state);
        }
        const scope = { kind: 'session' as const, botId: cfg.accounts.app.id, threadId: state.threadId };
        const view = await settings.read(scope);
        if (view.scope.kind !== 'session' || !('speed' in view.sections) || !view.sections.speed) throw new Error('该会话暂不支持切换响应速度');
        const project = await getProjectByChatId(state.chatId);
        const be = backendFor(rec!.backend);
        const catalog = projectModelCatalog(project, rec!.backend, await listModelsAt(be, rec!.cwd));
        // A fallback catalog has no trustworthy speed evidence. Keep the saved
        // choice until native model discovery succeeds again.
        if (!be.peekModels?.()?.length) throw new Error('实时模型目录不可用，请稍后重试');
        const prefer = modelPrefOf(project, rec!.backend);
        const currentModel = rec!.model ?? pickDefault(catalog, project?.modelAccess ? { ...prefer, custom: false } : prefer).model;
        if (currentModel !== state.model) {
          state.note = '会话模型已变化，请重新打开 /model。';
          return buildModelCard(state);
        }
        const selected = catalog.find(model => model.id === currentModel && !model.hidden);
        const available: ServiceTier[] = ['standard'];
        if (selected?.serviceTiers?.some(tier => tier.id === 'fast')) available.push('fast');
        if (selected?.serviceTiers?.some(tier => tier.id === 'ultrafast')) available.push('ultrafast');
        if (available.length === 1) throw new Error('当前模型不支持切换响应速度，请重新打开 /model');
        const stored = view.sections.speed.stored.tier;
        const current = stored !== 'inherit' && available.includes(stored) ? stored : 'standard';
        const tier = requested ?? available[(available.indexOf(current) + 1) % available.length]!;
        if (!available.includes(tier)) throw new Error('当前模型不支持这个速度档位');
        const result = await settings.save({ scope, section: 'speed', revision: view.sections.speed.revision, patch: { tier } });
        if (result.kind !== 'saved') {
          state.note = result.kind === 'rejected' ? result.fields.map(field => field.message).join('；') : result.kind === 'unavailable' ? '该会话当前不可编辑，请启动 Bot 后重试。' : '设置已变化，请重新打开 /model。';
          return buildModelCard(state);
        }
        const saved = await getSession(state.threadId);
        state.serviceTier = saved?.serviceTier;
        state.modelCustom = saved?.modelCustom;
        state.models = catalog;
        state.note = `✅ 已设置响应速度：${serviceTierLabel(tier)}，下一次发起任务生效`;
      } catch (error) {
        state.note = error instanceof Error ? error.message : '响应速度保存失败，请重试。';
      }
      return buildModelCard(state);
    }));
    speedClicks.set(evt.messageId, queued);
    void trackTask(queued);
    void queued.finally(() => { if (speedClicks.get(evt.messageId) === queued) speedClicks.delete(evt.messageId); });
  }

  dispatcher
    .on(MC.model, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        // 防跨后端写入：卡片建立后会话后端可能已变（/resume 换绑等）——这张卡
        // 列的是 state.backend 的模型，写进别的后端的会话记录会让 resume 把
        // 错后端的 model id 喂给 CLI（claude 吃到 'gpt-5.5' 即永久报错）。
        const rec = await getSession(state.threadId);
        const stale = modelCardStale(state, rec);
        if (stale) {
          state.note = stale;
          return buildModelCard(state);
        }
        const project = await getProjectByChatId(state.chatId);
        const currentBe = backendFor(state.backend ?? rec?.backend);
        const currentModels = projectModelCatalog(project, state.backend ?? rec?.backend ?? DEFAULT_BACKEND_ID, await listModelsAt(currentBe, rec?.cwd ?? project?.cwd));
        const chosen = currentModels.find(model => model.id === option);
        if (!chosen) { state.note = '这个模型已不在本群可用范围，请重新打开 /model。'; return buildModelCard(state); }
        const resetSpeed = state.backend === 'codex-appserver' && rec?.serviceTier && rec.serviceTier !== 'standard' && !chosen.serviceTiers?.some(tier => tier.id === rec.serviceTier);
        state.models = currentModels;
        state.model = option;
        state.modelCustom = false;
        // re-pick a valid effort if the new model doesn't support the current one
        const m = state.models.find((x) => x.id === option);
        if (m && m.supportedEfforts.length && !m.supportedEfforts.includes(state.effort)) {
          state.effort = m.defaultEffort;
        }
        await patchSession(state.threadId, { model: state.model, effort: state.effort, modelCustom: false, ...(resetSpeed ? { serviceTier: undefined } : {}) });
        if (resetSpeed) state.serviceTier = undefined;
        state.note = `✅ 已切换模型「${m?.displayName ?? option}」，下一轮生效${resetSpeed ? '；响应速度已恢复普通' : ''}`;
        return buildModelCard(state);
      });
    })
    .on(MC.effort, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        const rec = await getSession(state.threadId);
        const stale = modelCardStale(state, rec);
        if (stale) {
          state.note = stale;
          return buildModelCard(state);
        }
        const project = await getProjectByChatId(state.chatId);
        const catalog = projectModelCatalog(project, state.backend ?? rec!.backend, await listModelsAt(backendFor(state.backend), rec!.cwd));
        const prefer = modelPrefOf(project, rec!.backend);
        const currentModel = rec!.model ?? pickDefault(catalog, project?.modelAccess ? { ...prefer, custom: false } : prefer).model;
        if (currentModel !== state.model || (rec!.modelCustom === true) !== (state.modelCustom === true)) {
          state.note = '会话模型已变化，请重新打开 /model。';
          return buildModelCard(state);
        }
        if (!catalog.find(m => m.id === state.model && !m.hidden)?.supportedEfforts.includes(option) || !projectModelAllowed(project, state.backend ?? DEFAULT_BACKEND_ID, state.model, option as ReasoningEffort, catalog)) {
          state.note = '这个 Effort 已不在本群可用范围，请重新打开 /model。'; return buildModelCard(state);
        }
        let saved = false;
        await patchSession(state.threadId, latest => {
          if (latest.backend !== rec!.backend || latest.model !== rec!.model || (latest.modelCustom === true) !== (rec!.modelCustom === true)) return {};
          saved = true;
          return { effort: option as ReasoningEffort };
        });
        if (!saved) {
          state.note = '会话模型已变化，请重新打开 /model。';
          return buildModelCard(state);
        }
        state.effort = option as ReasoningEffort;
        state.note = '✅ 已设置 effort，下一轮生效';
        return buildModelCard(state);
      });
    })
    .on(MC.speedOpen, ({ evt }) => {
      const state = authPending(modelPending, evt);
      if (state) saveModelCardSpeed(evt, state);
    })
    // Accept buttons on cards already sent before the single-click change.
    .on(MC.speed, ({ evt, value }) => {
      const state = authPending(modelPending, evt);
      const tier = value?.tier;
      if (state && (tier === 'standard' || tier === 'fast' || tier === 'ultrafast')) saveModelCardSpeed(evt, state, tier);
    })
    // 手填模型 ID（3.11）：表单提交会锁住这张卡，结果发一张新卡（同一位置），由新卡接管
    // 这张卡的状态。id 只过 parseModelId，不对模型列表校验；填错了在回合里报错。
    .on(MC.custom, ({ evt, formValue }) => {
      const state = authPending(modelPending, evt);
      if (!state) return;
      const parsed = parseModelId(selectValue(formValue, 'customModel'));
      void trackTask((async () => {
        const rec = await getSession(state.threadId);
        const stale = modelCardStale(state, rec);
        if (stale) {
          state.note = stale;
        } else if (!parsed.ok) {
          state.note = `⚠️ ${parsed.message}`;
        } else if ((await getProjectByChatId(state.chatId))?.modelAccess) {
          state.note = '本群只能使用群设置中已选择的模型。';
        } else {
          const resetSpeed = rec?.backend === 'codex-appserver' && rec.serviceTier && rec.serviceTier !== 'standard';
          state.model = parsed.id;
          state.modelCustom = true;
          await patchSession(state.threadId, { model: state.model, effort: state.effort, modelCustom: true, ...(resetSpeed ? { serviceTier: undefined } : {}) });
          if (resetSpeed) state.serviceTier = undefined;
          state.note = `✅ 已切换到手填的模型 ${modelIdCode(parsed.id)}，下一轮生效${resetSpeed ? '；响应速度已恢复普通' : ''}`;
          log.info('card', 'model-custom', { threadId: state.threadId, model: parsed.id });
        }
        state.createdAt = Date.now();
        try {
          const res = await sendManagedCard(channel, state.chatId, buildModelCard(state), state.replyTo, state.inThread ?? false);
          modelPending.delete(evt.messageId);
          pruneModelPending();
          modelPending.set(res.messageId, state);
        } catch (err) {
          // 原卡已锁、新卡没发出去：回一句文字，让人知道结果。
          log.fail('card', err, { phase: 'model-custom-card' });
          await channel
            .send(state.chatId, { markdown: state.note ?? '' }, { replyTo: state.replyTo, replyInThread: state.inThread })
            .catch(() => undefined);
        }
      })().catch((err) => log.fail('card', err, { phase: 'model-custom' })));
    })
    .on(RES.pick, ({ evt, value }) => {
      const state = authPending(resumePending, evt);
      const sessionId = typeof value.t === 'string' ? value.t : undefined;
      // backend id from the button value (M-8: card callbacks carry it), with
      // the card state's copy as fallback for cards minted before the change.
      const backendId = typeof value.b === 'string' ? value.b : state?.backend;
      if (!state || !sessionId || state.launching) return;
      state.launching = true;
      settleUpdate(evt.messageId, buildResumeLaunchingCard(state));
      // detach: don't hold the cardAction callback for the whole resume + run
      void trackTask(resumeFromCard(evt, state, sessionId, backendId));
    });

  /** Run-card actions: gated by chat/user allow lists (design §5). */
  const runAllowed = (evt: CardActionEvent): boolean => placeOpen(evt.chatId, evt.operator?.openId ?? '');
  /**
   * Owner-or-admin gate for run-card controls. Killing/altering someone else's
   * run is destructive (design §5: 杀别人的 run 限 admins), and `allowedUsers`
   * defaults to "everyone", so the allow-list alone is not enough. Only the run
   * starter (requester) or an admin may ⏹/⚙️ it.
   */
  const runOwnerOrAdmin = (evt: CardActionEvent, ownerOpenId?: string): boolean => {
    if (!runAllowed(evt)) return false;
    const op = evt.operator?.openId ?? '';
    return op === ownerOpenId || isAdmin(cfg, op);
  };

  // ⏹/🎯 被拒点击分类反馈（M-4 / audit-03 ②）：原来三类点击全部静默吞掉，
  // 「点了毫无反应」。SDK 的 normalized cardAction 链路丢弃 handler 返回值，
  // 没有 toast 通道——用「回贴一条小注」做等价反馈，按 卡片(+操作者) 去重防
  // 连点刷屏。终态间隙（interrupt 刚卸下、runsByCard 还没清）窗口极小，保持
  // 忽略（audit-03 结论）。
  const runControlNotes = new RecentIdCache(512, 60_000);
  function noteSensitiveInGroup(msg: NormalizedMessage, sessionKey: string): void {
    if (runControlNotes.seen(`ask-sensitive:${sessionKey}`)) return;
    void trackTask(channel.send(msg.chatId, { markdown: '🔒 这题要在私聊里回答，群里发的不算回答。' },
      { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) }).catch(() => undefined));
  }
  /** 非发起人/非管理员点 ⏹/🎯：明确告知规则。 */
  const denyRunControl = (evt: CardActionEvent, key: string, actionId: string, verb: string): void => {
    if (!runControlNotes.seen(`deny:${key}:${evt.operator?.openId ?? ''}`)) {
      void trackTask(channel
        .send(evt.chatId, { markdown: `⚠️ 仅发起人或管理员可${verb}。` }, { replyTo: evt.messageId })
        .catch(() => undefined));
    }
    log.info('card', 'action', { actionId, denied: true });
  };
  /** run 已结束 / daemon 重启后的 orphan 卡：告知点击者 + 自愈成无按钮版。
   * 同进程内（终局帧被 429 风暴吞掉等）rc+stream 还在 → 重推真正的无按钮终态卡
   * （updateCard 自带终局退避）；重启后实体映射全丢 → 从载体消息反查 card_id，
   * 只删 {@link CONTROLS_EID} 控件行（其余内容无从重建；实体 seq 也丢了，用
   * epoch 秒——必大于按帧自增的运行期计数）。改版前的旧卡没有该 element_id，
   * 删除失败仅记日志（告知已发出）。卡片改动等 CARD_SETTLE_MS，避开点击互动窗。 */
  let healSequence = 0;
  const healUpdates = new Map<string, Promise<void>>();
  const healDeadRunCard = (evt: CardActionEvent, key: string, actionId: string, notice = 'ℹ️ 该任务已结束，按钮已失效。', extraElementId?: string): void => {
    if (runControlNotes.seen(`dead:${key}${extraElementId ? `:${extraElementId}` : ''}`)) return; // 已答复过 / 自愈在路上
    void trackTask(channel
      .send(evt.chatId, { markdown: notice }, { replyTo: evt.messageId })
      .catch(() => undefined));
    const rc = runCards.get(key);
    const stream = runStreams.get(key);
    log.info('card', 'action', { actionId, orphan: true, inProcess: Boolean(rc && stream) });
    const update = (healUpdates.get(key) ?? Promise.resolve()).then(async () => {
      try {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        if (rc && stream) {
          await stream.updateCard(channel, buildRunCardPlain(rc));
          return;
        }
        const res = await channel.rawClient.im.v1.message.get({ path: { message_id: key } });
        const content = (res.data as { items?: Array<{ body?: { content?: string } }> } | undefined)?.items?.[0]
          ?.body?.content;
        const cardId = content ? cardIdFromMessageContent(content) : undefined;
        if (!cardId) return;
        for (const elementId of deadRunCardElementIds(actionId,extraElementId)) {
          const seq = healSequence = Math.max(healSequence + 1, Math.floor(Date.now() / 1000));
          try { await channel.rawClient.cardkit.v1.cardElement.delete({
            path: { card_id: cardId, element_id: elementId },
            data: { sequence: seq, uuid: `h_${cardId}_${seq}` },
          }); } catch (err) { log.fail('card', err, { phase: 'run-card-heal', key }); }
        }
      } catch (err) {
        log.fail('card', err, { phase: 'run-card-heal', key });
      }
    });
    healUpdates.set(key, update);
    void trackTask(update.finally(() => { if (healUpdates.get(key) === update) healUpdates.delete(key); }));
  };

  const ASK_EXPIRED = '已失效（后台服务重启过）';
  const healDeadAskCard = (evt: CardActionEvent): void => {
    if (runControlNotes.seen(`dead-ask:${evt.messageId}`)) return;
    if (isManaged(evt.messageId)) {
      // settle owns this process's terminal update; epoch sequences would invalidate its counter.
      void trackTask(channel.send(evt.chatId, { markdown: 'ℹ️ 这个问题已经有结果了（有人回答、超时或已停止），卡片会更新。' }, { replyTo: evt.messageId }).catch(() => undefined));
      log.info('card', 'action', { actionId: 'ask_submit', settled: true });
      return;
    }
    void trackTask(channel.send(evt.chatId, { markdown: `ℹ️ 这张提问卡${ASK_EXPIRED}，这一轮已经结束。要继续，请重新发消息。` }, { replyTo: evt.messageId }).catch(() => undefined));
    log.info('card', 'action', { actionId: 'ask_submit', orphan: true });
    void trackTask((async () => {
      try {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        const res = await channel.rawClient.im.v1.message.get({ path: { message_id: evt.messageId } });
        const item = res.data?.items?.[0];
        if (item?.chat_id && item.chat_id !== evt.chatId) return;
        const content = item?.body?.content;
        let cardId = content ? cardIdFromMessageContent(content) : undefined;
        if (!cardId) {
          const converted = await channel.rawClient.cardkit.v1.card.idConvert({ data: { message_id: evt.messageId } });
          cardId = converted.data?.card_id;
        }
        if (!cardId) return;
        const seq = Math.floor(Date.now() / 1000);
        await channel.rawClient.cardkit.v1.cardElement.update({
          path: { card_id: cardId, element_id: ASK_CONTROLS_EID },
          data: { element: JSON.stringify(note(ASK_EXPIRED)), sequence: seq, uuid: `ha_${cardId}_${seq}` },
        });
      } catch (err) {
        log.fail('card', err, { phase: 'ask-card-heal' });
      }
    })());
  };

  const RETRY_STALE = 'ℹ️ 这个重试按钮已失效（之后已经有新的回合、换过会话，或者 bot 重启过）。要重试，请重新发送原消息。';
  /** A reply to a [重试] tap that ran nothing; the button stays for later. */
  const retryNote = (evt: CardActionEvent, key: string, markdown: string): void => {
    if (runControlNotes.seen(`retry:${key}:${markdown}`)) return;
    void trackTask(channel.send(evt.chatId, { markdown }, { replyTo: evt.messageId }).catch(() => undefined));
  };

  // run card buttons (design §3.3). ⏹ (st.interrupt) sends turn/interrupt and
  // waits for the stream's own terminal — codex 0.139+ ends it with
  // turn/completed(status:"interrupted")（08b 探针实测，旧版「no mappable
  // terminal」已证伪），线程与进程留用；5s 没收尾才强停 + 杀进程（launchRun）。
  dispatcher
    .on(RC.stop, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const st = runsByCard.get(key);
      if (!st) {
        healDeadRunCard(evt, key, RC.stop);
        return;
      }
      if (!runOwnerOrAdmin(evt, st.requesterOpenId)) {
        denyRunControl(evt, key, RC.stop, '终止');
        return;
      }
      st.interrupt?.();
      log.info('card', 'action', { actionId: 'run.stop', stopped: Boolean(st.interrupt) });
    })
    .on(RC.stopSub, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const extra = typeof value.e === 'string' && /^sb_[0-9a-f]{12}$/.test(value.e) ? value.e : undefined;
      const st = runsByCard.get(key);
      if (!st) { healDeadRunCard(evt, key, RC.stopSub, undefined, extra); return; }
      if (!runOwnerOrAdmin(evt, st.requesterOpenId)) {
        denyRunControl(evt, key, RC.stopSub, '停止子 agent');
        return;
      }
      if (!st.run?.stopSubagent) { healDeadRunCard(evt, key, RC.stopSub, undefined, extra); return; }
      if (typeof value.subagentId !== 'string') return;
      void trackTask(st.run.stopSubagent(value.subagentId).catch(error => {
        const row = st.subagents?.().find(row => row.id === value.subagentId);
        if (row && row.status !== 'running') return;
        const reason = error instanceof Error ? error.message : String(error);
        if (!runControlNotes.seen(`stop-sub:${key}:${value.subagentId}:${reason}`)) {
          return channel.send(evt.chatId, { markdown: `⚠️ ${reason}` }, { replyTo: evt.messageId }).then(() => undefined, () => undefined);
        }
      }));
    })
    .on(RC.subPage, ({ evt, value }) => {
      if (!runAllowed(evt)) return;
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runsByCard.has(key)) { healDeadRunCard(evt, key, RC.subPage, undefined, 'sp_next'); return; }
      if (typeof value.p !== 'number' || !Number.isSafeInteger(value.p) || value.p < 0) return;
      const rc = runsByCard.get(key)?.runCard;
      if (rc?.cardKey === key) { rc.subagentPage = value.p; runStreams.get(key)?.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID); }
    })
    // “仅手动”模式的单轮完成提醒。这不是破坏性操作，但也不允许
    // 管理员替别人订阅：只有这一轮的真实发起人能开启。
    .on(RC.remind, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const st = runsByCard.get(key);
      if (!st) {
        healDeadRunCard(evt,key,RC.remind,'ℹ️ 该任务已结束，无需再开启完成提醒。');
        log.info('card', 'action', { actionId: RC.remind, ended: true });
        return;
      }
      const op = evt.operator?.openId;
      if (!isCompletionReminderRequester(op, st.requesterOpenId)) {
        if (!runControlNotes.seen(`remind-deny:${key}:${op ?? ''}`)) {
          void trackTask(channel
            .send(evt.chatId, { markdown: '⚠️ 仅本轮发起人可开启完成提醒。' }, { replyTo: evt.messageId })
            .catch(() => undefined));
        }
        log.info('card', 'action', { actionId: RC.remind, denied: true });
        return;
      }
      // Settings may have changed after this frame was rendered. Refuse a
      // stale manual button and repaint it away instead of creating a hidden
      // per-turn override under long/failures/always.
      if (st.isGoal || !reminderButtonOffered(st.presentation ?? cfg, st)) {
        completionReminderRefreshers.get(key)?.();
        log.info('card', 'action', { actionId: RC.remind, stale: true });
        return;
      }
      if (!st.completionReminderRequested) {
        st.completionReminderRequested = true;
        completionReminderRefreshers.get(key)?.();
      }
      log.info('card', 'action', { actionId: RC.remind, requested: true });
    })
    // 🎯 结束目标 (goal cards): clear the goal, let the current turn finish, then
    // stop — no auto-continue. Owner-or-admin gated like ⏹.
    .on(RC.endGoal, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const st = runsByCard.get(key);
      if (!st) {
        healDeadRunCard(evt, key, RC.endGoal);
        return;
      }
      if (!runOwnerOrAdmin(evt, st.requesterOpenId)) {
        denyRunControl(evt, key, RC.endGoal, '结束目标');
        return;
      }
      st.endGoal?.();
      log.info('card', 'action', { actionId: 'goal.end', ended: Boolean(st.endGoal) });
    })
    // 🔁 重试 (terminal card of an idle-timeout / network failure): run that
    // turn's input again. Same gate as 👍 继续: the requester or an admin, still
    // allowed in the project. The tap is used up once the session takes it.
    .on(RC.retry, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const retry = retryTurns.get(key);
      if (!retry) {
        healDeadRunCard(evt, key, RC.retry, RETRY_STALE);
        return;
      }
      if (!runOwnerOrAdmin(evt, retry.turn.requesterOpenId)) {
        denyRunControl(evt, key, RC.retry, '重试');
        return;
      }
      if (retrying.has(key)) { // synchronous: a double tap never queues twice
        retryNote(evt, key, 'ℹ️ 正在重试，结果见下一张卡片。');
        return;
      }
      retrying.add(key);
      void trackTask(retryTurn(evt, key, retry)
        .catch((err) => log.fail('card', err, { phase: 'run-retry' }))
        .finally(() => retrying.delete(key)));
    });

  /** Why no turn may start in this group right now, in the words a [重试] tap
   * gets; undefined when one may. Messages are stopped by the same states. */
  function turnRefusal(project: Project | undefined, chatId: string): string | undefined {
    if (!project) return UNBOUND_GROUP_REPLY;
    if (project.enabled === false) return 'ℹ️ 本群的项目已停用，暂时不能重试。';
    if (projectMutations.has(chatId)) return 'ℹ️ 项目正在修改，请稍后再点重试。';
    if (resumePublications.has(chatId)) return 'ℹ️ 正在恢复历史会话，请完成后再点重试。';
    return undefined;
  }

  /** How long a group the desktop could not change because of a run starts no scheduled run, so a retry gets through. */
  const FIRING_HOLD_MS = 60_000;
  const firingHolds = new Map<string, number>();
  function holdFiring(chatId: string, ms: number): void {
    firingHolds.set(chatId, Math.max(firingHolds.get(chatId) ?? 0, Date.now() + ms));
  }

  /** Whether a run of `chatId` is on, for the desktop's edit lock. A run's reservation carries its group; one without
   * (/compact, /new, a resume, the desktop's session actions) counts for every group, as every state did before scheduled tasks. */
  function runningIn(chatId: string): boolean {
    for (const state of active.values()) if (state.chatId === undefined || state.chatId === chatId) return true;
    return false;
  }

  /** Whether a scheduled task of the group may start now (bot/schedule/scheduler.ts): turnRefusal's states, a desktop
   * hold, then the tier; a private chat's also that the chat's person and the one it runs as are still admins (dm-agent 6.3).
   * Synchronous, as the scheduler decides in place. */
  function scheduleGate(chatId: string, task: Pick<StoredTask, 'createdBy'>): 'ok' | 'disabled' | 'updating' | 'held' | 'unbound' | 'tier-unavailable' | 'admin-removed' {
    const project = getProjectByChatIdSync(chatId);
    if (!project) return 'unbound';
    if (project.dm && !(dmOpen(project) && isAdmin(cfg, dmRunner(task, project)))) return 'admin-removed';
    if (project.enabled === false) return 'disabled';
    if (projectMutations.has(chatId) || resumePublications.has(chatId)) return 'updating';
    if ((firingHolds.get(chatId) ?? 0) > Date.now()) return 'held';
    firingHolds.delete(chatId);
    return tierUnavailable(project) ? 'tier-unavailable' : 'ok';
  }

  /** Why the group's tier cannot run on its backend now (the check of refuseUnavailableTier); undefined when it can. */
  function tierUnavailable(project: Project): string | undefined {
    const be = groupBackend(project);
    return tierInfo(permissionTable(be.id), tableEnv(be), execOf(project).permission).unavailable;
  }

  async function retryTurn(evt: CardActionEvent, key: string, retry: RetryTurn): Promise<void> {
    const op = evt.operator?.openId ?? '';
    // Refused where a message in that group would be, before anything is used
    // up, and again after the waits below: the group can change meanwhile.
    // Only an unbound group takes the button away for good.
    const admitRetry = async (): Promise<Project | undefined> => {
      const project = await getProjectByChatId(retry.chatId);
      if (!project) {
        expireRetry(key);
        healDeadRunCard(evt, key, RC.retry, UNBOUND_GROUP_REPLY);
        return undefined;
      }
      if (!isUserAllowedInProject(cfg, project, op)) {
        denyRunControl(evt, key, RC.retry, '重试');
        return undefined;
      }
      if (retry.expired) {
        healDeadRunCard(evt, key, RC.retry, RETRY_STALE);
        return undefined;
      }
      const refused = turnRefusal(project, retry.chatId);
      if (refused) {
        retryNote(evt, key, refused);
        return undefined;
      }
      return project;
    };
    if (!await admitRetry()) return;
    const text = retryPrompt(retry, retry.replayText);
    const msg = { ...cardTurnMessage(key, retry.chatId, op, text, retry.sessionKey, retry.flat), raw: { sender: { sender_type: 'user' } } };
    if (active.get(retry.sessionKey)?.isGoal) {
      await replyGoalBusy(msg, retry.flat);
      return;
    }
    // The failed run may still be wrapping up that turn (its queue is dropped
    // when it was stopped): start after it, as a fresh run.
    await retry.settled;
    // Media is pruned after an hour; send what is still on disk.
    const savedImages = retry.turn.input.images ?? [];
    const onDisk = await Promise.all(savedImages.map((path) => stat(path).then((st) => st.isFile(), () => false)));
    const images = savedImages.filter((_, i) => onDisk[i]);
    const project = await admitRetry();
    if (!project) return;
    log.info('intake', 'retry', { key: retry.sessionKey, reason: retry.reason, op: op.slice(-6) });
    await handleTurn(
      msg, text, retry.sessionKey, retry.flat, project,
      turnPerm(project),
      {
        images: images.length ? images : undefined,
        summary: retry.turn.summary ?? retry.turn.titleSource.text,
        queueOnly: true,
        replayText: retry.replayText,
        retry: {
          current: () => !retry.expired,
          stale: () => healDeadRunCard(evt, key, RC.retry, RETRY_STALE),
          busy: () => retryNote(evt, key, 'ℹ️ 会话正在处理别的操作，请等它结束后再点重试。'),
          refused: (note) => retryNote(evt, key, note),
          accepted: () => markRetried(key),
        },
      },
    );
  }

  /** The session took the retry: drop the button for 「已重试」 on its card. */
  function markRetried(key: string): void {
    expireRetry(key);
    const rc = runCards.get(key);
    const stream = runStreams.get(key);
    if (!rc || !stream) return;
    rc.retry = 'sent';
    void trackTask((async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      await stream.updateCard(channel, buildRunCard(rc));
    })().catch((err) => log.fail('card', err, { phase: 'run-retry-repaint' })));
  }

  // DM management console buttons (design §3.1). Admin-gated; sub-views patch
  // the same card in place, each carrying a ⬅️ 菜单 back button.
  const dmAdmin = (openId?: string): boolean => isAdmin(cfg, openId ?? '');
  // DM cards are CardKit entities (sendManagedCard); update them via the
  // settle-then-cardkit path so the click's callback acks first. Passing the
  // whole evt lets settleUpdate self-heal an orphaned (post-restart) card by
  // re-posting to evt.chatId.
  const patch = (evt: CardActionEvent, c: object | (() => object | Promise<object>)): void => {
    void settleUpdate(evt.messageId, c, evt.chatId);
  };
  const showAdmins = ({ evt }: { evt: CardActionEvent }): void => {
    if (!dmAdmin(evt.operator?.openId)) return;
    patch(evt, async () => buildAdminsCard(cfg, await namesWithOperator(evt, cfg.preferences?.access?.admins ?? [])));
  };
  /** An old in-group settings card clicked (s1b): it becomes the not-dm sentence, nothing is written. */
  const refuseGroupSettingsCard = (evt: CardActionEvent): void => {
    log.info('console', 'group-settings-card', { refused: 'not-dm' });
    patch(evt, card([md(NOT_DM_MESSAGE)], { summary: NOT_DM_MESSAGE }));
  };

  async function renderForegroundUpdate(): Promise<ReturnType<typeof buildForegroundUpdateCard>> {
    const distribution = await runtimeDistribution();
    return buildForegroundUpdateCard({
      current: currentVersion(),
      distribution: distribution.kind === 'bundled' ? 'bundled' : 'other',
      desktopDownload: desktopDownloadForHost(),
    });
  }

  /** open_id→姓名 三级兜底（管理员/白名单卡展示用）：
   *  1) resolveNames：contact.batch（需 contact:user.base:readonly）；
   *  2) 项目群成员名：im:chat:readonly 已开就够，含外部成员，是 contact 没开时的主力；
   *  3) 卡片回调自带的操作者姓名（若 operator 带 name）。都拿不到才降级尾号。 */
  const namesWithOperator = async (
    evt: CardActionEvent,
    ids: (string | undefined)[],
  ): Promise<Map<string, string>> => {
    const m = await resolveNames(channel, ids);
    if (ids.some((id) => id && !m.has(id))) {
      for (const mem of await fetchAllProjectMembers(channel)) if (!m.has(mem.openId)) m.set(mem.openId, mem.name);
    }
    const op = evt.operator as { openId?: string; name?: string } | undefined;
    if (op?.openId && op.name && !m.has(op.openId)) m.set(op.openId, op.name);
    return m;
  };

  const responseNames = async (evt: CardActionEvent, project: Project): Promise<Map<string, string>> => {
    const members = await orStop(readResponseRoster(channel, roster, project.chatId), { state: 'unavailable', entries: [], otherBots: false });
    const names = await namesWithOperator(evt, project.allowedUsers ?? []);
    for (const member of members.entries) names.set(member.openId, responseMemberLabel(member));
    return names;
  };

  function applyPref(evt: CardActionEvent, mut: (p: AppPreferences) => void): Promise<boolean> {
    if (!dmAdmin(evt.operator?.openId)) return Promise.resolve(false);
    const saved = writePreferences(mut).then(
      () => true,
      (err) => {
        log.fail('console', err, { phase: 'save-config' });
        return false;
      },
    );
    void patch(evt, async () => {
      await saved;
      return renderSettings();
    });
    return saved;
  }

  function renderSettings(notice?: string): object {
    return buildSettingsCard(cfg, notice);
  }

  /** A submitted CardKit form locks its card id, so any result containing more
   * controls must be sent as a fresh managed card. Button-only settings still
   * use `patch` and remain in-place. */
  function sendFreshSettingsResult(
    evt: CardActionEvent,
    render: () => object | Promise<object>,
    phase: string,
  ): void {
    void trackTask((async () => {
      const next = await render();
      await sendManagedCard(channel, evt.chatId, next);
    })().catch((err) => log.fail('console', err, { phase })));
  }

  /** Old interactive cards can be abandoned without a callback. Bound their
   * transient render state so a long-running bot cannot accumulate message ids
   * forever; insertion order makes this a tiny FIFO eviction. */
  function setBoundedCardState<T>(map: Map<string, T>, messageId: string, value: T): void {
    if (!map.has(messageId) && map.size >= 64) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(messageId, value);
  }

  // ── 🏷️ Bridge 新会话的原生 resume 标题设置 ───────────────────────
  function sessionTitleBackendOptions(): { id: string; label: string }[] {
    return visibleCatalog()
      .filter((entry) => entry.id === DEFAULT_BACKEND_ID || isBackendEntryInstalled(entry))
      .map((entry) => ({ id: entry.id, label: entry.displayName }));
  }

  async function renderSessionTitleSettings(
    selectedBackendId?: string,
    notice?: string,
  ): Promise<object> {
    const options = sessionTitleBackendOptions();
    const selected =
      selectedBackendId && options.some((entry) => entry.id === selectedBackendId)
        ? selectedBackendId
        : (() => { const policy = getSessionTitleConfig(cfg); return policy.enabled ? policy.backend : options[0]?.id ?? DEFAULT_BACKEND_ID; })();
    const models = await listModels(backendFor(selected)).catch((err) => {
      log.fail('agent', err, { phase: 'session-title-models', backend: selected });
      return [] as ModelInfo[];
    });
    return buildSessionTitleSettingsCard(cfg, options, selected, models, notice);
  }

  const sessionTitleRenderStates = new Map<string, { generation: number; selectedBackendId?: string }>();
  async function renderSessionTitleSettingsFor(
    messageId: string,
    selectedBackendId?: string,
    notice?: string,
  ): Promise<object> {
    const previous = sessionTitleRenderStates.get(messageId);
    const state = { generation: (previous?.generation ?? 0) + 1, selectedBackendId };
    setBoundedCardState(sessionTitleRenderStates, messageId, state);
    for (;;) {
      const latestState = sessionTitleRenderStates.get(messageId) ?? state;
      const rendered = await renderSessionTitleSettings(latestState.selectedBackendId, notice);
      const current = sessionTitleRenderStates.get(messageId);
      if (!current || current === latestState) return rendered;
    }
  }

  function applySessionTitlePref(
    evt: CardActionEvent,
    backendId: string,
    config: SessionTitleBackendConfig,
    notice: string,
    freshAfterSubmit = false,
  ): void {
    if (!dmAdmin(evt.operator?.openId)) return;
    const valid = sessionTitleBackendOptions().some((entry) => entry.id === backendId);
    if (config.enabled && !valid) {
      const renderInvalid = () => renderSessionTitleSettings(undefined, '⚠️ 这个 Agent 当前不可用，未保存。');
      if (freshAfterSubmit) {
        sendFreshSettingsResult(evt, renderInvalid, 'session-title-submit-validation');
      } else {
        void patch(evt, renderInvalid);
      }
      return;
    }
    const saved = writePreferences((prefs) => {
      const current = prefs.sessionTitles ?? {};
      prefs.sessionTitles = {
        ...current,
        policy: { ...current.policy, ...(config.enabled ? { ...config, backend: backendId } : { enabled: false as const }) },
      };
    }).then(
      () => true,
      (err) => {
        log.fail('console', err, { phase: 'save-config' });
        return false;
      },
    );
    const renderSaved = async (): Promise<object> => {
      const ok = await saved;
      return renderSessionTitleSettings(backendId, ok ? notice : '⚠️ 保存失败，原配置未改变，请重试。');
    };
    if (freshAfterSubmit) {
      sendFreshSettingsResult(evt, renderSaved, 'session-title-submit-result');
    } else {
      void patch(evt, renderSaved);
    }
  }

  async function saveCommentRulesFromCard(evt: CardActionEvent, content: { kind: 'custom'; text: string } | { kind: 'default' }): Promise<void> {
    try {
      const view = await settings.read({ kind: 'agent', botId: cfg.accounts.app.id });
      if (!('commentInstructions' in view)) return;
      const result = await settings.act({ kind: 'commentInstructions', botId: cfg.accounts.app.id, revision: view.commentInstructions.revision, content });
      const notice = result.kind === 'saved' ? result.warnings.join('；') || '✅ 回复规则已保存并同步，下一条评论生效。' : '⚠️ 保存失败或规则已被修改，请刷新后重试。';
      sendFreshSettingsResult(evt, () => buildCommentPromptCard(content.kind === 'custom' ? content.text : DEFAULT_COMMENT_INSTRUCTIONS, notice, paths.commentInstructionsFile), 'comment-prompt-result');
    } catch {
      sendFreshSettingsResult(evt, () => buildCommentPromptCard(content.kind === 'custom' ? content.text : DEFAULT_COMMENT_INSTRUCTIONS, '⚠️ 回复规则不能为空或过长，未保存。', paths.commentInstructionsFile), 'comment-prompt-validation');
    }
  }

  // ── 📝 云文档评论 @bot 全局设置（DM「⚙️ 设置 → 📝 云文档评论」）───────────
  /** Installed backends offered for the comment flow (codex always; others when
   * downloaded) — same gate as the project backend picker. */
  function commentBackendOptions(): { id: string; label: string }[] {
    return visibleCatalog()
      .filter((e) => e.id === DEFAULT_BACKEND_ID || isBackendEntryInstalled(e))
      .map((e) => ({ id: e.id, label: e.displayName }));
  }

  /** Render the comment-settings card. Agent buttons are transient edit state;
   * the selected Agent/model/effort commit together only on form submit. */
  async function renderCommentSettings(notice?: string, selectedBackendId?: string): Promise<object> {
    const options = commentBackendOptions();
    const configured = resolveCommentsExecution(cfg.preferences).backend;
    const selected =
      selectedBackendId && options.some((entry) => entry.id === selectedBackendId)
        ? selectedBackendId
        : options.some((entry) => entry.id === configured)
          ? configured
          : options[0]?.id ?? DEFAULT_BACKEND_ID;
    for (;;) {
      const comments = getCommentsConfig(cfg);
      const models = await listModels(backendFor(selected)).catch(() => [] as ModelInfo[]);
      const latest = getCommentsConfig(cfg);
      if (
        latest.backend !== comments.backend ||
        latest.model !== comments.model ||
        latest.effort !== comments.effort
      ) {
        continue;
      }
      // The card preselects what a comment would run on: the settings, else the bot default.
      const effective = resolveCommentsExecution({ ...cfg.preferences, comments });
      const snapshot: AppConfig = {
        ...cfg,
        preferences: { ...(cfg.preferences ?? {}), comments: { backend: effective.backend, model: effective.model?.model, effort: effective.model?.effort } },
      };
      return buildCommentSettingsCard(snapshot, options, models, notice, selected);
    }
  }

  /** Per-card transient selection + generation. Two admins (or two old cards)
   * can browse different Agents without sharing UI state; rapid clicks on one
   * card converge to that card's newest selection after async model discovery. */
  const commentSettingsRenderStates = new Map<string, { generation: number; selectedBackendId?: string }>();
  async function renderCommentSettingsFor(
    messageId: string,
    selectedBackendId?: string,
    notice?: string,
  ): Promise<object> {
    const previous = commentSettingsRenderStates.get(messageId);
    const state = {
      generation: (previous?.generation ?? 0) + 1,
      selectedBackendId,
    };
    setBoundedCardState(commentSettingsRenderStates, messageId, state);
    for (;;) {
      const latestState = commentSettingsRenderStates.get(messageId) ?? state;
      const rendered = await renderCommentSettings(notice, latestState.selectedBackendId);
      const current = commentSettingsRenderStates.get(messageId);
      if (!current || current === latestState) return rendered;
    }
  }

  /** Mutate cfg.preferences.comments (admin-gated), persist, then render the
   * comment card. Form submissions request a fresh card because CardKit locks
   * the submitted entity; button-only callers may still update in place. */
  function applyCommentsPref(
    evt: CardActionEvent,
    mut: (c: CommentsConfig) => void,
    opts: { freshAfterSubmit?: boolean; notice?: string; selectedBackendId?: string } = {},
  ): void {
    if (!dmAdmin(evt.operator?.openId)) return;
    const saved = writePreferences((prefs) => {
      const comments: CommentsConfig = { ...(prefs.comments ?? {}) };
      mut(comments);
      prefs.comments = comments;
    }).then(
      () => true,
      (err) => {
        log.fail('console', err, { phase: 'save-config' });
        return false;
      },
    );
    const renderSaved = async (): Promise<object> => {
      const ok = await saved;
      return renderCommentSettings(
        ok ? opts.notice : '⚠️ 保存失败，原配置未改变，请重试。',
        ok ? undefined : opts.selectedBackendId,
      );
    };
    if (opts.freshAfterSubmit) {
      sendFreshSettingsResult(evt, renderSaved, 'comment-settings-submit-result');
    } else {
      void patch(evt, renderSaved);
    }
  }

  // Back-to-menu: the settings card is button-only (never locks) and the
  // new-project form isn't locked until it's submitted, so 返回 always lands on
  // a card we can update in place — no recall, no fresh entity needed.
  const renderDmMenuCard = async (): Promise<object> => buildDmMenuCard({ version: bridgeVersion() });
  const freshMenu = (evt: CardActionEvent): void => {
    patch(evt, renderDmMenuCard);
  };

  // 📊 Codex 用量：loading 卡先落地（取数走网络 1~3s），结果再原地覆盖。错误按
  // UsageError.kind 渲染对应的提示卡（未登录 / API-key 模式 / 需重登 / 波动重试）。
  // 孤儿卡自愈（与 settleUpdate 的 fallbackChatId 同语义）：重启后 byMessageId 映射
  // 已丢，updateManagedCard 返回 false（不抛错、.catch 兜不住）——loading 阶段就改发
  // 一张新卡并把结果更新指向它，否则旧菜单卡上这颗按钮就是「点了毫无反应」的死按钮。
  const runUsage = (evt: CardActionEvent, force: boolean): void => {
    if (!dmAdmin(evt.operator?.openId)) return;
    void trackTask((async () => {
      await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
      let msgId = evt.messageId;
      const okLoading = await updateManagedCard(channel, msgId, buildUsageCard({ phase: 'loading' })).catch(
        () => false,
      );
      if (!okLoading) {
        const sent = await sendManagedCard(channel, evt.chatId, buildUsageCard({ phase: 'loading' })).catch(
          (e) => {
            log.fail('console', e, { phase: 'usage-loading' });
            return undefined;
          },
        );
        if (!sent) return;
        msgId = sent.messageId;
      }
      let state: UsageCardState;
      try {
        state = { phase: 'ready', data: await fetchUsageBundle(force) };
      } catch (err) {
        log.fail('console', err, { phase: 'usage' });
        state = {
          phase: 'error',
          kind: err instanceof UsageError ? err.kind : 'transient',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const ok = await updateManagedCard(channel, msgId, buildUsageCard(state)).catch((e) => {
        log.fail('console', e, { phase: 'usage-render' });
        return false;
      });
      if (!ok) {
        // 结果卡必须落地：原地更新失败（极小概率 loading 后实体又失效）就发新卡兜底
        await sendManagedCard(channel, evt.chatId, buildUsageCard(state)).catch((e) =>
          log.fail('console', e, { phase: 'usage-fallback' }),
        );
      }
    })());
  };

  // Build the project list card with each project's topics (sessions) grouped
  // by chatId, most-recent first — shared by the list/cancel/delete handlers.
  const renderProjectList = async (page = 0): Promise<object> => {
    const [projects, sessions] = await Promise.all([listProjects(), listSessions()]);
    const byChat = new Map<string, SessionRecord[]>();
    for (const s of sessions) {
      if (isRetiredKey(s.threadId)) continue;
      const arr = byChat.get(s.chatId);
      if (arr) arr.push(s);
      else byChat.set(s.chatId, [s]);
    }
    return buildProjectListCard(projects, byChat, page);
  };

  // 体检数据收集（codex 探测 + 飞书 scope 自检）：DM.doctor 与私聊菜单 dm.doctor
  // 直达共用，两处不各写一遍探测。force 绕过探测缓存看「现在」的状态；探测全程
  // 异步——回调里绝不能 spawnSync（同步 codex --version 会冻住所有话题的流式 pump）。
  const buildDoctorInfo = async (): Promise<DoctorInfo> => {
    const codexProbe = await backend.doctor({ force: true });
    const app = cfg.accounts.app;
    // 读 keystore 里的 App Secret → 换 token → 查已开通 scope。任一步失败时
    // missingScopes 留 undefined，卡片显示「无法自动检查」而非误报缺失。
    const secret = await getSecret(secretKeyForApp(app.id)).catch(() => undefined);
    const scopeCheck = secret
      ? await validateAppCredentials(app.id, secret, app.tenant).catch(() => undefined)
      : undefined;
    const missingScopes = scopeCheck?.missingScopes;
    const missingJoinScopes = scopeCheck?.missingJoinScopes;
    return {
      codexOk: codexProbe.ok,
      codexVer: codexProbe.version,
      conn: channel.getConnectionStatus?.()?.state ?? 'unknown',
      // 复用上面 validateAppCredentials 的返回（bot/v3/info），不额外发请求；
      // scopeCheck 没换成 token → undefined，卡片降级显示「未能获取」。
      botOpenId: scopeCheck?.botOpenId,
      bridgeVer: bridgeVersion(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      logStdout: serviceStdoutPath(),
      logStderr: serviceStderrPath(),
      configFile: paths.configFile,
      missingScopes,
      // 缺失时预选缺失项（精准开通）；查不到/全开通时预选全部必需 scope 供核对。
      scopeGrantUrl: buildScopeGrantUrl(
        app.id,
        app.tenant,
        missingScopes && missingScopes.length ? missingScopes : undefined,
      ),
      missingJoinScopes,
      // 「加入存量群」按钮恒预选这两项 opt-in scope（它们不在必需清单里）。
      joinScopeGrantUrl: buildScopeGrantUrl(app.id, app.tenant, JOIN_GROUP_SCOPES),
    };
  };

  const voiceConsole = registerVoiceConsole(dispatcher, channel, cfg, voice);

  // s02b：咖啡一下第一版拿掉了。旧设置卡上的入口和咖啡子卡上的按钮不写盘，只把卡刷新成
  // 没有咖啡一下的设置卡并说一声；已存的 cliBridge 设置留在文件里，不迁移。
  for (const action of COFFEE_RETIRED_ACTIONS) {
    dispatcher.on(action, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) patch(evt, () => renderSettings(COFFEE_RETIRED));
    });
  }

  dispatcher
    .on(DM.menu, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) freshMenu(evt);
    })
    .on(DM.newProject, ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) patch(evt, buildNewProjectFormCard({ backends: backendOptionsFor('full') }));
    })
    .on(DM.newProjectSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const backend = safeBackendId(formValue);
      const kind = pickedMode(value.kind);
      const backends = backendOptionsFor('full');
      // A submitted form locks its card_id (its buttons — retry/返回 on an error
      // re-render — stop firing, and an in-place update no-ops). So the result
      // goes to a *fresh* card; the submitted form stays above as a 留痕. Detach
      // so the submit callback acks immediately (createProject is slow).
      void trackTask((async () => {
        let result;
        if (!name) result = buildNewProjectFormCard({ cwd: cwdIn, error: '项目名不能为空', backends });
        else if (!op) result = buildNewProjectFormCard({ name, cwd: cwdIn, error: '无法识别操作者身份', backends });
        else {
          try {
            if (!bindingBot) throw new Error('缺少机器人注册身份，请重启后再建群');
            const bot = bindingBot;
            const requestId = dmCreationId(evt.messageId, op, value.__r);
            // A click Feishu delivers again after it created the group (s36d1) finds that row, here in the queue
            // behind it, and answers as the first delivery did instead of with a duplicate-name form.
            const p = await serialCreate(async signal => (await listProjects()).find(row => row.creationRequestId === requestId) ?? createProject(channel, {
              requestId,
              bot,
              name,
              invitee: { idType: 'open_id', id: op },
              existingPath: cwdIn || undefined,
              projectsRootDir: cfg.preferences?.projectsRootDir,
              kind,
              noMention: parseNoMentionPick(formValue),
              backend,
              signal,
            }));
            log.info('console', 'new-project', { name: p.name, blank: p.blank, backend: p.backend, requestId });
            result = buildNewProjectDoneCard(p, false);
          } catch (err) {
            // A group may exist (s36d1): say so, with no form that could create a second one.
            result = err instanceof CreationOutcomeUnknownError || err instanceof CreatedButUnsavedError
              ? buildNewProjectUncertainCard({ name, cwd: cwdIn, warning: err.message, ...(err instanceof CreatedButUnsavedError ? { chatId: err.chatId } : {}) })
              : buildNewProjectFormCard({ name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err), backends });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'new-project-result' }),
        );
      })());
    })
    .on(DM.joinGroupSubmit, ({ evt, formValue, value }) => {
      const op = evt.operator?.openId;
      if (!dmAdmin(op)) return;
      const name = String((formValue?.name as string) ?? '').trim();
      const cwdIn = String((formValue?.cwd as string) ?? '').trim();
      const chatId = typeof value.chatId === 'string' ? value.chatId : '';
      const backend = safeBackendId(formValue);
      // 'topic' is 按话题聊, persisted as multi.
      const kind = pickedMode(value.kind);
      const topic = value.t === 'topic';
      const backends = backendOptionsFor('full');
      const fullOnly = backendFor(DEFAULT_BACKEND_ID).fullAccessOnly?.();
      const form = { chatId, name, cwd: cwdIn, backends, backend, topic, fullOnly };
      // Same fresh-card pattern as DM.newProjectSubmit: a submitted form locks
      // its card_id, so the result goes to a new card while the form stays above
      // as a 留痕. Detached so the click acks immediately (join is slow).
      void trackTask((async () => {
        const info = chatId ? await orStop(topicCtx.chatInfo(chatId), { ok: false, topic: false }) : undefined;
        // The group's other bot's project, looked up here and again below: the card carries no project id.
        const sibling = chatId && bindingBot ? await siblingProjectOfChat(chatId, bindingBot.appId).catch(() => undefined) : undefined;
        const formWithBots = { ...form, hasOtherBots: info?.ok && info.bots !== undefined ? info.bots > 1 : undefined, ...(sibling ? { sibling: { name: sibling.name } } : {}) };
        let result;
        if (!chatId)
          result = buildJoinGroupFormCard({ ...formWithBots, error: '缺少群标识，请重新从进群通知里打开绑定卡' });
        else if (!name) result = buildJoinGroupFormCard({ ...formWithBots, error: '项目名不能为空' });
        else if (!op) result = buildJoinGroupFormCard({ ...formWithBots, error: '无法识别操作者身份' });
        else {
          try {
            if (!bindingBot) throw new Error('缺少机器人注册身份，请重启后再绑定');
            const inChat = await withDeadline(channel.rawClient.im.v1.chatMembers.isInChat({ path: { chat_id: chatId } })
              .then(r => r.code === 0 && typeof r.data?.is_in_chat === 'boolean' ? r.data.is_in_chat : undefined, () => undefined), 3000, 'join-in-chat');
            if (inChat === false) throw new Error('我已经不在这个群里了：重新把我拉进群，会再收到一张设置卡。');
            const p = await joinExistingGroup(channel, {
              bot: bindingBot,
              name,
              chatId,
              addedBy: op,
              existingPath: cwdIn || undefined,
              ...(sibling && !cwdIn && parseProjectPick(formValue) === 'join' ? { project: sibling.id } : {}),
              projectsRootDir: cfg.preferences?.projectsRootDir,
              kind,
              noMention: parseNoMentionPick(formValue),
              backend,
              mode: bindModeFor(backend),
            });
            log.info('console', 'join-group', { name: p.name, blank: p.blank, backend: p.backend, mode: p.mode });
            result = buildNewProjectDoneCard(p, false, topic);
          } catch (err) {
            result = buildJoinGroupFormCard({ ...formWithBots, error: err instanceof Error ? err.message : String(err) });
          }
        }
        await sendManagedCard(channel, evt.chatId, result).catch((e) =>
          log.fail('console', e, { phase: 'join-group-result' }),
        );
      })());
    })
    .on(DM.projects, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const page = typeof value.p === 'number' ? value.p : Number(value.p) || 0;
      patch(evt, () => renderProjectList(page));
    })
    .on(DM.settings, async ({ evt }) => {
      if (dmAdmin(evt.operator?.openId)) {
        voiceConsole.leave(evt.messageId);
        await patch(evt, renderSettings);
      }
    })
    .on(DM.doctor, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      // A reply card (not a patch of the menu) so the diagnosis persists below
      // the console; re-open the menu by messaging the bot. 探测逻辑见 buildDoctorInfo。
      await sendManagedCard(channel, evt.chatId, buildDoctorCard(await buildDoctorInfo()), evt.messageId).catch((err) =>
        log.fail('console', err, { cmd: 'doctor' }),
      );
    })
    .on(DM.reconnect, async ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const conn = channel.getConnectionStatus?.()?.state ?? 'unknown';
      await sendManagedCard(channel, evt.chatId, buildReconnectCard(conn), evt.messageId).catch((err) =>
        log.fail('console', err, { cmd: 'reconnect' }),
      );
    })
    .on(DM.restart, ({ evt }) => {
      if (!dmAdmin(evt.operator.openId)) return;
      patch(evt, buildForegroundRestartCard());
    })
    .on(DM.restartDo, ({ evt }) => {
      if (!dmAdmin(evt.operator.openId)) return;
      patch(evt, buildForegroundRestartCard());
    })
    .on(DM.update, ({ evt }) => {
      if (!dmAdmin(evt.operator.openId)) return;
      patch(evt, renderForegroundUpdate);
    })
    .on(DM.updateDo, ({ evt }) => {
      if (!dmAdmin(evt.operator.openId)) return;
      patch(evt, renderForegroundUpdate);
    })
    .on(DM.usage, ({ evt }) => runUsage(evt, false))
    .on(DM.usageRefresh, ({ evt }) => runUsage(evt, true))
    // 分享：先弹「选择分享内容」表单卡（多选区块，不选=全部），提交后按所选区块
    // 动态拼装一张**新的**纯展示卡（不动控制台卡）——它零按钮、不再更新，数据定格
    // 在生成时刻，用户长按/右键即可原生转发（流式卡/带回调的卡转发会出问题）。
    .on(DM.usageShare, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, buildShareConfigCard());
    })
    .on(DM.usageShareDo, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const sections = parseShareSections(formValue?.secs);
      void trackTask((async () => {
        await new Promise((r) => setTimeout(r, CARD_SETTLE_MS));
        try {
          const data = await fetchUsageBundle();
          await sendManagedCard(channel, evt.chatId, buildUsageShareCard(data, { sections }), evt.messageId);
          log.info('console', 'usage-share', { sections: [...sections].join(',') });
          // 配置卡原地换成「已生成」态（带新表单，可换组合再来一张）
          await updateManagedCard(channel, evt.messageId, buildShareConfigCard(true)).catch(() => undefined);
        } catch (err) {
          log.fail('console', err, { phase: 'usage-share' });
          const reason = err instanceof UsageError ? err.message : '拉取用量数据失败';
          await channel
            .send(evt.chatId, { markdown: `⚠️ 生成分享卡失败：${reason}` }, { replyTo: evt.messageId })
            .catch(() => undefined);
        }
      })());
    })
    .on(DM.rmConfirm, async ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      if (!dmAdmin(evt.operator?.openId) || !name) return;
      const proj = (await listProjects()).find((p) => p.name === name);
      await patch(evt, buildRmConfirmCard(name, proj?.origin));
    })
    .on(DM.rmCancel, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, renderProjectList);
    })
    .on(DM.rmDo, ({ evt, value }) => {
      const name = typeof value.n === 'string' ? value.n : undefined;
      const op = evt.operator?.openId;
      if (!dmAdmin(op) || !name) return;
      // all the slow work (remove + owner transfer/leave + reply) runs in the
      // settle builder so the click acks immediately. The announcement vanishes
      // with the group once the owner dissolves it, so nothing to clean up here.
      patch(evt, async () => {
        const removed = await removeProject(name);
        if (removed?.chatId) { forgetAttention(removed.chatId, 'unbind'); markUnavailable(removed.chatId); }
        let tail: string;
        if (removed && (removed.origin ?? 'created') === 'joined') {
          // joined group: the bot is a plain member, not the owner — it just
          // leaves (never disbands; the group is the user's). Best-effort.
          const left = removed.chatId
            ? await leaveChat(channel, removed.chatId)
                .then(() => true)
                .catch((err) => {
                  log.fail('console', err, { phase: 'leave-chat' });
                  return false;
                })
            : false;
          log.info('console', 'rm', { name, origin: 'joined', left });
          tail = left
            ? '我已退出该群（群是你们的，不会解散）。'
            : '⚠️ 我退群失败（可能权限不足），可在群里手动把我移除。';
        } else {
          let transferred = false;
          if (removed?.chatId && op) {
            transferred = await transferOwnership(channel, removed.chatId, op)
              .then(() => true)
              .catch((err) => {
                log.fail('console', err, { phase: 'owner-transfer' });
                return false;
              });
          }
          log.info('console', 'rm', { name, origin: 'created', transferred });
          tail = transferred
            ? '群主已转给你 → 请在飞书里**自行解散该群**（机器人不主动解散）。'
            : '⚠️ 群主转让失败（可能 bot 非群主），请用「🚪 群管理」手动转让后解散。';
        }
        await channel
          .send(evt.chatId, { markdown: `✅ 已删除项目「${name}」（解绑，未删代码目录）。\n${tail}` }, { replyTo: evt.messageId })
          .catch(() => undefined);
        return renderProjectList();
      });
    })
    // Already-sent cards may still contain these Bot-wide controls. Explain the
    // per-chat route without writing a preference that no longer drives cards.
    .on(DM.setTools, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, renderSettings('消息卡现在按群聊和私聊分别设置。请在桌面端打开对应会话的「消息卡展示」，或在私聊告诉我想怎样显示。'));
    })
    .on(DM.setShowModel, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, renderSettings('消息卡现在按群聊和私聊分别设置。请在桌面端打开对应会话的「消息卡展示」，或在私聊告诉我想怎样显示。'));
    })
    .on(DM.setWatchdog, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n) && n >= 0) applyPref(evt, (p) => (p.runIdleTimeoutSeconds = normalizeRunIdleTimeoutSeconds(n)));
    })
    // 「自定义…」→ 打开输入卡（设置卡本身保持纯按钮、不会锁死）
    .on(DM.watchdogCustom, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, buildWatchdogCustomCard(cfg));
    })
    // 保存自定义秒数：钳到 [MIN, MAX]（0=关闭）后写入，确保存的值即为生效值；
    // applyPref 落盘并 patch 回设置卡，currentIdleMs() 下一轮立即读到新值。
    .on(DM.watchdogCustomSubmit, ({ evt, formValue }) => {
      const raw = String(formValue?.sec ?? '').trim();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        void patch(evt, buildWatchdogCustomCard(cfg));
        return;
      }
      applyPref(evt, (p) => (p.runIdleTimeoutSeconds = normalizeRunIdleTimeoutSeconds(n)));
    })
    .on(DM.setCompletionReminder, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const mode = value.v;
      if (mode !== 'manual' && mode !== 'long' && mode !== 'failures' && mode !== 'always') return;
      // Shared writer persists first and only then mutates LIVE cfg, so a disk
      // failure cannot create a setting that works until restart and vanishes.
      // Queue the write before the 500ms card-interaction settle delay: a task
      // finishing immediately after this click must already see the new policy.
      const saved = performSetCompletionReminder({
        cfg,
        mode: mode as CompletionReminderMode,
        writePreferences,
      }).then(
        (result) => {
          if (!result.ok) log.warn('console', 'completion-reminder-rejected', { reason: result.reason });
          else refreshCompletionReminderCards();
        },
        (err) => log.fail('console', err, { phase: 'save-config' }),
      );
      void patch(evt, async () => {
        await saved;
        return renderSettings();
      });
    })
    .on(DM.completionReminderCustom, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, buildCompletionReminderCustomCard(cfg));
    })
    .on(DM.completionReminderCustomSubmit, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const raw = String(formValue?.minutes ?? '').trim();
      const minutes = Number(raw);
      if (
        !Number.isInteger(minutes) ||
        minutes < COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES ||
        minutes > COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES
      ) {
        // A submitted form card becomes interaction-locked. Repaint it into a
        // fresh form so an invalid value is actually retryable instead of
        // leaving the user with a warning beside a dead input.
        void patch(evt, buildCompletionReminderCustomCard(cfg));
        return;
      }
      const saved = performSetCompletionReminder({
        cfg,
        mode: 'long',
        longTaskMinutes: minutes,
        writePreferences,
      }).then(
        (result) => {
          if (!result.ok) log.warn('console', 'completion-reminder-rejected', { reason: result.reason });
          else refreshCompletionReminderCards();
        },
        (err) => log.fail('console', err, { phase: 'save-config' }),
      );
      void patch(evt, async () => {
        await saved;
        return renderSettings();
      });
    })
    .on(DM.setPending, ({ evt, value }) => {
      if (value.v === 'steer' || value.v === 'queue') applyPref(evt, (p) => (p.pendingPolicy = value.v as PendingPolicy));
    })
    .on(DM.setConcurrency, ({ evt, value }) => {
      const n = Number(value.v);
      if (Number.isFinite(n)) applyPref(evt, (p) => (p.maxConcurrentRuns = n));
    })
    // 🏷️ 每个 Agent 后端独立配置。模型列表只用于方便选择，不充当白名单；
    // 表单也接受任意第三方模型 ID，运行时严格原样调用，失败即截断兜底。
    .on(DM.sessionTitleSettings, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, () => renderSessionTitleSettingsFor(evt.messageId));
    })
    .on(DM.sessionTitleSetBackend, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const backendId = typeof value.v === 'string' ? value.v : undefined;
      void patch(evt, () => renderSessionTitleSettingsFor(evt.messageId, backendId));
    })
    .on(DM.sessionTitleDisable, ({ evt, value }) => {
      const backendId = typeof value.b === 'string' ? value.b : '';
      applySessionTitlePref(evt, backendId, { enabled: false }, '✅ 已改为截断首句；以后新建的会话不调用标题模型。');
    })
    .on(DM.sessionTitleSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const backendId = typeof value.b === 'string' ? value.b : '';
      const parsed = parseSessionTitleFormValue(formValue);
      if (!parsed.ok) {
        sendFreshSettingsResult(
          evt,
          () => renderSessionTitleSettings(backendId, `⚠️ ${parsed.message}`),
          'session-title-submit-validation',
        );
        return;
      }
      if (!getSessionTitleEfforts(backendId).includes(parsed.config.effort)) {
        sendFreshSettingsResult(
          evt,
          () => renderSessionTitleSettings(backendId, '⚠️ 当前 Agent 不支持这个推理强度，未保存。'),
          'session-title-submit-validation',
        );
        return;
      }
      applySessionTitlePref(
        evt,
        backendId,
        parsed.config,
        `✅ 已保存：AI 精炼 · ${parsed.config.model} · ${reasoningEffortLabel(parsed.config.effort)}。仅影响以后新建的会话。`,
        true,
      );
    })
    // 📝 云文档评论 @bot 全局设置：Agent 按钮仅切换预览，模型/强度随表单一次保存；
    // 回复规则走 comment-instructions.md 文件，不塞进 config.json。
    .on(DM.commentSettings, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, () => renderCommentSettingsFor(evt.messageId));
    })
    .on(DM.commentSetBackend, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const v = typeof value.v === 'string' ? value.v : undefined;
      // Transient cascade source: fetch that Agent's models, but do not mutate
      // persistent comments config until the form is submitted.
      void patch(evt, () => renderCommentSettingsFor(evt.messageId, v));
    })
    // Model + effort form submit (one save for both). The dropdowns preselect the
    // current value, so a submit always carries a concrete model/effort to store.
    .on(DM.commentSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const backendId = typeof value.b === 'string' ? value.b : resolveCommentsExecution(cfg.preferences).backend;
      if (!commentBackendOptions().some((entry) => entry.id === backendId)) {
        sendFreshSettingsResult(
          evt,
          () => renderCommentSettings('⚠️ 这个 Agent 当前不可用，未保存。'),
          'comment-settings-submit-validation',
        );
        return;
      }
      const modelId = selectValue(formValue, 'model');
      const rawRequestedEffort = selectValue(formValue, 'effort');
      const requestedEffort = asEffort(rawRequestedEffort);
      if (rawRequestedEffort && !requestedEffort) {
        sendFreshSettingsResult(
          evt,
          () => renderCommentSettings('⚠️ 推理强度无效，未保存。请重新选择。', backendId),
          'comment-settings-submit-validation',
        );
        return;
      }
      void trackTask((async () => {
        const models = await listModels(backendFor(backendId)).catch(() => [] as ModelInfo[]);
        const resolved = resolveCommentModelFormValue(models, modelId, requestedEffort);
        if (!resolved.ok) {
          sendFreshSettingsResult(
            evt,
            () => renderCommentSettings(`⚠️ ${resolved.message}`, backendId),
            'comment-settings-submit-validation',
          );
          return;
        }
        const { model: selected, effort, adjusted } = resolved;
        const summary = `${selected.displayName || selected.id}${effort ? ` · ${reasoningEffortLabel(effort)}` : ''}`;
        applyCommentsPref(
          evt,
          (c) => {
            // An inherited backend stays inherited (s36d2): only a choice away from it is written.
            if (c.backend !== undefined || backendId !== botBackendId(cfg.preferences)) c.backend = backendId;
            c.model = selected.id;
            c.effort = effort;
          },
          {
            freshAfterSubmit: true,
            selectedBackendId: backendId,
            notice: adjusted
              ? `✅ 已保存：${summary}。所选强度不适用于这个模型，已自动调整。`
              : `✅ 已保存：${summary}。下一条新评论起生效。`,
          },
        );
      })().catch((err) => log.fail('console', err, { phase: 'comment-settings-submit' })));
    })
    // ✍️ 编辑提示词：打开预填当前 master 模板（含 {变量}）的编辑子卡。
    .on(DM.commentEditPrompt, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void patch(evt, async () =>
        buildCommentPromptCard(
          await loadCommentInstructions(paths.commentInstructionsFile),
          undefined,
          paths.commentInstructionsFile,
        ),
      );
    })
    // 保存提示词：写 master + 同步进所有评论工作目录（含历史）。停在编辑卡（不返回上一级），
    // 顶部出 ✅ 提示让用户看到保存成功，输入框预填刚保存的内容。
    .on(DM.commentPromptSubmit, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const content = typeof formValue?.prompt === 'string' ? formValue.prompt : '';
      void trackTask(saveCommentRulesFromCard(evt, { kind: 'custom', text: content }));
    })
    .on(DM.commentResetPrompt, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      void trackTask(saveCommentRulesFromCard(evt, { kind: 'default' }));
    })
    // The in-group settings card's buttons and forms (s1b, owner 2026-11-02): settings are a private chat's, so a card
    // still in a group from before changes nothing. Whoever clicks, it turns into the sentence that says where to change
    // them; the private chat's cards (DM.*) are not these.
    .on(GS.setNoMention, ({ evt }) => refuseGroupSettingsCard(evt))
    .on(GS.setAutoCompact, ({ evt }) => refuseGroupSettingsCard(evt))
    .on(GS.settings, ({ evt }) => refuseGroupSettingsCard(evt))
    .on(GS.modelDefault, ({ evt }) => refuseGroupSettingsCard(evt))
    .on(GS.modelDefaultSubmit, ({ evt }) => refuseGroupSettingsCard(evt))
    // ── 权限管理回调（admins 全局 / 项目响应白名单）。均 dmAdmin 门控（私聊管理台）。
    // 列表卡用 patch 原地重渲染（纯按钮不锁）；加人是 form 提交，结果发**新卡**（旧表单
    // 留痕），规避 select 锁卡。
    .on(DM.admins, showAdmins)
    // The list changes in the client and the terminal only (product.md section 6): an old card's buttons just redraw it.
    .on(DM.addAdminForm, showAdmins)
    .on(DM.addAdminSubmit, showAdmins)
    .on(DM.rmAdmin, showAdmins)
    .on(DM.allowlist, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return renderDmMenuCard();
        return buildAllowlistCard(p, await responseNames(evt, p));
      });
    })
    .on(DM.addAllowedForm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      if (!name) return;
      patch(evt, async () => {
        const p = await getProjectByName(name);
        const members = p?.chatId ? await readResponseRoster(channel, roster, p.chatId) : undefined;
        return buildAddAllowedCard(name, members);
      });
    })
    .on(DM.addAllowedSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const manual = String(formValue?.open_id ?? '').trim();
      const id = manual.startsWith('ou_') ? manual : pickOpenId(formValue);
      log.info('console', 'allow-add', { project: name, picked: id?.slice(-6) ?? null });
      void trackTask((async () => {
        // 函数式 updater：在 registry 临界区内基于最新盘值 append 去重，避免并发丢更新。
        if (id) await updateProject(name, (p) => ({ allowedUsers: Array.from(new Set([...(p.allowedUsers ?? []), id])) }));
        const fresh = await getProjectByName(name); // 写后回读，卡片显示与盘上一致
        if (!fresh) return;
        const card = buildAllowlistCard(fresh, await responseNames(evt, fresh));
        await sendManagedCard(channel, evt.chatId, card).catch((e) => log.fail('console', e, { phase: 'allow-add-result' }));
      })());
    })
    .on(DM.rmAllowed, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const id = typeof value.u === 'string' ? value.u : '';
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        await updateProject(name, (p) => ({ allowedUsers: (p.allowedUsers ?? []).filter((x) => x !== id) }));
        const fresh = await getProjectByName(name); // 写后回读，与盘上一致
        if (!fresh) return renderDmMenuCard();
        return buildAllowlistCard(fresh, await responseNames(evt, fresh));
      });
    })
    // 项目设置卡（可扩展容器）：打开 + DM 版免@开关（携带项目名 n，不能靠 evt.chatId）。
    .on(DM.projectSettings, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildProjectSettingsCard(p, backendDisplayName(p.backend)) : renderDmMenuCard();
      });
    })
    .on(DM.projectTopics, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return renderDmMenuCard();
        const sessions = (await listSessions()).filter((s) => s.chatId === p.chatId && !isRetiredKey(s.threadId));
        return buildProjectTopicsCard(p, sessions);
      });
    })
    // 写路径走管理面共享层（admin/ops.ts）——与 Web 控制台同一套校验/落盘/驱逐。
    .on(DM.setNoMentionDm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const on = value.v === 'on';
      patch(evt, async () => {
        const r = await performSetNoMention({ projectName: name, on });
        if (r.ok) return buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend));
        // Refused (turned 智能 since the card was sent, s25c): redraw it as it is now; a project gone goes to the menu.
        const p = await getProjectByName(name);
        return p ? buildProjectSettingsCard(p, backendDisplayName(p.backend), noMentionRefused(p, r.reason)) : renderDmMenuCard();
      });
    })
    // 旧卡上的 🗜️ 自动压缩按钮：同群设置，不写盘，只刷新卡。
    .on(DM.setAutoCompactDm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildProjectSettingsCard(p, backendDisplayName(p.backend), AUTO_COMPACT_RETIRED) : renderDmMenuCard();
      });
    })
    // 🔐 权限：打开单个权限下拉表单，联网随档。
    .on(DM.permission, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        const be = groupBackend(p);
        return p ? buildPermissionCard(p, permissionTable(groupBackendId(p)), tableEnv(be)) : renderDmMenuCard();
      });
    })
    // 提交权限表单：落盘 mode、清自定义并让联网随档，再驱逐本项目活跃会话让新档立即生效（沙箱
    // 在 thread/start 绑定后不可变）。表单卡 card_id 提交后会锁，故发一张全新的项目设置卡
    // （旧表单卡留痕），不 patch 原卡。
    .on(DM.permissionSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const mode = asTier(selectValue(formValue, 'mode'));
      // Old cards (including the separate network field) save nothing; send a current card.
      const oldCard = value.v !== PERMISSION_CARD_VERSION || selectValue(formValue, 'guestMode') !== undefined;
      void trackTask((async () => {
        const p = await getProjectByName(name);
        const be = groupBackend(p);
        const table = permissionTable(groupBackendId(p)), env = tableEnv(be);
        if (p && (oldCard || (mode !== undefined && tierInfo(table, env, mode).unavailable))) {
          log.info('console', 'permission-refused', { project: name, mode, reason: oldCard ? 'old-card' : 'tier-unavailable' });
          await sendManagedCard(channel, evt.chatId, buildPermissionCard(p, table, env)).catch((e) => log.fail('console', e, { phase: 'permission-result' }));
          return;
        }
        if (mode === undefined) {
          await channel.send(evt.chatId, { markdown: '没有改动。' }, { replyTo: evt.messageId })
            .catch(e => log.fail('console', e, { phase: 'permission-result' }));
          return;
        }
        // 共享层（admin/ops.ts）：落盘 + 驱逐活跃会话让新档立即生效；写后回读，
        // 卡片与盘上一致——与 Web 控制台的 setPermissionMode 完全同一条路径。
        const wasFull = p ? groupPermission(p).effect.mode === 'full' : false;
        const r = await performSetPermissionMode({ projectName: name, mode, backendFor, evictLiveSessionsForChat });
        if (!r.ok) return;
        log.info('console', 'permission', { project: name, mode });
        await sendManagedCard(channel, evt.chatId, buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend))).catch((e) =>
          log.fail('console', e, { phase: 'permission-result' }),
        );
        // devices 第 15 节：把群改成完全访问时带上这句。
        if (mode === 'full' && !wasFull)
          await channel.send(evt.chatId, { markdown: FULL_ACCESS_WARNING }).catch(e => log.fail('console', e, { phase: 'permission-result' }));
      })());
    })
    // 🤖 默认模型/强度：打开下拉表单子卡（按项目后端实时列模型；选完提交）。
    .on(DM.modelDefault, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return renderDmMenuCard();
        const models = await listModels(groupBackend(p));
        return buildModelDefaultCard(p, models, 'dm');
      });
    })
    // 提交默认模型表单：对该后端**实时**模型列表校验所选 model（不在列表 / 已下架即拒、
    // 不落盘），effort 按所选模型 supportedEfforts 收窄；落盘但**不驱逐**活跃会话（默认只
    // 管新话题）。表单卡提交后 card_id 锁，故发一张全新项目设置卡（带结果提示），不 patch。
    .on(DM.modelDefaultSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      void trackTask((async () => {
        const p = await getProjectByName(name);
        if (!p) return;
        const backendId = groupBackendId(p);
        const models = await listModels(backendFor(backendId));
        const parsed = parseModelDefaultFormValue(formValue, models, backendId);
        if (!parsed.ok) {
          // 无效的选择或手填的 id：带提示重发表单，让管理员直接改。
          await sendManagedCard(channel, evt.chatId, buildModelDefaultCard(p, models, 'dm', `⚠️ ${parsed.message}`));
          return;
        }
        const { model, effort, custom } = parsed;
        const r = await performSetModelDefault({ projectName: name, model, effort, custom });
        const label = custom ? `手填的 ${modelIdCode(model)}` : `「${parsed.label}」`;
        const notice = r.ok ? `✅ 默认已设为${label}${effort ? ` · 强度 ${effort}` : ''}，新话题生效。` : `⚠️ ${r.reason}`;
        if (r.ok) log.info('console', 'project-model-default', { project: name, model, effort, custom });
        const fresh = (await getProjectByName(name)) ?? p;
        await sendManagedCard(
          channel,
          evt.chatId,
          buildProjectSettingsCard(fresh, backendDisplayName(fresh.backend), notice),
        );
      })().catch((e) => log.fail('console', e, { phase: 'model-default-result' })));
    });
  // 〔已移除〕DM.backend / DM.backendSubmit 处理器（项目后端「运行时切换」检测卡 +
  // 单点切换）。产品改为「创建时选定、运行时固定、不支持切换」后整条路径废弃：UI 入口
  // 已撤、卡构建器（buildBackendDetectingCard/PickerCard）已删；防御仍在 performBackendSwitch
  // （已设 backend 切异值即拒）。创建时选后端见 DM.newProjectSubmit。

  /**
   * From a /resume card: read the past thread's transcript, post a collapsible
   * history card as reply_in_thread (which creates the topic) and bind the codex
   * thread to that topic. No filler turn — the session resumes lazily on the
   * topic's first message via {@link resolveThread}, so the user just continues.
   * Detached — never holds the card-action callback for the whole flow. On
   * failure the picker card flips to a (non-retryable) error and pending clears.
   */
  async function resumeFromCard(
    evt: CardActionEvent,
    state: ResumeCardState,
    sessionId: string,
    backendId?: string,
  ): Promise<void> {
    // The backend that listed this session (from the button value / card state);
    // unset on legacy cards → default (codex), the historical behavior.
    const be = backendFor(backendId);
    try {
      // Another place of the group holds the picked session: refuse and say where (s15f).
      const holder = await resumeHolder(state.chatId, state.flat ? state.sessionKey : undefined, be.id, sessionId);
      if (holder) {
        resumePending.delete(evt.messageId);
        settleUpdate(evt.messageId, buildResumeErrorCard(state, inUseText(holder)));
        return;
      }
      // Single-session group (flat): rebind the group's session key IN PLACE —
      // post the same history card flat (no reply_in_thread, so no topic) and
      // repoint the record. Binding is deterministic (the key IS the chatId
      // session key), so none of the multi path's topic-thread-id resolution /
      // "bound?" uncertainty applies.
      if (state.flat && state.sessionKey) {
        const sessionKey = state.sessionKey;
        // Rebinding under a live turn would swap the thread out from under it —
        // refuse and tell the admin to wait (the picked session is untouched).
        if (active.get(sessionKey)) {
          resumePending.delete(evt.messageId);
          settleUpdate(evt.messageId, buildResumeErrorCard(state, '当前有任务在跑，结束后再 /resume'));
          return;
        }
        // Reserve SYNCHRONOUSLY (mirrors runCompact/runClear): readHistory is a
        // long await, and a message racing in during it must NOT start a turn we
        // then evict out from under. Held until the rebind settles; released in
        // finally, with a notice for anything that queued and never ran.
        const reserved: ActiveState = { queue: [], requesterOpenId: state.requesterOpenId };
        active.set(sessionKey, reserved);
        try {
          const history = await scopedHistory(be,state.chatId,state.cwd,sessionId);
          resumePending.delete(evt.messageId);
          let taken: SessionRecord | undefined;
          await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
            const now = Date.now();
            // Bound before the history card goes out: a place that took the session meanwhile wins (s15f).
            taken = await bindSession({
              threadId: sessionKey,
              chatId: state.chatId,
              cwd: state.cwd,
              sessionId,
              backend: be.id,
              summary: resumedTitle(history) || '(恢复会话)',
              createdAt: now,
              updatedAt: now,
            });
            if (taken) {
              log.info('card', 'resume-in-use', { sessionKey, sessionId, holder: taken.threadId });
              return;
            }
            const cardState: HistoryCardState = { cwd: state.cwd, projectName: state.projectName, backendName: backendLabel(be), history };
            await sendManagedCard(channel, state.chatId, buildHistoryCard(cardState), state.originalMsgId, false).catch((err) =>
              log.fail('card', err, { phase: 'resume-history-single' }),
            );
            // Evict + close the current live thread at this key so the NEXT message
            // resumes the PICKED session via resolveThread (a live thread would win
            // the fast path and keep the old session running).
            const old = sessions.get(sessionKey);
            if (old) {
              sessions.delete(sessionKey);
              void trackTask(old.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
            }
            lastUsage.delete(sessionKey); // context gauge reflects the resumed thread on its next turn
            dropRetries(sessionKey); // the next turn runs in the picked session
            log.info('card', 'resume-done-single', { sessionKey, sessionId, turns: history.totalTurns });
          });
          settleUpdate(evt.messageId, taken ? buildResumeErrorCard(state, inUseText(taken)) : buildResumeDoneCard(state));
        } finally {
          if (active.get(sessionKey) === reserved) active.delete(sessionKey);
          const dropped = askAgain(reserved.queue, state.chatId, 'main', 'occupied', '会话被占用');
          if (dropped > 0) {
            await channel
              .send(
                state.chatId,
                { markdown: `⚠️ 切回期间收到的 ${dropped} 条消息未进入会话，请重发。` },
                { replyTo: state.originalMsgId },
              )
              .catch(() => undefined);
          }
        }
        return;
      }
      // thread/read: fetch the transcript without starting a turn or holding the
      // session live (model/effort left to the thread's own remembered config).
      // Never throws — empty history just yields a minimal card.
      const history = await scopedHistory(be,state.chatId,state.cwd,sessionId);
      resumePending.delete(evt.messageId);

      let bound = false;
      let taken: SessionRecord | undefined;
      let busy = false;
      await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
        const cardState: HistoryCardState = { cwd: state.cwd, projectName: state.projectName, backendName: backendLabel(be), history };
        // reply_in_thread on the /resume message turns it into the topic; the
        // history card is that topic's first message.
        const sent = await sendManagedCard(channel, state.chatId, buildHistoryCard(cardState), state.originalMsgId, true);
        // Binding the codex thread to the topic hinges entirely on resolving the
        // topic thread_id (no live thread to fall back on, unlike the run path) —
        // a miss would make the next message start a FRESH empty session. The
        // reply response omits thread_id and the raw lookup can lag right after
        // the reply, so retry a few times before giving up.
        const tid = await getThreadId(channel, sent.messageId, 4);
        if (tid) {
          // Titled by the resumed session's name: the first message is the `/resume` itself.
          noteOpenedTopic(state.chatId, tid, { id: state.originalMsgId, text: resumedTitle(history) });
        }
        if (tid && (active.has(tid) || sessions.has(tid))) {
          // A message in the new topic started a session before the topic's id came back: the
          // topic keeps that one, as the web resume refuses such a topic.
          busy = true;
          await noteUnbound(state.chatId, sent.messageId, RESUME_TOPIC_BUSY);
        } else if (tid) {
          // Held while binding, as the web resume holds it: a message meanwhile is named for resending.
          const reserved: ActiveState = { queue: [], requesterOpenId: state.requesterOpenId };
          active.set(tid, reserved);
          try {
            const now = Date.now();
            taken = await bindSession({
              threadId: tid,
              chatId: state.chatId,
              cwd: state.cwd,
              sessionId,
              backend: be.id,
              summary: resumedTitle(history) || '(恢复会话)',
              createdAt: now,
              updatedAt: now,
            });
            // Another place took the session while this topic opened (s15f): the topic stays without it.
            if (taken) await noteUnbound(state.chatId, sent.messageId, inUseText(taken));
            bound = !taken;
          } finally {
            if (active.get(tid) === reserved) active.delete(tid);
            const dropped = askAgain(reserved.queue, state.chatId, 'topic', 'occupied', '会话被占用');
            if (dropped > 0) {
              await channel
                .send(state.chatId, { markdown: `⚠️ 恢复期间收到的 ${dropped} 条消息未进入会话，请重发。` }, { replyTo: sent.messageId, replyInThread: true })
                .catch(() => undefined);
            }
          }
        } else {
          log.warn('card', 'resume-no-threadid', { messageId: sent.messageId });
        }
        log.info('card', 'resume-done', { sessionId, threadId: tid ?? null, bound, turns: history.totalTurns, ...(taken ? { holder: taken.threadId } : {}), ...(busy ? { busy } : {}) });
      });

      // Only promise continuity once the thread is actually bound — else the
      // next message silently starts a fresh session, so say so instead of
      // claiming success. settleUpdate keeps this ordered after the launching
      // card the RES.pick handler settle-pushed (normally the done push runs
      // last; a 200810 retry on the launching push could in theory reorder, but
      // the 500ms settle window avoids that in practice).
      settleUpdate(
        evt.messageId,
        bound
          ? buildResumeDoneCard(state)
          : buildResumeErrorCard(state, taken ? inUseText(taken) : busy ? RESUME_TOPIC_BUSY : '已建话题但未能绑定会话，请重新 /resume'),
      );
    } catch (err) {
      state.launching = false;
      log.fail('card', err, { phase: 'resume-launch' });
      settleUpdate(evt.messageId, buildResumeErrorCard(state, err instanceof Error ? err.message : String(err)));
    }
  }

  const projectMutations = new Set<string>();
  const runIds = new WeakMap<ActiveState, { run: AgentRun | undefined; id: string }>();
  let createChain: Promise<unknown> = Promise.resolve();
  /** Aborts every Feishu call of a creation still running when the bridge stops, so the drain does not wait out its budget. */
  const creationStop = new AbortController();
  onStop.add(() => creationStop.abort());
  /** DM and web creations run one at a time (s36d1): a name both pick at once is refused locally, not created twice.
   * One that reaches its turn after shutdown began is refused without calling Feishu. */
  function serialCreate<T>(create: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const result = createChain.then(() => {
      if (shuttingDown) throw new AdminWriteError(CREATION_STOPPING);
      return create(creationStop.signal);
    });
    createChain = result.catch(() => undefined);
    return result;
  }
  const createRequests = new Map<string, { signature: string; result: Promise<unknown> }>();
  const runId = (state: ActiveState): string => {
    let identity = runIds.get(state);
    if (!identity || identity.run !== state.run) { identity = { run: state.run, id: randomUUID() }; runIds.set(state, identity); }
    return identity.id;
  };
  const DESKTOP_RECEIPT_WARNING = '操作已生效，但未能确认飞书回执已送达，请到群里确认；无需重复执行。';
  type DesktopSessionResult = { ok: true; threadId: string; message: string; warning?: string };
  /** One send only: a rejected promise can mean Feishu accepted the message but its reply was lost. */
  async function desktopReceipt(chatId: string, key: string, markdown: string, replyTo?: string): Promise<boolean> {
    try {
      const sent = await channel.send(chatId, { markdown }, replyTo ? { replyTo, replyInThread: true } : undefined);
      recent.addOwn(key, chatId, { id: sent.messageId, at: Date.now(), text: markdown });
      return true;
    } catch (error) {
      log.fail('desktop', error, { phase: 'session-receipt', threadId: key });
      return false;
    }
  }
  /** A topic receipt must stay in that topic. Resolve it before any session mutation. */
  async function desktopTopicReply(chatId: string, key: string): Promise<string | undefined> {
    if (isMainKey(key, chatId)) return undefined;
    const messages = await channel.rawClient.im.v1.message.list({ params: { container_id_type: 'thread', container_id: key, page_size: 1 } });
    const message = messages.data?.items?.[0];
    if (messages.code !== 0 || !message?.message_id || (message.chat_id && message.chat_id !== chatId) || (message.thread_id && message.thread_id !== key)) {
      throw new AdminWriteError('无法定位原飞书话题，请在飞书确认话题仍然存在');
    }
    return message.message_id;
  }
  async function updateHistoryReceipt(messageId: string, state: HistoryCardState): Promise<boolean> {
    try { return await updateManagedCard(channel, messageId, buildHistoryCard(state)); }
    catch (error) {
      log.fail('card', error, { phase: 'resume-history-update', messageId });
      return false;
    }
  }
  async function collaboration(request: CollaborationRequest): Promise<unknown> {
    // Who a new group is for and who gets a group this Bot leaves: its primary admin, unless a private chat's creation
    // says who asked (dm-agent 6.4), when this Bot needs no admin of its own.
    const primary = primaryAdmin(cfg);
    const invitee: GroupInvitee | undefined = (request.action === 'createProject' ? request.invitee : undefined) ?? (primary ? { idType: 'open_id', id: primary } : undefined);
    if (!invitee) throw new AdminWriteError('请先给这个 Bot 添加管理员');
    const admin = invitee.id;
    if (request.action === 'usage') return { data: await fetchUsageBundle(request.force) };
    if (request.action === 'createProject') {
      const signature = JSON.stringify(request);
      const persisted = (await listProjects()).find(item => item.creationRequestId === request.requestId);
      if (persisted) {
        if (persisted.creationRequestSignature !== signature) throw new AdminWriteError('创建请求标识已用于其他参数');
        return { ok: true, project: projectView(persisted) };
      }
      const prior = createRequests.get(request.requestId);
      if (prior) {
        if (prior.signature !== signature) throw new AdminWriteError('创建请求标识已用于其他参数');
        return prior.result;
      }
      if (!bindingBot) throw new AdminWriteError('缺少机器人注册身份，请重启后再建群');
      const bot = bindingBot;
      const result = serialCreate(async signal => {
        const directory = request.directory === undefined ? undefined : await realpath(request.directory);
        if (directory !== undefined && !(await stat(directory)).isDirectory()) throw new AdminWriteError('所选文件夹不是目录');
        const project = await createProject(channel, { requestId: request.requestId, requestSignature: signature, bot, botName: channel.botIdentity?.name, name: request.name, invitee, existingPath: directory, project: request.project, projectsRootDir: cfg.preferences?.projectsRootDir, kind: request.kind, noMention: request.noMention, backend: request.backend, judge: request.judge, mode: bindModeFor(request.backend), signal });
        return { ok: true, project: projectView(project) };
      }).catch((error: unknown) => {
        // Every refusal crosses IPC as the bot's own word; a result not known stays a plain error, which the RPC
        // layer reports as "maybe created" together with a lost connection or a bot that never answered. A group
        // created and not saved keeps its own code, so the web locks its form as the DM does (s36d1).
        if (error instanceof CreationOutcomeUnknownError || error instanceof CreatedButUnsavedError || error instanceof AdminWriteError) throw error;
        throw new AdminWriteError(error instanceof Error ? error.message : String(error));
      });
      void result.then(() => createRequests.delete(request.requestId), () => createRequests.delete(request.requestId));
      createRequests.set(request.requestId, { signature, result });
      return result;
    }
    const project = await getProjectByName(request.projectName);
    if (!project || project.chatId !== request.chatId) throw new AdminWriteError('项目已改变，请刷新后重试');
    if (request.action === 'project') return { project: projectView(project) };
    if (request.action === 'shareUsage') {
      const sections = parseShareSections(request.sections);
      const sent = await sendManagedCard(channel, project.chatId, buildUsageShareCard(await fetchUsageBundle(), { sections }));
      return { messageId: sent.messageId };
    }
    // Keys from before s15c (two tiers) are left in the store, never used: not listed, not acted on.
    const records = (await listSessions()).filter(record => record.chatId === project.chatId && !isRetiredKey(record.threadId));
    const currentProject = await getProjectByName(project.name);
    if (!currentProject || projectRevision(currentProject) !== projectRevision(project)) throw new AdminWriteError('项目已改变，请刷新后重试');
    const be = groupBackend(project);
    if (request.action === 'history') {
      try { return { sessions: records, threads: (await scopedThreads(be,project.chatId,project.cwd)).map(resumableThread), backend: be.id }; }
      catch (error) { return { sessions: records, threads: [], backend: be.id, threadsError: error instanceof Error ? error.message : '无法读取后端历史' }; }
    }
    if (request.action === 'editProject' || request.action === 'removeProject') {
      if (projectRevision(project) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
      if (projectMutations.has(project.chatId) || runningIn(project.chatId) || intakeChats.has(project.chatId) || pendingTopics.has(project.chatId)) {
        holdFiring(project.chatId, FIRING_HOLD_MS); // no scheduled run starts before the retry
        throw new AdminWriteError('Agent 正在执行任务，请结束后修改项目');
      }
      let edited: { ok: true; project: ReturnType<typeof projectView> } | undefined;
      projectMutations.add(project.chatId);
      try {
        const current = await getProjectByName(project.name);
        if (!current || projectRevision(current) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
        if (request.action === 'removeProject') {
          const removed = await removeProject(project.name, latest => {
            if (projectRevision(latest) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
          });
          if (!removed) throw new AdminWriteError('项目已移除，请刷新');
          forgetAttention(project.chatId, 'unbind');
          markUnavailable(project.chatId);
          for (const rec of records) { const thread = sessions.get(rec.threadId); sessions.delete(rec.threadId); if (thread) await thread.close().catch(error => log.fail('desktop', error, { phase: 'project-session-close' })); }
          let groupEffect: 'left' | 'transferred' | 'failed';
          let warning: string | undefined;
          try {
            if (project.origin === 'joined') { await leaveChat(channel, project.chatId); groupEffect = 'left'; }
            else { await transferOwnership(channel, project.chatId, admin); groupEffect = 'transferred'; }
          } catch (error) { groupEffect = 'failed'; warning = error instanceof Error ? error.message : '飞书群操作失败'; }
          return { ok: true, groupEffect, ...(warning ? { warning } : {}) };
        }
        const patch: Partial<Project> = {};
        // A row of a library project mirrors its workspace; the host funnels every change through the library
        // (admin/library.ts), so a folder arriving here for such a row did not come that way.
        if (request.directory !== undefined && isProjectId(project.projectId)) throw new AdminWriteError('这个群的工作区归项目管，请改项目的工作区');
        // 换到别的项目: the row names the other project and mirrors its workspace; the group's sessions start over.
        let rebind: LibraryProject | undefined;
        if (request.project !== undefined) {
          if (request.directory !== undefined) throw new AdminWriteError('换项目和改文件夹要分两次');
          rebind = (await readLibrary()).projects.find(item => item.id === request.project);
          if (!rebind) throw new AdminWriteError('项目不存在，请刷新');
          if (rebind.id === project.projectId) rebind = undefined;
        }
        if (request.directory !== undefined) {
          // The same admission as creating and binding (s36c2d). Only a new directory is checked, so an old row already
          // in a refused place can still be turned off; the first change gives an old row its declaration.
          let cwd: string;
          try { cwd = await realpath(request.directory); } catch { throw new AdminWriteError('所选文件夹不存在'); }
          if (!(await stat(cwd)).isDirectory()) throw new AdminWriteError('所选文件夹不是目录');
          const admitted = await admitDirectorySettings({ workspaces: { primary: cwd, additional: [] } }, { dataDir: paths.appDir })
            .catch((error: unknown) => { const failure = directoryFailure(error); throw failure instanceof DirectoryError ? new AdminWriteError(failure.message) : failure; });
          cwd = admitted?.workspaces?.primary ?? cwd;
          patch.cwd = cwd;
          if (cwd !== project.cwd) patch.blank = false;
        }
        if (request.enabled !== undefined) patch.enabled = request.enabled;
        // The page sends the 会话方式 it shows, so an unchanged one (智能 included) is left alone (s25c).
        const mode = request.kind;
        if (mode === 'smart' && sessionModeOf(project) !== 'smart') {
          const selected = parseStoredJudge(project.judge, backendIds()).value;
          if (!selected && project.judge !== undefined) throw new AdminWriteError('本群决策模型设置无效，请重新选择');
          try {
            if (selected?.kind === 'default') patch.judge = await snapshotDefaultJudge({ backendFor });
            else if (selected?.kind === 'provider') patch.judge = await snapshotProviderJudge(selected.provider, { backendFor });
            else if (selected?.kind === 'decision') await requireDecisionKey(selected.provider);
            // Old groups without their own choice retain Bot inheritance. New groups already have a snapshot.
          } catch (error) {
            throw new AdminWriteError(error instanceof Error ? error.message : '无法确认决策模型');
          }
        }
        const commit = () => mutateProject(project.name, latest => {
          if (projectRevision(latest) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
          // Switching 会话方式 leaves 免@ as it was (3.4): pin the value it read as before. 智能 has none, so leaving it
          // writes 关, what it ran as, and entering it stores 关 too (storedMode), the value older daemons read.
          if (mode !== undefined && mode !== sessionModeOf(latest)) {
            if (latest.noMention === undefined || sessionModeOf(latest) === 'smart') latest.noMention = noMentionOf(latest);
            delete latest.smart;
            Object.assign(latest, storedMode(mode));
          } else if (sessionModeOf(latest) === 'smart') latest.noMention = false; // a hand-edited 开 too: older daemons read it (审查低)
          else if (mode !== undefined) delete latest.smart; // left by an old daemon, never counted
          Object.assign(latest, patch);
          if (patch.cwd !== undefined) latest.directories = { ...latest.directories, workspaces: { primary: patch.cwd, additional: latest.directories?.workspaces?.additional ?? [] } };
          if (rebind) {
            latest.projectId = rebind.id;
            latest.migration = { ...latest.migration, library: Date.now() };
            applyMirror(latest, rebind.workspace);
          }
        }, { mirror: rebind !== undefined });
        // 单会话 and 智能 share the main area's session (keyed by chatId): switching between them archives nothing.
        const archive = (patch.cwd !== undefined && patch.cwd !== project.cwd) || rebind !== undefined || (mode !== undefined && (mode === 'multi' ? 'multi' : 'single') !== ruleKind(project));
        const updated = archive ? await detachSessionsForChat(project.chatId, commit) : await commit();
        if (sessionModeOf(updated) !== sessionModeOf(project)) forgetAttention(project.chatId, 'mode');
        if (archive) expireRetries((retry) => retry.chatId === project.chatId); // its sessions start over
        for (const rec of records) {
          const thread = sessions.get(rec.threadId); sessions.delete(rec.threadId);
          if (thread) await thread.close().catch(error => log.fail('desktop', error, { phase: 'project-session-close' }));
        }
        edited = { ok: true, project: projectView(updated) };
      } finally { projectMutations.delete(project.chatId); }
      // Switching to 智能 says nothing in the group (owner 2026-11-08): the bot just starts reading.
      return edited;
    }
    if (projectMutations.has(project.chatId) || project.enabled === false) throw new AdminWriteError('项目已停用或正在修改');
    const perm = turnSession(project.chatId, project);
    if (request.action === 'resume') {
      if (request.backend !== be.id) throw new AdminWriteError('项目后端已改变');
      const available = await scopedThreads(be,project.chatId,project.cwd);
      if (!available.some(item => item.sessionId === request.sessionId)) throw new AdminWriteError('历史会话不属于当前项目');
      // Another place of the group holds it (s15f); a single group's own key may take it again.
      const holder = await resumeHolder(project.chatId, ruleKind(project) === 'single' ? perm.sessionKey : undefined, be.id, request.sessionId);
      if (holder) throw new AdminWriteError(inUseText(holder));
      const current = await getProjectByName(project.name);
      if (!current || projectMutations.has(project.chatId) || projectRevision(current) !== projectRevision(project)) throw new AdminWriteError('项目已改变，请刷新后重试');
      const key = ruleKind(project) === 'single' ? perm.sessionKey : `desktop-resume:${project.chatId}`;
      if (active.has(key) || intakeChats.has(project.chatId) || pendingTopics.has(project.chatId)) throw new AdminWriteError('会话正在运行');
      const reserved: ActiveState = { queue: [], requesterOpenId: admin, requesterKind: 'user', smart: sessionModeOf(project) === 'smart' };
      active.set(key, reserved);
      if (ruleKind(project) !== 'single') resumePublications.add(project.chatId);
      let publishedKey: string | undefined;
      let topicCard: string | undefined;
      let cardState: HistoryCardState | undefined;
      let applied: DesktopSessionResult | undefined;
      try {
        const history = await scopedHistory(be,project.chatId,project.cwd,request.sessionId);
        cardState = { cwd: project.cwd, projectName: project.name, backendName: backendLabel(be), history, source: 'desktop' };
        let threadId = key;
        if (ruleKind(project) !== 'single') {
          const root = await channel.send(project.chatId, { markdown: '从桌面端恢复历史会话' });
          recent.addOwn(project.chatId, project.chatId, { id: root.messageId, at: Date.now(), text: '从桌面端恢复历史会话' });
          const sent = await sendManagedCard(channel, project.chatId, buildHistoryCard({ ...cardState, status: 'pending' }), root.messageId, true);
          topicCard = sent.messageId;
          const tid = await getThreadId(channel, sent.messageId, 4);
          if (!tid) throw new AdminWriteError('已创建话题，但飞书尚未返回话题标识；会话未绑定');
          noteOpenedTopic(project.chatId, tid, { id: root.messageId, from: { kind: 'self' }, at: Date.now(), text: resumedTitle(history) });
          threadId = turnSession(tid, project).sessionKey;
          if (active.has(threadId) || sessions.has(threadId)) throw new AdminWriteError('新话题已有任务，会话未切换');
          active.set(threadId, reserved);
          publishedKey = threadId;
        }
        const now = Date.now();
        // Bound before the main area's history card and its thread swap (s15f): when another place
        // took the session meanwhile, nothing here changes; a new topic says it got none.
        const taken = await bindSession({ threadId, chatId: project.chatId, cwd: project.cwd, sessionId: request.sessionId, backend: be.id, summary: resumedTitle(history) || '(恢复会话)', createdAt: now, updatedAt: now });
        if (taken) {
          if (topicCard) await noteUnbound(project.chatId, topicCard, inUseText(taken));
          throw new AdminWriteError(inUseText(taken));
        }
        // Commit the local swap before announcing success; delivery never changes the operation's result.
        const old = sessions.get(threadId); sessions.delete(threadId);
        if (old) await old.close().catch(error => log.fail('desktop', error, { phase: 'resume-thread-close' }));
        lastUsage.delete(threadId);
        dropRetries(threadId);
        applied = { ok: true, threadId, message: '已恢复会话。' };
        if (topicCard) {
          if (!await updateHistoryReceipt(topicCard, cardState)) applied.warning = DESKTOP_RECEIPT_WARNING;
        } else {
          await sendManagedCard(channel, project.chatId, buildHistoryCard(cardState)).catch(error => {
            log.fail('desktop', error, { phase: 'resume-history-single' });
            applied!.warning = DESKTOP_RECEIPT_WARNING;
          });
        }
        return applied;
      } catch (error) {
        if (!applied && topicCard && cardState) await updateHistoryReceipt(topicCard, { ...cardState, status: 'failed', error: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        resumePublications.delete(project.chatId);
        if (publishedKey && active.get(publishedKey) === reserved) active.delete(publishedKey);
        if (active.get(key) === reserved) active.delete(key);
        const dropped = askAgain(reserved.queue, project.chatId, ruleKind(project) === 'single' ? 'main' : 'topic', 'occupied', '会话被占用');
        if (dropped && !await desktopReceipt(project.chatId, publishedKey ?? project.chatId, `切回期间收到的 ${dropped} 条消息未执行，请重发。`, topicCard)) {
          if (applied) applied.warning = DESKTOP_RECEIPT_WARNING;
        }
      }
    }
    if (isRetiredKey(request.threadId)) throw new AdminWriteError(RETIRED_KEY_TEXT);
    const record = records.find(item => item.threadId === request.threadId);
    if (!record || record.detached) throw new AdminWriteError('此会话已归档或不属于当前项目，请开始新会话');
    const key = record.threadId;
    const state = active.get(key);
    if (request.action === 'context') return { threadId: key, usage: lastUsage.get(key) ?? null, run: state ? { id: runId(state), goal: state.isGoal === true, canStop: Boolean(state.interrupt), canEndGoal: Boolean(state.endGoal), canRemind: state.requesterOpenId === admin && reminderButtonOffered(state.presentation ?? cfg, state) && !state.isGoal, reminderRequested: state.completionReminderRequested === true, subagents: (state.subagents?.() ?? []).map(({ id, name, task, status, stoppable }) => ({ id, name, task, status, stoppable })) } : null };
    if (request.action === 'stopSubagent') {
      if (!state || runId(state) !== request.runId) throw new AdminWriteError('原任务已经结束，请刷新');
      if (!state.run?.stopSubagent) throw new AdminWriteError('这个任务不支持单独停止子 agent');
      try { await state.run.stopSubagent(request.subagentId); }
      catch (error) { throw new AdminWriteError(error instanceof Error ? error.message : String(error)); }
      return { ok: true };
    }
    if (request.action === 'stop' || request.action === 'endGoal' || request.action === 'reminder') {
      if (!state || runId(state) !== request.runId) throw new AdminWriteError('原任务已经结束，请刷新');
      if (request.action === 'stop') { if (!state.interrupt) throw new AdminWriteError('任务正在准备，请稍后停止'); state.interrupt(); }
      else if (request.action === 'endGoal') { if (!state.endGoal) throw new AdminWriteError('当前不是目标任务'); state.endGoal(); }
      else {
        if (state.requesterOpenId !== admin || !reminderButtonOffered(state.presentation ?? cfg, state) || state.isGoal) throw new AdminWriteError('仅任务发起人可设置本次完成提醒，且需开启手动提醒模式');
        state.completionReminderRequested = request.requested;
        refreshCompletionReminderCards();
      }
      return { ok: true };
    }
    if (state) throw new AdminWriteError('会话正在运行，请完成后重试');
    if (record.cwd !== project.cwd) throw new AdminWriteError('此历史会话使用原项目目录，请选择新会话');
    const sessionBackend = backendFor(record.backend);
    if (request.action === 'startGoal' && sessionBackend.capabilities?.goal === false) throw new AdminWriteError('当前后端不支持自主目标');
    if (request.action === 'compact' && sessionBackend.capabilities?.compact === false) throw new AdminWriteError('当前后端不支持手动压缩');
    const reserved: ActiveState = { queue: [], requesterOpenId: admin, requesterKind: 'user', smart: sessionModeOf(project) === 'smart', isGoal: request.action === 'startGoal' };
    active.set(key, reserved);
    let launched = false;
    let compacted: AgentThread | undefined;
    let applied: DesktopSessionResult | undefined;
    let replyTo: string | undefined;
    try {
      if (request.action === 'clear') {
        if (ruleKind(project) !== 'single' || key !== perm.sessionKey) throw new AdminWriteError('只有单会话群可以清空当前上下文');
        const clearedSpeed = await reconcileStoredSpeed(sessionBackend, key, record.cwd, record.model, record.serviceTier);
        const savedSpeed = (await getSession(key))?.serviceTier;
        const fresh = await startWith(sessionBackend, { cwd: project.cwd, model: record.model, effort: record.effort, serviceTier: clearedSpeed, mode: perm.mode, network: perm.network, native: perm.native, readScope: perm.readScope, profile: await profileOf(project, project.cwd, sessionBackend, perm.mode) }, sessionPlace(project, project.chatId));
        // The local clock, not a Feishu createTime like the other watermarks: this
        // is the main-area session, which no back-fill reads until s14 (it must
        // then allow for clock skew, or use the newest createTime it has).
        const now = Date.now();
        try { await upsertSession({ ...record, serviceTier: savedSpeed, ...sessionFields(fresh), sessionId: fresh.sessionId, summary: '(新会话)', lastSeenAt: now, seen: undefined, from: now, recalls: undefined, createdAt: now, updatedAt: now }); }
        catch (error) { await fresh.close(); throw error; }
        const old = sessions.get(key); if (old) await old.close().catch(error => log.fail('desktop', error, { phase: 'clear-thread-close' }));
        trackSession(key, fresh); lastUsage.delete(key); dropRetries(key);
        applied = { ok: true, threadId: key, message: '已开始新会话。' };
        if (!await desktopReceipt(project.chatId, key, '已开始新会话（桌面端操作）。群聊记录和长期记忆保留，接下来从新的上下文继续。')) applied.warning = DESKTOP_RECEIPT_WARNING;
        return applied;
      }
      if (request.action === 'compact') replyTo = await desktopTopicReply(project.chatId, key);
      const { thread } = await resolveThread(key, project.chatId, perm);
      if (!thread) throw new AdminWriteError('会话尚未开始');
      if (request.action === 'compact') {
        compacted = thread;
        const before = meterOf(key, record, thread)?.used;
        const result = await thread.compact();
        markTopicsDue(key, project.chatId, thread.sessionId);
        markContextDue(thread, key);
        if (result.usage) lastUsage.set(key, { used: result.usage.usedTokens, window: result.usage.contextWindow }); else lastUsage.delete(key);
        const after = result.usage?.usedTokens;
        const measured = typeof before === 'number' && Number.isFinite(before) && before >= 0 && typeof after === 'number' && Number.isFinite(after) && after >= 0;
        const markdown = `上下文已压缩（桌面端操作）。${measured ? `上下文用量：${before.toLocaleString('en-US')} → ${after.toLocaleString('en-US')} tokens。` : ''}`;
        applied = { ok: true, threadId: key, message: '上下文已压缩。' };
        if (!await desktopReceipt(project.chatId, key, markdown, replyTo)) applied.warning = DESKTOP_RECEIPT_WARNING;
        return applied;
      }
      if (ruleKind(project) !== 'single') {
        const messages = await channel.rawClient.im.v1.message.list({ params: { container_id_type: 'thread', container_id: key, page_size: 1 } });
        replyTo = messages.data?.items?.[0]?.message_id;
        if (messages.code !== 0 || !replyTo) throw new AdminWriteError('无法定位原飞书话题，请在飞书确认话题仍然存在');
      }
      const root = await channel.send(project.chatId, { markdown: `桌面端启动目标：${request.objective}` }, replyTo ? { replyTo, replyInThread: true } : undefined);
      launched = true;
      void trackRun(launchGoalRun({ chatId: project.chatId, replyTo: root.messageId, thread, firstText: request.objective, knownThreadId: key, cwd: project.cwd, mode: perm.mode, network: perm.network, native: perm.native, readScope: perm.readScope, model: record.model, effort: record.effort, serviceTier: record.serviceTier, flat: ruleKind(project) === 'single', backendId: sessionBackend.id, requesterOpenId: admin, requesterKind: 'user', titleSource: { text: request.objective, rawContentType: 'text' } })).catch(error => log.fail('desktop', error));
      return { ok: true, threadId: key };
    } finally {
      if (!launched && active.get(key) === reserved) active.delete(key);
      releaseIdle(key, compacted);
      const dropped = !launched ? askAgain(reserved.queue, project.chatId, isMainKey(key, project.chatId) ? 'main' : 'topic', 'occupied', '会话被占用') : 0;
      if (dropped && (isMainKey(key, project.chatId) || replyTo) && !await desktopReceipt(project.chatId, key, `操作期间收到的 ${dropped} 条消息未执行，请重发。`, replyTo)) {
        if (applied) applied.warning = DESKTOP_RECEIPT_WARNING;
      }
    }
  }

  // ── shared run loop ───────────────────────────────────────────────
  async function sendCompletionReminder(input: CompletionReminderReplyInput, runConfig = cfg): Promise<void> {
    if (shuttingDown) return;
    await sendCompletionReminderReply({ channel, cfg: runConfig, dedupe: completionReminderSent }, input);
  }

  async function handOff(rc: RunCardState, stream: RunCardStream, cardId: string, answerText: string,
    cardUpdated: boolean, opts: Pick<LaunchOpts, 'chatId' | 'flat' | 'smart'>): Promise<void> {
    // Final card → fenced cards → one handoff text → session save → completion reminder.
    if (!opts.smart || rc.rs.terminal !== 'done') return;
    if (!answerText.includes('@') && !/<at\b/i.test(answerText)) return;
    const ref = cardId.slice(-6);
    const done = (fields: Record<string, unknown>): void => log.info('card', 'handoff', { ref, ...fields });
    if (shuttingDown) { done({ sent: false, why: 'shutdown' }); return; }
    await Promise.all([orStop(roster.load(opts.chatId), undefined), orStop(people.load(opts.chatId), undefined)]);
    // Shutdown while reading the roster must not send or repaint, even for ambiguous names.
    if (shuttingDown) { done({ sent: false, why: 'shutdown' }); return; }
    const bots = roster.peekForHandoff(opts.chatId);
    if (!bots) { done({ sent: false, why: 'no-roster' }); return; }
    const known = people.peek(opts.chatId);
    const { handoffs: found, ambiguous, ambiguousPeople, over, unverified } = findHandoffs(answerText, bots, {
      openId: channel.botIdentity?.openId, appId: channel.rawClient.appId,
    }, known?.people, known?.complete ?? false);
    if (!found.length && !ambiguous.length && !ambiguousPeople.length && !unverified.length) return;
    const to = found.map(h => h.openId.slice(-6));
    const note = async (why?: HandoffMiss): Promise<void> => {
      const lines = [
        ...(why ? [handoffNote(found, why)] : []),
        ...ambiguous.map(ambiguousNote),
        ...ambiguousPeople.map(ambiguousPersonNote),
        ...(unverified.length ? [incompleteNote(unverified)] : []),
        ...(over.length ? [overNote(over)] : []),
      ];
      if (!lines.length || shuttingDown) return;
      rc.handoffNotes = lines;
      if (!(await stream.finalizeCard(channel, buildRunCard(rc)))) {
        log.warn('card', 'handoff-note-failed', { ref, why: why ?? 'ambiguous' });
      }
    };
    if (!cardUpdated) { done({ to, sent: false, why: 'finalize-failed' }); return; }
    if (!found.length) {
      done({
        sent: false, why: unverified.length ? 'incomplete' : 'ambiguous',
        names: ambiguous.length + ambiguousPeople.length + unverified.length,
        ...(unverified.length ? { incomplete: true, unverified: unverified.length, ...(!known ? { people: false } : {}) } : {}),
      });
      await note();
      return;
    }
    if (shuttingDown) { done({ to, sent: false, why: 'shutdown' }); return; }
    const text = handoffText(found);
    const send: Promise<HandoffSendResult> = channel.rawClient.im.v1.message.reply({
      path: { message_id: cardId },
      data: { msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: !opts.flat },
    }).then(handoffSendResult, (err: unknown) => handoffSendResult(feishuError(err)));
    const r = await orStop<HandoffSendResult | undefined | 'stopped'>(withDeadline(send, HANDOFF_SEND_MS, 'handoff'), 'stopped');
    if (r === 'stopped') { done({ to, sent: 'unknown', why: 'shutdown' }); return; }
    if (r === undefined) { done({ to, sent: 'unknown', why: 'timeout' }); await note('timeout'); return; }
    if (r.kind === 'unknown') {
      done({ to, sent: 'unknown', why: 'no-result' });
      await note('unknown');
      return;
    }
    if (r.kind === 'failed') {
      done({ to, sent: false, why: 'send-failed', code: r.code });
      await note('failed');
      return;
    }
    done({ to, sent: true, len: text.length, ...(ambiguous.length ? { ambiguous: ambiguous.length } : {}),
      ...(ambiguousPeople.length ? { ambiguousPeople: ambiguousPeople.length } : {}),
      ...(over.length ? { over: over.length } : {}),
      ...(found.some(h => h.person) ? { persons: found.filter(h => h.person).length } : {}) });
    await note();
  }

  interface LaunchOpts {
    feedback?: FeedbackSource;
    attentionAcceptance?: AttentionAcceptance;
    /** Only group-message launches have a sender to notify if preparation is cut short. */
    origin?: DroppedOrigin;
    voice?: VoiceReply;
    chatId: string;
    replyTo: string;
    /** The message the first turn is for, when {@link replyTo} is another: a topic the smart mode opened on an earlier line (s25b). */
    triggerId?: string;
    /** The first turn is the smart mode joining in on its own (QueuedTurn.initiative). */
    initiative?: true;
    /** Whether the group was smart when this run started. */
    smart?: true;
    wake?: TurnExtra['wake'];
    memoryTrigger?: MemoryTrigger;
    /** true on first reply that creates the topic; subsequent replies use replyTo only */
    replyInThread?: boolean;
    thread: AgentThread;
    firstText: string;
    /** local image paths for the FIRST turn (codex reads them as localImage) */
    images?: string[];
    /** when the topic thread_id is already known (turn in an existing topic) */
    knownThreadId?: string;
    model?: string;
    effort?: ReasoningEffort;
    serviceTier?: ServiceTier;
    /** {@link model} is the project's hand-typed default; persisted with it */
    modelCustom?: boolean;
    /** The run's workspace. Resolves relative `![](…)` image refs in the reply
     * and is persisted as the session's cwd — NOT the bridge process's cwd. */
    cwd?: string;
    /** The turn's permission mode; a `full` project may reference images outside
     * {@link cwd} (see ../card/outbound-images). */
    mode?: PermissionMode;
    /** Remote image refs are fetched only when this is on, in every tier. */
    network?: boolean;
    native?: StartThreadOptions['native'];
    readScope?: StartThreadOptions['readScope'];
    summary?: string;
    /** first turn is a 🔁 重试: the original input it wraps (QueuedTurn.replayText) */
    replayText?: string;
    /** who triggered this run (for ⏹/⚙️ ownership gating) */
    requesterOpenId?: string;
    requesterKind?: 'user' | 'bot' | 'unknown';
    requesterName?: string;
    /** wall-clock origin for completion reminders; normally the inbound
     * message's createTime, so global/session queueing is included. */
    requestedAt?: number;
    /** A topic the bot opens on {@link replyTo}: that message's createTime,
     * written as the new session's watermark (never `requestedAt`, which falls
     * back to the local clock) so its next turn back-fills what came after. */
    seenAt?: number;
    /** A topic this run opens under {@link replyTo}: its first message, for the topic registry. */
    openTopic?: TopicSighting['first'];
    /** The trigger, marked seen once the host accepts the first turn (see QueuedTurn.seen). */
    seen?: SeenMark;
    /** See QueuedTurn.triggerMessageId. */
    triggerMessageId?: string;
    seenHow?: SeenHow;
    /** The first turn's record block: cards still streaming, the ids it carried, the topics it quoted and whether it had the table (see QueuedTurn). */
    streaming?: SeenMark[];
    woven?: string[];
    seenExtra?: SeenMark[];
    tableShown?: boolean;
    /** The first turn's said recall notes and an opening's oldest line (see QueuedTurn); a topic
     * this run opens writes `from` with its record. */
    recallsShown?: string[];
    from?: number;
    /** single-session group: reply by quoting (no reply_in_thread / topic). */
    flat?: boolean;
    /** the backend that created `thread` (persisted into the SessionRecord so a
     * restart resumes on the same runtime). Unset → default (codex). */
    backendId?: string;
    /** Durable title ledger key for a Bridge-owned, newly-created native
     * session. Absent for manual /resume, legacy sessions, and doc comments. */
    titleJobKey?: string;
    /** Structured, un-woven first message. Required so a rejected first turn
     * can be retitled from a later queued message without touching AgentInput. */
    titleSource: SessionTitleSource;
    /** prefetched SessionRecord for the FIRST turn (M-1 极限提前)：免掉编织完成
     * 与 turn/start 之间的 getSession 读盘。`null` = 确知没有记录（全新会话）；
     * undefined = 没预取，照旧读。后续排队轮永远重读（⚙️ 可能改了 model）。 */
    firstRec?: SessionRecord | null;
    /** intake-phase durations (ms, FIRST turn only) for the stream.timing line:
     * tResolve = resolveThread/startThread settled, tWeave = 编织完成（含话题
     * 上文投机拉取），both measured from intake start (M-1 observability). */
    timing?: { tResolve: number; tWeave: number };
    /** Shown on the FIRST card when this location was forced onto a new session
     * (resume failed or the cwd changed), see {@link sessionChangeNotice}. The
     * run clears it once a card carrying it exists; if none ever does, the
     * intake's failure reply carries it instead. */
    sessionNotice?: string;
    /** The first turn is a scheduled task's run (QueuedTurn.scheduled). */
    scheduled?: ScheduledHook;
  }

  /** The queue placeholder card's CardKit entity, handed to the run for in-place
   * reuse (占位卡→run 卡同一实体翻面，防闪烁). */
  interface QueuedCardHandle {
    stream: RunCardStream;
    msgId: string;
    /** The slot came while a shutdown began: the card says the bot stopped, as a cancel at shutdown does (s18c). */
    stopped: () => void;
    /** The run ended before its first turn took the card over (launchRun): the same last word, its queue already dropped
     * or taken by the shutdown. */
    ended: () => void;
  }

  /**
   * M-3 排队可见可取消：拿全局并发槽。池有空位 → 直接 acquire（与旧行为一致，
   * 无卡）。池满 → 先发「⏳ 排队中（第 N 位）+ ⏹ 取消」占位卡再进 FIFO 队列：
   * 位置变化原地刷新；等待期 ⏹（走既有 RC.stop 回调 → state.interrupt）解析为
   * 「移除 waiter + 释放预订」（active/sessions/进程全回收，占位卡翻「已取消」
   * 终态）。返回 null = 等待期被取消；否则带回 release 与占位卡实体 ——
   * launchRun 的首轮 run 卡复用同一张 CardKit 实体原地翻面（不闪烁），goal 则
   * 把它翻成「已开始执行」短报（goal 的 run 卡按 turn 懒建，不能钉死在一张上）。
   */
  async function acquireRunSlot(
    opts: LaunchOpts,
    state: ActiveState,
    activeKey: string,
    reaction?: RunReaction,
  ): Promise<{ release: () => void; queuedCard?: QueuedCardHandle } | null> {
    if (sema.hasFree()) return { release: await sema.acquire() };
    const stream = new RunCardStream();
    let msgId: string | undefined;
    const queueCard = (input: Parameters<typeof buildQueuedCard>[0]) =>
      buildQueuedCard({
        ...input,
        voiceMessages: opts.voice ? [opts.voice] : undefined,
        // state.scheduled is set once the turn starts; a scheduled run waiting here has no 🔔 either.
        ...(!state.isGoal && !opts.scheduled ? { completionReminder: completionReminderView(state) } : {}),
      });
    const q = sema.enqueue((pos) => {
      // 前面有人拿到槽/取消 → 原地刷新位置。走合并泵（非阻塞、合并、限频）。
      if (msgId) stream.streamCoalesced(channel, queueCard({ position: pos, cardKey: msgId }), null);
    });
    // Replied to where the queue card is (s18c), until a slot or a cancel ends the wait.
    if (opts.requesterKind !== 'bot' && !opts.scheduled) state.waiting = {
      chatId: opts.chatId, messageId: opts.replyTo, at: opts.requestedAt ?? Date.now(),
      replyInThread: opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId)), place: opts.flat ? 'main' : 'topic',
    };
    try {
      if (state.presentation?.preferences?.cardDisplay?.reply?.streamText !== false) {
        msgId = await stream.create(channel, opts.chatId, queueCard({ position: q.position() }), {
          replyTo: opts.replyTo,
          replyInThread: opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId)),
        });
        // 自指按钮（m = 自己的 messageId）只能在拿到 messageId 后补上。建卡 RTT 里
        // 槽可能已到手（position()=0）——那就不补按钮，run 卡马上原地接管。
        const pos = q.position();
        if (pos > 0) await stream.updateCard(channel, queueCard({ position: pos, cardKey: msgId }));
        runsByCard.set(msgId, state);
        runStreams.set(msgId, stream);
        if (!state.isGoal) {
          const key = msgId;
          completionReminderRefreshers.set(key, () => {
            const currentPos = q.position();
            if (currentPos > 0) void trackTask(stream.updateLiveCard(channel, queueCard({ position: currentPos, cardKey: key })));
          });
        }
      }
    } catch (err) {
      // 占位卡失败不阻断排队：没有卡只是不可见/不可取消，run 照常等槽。
      log.fail('card', err, { phase: 'queued-card' });
    }
    log.info('intake', 'run-queued', { position: q.position(), key: activeKey });
    /** The card's last word for a run that never starts; the turns queued behind are asked again unless `asked`. */
    const endCard = (asked = false): void => {
      const dropped = asked ? 0 : askAgain(state.queue, opts.chatId, opts.flat ? 'main' : 'topic', 'queue-dropped', '会话被停下了');
      if (!msgId) return;
      runsByCard.delete(msgId);
      runStreams.delete(msgId);
      completionReminderRefreshers.delete(msgId);
      // At shutdown nobody cancelled it: the card says the bot stopped, and the bot says so again once back (s18c).
      void trackTask(stream.updateCard(channel, queueCard({ cancelled: true, dropped, ...(shuttingDown ? { stopped: true } : {}) })));
    };
    // 等待期 ⏹ = 移除 waiter + 释放预订。槽已到手的瞬间 cancel() 返回 false →
    // 让位给运行期 interrupt（launchRun 每轮重装）。
    state.interrupt = () => {
      if (!q.cancel()) return;
      cancelIntake(state);
      active.delete(activeKey);
      if (opts.knownThreadId) sessions.delete(opts.knownThreadId);
      // 还没跑过任何 turn：直接回收进程。持久化记录保留，重发消息经 resume 兜底。
      void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
      endCard();
      reaction?.done();
      log.info('card', 'action', { actionId: 'run.stop', queuedCancel: true });
    };
    // A shutdown that began while the card was being created found no interrupt to call: it is cancelled now (s18c).
    if (shuttingDown) state.interrupt();
    const release = await q.acquired;
    state.interrupt = undefined;
    state.waiting = undefined;
    if (!release) return null; // 已取消：占位卡已翻终态，预订已释放
    return { release, queuedCard: msgId ? { stream, msgId, stopped: () => endCard(), ended: () => endCard(true) } : undefined };
  }

  /** Deletes a card this bot sent: undefined once it is gone (230110: it was already), else why not, for the page. A
   * delete that timed out may still go through. */
  async function deleteOwnCard(id: string): Promise<string | undefined> {
    let code: number | undefined;
    try {
      const res = await withDeadline(channel.rawClient.im.v1.message.delete({ path: { message_id: id } }), DELETE_DEADLINE_MS, 'card-delete');
      if (!res) {
        log.warn('card', 'empty-delete-failed', { err: 'timeout' });
        return '删空卡超时，卡可能还在';
      }
      // A 200 with a non-zero code is a failure too.
      code = feishuError(res)?.code;
    } catch (error) {
      code = feishuError(error)?.code;
      if (code === undefined) {
        log.warn('card', 'empty-delete-failed', { err: errorDetail(error) });
        return '空卡没删成（连不上飞书），卡上留了一行';
      }
    }
    if (code === undefined || code === MESSAGE_GONE) return undefined;
    log.warn('card', 'empty-delete-failed', { code });
    return DELETE_DENIED_CODES.has(code) ? `空卡没删成，缺权限（${code}），卡上留了一行` : `空卡没删成（${code}），卡上留了一行`;
  }

  /**
   * The end of a turn the smart mode joined on its own (product.md 3.4 控制成本, s25b). With nothing to say, its card
   * is deleted and the page notes it. Kept: a card that used a tool, sent a file or answers a voice message, one with 🔔
   * tapped, one a steer split off (`initiativeCard` unset), a failed or stopped turn, and any while shutting down.
   * True when the card is gone; a delete that fails leaves it one short line (`emptyNote`).
   */
  async function dropSilentCard(rc: RunCardState, cardId: string, trigger: NotedMessage,
    opts: Pick<LaunchOpts, 'chatId' | 'flat' | 'backendId'>, reminded: boolean): Promise<boolean> {
    const rs = rc.rs;
    if (!rc.initiativeCard || shuttingDown || reminded || rs.terminal !== 'done' || finalMessageText(rs)
      || rs.blocks.some((b) => b.kind === 'tool' || b.kind === 'compaction') || rc.voiceMessages?.length) return false;
    const place = opts.flat ? 'main' : 'topic';
    runsByCard.delete(cardId);
    completionReminderRefreshers.delete(cardId);
    const detail = cardId ? await deleteOwnCard(cardId) : undefined;
    noteNotReplied(trigger, 'judge-empty', { place, backendId: opts.backendId, detail });
    // The main area's next judgement sees it looked and said nothing; an id no recall event removes.
    recent.addOwn(opts.chatId, opts.chatId, { id: `empty:${trigger.messageId}`, at: Date.now(), text: '（看了，没有要补的，没有回）' });
    if (detail !== undefined) {
      rc.emptyNote = true;
      return false;
    }
    log.info('card', 'empty-deleted', { ref: trigger.messageId.slice(-6), place });
    return true;
  }

  async function launchRun(
    opts: LaunchOpts,
    reaction?: RunReaction,
    onTopicCreated?: () => void,
  ): Promise<void> {
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    // The turn's workspace: resolves relative image refs in the reply and is what
    // the session record stores (see LaunchOpts.cwd).
    const runCwd = opts.cwd ?? fallbackCwd;
    // Reuse the reservation handleTurn made for this session (so messages
    // queued during startup aren't lost); fall back to a fresh state otherwise.
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId, runLoop: true };
    state.chatId = opts.chatId;
    state.thread = opts.thread;
    state.presentation = presentationConfig(cfg, await getProjectByChatId(opts.chatId));
    // Checked right after this await: no macrotask can start a shutdown between here and the free-slot acquire below.
    // A shutdown that began meanwhile found this turn neither queued nor waiting for a slot (collectLost), so a
    // person's turn is kept for redelivery here.
    if (shuttingDown) { if (opts.origin) keepForResend(opts.origin); reaction?.done(); await opts.thread.close(); return; }
    state.runLoop = true;
    state.smart = opts.smart === true;
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    if (opts.requesterKind) state.requesterKind = opts.requesterKind;
    active.set(activeKey, state);
    if (opts.knownThreadId) trackSession(opts.knownThreadId, opts.thread);

    // M-3: 池满先排队（占位卡可见可取消）；null = 等待期被 ⏹ 取消，预订已释放。
    const slot = await acquireRunSlot(opts, state, activeKey, reaction);
    if (!slot) {
      dropCompact(state);
      opts.scheduled?.settle(scheduleStopped());
      return;
    }
    if (shuttingDown) {
      slot.queuedCard?.stopped();
      slot.release();
      active.delete(activeKey);
      reaction?.done();
      await opts.thread.close();
      return;
    }
    const { release } = slot;
    let queuedCard = slot.queuedCard;
    reaction?.started(); // slot acquired → flip OneSecond → Typing
    let turnScope: TurnScope | undefined;
    let turnMemory: TurnMemory | undefined;
    let askTurn: AskTurn | undefined;
    let activity: ReturnType<typeof createRunActivity> | undefined;
    let firstCardSent = false;
    let titleStart: Promise<boolean> | undefined;
    let titleApplyRequested = false;
    let titleTurnAttempted = false;

    const beginSessionTitle = (): void => {
      if (!opts.titleJobKey || titleStart) return;
      const key = opts.titleJobKey;
      titleStart = (async () => {
        try {
          // Called only after the host emits turn_started. A start rejection
          // leaves waiting_turn + its binding marker intact for the next message.
          const activated = await sessionTitles.activate(key);
          if (!activated) return false;
          await sessionTitles.prepare(key);
          return true;
        } catch (err) {
          log.fail('agent', err, { phase: 'session-title-start', key });
          return false;
        }
      })();
    };
    const requestSessionTitleApply = (): void => {
      if (!opts.titleJobKey || !titleStart || titleApplyRequested) return;
      titleApplyRequested = true;
      const key = opts.titleJobKey;
      const bindingKey = topicThreadId;
      void trackTask(titleStart.then(async (activated) => {
        if (!activated) {
          titleStart = undefined;
          titleApplyRequested = false;
          return;
        }
        if (bindingKey) {
          await clearSessionTitleJobKey(bindingKey, key).catch((err) =>
            log.fail('agent', err, { phase: 'session-title-marker-clear', key }),
          );
        }
        await sessionTitles.apply(key);
      }));
    };
    const retrySessionTitleAfterTurn = (): void => {
      if (!opts.titleJobKey || !titleStart) return;
      const key = opts.titleJobKey;
      void trackTask((async () => {
        if (!(await titleStart)) return;
        // Claude's native session row may appear only after the first result. An
        // idempotent post-turn attempt plus a short delayed retry covers that
        // timing edge without holding the user's run/semaphore completion.
        await sessionTitles.apply(key);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await sessionTitles.apply(key);
      })());
    };

    const persist = async (threadId: string): Promise<void> => {
      const existing = await getSession(threadId);
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: runCwd,
        sessionId: opts.thread.sessionId,
        backend: opts.backendId ?? DEFAULT_BACKEND_ID,
        titleJobKey: opts.titleJobKey,
        model: opts.model,
        effort: opts.effort,
        serviceTier: existing ? existing.serviceTier : opts.serviceTier,
        modelCustom: opts.modelCustom,
        summary: opts.summary ?? opts.firstText.slice(0, 80),
        ...sessionFields(opts.thread),
        ...(opts.seenAt ? nextSeen({}, { id: opts.replyTo, at: opts.seenAt }, 'advance') : {}),
        ...(opts.from ? { from: opts.from } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch((err) => log.fail('console', err, { phase: 'persist-session', threadId }));
    };

    /** Demote the previous turn's card (drop its ⚙️) and promote this one. */
    const promoteCard = (cardMsgId: string, rc: RunCardState): void => {
      if (!topicThreadId) return;
      const prev = lastRunCard.get(topicThreadId);
      if (prev && prev !== cardMsgId) {
        const prevState = runCards.get(prev);
        const prevStream = runStreams.get(prev);
        if (prevState && prevStream) void trackTask(prevStream.updateCard(channel, buildRunCardPlain(prevState)));
        runCards.delete(prev);
        runStreams.delete(prev);
        expireRetry(prev);
      }
      lastRunCard.set(topicThreadId, cardMsgId);
      runCards.set(cardMsgId, rc);
    };

    // tracks the latest run card key so the finally can clear runsByCard even
    // if the stream producer throws mid-turn (avoids leaking a stale stop target)
    let curCardKey: string | undefined;
    let disposeInterrupt: (() => void) | undefined;
    let cardClock: ReturnType<typeof setInterval> | undefined;
    // intake durations ride the FIRST turn's stream.timing line only (M-1)
    let intake = opts.timing;
    let firstRec = opts.firstRec;
    // Wakes a [重试] tapped while this run still wraps up the failed turn: it
    // waits, then starts a fresh run instead of joining a queue this run drops.
    let settleTurn: (() => void) | undefined;
    // The turn running now, for a failure noted from the catch below.
    let noted: QueuedTurn | undefined;
    const notedOf = (turn: QueuedTurn | undefined): NotedMessage => ({ chatId: opts.chatId, messageId: turn?.seen?.id ?? opts.triggerId ?? opts.replyTo,
      senderId: turn?.requesterOpenId ?? opts.requesterOpenId ?? '', createTime: turn?.requestedAt ?? 0 });
    const noteTurnFailure = (turn: QueuedTurn | undefined, failure: TurnFailure): void =>
      noteFailure(notedOf(turn), opts.flat ? 'main' : 'topic', opts.backendId, failure);
    /** Ends the run with the turns queued behind it (the loop's stops below): people are asked to resend under `target`,
     * a scheduled turn settled by `scheduledWhy` (askAgain). */
    const dropQueue = (scheduledWhy: string, target: string | undefined, facts: Record<string, boolean>): void => {
      cancelIntake(state);
      if (scheduledWhy === 'occupied') state.evictedDrop = true;
      dropCompact(state);
      const dropped = askAgain(state.queue, opts.chatId, opts.flat ? 'main' : 'topic', 'queue-dropped', '会话被停下了', scheduledWhy);
      if (dropped === 0) return;
      void trackTask(channel
        .send(
          opts.chatId,
          { markdown: `⚠️ ${dropped} 条排队消息已丢弃，请重发。` },
          { replyTo: target, replyInThread: !opts.flat },
        )
        .catch(() => undefined));
      log.info('intake', 'queue-dropped', { depth: state.queue.length, ...facts, evicted: Boolean(state.evicted) });
    };
    /** A turn of this run that failed, or is about to start, after its session went is not a failure (T2 做法): the
     * shutdown's interrupts a scheduled one and keeps a person's for redelivery, as this run's start does (the shutdown
     * took the queue); a settings change's eviction drops it with the turns queued behind (dropQueue). False when the
     * session is there. */
    const settleGone = (turn: QueuedTurn, target: string | undefined): boolean => {
      if (shuttingDown) {
        if (turn.scheduled) turn.scheduled.settle(scheduleStopped());
        else if (turn.origin) keepForResend(turn.origin);
        return true;
      }
      if (!state.evicted) return false;
      state.queue.unshift(turn);
      dropQueue('occupied', target, {});
      return true;
    };
    // What queued turns, and a drop of them, reply to: the last card still there (set as each turn ends).
    let replyTo = opts.replyTo;
    try {
      let currentTurn: QueuedTurn = {
        origin: opts.origin,
        input: { text: opts.firstText, images: opts.images },
        voice: opts.voice,
        titleSource: opts.titleSource,
        attentionAcceptance: opts.attentionAcceptance,
        requesterOpenId: opts.requesterOpenId, requesterKind: opts.requesterKind,
        requesterName: opts.requesterName,
        requestedAt: opts.requestedAt ?? Date.now(),
        summary: opts.summary,
        replayText: opts.replayText,
        seen: opts.seen,
        triggerMessageId: opts.triggerMessageId,
        feedback: opts.feedback,
        seenHow: opts.seenHow,
        streaming: opts.streaming,
        woven: opts.woven,
        seenExtra: opts.seenExtra,
        tableShown: opts.tableShown,
        recallsShown: opts.recallsShown,
        from: opts.from,
        ...(opts.initiative ? { initiative: opts.initiative } : {}),
        wake: opts.wake,
        ...(opts.memoryTrigger ? { memoryTrigger: opts.memoryTrigger } : {}),
        ...(opts.scheduled ? { scheduled: opts.scheduled } : {}),
      };
      noted = currentTurn;
      // Recall notes a turn of this run said; only a queued turn says the newer ones (s15).
      const said = new Set(opts.recallsShown);
      let fromQueue = false;
      let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));
      // On the row since their first message (dm-agent 6.4). Whoever a turn runs as: a task's creator need not be this chat's person.
      const dmPeople = Object.values((await getProjectByChatId(opts.chatId).catch(() => undefined))?.dm?.people ?? {});
      for (;;) {
        let turnInput = currentTurn.input;
        const refs = currentTurn.feedback?.attachments;
        if (refs?.length) turnInput = {...turnInput, text: turnInput.text + '\n本条消息可供反馈核对的附件引用：' + JSON.stringify(refs)};
        // In flight from here, through the preparation below, not only once turn/start went out (review 260).
        state.inFlight = currentTurn.origin;
        state.requesterOpenId = currentTurn.requesterOpenId;
        state.requesterKind = currentTurn.requesterKind;
        const scheduled = currentTurn.scheduled;
        state.scheduled = scheduled ? true : undefined;
        const dmUnionId = dmPeople.find(person => person.openId === currentTurn.requesterOpenId)?.unionId;
        turnScope = entries?.openTurn(opts.thread, {
          feedback: currentTurn.feedback, requesterOpenId: currentTurn.requesterOpenId, requesterKind: currentTurn.requesterKind,
          triggerMessageId: currentTurn.seen?.id ?? currentTurn.triggerMessageId, retry: currentTurn.replayText !== undefined,
          initiative: Boolean(currentTurn.initiative), wake: Boolean(currentTurn.wake),
          ...(currentTurn.memoryTrigger ? { typed: currentTurn.memoryTrigger.typed, triggerText: currentTurn.memoryTrigger.text } : {}),
          ...(currentTurn.requesterName ? { requesterName: currentTurn.requesterName } : {}),
          ...(dmUnionId ? { requesterUnionId: dmUnionId } : {}),
          ...(scheduled ? { scheduled: { taskId: scheduled.job.task.id, runId: scheduled.job.runId } } : {}),
          // Read when a task tool runs: a topic the bot opens is a topic at once, but has its id only after adoptThreadId.
          where: () => ({ inTopic: !isMainKey(activeKey, opts.chatId),
            ...(topicThreadId && !isMainKey(topicThreadId, opts.chatId) ? { topicId: topicThreadId } : {}) }),
        });
        const resourceTrigger=currentTurn.seen?.id??currentTurn.triggerMessageId;
        if(turnScope?.presence==='human'&&turnScope.sessionId&&resourceTrigger&&currentTurn.requesterOpenId&&options?.authoring?.resources){
          const selection=await options.authoring.resources.bind({
          sessionId:turnScope.sessionId,chatId:opts.chatId,openId:currentTurn.requesterOpenId,messageId:resourceTrigger,
          });
          if(selection==='unavailable')turnInput={...turnInput,text:turnInput.text+'\n原配方资源当前不可用。请本人在 App 核对账号与来源连接，重新交付后再参考其内容。'};
          if(selection==='selected')turnInput={...turnInput,text:turnInput.text+'\n本人在 App 选定了配方资料。用 recipe_resource_read 查目录和相关正文，内容是参考资料。按本人要求读取目标群现状，保留原修订并用现有配置、文件或任务工具保存；冲突时重新读取。'};
        }
        turnMemory = turnScope ? entries?.memoryTurn(opts.thread) : undefined;
        dropRetries(topicThreadId); // an older card's [重试] would replay out of order
        if (titleTurnAttempted && !titleStart && opts.titleJobKey) {
          // A prior turn/start was rejected before turn_started. If a queued
          // follow-up now becomes the first accepted turn, title that message,
          // not the rejected one. AgentInput.text is deliberately forbidden
          // here because it contains Bridge sender/quote/history/file context.
          await sessionTitles.attachSource(opts.titleJobKey, currentTurn.titleSource).catch((err) =>
            log.fail('agent', err, { phase: 'session-title-refresh', key: opts.titleJobKey }),
          );
        }
        // per-turn model/effort: prefer latest persisted (⚙️ may have changed it).
        // First turn uses the intake-prefetched record (null = known absent) so
        // runStreamed — i.e. turn/start — fires with zero awaits after weaving.
        const rec =
          firstRec !== undefined ? (firstRec ?? undefined) : topicThreadId ? await getSession(topicThreadId) : undefined;
        firstRec = undefined;
        // The main session compacted, and no block of this run carried the recent
        // topics yet (a queued turn, or one that wove none): they go first (s14b).
        // So do recall notes no turn of this run said yet (s15).
        const notes = fromQueue && topicThreadId ? (rec?.recalls ?? []).filter((r) => !said.has(r.id)) : [];
        const rows = !currentTurn.tableShown && topics && topicThreadId && topicsDueFor(topicThreadId, opts.chatId, rec, opts.thread.sessionId)
          ? topicRows(await topics.list(opts.chatId, { limit: 5 }), names) : [];
        if (topicThreadId && (rows.length || notes.length)) {
          const main = isMainKey(topicThreadId, opts.chatId);
          const topic = main ? {} : { topic: { title: (await topics?.get(opts.chatId, topicThreadId))?.title } };
          const place = { group: (await getProjectByChatId(opts.chatId))?.name, me: channel.botIdentity?.name, ...topic };
          turnInput = { ...turnInput, text: weaveTurnRecordBlock(turnInput.text ?? '', currentTurn, { place, entries: [], now: Date.now(), table: rows, recalls: recallLines(notes) }) };
          if (rows.length) currentTurn.tableShown = true;
          currentTurn.recallsShown = notes.map((r) => r.id);
          for (const r of notes) said.add(r.id);
          log.info('intake', 'record-block', { place: main ? 'main' : 'topic', lines: 0, table: rows.length, recalls: notes.length });
        }
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const modelDisp = getModelDisplay(state.presentation ?? cfg);
        const currentProject = await getProjectByChatId(opts.chatId);
        const turnBackend = backendFor(opts.backendId);
        if (!projectModelAllowed(currentProject, turnBackend.id, turnModel, turnEffort, currentProject?.modelAccess ? await listModels(turnBackend) : undefined)) {
          throw new Error('当前模型或 Effort 已不在本群可用范围，请用 /model 重新选择。若已更换 Provider，请创建新会话。');
        }
        const turnServiceTier = await reconcileStoredSpeed(turnBackend, rec?.threadId ?? topicThreadId, rec?.cwd ?? runCwd, turnModel, rec?.serviceTier);
        turnInput = await preparePersonality(opts.thread, opts.chatId, turnInput, topicThreadId, opts.backendId);
        // Removed while this turn was prepared (dm-agent 3.3): the door is shut, and the removal could not see this thread.
        if (currentProject?.dm && !dmOpen(currentProject)) {
          askAgain([currentTurn, ...state.queue.splice(0)], opts.chatId, opts.flat ? 'main' : 'topic', 'queue-dropped', '会话被停下了', 'occupied');
          state.inFlight = undefined;
          if (topicThreadId && sessions.get(topicThreadId) === opts.thread) sessions.delete(topicThreadId);
          void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
          break;
        }
        // The session went during the awaits above, after the last turn's end found it there: the turn does not start on
        // the closed thread. A person's first turn, evicted while it was prepared, still runs (T2 做法).
        if ((fromQueue || scheduled || shuttingDown) && settleGone(currentTurn, replyTo)) break;
        const run = opts.thread.runStreamed(turnInput, { model: turnModel, effort: turnEffort, serviceTier: turnServiceTier });
        let unseen = currentTurn.seen;
        titleTurnAttempted = true;
        const turnStartAt = Date.now(); // turn/start 已在 runStreamed() 内发出（与下面的建卡并行）
        state.run = run;
        // review 260: the ⏹ entry comes only once the card is created and the topic adopted (Feishu calls, seconds when
        // Feishu is slow); a stop or the shutdown meanwhile interrupts the turn through this one, as soon as it has its id.
        const early = createEarlyInterrupt({ turnId: () => run.turnId(), abort: (tid) => void opts.thread.abort(tid).catch(() => undefined) });
        state.interrupt = () => { cancelIntake(state); early.interrupt(); };
        activity?.end();
        activity = createRunActivity(opts.chatId);
        const render = new RunRender();
        state.subagents = () => render.snapshot().subagents;
        render.seedUsage(meterOf(topicThreadId, rec, opts.thread));
        const cardEvents = new TurnCardEvents();
        state.steerReply = { run, accept: (messageId, voice) => cardEvents.accept(messageId, voice) };
        let boundary: RunState | undefined;
        let segmentStartedAt: number | undefined;
        const segmentSnapshot = (): RunState => runSegment(render.snapshot(), boundary, segmentStartedAt);
        render.showTools = getShowToolCalls(state.presentation ?? cfg);
        let cardMsgId: string | undefined;
        let rc: RunCardState = {
          rs: render.snapshot(),
          cardDisplay: state.presentation?.preferences?.cardDisplay,
          voiceMessages: currentTurn.voice ? [currentTurn.voice] : [],
          requesterOpenId: currentTurn.requesterOpenId,
          showTools: render.showTools,
          completionReminder: completionReminderView(state),
          ...(opts.backendId ? { backend: opts.backendId } : {}),
          // 模型显示档位：footnote 本轮 model·推理强度；always 档终态卡也保留。
          ...((modelDisp !== 'off' || state.presentation?.preferences?.cardDisplay) && turnModel
            ? { model: turnModel, effort: turnEffort, modelOnTerminal: modelDisp === 'always' }
            : {}),
          ...(opts.sessionNotice ? { sessionNotice: opts.sessionNotice } : {}),
          ...(currentTurn.initiative ? { initiativeCard: currentTurn.initiative } : {}),
          ...(scheduled ? { label: scheduledLabel(scheduled.job), nextRun: scheduledNextRun(scheduled.job) } : {}),
        };
        await refreshRunCardDisplayValues(rc,runCwd);

        const adoptThreadId = async (messageId: string): Promise<void> => {
          if (activeKey.startsWith('pending:')) {
            const tid = await getThreadId(channel, messageId, 3); // F8: 单次抖动别滞留 pending:
            if (tid) {
              const key = tid;
              active.delete(activeKey);
              active.set(key, state);
              trackSession(key, opts.thread);
              activeKey = key;
              topicThreadId = key;
              rc.threadId = key;
              await persist(key);
              if (opts.openTopic) noteOpenedTopic(opts.chatId, tid, opts.openTopic, opts.attentionAcceptance);
            }
          } else {
            topicThreadId = activeKey;
            rc.threadId = activeKey;
          }
        };

        // CardKit streaming entity: body streams with the native typewriter,
        // ⏹/⚙️ ride whole-card updates — both on one card_id (see RunCardStream).
        let stream = queuedCard?.stream ?? new RunCardStream();
        const pushLiveCard = (): void => {
          if (cardMsgId) stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
        };
        state.voiceReply = {
          run,
          add: (voice) => {
            const messages = (rc.voiceMessages ??= []);
            if (messages.some((v) => v.messageId === voice.messageId)) return;
            messages.push(voice);
            if (!cardMsgId) return; // The post-create frame picks it up below.
            if (rc.rs.terminal === 'running') pushLiveCard();
            else void trackTask(stream.updateCard(channel, buildRunCard(rc))
              .catch((err) => log.fail('card', err, { phase: 'voice-steer-reply' })));
          },
        };
        attachRunImages({
          stream,
          rc,
          channel,
          upload: (sources) => uploadOutboundImages(channel, sources, runCwd, opts.mode ?? DEFAULT_PERMISSION_MODE, opts.network ?? false),
        });
        const completionOnly = rc.cardDisplay?.reply?.streamText === false;
        const tCreate = Date.now();
        try {
          if (completionOnly) {
            cardMsgId = ''; // No carrier exists until the terminal frame.
          } else
          if (queuedCard) {
            // 占位卡→run 卡：同一 CardKit 实体 whole-card update 原地翻面（不闪
            // 烁、不留垃圾卡）。update 的 card JSON 带 streaming_mode=true；若该
            // 设置未随 update 生效，首次元素推送的 300309 自愈路径会重开
            // streaming 并重推（见 RunCardStream.streamElement）。
            cardMsgId = queuedCard.msgId;
            queuedCard = undefined; // 只复用一次；排队续轮照常新建卡
            await stream.updateCard(channel, buildRunCard(rc));
          } else {
            // A scheduled turn quotes no earlier card: it goes where its hook says (T2 4.2).
            cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(rc), { replyTo: scheduled ? landingOf(scheduled) : replyTo, replyInThread });
          }
        } catch (err) {
          // turn/start 已提前发出：建卡失败时模型已在跑，必须中断并回收进程——
          // 无人消费的通知流会污染该 thread 的下一轮。turnId 此时多半还没到手
          // （事件尚未消费），abort 仅尽力而为；close() SIGKILL 子进程兜底终结
          // 这轮。下一条消息经 resolveThread 的 resume 兜底自愈。
          const { sentTo } = early.handOver();
          const tid = run.turnId();
          if (tid && tid !== sentTo) void opts.thread.abort(tid).catch(() => undefined);
          void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
          if (topicThreadId) sessions.delete(topicThreadId);
          throw err; // 外层 catch 把错误回给用户
        }
        const tCardCreate = Date.now() - tCreate; // 建卡 RTT（与模型推理并行付出）
        opts.sessionNotice = undefined; // shown; a failed create leaves it for the failure reply
        curCardKey = cardMsgId;
        rc.cardKey = cardMsgId;
        state.runCard = rc;
        if (cardMsgId) {
          runsByCard.set(cardMsgId, state);
          runStreams.set(cardMsgId, stream);
        }
        const registerReminder = (messageId: string, target: RunCardState, targetStream: RunCardStream): void => {
          completionReminderRefreshers.set(messageId, () => {
            target.completionReminder = completionReminderView(state);
            void trackTask(targetStream.updateLiveCard(channel, buildRunCard(target)));
          });
        };
        if (cardMsgId) registerReminder(cardMsgId, rc, stream);
        // The entity is created before its carrier messageId exists, so the
        // initial JSON cannot self-route controls. Establish the first
        // self-addressed ⏹/🔔 row immediately instead of waiting for an agent
        // event (a long silent tool startup still needs both controls).
        pushLiveCard();
        if (cardMsgId) await adoptThreadId(cardMsgId);
        if (cardMsgId) scheduled?.started({ messageId: cardMsgId, ...(topicThreadId && !isMainKey(topicThreadId, opts.chatId) ? { topicId: topicThreadId } : {}) });
        // first card is live = topic created. The 群@bot 建话题 path flips its
        // reaction to DONE here (creating the topic is the acked action), unlike
        // an in-topic turn which holds Typing until the reply itself ends.
        if (cardMsgId && !firstCardSent) {
          firstCardSent = true;
          try {
            onTopicCreated?.();
          } catch {
            /* reaction is best-effort */
          }
        }

        const splitCard = async (event: SteerCardEvent): Promise<void> => {
          if (completionOnly) {
            // Preserve steer segmentation and quote the latest accepted input,
            // without publishing either segment while the run is still active.
            boundary = render.snapshot();
            segmentStartedAt = Date.now();
            rc.rs = segmentSnapshot();
            replyTo = event.messageId;
            rc.initiativeCard = undefined;
            rc.voiceMessages = event.voice ? [event.voice] : [];
            return;
          }
          const nextStream = new RunCardStream();
          const nextBoundary = render.snapshot();
          const nextStartedAt = Date.now();
          const next: RunCardState = {
            ...rc, rs: runSegment(nextBoundary, nextBoundary, nextStartedAt),
            cardKey: undefined, continued: false, localFiles: undefined, images: undefined, sessionNotice: undefined,
            // A steer's card answers that message, even an @ (s25b H1): never deleted as empty.
            initiativeCard: undefined,
            voiceMessages: event.voice ? [event.voice] : [],
          };
          let nextId: string;
          try {
            nextId = await nextStream.create(channel, opts.chatId, buildRunCard(next), {
              replyTo: event.messageId, replyInThread: !opts.flat,
            });
          } catch (err) {
            log.fail('card', err, { phase: 'steer-card-create' });
            if (event.voice) state.voiceReply?.add(event.voice);
            void trackTask(channel.send(opts.chatId, { markdown: '补充消息已送达；新卡片创建失败，本轮继续在原卡片输出。' },
              { replyTo: event.messageId, replyInThread: !opts.flat }).catch(() => undefined));
            return;
          }
          const previous = rc;
          const previousStream = stream;
          const previousId = cardMsgId!;
          previous.rs = { ...previous.rs, terminal: 'done', footer: null, completedAt: nextStartedAt };
          previous.continued = true;
          completionReminderRefreshers.delete(previousId);
          runsByCard.delete(previousId);
          runStreams.delete(previousId);
          // Switch the live target before awaiting the frozen card's I/O. The
          // event queue retains all backend output produced while cards rotate.
          boundary = nextBoundary;
          segmentStartedAt = nextStartedAt;
          next.askWaiting = rc.askWaiting;
          next.askWaitingSubagentId = rc.askWaitingSubagentId;
          rc = next;
          stream = nextStream;
          cardMsgId = nextId;
          curCardKey = nextId;
          rc.cardKey = nextId;
          state.runCard = rc;
          runsByCard.set(nextId, state);
          runStreams.set(nextId, stream);
          registerReminder(nextId, rc, stream);
          attachRunImages({ stream, rc, channel,
            upload: sources => uploadOutboundImages(channel, sources, runCwd, opts.mode ?? DEFAULT_PERMISSION_MODE, opts.network ?? false) });
          pushLiveCard();
          try {
            await previousStream.drain();
            const text = finalMessageText(previous.rs);
            previous.localFiles = await outboundFiles.prepare(text, {
              messageId: previousId, chatId: opts.chatId, cwd: runCwd,
              mode: opts.mode ?? DEFAULT_PERMISSION_MODE, requesterOpenId: currentTurn.requesterOpenId,
              replyInThread: !opts.flat, cardId: previousStream.getCardId(),
            }, (id, element) => previousStream.updateElement(channel, id, element));
            previous.images = await previousStream.settleImages(text);
          } catch (err) {
            log.fail('card', err, { phase: 'steer-card-assets' });
          }
          await refreshRunCardDisplayValues(previous,runCwd);
          await previousStream.finalizeCard(channel, buildRunCard(previous))
            .catch(err => log.fail('card', err, { phase: 'steer-card-finalize' }));
        };
        cardClock = setInterval(() => {
          if (rc.rs.terminal === 'running') pushLiveCard();
        }, 1000);
        cardClock.unref();

        // ⏹ 终止（QW-15）：发 turn/interrupt 后等事件流**自然 done** —— codex
        // 0.139+ 实测 interrupt 4ms 返回、turn/completed(status:"interrupted")
        // 干净收尾（.plans/auto-optimize/research/08b-interrupt-probe.md；旧注释
        // 「no mappable terminal — the stream just hangs」是旧版行为，已证伪），
        // event-map 把 turn/completed 映射为 done，消费循环自然终止 → 线程与
        // 进程留用，下一条消息免 resume 冷启。turnId 未到手或 5s 内没收尾
        // （版本旧 / 挂死）才经 stopSignal 强停本地循环，按原样走杀进程恢复锤。
        // watchdog 超时（timedOut）不变，恒走杀进程。
        let timedOut = false;
        let askFaulted = false; // the ask coordinator stopped the turn, not a ⏹ or the shutdown
        let resolveStop!: () => void;
        const stopSignal = new Promise<void>((res) => {
          resolveStop = res;
        });
        let startedTurnId: string | undefined;
        let awaitingSubagents = false;
        // From here the ⏹ entry below stops the turn; a stop that came while the card was created goes on through it.
        const handed = early.handOver();
        const stopper = createGracefulInterrupt({
          turnId: () => run.turnId() ?? (awaitingSubagents ? startedTurnId : undefined),
          // That stop sent turn/interrupt to this turn already.
          abort: (tid) => { if (tid !== handed.sentTo) void opts.thread.abort(tid).catch(() => undefined); },
          forceStop: resolveStop,
        });
        disposeInterrupt = stopper.dispose;
        state.interrupt = () => { askTurn?.close('stopped'); cancelIntake(state); stopper.interrupt(); };
        const idleMs = currentIdleMs();
        const idlePause = createIdlePause();
        state.idlePause = idlePause;
        const originalInterrupt = state.interrupt;
        askTurn = asks.openTurn({ run, sessionKey: activeKey,
          placed: async messageId => { await adoptThreadId(messageId); return activeKey; },
          placement: { chatId: opts.chatId, replyTo: scheduled ? landingOf(scheduled) : currentTurn.seen?.id ?? opts.replyTo, replyInThread: !opts.flat, own: Boolean(currentProject?.dm) },
          initiator: { kind: currentTurn.requesterKind ?? 'unknown', openId: currentTurn.requesterOpenId }, idlePause,
          waiting: (label, subagentId) => { activity?.waiting(Boolean(label)); rc.askWaiting = label; rc.askWaitingSubagentId = subagentId; pushLiveCard(); },
          // A late ask faults too once a ⏹ or the shutdown stopped the turn (both set intakeCancelled): the stop stays theirs.
          fault: error => { log.fail('agent', error, { phase: 'ask-response' }); if (state.run === run) { askFaulted ||= !state.intakeCancelled && !shuttingDown; originalInterrupt(); } },
        });
        const guarded = withIdleTimeout(
          redactAgentEvents(run.events, hiddenBlockFilter(opts.thread, opts.backendId, turnMemory, () => topicThreadId)),
          idleMs,
          () => {
            timedOut = true;
          },
          stopSignal,
          run.lastActivity, // raw-notification liveness: a long shell command isn't "idle"
          idlePause,
        );
        if (handed.stopped) originalInterrupt();
        // Per-turn stream-latency observability (file log `stream.timing`): locates
        // where a reply lags — first byte, backlog (lastEv vs done), push split, RTT.
        const tStart = Date.now();
        let firstEvAt = 0;
        let firstTextAt = 0;
        let lastEvAt = tStart;
        let evCount = 0;
        let textChars = 0;
        let confirmedDone = false;
        for await (const ev of cardEvents.consume(guarded)) {
          if (ev.type !== 'steer_accepted') activity?.accept(ev);
          if (ev.type === 'done') confirmedDone = true;
          if (ev.type === 'turn_started') startedTurnId = ev.turnId;
          if (ev.type === 'awaiting_subagents') awaitingSubagents = true;
          if (ev.type === 'ask') { askTurn.enqueue(ev.request, ev.subagentId ? { subagentId: ev.subagentId, name: render.snapshot().subagents.find(row => row.id === ev.subagentId)?.name } : undefined); continue; }
          if (ev.type === 'ask_cancelled') { askTurn.cancel(ev.requestId); continue; }
          if (ev.type === 'done' || (ev.type === 'error' && !ev.willRetry)) { turnScope?.close(); askTurn.close('turn-ended'); }
          if (ev.type === 'steer_accepted') {
            await splitCard(ev);
            continue;
          }
          const tEv = Date.now();
          if (!firstEvAt) firstEvAt = tEv;
          const et = (ev as { type?: string }).type;
          if (et === 'turn_started') {
            currentTurn.attentionAcceptance?.accept();
            // The host took the input: only now do it and the history woven into
            // it count as seen (a refused turn/start or a crash before here leaves
            // both for the next back-fill and a re-push).
            if (topicThreadId && (unseen || currentTurn.recallsShown?.length)) {
              // A trigger recalled while its turn was prepared still runs; the next turn says so (s15).
              const late: RecallNote | undefined = unseen && recalled.has(unseen.id)
                ? { id: unseen.id, at: unseen.at, who: { kind: 'user', openId: currentTurn.requesterOpenId } } : undefined;
              markSeen(topicThreadId, unseen, currentTurn.seenHow, currentTurn.streaming, currentTurn.seenExtra,
                { recallsShown: currentTurn.recallsShown, from: currentTurn.from, late });
            }
            unseen = undefined;
            if (currentTurn.tableShown && topicThreadId) setTopicsDue(topicThreadId, '');
            if (currentTurn.woven?.length) state.woven = new Set(currentTurn.woven);
            // Host accepted the first turn. Title generation now overlaps the
            // remainder of that turn; the binding was persisted before this loop.
            beginSessionTitle();
            requestSessionTitleApply();
          }
          if (et === 'text_delta') {
            if (!firstTextAt) firstTextAt = tEv;
            const d = (ev as { delta?: string }).delta;
            if (typeof d === 'string') textChars += d.length;
          }
          lastEvAt = tEv;
          evCount++;
          const subagents = render.snapshot().subagents;
          render.apply(ev);
          logSubagentChanges(subagents, render.snapshot().subagents);
          // Track context usage for /context and the next turn's meter. Only
          // auto-compaction reaches the turn loop (a manual /compact drains its own
          // events); it shows as a line on this card, and Claude's post-compaction
          // count moves the meter too.
          if ((et === 'context_usage' || et === 'compaction') && topicThreadId) {
            const usage = render.snapshot().usage;
            if (usage) lastUsage.set(topicThreadId, usage);
          }
          if (ev.type === 'compaction' && ev.phase === 'end' && !ev.failed) { markTopicsDue(topicThreadId, opts.chatId, opts.thread.sessionId); markContextDue(opts.thread, topicThreadId); }
          rc.rs = segmentSnapshot();
          // The global mode is live-editable. Re-evaluate on every structural /
          // answer frame so switching away from manual removes the button from
          // an already-running card instead of leaving a stale affordance.
          rc.completionReminder = completionReminderView(state);
          // Non-blocking: never stall event consumption on a round-trip. The pump
          // coalesces and routes the latest snapshot — answer text → element
          // typewriter (cardElement.content), structure → whole-card update.
          if (ev.type !== 'subagent_step') pushLiveCard();
        }
        // Whether its session had gone as the turn's events ended, before any terminal I/O: a turn that failed on its own
        // stays its own failure, whatever stops the bot or changes the group while it is delivered (ranScheduled).
        const goneAt = shuttingDown ? 'shutdown' : state.evicted ? 'evicted' : undefined;
        turnScope?.close();
        askTurn.close('turn-ended');
        activity?.end();
        clearInterval(cardClock);
        cardClock = undefined;
        state.steerReply = undefined;
        state.idlePause = undefined;
        state.subagents = undefined;
        state.runCard = undefined;
        state.run = undefined; // completion-card I/O must queue, never steer into a finished turn
        state.scheduled = undefined;
        const doneAt = Date.now(); // codex stopped emitting / loop ended
        stopper.dispose(); // 事件流已收尾：撤掉 ⏹ 的 5s 强停兜底定时器
        disposeInterrupt = undefined;
        await stream.drain().catch(err => log.fail('card', err, { phase: 'terminal-drain' })); // terminal I/O must not kill a completed turn
        state.interrupt = undefined; // turn done; nothing left to interrupt
        const interrupted = stopper.interrupted();
        // 杀进程恢复锤只留给「真出事」：watchdog 超时，或 ⏹ 后没等到干净收尾
        // （forced）。优雅 ⏹（done 及时到达）不算 killed —— 线程与进程留用。
        const killed = timedOut || (interrupted && stopper.forced());
        // A child crash closes the notification iterator cleanly, so no error
        // event is guaranteed. Detect liveness BEFORE finalizing: only a still-
        // running render becomes error; an explicit backend done/error terminal
        // remains authoritative.
        const procDead = !killed && !opts.thread.isAlive();
        settleOrdinaryTurnRender(render, {
          interrupted,
          timedOut,
          idleTimeoutSeconds: Math.round(idleMs / 1000),
          procDead,
        });
        rc.rs = segmentSnapshot();
        // owner 2026-11-02: a turn a stop, restart or update cut short says so, and asks a person for the message again.
        if (interrupted && shuttingDown) rc.stopped = { reason: shutdownReason(), resend: currentTurn.origin !== undefined };
        // The final card promises a next run from the task as it is now: paused or deleted during the run, it has none.
        if (scheduled) rc.nextRun = scheduledNextRun(scheduled.job);
        if (interrupted) log.info('agent', 'interrupt', { graceful: !stopper.forced(), threadId: topicThreadId ?? null });
        // A ⏹ is not a failure; an error or the watchdog is.
        else if (rc.rs.terminal === 'error' || rc.rs.terminal === 'idle_timeout') noteTurnFailure(currentTurn, { rs: rc.rs, procDead });

        // A killed turn (watchdog / forced ⏹) leaves codex mid-turn with a
        // notification stream that never terminates. Recycle the process:
        // closing it ends the stream cleanly (no orphaned reader stealing the
        // next turn's events) and frees the turn. The topic resumes from the
        // persisted thread on its next message (resolveThread), so the session
        // survives the kill.
        // 优雅 ⏹（killed=false）不回收：turn/completed(status:"interrupted") 已
        // 干净收尾，同进程同 thread 可继续复用（08b 探针已证）——sessions 保留、
        // 不 close，下一条消息走 LIVE 快路径。
        // 进程级死亡（app-server 中途崩溃 → error 卡 / 轮间死 → 空卡，killed=false）
        // 同走回收：立即清出缓存，下一条消息直接经 resolveThread 的 resume 兜底
        // 自愈（快路径的 isAlive 守卫是兜底的兜底）。
        if (killed || procDead) {
          void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
          if (topicThreadId) sessions.delete(topicThreadId);
          // 自愈观测：这里是「kill 中途死」唯一的驱逐点且原先静默——进程死在轮中
          // 时 LIVE 缓存在本轮收尾就清掉，下一条消息的 resolveThread 不会再命中
          // dead-thread-evict（那条只兜「轮间死」）。没有这行，e2e 无法从日志还原
          // 驱逐发生在哪。
          log.info('agent', 'session-evict', {
            threadId: topicThreadId ?? null,
            reason: timedOut ? 'watchdog-timeout' : procDead ? 'proc-dead' : 'forced-interrupt',
          });
        }

        let finalMsgId = cardMsgId;
        // Joined in on its own with nothing to say: the card goes, and nothing below is sent (s25b).
        const gone = await dropSilentCard(rc, finalMsgId, notedOf(currentTurn), opts, Boolean(state.completionReminderRequested));
        let delivered = false;
        if (!gone) try {
          if (!finalMsgId) {
            // Only settled content may create the carrier in completion-only mode.
            rc.images = await stream.settleImages(finalMessageText(rc.rs));
            await refreshRunCardDisplayValues(rc,runCwd);
            finalMsgId = await stream.create(channel, opts.chatId, buildRunCard(rc), {
              replyTo: scheduled ? landingOf(scheduled) : replyTo, replyInThread,
            });
            cardMsgId = finalMsgId;
            curCardKey = finalMsgId;
            runStreams.set(finalMsgId, stream);
            if (!firstCardSent) {
              firstCardSent = true;
              try { onTopicCreated?.(); } catch { /* reaction is best-effort */ }
            }
          }
          await adoptThreadId(finalMsgId);
          if (completionOnly) scheduled?.started({ messageId: finalMsgId, ...(topicThreadId && !isMainKey(topicThreadId, opts.chatId) ? { topicId: topicThreadId } : {}) });
          rc.cardKey = finalMsgId;

          // [重试] for a turn that went quiet or lost the model (product.md 3.12),
          // read from the settled render: a ⏹ wins over a timer that fired
          // while it waited. Not when follow-ups are queued: they run next and
          // would make a replay land out of order. Nor for a scheduled turn:
          // its next run is the retry (T2 4.1 第 7 条).
          let retryReason: RetryTurn['reason'] | undefined;
          if (rc.rs.terminal === 'idle_timeout') retryReason = 'idle';
          else if (rc.rs.terminal === 'error' && rc.rs.errorKind === 'network') retryReason = 'network';
          if (retryReason && topicThreadId && state.queue.length === 0 && !scheduled) {
            retryTurns.set(finalMsgId, {
              sessionKey: topicThreadId, chatId: opts.chatId, flat: Boolean(opts.flat), turn: currentTurn,
              replayText: currentTurn.replayText ?? currentTurn.input.text ?? '',
              reason: retryReason, idleSeconds: Math.round(idleMs / 1000),
              settled: new Promise<void>((resolve) => { settleTurn = resolve; }),
            });
            rc.retry = 'available';
          }

          // Outbound images + 卡片围栏. The answer's images mostly uploaded already
          // (the background uploader started on the ref's first appearance, so the
          // live card showed them mid-stream). settleImages finishes the job under
          // ONE hard deadline — it waits out in-flight uploads and uploads the
          // final answer's own refs concurrently, and what hasn't landed by then
          // simply renders as text (an `image.create` with no timeout used to leave
          // the card stuck on 「正在输出」with a live ⏹; issue #14 "一显示就卡").
          // The ```feishu-card fences are hoisted into standalone clean cards here.
          // Best-effort throughout: an unresolved ref renders as text, a failed
          // card is logged.
          const answerText = finalMessageText(rc.rs);
          noteTurnUsage(opts.thread, answerText, topicThreadId);
          // What this bot said, for the place's next judgements (smart groups only: none other is tracked).
          if (topicThreadId && answerText.trim()) recent.addOwn(topicThreadId, opts.chatId, { id: finalMsgId, at: Date.now(), text: answerText });
          rc.localFiles = await outboundFiles.prepare(answerText, {
            messageId: finalMsgId, chatId: opts.chatId, cwd: runCwd,
            mode: opts.mode ?? DEFAULT_PERMISSION_MODE, requesterOpenId: currentTurn.requesterOpenId,
            replyInThread: !opts.flat, cardId: stream.getCardId(),
          }, (elementId, element) => stream.updateElement(channel, elementId, element));
          const { fences } = extractCardFences(answerText);
          rc.images = await stream.settleImages(answerText);

          // terminal whole-card update: final render with streaming off (clears the
          // typewriter cursor) and no ⏹ button. Remove the callback before freezing
          // live repaints; already-accepted repaint writes are serialized ahead of
          // finalizeCard, while callbacks arriving from now on cannot overwrite it.
          const manuallyRequested = Boolean(state.completionReminderRequested);
          completionReminderRefreshers.delete(cardMsgId);
          await refreshRunCardDisplayValues(rc,runCwd);
          const terminalCardUpdated = await stream.finalizeCard(channel, buildRunCard(rc));
          delivered = terminalCardUpdated;
          // Its card has its last word (the answer, or that the shutdown cut it short): nothing to ask again after a restart.
          if (terminalCardUpdated) {
            cutShortAnswered(state.inFlight);
            state.inFlight = undefined;
          }
          if (confirmedDone && rc.rs.terminal === 'done' && answerText.trim() && terminalCardUpdated) reportLatestAction(opts.chatId, 'replied');
          // One-line per-turn timeline; all ms are relative to the turn's stream start.
          {
            const terminalAt = Date.now();
            const st = stream.stats();
            log.info('stream', 'timing', {
              tResolve: intake?.tResolve ?? -1, // 入站段耗时（仅首轮有值；M-1 并行化观测）
              tWeave: intake?.tWeave ?? -1,
              tCardCreate,
              tTurnStart: turnStartAt - tStart, // 负数 = turn/start 抢在流循环前多少 ms（QW-1 并行收益）
              firstEv: firstEvAt ? firstEvAt - tStart : -1,
              firstText: firstTextAt ? firstTextAt - tStart : -1,
              lastEv: lastEvAt - tStart,
              done: doneAt - tStart,
              terminal: terminalAt - tStart,
              doneToTerminal: terminalAt - doneAt,
              events: evCount,
              textChars,
              pushes: st.pushCount,
              cardPushes: st.cardPushes,
              elPushes: st.elPushes,
              rttAvg: st.pushCount ? Math.round(st.totalRttMs / st.pushCount) : 0,
              rttMax: st.maxRttMs,
            });
            intake = undefined; // 排队续轮没有入站段，别把首轮数值带下去
          }
          runsByCard.delete(cardMsgId);
          promoteCard(finalMsgId, rc);

          for (const fence of fences) {
            try {
              await sendManagedCard(channel, opts.chatId, buildCleanCard(fence, rc.images), finalMsgId, !opts.flat);
            } catch (err) {
              log.fail('card', err, { phase: 'clean-card' });
            }
          }
          await handOff(rc, stream, finalMsgId, answerText, terminalCardUpdated, opts);
          if (topicThreadId) {
            touchSession(topicThreadId); // 轮次收尾打点（M-3 reaper 的空闲时钟）
            await patchSession(topicThreadId, { updatedAt: Date.now(), ...savedMeter(topicThreadId, opts.thread) });
          }
          await sendCompletionReminder({
            cardMsgId: finalMsgId,
            requesterOpenId: currentTurn.requesterOpenId,
            requesterKind: currentTurn.requesterKind,
            smart: opts.smart === true,
            outcome: rc.rs.terminal === 'running' ? 'done' : rc.rs.terminal,
            requestedAt: currentTurn.requestedAt,
            manuallyRequested,
            summary: currentTurn.summary,
            cardUpdated: terminalCardUpdated,
            replyInThread: !opts.flat,
          }, state.presentation);
        } catch (err) {
          log.fail('card', err, { phase: 'terminal-delivery' });
          void trackTask(channel.send(opts.chatId, { markdown: '⚠️ 本轮已结束，但结果同步失败，请检查会话记录。' }, { replyTo: finalMsgId, replyInThread: !opts.flat }).catch(() => undefined));
        }
        if (gone && topicThreadId) {
          touchSession(topicThreadId);
          await patchSession(topicThreadId, { updatedAt: Date.now(), ...savedMeter(topicThreadId, opts.thread) })
            .catch((err) => log.fail('card', err, { phase: 'empty-card-session' }));
        }
        // Settled as it ends, before any turn queued behind it runs (T2 4.1 第 5 条).
        scheduled?.settle(ranScheduled(scheduled, rc.rs, delivered, askFaulted, goneAt));
        state.inFlight = undefined;
        retrySessionTitleAfterTurn();
        // Queued turns reply to the last card still there; a deleted one keeps the previous target.
        if (!gone) replyTo = finalMsgId;
        replyInThread = !opts.flat; // stay in the topic for queued turns (single: stay flat)
        log.info('card', 'final', { terminal: render.terminal() });

        // A /compact sent during the turn compacts now, before the turns already
        // queued; what comes in meanwhile queues (product.md 3.5, s15). Checked
        // after the last await of the turn, so a /compact either sees this run
        // or none. A process the compaction killed ends the run as below.
        let compactDied = false;
        const pending = state.compactAfter;
        if (pending && !(killed || procDead || interrupted)) {
          state.compactAfter = undefined;
          state.compacting = true;
          try { await compactWithCard(pending.msg, pending.inThread, opts.thread, topicThreadId ?? activeKey); }
          finally { state.compacting = false; }
          compactDied = !opts.thread.isAlive();
          if (compactDied) {
            void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
            if (topicThreadId && sessions.get(topicThreadId) === opts.thread) sessions.delete(topicThreadId);
            log.info('agent', 'session-evict', { threadId: topicThreadId ?? null, reason: 'compact-proc-dead' });
          }
        }

        // A stop (⏹ graceful or forced / watchdog) or a dead process ends the
        // whole run — drop any queued follow-ups, but tell the user instead of
        // swallowing them. 优雅 ⏹ 虽然线程留用，但用户按了停就是要停：排队消息
        // 同样丢弃（语义与杀进程路径一致，只是进程不回收）。A settings change that
        // closed the thread (state.evicted), even after procDead was read above, ends
        // it too, with the turns still in intake (intakeStopped).
        if (killed || procDead || interrupted || compactDied || state.evicted) {
          // Only a ⏹ is the user's, and a settings change's eviction the group's: a scheduled turn queued behind a watchdog
          // kill, a dead process or an ask fault failed (T2 4.2).
          dropQueue(interrupted && !askFaulted ? 'queue-dropped' : state.evicted ? 'occupied' : 'run-failed', finalMsgId, { killed, procDead, interrupted });
          break;
        }
        // A message queued while this run's back-fill was pulled may be a line of
        // its record block already (see ActiveState.woven): it is not run again.
        while (state.queue[0]?.seen && state.woven?.has(state.queue[0].seen.id)) {
          log.info('intake', 'queued-seen-skipped', { msgId: state.queue.shift()!.seen!.id });
        }
        if (state.queue.length === 0) break;
        settleTurn?.(); // moving on: whatever queued meanwhile made the retry stale
        settleTurn = undefined;
        currentTurn = state.queue.shift()!;
        noted = currentTurn;
        fromQueue = true;
        // Per-turn ownership + one-shot override must not leak from the previous
        // requester. The queued item's timestamp preserves all waiting time for
        // the `long` policy and notification copy.
        activateQueuedTurn(state, currentTurn);
      }
    } catch (err) {
      turnScope?.close();
      activity?.end();
      askTurn?.close('turn-ended');
      // Detach before any await: new messages must not join a failed consumer.
      if (active.get(activeKey) === state) active.delete(activeKey);
      state.inFlight = undefined;
      // The session went (the shutdown, a settings change): not this turn's failure, nor the queue's.
      const went = noted !== undefined && settleGone(noted, replyTo);
      const dropped = went ? 0 : askAgain(state.queue.splice(0), opts.chatId, opts.flat ? 'main' : 'topic', 'run-failed', '前一轮出错，排队的没跑');
      dropCompact(state);
      disposeInterrupt?.();
      state.subagents = undefined;
      state.runCard = undefined;
      state.run = undefined;
      state.interrupt = undefined;
      // A stream/card failure can leave an agent turn running. Retire that
      // client before the next message resumes the persisted session.
      if (topicThreadId && sessions.get(topicThreadId) === opts.thread) sessions.delete(topicThreadId);
      await opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' }));
      log.fail('intake', err);
      if (went) return;
      noteTurnFailure(noted, { error: err });
      if (noted?.scheduled) noted.scheduled.settle(scheduleFailed(noted.scheduled, err));
      await channel
        .send(opts.chatId, { markdown: runFailureMessage(err, dropped, opts.sessionNotice) }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch((sendError) => log.fail('intake', sendError, { phase: 'run-failure-feedback', dropped }));
    } finally {
      turnScope?.close();
      activity?.end();
      askTurn?.close('turn-ended');
      // A replacement run may have reserved the key while failure feedback
      // was in flight. Never delete another run's reservation.
      if (active.get(activeKey) === state) active.delete(activeKey);
      // A scheduled run's hidden topic that nobody joined lets its process go now, not after the reaper's 45 minutes.
      releaseIdle(topicThreadId, opts.thread, Boolean(opts.openTopic && opts.scheduled && noted?.scheduled === opts.scheduled));
      settleTurn?.();
      clearInterval(cardClock);
      state.steerReply = undefined;
      state.voiceReply = undefined;
      if (curCardKey) {
        runsByCard.delete(curCardKey);
        completionReminderRefreshers.delete(curCardKey);
      }
      // The first turn ended before it took the slot's queue card over (settleGone, or it failed): the card says so, with
      // no ⏹ left. Its queue went already: dropped above, or taken by the shutdown.
      queuedCard?.ended();
      // F8: adopt 始终没成功的线程对任何后续消息都不可达（pending: 键随本
      // finally 即灭，会话从未 persist，M-3 reaper 只扫 sessions 也看不见它）
      // ——保活只会把常驻 agent 进程（~172MB/个）泄漏到停机。与 goal 路径
      // 一致直接回收（close 幂等，已死/已关的也无害）。
      if (activeKey.startsWith('pending:')) {
        void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
        log.warn('intake', 'unadopted-thread-closed', { activeKey });
      }
      reaction?.done(); // run ended (complete / ⏹ / timeout / error) → ✅ DONE
      release();
    }
  }

  /**
   * Goal run: set a persistent codex goal (opts.firstText is the objective) and
   * render its autonomous, multi-turn execution as a sequence of streaming run
   * cards, then post a terminal 「目标已完成 / 已中止」 card with the run metadata.
   *
   * Differs from {@link launchRun}: turns are auto-started AND auto-continued by
   * codex (we never call turn/start — see {@link AgentThread.runGoal}); the
   * `GOAL_IDLE_MS` ends a goal after 30 minutes without codex activity.
   * Goal cards let the user stop immediately or end the goal after the current
   * turn. The codex process is recycled at the end — a terminated goal leaves
   * trailing notifications that would poison the next turn's stream — and any
   * non-complete goal is cleared first so it won't reactivate on the next resume.
   */
  async function launchGoalRun(opts: LaunchOpts): Promise<void> {
    if (shuttingDown) { if (opts.origin) keepForResend(opts.origin); await opts.thread.close(); return; }
    const objective = opts.firstText;
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    // The goal's workspace — see LaunchOpts.cwd / launchRun's runCwd.
    const runCwd = opts.cwd ?? fallbackCwd;
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId };
    state.chatId = opts.chatId;
    state.presentation = presentationConfig(cfg, await getProjectByChatId(opts.chatId));
    state.thread = opts.thread;
    state.isGoal = true; // messages during the goal get a prompt, never queue (handleTurn)
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    state.requesterKind = 'user';
    active.set(activeKey, state);
    if (opts.knownThreadId) {
      trackSession(opts.knownThreadId, opts.thread);
      dropRetries(opts.knownThreadId); // an older card's [重试] must not replay after the goal
    }

    // M-3: 池满先排队（占位卡可见可取消）；null = 等待期被 ⏹ 取消，预订已释放。
    const slot = await acquireRunSlot(opts, state, activeKey);
    if (!slot) return;
    if (shuttingDown) {
      slot.queuedCard?.stopped();
      slot.release();
      active.delete(activeKey);
      await opts.thread.close();
      return;
    }
    const { release } = slot;
    if (slot.queuedCard) {
      // goal 的 run 卡按 turn 懒建（首个有内容的 turn 才出卡），不把占位实体钉成
      // 某一轮的卡 —— 否则规划-only 的 goal 会让它永远停在「排队中」。原地翻成
      // 「已开始执行」短报（同一实体 update，不闪烁），后续 run 卡照常另出。
      runsByCard.delete(slot.queuedCard.msgId);
      runStreams.delete(slot.queuedCard.msgId);
      void trackTask(slot.queuedCard.stream.updateCard(channel, buildQueuedCard({ started: true })));
    }

    let titleStart: Promise<boolean> | undefined;
    let titleApplyRequested = false;
    const beginGoalSessionTitle = (): void => {
      if (!opts.titleJobKey || titleStart) return;
      const key = opts.titleJobKey;
      titleStart = (async () => {
        try {
          const activated = await sessionTitles.activate(key);
          if (!activated) return false;
          await sessionTitles.prepare(key);
          return true;
        } catch (err) {
          log.fail('agent', err, { phase: 'session-title-start', key });
          return false;
        }
      })();
    };
    const requestGoalSessionTitleApply = (): void => {
      if (!opts.titleJobKey || !titleStart || titleApplyRequested) return;
      titleApplyRequested = true;
      const key = opts.titleJobKey;
      const bindingKey = topicThreadId;
      void trackTask(titleStart.then(async (activated) => {
        if (!activated) {
          titleStart = undefined;
          titleApplyRequested = false;
          return;
        }
        if (bindingKey) {
          await clearSessionTitleJobKey(bindingKey, key).catch((err) =>
            log.fail('agent', err, { phase: 'session-title-marker-clear', key }),
          );
        }
        await sessionTitles.apply(key);
      }));
    };
    const retryGoalSessionTitleAfterRun = (): void => {
      if (!opts.titleJobKey || !titleStart) return;
      const key = opts.titleJobKey;
      void trackTask((async () => {
        if (!(await titleStart)) return;
        await sessionTitles.apply(key);
        await new Promise((resolve) => setTimeout(resolve, 250));
        await sessionTitles.apply(key);
      })());
    };

    const persist = async (threadId: string): Promise<void> => {
      const existing = await getSession(threadId);
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: runCwd,
        sessionId: opts.thread.sessionId,
        backend: opts.backendId ?? DEFAULT_BACKEND_ID,
        titleJobKey: opts.titleJobKey,
        model: opts.model,
        effort: opts.effort,
        serviceTier: existing ? existing.serviceTier : opts.serviceTier,
        modelCustom: opts.modelCustom,
        summary: opts.summary ?? objective.slice(0, 80),
        ...sessionFields(opts.thread),
        ...(opts.seenAt ? nextSeen({}, { id: opts.replyTo, at: opts.seenAt }, 'advance') : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch((err) => log.fail('console', err, { phase: 'persist-session', threadId }));
    };

    // One streaming run card per codex turn. `cur` is the in-flight turn's render
    // context (null between turns); assigned directly in the loop so TS narrows it.
    // `stream`/`cardMsgId` are null until the turn produces real output — a card is
    // sent LAZILY on first content, so a planning-only turn leaves no empty box.
    type GoalTurnCtx = { cardRequested?: boolean; render: RunRender; rc: RunCardState; stream: RunCardStream | null; cardMsgId: string | null; clock?: ReturnType<typeof setInterval> };
    let cur: GoalTurnCtx | null = null;
    const finalized: { last?: GoalTurnCtx } = {};
    let carried: SubagentRow[] = [];
    const knownSubagents = new Map<string, SubagentRow>();
    state.subagents = () => cur?.render.snapshot().subagents ?? carried;
    let replyTo = opts.replyTo;
    let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));

    const adoptThreadId = async (messageId: string, card: RunCardState): Promise<void> => {
      if (activeKey.startsWith('pending:')) {
        const tid = await getThreadId(channel, messageId, 3); // F8: 单次抖动别滞留 pending:
        if (tid) {
          const key = tid;
          active.delete(activeKey);
          active.set(key, state);
          sessions.set(key, opts.thread);
          activeKey = key;
          topicThreadId = key;
          card.threadId = key;
          await persist(key);
          if (opts.openTopic) noteOpenedTopic(opts.chatId, tid, opts.openTopic, opts.attentionAcceptance);
        }
      } else {
        topicThreadId = activeKey;
        card.threadId = activeKey;
      }
    };

    const promoteCard = (msgId: string, card: RunCardState): void => {
      if (!topicThreadId) return;
      const prev = lastRunCard.get(topicThreadId);
      if (prev && prev !== msgId) {
        const prevState = runCards.get(prev);
        const prevStream = runStreams.get(prev);
        if (prevState && prevStream) void trackTask(prevStream.updateCard(channel, buildRunCardPlain(prevState)));
        runCards.delete(prev);
        runStreams.delete(prev);
        expireRetry(prev);
      }
      lastRunCard.set(topicThreadId, msgId);
      runCards.set(msgId, card);
    };

    /** Finalize a turn's card (terminal render). No-op for a render-only turn that
     * never produced content (no card was sent) — that's how empty turns vanish. */
    /** Whether the last card finalizeCard wrote got through (a cut-short goal's last word, owner 2026-11-02). */
    let lastCardUpdated = false;
    const finalizeCard = async (ctx: GoalTurnCtx | null, continues = false): Promise<void> => {
      lastCardUpdated = false;
      if (!ctx) return;
      carried = ctx.render.snapshot().subagents.filter(row => row.status === 'running');
      ctx.rc.subagentsCarried = continues && carried.length ? true : undefined;
      if (!ctx.stream && ctx.cardRequested && ctx.rc.cardDisplay?.reply?.streamText === false) {
        ctx.render.finalize();
        ctx.rc.rs = ctx.render.snapshot();
        await ensureCard(ctx);
      }
      if (!ctx.stream || !ctx.cardMsgId) return;
      clearInterval(ctx.clock);
      ctx.clock = undefined;
      await ctx.stream.drain();
      const subagents = ctx.render.snapshot().subagents;
      const confirmedDone = ctx.render.terminal() === 'done';
      ctx.render.finalize();
      ctx.rc.rs = { ...ctx.render.snapshot(), subagents };
      logSubagentChanges(subagents, ctx.rc.rs.subagents);
      const answerText = finalMessageText(ctx.rc.rs);
      ctx.rc.localFiles = await outboundFiles.prepare(answerText, {
        messageId: ctx.cardMsgId, chatId: opts.chatId, cwd: runCwd,
        mode: opts.mode ?? DEFAULT_PERMISSION_MODE, requesterOpenId: opts.requesterOpenId,
        replyInThread: !opts.flat, cardId: ctx.stream.getCardId(),
      }, (elementId, element) => ctx.stream!.updateElement(channel, elementId, element));
      ctx.rc.images = await ctx.stream.settleImages(answerText);
      await refreshRunCardDisplayValues(ctx.rc,runCwd);
      const terminalCardUpdated = await ctx.stream.updateCard(channel, buildRunCard(ctx.rc));
      lastCardUpdated = terminalCardUpdated;
      if (confirmedDone && ctx.rc.rs.terminal === 'done' && answerText.trim() && terminalCardUpdated) reportLatestAction(opts.chatId, 'replied');
      runsByCard.delete(ctx.cardMsgId);
      promoteCard(ctx.cardMsgId, ctx.rc);
      finalized.last = ctx;
    };

    /** Begin a turn's render context WITHOUT sending a card yet. */
    const startTurn = (): GoalTurnCtx => {
      const render = new RunRender();
      render.seedSubagents(carried);
      render.seedUsage(topicThreadId ? lastUsage.get(topicThreadId) : undefined);
      render.showTools = getShowToolCalls(state.presentation ?? cfg);
      const goalModelDisp = getModelDisplay(state.presentation ?? cfg);
      const rc: RunCardState = {
        rs: render.snapshot(),
        cardDisplay: state.presentation?.preferences?.cardDisplay,
        requesterOpenId: opts.requesterOpenId,
        showTools: render.showTools,
        goalControls: true,
        ...(opts.backendId ? { backend: opts.backendId } : {}),
        ...((goalModelDisp !== 'off' || state.presentation?.preferences?.cardDisplay) && opts.model
          ? { model: opts.model, effort: opts.effort, modelOnTerminal: goalModelDisp === 'always' }
          : {}),
        ...(opts.sessionNotice ? { sessionNotice: opts.sessionNotice } : {}),
      };
      return { render, rc, stream: null, cardMsgId: null };
    };

    /** Send this turn's streaming card on first real content (idempotent). */
    const ensureCard = async (ctx: GoalTurnCtx): Promise<void> => {
      ctx.cardRequested = true;
      if (ctx.stream || (ctx.rc.cardDisplay?.reply?.streamText === false && ctx.rc.rs.terminal === 'running')) return;
      const stream = new RunCardStream();
      attachRunImages({
        stream,
        rc: ctx.rc,
        channel,
        upload: (sources) => uploadOutboundImages(channel, sources, runCwd, opts.mode ?? DEFAULT_PERMISSION_MODE, opts.network ?? false),
      });
      ctx.rc.askWaiting = askWaiting;
      ctx.rc.askWaitingSubagentId = askWaitingSubagentId;
      await refreshRunCardDisplayValues(ctx.rc,runCwd);
      const cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(ctx.rc), { replyTo, replyInThread });
      ctx.rc.cardKey = cardMsgId;
      state.runCard = ctx.rc;
      ctx.stream = stream;
      ctx.cardMsgId = cardMsgId;
      opts.sessionNotice = undefined; // shown; a turn without a card keeps it for the next
      ctx.clock = setInterval(() => {
        if (ctx.rc.rs.terminal === 'running') stream.streamCoalesced(channel, buildRunCard(ctx.rc), ANSWER_EID);
      }, 1000);
      ctx.clock.unref();
      runsByCard.set(cardMsgId, state);
      runStreams.set(cardMsgId, stream);
      await adoptThreadId(cardMsgId, ctx.rc);
      requestGoalSessionTitleApply();
      // chain the next turn's card (and the terminal card) under this one
      replyTo = cardMsgId;
      replyInThread = !opts.flat;
    };

    let askTurn: AskTurn | undefined;
    let askWaiting: string | undefined;
    let activity: ReturnType<typeof createRunActivity> | undefined;
    let askWaitingSubagentId: string | undefined;
    const askPlacement = { chatId: opts.chatId, replyTo: opts.replyTo, replyInThread: !opts.flat, own: false };
    let lastStatus = 'active';
    let goalTokens = 0;
    let goalSeconds = 0;
    let goalErrorMsg: string | undefined;
    let interrupted = false; // ⏹ 终止 was tapped
    let goalEnded = false; // 🎯 结束目标 was tapped
    let idledOut = false; // idle watchdog fired (presumed-wedged backstop)
    let resolveStop!: () => void; // 终止 → end the loop NOW (cuts current output)
    let resolveEnd!: () => void; // 结束目标 with no turn in flight → end the loop now
    const stopSignal = new Promise<void>((res) => {
      resolveStop = res;
    });
    const endSignal = new Promise<void>((res) => {
      resolveEnd = res;
    });

    try {
      if (opts.knownThreadId) opts.serviceTier = await reconcileStoredSpeed(backendFor(opts.backendId), opts.knownThreadId, runCwd, opts.model, opts.serviceTier);
      // Native goals have no turn/start tier override. A loaded same-client
      // resume also retains its old tier, so reopen an idle persisted thread
      // in a fresh app-server process before a new goal. Brand-new threads
      // are not yet on disk and keep their thread/start tier.
      if (opts.knownThreadId && opts.thread.releaseAfterRun && backendFor(opts.backendId).id === 'codex-appserver') {
        const old = opts.thread;
        const project = await getProjectByChatId(opts.chatId);
        const be = backendFor(opts.backendId);
        if (sessions.get(opts.knownThreadId) === old) sessions.delete(opts.knownThreadId);
        await old.close();
        opts.thread = await resumeWith(be, {
          cwd: runCwd, sessionId: old.sessionId, model: opts.model, effort: opts.effort,
          serviceTier: opts.serviceTier,
          mode: opts.mode, network: opts.network, native: opts.native, readScope: opts.readScope,
          profile: await profileOf(project, runCwd, be, opts.mode),
        }, sessionPlace(project, opts.chatId));
        state.thread = opts.thread;
        trackSession(opts.knownThreadId, opts.thread);
      }
      const currentProject = await getProjectByChatId(opts.chatId);
      const goalBackend = backendFor(opts.backendId);
      if (!projectModelAllowed(currentProject, goalBackend.id, opts.model, opts.effort, currentProject?.modelAccess ? await listModels(goalBackend) : undefined)) throw new Error('当前模型或 Effort 已不在本群可用范围，请用 /model 重新选择。');
      const goalServiceTier = opts.serviceTier;
      const goalContext = await preparePersonality(opts.thread, opts.chatId, {}, opts.knownThreadId, opts.backendId);
      if (currentProject?.dm && !dmOpen(currentProject)) throw new ThreadPermissionChanged(DM_CLOSED);
      askPlacement.own = Boolean(currentProject?.dm);
      const run = opts.thread.runGoal(goalContext.text ? `${goalContext.text}\n\n目标：${objective}` : objective,
        { serviceTier: goalServiceTier });
      state.run = run;
      state.inFlight = opts.origin;
      activity = createRunActivity(opts.chatId);
      // ⏹ 终止: clear the goal first (so it won't reactivate on resume), then end
      // the loop immediately — cutting the in-flight turn's output.
      state.interrupt = () => {
        if (interrupted) return;
        askTurn?.close('stopped');
        interrupted = true;
        void opts.thread.clearGoal().catch(() => undefined);
        resolveStop();
      };
      // 🎯 结束目标: clear the goal so codex stops auto-continuing, but let the
      // in-flight turn finish. With no turn in flight, end now; otherwise the
      // `done` branch below breaks the loop after the current turn completes.
      state.endGoal = () => {
        if (goalEnded || interrupted) return;
        askTurn?.close('stopped');
        goalEnded = true;
        void opts.thread.clearGoal().catch(() => undefined);
        if (cur) {
          // Immediate feedback: drop the 结束目标 button + show "本轮完成后停止"
          // while the in-flight turn keeps streaming. The flag lives on rc, so
          // later frames keep it; this push refreshes the card right away (a
          // structure change forces a whole-card update).
          cur.rc.goalEnding = true;
          if (cur.stream) {
            cur.rc.rs = cur.render.snapshot();
            cur.stream.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
          }
        } else {
          resolveEnd(); // no turn in flight → end now
        }
      };
      // No total wall-clock cap (goals may run for days). GOAL_IDLE_MS is a
      // presumed-wedged backstop: a live goal streams events continuously, so it
      // only fires when codex goes fully silent. stopSignal/endSignal end the loop
      // WITHOUT killing the process, so we can clear the goal + recycle cleanly.
      const stop = Promise.race([stopSignal, endSignal]);
      // Child questions can outlive a parent turn; their watchdog holds do too.
      const idlePause = createIdlePause();
      state.idlePause = idlePause;
      const guarded = withIdleTimeout(redactAgentEvents(run.events, createHiddenBlockFilter()), GOAL_IDLE_MS, () => {
        idledOut = true;
      }, stop, run.lastActivity, idlePause);
      const originalInterrupt = state.interrupt;
      let unseen = opts.seen; // marked once the host starts the goal's first turn (see launchRun)
      for await (const ev of guarded) {
        activity.accept(ev);
        if (ev.type === 'ask_cancelled') { askTurn?.cancel(ev.requestId); continue; }
        if (ev.type === 'ask') {
          if (askTurn) askTurn.enqueue(ev.request, ev.subagentId ? { subagentId: ev.subagentId, name: (cur?.render.snapshot().subagents ?? carried).find(row => row.id === ev.subagentId)?.name } : undefined);
          else { asks.unavailable(run, ev.request, error => log.fail('agent', error)); originalInterrupt(); }
          continue;
        }
        if (ev.type === 'goal_update') {
          lastStatus = ev.status;
          goalTokens = ev.tokensUsed;
          goalSeconds = ev.timeUsedSeconds;
          continue;
        }
        // Usage and compaction update the meter and the process lines of the
        // turn's card; on their own they don't send a card (like reasoning).
        if (ev.type === 'context_usage' || ev.type === 'compaction') {
          let usage = ev.type === 'context_usage' ? { used: ev.usedTokens, window: ev.contextWindow } : undefined;
          if (cur) {
            cur.render.apply(ev);
            cur.rc.rs = cur.render.snapshot();
            usage = cur.rc.rs.usage;
            if (cur.stream) cur.stream.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
          }
          if (topicThreadId && usage) lastUsage.set(topicThreadId, usage);
          if (ev.type === 'compaction' && ev.phase === 'end' && !ev.failed) { markTopicsDue(topicThreadId, opts.chatId, opts.thread.sessionId); markContextDue(opts.thread, topicThreadId); }
          continue;
        }
        if (ev.type === 'turn_started') {
          opts.attentionAcceptance?.accept();
          askTurn?.finishParent();
          if (unseen && topicThreadId) markSeen(topicThreadId, unseen, opts.seenHow);
          unseen = undefined;
          // Unlike runGoal() construction, this proves the host accepted and
          // started the goal's first turn. Generate in parallel from here.
          beginGoalSessionTitle();
          if (topicThreadId) requestGoalSessionTitleApply();
          await finalizeCard(cur, true); // close the previous turn's card (if it produced one)
          cur = startTurn(); // existing topics still send the card lazily on first content
          if (activeKey.startsWith('pending:') && cur.rc.cardDisplay?.reply?.streamText !== false) {
            // A new goal needs a real topic before its first ask can accept text.
            // Anchor both the active run and the question to the same run card.
            await ensureCard(cur);
            if (activeKey.startsWith('pending:')) throw new Error('Goal topic could not be resolved');
            askPlacement.replyTo = cur.cardMsgId!;
          }
          askTurn ??= asks.openTurn({ run, sessionKey: activeKey, placement: askPlacement,
            placed: async messageId => { if (cur) await adoptThreadId(messageId, cur.rc); return activeKey; },
            initiator: { kind: opts.requesterKind ?? 'unknown', openId: opts.requesterOpenId }, idlePause,
            waiting: (label, subagentId) => { activity?.waiting(Boolean(label)); askWaiting = label; askWaitingSubagentId = subagentId; if (cur) { cur.rc.askWaiting = label; cur.rc.askWaitingSubagentId = subagentId; if (cur.stream) cur.stream.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID); } },
            fault: error => { log.fail('agent', error, { phase: 'ask-response' }); if (state.run === run) originalInterrupt(); },
          });
          continue;
        }
        if (ev.type === 'done') {
          askTurn?.finishParent();
          // turn/completed for an intermediate turn — finalize its card (if any).
          // codex auto-continues with the next turn (a terminal goal status, handled
          // after the loop, preempts the final turn's done).
          if (cur) {
            cur.render.apply(ev);
            await finalizeCard(cur, !goalEnded);
            cur = null;
          }
          state.subagents = () => cur?.render.snapshot().subagents ?? carried;
          // 🎯 结束目标: the goal was cleared mid-turn; that turn is now done and
          // codex won't auto-continue, so stop here (codex emits no terminal we'd
          // otherwise wait on — goal/cleared is ignored by the event map).
          if (goalEnded) break;
          continue;
        }
        if (ev.type === 'error') {
          // A retry notice (the backend is retrying the call itself) is not why
          // the goal ended; keep it off the summary card.
          if (!ev.willRetry) { askTurn?.close('turn-ended'); askTurn = undefined; goalErrorMsg = ev.message; }
          if (!cur) continue; // set-failure before any turn → terminal card only
        }
        if (ev.type === 'subagent_start' || ev.type === 'subagent_step' || ev.type === 'subagent_status') {
          const known = knownSubagents.get(ev.id);
          if (known && ev.type !== 'subagent_start') {
            if (cur) cur.render.restoreSubagent(known);
            else if (!carried.some(row => row.id === ev.id)) carried = [...carried, known];
          }
          if (cur) {
            const subagents = cur.render.snapshot().subagents;
            cur.render.apply(ev);
            logSubagentChanges(subagents, cur.render.snapshot().subagents);
            cur.rc.rs = cur.render.snapshot();
          } else carried = reduce({ ...initialState, subagents: carried }, ev).subagents;
          for (const row of cur?.render.snapshot().subagents ?? carried) knownSubagents.set(row.id, row);
          continue;
        }
        if (!cur) cur = startTurn();
        const subagents = cur.render.snapshot().subagents;
        cur.render.apply(ev);
        logSubagentChanges(subagents, cur.render.snapshot().subagents);
        // Reasoning ALONE doesn't warrant a card (a planning-only turn must not leave
        // an empty box); only real output (text / tool calls) sends the card. Once a
        // card exists, keep streaming everything (incl. reasoning) into it.
        if (ev.type === 'thinking' || ev.type === 'thinking_delta') {
          if (cur.stream) {
            cur.rc.rs = cur.render.snapshot();
            cur.stream.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
          }
          continue;
        }
        await ensureCard(cur);
        cur.rc.rs = cur.render.snapshot();
        cur.stream?.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
      }
      activity.end();
      askTurn?.close('turn-ended');
      state.idlePause = undefined;
      // ⏹ 终止: mark the in-flight turn's card as interrupted before finalizing
      // (finalize() is a no-op once terminal, so this doesn't clash).
      if (interrupted && cur) {
        const subagents = cur.render.snapshot().subagents;
        cur.render.interrupt();
        logSubagentChanges(subagents, cur.render.snapshot().subagents);
        // owner 2026-11-02: cut short by a stop, restart or update, the in-flight turn's card says so.
        if (shuttingDown) cur.rc.stopped = { reason: shutdownReason(), resend: opts.origin !== undefined };
      }
      const cutCard = interrupted && shuttingDown && cur !== null;
      await finalizeCard(cur);
      // Only a card that said the goal was cut short settles it; between turns no card says so, and the sender hears later.
      if (cutCard && lastCardUpdated) cutShortAnswered(opts.origin);
      state.inFlight = undefined;
      if (!cur && finalized.last && carried.length) {
        const rs = { ...finalized.last.rc.rs, subagents: [...finalized.last.rc.rs.subagents.filter(row => !carried.some(latest => latest.id === row.id)), ...carried] };
        finalized.last.rc.rs = interrupted ? markInterrupted(rs) : rs;
        finalized.last.rc.subagentsCarried = undefined;
        await finalized.last.stream?.updateCard(channel, buildRunCard(finalized.last.rc));
      }
      cur = null;
      // Covers a goal that produced no content card (and therefore never called
      // ensureCard) plus Claude's post-result native-session timing.
      requestGoalSessionTitleApply();
      retryGoalSessionTitleAfterRun();

      // Always clear the goal when the run ends: a non-complete goal would
      // reactivate on the next resume, and a LEFTOVER goal (even complete) gets
      // re-broadcast as a stale snapshot when this thread is next resumed, which
      // would make the next /goal "complete" instantly (see runGoal's stale guard).
      // (Manual 终止/结束目标 already cleared it; this is idempotent + covers the
      // natural-terminal / idle-backstop paths.)
      await opts.thread.clearGoal().catch(() => undefined);

      // Summary card only for an autonomous end (natural terminal status, or the
      // idle backstop). Manual ⏹ 终止 / 🎯 结束目标 end silently — the run card(s)
      // already convey the outcome.
      if (!interrupted && !goalEnded) {
        const status = idledOut ? 'timeout' : goalErrorMsg && !isGoalTerminal(lastStatus) ? 'error' : lastStatus;
        await sendManagedCard(
          channel,
          opts.chatId,
          buildGoalDoneCard({ objective, status, tokensUsed: goalTokens, timeUsedSeconds: goalSeconds, errorMessage: goalErrorMsg }),
          replyTo,
          !opts.flat,
        ).catch((err) => log.fail('card', err, { phase: 'goal-done' }));
        log.info('card', 'goal-final', { status, tokens: goalTokens, seconds: goalSeconds });
      } else {
        log.info('card', 'goal-final', { status: interrupted ? 'interrupted' : 'ended', tokens: goalTokens, seconds: goalSeconds });
      }
      if (topicThreadId) await patchSession(topicThreadId, { updatedAt: Date.now(), ...savedMeter(topicThreadId, opts.thread) }).catch(() => undefined);
    } catch (err) {
      askTurn?.close('turn-ended');
      activity?.end();
      log.fail('intake', err);
      await opts.thread.clearGoal().catch(error => log.fail('agent', error, { phase: 'goal-clear' }));
      if (cur?.stream && cur.cardMsgId) {
        clearInterval(cur.clock);
        cur.render.apply({ type: 'error', message: err instanceof Error ? err.message : String(err), willRetry: false });
        cur.rc.rs = cur.render.snapshot();
        cur.rc.askWaiting = undefined;
        // Do not repeat finalizeCard's file/image I/O after a failure. Drain old
        // frames, then retire the card without controls; a second failure stays secondary.
        try {
          await cur.stream.drain();
          await cur.stream.updateCard(channel, buildRunCardPlain(cur.rc));
        } catch (error) { log.fail('card', error, { phase: 'goal-failure-card' }); }
        runStreams.delete(cur.cardMsgId);
        runCards.delete(cur.cardMsgId);
      }
      await channel
        .send(opts.chatId, { markdown: runFailureMessage(err, 0, opts.sessionNotice) }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch(() => undefined);
    } finally {
      askTurn?.close('turn-ended');
      activity?.end();
      state.idlePause = undefined;
      state.runCard = undefined;
      state.run = undefined;
      state.subagents = undefined;
      clearInterval(cur?.clock);
      active.delete(activeKey);
      if (cur?.cardMsgId) runsByCard.delete(cur.cardMsgId);
      // Recycle the codex process (it may still be mid-goal, and a terminated goal
      // leaves trailing notifications); the persisted record stays so the next
      // message resumes a fresh process.
      void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
      if (topicThreadId) sessions.delete(topicThreadId);
      release();
    }
  }

  // ── cloud-doc comments ────────────────────────────────────────────
  /**
   * `comment` event: someone @-mentioned the bot in a Feishu doc comment
   * (drive.notice.comment_add_v1). There's no streaming card here — we mark the
   * triggering reply with a "Typing" reaction, run one codex turn, and post the
   * answer back into the same comment thread. One codex thread per document
   * (keyed `doc:<fileToken>`), so repeated @-mentions in a doc continue the same
   * conversation; it shares the session store + concurrency semaphore with the
   * group run loop. Comment runs aren't interruptible (no ⏹ card) — the idle
   * watchdog is the only kill switch.
   */
  const onComment = async (evt: CommentEvent): Promise<void> => {
    // 评论事件没有 messageId，按 commentId+replyId 去重（前缀防与消息 id 混淆）。
    if (seenInbound.seen(`comment:${evt.commentId}:${evt.replyId ?? ''}`)) {
      log.info('comment', 'skip', { reason: 'duplicate', commentId: evt.commentId });
      return;
    }
    await withTrace({ chatId: 'comment' }, async () => {
      log.info('comment', 'enter', {
        doc: evt.fileToken,
        fileType: evt.fileType,
        commentId: evt.commentId,
        replyId: evt.replyId ?? null,
        mentionedBot: evt.mentionedBot,
        sender: evt.operator.openId,
      });
      if (!evt.mentionedBot) return log.info('comment', 'skip', { reason: 'not-mentioned' });
      if (!SUPPORTED_FILE_TYPES.has(evt.fileType))
        return log.info('comment', 'skip', { reason: 'unsupported-fileType', fileType: evt.fileType });
      // 评论 @bot 仅响应管理员（owner / admins）——评论流可改文档，破坏性，不放给任何人。
      // operator.openId 可能缺失（事件归一化边角）：?? '' 让 isAdmin 安全返回 false，
      // 且 slice 不会在 undefined 上抛 TypeError。
      const operatorId = evt.operator?.openId ?? '';
      if (!isAdmin(cfg, operatorId))
        return log.info('comment', 'skip', { reason: 'not-admin', sender: operatorId.slice(-6) || '(unknown)' });

      const resolved = await resolveComment(channel, evt);
      if (!resolved) return log.info('comment', 'skip', { reason: 'no-target-or-empty' });
      const { target, ctx } = resolved;
      log.info('comment', 'parsed', { isWhole: ctx.isWhole, hasQuote: Boolean(ctx.quote) });

      // One session per comment THREAD (not per doc): distinct threads on the same
      // doc are independent and run in parallel; replies in a thread continue it.
      const sessionKey = commentSessionKey(target.fileToken, evt.commentId);
      // Per-doc working dir, seeded with the user-editable instructions (synced to
      // AGENTS.md + CLAUDE.md so codex/claude read them natively, no per-turn inject).
      const cwd = commentCwd(paths.commentsRootDir, target.fileType, target.fileToken);
      const rawInstructions = await loadCommentInstructions(paths.commentInstructionsFile);
      // Substitute this doc's variables ({fileType}/{fileToken}/{docUrl}) before syncing.
      const instructions = renderCommentInstructions(
        rawInstructions,
        cfg.accounts.app.tenant,
        target.fileType,
        target.fileToken,
      );
      let synced = true;
      await syncCommentInstructions(cwd, instructions).catch((err) => {
        synced = false;
        log.warn('comment', 'sync-instructions-failed', { err: err instanceof Error ? err.message : String(err) });
      });
      // Normally the instructions reach the agent via the synced AGENTS.md/CLAUDE.md.
      // If the sync FAILED (disk/permission), the cwd may lack those files — fall back
      // to prepending the instructions to this turn's prompt so the machine contract
      // (don't self-post / plain-text only) never silently vanishes.
      const facts = buildCommentPrompt(target, ctx, cfg.accounts.app.tenant);
      const prompt = synced ? facts : `${instructions}\n\n---\n\n${facts}`;

      // Best-effort "received" feedback up-front (comments have no streaming
      // UI). Added before the per-doc lock so a queued mention still acks
      // immediately; cleared in the finally regardless of how the run ends.
      const reacted = ctx.targetReplyId
        ? await addCommentReaction(channel, target, ctx.targetReplyId)
        : false;

      try {
        // Serialize per comment THREAD (sessionKey = doc:<token>:<commentId>): one
        // codex thread can't run two turns at once (they'd both consume its single
        // app-server notification stream and steal each other's events), so repeated
        // @-mentions in the SAME comment thread must queue. Different threads — even
        // on the same doc — have distinct codex threads and run in parallel; the
        // global cap is still `sema`, acquired inside the lock.
        await withDocLock(sessionKey, async () => {
          const release = await sema.acquire();
          let turn: TurnScope | undefined;
          try {
            if (shuttingDown) return;
            const thread = await resolveDocThread(sessionKey, cwd, instructions, ctx.question, target);
            if (shuttingDown) { await thread.close(); return; }
            const rec = await getSession(sessionKey);
            // The document tools answer only while a turn is going (dm-agent 7.4). The person was checked above.
            turn = entries?.openTurn(thread, { requesterOpenId: operatorId, requesterKind: 'user', triggerMessageId: evt.replyId ?? evt.commentId, retry: false, initiative: false, wake: false });
            const run = thread.runStreamed({ text: prompt }, { model: rec?.model, effort: rec?.effort });

            let state: RunState = initialState;
            let timedOut = false;
            let askFault = false;
            let consuming = true;
            let stopAsk!: () => void;
            const askStopped = new Promise<void>(resolve => { stopAsk = resolve; });
            const idleMs = currentIdleMs();
            const guarded = withIdleTimeout(redactAgentEvents(run.events, createHiddenBlockFilter()), idleMs, () => {
              timedOut = true;
            }, askStopped, run.lastActivity);
            try {
              for await (const ev of guarded) {
                if (ev.type === 'ask_cancelled') continue;
                if (ev.type === 'ask') {
                  asks.unavailable(run, ev.request, error => {
                    log.fail('agent', error, { phase: 'comment-ask' });
                    if (!consuming) return;
                    askFault = true;
                    stopAsk();
                    const id = run.turnId();
                    if (id) void thread.abort(id).catch(() => undefined);
                  });
                  continue;
                }
                state = reduce(state, ev);
              }
            } finally { consuming = false; }

            if (timedOut || askFault) {
              const tid = run.turnId();
              // Recycle the thread so the hung turn's never-terminating stream
              // doesn't poison the next comment; the doc resumes from the
              // persisted thread on its next @-mention. Fire-and-forget the
              // interrupt — turn/interrupt is an unbounded JSON-RPC round-trip,
              // and close() SIGKILLs the child anyway, so awaiting it here would
              // pin both the per-doc lock and a global semaphore slot if it
              // hangs. sessions.delete stays synchronous + before release() so
              // the next queued same-doc comment always starts fresh.
              if (tid) void thread.abort(tid).catch(() => undefined);
              void trackTask(thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
              sessions.delete(sessionKey);
              commentInstrUsed.delete(sessionKey);
            } else {
              touchSession(sessionKey); // 轮次收尾打点（M-3 reaper 的空闲时钟）
              await patchSession(sessionKey, { updatedAt: Date.now() });
            }

            let reply = stripMarkdown(finalMessageText(state)).trim();
            if (state.terminal === 'error' && state.errorMsg) reply = `⚠️ 出错了：${state.errorMsg}`;
            let notice = '';
            if (timedOut) {
              const stopped = `${idleLabel(Math.round(idleMs / 1000))}没有输出，已停止`;
              if (reply) notice = `\n\n（${stopped}）`;
              else reply = `（${stopped}。可以再 @ 我一次，或者把问题问得更具体些）`;
            }
            if (!reply) reply = '（没有可回复的内容）';
            reply = fitCommentReply(reply, notice);

            await postCommentReply(channel, target, evt, reply).catch((err) =>
              log.fail('comment', err, { step: 'postCommentReply' }),
            );
            log.info('comment', 'done', { terminal: state.terminal, timedOut, len: reply.length });
          } finally {
            turn?.close();
            release();
          }
        });
      } catch (err) {
        log.fail('comment', err, { step: 'run' });
      } finally {
        if (reacted && ctx.targetReplyId)
          await removeCommentReaction(channel, target, ctx.targetReplyId).catch(() => undefined);
      }
    }).catch((err) => log.fail('comment', err));
  };

  /**
   * Run `fn` serially per `key`: each call chains after the previous one for the
   * same key (so same-doc comment turns never overlap), while different keys run
   * concurrently. The map entry is dropped once its chain fully drains.
   */
  function withDocLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = docLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the prior call's outcome
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    docLocks.set(key, tail);
    void tail.then(() => {
      if (docLocks.get(key) === tail) docLocks.delete(key);
    });
    return run;
  }

  async function resolveDocThread(
    sessionKey: string,
    cwd: string,
    instructions: string,
    question: string,
    target: ResolvedTarget,
  ): Promise<AgentThread> {
    const docId = target.fileToken;
    // The comment settings, else the bot default, else built in (s36d2); no tier, as before.
    const comments = resolveCommentsExecution(cfg.preferences);
    const be = backendFor(comments.backend);
    const { model, effort } = pickDefault(await listModels(be), comments.model);
    const modelCustom = isCustomDefault(comments.model, model);
    const rec = await getSession(sessionKey);
    const selectionChanged = rec && (rec.backend !== be.id || rec.model !== model || rec.effort !== effort);
    const live = sessions.get(sessionKey);
    if (live) {
      if (live.isAlive() && !selectionChanged && commentInstrUsed.get(sessionKey) === instructions) return live;
      await live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' }));
      sessions.delete(sessionKey);
      commentInstrUsed.delete(sessionKey);
    }
    if (rec && rec.backend === be.id) {
      try {
        const resumed = await resumeWith(be, { cwd: rec.cwd, sessionId: rec.sessionId, model, effort, profile: await profileOf(undefined, rec.cwd, be, 'full', 'comment', target.fileType) }, { kind: 'doc', docId });
        // 评论的模型来自评论设置（不是手填的）或 bot 默认
        await patchSession(sessionKey, { model, effort, modelCustom });
        trackSession(sessionKey, resumed);
        commentInstrUsed.set(sessionKey, instructions);
        return resumed;
      } catch (err) {
        log.fail('agent', err, { phase: 'comment-resume', sessionKey });
      }
    }
    const fresh = await startWith(be, { cwd, model, effort, profile: await profileOf(undefined, cwd, be, 'full', 'comment', target.fileType) }, { kind: 'doc', docId });
    trackSession(sessionKey, fresh);
    commentInstrUsed.set(sessionKey, instructions);
    await upsertSession({
      threadId: sessionKey,
      chatId: sessionKey,
      cwd,
      sessionId: fresh.sessionId,
      backend: be.id,
      model,
      effort,
      summary: question.slice(0, 80),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return fresh;
  }

  async function defaultBindBackend(backends: SelectOption[]): Promise<string | undefined> {
    const preferred = cfg.preferences?.defaults?.backend ?? await effectiveDefaultBackend().catch(() => DEFAULT_BACKEND_ID);
    return backends.some(option => option.value === preferred) ? preferred : backends[0]?.value;
  }

  const pendingGroups = createPendingGroups({
    file: pendingGroupsFile(paths.projectsFile),
    eligible: async ({ chatId }) => !(await getProjectByChatId(chatId)),
    verify: async chatId => {
      const membership = await channel.rawClient.im.v1.chatMembers.isInChat({ path: { chat_id: chatId } });
      if (membership.code !== 0 || typeof membership.data?.is_in_chat !== 'boolean') throw new Error('无法确认机器人群成员身份');
      if (!membership.data.is_in_chat) return { state: 'retry' };
      const info = await withDeadline(channel.getChatInfo(chatId), 3000, 'pending-chatinfo');
      if (!info) throw new Error('读取飞书群信息超时');
      if (info.chatType === 'p2p' || (channel.botIdentity?.openId && info.ownerId === channel.botIdentity.openId)) return { state: 'ignore' };
      const name = info?.name?.trim();
      if (!name) throw new Error('无法读取飞书群名称');
      // Feishu also returns topic; the SDK declaration only lists group and p2p.
      const chatType: string = info.chatType;
      const mode = await topicCtx.chatInfo(chatId);
      return { state: 'ready', name, topic: chatType === 'topic' || mode.topic, ...(mode.ok && mode.bots !== undefined ? { hasOtherBots: mode.bots > 1 } : {}) };
    },
    onError: error => log.fail('intake', error, { phase: 'pending-groups' }),
  });
  void trackTask(pendingGroups.refresh());
  const pendingGroupTimer = setInterval(() => { void trackTask(pendingGroups.refresh()); }, 15_000);
  pendingGroupTimer.unref();

  /** Record arrivals before lookup; notify privileged adders directly, otherwise the owner.
   * Self joins and redeliveries do not send cards. Shutdown can interrupt each bounded lookup. */
  async function onBotAddedToChat(evt: BotAddedEvent): Promise<void> {
    await withTrace({ chatId: evt.chatId }, async () => {
      const op = evt.operator?.openId;
      const tail = { chatId: evt.chatId.slice(-6), op: op?.slice(-6) };
      if (op && op === channel.botIdentity?.openId) {
        log.info('intake', 'bot-added-self', tail);
        return;
      }
      if (await getProjectByChatId(evt.chatId)) {
        log.info('intake', 'bot-added-bound', tail);
        return;
      }
      if (!op) {
        log.info('intake', 'bot-added-no-operator', tail);
        return;
      }
      unboundNoted.delete(evt.chatId);
      const fresh = await pendingGroups.add(evt.chatId, op).catch(error => {
        log.fail('intake', error, { phase: 'pending-group-add' });
        return true;
      });
      void trackTask(pendingGroups.refresh());
      if (!fresh) {
        log.info('intake', 'bot-added-again', tail);
        return;
      }
      const admin = isAdmin(cfg, op);
      const to = admin ? op : primaryAdmin(cfg);
      if (!to) {
        log.info('intake', 'bot-added-no-admin', tail);
        return;
      }
      const [info, mode, adderName] = await Promise.all([
        orStop(withDeadline(channel.getChatInfo(evt.chatId), 3000, 'bot-added-chatinfo').catch(error => {
          log.fail('intake', error, { phase: 'bot-added-chatinfo' });
          return undefined;
        }), undefined),
        orStop(topicCtx.chatInfo(evt.chatId), { ok: false, topic: false }),
        admin ? undefined : names.peek(op) ?? orStop(withDeadline((async () => {
          const contact = (await resolveNames(channel, [op])).get(op);
          if (contact) return contact;
          let found: string | undefined;
          for (const member of await fetchChatMembers(channel, evt.chatId)) {
            if (member.name.startsWith('…')) continue;
            names.remember(member.openId, member.name);
            if (member.openId === op) found = member.name;
          }
          return found;
        })(), 3000, 'bot-added-adder'), undefined),
      ]);
      if (adderName) names.remember(op, adderName);
      if (shuttingDown) {
        log.info('intake', 'bot-added-dropped', tail);
        return;
      }
      if (await getProjectByChatId(evt.chatId)) {
        log.info('intake', 'bot-added-bound', tail);
        return;
      }
      const name = info?.name?.trim() ?? '';
      const chatType: string | undefined = info?.chatType;
      const topic = chatType === 'topic' || mode.topic;
      const backends = backendOptionsFor('full');
      const backend = await defaultBindBackend(backends);
      if (shuttingDown) {
        log.info('intake', 'bot-added-dropped', tail);
        return;
      }
      const fullOnly = backendFor(DEFAULT_BACKEND_ID).fullAccessOnly?.();
      const sibling = bindingBot ? await orStop(siblingProjectOfChat(evt.chatId, bindingBot.appId).catch(() => undefined), undefined) : undefined;
      const card = buildJoinGroupFormCard({ chatId: evt.chatId, name, topic, backends, backend, ...(sibling ? { sibling: { name: sibling.name } } : {}),
        hasOtherBots: mode.ok && mode.bots !== undefined ? mode.bots > 1 : undefined,
        fullOnly, addedBy: admin ? undefined : { name: adderName } });
      const sent = await orStop(sendManagedCard(channel, to, card, undefined, false, 'open_id').then(() => 'yes', error => {
        log.fail('intake', error, { phase: 'bot-added-bindcard', to: admin ? 'adder' : 'admin' });
        return 'no';
      }), 'unknown');
      log.info('intake', 'bot-added', { ...tail, to: admin ? 'adder' : 'admin', topic,
        named: Boolean(name), adderNamed: Boolean(adderName), sent });
    }).catch(error => log.fail('intake', error, { phase: 'bot-added' }));
  }

  /**
   * Bot removed from a group (im.chat.member.bot.deleted_v1, tapped on the raw
   * dispatcher in bridge.ts — the SDK has no named event for it). Auto-unbind the
   * bound project: the bot is already out, so no me_leave. Notify the binder.
   */
  async function onBotRemovedFromChat(chatId: string): Promise<void> {
    await pendingGroups.remove(chatId).catch(error => log.fail('intake', error, { phase: 'pending-group-remove' }));
    const project = await getProjectByChatId(chatId);
    if (!project) return;
    // Remove first, then notify only if THIS call removed it — Feishu delivers
    // events at-least-once and this raw-tap path bypasses the SDK's dedup, so a
    // redelivery would otherwise double-notify the binder. removeProject returns
    // undefined when the entry is already gone.
    const removed = await removeProject(project.name);
    if (!removed) return;
    forgetAttention(project.chatId, 'unbind');
    markUnavailable(project.chatId);
    log.info('intake', 'bot-removed-unbind', { name: removed.name, chatId: chatId.slice(-6) });
    if (removed.addedBy) {
      await channel.rawClient.im.v1.message
        .create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: removed.addedBy,
            msg_type: 'text',
            content: JSON.stringify({ text: `ℹ️ 我已被移出群「${removed.name}」，对应项目已自动解绑。` }),
          },
        })
        .catch(() => undefined);
    }
  }

  /** A message posed as if `senderId` sent `content` in reply to the run card
   * `cardMessageId`, so 👍 继续 and 🔁 重试 reuse the whole message pipeline. */
  function cardTurnMessage(
    cardMessageId: string, chatId: string, senderId: string, content: string, sessionKey: string, flat: boolean,
  ): NormalizedMessage {
    return {
      messageId: cardMessageId,
      chatId,
      chatType: 'group',
      senderId,
      content,
      rawContentType: 'text',
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: true,
      threadId: flat ? undefined : sessionKey,
      createTime: Date.now(),
    };
  }

  // ── M-6 reaction 入站：零打字驱动 ─────────────────────────────────
  /**
   * `reaction` event（SDK 已归一化 im.message.reaction.created_v1 并自带去重）。
   * 按 message_id 反查归属：运行中的 run/排队卡（runsByCard）→ OK/DONE 走与
   * RC.stop 同语义的终止；终态 run 卡（runCards，每话题只留最新一张）→ 👍 等价
   * 在话题里发「继续」。事件天然限机器人所在会话；缺 im:message.reactions:read
   * scope 时事件根本不会推送 —— 整条链路零报错地静默关闭。
   */
  const onReaction = async (evt: ReactionEvent): Promise<void> => {
    if (evt.action !== 'added') return;
    // 机器人（含自己的 ⏳/🫳/OKR 生命周期表情）不能触发自己：事件体 operator_type
    // 标 app 的一律忽略；normalizeReaction 已滤掉无 open_id 的事件，这里再按自身
    // open_id 双保险。
    const operatorType = (evt.raw as { operator_type?: string } | undefined)?.operator_type;
    if (operatorType && operatorType !== 'user') return;
    const op = evt.operator?.openId;
    if (!op || op === channel.botIdentity?.openId) return;

    const running = runsByCard.get(evt.messageId);
    const intent = classifyReaction(evt.emojiType, Boolean(running));
    if (!intent) return;
    await withTrace({ msgId: evt.messageId }, async () => {
      if (intent === 'stop' && running) {
        // 与 RC.stop 相同的 owner-or-admin 门（杀别人的 run 限发起人/管理员，
        // design §5）。事件体不带 chat_id，拒绝只记日志、不回贴。
        if (op !== running.requesterOpenId && !isAdmin(cfg, op)) {
          log.info('intake', 'reaction-denied', { emoji: evt.emojiType, op: op.slice(-6) });
          return;
        }
        running.interrupt?.();
        log.info('intake', 'reaction-stop', { emoji: evt.emojiType, stopped: Boolean(running.interrupt) });
        return;
      }
      if (intent !== 'continue') return;
      const rc = runCards.get(evt.messageId);
      const sessionKey = rc?.threadId;
      if (!rc || !sessionKey) return; // 不是（最新的）终态 run 卡 / adopt 失败无会话可续
      // 随手点赞的群友不该烧一轮 codex：续轮与 run 控件同门（发起人或管理员），
      // 且会话/用户仍须在白名单内（与真发一条消息的门禁一致）。
      if (op !== rc.requesterOpenId && !isAdmin(cfg, op)) {
        log.info('intake', 'reaction-denied', { emoji: evt.emojiType, op: op.slice(-6) });
        return;
      }
      const rec = await getSession(sessionKey);
      if (!rec) return;
      const project = await getProjectByChatId(rec.chatId);
      // Unbound or disabled: a message there would not run either, and an
      // unbound resume has no tier (backends read that as full access).
      if (!project || project.enabled === false) {
        log.info('intake', 'reaction-denied', { emoji: evt.emojiType, unbound: !project });
        return;
      }
      if (!placeOpen(rec.chatId, op) || !isUserAllowedInProject(cfg, project, op)) return;
      // Flat only for a single group's main-area session (keyed by chatId); a
      // topic in a single group is its own session and continues in the topic.
      const flat = project !== undefined && ruleKind(project) === 'single' && sessionKey === rec.chatId;
      // 合成一条等价的「继续」消息复用整条消息管线（steer/queue/goal 提示全部
      // 生效）：replyTo 指向被点的终态卡，⏳/🫳 生命周期表情也落在卡上作回执；
      // sessionKey 用卡片自己的会话键，续的就是这张卡的会话。
      const synthetic = cardTurnMessage(evt.messageId, rec.chatId, op, '继续', sessionKey, flat);
      log.info('intake', 'reaction-continue', { key: sessionKey, op: op.slice(-6) });
      await handleTurn(synthetic, '继续', sessionKey, flat, project, turnPerm(project));
    });
  };

  // ── application.bot.menu_v6（bot 单聊菜单）────────────────────────
  /**
   * onboarding 一直引导订阅该事件（README / 启动文案）但 bridge 此前没有处理器
   * —— 点菜单毫无反应的半成品（research/04 §4）。bot 菜单仅单聊生效，而 DM 正是
   * 管理台的地盘：按 event_key 路由到对应卡——dm.newProject / dm.projects /
   * dm.settings / dm.usage / dm.doctor / dm.reconnect / dm.update 各自直达对应卡
   * （与首页卡内同名按钮的渲染同源，单一事实源）；其它 key 或空 key 回退首页菜单卡，
   * 兼容「只配一个入口」与「私聊发任意消息→首页卡」（handleDmConsole）的旧语义。
   * 非管理员回拒绝文案（同私聊消息，走 dmRefusal）。事件不带 chat_id，发送走
   * receive_id_type=open_id。
   */
  /** What a non-administrator gets in a private chat and the list the client picks administrators from (dm-agent 3.5). */
  const dmRefusal = createDmRefusal({ channel, appId: cfg.accounts.app.id });
  const onBotMenu = async (evt: { openId?: string; eventKey?: string; eventId?: string }): Promise<void> => {
    const op = evt.openId;
    if (!op) return;
    // raw-tap 绕过 SDK 的内建去重（at-least-once 重推会双开菜单卡）——有 event_id
    // 就按它去重；没有则照常放行（同一菜单点两下本就该出两张卡）。
    if (evt.eventId && seenInbound.seen(`menu:${evt.eventId}`)) return;
    log.info('intake', 'bot-menu', { key: evt.eventKey, op: op.slice(-6) });
    if (!isAdmin(cfg, op)) {
      await dmRefusal({ openId: op });
      return;
    }
    const sendDm = (c: object) => sendManagedCard(channel, op, c, undefined, false, 'open_id');
    try {
      switch (evt.eventKey) {
        case DM.newProject:
          await sendDm(buildNewProjectFormCard({ backends: backendOptionsFor('full') }));
          break;
        case DM.projects:
          await sendDm(await renderProjectList());
          break;
        case DM.settings:
          await sendDm(buildSettingsCard(cfg));
          break;
        case DM.doctor:
          await sendDm(buildDoctorCard(await buildDoctorInfo()));
          break;
        case DM.reconnect:
          await sendDm(buildReconnectCard(channel.getConnectionStatus?.()?.state ?? 'unknown'));
          break;
        case DM.restart:
          await sendDm(buildForegroundRestartCard());
          break;
        case DM.usage: {
          // 同 runUsage 语义，但锚在自己刚发的 loading 卡上：取数后原地更新；取数失败按
          // UsageError.kind 渲染错误卡；原地更新失败（极小概率实体失效）兜底再发一张。
          const { messageId } = await sendDm(buildUsageCard({ phase: 'loading' }));
          let state: UsageCardState;
          try {
            state = { phase: 'ready', data: await fetchUsageBundle(false) };
          } catch (e) {
            log.fail('console', e, { phase: 'usage', via: 'menu' });
            state = {
              phase: 'error',
              kind: e instanceof UsageError ? e.kind : 'transient',
              message: e instanceof Error ? e.message : String(e),
            };
          }
          const ok = await updateManagedCard(channel, messageId, buildUsageCard(state)).catch(() => false);
          if (!ok) await sendDm(buildUsageCard(state));
          break;
        }
        case DM.update:
          await sendDm(await renderForegroundUpdate());
          break;
        default:
          await sendDm(await renderDmMenuCard());
      }
    } catch (err) {
      log.fail('console', err, { cmd: 'menu-card', key: evt.eventKey });
    }
  };

  // ── M-3 空闲进程 reaper ──────────────────────────────────────────
  // sessions 只增不减：数周 daemon 会积累几十上百个常驻 agent 进程（每个 ~172MB
  // 子树）。周期清扫超过 SESSION_REAP_IDLE_MS 无轮次的 LIVE 会话：close()
  // （SIGKILL 子进程）+ 驱逐缓存。持久化记录不动 —— 下一条消息经 resolveThread
  // 的 resume 兜底自愈，对话无感衔接。active（运行/排队中）与 docLocks（评论
  // 串行链）持有的会话跳过；goal 话题本就每轮收尾回收，不受影响。与 watchdog
  // 的假死超时语义不冲突：那是单轮内的事件静默，这里是轮与轮之间的空闲。
  const reaper = setInterval(() => {
    const now = Date.now();
    // 没打点的 key 先补记（理论不可达——所有入缓存都走 trackSession），下轮评估；
    // 已驱逐会话的残留打点顺手清掉，时钟表不随历史会话无限增长。
    for (const key of sessions.keys()) if (!sessionTouchedAt.has(key)) sessionTouchedAt.set(key, now);
    for (const key of [...sessionTouchedAt.keys()]) if (!sessions.has(key)) sessionTouchedAt.delete(key);
    const idle = pickIdleSessions(
      sessions.keys(),
      sessionTouchedAt,
      (k) => active.has(k) || docLocks.has(k),
      SESSION_REAP_IDLE_MS,
      now,
    );
    for (const key of idle) {
      const thread = sessions.get(key);
      sessions.delete(key);
      sessionTouchedAt.delete(key);
      if (thread) void trackTask(thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
    }
    if (idle.length > 0) log.info('agent', 'idle-reap', { reaped: idle.length, live: sessions.size });
  }, SESSION_REAP_SWEEP_MS);
  reaper.unref(); // 不挡进程退出（CLI/测试里 orchestrator 可能不走 shutdown）

  /** What a shutdown drops unanswered (product.md 3.10, s18c), read only: queued turns (not ones the running turn's
   * record block already carried), input held by /compact or /new, a /compact waiting on a run, and a run waiting for a
   * slot. A run preparing its first turn and a started one are not here. A state can sit under two keys. */
  function collectLost(): DroppedOrigin[] {
    const lost: DroppedOrigin[] = [];
    for (const state of new Set(active.values())) {
      for (const turn of state.queue) if (turn.origin && !(turn.seen && state.woven?.has(turn.seen.id))) lost.push(turn.origin);
      for (const held of state.deferred ?? []) if (held.origin) lost.push(held.origin);
      // Where dropCompact would answer it.
      if (state.compactAfter) lost.push(originOf(state.compactAfter.msg, !state.compactAfter.inThread));
      if (state.waiting) lost.push(state.waiting);
    }
    // Named messages still judged (s25): their senders were promised an answer. Unnamed ones go without a word.
    for (const item of smartLanes.pending()) lost.push(originOf(item.msg, !item.msg.threadId));
    for (const burst of dmBursts.values()) for (const msg of burst.msgs) lost.push(originOf(msg, !msg.threadId));
    return lost;
  }

  /** Each message once: a run waiting for a slot is both lost (collectLost) and in flight. */
  function oncePerMessage(items: readonly DroppedOrigin[]): DroppedOrigin[] {
    return items.filter((item, index) => items.findIndex(other => other.messageId === item.messageId) === index);
  }

  /** The people's turns in flight now (ActiveState.inFlight), a first turn still being prepared too. */
  function inFlightTurns(): DroppedOrigin[] {
    return [...new Set(active.values())].flatMap(state => state.inFlight ? [state.inFlight] : []);
  }

  /**
   * A cut-short turn whose card said so (or answered): its sender is not asked again once the bot is back. A card that
   * got through after the drain had kept its turn takes it off dropped.json again (review 259).
   */
  function cutShortAnswered(origin: DroppedOrigin | undefined): void {
    if (!origin) return;
    const ref = origin.messageId.slice(-6);
    if (cutShort.delete(origin.messageId)) {
      resendKept.set(origin.messageId, 'answered');
      log.info('bridge', 'cut-short-card', { ref });
    } else if (resendKept.get(origin.messageId) === 'appended') {
      resendKept.set(origin.messageId, 'answered');
      droppedReplies?.retractSync(origin);
      log.info('bridge', 'cut-short-card-late', { ref });
    }
  }

  /** Keeps a person's message the shutdown dropped or cut short in dropped.json: once, and not one its card answered. */
  function keepForResend(origin: DroppedOrigin): void {
    cutShort.delete(origin.messageId);
    if (resendKept.has(origin.messageId)) return;
    resendKept.set(origin.messageId, 'appended');
    droppedReplies?.appendSync(origin);
  }

  /** The cut-short turns whose card did not say so in time (or at all): their senders hear once the bot is back. */
  function keepCutShort(): void {
    const left = [...cutShort.values()];
    for (const origin of left) keepForResend(origin);
    if (left.length) log.info('bridge', 'cut-short-kept', { turns: left.length });
  }

  /** Waits for the runs (and, with `accepted`, the other tracked tasks) for at most `ms`; true when they all ended. */
  async function settleWithin(ms: number, accepted: boolean): Promise<boolean> {
    const deadline = Date.now() + ms;
    const pending = (): Promise<unknown>[] => accepted ? [...acceptedTasks, ...runTasks] : [...runTasks];
    while (pending().length) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      let timer: NodeJS.Timeout | undefined;
      const results = await Promise.race([
        Promise.allSettled(pending()),
        new Promise<undefined>(resolve => { timer = setTimeout(resolve, left, undefined); }),
      ]).finally(() => clearTimeout(timer));
      if (!results) return false;
      for (const result of results) if (result.status === 'rejected') shutdownErrors.add(result.reason);
    }
    return true;
  }

  /**
   * Stops, restarts and updates cut the turns short at once (owner 2026-11-02): every turn is interrupted now, Codex and
   * Claude get up to {@link SHUTDOWN_INTERRUPT_GRACE_MS} to end it, then their processes are closed. The cards of the
   * cut-short turns say why and ask for the message again; the drain waits {@link SHUTDOWN_DRAIN_MS} at most for them,
   * and what is not confirmed by then goes to dropped.json like the queued messages (s18c).
   */
  function shutdown(reason?: () => StopReason): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    if (reason) shutdownReason = reason;
    // No new agent process from now on; the running ones are closed once the grace is over.
    stopAcceptingProviderProcesses();
    entries?.closeAll('shutdown');
    if (attentionTimer !== undefined) time.clearTimer(attentionTimer);
    attentionTimer = undefined;
    for (const burst of dmBursts.values()) time.clearTimer(burst.timer);
    attention.observe(() => undefined);
    asks.shutdown();
    // Written at once, before anything is cleared below and long before the Codex processes end or the lock goes.
    const lost = collectLost();
    droppedReplies?.saveSync(lost, 'shutdown');
    for (const origin of lost) resendKept.set(origin.messageId, 'saved');
    // A run waiting for a slot is in both: kept above already.
    for (const origin of inFlightTurns()) if (!resendKept.has(origin.messageId)) cutShort.set(origin.messageId, origin);
    // After collectLost read the lanes, before the judge's processes go: nothing judged lands now, nor takes its THINKING off.
    for (const item of smartLanes.pending()) dropAck(item);
    smartLanes.shutdown();
    for (const stop of onStop) stop();
    clearInterval(pendingGroupTimer);
    clearInterval(reaper);
    const cleanup: Promise<unknown>[] = [];
    const startCleanup = (operation: () => Promise<unknown>): void => {
      try { cleanup.push(operation()); }
      catch (error) { shutdownErrors.add(error); }
    };
    const dropped = { queued: 0, held: 0, compacts: 0 };
    for (const state of active.values()) {
      cancelIntake(state);
      dropped.queued += state.queue.length;
      dropped.held += state.deferred?.length ?? 0;
      if (state.compactAfter) dropped.compacts++;
      for (const turn of state.queue) turn.scheduled?.settle({ status: 'interrupted', by: 'shutdown' });
      state.queue.length = 0;
      // A waiting /compact and input held by /compact or /new go without a word now; collectLost kept them, and their
      // senders hear once the bot is back (s18c). The input also comes back in the next back-fill as context only.
      state.compactAfter = undefined;
      state.deferred?.splice(0);
      try { state.interrupt?.(); }
      catch (error) { shutdownErrors.add(error); }
    }
    if (dropped.queued || dropped.held || dropped.compacts) log.info('bridge', 'shutdown_dropped', dropped);
    startCleanup(() => sessionTitles.shutdown());
    startCleanup(() => judge.shutdown());
    // Abort results finish in microtasks; persist them without waiting for backend cleanup.
    if (judgeUsage) startCleanup(async () => {
      await new Promise<void>(resolve => setImmediate(resolve));
      await judgeUsage.close();
    });
    const live = [...new Set(sessions.values())];
    sessions.clear();
    // Interrupted above, closed once the turns ended or the grace is over: an agent that ends its turn itself also
    // stops the commands it started, which the process group kill may not reach.
    const graceOver = settleWithin(interruptGraceMs, false).then(ended => {
      if (!ended) log.info('bridge', 'shutdown_grace_over', { runs: runTasks.size, graceMs: interruptGraceMs });
    });
    startCleanup(async () => { await graceOver; await closeOwnedProviderProcesses(); });
    startCleanup(async () => { await graceOver; await shutdownResidentClients(); });
    for (const thread of live) startCleanup(async () => { await graceOver; await thread.close(); });
    const cleanupResults = Promise.allSettled(cleanup);
    shutdownPromise = (async () => {
      // The cards of the cut-short turns get what is left of the drain; a Feishu call without an answer is not waited out.
      if (!await settleWithin(shutdownDrainMs, true)) {
        log.warn('bridge', 'shutdown_drain_cut', { runs: runTasks.size, tasks: acceptedTasks.size, limitMs: shutdownDrainMs });
      }
      keepCutShort();
      for (const result of await cleanupResults) if (result.status === 'rejected') shutdownErrors.add(result.reason);
      // Whatever the drain left unsettled (a run never launched, input /new held): the scheduler waits on none of it.
      for (const hook of scheduledHooks) hook.settle({ status: 'interrupted', by: 'shutdown' });
      log.info('bridge', 'shutdown', { closed: live.length });
      if (shutdownErrors.size) throw new AggregateError(shutdownErrors, 'Bridge orchestrator cleanup failed');
    })();
    return shutdownPromise;
  }

  // Recover only ledger rows created by this feature. v1/v2 sessions migrate
  // with an empty ledger, so startup never backfills legacy/manual sessions.
  sessionTitles.startRecovery();

  // 启动预热：daemon 首个新话题原本恒吃一次 model/list 冷 spawn（独立 app-server
  // ~150–300ms），启动是空闲期，提前付掉。成功时只填 backend 内部缓存，后续
  // listModels() 零成本；失败时 backend 返回 STATIC_MODELS 兜底但不写缓存——
  // 首次真实调用会自动重试，fallback 绝不被钉死（listModels 包装层也不缓存）。
  void trackTask(backend.listModels().catch((err) => log.fail('agent', err, { phase: 'models-prewarm' })));

  /** The removal's steps after the list is written (dm-agent 3.3): the door is shut already; each failure here is only logged. */
  async function endDmOf(openId: string): Promise<void> {
    await Promise.all([
      closeDmChatsOf(openId),
      options?.authoring?.adminRemoved(openId).catch(() => log.warn('project', 'draft-admin-removal-failed')),
    ]);
  }
  async function closeDmChatsOf(openId: string): Promise<void> {
    const chats = new Set(dmChatsOf.get(openId));
    dmChatsOf.delete(openId);
    // The files only add what this process has not seen: one that cannot be read must not keep a running turn alive.
    const orLogged = <T,>(read: Promise<T>, fallback: T): Promise<T> => read.catch((error: unknown) => { log.fail('project', error, { phase: 'dm-close' }); return fallback; });
    const people = (await orLogged(dmProject(), undefined))?.dm?.people ?? {};
    for (const [chatId, person] of Object.entries(people)) if (person.openId === openId) chats.add(chatId);
    const pauseTasks = (): Promise<void> => pauseDmTasks(openId, chats).catch((error: unknown) => log.fail('schedule', error, { phase: 'admin-removed' }));
    if (!chats.size) return pauseTasks();
    const records = await orLogged(listSessions(), []);
    for (const chatId of chats) {
      entries?.revokeChat(chatId);
      const keys = new Set([chatId, ...records.filter(rec => rec.chatId === chatId).map(rec => rec.threadId),
        ...[...active].flatMap(([key, state]) => state.chatId === chatId ? [key] : [])]);
      for (const key of keys) {
        const state = active.get(key);
        if (state) {
          // The queue goes first: a stop only ends the turn. Nothing is asked again, the person has no door to send it to.
          askAgain(state.queue.splice(0), chatId, key === chatId ? 'main' : 'topic', 'queue-dropped', '会话被停下了', 'occupied');
          dropCompact(state);
          cancelIntake(state);
          state.interrupt?.();
          state.evicted = true;
        }
        const live = sessions.get(key);
        if (live) {
          sessions.delete(key);
          void trackTask(live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
        }
      }
      log.info('console', 'dm-closed', { chat: chatId.slice(-6), keys: keys.size });
    }
    await pauseTasks();
  }
  /** A removed admin's private-chat tasks pause (dm-agent 3.3): those in their chats and those they made in another's. A group's stay, they are the group's. */
  async function pauseDmTasks(openId: string, chats: ReadonlySet<string>): Promise<void> {
    await loadStore();
    const theirs = (task: StoredTask): boolean => task.state === 'active'
      && (chats.has(task.chatId) || (task.createdBy.openId === openId && scheduleChat(task.chatId)?.kind === 'dm'));
    if (!scheduleStore.all().some(theirs)) return;
    await scheduleStore.mutateConfig((tasks, touch) => {
      for (const task of tasks) {
        if (!theirs(task)) continue;
        task.state = 'paused';
        task.pausedReason = 'admin-removed';
        touch(task);
      }
    });
  }
  const personNames = createPersonNames(channel);
  const settings = createSettingsOwner({ personNames, adminRemoved: endDmOf, responseRoster: (chatId) => orStop(readResponseRoster(channel, roster, chatId), { state: 'unavailable', entries: [], otherBots: false }), cfg, backendFor, evictLiveSessionsForChat, writePreferences, voiceAction: voice.action, refreshCompletionReminders: refreshCompletionReminderCards });
  const executeAdminWrite = createAdminWriteExecutor({ cfg, backendFor, evictLiveSessionsForChat, writePreferences, voiceAction: voice.action, settings });
  const adminExecute = async (op: AdminWriteOp): Promise<AdminWriteResult> => {
    const result = await executeAdminWrite(op);
    if (op.kind === 'setCompletionReminder') refreshCompletionReminderCards();
    return result;
  };

  /**
   * The host changed a library project's workspace (admin/library.ts): this bot's rows of it take the new folders and
   * their groups' sessions are archived the way `editProject` always did: the next turn opens a new session. A group
   * is held for the moment, so a message arriving meanwhile is not answered into the old workspace.
   */
  const libraryExecute = async (op: AdminLibraryOp): Promise<unknown> => {
    const mine = (await listProjects()).filter(row => row.projectId === op.projectId);
    if (op.kind === 'libraryWorkspaceCheck') {
      const busy = mine.some(row => runningIn(row.chatId) || projectMutations.has(row.chatId) || intakeChats.has(row.chatId) || pendingTopics.has(row.chatId));
      if (busy) for (const row of mine) holdFiring(row.chatId, FIRING_HOLD_MS);
      return { busy };
    }
    const held = mine.map(row => row.chatId).filter(chatId => !projectMutations.has(chatId));
    for (const chatId of held) projectMutations.add(chatId);
    try {
      return await mirrorProjectIntoBot(cfg.accounts.app.id, op.projectId, async (chatId, commit) => {
        const result = await detachSessionsForChat(chatId, commit);
        expireRetries(retry => retry.chatId === chatId); // its sessions start over
        await evictLiveSessionsForChat(chatId);
        return result;
      });
    } finally { for (const chatId of held) projectMutations.delete(chatId); }
  };

  // ── scheduled runs (T2, 总设计第 7 节) ─────────────────────────────
  /** Runs not settled yet. A shutdown settles what its drain left; nothing in the drain waits on their promises. */
  const scheduledHooks = new Set<ScheduledHook>();
  const SCHEDULE_UPDATING: ScheduledOutcome = { status: 'skipped', reason: 'updating' };
  const scheduleStopped = (): ScheduledOutcome => ({ status: 'interrupted', by: shuttingDown ? 'shutdown' : 'user' });
  /** A scheduled turn still in intake when its session's intake was cancelled: settled as the turns queued were when a
   * settings change's eviction dropped them (launchRun), else as a ⏹'s or the shutdown's. */
  const intakeStopped = (state: ActiveState): ScheduledOutcome => (state.evictedDrop ? SCHEDULE_UPDATING : scheduleStopped());
  /** Where a scheduled turn's cards and messages go instead of its synthetic message; '' is a new main-area message. */
  const landingOf = (hook: ScheduledHook): string => (hook.target.kind === 'topic' ? hook.target.anchor : '');
  const ranFor = (hook: ScheduledHook): number => Math.max(0, Date.now() - (hook.job.task.inflight?.startedAt ?? Date.now()));
  /** The run card's Feishu link, made as outbound-files makes one; 3 seconds at most, and none when that fails or a
   * shutdown starts meanwhile (the scheduler's drain is 5 seconds). */
  async function scheduledLink(chatId: string, messageId: string): Promise<string | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await orStop(Promise.race([
        channel.rawClient.im.v1.message.get({ path: { message_id: messageId } }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('message.get timed out')), 3_000); }),
      ]).then(result => {
        const item = result.data?.items?.find(m => m.message_id === messageId);
        return item && !item.deleted ? messageLink(item, chatId) : undefined;
      }), undefined);
    } catch (err) {
      log.fail('schedule', err, { phase: 'result-link' });
      return undefined;
    } finally { clearTimeout(timer); }
  }
  /** A request that never got through: failing so before any card is sent does not count toward auto-pause (总设计第 8 节). */
  const UNREACHABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED']);
  function scheduleFailed(hook: ScheduledHook, err: unknown): ScheduledOutcome {
    const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
    const error = err instanceof Error ? err.message : String(err);
    return { status: 'failed', error, durationMs: ranFor(hook), counts: !UNREACHABLE.has(String(e?.code ?? e?.cause?.code)) };
  }
  /** A queued scheduled turn dropped with its queue, by askAgain's `why`: a turn ahead that failed or died is a failure,
   * a stop the user's or the shutdown's. */
  function droppedScheduled(why: string): ScheduledOutcome {
    if (why === 'run-failed') return { status: 'failed', error: '前一轮出错', durationMs: 0, counts: true };
    return why === 'occupied' ? SCHEDULE_UPDATING : scheduleStopped();
  }
  /** Settles the scheduled run `extra` carries: true when there is one, and then the caller says nothing in the group. */
  function dropScheduled(extra: Pick<TurnExtra, 'scheduled'> | undefined, outcome: ScheduledOutcome): boolean {
    extra?.scheduled?.settle(outcome);
    return Boolean(extra?.scheduled);
  }
  /** nextRunAfterFailure on the task in the store now, not as it was claimed; a deleted task has no next run. */
  function scheduledNextRun(job: ScheduledJob): boolean {
    const task = scheduleStore.get(job.task.id);
    return task !== undefined && nextRunAfterFailure({ ...job, task });
  }
  /** How a scheduled turn that ran ended: its card's terminal, and whether the final card update landed. A stop by its own
   * ask coordinator's fault is neither the user's nor the shutdown's: a counted failure. A failure of a turn whose session
   * had gone as its events ended (`gone`) is not one (launchRun's settleGone): the shutdown's, or skipped for the settings
   * change that closed it. */
  function ranScheduled(hook: ScheduledHook, rs: RunState, delivered: boolean, askFaulted: boolean, gone: 'shutdown' | 'evicted' | undefined): ScheduledOutcome {
    if (rs.terminal === 'interrupted' && !askFaulted) return scheduleStopped();
    const error = rs.terminal === 'interrupted' ? '提问出错' : failureText(rs) ?? (delivered ? undefined : '结果卡片没有更新成功');
    if (error && gone === 'shutdown') return scheduleStopped();
    if (error) return gone === 'evicted' ? SCHEDULE_UPDATING : { status: 'failed', error, durationMs: ranFor(hook), counts: true };
    return { status: 'done', excerpt: clampUnits(finalMessageText(rs), 500), durationMs: ranFor(hook) };
  }

  /**
   * The scheduler's runner: places one run as the group's session mode says (总设计 7.1), starts it, and resolves once
   * it is settled. The placement work is tracked, so a shutdown's drain sees the run it starts; the result is not.
   */
  async function runScheduled(job: ScheduledJob): Promise<ScheduledOutcome> {
    if (shuttingDown) return { status: 'interrupted', by: 'shutdown' };
    let resolve!: (outcome: ScheduledOutcome) => void;
    const result = new Promise<ScheduledOutcome>(r => { resolve = r; });
    let card: { messageId?: string; topicId?: string } = {};
    const hook: ScheduledHook = {
      job, target: { kind: 'main' },
      started: (info) => { card = { ...card, ...info }; },
      // Every drop path settles, a few of them after another already did: the first call counts.
      settle: (outcome) => {
        if (!scheduledHooks.delete(hook)) return;
        if (outcome.status === 'skipped') return resolve(outcome);
        // Once a card is out, Feishu was there: a failure counts.
        const settled: ScheduledOutcome = { ...card, ...outcome, ...(outcome.status === 'failed' && card.messageId ? { counts: true } : {}) };
        // The record links the card (T2 4.1 第 5 条); a stopping bot does not wait on Feishu for it.
        if (!card.messageId || shuttingDown) return resolve(settled);
        void scheduledLink(job.task.chatId, card.messageId).then(link => resolve(link ? { ...settled, link } : settled));
      },
    };
    scheduledHooks.add(hook);
    // Counted as a message's intake until the run holds its session (handleTurn) or topic (pendingTopics).
    await trackTask(duringIntake(job.task.chatId, () => placeScheduled(hook))).catch((err) => {
      log.fail('schedule', err, { phase: 'run', taskId: job.task.id });
      hook.settle(scheduleFailed(hook, err));
    });
    return result;
  }

  async function placeScheduled(hook: ScheduledHook): Promise<void> {
    const { task } = hook.job;
    const chatId = task.chatId;
    const placed = await getProjectByChatId(chatId);
    if (refusedTurn(placed, chatId, { scheduled: hook }) || !placed) return;
    let topicId: string | undefined;
    let fallback = false;
    if (task.placement.kind === 'topic') {
      const key = task.placement.topicId;
      // The topic's latest message is the anchor; a topic or session gone sends this run where the group would.
      const anchor = await getSession(key).then(rec => (rec && !rec.detached ? desktopTopicReply(chatId, key) : undefined))
        .catch((err) => { log.warn('schedule', 'topic-gone', { taskId: task.id, err: String(err) }); return undefined; });
      if (anchor) {
        hook.target = { kind: 'topic', anchor };
        topicId = key;
      } else fallback = true;
    }
    // A private chat opens no topic for a run (dm-agent 8): its main area's one session, whatever the task says.
    const newTopic = !topicId && !placed.dm && (task.placement.kind === 'newTopic' || ruleKind(placed) === 'multi' || await orStop(topicCtx.noMainArea(chatId), false));
    // Unbound, disabled or edited while Feishu and the disk answered: the run uses none of what it read (T2 4.2).
    const project = await getProjectByChatId(chatId);
    if (refusedTurn(project, chatId, { scheduled: hook }) || !project || projectSettingsRevision(project) !== projectSettingsRevision(placed)) return void hook.settle(SCHEDULE_UPDATING);
    if (shuttingDown) return void hook.settle({ status: 'interrupted', by: 'shutdown' });
    if (newTopic) return startScheduledTopic(hook, project, fallback);
    const text = scheduledHeader(hook.job, hostTimeZone(), fallback);
    // A group's run has no sender. A private chat's has its person's rights, read off the turn (dm-agent 6.3).
    const sender = project.dm ? { senderId: dmRunner(task, project), ...(task.createdBy.name ? { senderName: task.createdBy.name } : {}) } : { senderId: '' };
    const msg: NormalizedMessage = {
      messageId: `vsched_${task.id}_${hook.job.slot}`, chatId, chatType: project.dm ? 'p2p' : 'group', ...sender, content: text, rawContentType: 'text',
      resources: [], mentions: [], mentionAll: false, mentionedBot: false, createTime: Date.now(), ...(topicId ? { threadId: topicId } : {}),
    };
    await handleTurn(msg, text, topicId ?? chatId, !topicId, project, turnPerm(project), { scheduled: hook, queueOnly: true, summary: `定时任务「${plainTaskName(task.name)}」` });
  }

  /**
   * A scheduled run in a new hidden session (总设计 7.1"开新话题"): a topic opens only on a real message, so a text root
   * goes to the main area first and the card replies in thread under it. Not startTopicDirectly: that one reacts to,
   * ingests and pulls before a message a person sent.
   */
  function startScheduledTopic(hook: ScheduledHook, project: Project, fallback: boolean): void {
    const { job } = hook;
    const chatId = project.chatId;
    pendingTopics.set(chatId, (pendingTopics.get(chatId) ?? 0) + 1);
    void trackTask((async () => {
      let starting: Promise<AgentThread> | undefined;
      let launched = false;
      try {
        const be = groupBackend(project);
        const prefer = modelPrefOf(project, be.id);
        const cwd = workCwd(project);
        const perm = turnPerm(project);
        // A text message's `<at>` is a real mention: scheduledRootText leaves no tag in the task's name.
        const rootText = scheduledRootText(job);
        const root = await channel.send(chatId, { text: rootText });
        const rootAt = Date.now();
        recent.addOwn(chatId, chatId, { id: root.messageId, at: rootAt, text: rootText });
        hook.target = { kind: 'topic', anchor: root.messageId };
        const { model, effort } = await pickGroupDefault(project, be, prefer);
        starting = profileOf(project, cwd, be, perm.mode).then(profile => startWith(be, { cwd, model, effort, serviceTier: 'standard', ...perm, profile }, sessionPlace(project, chatId)));
        const listP = topics ? topics.list(chatId) : Promise.resolve([]);
        const [thread, section] = await Promise.all([starting,
          Promise.all([pullMainBefore(chatId, rootAt, root.messageId), listP]).then(([pull, list]) => mainSection(chatId, pull, list, rootAt, undefined))]);
        const titleSource: SessionTitleSource = { text: `定时任务「${job.task.name}」`, rawContentType: 'text' };
        const titleJobKey = await registerSessionTitle(be, thread.sessionId, cwd, titleSource);
        const current = await getProjectByChatId(chatId);
        if (refusedTurn(current, chatId, { scheduled: hook }) || projectSettingsRevision(current!) !== projectSettingsRevision(project)) {
          hook.settle(SCHEDULE_UPDATING);
          return;
        }
        // The topic's usual opening (the main area before it), then the task (总设计 7.2).
        const firstText = weaveTurnRecordBlock(scheduledOpening(job, hostTimeZone(), fallback), undefined, {
          place: { group: project.name, me: channel.botIdentity?.name, topic: { title: job.task.name } }, entries: [], now: rootAt,
          opening: { pointer: { botOpened: true, root: { at: rootAt, who: { kind: 'self' } } }, main: section.main },
          quotes: section.quotes, moreTopics: section.moreTopics,
        });
        launched = true;
        await trackRun(launchRun({
          chatId, replyTo: root.messageId, replyInThread: true, thread, firstText, model, effort, serviceTier: 'standard',
          modelCustom: isCustomDefault(prefer, model), cwd, ...perm, summary: `定时任务「${plainTaskName(job.task.name)}」`, requesterKind: 'unknown',
          requestedAt: rootAt, seenAt: rootAt, from: section.main[0]?.createTime || rootAt,
          openTopic: { id: root.messageId, from: { kind: 'self' }, at: rootAt, text: rootText },
          smart: sessionModeOf(project) === 'smart' ? true : undefined, backendId: be.id, titleJobKey, titleSource, scheduled: hook,
        }));
      } catch (err) {
        log.fail('schedule', err, { phase: 'start-topic', taskId: job.task.id });
        // Stopping (its client pool closed as the thread started): the shutdown's, not the run's failure, as in launchRun.
        if (shuttingDown) {
          hook.settle(scheduleStopped());
          return;
        }
        hook.settle(scheduleFailed(hook, err));
        if (hook.target.kind === 'topic') await channel.send(chatId, { markdown: `❌ 启动失败：${err instanceof Error ? err.message : String(err)}` },
          { replyTo: hook.target.anchor, replyInThread: true }).catch(() => undefined);
      } finally {
        if (!launched) await starting?.then(thread => thread.close()).catch(error => log.fail('agent', error, { phase: 'unadopted-thread-close' }));
        const remaining = (pendingTopics.get(chatId) ?? 1) - 1;
        if (remaining) pendingTopics.set(chatId, remaining); else pendingTopics.delete(chatId);
      }
    })());
  }

  /**
   * Scheduled tasks (bot/schedule): this process is the only writer of schedules.json, and schedule-commands the only
   * entry that changes it for a user. The file is read once: in initialize(), before the bridge takes events, or at the
   * first request of a harness that never calls it. The tick is not started here: bridge.ts does, once connected.
   */
  const scheduleDiagnostic = ({ kind, ...fields }: ScheduleDiagnosticEvent): void => log.info('schedule', kind, fields);
  const scheduleStore = createScheduleStore(botPaths(cfg.accounts.app.id).schedulesFile, { now: () => Date.now(), log, diagnostics: scheduleDiagnostic });
  const scheduler = createScheduler({
    store: scheduleStore, now: () => Date.now(), timers: { setTimeout, clearTimeout },
    run: async job => {
      if (scheduleStore.get(job.task.id)?.revision !== job.task.revision) return SCHEDULE_UPDATING;
      return runScheduled(job);
    },
    gate: scheduleGate, notifyAutoPause, notifyGateFailure,
    // Half the run slots at most, so people always find one (总设计第 15 节第 8 条).
    maxInflight: () => Math.max(1, Math.floor(getMaxConcurrentRuns(cfg) / 2)),
    log, diagnostics: scheduleDiagnostic,
  });
  /** What a chat is to this Bot, for the task commands. The private-chat row's own id (`oc_dm_…`) is nowhere to post. An unreadable project file reads as no chat: the view must not throw. */
  function scheduleChat(chatId: string): { kind: 'dm'; name?: string } | { kind: 'group' } | undefined {
    let project: Project | undefined;
    try { project = getProjectByChatIdSync(chatId); }
    catch (error) { log.fail('schedule', error, { phase: 'chat-of' }); return undefined; }
    if (!project?.dm) return project && { kind: 'group' };
    const person = dmPersonOf(project, chatId);
    const name = person && (person.name ?? names.peek(person.openId));
    return person && { kind: 'dm', ...(name ? { name } : {}) };
  }
  const scheduleCommands = createScheduleCommands({ store: scheduleStore, scheduler, botId: cfg.accounts.app.id, now: () => Date.now(), hostTimeZone, chatOf: scheduleChat });
  let storeLoaded: ReturnType<typeof scheduleStore.load> | undefined;
  const loadStore = (): ReturnType<typeof scheduleStore.load> => (storeLoaded ??= scheduleStore.load());
  const scheduleAs = async (actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply> => {
    await loadStore();
    return scheduleCommands.execute(actor, request);
  };
  /** Not admit: a stopping bot did nothing, so it says so as a refusal, not as a rejection the terminal reads as a result not known. */
  const admittedScheduleAs = (actor: ScheduleActor, request: ScheduleRequest): Promise<ScheduleReply> => (
    shuttingDown ? Promise.resolve(botNotRunning()) : trackTask(scheduleAs(actor, request))
  );

  const admittedCollaboration = admit(collaboration);
  /** s36d1: creations skip admit, whose shutdown refusal would read as a result not known; serialCreate refuses
   * them instead, saying nothing was created. The drain waits for one in flight, but how it ended is its caller's
   * answer, not a cleanup failure. */
  function collaborate(request: CollaborationRequest): Promise<unknown> {
    if (request.action !== 'createProject') return admittedCollaboration(request);
    const result = collaboration(request);
    void trackTask(result.catch(() => undefined));
    return result;
  }
  return {
    initialize: async () => {
      // A failure leaves the list as it is and the next start tries again.
      await upgradeAdmins(cfg, writePreferences).catch(error => log.fail('setup', error, { phase: 'admins-upgrade' }));
      const result = await materializeGroupSettings({ cfg, backendFor });
      if (result.updated.length || result.deferred.length) log.info('settings', 'group-settings-materialized', { updated: result.updated.length, deferred: result.deferred.length });
      // The host prepares old/stopped Bots too. This also covers new registrations and a standalone Bot process.
      if (options?.bot) dmReady = trackTask(ensureDmProject({ bot: options.bot, projectsRootDir: cfg.preferences?.projectsRootDir, defaults: async () => storedDmDefaults(cfg.preferences) }));
      await dmReady;
      const cardDisplayRows=await materializeCardDisplaySettings({legacy:cfg.preferences?.cardDisplay,defaults:cardDisplayPresentationDefaults(cfg)});
      if (cardDisplayRows) log.info('card','display-settings-materialized',{count:cardDisplayRows});
      // An unreadable file keeps the bot from starting; a corrupt one is moved aside and the store starts empty.
      await loadStore();
    },
    collaboration: collaborate,
    onMessage: admitEvent(onMessage),
    onComment: admitEvent(onComment),
    onBotAddedToChat: admitEvent(onBotAddedToChat),
    onBotRemovedFromChat: admitEvent(onBotRemovedFromChat),
    onReaction: admitEvent(onReaction),
    onBotMenu: admitEvent(onBotMenu),
    onRecall: admitEvent(onRecall),
    dispatcher,
    adminExecute: admit(adminExecute),
    writePreferences,
    libraryExecute: admit(libraryExecute),
    settings: { read: admit(settings.read), save: admit(settings.save), models: admit(settings.models), act: admit(settings.act) },
    scheduleAs: admittedScheduleAs,
    permissionOf: async chatId => {
      const project = await getProjectByChatId(chatId);
      return project ? execOf(project).permission : undefined;
    },
    scheduler: { start: async () => scheduler.start(await loadStore()), stop: () => scheduler.stop(), drain: ms => scheduler.drain(ms) },
    shutdown,
    // A crash before the shutdown also keeps the people's turns in flight: no card of theirs will say anything. One during
    // the shutdown keeps the cut-short turns whose cards had not said so yet; the shutdown already saved the rest.
    saveDroppedSync: (why: 'shutdown' | 'crash') => {
      if (shuttingDown) keepCutShort();
      else droppedReplies?.saveSync(oncePerMessage([...collectLost(), ...inFlightTurns()]), why);
    },
    replyDropped: () => { if (!shuttingDown) droppedReplies?.start(); },
  };
}

/** Resolve a message's thread_id via raw API (reply response omits it). The
 * lookup can lag right after the reply, and a single API blip used to leave the
 * run stranded on its `pending:` key（双开 + 孤儿进程，F8）——binding-critical
 * callers pass `attempts` > 1 to retry (500ms apart) before giving up.
 * Exported for tests. */
export async function getThreadId(
  channel: LarkChannel,
  messageId: string,
  attempts = 1,
): Promise<string | undefined> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await channel.rawClient.im.v1.message.get({ path: { message_id: messageId } });
      const items = (res.data as { items?: { thread_id?: string }[] } | undefined)?.items;
      const tid = items?.[0]?.thread_id;
      if (tid) return tid;
      log.warn('intake', 'threadid-missing', { messageId, attempt });
    } catch (err) {
      log.warn('intake', 'threadid-lookup-failed', { messageId, attempt, err: String(err) });
    }
  }
  return undefined;
}
