import { createPendingGroups, pendingGroupsFile } from '../project/pending-groups';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { projectRevision, projectView, type CollaborationRequest } from '../admin/collaboration';
import { AdminWriteError } from '../admin/ops';
import { createSettingsOwner } from '../admin/settings';
import type { HostSettings } from '../admin/settings-types';
import type { AdminWriteResult } from '../admin/ops';
import { registerVoiceConsole } from './voice-console';
import { createVoiceService } from '../voice/service';
import { ingestVoice, createIntakeQueue, type IngestedContext } from '../voice/inbound';
import type { VoiceReply } from '../voice/types';
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
import { DEFAULT_BACKEND_ID, backendIds, createBackend, isBackendEntryInstalled } from '../agent';
import { BackendNotInstalledError } from '../agent/backend-loader';
import { CodexFullOnlyError, fullOnlyReply } from '../agent/codex-appserver/full-only';
import { errorKindFromText, type AgentErrorKind } from '../agent/error-kind';
import { scopeDenial } from '../utils/feishu-error';
import type { NotReplied, NotRepliedReason } from '@vonvon/protocol';
import { deniedScopeName, errorDetail, reportNotReplied, reportScopeDenied } from './diagnostics';
import { createDroppedReplies, originOf, type DroppedOrigin } from './restart-dropped';
import { catalogById, projectCreatableBackends, visibleCatalog } from '../agent/catalog';
import {
  DEFAULT_PERMISSION_MODE,
  REASONING_EFFORTS,
  type AgentBackend,
  type AgentInput,
  type AgentRun,
  type AgentThread,
  type ModelInfo,
  type PermissionMode,
  type ReasoningEffort,
  type ThreadHistory,
  type ThreadSummary,
} from '../agent/types';
import type { SelectOption } from '../card/cards';
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
import { isGoalTerminal, SessionInUseError, UsageError } from '../agent/types';
import { parseModelId } from '../agent/model-id';
import {
  getMaxConcurrentRuns,
  getPendingPolicy,
  getModelDisplay,
  getRunIdleTimeoutMs,
  getSessionTitleConfig,
  getSessionTitleEfforts,
  getShowToolCalls,
  getCommentsConfig,
  getCompletionReminderConfig,
  shouldShowCompletionReminderButton,
  isAdmin,
  isChatAllowed,
  isUserAllowedInProject,
  normalizeRunIdleTimeoutSeconds,
  resolveOwner,
  COMPLETION_REMINDER_LONG_TASK_MAX_MINUTES,
  COMPLETION_REMINDER_LONG_TASK_MIN_MINUTES,
  secretKeyForApp,
  type AppAccess,
  type AppConfig,
  type AppPreferences,
  type CommentsConfig,
  type CompletionReminderMode,
  type PendingPolicy,
  type SessionTitleBackendConfig,
} from '../config/schema';
import { CardDispatcher, type CardActionHandler } from '../card/dispatcher';
import { closeOwnedCodexProcesses } from '../agent/codex-appserver/owned-process';
import { shutdownResidentClients } from '../agent/codex-appserver/client-pool';
import { sendManagedCard, updateManagedCard } from '../card/managed';
import { RunRender } from '../card/run-render';
import { finalMessageText, initialState, reduce, type RunState } from '../card/run-state';
import {
  buildClearedCard,
  buildHelpCard,
  buildModelCard,
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
  buildRunCardPlain,
  CONTROLS_EID,
  RC,
  attachRunImages,
  idleLabel,
  type RunCardState,
} from '../card/run-card';
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
  buildAddAdminCard,
  buildAddAllowedCard,
  buildAdminsCard,
  buildCommentPromptCard,
  buildCommentSettingsCard,
  buildAllowlistCard,
  buildDmMenuCard,
  buildDoctorCard,
  buildGroupSettingsCard,
  buildJoinGroupFormCard,
  parseNoMentionPick,
  buildModelDefaultCard,
  parseModelDefaultFormValue,
  buildNewProjectDoneCard,
  buildNewProjectFormCard,
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
import { getDesktopRelease } from '../service/desktop-release';
import { runtimeDistribution } from '../service/distribution';
import { paths } from '../config/paths';
import { loadBots } from '../config/bots';
import { fileClaimMode, OutboundFiles } from './outbound-files';
import { getSecret } from '../config/keystore';
import { buildScopeGrantUrl, JOIN_GROUP_SCOPES } from '../config/scopes';
import { validateAppCredentials } from '../utils/feishu-auth';
import {
  effectiveMode,
  getProjectByChatId,
  getProjectByName,
  listProjects,
  noMentionOf,
  pendingPolicyOf,
  ruleKind,
  mutateProject,
  removeProject,
  updateProject,
  type Project,
} from '../project/registry';
import { bindModeFor, createProject, joinExistingGroup } from '../project/lifecycle';
export { bindModeFor } from '../project/lifecycle';
import { refreshBranch } from '../project/announcement';
import { leaveChat, transferOwnership } from '../project/group-ops';
import {
  addRecall,
  backfillFrom,
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
import { audienceOf, fromBot, quotedId } from './baselines';
import {
  sessionTitleSourceFromMessage,
  stripBridgeMessageEnvelope,
  type SessionTitleSource,
} from './session-title';
import { handleDmConsole } from './dm-console';
import { createSyncCopyGate } from './sync-copy';
import { fetchInteractiveCardText, isDegradedCardContent } from './card-content';
import {
  collectInboundFiles,
  collectInboundImages,
  messageHasFiles,
  messageHasImages,
  stripFileTokens,
  weaveFileManifest,
} from './media';
import {
  BACKFILL_MAX,
  OPENING_MAIN_MAX,
  STREAMING_RECHECK_MS,
  fetchChatContext,
  fetchMessageMeta,
  fetchTopicLastBot,
  fetchQuotedMessage,
  fetchThreadContext,
  keepRecent,
  OPENING_MAX,
  weaveQuote,
  weaveRecordBlock,
  weaveSender,
  type ContextMessage,
  type PullOpts,
  type RecordBlock,
  type ThreadPull,
  type Who,
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
  stripMarkdown,
  SUPPORTED_FILE_TYPES,
  syncCommentInstructions,
} from './comments';
import { createGracefulInterrupt, createIdlePause, Semaphore, withIdleTimeout, type IdlePause } from './watchdog';
import { createNameBook, fetchChatMembers, resolveNames, withDeadline } from './names';

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

/** Narrow an arbitrary string to a PermissionMode, else undefined. */
function asTier(v: string | undefined): PermissionMode | undefined {
  return v === 'qa' || v === 'write' || v === 'full' ? v : undefined;
}

/** Narrow an arbitrary string to a ReasoningEffort, else undefined. */
function asEffort(v: string | undefined): ReasoningEffort | undefined {
  return v !== undefined && (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : undefined;
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

/** Whether `model` is the project's hand-typed default (3.11): a session started
 * on it records `modelCustom`, so the /model card and the web keep showing it as
 * hand-typed after the project default changes. */
function isCustomDefault(project: Pick<Project, 'defaultModel' | 'defaultModelCustom'> | undefined, model: string | undefined): boolean {
  return Boolean(model && project?.defaultModelCustom && project.defaultModel === model);
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
  voice?: VoiceReply;
  input: AgentInput;
  /** Un-woven SDK message source used only if this becomes the first accepted
   * host turn. Never recover a title from AgentInput.text. */
  titleSource: SessionTitleSource;
  requesterOpenId?: string;
  requestedAt: number;
  /** Clean user-authored label; never derive reminder copy from woven input. */
  summary?: string;
  /** Set on a 🔁 重试 turn: the original input it wraps (see {@link retryPrompt}). */
  replayText?: string;
  /** The inbound message, marked seen once the host accepts its turn
   * (turn_started), never when it is queued or dequeued: a dropped queue or a
   * refused turn/start must leave it for the next back-fill. */
  seen?: SeenMark;
  /** How {@link seen} moves the watermark (session-store.nextSeen); 'id' when unset. */
  seenHow?: SeenHow;
  /** Other bots' cards its record block wove while they were still streaming (SessionRecord.streaming). */
  streaming?: SeenMark[];
  /** Ids of the messages its record block carried (see ActiveState.woven). */
  woven?: string[];
  /** The topics its record block quoted, marked seen with {@link seen} so each is quoted once. */
  seenExtra?: SeenMark[];
  /** Its record block carried the recent topics (SessionRecord.topicsDue), cleared once it starts. */
  tableShown?: boolean;
  /** The recall notes its block said (SessionRecord.recalls), dropped once it starts (s15). */
  recallsShown?: string[];
  /** An opening turn's oldest line, written as SessionRecord.from once it starts (s15). */
  from?: number;
  /** The message's place, for the reply asking to send it again when a shutdown drops it (s18c). */
  origin?: DroppedOrigin;
}

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
  state: { requesterOpenId?: string; completionReminderRequested?: boolean },
  turn: QueuedTurn,
): void {
  state.requesterOpenId = turn.requesterOpenId;
  state.completionReminderRequested = false;
}

/** Only the exact turn initiator may opt that turn into the manual reminder. */
export function isCompletionReminderRequester(operatorOpenId?: string, requesterOpenId?: string): boolean {
  return Boolean(operatorOpenId && requesterOpenId && operatorOpenId === requesterOpenId);
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
  if (input.interrupted) render.interrupt();
  else if (input.timedOut) render.timeout(input.idleTimeoutSeconds);
  else if (input.procDead && render.terminal() === 'running') {
    render.apply({ type: 'error', message: 'agent 进程异常退出，请重发本条消息', willRetry: false });
  } else {
    // finalize() is a no-op for explicit done/error terminals.
    render.finalize();
  }
}

/** A turn that started but did not answer: the error it threw, or the run state it ended in. */
interface TurnFailure { error?: unknown; rs?: RunState; procDead?: boolean }
/** The message a not-replied record is about. */
type NotedMessage = Pick<NormalizedMessage, 'chatId' | 'messageId' | 'senderId' | 'createTime' | 'threadId'>;

/** How long a group's full-only explanation quiets the next ones for 免@ messages; an @ always gets one. */
const FULL_ONLY_QUIET_MS = 10 * 60_000;
/** Each 三条底线 lookup's limit (s22): the group's later messages wait behind it. */
const LOOKUP_DEADLINE_MS = 3000;

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
export type RecreateReason = 'resume-failed' | 'cwd-changed';

/** The run-card line for a forced session change: never switch sessions
 * silently (product.md 3.5). A topic re-weaves its recent messages into the new
 * session; the main area has nothing to re-weave. */
export function sessionChangeNotice(reason: RecreateReason, topic: boolean): string {
  const why = reason === 'cwd-changed' ? '本群的工作目录改了' : '原来的会话接不上了（恢复失败）';
  const carried = topic ? '，话题里最近的消息已重新带上' : '';
  return `⚠️ ${why}，这一轮起换了一条新会话，之前的对话记不得${carried}。`;
}

interface ActiveState {
  steerReply?: { run: AgentRun; accept: (messageId: string, voice?: VoiceReply) => boolean };
  /** Captured with the steer target so a late ACK cannot decorate another turn. */
  voiceReply?: { run: AgentRun; add: (voice: VoiceReply) => void };
  /** Prevent a late ASR result from restarting a stopped conversation. */
  intakeCancelled?: boolean;
  /** unset only during the brief "reserved, still resolving the thread" window */
  thread?: AgentThread;
  run?: AgentRun;
  /** follow-up turns queued mid-run; each carries its own text + downloaded images */
  queue: QueuedTurn[];
  /** who started this run — gates destructive ⏹ (design §5) */
  requesterOpenId?: string;
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
  /** A /compact sent while this run was busy: done right after the current turn (product.md 3.5). */
  compactAfter?: { msg: NormalizedMessage; inThread: boolean };
  /** A compaction runs on this session now (an idle /compact, or a queued one between turns). */
  compacting?: boolean;
  /** Set while /compact or /new holds the session with no run: input waits here and
   * goes through intake again once the command is done (s15). `early` tells one
   * sent before a /new that swapped ({@link newAt}) instead. */
  deferred?: { id: string; at?: number; go: () => void; early: () => void; origin: DroppedOrigin }[];
  /** The /new command's send time, once its swap is done: input sent before it belongs to the old session. */
  newAt?: number;
  /** The run's trigger while it waits for a global slot (acquireRunSlot), for a shutdown to keep (s18c). */
  waiting?: DroppedOrigin;
}

/** Inputs a synthetic turn (🔁 重试) carries that a real message would not. */
interface TurnExtra {
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
}

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
const UNBOUND_GROUP_REPLY = '本群还没绑定为项目。请**把我拉进群的管理员**在与我的私聊里完成绑定后再 @我。';

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
  settings: HostSettings;
  /** Close every live codex session (SIGKILLs the app-server children) so a
   *  graceful exit leaves no orphan processes. */
  shutdown: () => Promise<void>;
  /** Once connected: ask the senders of what the last shutdown dropped to send again (s18c). Not after shutdown. */
  replyDropped: () => void;
}

/**
 * The group orchestrator owns all per-bridge run state (codex threads, active
 * turns, concurrency, pending command cards) and exposes both the inbound
 * message handler and the card-action dispatcher so they share that state.
 *
 * Flow (design §3):
 *   p2p                       → DM console (never runs codex).
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

export function createOrchestrator(
  channel: LarkChannel,
  cfg: AppConfig,
  fallbackCwd: string,
  /** The topic registry (s13); without it nothing is recorded (tests). */
  topics?: TopicRegistry,
  /** `droppedFile`: where a shutdown keeps the queued messages it drops (s18c). No default: without it, nothing is
   * kept or answered (tests, and every caller but `daemon run`). */
  options?: { droppedFile?: string },
): Orchestrator {
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

  /** 会话后端是否支持 `/goal` 自治目标（codex caps undefined ⇒ true）。 */
  function goalCapable(project?: Project): boolean {
    return backendFor(project?.backend).capabilities?.goal ?? true;
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

  /** Snapshot the selected backend's title policy when its native session is
   * created. Later DM-setting changes affect future sessions only. */
  function sessionTitlePolicy(backendId: string): SessionTitlePolicySnapshot {
    const selected = getSessionTitleConfig(cfg, backendId);
    return selected.enabled
      ? { strategy: 'model', model: selected.model, effort: selected.effort }
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
        policy: sessionTitlePolicy(be.id),
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
  /** M-3 空闲 reaper 的轮次时钟：每次进 LIVE 缓存（trackSession）/ 每轮收尾
   * （touchSession）打点；空闲时长 = now − 最后打点。 */
  const sessionTouchedAt = new Map<string, number>();
  /** sessions.set + 打点 —— 所有放进 LIVE 缓存的会话一律走这里。 */
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
   */
  function releaseIdle(key: string | undefined, thread: AgentThread | undefined): void {
    if (!key || !thread?.releaseAfterRun || active.has(key) || sessions.get(key) !== thread) return;
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
  let shutdownPromise: Promise<void> | undefined;
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
  /** Who sent a message, as the topic registry records it. */
  function senderOf(msg: NormalizedMessage): TopicPerson {
    const app = (msg.raw as { sender?: { sender_type?: string } } | undefined)?.sender?.sender_type === 'app';
    return topicPerson(app ? 'bot' : 'user', msg.senderId);
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
      void withDeadline(fetchQuotedMessage(channel, firstId, names), 10_000).then((root) => {
        if (!root || shuttingDown) return;
        const rootFrom: TopicPerson = root.from === 'self' ? { kind: 'self' } : topicPerson(root.from, root.senderId);
        void trackTask(topics.note(msg.chatId, { ...sighting, first: { id: firstId, from: rootFrom, at: root.createTime || undefined, text: root.text } }));
      }).catch(fail);
    }).catch(fail));
  }
  /** This bot opened `topicId` (a reply in thread, or a resumed session's topic). */
  function noteOpenedTopic(chatId: string, topicId: string, first: TopicSighting['first']): void {
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
   * manual. Non-manual modes return undefined, so their cards have no button. */
  const completionReminderView = (state: ActiveState): 'available' | 'requested' | undefined =>
    shouldShowCompletionReminderButton(cfg)
      ? state.completionReminderRequested
        ? 'requested'
        : 'available'
      : undefined;

  /** 模型列表直通后端：两个后端内部都已缓存成功结果（codex 的 modelCache、
   * claude 的静态常量），这层不再缓存——codex 瞬时不可用时返回的 STATIC_MODELS
   * 兜底一旦缓存在这层，会被钉死整个 daemon 生命周期（backend 故意不缓存失败
   * 结果，让下次调用重试；见 codex-appserver/backend.listModels）。 */
  const listModels = (be: AgentBackend = backend): Promise<ModelInfo[]> => be.listModels();

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
    extra: { place?: NotReplied['place']; backendId?: string | undefined; detail?: string | undefined } = {}): void {
    if (recalled.has(msg.messageId)) return;
    const sender = names.peek(msg.senderId)?.slice(0, 64);
    const backend = backendTool(extra.backendId);
    reportNotReplied({
      at: msg.createTime || Date.now(), groupId: msg.chatId, place: extra.place ?? (msg.threadId ? 'topic' : 'main'), reason,
      ...(sender ? { sender } : {}), ...(backend ? { backend } : {}), ...(extra.detail ? { detail: extra.detail } : {}), ref: msg.messageId.slice(-6),
    });
  }
  /** A turn that started but did not answer; a refused scope also goes to the page's 缺的权限. */
  function noteFailure(msg: NotedMessage, place: NotReplied['place'], backendId: string | undefined, failure: TurnFailure): void {
    const { reason, detail, scope } = failureReason(failure);
    if (scope) reportScopeDenied(scope, 'send');
    noteNotReplied(msg, reason, { place, backendId, detail });
  }

  // ── inbound messages ──────────────────────────────────────────────
  const intakeChats = new Map<string, number>();
  const pendingTopics = new Map<string, number>();
  const resumePublications = new Set<string>();
  const onMessage = async (msg: NormalizedMessage): Promise<void> => {
    intakeChats.set(msg.chatId, (intakeChats.get(msg.chatId) ?? 0) + 1);
    try { await handleMessage(msg); } finally {
      const remaining = (intakeChats.get(msg.chatId) ?? 1) - 1;
      if (remaining) intakeChats.set(msg.chatId, remaining); else intakeChats.delete(msg.chatId);
    }
  };
  const handleMessage = async (msg: NormalizedMessage): Promise<void> => {
    if (seenInbound.seen(msg.messageId)) {
      log.info('intake', 'reject', { reason: 'duplicate', msgId: msg.messageId });
      return;
    }
    // Feishu does not keep events in order: a recall can come before its message (s15).
    if (recalledSkip(msg)) return;
    // No message text (3.5); the ids' last 6 characters match the 状态与诊断 page's 消息尾号.
    log.info('intake', 'recv', {
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
      await handleDmConsole(channel, cfg, msg);
      return;
    }

    const project = await getProjectByChatId(msg.chatId);
    // @门：没 @ 时只在「项目群 + 免@ 适用」才响应。免@默认开,但 multi 仅话题内、
    // single 整群;非项目群一律不响应非 @ 消息。Another bot's message never is (s22:
    // rule mode's bots do not see each other). Who an unnamed message is for (三条
    // 底线) is looked up below, after the cheap gates; this is what may be for it.
    const bot = fromBot(msg);
    const maybe = !bot && (msg.mentionedBot || Boolean(project && (shouldRespondWithoutMention(project, msg)
      || (noMentionOf(project) && quotedId(msg) !== undefined))));
    if (await syncCopy.skip(msg, maybe || resumePublications.has(msg.chatId))) return;
    if (resumePublications.has(msg.chatId)) {
      await channel.send(msg.chatId, { markdown: '正在恢复历史会话，请完成后重发此消息。' }, { replyTo: msg.messageId });
      return;
    }
    if (project?.enabled === false) {
      if (msg.mentionedBot && !bot) noteNotReplied(msg, 'group-disabled');
      return;
    }
    if (projectMutations.has(msg.chatId)) {
      if (!bot && (msg.mentionedBot || (project && shouldRespondWithoutMention(project, msg)))) noteNotReplied(msg, 'group-updating');
      return;
    }
    if (project && msg.threadId && isChatAllowed(cfg, msg.chatId)) noteTopicMessage(msg);
    if (!maybe) {
      if (bot && msg.mentionedBot) log.info('intake', 'reject', { reason: 'bot-sender', ref: msg.messageId.slice(-6) });
      return;
    }
    let refused: NotRepliedReason | undefined;
    if (!isChatAllowed(cfg, msg.chatId)) refused = 'chat-not-allowed';
    else if (!isUserAllowedInProject(cfg, project, msg.senderId)) refused = 'user-not-allowed';
    if (refused) {
      log.info('intake', 'reject', { reason: 'not_allowed', chatId: msg.chatId.slice(-6) });
      noteNotReplied(msg, refused);
      return;
    }
    if (project && !msg.mentionedBot && !(await forThisBot(msg, project))) return;

    // The bot is in a group not bound to any project (e.g. it was just added and
    // the admin hasn't finished binding in DM yet). Don't run codex in the
    // fallback cwd for an unbound group — only nudge toward binding when @ed.
    if (!project) {
      log.info('intake', 'unbound-group', { chatId: msg.chatId.slice(-6), atBot: msg.mentionedBot });
      if (msg.mentionedBot) {
        // It got only a hint, so the owner sees why on the page.
        noteNotReplied(msg, 'unbound');
        await channel
          .send(
            msg.chatId,
            { markdown: UNBOUND_GROUP_REPLY },
            { replyTo: msg.messageId },
          )
          .catch(() => undefined);
      }
      return;
    }

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

    const text = msg.content.trim();
    const cmd = parseCommand(text);
    // `/goal <objective>` anywhere in the message → a persistent autonomous goal
    // run (OKR reaction as the receipt, streaming cards, then a terminal card).
    // Explicit slash COMMANDS above still take priority (clear, leading intent).
    const goalObjective = parseGoalTrigger(text);

    // Single-session group: the main area is one session keyed by chatId. No
    // topics — reply by quoting (引用回复); runs serialize per chatId (active[chatId]).
    // Commands: /settings (群设置) + /model. /resume has no topic list here.
    // A topic opened in the group (msg.threadId) falls through to the topic path
    // below and gets its own session (product.md 3.5); an old topic that used to
    // share the chat session starts fresh from its next message, nothing migrated.
    if (project && ruleKind(project) === 'single' && !msg.threadId) {
      if (cmd === 'help') {
        await postHelpCard(msg, 'single', false, project);
        return;
      }
      if (cmd === 'settings') {
        await postGroupSettings(msg, project);
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
      if (await refuseFullOnly(msg, project, ts)) return;
      if (goalObjective) {
        if (!goalCapable(project)) {
          await denyGoal(msg, false);
          return;
        }
        void trackTask(addReaction(msg.messageId, 'OKR'));
        startReservedRun(msg, goalObjective, ts.sessionKey, true, project, ts, undefined, undefined, undefined, true);
        return;
      }
      if (await alreadySeen(msg, ts.sessionKey)) return;
      void trackTask(handleTurn(msg, text, ts.sessionKey, true, project, ts).catch((err) => log.fail('intake', err)));
      return;
    }

    // Inside a topic (multi, or a topic in a single group) → a turn in that session. /settings +
    // /resume aren't topic-scoped — redirect to the main area instead of feeding
    // them to codex as a normal turn (烧一轮还无人能懂).
    if (msg.threadId) {
      if (cmd === 'help') {
        await postHelpCard(msg, 'topic', true, project);
        return;
      }
      if (cmd === 'resume' || cmd === 'settings') {
        await channel
          .send(msg.chatId, { markdown: `\`/${cmd}\` 请到主群区使用（话题外发）。` }, { replyTo: msg.messageId, replyInThread: true })
          .catch(() => undefined);
        return;
      }
      if (cmd === 'clear' || cmd === 'new') {
        await channel
          .send(
            msg.chatId,
            { markdown: '话题里不换会话。要新的会话，就开一个新话题；`/resume` 请到主群区使用。' },
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
      if (await refuseFullOnly(msg, project, ts)) return;
      if (goalObjective) {
        if (!goalCapable(project)) {
          await denyGoal(msg, true);
          return;
        }
        void trackTask(addReaction(msg.messageId, 'OKR'));
        startReservedRun(msg, goalObjective, ts.sessionKey, false, project, ts, undefined, undefined, undefined, true);
        return;
      }
      if (await alreadySeen(msg, ts.sessionKey)) return;
      void trackTask(handleTurn(msg, text, ts.sessionKey, false, project, ts).catch((err) => log.fail('intake', err)));
      return;
    }
    // Main group area: /resume opens the history picker; /settings opens the
    // group-settings card; /model only makes sense inside a topic; anything else
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
      await postGroupSettings(msg, project);
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
      if (!goalCapable(project)) {
        await denyGoal(msg, false);
        return;
      }
      if (await refuseFullOnly(msg, project, turnPerm(project))) return;
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
    if (await refuseFullOnly(msg, project, turnPerm(project))) return;
    startTopicDirectly(msg, text, project);
  };

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
   * bot 不插话。(此函数仅在 !mentionedBot 时调用,故 @到 bot 的情况已被排除。) */
  function shouldRespondWithoutMention(project: Project, msg: NormalizedMessage): boolean {
    if (!noMentionOf(project)) return false;
    if (msg.mentionAll || msg.mentions.some((m) => !m.isBot)) return false;
    if (ruleKind(project) === 'single') return true;
    const content = msg.content.trim();
    return Boolean(msg.threadId) || parseCommand(content) !== null || parseGoalTrigger(content) !== null;
  }

  /**
   * Whether a message without an @ of this bot, in a bound group whose 免@ may
   * answer it, is for this bot (三条底线, s22). Answers what the mode would,
   * except: a quote of this bot's message names it (免@, even in a 多会话 main
   * area); a quote of someone else's, or a topic another bot spoke in last, is
   * someone else's; with other bots in the group (or the count unread) a 多会话
   * main-area command needs an @. A lookup that fails leaves the message
   * unanswered and noted.
   * The group's only bot looks nothing up and answers as before s22.
   */
  async function forThisBot(msg: NormalizedMessage, project: Project): Promise<boolean> {
    let info: Promise<ChatInfo> | undefined;
    const chat = (): Promise<ChatInfo> => (info ??= topicCtx.chatInfo(msg.chatId));
    const lonely = (): Promise<boolean> => chat().then((r) => r.ok && r.bots === 1);
    const who = await audienceOf(msg, { noMention: noMentionOf(project) }, {
      lonely,
      quoted: (id) => fetchMessageMeta(channel, id, names, { event: 'quote-lookup-failed', deadlineMs: LOOKUP_DEADLINE_MS }),
      lastBot: (threadId) => fetchTopicLastBot(channel, threadId, LOOKUP_DEADLINE_MS),
    });
    const ref = msg.messageId.slice(-6);
    switch (who.to) {
      case 'me':
        if (who.by === 'quote') log.info('intake', 'audience', { to: 'me', by: 'quote', ref });
        return true;
      case 'other':
        log.info('intake', 'audience', { to: 'other', by: who.by, ref });
        return false;
      case 'unknown':
        log.info('intake', 'audience', { to: 'unknown', why: who.why, ref });
        noteNotReplied(msg, 'lookup-failed', { detail: who.why === 'quote' ? '引用的消息' : '话题里谁在说话' });
        return false;
      case 'nobody':
        if (!shouldRespondWithoutMention(project, msg)) return false;
        // Here only a main-area command or /goal of a 多会话 group: each bot would answer it.
        if (ruleKind(project) === 'multi' && !msg.threadId && !(await lonely())) {
          log.info('intake', 'audience', { to: 'other', by: 'command-needs-at', ref });
          // Unread, the count may be just this bot: the page says why the command got nothing.
          const r = await chat();
          if (!r.ok || r.bots === undefined) noteNotReplied(msg, 'lookup-failed', { detail: '群里有几个 bot' });
          return false;
        }
        return true;
    }
  }

  /** 非管理员触发 owner-only 命令(/resume、/settings)时的统一无权限提示。
   * design §5: 管理类命令仅 bot owner(=admins[]) 可用；对话类(/model、/help)对所有人开放。 */
  async function denyAdminCommand(msg: NormalizedMessage, cmd: 'resume' | 'settings' | 'clear' | 'new'): Promise<void> {
    const why = cmd === 'clear' || cmd === 'new' ? '主区的会话是大家共用的。' : '';
    await channel
      .send(msg.chatId, { markdown: `⚠️ \`/${cmd}\` 只有主人和管理员能用。${why}` }, { replyTo: msg.messageId })
      .catch(() => undefined);
    log.info('intake', 'cmd-denied', { cmd });
  }

  /** @bot /settings in a group: post the in-group settings card (owner/admin-gated). */
  async function postGroupSettings(msg: NormalizedMessage, project?: Project): Promise<void> {
    if (!isAdmin(cfg, msg.senderId)) {
      await denyAdminCommand(msg, 'settings');
      return;
    }
    if (!project) {
      await channel
        .send(msg.chatId, { markdown: '本群未绑定项目，请先在私聊里新建项目。' }, { replyTo: msg.messageId })
        .catch(() => undefined);
      return;
    }
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      await sendManagedCard(channel, msg.chatId, buildGroupSettingsCard(project), msg.messageId);
      log.info('card', 'group-settings', { project: project.name });
    });
  }

  /** A turn's resolved permission: the group's one tier, whoever sends (s15c). */
  type TurnPerm = { mode?: PermissionMode; network?: boolean };

  /** The group's tier and network for `project`. */
  function turnPerm(project: Project | undefined): TurnPerm {
    return project ? { mode: effectiveMode(project), network: project.network } : {};
  }

  /** As {@link turnPerm}, plus the session key: the place itself, one session for everyone. */
  function turnSession(baseKey: string, project: Project | undefined): { sessionKey: string } & TurnPerm {
    return { sessionKey: baseKey, ...turnPerm(project) };
  }

  /** When each group last got the full-only explanation (see refuseFullOnly). */
  const fullOnlyNoted = new Map<string, number>();
  /** A 只读 or 读写 turn where the backend runs only in 完全访问 (Codex on Linux): no session starts and
   * nothing is downloaded or woven first. The message is noted and the group told why, in place: every
   * @, and a 免@ message only when the group got no explanation in the last {@link FULL_ONLY_QUIET_MS}. */
  async function refuseFullOnly(msg: NormalizedMessage, project: Project, perm: TurnPerm): Promise<boolean> {
    const mode = perm.mode ?? 'full';
    if (mode === 'full') return false;
    const be = backendFor(project.backend);
    if (!be.fullAccessOnly?.()) return false;
    log.info('intake', 'reject', { reason: 'full-only', mode });
    noteNotReplied(msg, 'tier-unavailable', { backendId: be.id });
    const now = Date.now();
    const last = fullOnlyNoted.get(msg.chatId);
    if (!msg.mentionedBot && now - (last ?? -Infinity) < FULL_ONLY_QUIET_MS) return true;
    // Stamped before sending so 免@ messages arriving meanwhile stay quiet; put back if the send fails.
    fullOnlyNoted.set(msg.chatId, now);
    // The command needs --bot when the host has several bots (pickBot); an unreadable registry counts as one.
    const several = await loadBots().then((reg) => reg.bots.length > 1, () => false);
    const markdown = fullOnlyReply(msg.chatId, mode, several ? cfg.accounts.app.id : undefined);
    const sent = await channel.send(msg.chatId, { markdown }, { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) }).then(() => true, () => false);
    if (!sent && fullOnlyNoted.get(msg.chatId) === now) {
      if (last === undefined) fullOnlyNoted.delete(msg.chatId);
      else fullOnlyNoted.set(msg.chatId, last);
    }
    return true;
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
  function ingestContext(msg: NormalizedMessage, text: string): Promise<IngestedContext> {
    return orderContext(msg.threadId ?? msg.chatId, () => ingestContextImpl(msg, text));
  }
  async function ingestContextImpl(msg: NormalizedMessage, text: string): Promise<IngestedContext> {
    names.learnMentions(msg.mentions);
    // Started first so the lookup overlaps the voice, file and quote fetches;
    // bounded, and undefined on failure (the block then says 某用户, as before).
    const senderNameP = names.senderName(msg);
    const ingested = msg.rawContentType === 'audio' ? await ingestVoice(channel, msg, voice) : { text };
    let body = ingested.text;
    if (messageHasFiles(msg)) {
      const files = await collectInboundFiles(channel, msg);
      body = weaveFileManifest(text, files);
      // A file-ONLY message whose download failed (oversize / Feishu reject /
      // transient) strips to '' — don't hand codex a blank turn (wasted run +
      // empty card). Tell it the attachment couldn't be read so it can say so.
      if (!body.trim()) {
        body =
          '用户发来一个附件，但桥没能下载它（可能超过 50MB 上限或被飞书拒绝）。请告诉用户附件没读到，可以重发，或改为粘贴文本 / 发图片。';
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
    body = weaveSender(body, { senderId: msg.senderId, senderName }, deliveryLagMs(msg));
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
    if (refusedTurn(project, msg.chatId, extra)) return Promise.resolve();
    const owner = active.get(sessionKey);
    return orderTurns(sessionKey, async () => {
      if (staleRetry(extra)) return;
      if (owner?.intakeCancelled) {
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
        await replyGoalBusy(msg, flat);
        return;
      }
      // Download any images first (best-effort) so the steered/queued turn can
      // carry them. Awaited here — the session is already held by a running
      // turn, so there's no reservation race to protect; gated on
      // messageHasImages so the common text path stays await-free and fast.
      // A retry brings its own saved images instead.
      let pendingImages: Promise<string[] | undefined> = Promise.resolve(extra?.images);
      if (!extra?.images && messageHasImages(msg)) pendingImages = collectInboundImages(channel, msg);
      const [images, woven] = await Promise.all([pendingImages, ingestContext(msg, text)]);
      if (existing.intakeCancelled) {
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
        await replyGoalBusy(msg, flat);
        return;
      }
      void trackTask(deliverPreparedTurn(msg, woven, images, extra?.summary ?? text, sessionKey, flat, project, perm, cur, extra)
        .catch((err) => log.fail('intake', err)));
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
    return refused !== undefined;
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
    if (!extra?.queueOnly && pendingPolicyOf(getPendingPolicy(cfg), project) === 'steer' && cur.run && cur.thread && cur.thread.supportsSteer !== false) {
      const tid = cur.run.turnId();
      if (tid) {
        const voiceReply = cur.voiceReply?.run === cur.run ? cur.voiceReply : undefined;
        const steerReply = cur.steerReply?.run === cur.run ? cur.steerReply : undefined;
        // Dropped before the RPC: once sent, the input may reach the model even
        // if the ACK is lost. Marked seen for the same reason, so the next
        // back-fill does not weave it again.
        dropRetries(sessionKey);
        markSeen(sessionKey, { id: msg.messageId, at: msg.createTime });
        try {
          await steerWithDeadline(cur.thread, { text: woven.text, images }, tid);
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
    if (cur.intakeCancelled) return;
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
  async function replyGoalBusy(msg: NormalizedMessage, flat: boolean): Promise<void> {
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
    if (refusedTurn(project, msg.chatId, extra)) return;
    // A retry re-checks here, in the same synchronous step that reserves it: a
    // message may have reserved the session while it waited.
    if (staleRetry(extra)) return;
    if (recalledSkip(msg)) return;
    const existing = active.get(sessionKey);
    if (existing) {
      // A /compact or /new holds the session: wait, then go through here again (s15).
      if (existing.deferred && !extra?.retry) {
        existing.deferred.push({ id: msg.messageId, at: msg.createTime, origin: originOf(msg, flat), go: () =>
          startReservedRun(msg, text, sessionKey, flat, project, perm, preloadedImages, preIngested, summaryText, goal, extra), early: () => {
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
        void trackTask(replyGoalBusy(msg, flat));
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
        requesterOpenId: msg.senderId,
        requestedAt: msg.createTime || Date.now(),
        summary: stripFileTokens(summaryText ?? text).slice(0, 80) || undefined,
        seen: { id: msg.messageId, at: msg.createTime },
        origin: originOf(msg, flat),
      });
      dropRetries(sessionKey);
      log.info('intake', 'queued', { depth: existing.queue.length });
      return;
    }
    const reserved: ActiveState = { queue: [], requesterOpenId: msg.senderId, isGoal: goal, runLoop: true };
    active.set(sessionKey, reserved);
    dropRetries(sessionKey);
    extra?.retry?.accepted();
    void trackTask(withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      // Goal runs use the OKR reaction (added at dispatch) as their only receipt,
      // not the ⏳/🫳 run-reaction lifecycle.
      const reaction = goal ? undefined : runReaction(msg.messageId, !sema.hasFree());
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
        const ingestP = preIngested ? Promise.resolve(preIngested) : ingestContext(msg, text);
        let tResolveDone = tIntake;
        const resolveP = resolveThread(sessionKey, msg.chatId, {
          mode: perm.mode,
          network: perm.network,
        }).then((r) => {
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
          const be = backendFor(prior?.backend ?? project?.backend);
          const defaults = pickDefault(await listModels(be), {
            model: project?.defaultModel,
            effort: project?.defaultEffort,
            custom: project?.defaultModelCustom,
          });
          if (!model) {
            model = defaults.model;
            modelCustom = isCustomDefault(project, model);
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
          firstText = weaveRecordBlock(firstText, {
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
          if (codexEmpty && pull.ok) openFrom = Math.min(now, ...times);
          log.info('intake', 'record-block', { place, lines: kept.length, earlier, opening: codexEmpty, ok: pull.ok, streaming: streaming.length,
            quotes: topicsPart.quotes?.length ?? 0, moreTopics: topicsPart.moreTopics ?? 0, table: topicsPart.table?.length ?? 0,
            ownRoots: topicsPart.refs?.length ?? 0, recalls: recalls.length, ...openingLog });
        } else if (place && recalls.length) {
          // No back-fill (a resumed session without a watermark): a block with the notes only.
          const header = { group: project?.name, me: channel.botIdentity?.name, ...(topicId ? { topic: { title } } : {}) };
          firstText = weaveRecordBlock(firstText, { place: header, entries: [], now: msg.createTime || Date.now(), recalls });
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
          const cwd = project?.cwd ?? fallbackCwd;
          const be = backendFor(project?.backend);
          thread = await be.startThread({ cwd, model, effort, mode: perm.mode, network: perm.network });
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
            modelCustom,
            // `text` is already file-woven when preIngested; use the raw
            // `summaryText` (handleTurn's original) so the session label isn't
            // manifest boilerplate + a temp path.
            summary: stripFileTokens(summaryText ?? text).slice(0, 80),
            // Nothing reached it yet; the trigger is marked once the turn starts.
            ...nothingSeen(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        } else if (recreated) {
          // resume 失败后创建的是一个全新的 HOST 会话；它属于升级后的新会话，
          // 应独立登记标题任务（旧 sessionId 的 ledger/标题绝不复用）。
          const be = backendFor(prior?.backend ?? project?.backend);
          const cwd = project?.cwd ?? prior?.cwd ?? fallbackCwd;
          titleJobKey = await registerSessionTitle(be, thread.sessionId, cwd, titleSource);
          // Full replacement drops the old session's titleJobKey even if title
          // registration failed; carrying it across would let a later turn attach
          // source to the wrong native session.
          if (prior) {
            await upsertSession({
              ...prior,
              // A new native session: the old watermark does not cover it.
              ...nothingSeen(),
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
          const be = backendFor(prior?.backend ?? project?.backend);
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
        launchOpts = {
          chatId: msg.chatId,
          replyTo: msg.messageId,
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
          cwd: project?.cwd ?? prior?.cwd ?? fallbackCwd,
          mode: perm.mode,
          network: perm.network,
          // The backend resolveThread routed by: the record's, else the project's.
          backendId: backendFor(prior?.backend ?? project?.backend).id,
          summary: stripFileTokens(summaryText ?? text).slice(0, 80) || '(本轮任务)',
          requesterOpenId: msg.senderId,
          requestedAt: msg.createTime || tIntake,
          replayText: extra?.replayText,
          seen: seenMark,
          seenHow,
          streaming,
          woven,
          seenExtra,
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
        };
        if (recreateReason) log.info('agent', 'session-changed', { sessionKey, reason: recreateReason, ...(unused ? { unused } : {}) });
        if (goal) await trackRun(launchGoalRun(launchOpts));
        else await trackRun(launchRun(launchOpts, reaction));
      } catch (err) {
        if (active.get(sessionKey) === reserved) active.delete(sessionKey);
        releaseIdle(sessionKey, sessions.get(sessionKey));
        const dropped = reserved.queue.splice(0).length;
        dropCompact(reserved);
        reaction?.done();
        log.fail('intake', err);
        if (!goal) noteFailure(msg, flat ? 'main' : 'topic', launchOpts?.backendId ?? backendFor(project?.backend).id, { error: err });
        await channel
          .send(msg.chatId, { markdown: runFailureMessage(err, dropped, launchOpts?.sessionNotice) }, { replyTo: msg.messageId, replyInThread: !flat })
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

  /** Reuse an in-memory codex thread, else resume from the persisted store.
   * `perm` carries the bound project's CURRENT permission tier (mode/network),
   * applied when we (re)start a thread here. A LIVE thread keeps the sandbox it
   * was started with (codex binds it at thread/start and never re-reads it), so
   * a tier change can only take effect by EVICTING the live thread first — see
   * evictLiveSessionsForChat, called from the 🔐 权限 handlers. Without that
   * eviction the fast-path below would silently keep a 'full' thread running
   * after the admin switched to read-only.
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
    perm?: { mode?: PermissionMode; network?: boolean },
  ): Promise<{ thread: AgentThread | undefined; recreated: boolean; reason?: RecreateReason }> {
    const live = sessions.get(threadId);
    if (live) {
      if (live.isAlive()) {
        const elsewhere = await writtenElsewhere(threadId, live);
        const prior = elsewhere ? undefined : await getSession(threadId).catch(() => undefined);
        // Evicted while it looked (a tier change, the reaper): resume below like any other.
        if (sessions.get(threadId) === live && live.isAlive()) {
          if (!elsewhere) {
            noteCompaction(threadId, chatId, live, prior);
            return { thread: live, recreated: false };
          }
          // Someone else wrote the session (a terminal turn or /compact, s15b): this
          // process never rereads it, so reconnect from the file below.
          sessions.delete(threadId);
          void trackTask(live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
        }
      } else {
        // app-server 子进程已死（崩溃/被 kill）：死线程留在缓存只会反复失败，
        // 清掉让它落入下面既有的 resume-or-recreate 兜底（持久化的 sessionId
        // 还在，话题自愈而不是僵死到重启）。
        sessions.delete(threadId);
        log.info('agent', 'dead-thread-evict', { threadId });
      }
    }
    const rec = await getSession(threadId);
    if (!rec) return { thread: undefined, recreated: false };
    // Route by the RECORD's backend — the backend that created the session (old
    // v1 records read back as the codex default). A project switching backends
    // later must not strand existing sessions on the wrong runtime; the project
    // is still consulted for cwd / tier defaults on the recreate path below.
    const project = await getProjectByChatId(chatId);
    if (project && rec.cwd !== project.cwd) {
      lastUsage.delete(threadId); // a new session: the meter starts over
      return { thread: undefined, recreated: true, reason: 'cwd-changed' };
    }
    const be = backendFor(rec.backend);
    await waitReleased(threadId);
    try {
      const resumed = await be.resumeThread({
        cwd: rec.cwd,
        sessionId: rec.sessionId,
        model: rec.model,
        effort: rec.effort,
        mode: perm?.mode,
        network: perm?.network,
      });
      trackSession(threadId, resumed);
      // 自愈观测：resume 来源=持久化记录（区分「resume 自愈」与 LIVE 快路径的
      // 普通续轮——后者不经过这里，stream.timing 的 tResolve≈0 是它的指纹）。
      log.info('agent', 'resume-ok', { threadId, sessionId: rec.sessionId, backend: be.id });
      noteCompaction(threadId, chatId, resumed, rec);
      return { thread: resumed, recreated: false };
    } catch (err) {
      log.fail('agent', err, { phase: 'resume-on-turn', threadId });
      // Open in a terminal or the Codex app (s15b): say so and keep the session.
      if (err instanceof SessionInUseError) throw err;
      const cwd = project?.cwd ?? rec.cwd ?? fallbackCwd;
      const fresh = await be.startThread({
        cwd,
        model: rec.model,
        effort: rec.effort,
        mode: perm?.mode ?? project?.mode,
        network: perm?.network ?? project?.network,
      });
      trackSession(threadId, fresh);
      lastUsage.delete(threadId);
      // The resumed codex thread is gone — repoint the persisted record at the
      // new thread id so a later restart doesn't keep resuming the dead one.
      await patchSession(threadId, { sessionId: fresh.sessionId }).catch(() => undefined);
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
      sessions.delete(rec.threadId); // synchronous: next turn can't reuse it
      void trackTask(live.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
      closed++;
    }
    if (closed) log.info('console', 'tier-evict', { chatId, closed });
  }

  /** Group @bot (no topic): create the topic + run with the default model.
   * Detached — onMessage must return fast (see {@link handleTurn}); a new
   * topic has a unique reply target so no same-topic reservation is needed. */
  function startTopicDirectly(msg: NormalizedMessage, text: string, project?: Project, goal?: boolean): void {
    if (resumePublications.has(msg.chatId) || projectMutations.has(msg.chatId)) {
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
      const cwd = project?.cwd ?? fallbackCwd;
      const perm = turnPerm(project);
      // lazy banner branch refresh (design §3.2) — best-effort, non-blocking
      if (project) void trackTask(refreshBranch(channel, project).catch(() => undefined));
      // Pick the default model FROM THE PROJECT'S BACKEND — a claude project must
      // not be handed codex's default ('gpt-5.5'). Unset backend → codex, as before.
      const be = backendFor(project?.backend);
      // ── 入站并行（M-1）── listModels+startThread（本地 spawn，实测 250ms–1.6s）
      // 与图片下载 / 文件+引用织入（飞书 API）互不依赖。任何一路失败都终止本轮
      // 并回 ❌（原先 ingest 失败只进日志、reaction 卡死——顺带修正），但已起的
      // 进程必须回收：它还不在 sessions 里，不关就是孤儿 app-server。
      const tIntake = Date.now();
      let tResolveDone = tIntake;
      const threadP = (async () => {
        const { model, effort } = pickDefault(await listModels(be), {
          model: project?.defaultModel,
          effort: project?.defaultEffort,
          custom: project?.defaultModelCustom,
        });
        const thread = await be.startThread({ cwd, model, effort, mode: perm.mode, network: perm.network });
        tResolveDone = Date.now();
        return { thread, model, effort };
      })();
      // Download any attached/forwarded images so the opening turn can see them,
      // and any file attachments (their paths get woven into the prompt text).
      const imagesP = messageHasImages(msg) ? collectInboundImages(channel, msg) : Promise.resolve(undefined);
      const ingestP = ingestContext(msg, text);
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
      if (section) {
        // The bot-opened topic's opening (s14b): where it hangs, and the main area before it.
        const { pull, main, quotes, moreTopics } = section;
        firstText = weaveRecordBlock(firstText, {
          place: { group: project?.name, me: channel.botIdentity?.name, topic: { title: topicTitle(msg.content) } },
          entries: [],
          now: msg.createTime || Date.now(),
          opening: { pointer: { botOpened: true, root: { at: msg.createTime, who: senderWho(msg) } }, main },
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
        chatId: msg.chatId,
        replyTo: msg.messageId,
        replyInThread: true,
        thread,
        firstText,
        voice: voiceReply,
        images,
        model,
        effort,
        modelCustom: isCustomDefault(project, model),
        cwd,
        mode: perm.mode,
        network: perm.network,
        summary: stripFileTokens(text).slice(0, 80) || '(空)',
        requesterOpenId: msg.senderId,
        requestedAt: msg.createTime || tIntake,
        seenAt: msg.createTime,
        // The topic session's oldest line: the opening's first main line, else the trigger (s15).
        from: section ? section.main[0]?.createTime || msg.createTime : undefined,
        openTopic: { id: msg.messageId, from: senderOf(msg), at: msg.createTime || undefined, text: msg.content },
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
      const remaining = (pendingTopics.get(msg.chatId) ?? 1) - 1;
      if (remaining) pendingTopics.set(msg.chatId, remaining); else pendingTopics.delete(msg.chatId);
    }));
  }

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
        const cwd = project?.cwd ?? fallbackCwd;
        // Routed so a no-resume backend surfaces its clear "not supported" error
        // here. The resolved backend id rides the card state AND each pick
        // button's callback value (`b`), so the pick → readHistory → rebind path
        // stays on the same backend that listed the sessions.
        const be = backendFor(project?.backend);
        const threads = await be.listThreads(cwd);
        const state: ResumeCardState = {
          chatId: msg.chatId,
          originalMsgId: msg.messageId,
          requesterOpenId: msg.senderId,
          cwd,
          projectName: project?.name,
          backend: be.id,
          threads,
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
        const be = backendFor(rec?.backend ?? project?.backend);
        const models = await listModels(be);
        // Seed the /model card's "current" from the project default (when this
        // topic has no session record yet) so a fresh topic shows what it WILL
        // start on; pickDefault validates it against the live list.
        const def = pickDefault(models, {
          model: project?.defaultModel,
          effort: project?.defaultEffort,
          custom: project?.defaultModelCustom,
        });
        // 记录里跨后端污染的 model id（旧版未路由的 /model 卡写入）不在本后端
        // 列表里——回落默认，别把坏值当 select 初值渲染。手填的 id（会话上标了
        // modelCustom）不在列表里也照显示。
        const recModel =
          rec?.model && (rec.modelCustom || models.some((m) => m.id === rec.model)) ? rec.model : undefined;
        const state: ModelCardState = {
          chatId: msg.chatId,
          threadId: sessionKey,
          requesterOpenId: msg.senderId,
          models,
          model: recModel ?? def.model,
          effort: rec?.effort ?? def.effort,
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
          network: perm.network,
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
   * model / effort / backend. The parked thread stays on disk (resumable via
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
        // codex thread for a codex session, claude for a claude one.
        const be = backendFor(rec?.backend ?? project?.backend);
        const cwd = rec?.cwd ?? project?.cwd ?? fallbackCwd;
        // Carry the session's chosen model/effort into the new thread so /clear
        // resets the CONVERSATION, not the user's model pick. Tier (mode/network)
        // comes from the caller's live perm.
        const fresh = await be.startThread({
          cwd,
          model: rec?.model,
          effort: rec?.effort,
          mode: perm.mode,
          network: perm.network,
        });
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
          model: rec?.model,
          effort: rec?.effort,
          modelCustom: rec?.modelCustom,
          summary: '(新会话)',
          // The new session starts at this command (product.md 3.5 "命令"), also
          // when it is rebuilt before its first turn (from).
          lastSeenAt: msg.createTime || Date.now(),
          from: (msg.createTime || Date.now()) + 1,
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
    const caps = backendFor(project?.backend).capabilities;
    await withTrace({ chatId: msg.chatId, msgId: msg.messageId }, async () => {
      const card = buildHelpCard(scope, noMention, isAdmin(cfg, msg.senderId), caps, project ? ruleKind(project) : 'multi');
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
  ): void => {
    const armedAt = Date.now();
    void trackTask((async () => {
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
    })());
  };
  function pruneResumePending(): void {
    const now = Date.now();
    for (const [k, s] of resumePending) if (now - s.createdAt > PENDING_TTL_MS) resumePending.delete(k);
  }
  function pruneModelPending(): void {
    const now = Date.now();
    for (const [k, s] of modelPending) if (now - s.createdAt > PENDING_TTL_MS) modelPending.delete(k);
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
    if (op !== state.requesterOpenId || !isChatAllowed(cfg, state.chatId)) {
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
        state.model = option;
        // re-pick a valid effort if the new model doesn't support the current one
        const m = state.models.find((x) => x.id === option);
        if (m && m.supportedEfforts.length && !m.supportedEfforts.includes(state.effort)) {
          state.effort = m.defaultEffort;
        }
        await patchSession(state.threadId, { model: state.model, effort: state.effort, modelCustom: false });
        state.note = `✅ 已切换模型「${m?.displayName ?? option}」，下一轮生效`;
        return buildModelCard(state);
      });
    })
    .on(MC.effort, ({ evt, option }) => {
      const state = authPending(modelPending, evt);
      if (!state || !option) return;
      settleUpdate(evt.messageId, async () => {
        const stale = modelCardStale(state, await getSession(state.threadId));
        if (stale) {
          state.note = stale;
          return buildModelCard(state);
        }
        state.effort = option as ReasoningEffort;
        await patchSession(state.threadId, { effort: state.effort });
        state.note = '✅ 已设置 effort，下一轮生效';
        return buildModelCard(state);
      });
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
        } else {
          state.model = parsed.id;
          if (!getSessionTitleEfforts(state.backend ?? rec?.backend ?? '').includes(state.effort)) state.effort = 'medium';
          await patchSession(state.threadId, { model: state.model, effort: state.effort, modelCustom: true });
          state.note = `✅ 已切换到手填的模型 ${modelIdCode(parsed.id)}，下一轮生效`;
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
  const runAllowed = (evt: CardActionEvent): boolean => isChatAllowed(cfg, evt.chatId);
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
  const healDeadRunCard = (evt: CardActionEvent, key: string, actionId: string, notice = 'ℹ️ 该任务已结束，按钮已失效。'): void => {
    if (runControlNotes.seen(`dead:${key}`)) return; // 已答复过 / 自愈在路上
    void trackTask(channel
      .send(evt.chatId, { markdown: notice }, { replyTo: evt.messageId })
      .catch(() => undefined));
    const rc = runCards.get(key);
    const stream = runStreams.get(key);
    log.info('card', 'action', { actionId, orphan: true, inProcess: Boolean(rc && stream) });
    void trackTask((async () => {
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
        const seq = Math.floor(Date.now() / 1000);
        await channel.rawClient.cardkit.v1.cardElement.delete({
          path: { card_id: cardId, element_id: CONTROLS_EID },
          data: { sequence: seq, uuid: `h_${cardId}_${seq}` },
        });
      } catch (err) {
        log.fail('card', err, { phase: 'run-card-heal', key });
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
    // “仅手动”模式的单轮完成提醒。这不是破坏性操作，但也不允许
    // 管理员替别人订阅：只有这一轮的真实发起人能开启。
    .on(RC.remind, ({ evt, value }) => {
      const key = typeof value.m === 'string' ? value.m : evt.messageId;
      if (!runAllowed(evt)) return;
      const st = runsByCard.get(key);
      if (!st) {
        if (!runControlNotes.seen(`remind-ended:${key}:${evt.operator?.openId ?? ''}`)) {
          void trackTask(channel
            .send(evt.chatId, { markdown: 'ℹ️ 该任务已结束，无需再开启完成提醒。' }, { replyTo: evt.messageId })
            .catch(() => undefined));
        }
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
      if (!shouldShowCompletionReminderButton(cfg)) {
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
    const msg = cardTurnMessage(key, retry.chatId, op, text, retry.sessionKey, retry.flat);
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
  const patch = (evt: CardActionEvent, c: object | (() => object | Promise<object>)): void =>
    settleUpdate(evt.messageId, c, evt.chatId);

  async function renderForegroundUpdate(): Promise<ReturnType<typeof buildForegroundUpdateCard>> {
    const [desktopRelease, distribution] = await Promise.all([getDesktopRelease(), runtimeDistribution()]);
    return buildForegroundUpdateCard({
      current: currentVersion(),
      distribution: distribution.kind === 'bundled' ? 'bundled' : 'other',
      desktopRelease,
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
        : options[0]?.id ?? DEFAULT_BACKEND_ID;
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
    if (!valid) {
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
        byBackend: { ...(current.byBackend ?? {}), [backendId]: { ...current.byBackend?.[backendId], ...config } },
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
    const configured = getCommentsConfig(cfg).backend ?? DEFAULT_BACKEND_ID;
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
      const snapshot: AppConfig = {
        ...cfg,
        preferences: { ...(cfg.preferences ?? {}), comments: { ...comments } },
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
  const renderDmMenuCard = async (): Promise<object> => buildDmMenuCard({
      version: bridgeVersion(),
      desktopRelease: await getDesktopRelease(),
    });
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
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
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
            const p = await createProject(channel, {
              name,
              ownerOpenId: op,
              existingPath: cwdIn || undefined,
              projectsRootDir: cfg.preferences?.projectsRootDir,
              kind,
              noMention: parseNoMentionPick(formValue),
              backend,
            });
            log.info('console', 'new-project', { name: p.name, blank: p.blank, backend: p.backend });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildNewProjectFormCard({ name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err), backends });
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
      const kind: 'multi' | 'single' = value.kind === 'single' ? 'single' : 'multi';
      // 列「全后端」（full 档过滤面 = 已下载的都列，含 claude 系）。默认仍是 codex（列表
      // 首项），绑定后按所选后端定档：codex→qa（外部群安全默认）、claude→full（见 bindModeFor）。
      const backends = backendOptionsFor('full');
      // Same fresh-card pattern as DM.newProjectSubmit: a submitted form locks
      // its card_id, so the result goes to a new card while the form stays above
      // as a 留痕. Detached so the click acks immediately (join is slow).
      void trackTask((async () => {
        let result;
        if (!chatId)
          result = buildJoinGroupFormCard({ chatId: '', name, cwd: cwdIn, error: '缺少群标识，请重新从进群通知里打开绑定卡', backends });
        else if (!name) result = buildJoinGroupFormCard({ chatId, cwd: cwdIn, error: '项目名不能为空', backends });
        else if (!op) result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, error: '无法识别操作者身份', backends });
        else {
          try {
            const p = await joinExistingGroup(channel, {
              name,
              chatId,
              addedBy: op,
              existingPath: cwdIn || undefined,
              projectsRootDir: cfg.preferences?.projectsRootDir,
              kind,
              noMention: parseNoMentionPick(formValue),
              backend,
              mode: bindModeFor(backend),
            });
            log.info('console', 'join-group', { name: p.name, blank: p.blank, backend: p.backend, mode: p.mode });
            result = buildNewProjectDoneCard(p);
          } catch (err) {
            result = buildJoinGroupFormCard({ chatId, name, cwd: cwdIn, error: err instanceof Error ? err.message : String(err), backends });
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
    // Each setting is a row of option buttons; the click's `v` is the chosen value.
    .on(DM.setTools, ({ evt, value }) => {
      applyPref(evt, (p) => (p.showToolCalls = value.v === 'on'));
    })
    .on(DM.setShowModel, ({ evt, value }) => {
      applyPref(evt, (p) => {
        p.showModel = value.v === 'running' ? 'running' : value.v === 'always' ? 'always' : 'off';
      });
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
      const backendId = typeof value.b === 'string' ? value.b : getCommentsConfig(cfg).backend ?? DEFAULT_BACKEND_ID;
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
            c.backend = backendId;
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
    // In-group settings: toggle 免@ for the project bound to evt.chatId. Admin-gated.
    // 写路径走管理面共享层（admin/ops.ts）——与 DM 卡片 / Web 控制台同一套落盘逻辑。
    .on(GS.setNoMention, ({ evt, value }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      const on = value.v === 'on';
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (project) {
          const r = await performSetNoMention({ projectName: project.name, on });
          log.info('console', 'group-nomention', { project: project.name, on });
          return buildGroupSettingsCard(r.ok ? r.project : { ...project, noMention: on });
        }
        return buildGroupSettingsCard({ name: '本群', kind: 'multi', noMention: on });
      });
    })
    // s12：自动压缩一直开，开关已去掉。旧卡上的按钮不写盘，只把卡刷新成没有开关的样子并说一声。
    .on(GS.setAutoCompact, ({ evt }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        return buildGroupSettingsCard(project ?? { name: '本群', kind: 'multi' }, AUTO_COMPACT_RETIRED);
      });
    })
    // 🤖 默认模型/强度：群内 /settings 的镜像入口。GS.settings 返回群设置卡；GS.modelDefault
    // 进子卡（按项目后端实时列模型）；GS.modelDefaultSubmit 校验+落盘后回群设置卡。均 isAdmin
    // 门控（与 ✋免@ 同级），项目按 evt.chatId 解析；不驱逐活跃会话（默认只管新话题）。
    .on(GS.settings, ({ evt }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        return buildGroupSettingsCard(project ?? { name: '本群', kind: 'multi' });
      });
    })
    .on(GS.modelDefault, ({ evt }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      patch(evt, async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (!project) return buildGroupSettingsCard({ name: '本群', kind: 'multi' });
        const models = await listModels(backendFor(project.backend));
        return buildModelDefaultCard(project, models, 'group');
      });
    })
    // 表单提交锁卡：成功回群设置卡；选的模型无效或手填的 id 不合格时，带提示重发
    // 默认模型卡让管理员改，不再静默回群设置卡。
    .on(GS.modelDefaultSubmit, ({ evt, formValue }) => {
      if (!isAdmin(cfg, evt.operator?.openId ?? '')) return;
      void trackTask((async () => {
        const project = await getProjectByChatId(evt.chatId);
        if (!project) return;
        const backendId = project.backend ?? DEFAULT_BACKEND_ID;
        const models = await listModels(backendFor(project.backend));
        const parsed = parseModelDefaultFormValue(formValue, models, backendId);
        let next: object;
        if (!parsed.ok) {
          next = buildModelDefaultCard(project, models, 'group', `⚠️ ${parsed.message}`);
        } else {
          const r = await performSetModelDefault({ projectName: project.name, model: parsed.model, effort: parsed.effort, custom: parsed.custom });
          if (r.ok) log.info('console', 'group-model-default', { project: project.name, model: parsed.model, effort: parsed.effort, custom: parsed.custom });
          next = buildGroupSettingsCard((await getProjectByChatId(evt.chatId)) ?? project);
        }
        await sendManagedCard(channel, evt.chatId, next);
      })().catch((e) => log.fail('console', e, { phase: 'group-model-default-result' })));
    })
    // ── 权限管理回调（admins 全局 / 项目响应白名单）。均 dmAdmin 门控（私聊管理台）。
    // 列表卡用 patch 原地重渲染（纯按钮不锁）；加人是 form 提交，结果发**新卡**（旧表单
    // 留痕），规避 select 锁卡。owner 恒在 admins 名单顶、不可删。
    .on(DM.admins, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, async () =>
        buildAdminsCard(cfg, await namesWithOperator(evt, [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])])),
      );
    })
    .on(DM.addAdminForm, ({ evt }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      patch(evt, async () => {
        const all = await fetchAllProjectMembers(channel);
        const members = all.filter((m) => !isAdmin(cfg, m.openId)); // 排除已是 admin/owner 的
        return buildAddAdminCard(members);
      });
    })
    .on(DM.addAdminSubmit, ({ evt, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const manual = String(formValue?.open_id ?? '').trim();
      const id = manual.startsWith('ou_') ? manual : pickOpenId(formValue);
      log.info('console', 'admin-add', { picked: id?.slice(-6) ?? null });
      void trackTask((async () => {
        if (id) {
          await writePreferences((preferences) => {
            const access: AppAccess = { ...(preferences.access ?? {}) };
            access.ownerOpenId ??= resolveOwner(cfg);
            access.admins = Array.from(new Set([...(access.admins ?? []), id]));
            preferences.access = access;
          }).catch((e) => log.fail('console', e, { phase: 'save-config' }));
        }
        const ids = [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])];
        const next = buildAdminsCard(cfg, await namesWithOperator(evt, ids));
        await sendManagedCard(channel, evt.chatId, next).catch((e) => log.fail('console', e, { phase: 'admin-add-result' }));
      })());
    })
    .on(DM.rmAdmin, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const id = typeof value.u === 'string' ? value.u : '';
      patch(evt, async () => {
        if (id && id !== resolveOwner(cfg)) {
          await writePreferences((preferences) => {
            const access: AppAccess = { ...(preferences.access ?? {}) };
            access.ownerOpenId ??= resolveOwner(cfg);
            access.admins = (access.admins ?? []).filter((x) => x !== id);
            preferences.access = access;
          }).catch((e) => log.fail('console', e, { phase: 'save-config' }));
        }
        const ids = [resolveOwner(cfg), ...(cfg.preferences?.access?.admins ?? [])];
        return buildAdminsCard(cfg, await namesWithOperator(evt, ids));
      });
    })
    .on(DM.allowlist, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return renderDmMenuCard();
        return buildAllowlistCard(p, await namesWithOperator(evt, p.allowedUsers ?? []));
      });
    })
    .on(DM.addAllowedForm, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      if (!name) return;
      patch(evt, async () => {
        const p = await getProjectByName(name);
        const members = p?.chatId ? await fetchChatMembers(channel, p.chatId) : [];
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
        const card = buildAllowlistCard(fresh, await namesWithOperator(evt, fresh.allowedUsers ?? []));
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
        return buildAllowlistCard(fresh, await namesWithOperator(evt, fresh.allowedUsers ?? []));
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
        if (!r.ok) return renderDmMenuCard();
        return buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend));
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
    // 🔐 权限：打开下拉表单子卡（权限档 + 联网，选完提交）。
    .on(DM.permission, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        return p ? buildPermissionCard(p, backendFor(p.backend).fullAccessOnly?.()) : renderDmMenuCard();
      });
    })
    // 提交权限表单：落盘 权限档 mode / 联网，再驱逐本项目活跃会话让新档立即生效（沙箱
    // 在 thread/start 绑定后不可变）。表单卡 card_id 提交后会锁，故发一张全新的项目设置卡
    // （旧表单卡留痕），不 patch 原卡。
    .on(DM.permissionSubmit, ({ evt, value, formValue }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      const mode = asTier(selectValue(formValue, 'mode'));
      const network = selectValue(formValue, 'network') === 'on';
      // A card sent before s15c (no version; it has 普通成员权限) saves nothing, a fresh one-tier card goes out.
      const oldCard = value.v !== PERMISSION_CARD_VERSION || selectValue(formValue, 'guestMode') !== undefined;
      void trackTask((async () => {
        // On a full-only backend a save of 只读 or 读写 is refused as the web save is, with a fresh card.
        const p = await getProjectByName(name);
        const fullOnly = p && backendFor(p.backend).fullAccessOnly?.();
        if (p && (oldCard || (fullOnly && mode !== undefined && mode !== 'full'))) {
          log.info('console', 'permission-refused', { project: name, mode, reason: oldCard ? 'old-card' : 'full-only' });
          await sendManagedCard(channel, evt.chatId, buildPermissionCard(p, fullOnly)).catch((e) => log.fail('console', e, { phase: 'permission-result' }));
          return;
        }
        // 共享层（admin/ops.ts）：落盘 + 驱逐活跃会话让新档立即生效；写后回读，
        // 卡片与盘上一致——与 Web 控制台的 setPermissionMode 完全同一条路径。
        const r = await performSetPermissionMode({ projectName: name, mode, network, evictLiveSessionsForChat });
        if (!r.ok) return;
        log.info('console', 'permission', { project: name, mode, network });
        await sendManagedCard(channel, evt.chatId, buildProjectSettingsCard(r.project, backendDisplayName(r.project.backend))).catch((e) =>
          log.fail('console', e, { phase: 'permission-result' }),
        );
      })());
    })
    // 🤖 默认模型/强度：打开下拉表单子卡（按项目后端实时列模型；选完提交）。
    .on(DM.modelDefault, ({ evt, value }) => {
      if (!dmAdmin(evt.operator?.openId)) return;
      const name = typeof value.n === 'string' ? value.n : '';
      patch(evt, async () => {
        const p = await getProjectByName(name);
        if (!p) return renderDmMenuCard();
        const models = await listModels(backendFor(p.backend));
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
        const models = await listModels(backendFor(p.backend));
        const parsed = parseModelDefaultFormValue(formValue, models, p.backend ?? DEFAULT_BACKEND_ID);
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
          const history = await be.readHistory(state.cwd, sessionId);
          resumePending.delete(evt.messageId);
          await withTrace({ chatId: state.chatId, msgId: state.originalMsgId }, async () => {
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
            const now = Date.now();
            await upsertSession({
              threadId: sessionKey,
              chatId: state.chatId,
              cwd: state.cwd,
              sessionId,
              backend: be.id,
              summary: resumedTitle(history) || '(恢复会话)',
              createdAt: now,
              updatedAt: now,
            });
            dropRetries(sessionKey); // the next turn runs in the picked session
            log.info('card', 'resume-done-single', { sessionKey, sessionId, turns: history.totalTurns });
          });
          settleUpdate(evt.messageId, buildResumeDoneCard(state));
        } finally {
          if (active.get(sessionKey) === reserved) active.delete(sessionKey);
          if (reserved.queue.length > 0) {
            await channel
              .send(
                state.chatId,
                { markdown: `⚠️ 切回期间收到的 ${reserved.queue.length} 条消息未进入会话，请重发。` },
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
      const history = await be.readHistory(state.cwd, sessionId);
      resumePending.delete(evt.messageId);

      let bound = false;
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
          const now = Date.now();
          // Titled by the resumed session's name: the first message is the `/resume` itself.
          noteOpenedTopic(state.chatId, tid, { id: state.originalMsgId, text: resumedTitle(history) });
          await upsertSession({
            threadId: tid,
            chatId: state.chatId,
            cwd: state.cwd,
            sessionId,
            backend: be.id,
            summary: resumedTitle(history) || '(恢复会话)',
            createdAt: now,
            updatedAt: now,
          });
          bound = true;
        } else {
          log.warn('card', 'resume-no-threadid', { messageId: sent.messageId });
        }
        log.info('card', 'resume-done', { sessionId, threadId: tid ?? null, bound, turns: history.totalTurns });
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
          : buildResumeErrorCard(state, '已建话题但未能绑定会话，请重新 /resume'),
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
  const createRequests = new Map<string, { signature: string; result: Promise<unknown> }>();
  const runId = (state: ActiveState): string => {
    let identity = runIds.get(state);
    if (!identity || identity.run !== state.run) { identity = { run: state.run, id: randomUUID() }; runIds.set(state, identity); }
    return identity.id;
  };
  async function collaboration(request: CollaborationRequest): Promise<unknown> {
    const owner = resolveOwner(cfg);
    if (!owner) throw new AdminWriteError('请先配置此 Agent 的飞书管理员');
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
      const result = createChain.then(async () => {
        const directory = request.directory === undefined ? undefined : await realpath(request.directory);
        if (directory !== undefined && !(await stat(directory)).isDirectory()) throw new AdminWriteError('所选文件夹不是目录');
        const project = await createProject(channel, { requestId: request.requestId, requestSignature: signature, name: request.name, ownerOpenId: owner, existingPath: directory, projectsRootDir: cfg.preferences?.projectsRootDir, kind: request.kind, noMention: request.noMention, backend: request.backend, mode: bindModeFor(request.backend) });
        return { ok: true, project: projectView(project) };
      });
      createChain = result.catch(() => undefined);
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
    const be = backendFor(project.backend);
    if (request.action === 'history') {
      try { return { sessions: records, threads: (await be.listThreads(project.cwd)).map(resumableThread), backend: be.id }; }
      catch (error) { return { sessions: records, threads: [], backend: be.id, threadsError: error instanceof Error ? error.message : '无法读取后端历史' }; }
    }
    if (request.action === 'editProject' || request.action === 'removeProject') {
      if (projectRevision(project) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
      if (projectMutations.has(project.chatId) || active.size > 0 || intakeChats.has(project.chatId) || pendingTopics.has(project.chatId)) throw new AdminWriteError('Agent 正在执行任务，请结束后修改项目');
      projectMutations.add(project.chatId);
      try {
        const current = await getProjectByName(project.name);
        if (!current || projectRevision(current) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
        if (request.action === 'removeProject') {
          const removed = await removeProject(project.name, latest => {
            if (projectRevision(latest) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
          });
          if (!removed) throw new AdminWriteError('项目已移除，请刷新');
          for (const rec of records) { const thread = sessions.get(rec.threadId); sessions.delete(rec.threadId); if (thread) await thread.close().catch(error => log.fail('desktop', error, { phase: 'project-session-close' })); }
          let groupEffect: 'left' | 'transferred' | 'failed';
          let warning: string | undefined;
          try {
            if (project.origin === 'joined') { await leaveChat(channel, project.chatId); groupEffect = 'left'; }
            else { await transferOwnership(channel, project.chatId, owner); groupEffect = 'transferred'; }
          } catch (error) { groupEffect = 'failed'; warning = error instanceof Error ? error.message : '飞书群操作失败'; }
          return { ok: true, groupEffect, ...(warning ? { warning } : {}) };
        }
        const patch: Partial<Project> = {};
        if (request.directory !== undefined) {
          const cwd = await realpath(request.directory);
          if (!(await stat(cwd)).isDirectory()) throw new AdminWriteError('所选文件夹不是目录');
          patch.cwd = cwd;
          if (cwd !== project.cwd) patch.blank = false;
        }
        if (request.kind !== undefined) patch.kind = request.kind;
        if (request.enabled !== undefined) patch.enabled = request.enabled;
        const commit = () => mutateProject(project.name, latest => {
          if (projectRevision(latest) !== request.expectedRevision) throw new AdminWriteError('项目设置已改变，请刷新后重试');
          // Switching 会话方式 leaves 免@ as it was (3.4): pin the value it read as before. 智能 is not
          // offered here, so a stored one is kept when 单会话 comes back unchanged and dropped on a switch.
          if (patch.kind !== undefined && patch.kind !== ruleKind(latest)) {
            if (latest.noMention === undefined || latest.smart) latest.noMention = noMentionOf(latest);
            delete latest.smart;
          }
          Object.assign(latest, patch);
        });
        const archive = (patch.cwd !== undefined && patch.cwd !== project.cwd) || (patch.kind !== undefined && patch.kind !== ruleKind(project));
        const updated = archive ? await detachSessionsForChat(project.chatId, commit) : await commit();
        if (archive) expireRetries((retry) => retry.chatId === project.chatId); // its sessions start over
        for (const rec of records) {
          const thread = sessions.get(rec.threadId); sessions.delete(rec.threadId);
          if (thread) await thread.close().catch(error => log.fail('desktop', error, { phase: 'project-session-close' }));
        }
        return { ok: true, project: projectView(updated) };
      } finally { projectMutations.delete(project.chatId); }
    }
    if (projectMutations.has(project.chatId) || project.enabled === false) throw new AdminWriteError('项目已停用或正在修改');
    const perm = turnSession(project.chatId, project);
    if (request.action === 'resume') {
      if (request.backend !== be.id) throw new AdminWriteError('项目后端已改变');
      const available = await be.listThreads(project.cwd);
      if (!available.some(item => item.sessionId === request.sessionId)) throw new AdminWriteError('历史会话不属于当前项目');
      const current = await getProjectByName(project.name);
      if (!current || projectMutations.has(project.chatId) || projectRevision(current) !== projectRevision(project)) throw new AdminWriteError('项目已改变，请刷新后重试');
      const key = ruleKind(project) === 'single' ? perm.sessionKey : `desktop-resume:${project.chatId}`;
      if (active.has(key) || intakeChats.has(project.chatId) || pendingTopics.has(project.chatId)) throw new AdminWriteError('会话正在运行');
      const reserved: ActiveState = { queue: [], requesterOpenId: owner };
      active.set(key, reserved);
      if (ruleKind(project) !== 'single') resumePublications.add(project.chatId);
      let publishedKey: string | undefined;
      try {
        const history = await be.readHistory(project.cwd, request.sessionId);
        let threadId = key;
        if (ruleKind(project) === 'single') {
          await sendManagedCard(channel, project.chatId, buildHistoryCard({ cwd: project.cwd, projectName: project.name, backendName: backendLabel(be), history }));
        } else {
          const root = await channel.send(project.chatId, { markdown: '从桌面端恢复历史会话' });
          const sent = await sendManagedCard(channel, project.chatId, buildHistoryCard({ cwd: project.cwd, projectName: project.name, backendName: backendLabel(be), history }), root.messageId, true);
          const tid = await getThreadId(channel, sent.messageId, 4);
          if (!tid) throw new AdminWriteError('已创建话题，但飞书尚未返回话题标识；会话未绑定');
          noteOpenedTopic(project.chatId, tid, { id: root.messageId, from: { kind: 'self' }, at: Date.now(), text: resumedTitle(history) });
          threadId = turnSession(tid, project).sessionKey;
          if (active.has(threadId)) throw new AdminWriteError('新话题已有任务，会话未切换');
          active.set(threadId, reserved);
          publishedKey = threadId;
        }
        const old = sessions.get(threadId); sessions.delete(threadId); if (old) await old.close();
        lastUsage.delete(threadId);
        const now = Date.now();
        await upsertSession({ threadId, chatId: project.chatId, cwd: project.cwd, sessionId: request.sessionId, backend: be.id, summary: resumedTitle(history) || '(恢复会话)', createdAt: now, updatedAt: now });
        dropRetries(threadId);
        return { ok: true, threadId };
      } finally {
        resumePublications.delete(project.chatId);
        if (publishedKey && active.get(publishedKey) === reserved) active.delete(publishedKey);
        if (active.get(key) === reserved) active.delete(key);
        if (reserved.queue.length) await channel.send(project.chatId, { markdown: `切回期间收到的 ${reserved.queue.length} 条消息未执行，请重发。` });
      }
    }
    if (isRetiredKey(request.threadId)) throw new AdminWriteError(RETIRED_KEY_TEXT);
    const record = records.find(item => item.threadId === request.threadId);
    if (!record || record.detached) throw new AdminWriteError('此会话已归档或不属于当前项目，请开始新会话');
    const key = record.threadId;
    const state = active.get(key);
    if (request.action === 'context') return { threadId: key, usage: lastUsage.get(key) ?? null, run: state ? { id: runId(state), goal: state.isGoal === true, canStop: Boolean(state.interrupt), canEndGoal: Boolean(state.endGoal), canRemind: state.requesterOpenId === owner && shouldShowCompletionReminderButton(cfg) && !state.isGoal, reminderRequested: state.completionReminderRequested === true } : null };
    if (request.action === 'stop' || request.action === 'endGoal' || request.action === 'reminder') {
      if (!state || runId(state) !== request.runId) throw new AdminWriteError('原任务已经结束，请刷新');
      if (request.action === 'stop') { if (!state.interrupt) throw new AdminWriteError('任务正在准备，请稍后停止'); state.interrupt(); }
      else if (request.action === 'endGoal') { if (!state.endGoal) throw new AdminWriteError('当前不是目标任务'); state.endGoal(); }
      else {
        if (state.requesterOpenId !== owner || !shouldShowCompletionReminderButton(cfg) || state.isGoal) throw new AdminWriteError('仅任务发起人可设置本次完成提醒，且需开启手动提醒模式');
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
    const reserved: ActiveState = { queue: [], requesterOpenId: owner };
    active.set(key, reserved);
    let launched = false;
    let compacted: AgentThread | undefined;
    try {
      if (request.action === 'clear') {
        if (ruleKind(project) !== 'single' || key !== perm.sessionKey) throw new AdminWriteError('只有单会话群可以清空当前上下文');
        const fresh = await sessionBackend.startThread({ cwd: project.cwd, model: record.model, effort: record.effort, mode: perm.mode, network: perm.network });
        // The local clock, not a Feishu createTime like the other watermarks: this
        // is the main-area session, which no back-fill reads until s14 (it must
        // then allow for clock skew, or use the newest createTime it has).
        const now = Date.now();
        try { await upsertSession({ ...record, sessionId: fresh.sessionId, summary: '(新会话)', lastSeenAt: now, seen: undefined, from: now, recalls: undefined, createdAt: now, updatedAt: now }); }
        catch (error) { await fresh.close(); throw error; }
        const old = sessions.get(key); if (old) await old.close();
        trackSession(key, fresh); lastUsage.delete(key); dropRetries(key);
        return { ok: true, threadId: key };
      }
      const { thread } = await resolveThread(key, project.chatId, perm);
      if (!thread) throw new AdminWriteError('会话尚未开始');
      if (request.action === 'compact') {
        compacted = thread;
        const result = await thread.compact();
        if (result.usage) lastUsage.set(key, { used: result.usage.usedTokens, window: result.usage.contextWindow }); else lastUsage.delete(key);
        return { ok: true, threadId: key };
      }
      let replyTo: string | undefined;
      if (ruleKind(project) !== 'single') {
        const messages = await channel.rawClient.im.v1.message.list({ params: { container_id_type: 'thread', container_id: key, page_size: 1 } });
        replyTo = messages.data?.items?.[0]?.message_id;
        if (messages.code !== 0 || !replyTo) throw new AdminWriteError('无法定位原飞书话题，请在飞书确认话题仍然存在');
      }
      const root = await channel.send(project.chatId, { markdown: `桌面端启动目标：${request.objective}` }, replyTo ? { replyTo, replyInThread: true } : undefined);
      launched = true;
      void trackRun(launchGoalRun({ chatId: project.chatId, replyTo: root.messageId, thread, firstText: request.objective, knownThreadId: key, cwd: project.cwd, mode: perm.mode, network: perm.network, model: record.model, effort: record.effort, flat: ruleKind(project) === 'single', backendId: sessionBackend.id, requesterOpenId: owner, titleSource: { text: request.objective, rawContentType: 'text' } })).catch(error => log.fail('desktop', error));
      return { ok: true, threadId: key };
    } finally {
      if (!launched && active.get(key) === reserved) active.delete(key);
      releaseIdle(key, compacted);
      if (!launched && reserved.queue.length) await channel.send(project.chatId, { markdown: `操作期间收到的 ${reserved.queue.length} 条消息未执行，请重发。` });
    }
  }

  // ── shared run loop ───────────────────────────────────────────────
  async function sendCompletionReminder(input: CompletionReminderReplyInput): Promise<void> {
    await sendCompletionReminderReply({ channel, cfg, dedupe: completionReminderSent }, input);
  }

  interface LaunchOpts {
    voice?: VoiceReply;
    chatId: string;
    replyTo: string;
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
    summary?: string;
    /** first turn is a 🔁 重试: the original input it wraps (QueuedTurn.replayText) */
    replayText?: string;
    /** who triggered this run (for ⏹/⚙️ ownership gating) */
    requesterOpenId?: string;
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
  }

  /** The queue placeholder card's CardKit entity, handed to the run for in-place
   * reuse (占位卡→run 卡同一实体翻面，防闪烁). */
  interface QueuedCardHandle {
    stream: RunCardStream;
    msgId: string;
    /** The slot came while a shutdown began: the card says the bot stopped, as a cancel at shutdown does (s18c). */
    stopped: () => void;
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
        ...(!state.isGoal ? { completionReminder: completionReminderView(state) } : {}),
      });
    const q = sema.enqueue((pos) => {
      // 前面有人拿到槽/取消 → 原地刷新位置。走合并泵（非阻塞、合并、限频）。
      if (msgId) stream.streamCoalesced(channel, queueCard({ position: pos, cardKey: msgId }), null);
    });
    // Replied to where the queue card is (s18c), until a slot or a cancel ends the wait.
    state.waiting = {
      chatId: opts.chatId, messageId: opts.replyTo, at: opts.requestedAt ?? Date.now(),
      replyInThread: opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId)), place: opts.flat ? 'main' : 'topic',
    };
    try {
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
    } catch (err) {
      // 占位卡失败不阻断排队：没有卡只是不可见/不可取消，run 照常等槽。
      log.fail('card', err, { phase: 'queued-card' });
    }
    log.info('intake', 'run-queued', { position: q.position(), key: activeKey });
    /** The card's last word for a run that never starts. */
    const endCard = (): void => {
      if (!msgId) return;
      runsByCard.delete(msgId);
      runStreams.delete(msgId);
      completionReminderRefreshers.delete(msgId);
      // At shutdown nobody cancelled it: the card says the bot stopped, and the bot says so again once back (s18c).
      void trackTask(stream.updateCard(channel, queueCard({ cancelled: true, dropped: state.queue.length, ...(shuttingDown ? { stopped: true } : {}) })));
    };
    // 等待期 ⏹ = 移除 waiter + 释放预订。槽已到手的瞬间 cancel() 返回 false →
    // 让位给运行期 interrupt（launchRun 每轮重装）。
    state.interrupt = () => {
      if (!q.cancel()) return;
      state.intakeCancelled = true;
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
    return { release, queuedCard: msgId ? { stream, msgId, stopped: endCard } : undefined };
  }

  async function launchRun(
    opts: LaunchOpts,
    reaction?: RunReaction,
    onTopicCreated?: () => void,
  ): Promise<void> {
    if (shuttingDown) { reaction?.done(); await opts.thread.close(); return; }
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    // The turn's workspace: resolves relative image refs in the reply and is what
    // the session record stores (see LaunchOpts.cwd).
    const runCwd = opts.cwd ?? fallbackCwd;
    // Reuse the reservation handleTurn made for this session (so messages
    // queued during startup aren't lost); fall back to a fresh state otherwise.
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId, runLoop: true };
    state.thread = opts.thread;
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
    active.set(activeKey, state);
    if (opts.knownThreadId) trackSession(opts.knownThreadId, opts.thread);

    // M-3: 池满先排队（占位卡可见可取消）；null = 等待期被 ⏹ 取消，预订已释放。
    const slot = await acquireRunSlot(opts, state, activeKey, reaction);
    if (!slot) {
      dropCompact(state);
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
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: runCwd,
        sessionId: opts.thread.sessionId,
        backend: opts.backendId ?? DEFAULT_BACKEND_ID,
        titleJobKey: opts.titleJobKey,
        model: opts.model,
        effort: opts.effort,
        modelCustom: opts.modelCustom,
        summary: opts.summary ?? opts.firstText.slice(0, 80),
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
    const noteTurnFailure = (turn: QueuedTurn | undefined, failure: TurnFailure): void =>
      noteFailure({ chatId: opts.chatId, messageId: turn?.seen?.id ?? opts.replyTo, senderId: turn?.requesterOpenId ?? opts.requesterOpenId ?? '', createTime: turn?.requestedAt ?? 0 },
        opts.flat ? 'main' : 'topic', opts.backendId, failure);
    try {
      let currentTurn: QueuedTurn = {
        input: { text: opts.firstText, images: opts.images },
        voice: opts.voice,
        titleSource: opts.titleSource,
        requesterOpenId: opts.requesterOpenId,
        requestedAt: opts.requestedAt ?? Date.now(),
        summary: opts.summary,
        replayText: opts.replayText,
        seen: opts.seen,
        seenHow: opts.seenHow,
        streaming: opts.streaming,
        woven: opts.woven,
        seenExtra: opts.seenExtra,
        tableShown: opts.tableShown,
        recallsShown: opts.recallsShown,
        from: opts.from,
      };
      noted = currentTurn;
      // Recall notes a turn of this run said; only a queued turn says the newer ones (s15).
      const said = new Set(opts.recallsShown);
      let fromQueue = false;
      let replyTo = opts.replyTo;
      let replyInThread = opts.flat ? false : (opts.replyInThread ?? Boolean(opts.knownThreadId));
      for (;;) {
        let turnInput = currentTurn.input;
        state.requesterOpenId = currentTurn.requesterOpenId;
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
          turnInput = { ...turnInput, text: weaveRecordBlock(turnInput.text ?? '', { place, entries: [], now: Date.now(), table: rows, recalls: recallLines(notes) }) };
          if (rows.length) currentTurn.tableShown = true;
          currentTurn.recallsShown = notes.map((r) => r.id);
          for (const r of notes) said.add(r.id);
          log.info('intake', 'record-block', { place: main ? 'main' : 'topic', lines: 0, table: rows.length, recalls: notes.length });
        }
        const turnModel = rec?.model ?? opts.model;
        const turnEffort = rec?.effort ?? opts.effort;
        const modelDisp = getModelDisplay(cfg);
        const run = opts.thread.runStreamed(turnInput, { model: turnModel, effort: turnEffort });
        let unseen = currentTurn.seen;
        titleTurnAttempted = true;
        const turnStartAt = Date.now(); // turn/start 已在 runStreamed() 内发出（与下面的建卡并行）
        state.run = run;
        const render = new RunRender();
        render.seedUsage(meterOf(topicThreadId, rec, opts.thread));
        const cardEvents = new TurnCardEvents();
        state.steerReply = { run, accept: (messageId, voice) => cardEvents.accept(messageId, voice) };
        let boundary: RunState | undefined;
        let segmentStartedAt: number | undefined;
        const segmentSnapshot = (): RunState => runSegment(render.snapshot(), boundary, segmentStartedAt);
        render.showTools = getShowToolCalls(cfg);
        let cardMsgId: string | undefined;
        let rc: RunCardState = {
          rs: render.snapshot(),
          voiceMessages: currentTurn.voice ? [currentTurn.voice] : [],
          requesterOpenId: currentTurn.requesterOpenId,
          showTools: render.showTools,
          completionReminder: completionReminderView(state),
          ...(opts.backendId ? { backend: opts.backendId } : {}),
          // 模型显示档位：footnote 本轮 model·推理强度；always 档终态卡也保留。
          ...(modelDisp !== 'off' && turnModel
            ? { model: turnModel, effort: turnEffort, modelOnTerminal: modelDisp === 'always' }
            : {}),
          ...(opts.sessionNotice ? { sessionNotice: opts.sessionNotice } : {}),
        };

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
              if (opts.openTopic) noteOpenedTopic(opts.chatId, tid, opts.openTopic);
            }
          } else {
            topicThreadId = activeKey;
            rc.threadId = activeKey;
          }
        };

        // CardKit streaming entity: body streams with the native typewriter,
        // ⏹/⚙️ ride whole-card updates — both on one card_id (see RunCardStream).
        let stream = queuedCard?.stream ?? new RunCardStream();
        state.voiceReply = {
          run,
          add: (voice) => {
            const messages = (rc.voiceMessages ??= []);
            if (messages.some((v) => v.messageId === voice.messageId)) return;
            messages.push(voice);
            if (!cardMsgId) return; // The post-create frame picks it up below.
            if (rc.rs.terminal === 'running') stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
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
        const tCreate = Date.now();
        try {
          if (queuedCard) {
            // 占位卡→run 卡：同一 CardKit 实体 whole-card update 原地翻面（不闪
            // 烁、不留垃圾卡）。update 的 card JSON 带 streaming_mode=true；若该
            // 设置未随 update 生效，首次元素推送的 300309 自愈路径会重开
            // streaming 并重推（见 RunCardStream.streamElement）。
            cardMsgId = queuedCard.msgId;
            queuedCard = undefined; // 只复用一次；排队续轮照常新建卡
            await stream.updateCard(channel, buildRunCard(rc));
          } else {
            cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(rc), { replyTo, replyInThread });
          }
        } catch (err) {
          // turn/start 已提前发出：建卡失败时模型已在跑，必须中断并回收进程——
          // 无人消费的通知流会污染该 thread 的下一轮。turnId 此时多半还没到手
          // （事件尚未消费），abort 仅尽力而为；close() SIGKILL 子进程兜底终结
          // 这轮。下一条消息经 resolveThread 的 resume 兜底自愈。
          const tid = run.turnId();
          if (tid) void opts.thread.abort(tid).catch(() => undefined);
          void trackTask(opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' })));
          if (topicThreadId) sessions.delete(topicThreadId);
          throw err; // 外层 catch 把错误回给用户
        }
        const tCardCreate = Date.now() - tCreate; // 建卡 RTT（与模型推理并行付出）
        opts.sessionNotice = undefined; // shown; a failed create leaves it for the failure reply
        curCardKey = cardMsgId;
        rc.cardKey = cardMsgId;
        runsByCard.set(cardMsgId, state);
        runStreams.set(cardMsgId, stream);
        const registerReminder = (messageId: string, target: RunCardState, targetStream: RunCardStream): void => {
          completionReminderRefreshers.set(messageId, () => {
            target.completionReminder = completionReminderView(state);
            void trackTask(targetStream.updateLiveCard(channel, buildRunCard(target)));
          });
        };
        registerReminder(cardMsgId, rc, stream);
        // The entity is created before its carrier messageId exists, so the
        // initial JSON cannot self-route controls. Establish the first
        // self-addressed ⏹/🔔 row immediately instead of waiting for an agent
        // event (a long silent tool startup still needs both controls).
        stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
        await adoptThreadId(cardMsgId);
        // first card is live = topic created. The 群@bot 建话题 path flips its
        // reaction to DONE here (creating the topic is the acked action), unlike
        // an in-topic turn which holds Typing until the reply itself ends.
        if (!firstCardSent) {
          firstCardSent = true;
          try {
            onTopicCreated?.();
          } catch {
            /* reaction is best-effort */
          }
        }

        const splitCard = async (event: SteerCardEvent): Promise<void> => {
          const nextStream = new RunCardStream();
          const nextBoundary = render.snapshot();
          const nextStartedAt = Date.now();
          const next: RunCardState = {
            ...rc, rs: runSegment(nextBoundary, nextBoundary, nextStartedAt),
            cardKey: undefined, continued: false, localFiles: undefined, images: undefined, sessionNotice: undefined,
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
          rc = next;
          stream = nextStream;
          cardMsgId = nextId;
          curCardKey = nextId;
          rc.cardKey = nextId;
          runsByCard.set(nextId, state);
          runStreams.set(nextId, stream);
          registerReminder(nextId, rc, stream);
          attachRunImages({ stream, rc, channel,
            upload: sources => uploadOutboundImages(channel, sources, runCwd, opts.mode ?? DEFAULT_PERMISSION_MODE, opts.network ?? false) });
          stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
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
          await previousStream.finalizeCard(channel, buildRunCard(previous))
            .catch(err => log.fail('card', err, { phase: 'steer-card-finalize' }));
        };
        cardClock = setInterval(() => {
          if (rc.rs.terminal === 'running') stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
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
        let resolveStop!: () => void;
        const stopSignal = new Promise<void>((res) => {
          resolveStop = res;
        });
        const stopper = createGracefulInterrupt({
          turnId: () => run.turnId(),
          abort: (tid) => void opts.thread.abort(tid).catch(() => undefined),
          forceStop: resolveStop,
        });
        disposeInterrupt = stopper.dispose;
        state.interrupt = () => { state.intakeCancelled = true; stopper.interrupt(); };
        const idleMs = currentIdleMs();
        const idlePause = createIdlePause();
        state.idlePause = idlePause;
        const guarded = withIdleTimeout(
          run.events,
          idleMs,
          () => {
            timedOut = true;
          },
          stopSignal,
          run.lastActivity, // raw-notification liveness: a long shell command isn't "idle"
          idlePause,
        );
        // Per-turn stream-latency observability (file log `stream.timing`): locates
        // where a reply lags — first byte, backlog (lastEv vs done), push split, RTT.
        const tStart = Date.now();
        let firstEvAt = 0;
        let firstTextAt = 0;
        let lastEvAt = tStart;
        let evCount = 0;
        let textChars = 0;
        for await (const ev of cardEvents.consume(guarded)) {
          if (ev.type === 'steer_accepted') {
            await splitCard(ev);
            continue;
          }
          const tEv = Date.now();
          if (!firstEvAt) firstEvAt = tEv;
          const et = (ev as { type?: string }).type;
          if (et === 'turn_started') {
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
          render.apply(ev);
          // Track context usage for /context and the next turn's meter. Only
          // auto-compaction reaches the turn loop (a manual /compact drains its own
          // events); it shows as a line on this card, and Claude's post-compaction
          // count moves the meter too.
          if ((et === 'context_usage' || et === 'compaction') && topicThreadId) {
            const usage = render.snapshot().usage;
            if (usage) lastUsage.set(topicThreadId, usage);
          }
          if (ev.type === 'compaction' && ev.phase === 'end' && !ev.failed) markTopicsDue(topicThreadId, opts.chatId, opts.thread.sessionId);
          rc.rs = segmentSnapshot();
          // The global mode is live-editable. Re-evaluate on every structural /
          // answer frame so switching away from manual removes the button from
          // an already-running card instead of leaving a stale affordance.
          rc.completionReminder = completionReminderView(state);
          // Non-blocking: never stall event consumption on a round-trip. The pump
          // coalesces and routes the latest snapshot — answer text → element
          // typewriter (cardElement.content), structure → whole-card update.
          stream.streamCoalesced(channel, buildRunCard(rc), ANSWER_EID);
        }
        clearInterval(cardClock);
        cardClock = undefined;
        state.steerReply = undefined;
        state.idlePause = undefined;
        state.run = undefined; // completion-card I/O must queue, never steer into a finished turn
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

        const finalMsgId = cardMsgId;
        try {
          await adoptThreadId(finalMsgId);
          rc.cardKey = finalMsgId;

          // [重试] for a turn that went quiet or lost the model (product.md 3.12),
          // read from the settled render: a ⏹ wins over a timer that fired
          // while it waited. Not when follow-ups are queued: they run next and
          // would make a replay land out of order.
          let retryReason: RetryTurn['reason'] | undefined;
          if (rc.rs.terminal === 'idle_timeout') retryReason = 'idle';
          else if (rc.rs.terminal === 'error' && rc.rs.errorKind === 'network') retryReason = 'network';
          if (retryReason && topicThreadId && state.queue.length === 0) {
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
          const terminalCardUpdated = await stream.finalizeCard(channel, buildRunCard(rc));
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
          if (topicThreadId) {
            touchSession(topicThreadId); // 轮次收尾打点（M-3 reaper 的空闲时钟）
            await patchSession(topicThreadId, { updatedAt: Date.now(), ...savedMeter(topicThreadId, opts.thread) });
          }
          await sendCompletionReminder({
            cardMsgId: finalMsgId,
            requesterOpenId: currentTurn.requesterOpenId,
            outcome: rc.rs.terminal === 'running' ? 'done' : rc.rs.terminal,
            requestedAt: currentTurn.requestedAt,
            manuallyRequested,
            summary: currentTurn.summary,
            cardUpdated: terminalCardUpdated,
            replyInThread: !opts.flat,
          });
        } catch (err) {
          log.fail('card', err, { phase: 'terminal-delivery' });
          void trackTask(channel.send(opts.chatId, { markdown: '⚠️ 本轮已结束，但结果同步失败，请检查会话记录。' }, { replyTo: finalMsgId, replyInThread: !opts.flat }).catch(() => undefined));
        }
        retrySessionTitleAfterTurn();
        replyTo = finalMsgId;
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
        // 同样丢弃（语义与杀进程路径一致，只是进程不回收）。
        if (killed || procDead || interrupted || compactDied) {
          state.intakeCancelled = true;
          dropCompact(state);
          if (state.queue.length > 0) {
            void trackTask(channel
              .send(
                opts.chatId,
                { markdown: `⚠️ ${state.queue.length} 条排队消息已丢弃，请重发。` },
                { replyTo: finalMsgId, replyInThread: !opts.flat },
              )
              .catch(() => undefined));
            log.info('intake', 'queue-dropped', { depth: state.queue.length, killed, procDead, interrupted });
          }
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
      // Detach before any await: new messages must not join a failed consumer.
      if (active.get(activeKey) === state) active.delete(activeKey);
      const dropped = state.queue.splice(0).length;
      dropCompact(state);
      disposeInterrupt?.();
      state.run = undefined;
      state.interrupt = undefined;
      // A stream/card failure can leave an agent turn running. Retire that
      // client before the next message resumes the persisted session.
      if (topicThreadId && sessions.get(topicThreadId) === opts.thread) sessions.delete(topicThreadId);
      await opts.thread.close().catch(error => log.fail('agent', error, { phase: 'thread-close' }));
      log.fail('intake', err);
      noteTurnFailure(noted, { error: err });
      await channel
        .send(opts.chatId, { markdown: runFailureMessage(err, dropped, opts.sessionNotice) }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch((sendError) => log.fail('intake', sendError, { phase: 'run-failure-feedback', dropped }));
    } finally {
      // A replacement run may have reserved the key while failure feedback
      // was in flight. Never delete another run's reservation.
      if (active.get(activeKey) === state) active.delete(activeKey);
      releaseIdle(topicThreadId, opts.thread);
      settleTurn?.();
      clearInterval(cardClock);
      state.steerReply = undefined;
      state.voiceReply = undefined;
      if (curCardKey) {
        runsByCard.delete(curCardKey);
        completionReminderRefreshers.delete(curCardKey);
      }
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
    if (shuttingDown) { await opts.thread.close(); return; }
    const objective = opts.firstText;
    let activeKey = opts.knownThreadId ?? `pending:${opts.replyTo}`;
    let topicThreadId = opts.knownThreadId;
    // The goal's workspace — see LaunchOpts.cwd / launchRun's runCwd.
    const runCwd = opts.cwd ?? fallbackCwd;
    const state: ActiveState = active.get(activeKey) ?? { queue: [], requesterOpenId: opts.requesterOpenId };
    state.thread = opts.thread;
    state.isGoal = true; // messages during the goal get a prompt, never queue (handleTurn)
    if (opts.requesterOpenId) state.requesterOpenId = opts.requesterOpenId;
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
      await upsertSession({
        threadId,
        chatId: opts.chatId,
        cwd: runCwd,
        sessionId: opts.thread.sessionId,
        backend: opts.backendId ?? DEFAULT_BACKEND_ID,
        titleJobKey: opts.titleJobKey,
        model: opts.model,
        effort: opts.effort,
        modelCustom: opts.modelCustom,
        summary: opts.summary ?? objective.slice(0, 80),
        ...(opts.seenAt ? nextSeen({}, { id: opts.replyTo, at: opts.seenAt }, 'advance') : {}),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }).catch((err) => log.fail('console', err, { phase: 'persist-session', threadId }));
    };

    // One streaming run card per codex turn. `cur` is the in-flight turn's render
    // context (null between turns); assigned directly in the loop so TS narrows it.
    // `stream`/`cardMsgId` are null until the turn produces real output — a card is
    // sent LAZILY on first content, so a planning-only turn leaves no empty box.
    type GoalTurnCtx = { render: RunRender; rc: RunCardState; stream: RunCardStream | null; cardMsgId: string | null; clock?: ReturnType<typeof setInterval> };
    let cur: GoalTurnCtx | null = null;
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
          if (opts.openTopic) noteOpenedTopic(opts.chatId, tid, opts.openTopic);
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
    const finalizeCard = async (ctx: GoalTurnCtx | null): Promise<void> => {
      if (!ctx || !ctx.stream || !ctx.cardMsgId) return;
      clearInterval(ctx.clock);
      ctx.clock = undefined;
      await ctx.stream.drain();
      ctx.render.finalize();
      ctx.rc.rs = ctx.render.snapshot();
      const answerText = finalMessageText(ctx.rc.rs);
      ctx.rc.localFiles = await outboundFiles.prepare(answerText, {
        messageId: ctx.cardMsgId, chatId: opts.chatId, cwd: runCwd,
        mode: opts.mode ?? DEFAULT_PERMISSION_MODE, requesterOpenId: opts.requesterOpenId,
        replyInThread: !opts.flat, cardId: ctx.stream.getCardId(),
      }, (elementId, element) => ctx.stream!.updateElement(channel, elementId, element));
      ctx.rc.images = await ctx.stream.settleImages(answerText);
      await ctx.stream.updateCard(channel, buildRunCard(ctx.rc));
      runsByCard.delete(ctx.cardMsgId);
      promoteCard(ctx.cardMsgId, ctx.rc);
    };

    /** Begin a turn's render context WITHOUT sending a card yet. */
    const startTurn = (): GoalTurnCtx => {
      const render = new RunRender();
      render.seedUsage(topicThreadId ? lastUsage.get(topicThreadId) : undefined);
      render.showTools = getShowToolCalls(cfg);
      const goalModelDisp = getModelDisplay(cfg);
      const rc: RunCardState = {
        rs: render.snapshot(),
        requesterOpenId: opts.requesterOpenId,
        showTools: render.showTools,
        goalControls: true,
        ...(opts.backendId ? { backend: opts.backendId } : {}),
        ...(goalModelDisp !== 'off' && opts.model
          ? { model: opts.model, effort: opts.effort, modelOnTerminal: goalModelDisp === 'always' }
          : {}),
        ...(opts.sessionNotice ? { sessionNotice: opts.sessionNotice } : {}),
      };
      return { render, rc, stream: null, cardMsgId: null };
    };

    /** Send this turn's streaming card on first real content (idempotent). */
    const ensureCard = async (ctx: GoalTurnCtx): Promise<void> => {
      if (ctx.stream) return;
      const stream = new RunCardStream();
      attachRunImages({
        stream,
        rc: ctx.rc,
        channel,
        upload: (sources) => uploadOutboundImages(channel, sources, runCwd, opts.mode ?? DEFAULT_PERMISSION_MODE, opts.network ?? false),
      });
      const cardMsgId = await stream.create(channel, opts.chatId, buildRunCard(ctx.rc), { replyTo, replyInThread });
      ctx.rc.cardKey = cardMsgId;
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
      const run = opts.thread.runGoal(objective);
      state.run = run;
      // ⏹ 终止: clear the goal first (so it won't reactivate on resume), then end
      // the loop immediately — cutting the in-flight turn's output.
      state.interrupt = () => {
        if (interrupted) return;
        interrupted = true;
        void opts.thread.clearGoal().catch(() => undefined);
        resolveStop();
      };
      // 🎯 结束目标: clear the goal so codex stops auto-continuing, but let the
      // in-flight turn finish. With no turn in flight, end now; otherwise the
      // `done` branch below breaks the loop after the current turn completes.
      state.endGoal = () => {
        if (goalEnded || interrupted) return;
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
      // One watchdog spans every auto-continued turn, so its pause is reset at
      // each turn boundary: a hold never carries into the next turn.
      const idlePause = createIdlePause();
      state.idlePause = idlePause;
      const guarded = withIdleTimeout(run.events, GOAL_IDLE_MS, () => {
        idledOut = true;
      }, stop, run.lastActivity, idlePause);
      let unseen = opts.seen; // marked once the host starts the goal's first turn (see launchRun)
      for await (const ev of guarded) {
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
          if (ev.type === 'compaction' && ev.phase === 'end' && !ev.failed) markTopicsDue(topicThreadId, opts.chatId, opts.thread.sessionId);
          continue;
        }
        if (ev.type === 'turn_started') {
          idlePause.reset();
          if (unseen && topicThreadId) markSeen(topicThreadId, unseen, opts.seenHow);
          unseen = undefined;
          // Unlike runGoal() construction, this proves the host accepted and
          // started the goal's first turn. Generate in parallel from here.
          beginGoalSessionTitle();
          if (topicThreadId) requestGoalSessionTitleApply();
          await finalizeCard(cur); // close the previous turn's card (if it produced one)
          cur = startTurn(); // render-only; the card is sent lazily on first content
          continue;
        }
        if (ev.type === 'done') {
          idlePause.reset();
          // turn/completed for an intermediate turn — finalize its card (if any).
          // codex auto-continues with the next turn (a terminal goal status, handled
          // after the loop, preempts the final turn's done).
          if (cur) {
            cur.render.apply(ev);
            await finalizeCard(cur);
            cur = null;
          }
          // 🎯 结束目标: the goal was cleared mid-turn; that turn is now done and
          // codex won't auto-continue, so stop here (codex emits no terminal we'd
          // otherwise wait on — goal/cleared is ignored by the event map).
          if (goalEnded) break;
          continue;
        }
        if (ev.type === 'error') {
          // A retry notice (the backend is retrying the call itself) is not why
          // the goal ended; keep it off the summary card.
          if (!ev.willRetry) goalErrorMsg = ev.message;
          if (!cur) continue; // set-failure before any turn → terminal card only
        }
        if (!cur) cur = startTurn();
        cur.render.apply(ev);
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
        cur.stream!.streamCoalesced(channel, buildRunCard(cur.rc), ANSWER_EID);
      }
      state.idlePause = undefined;
      // ⏹ 终止: mark the in-flight turn's card as interrupted before finalizing
      // (finalize() is a no-op once terminal, so this doesn't clash).
      if (interrupted && cur) cur.render.interrupt();
      await finalizeCard(cur);
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
      log.fail('intake', err);
      await channel
        .send(opts.chatId, { markdown: runFailureMessage(err, 0, opts.sessionNotice) }, { replyTo: opts.replyTo, replyInThread: !opts.flat })
        .catch(() => undefined);
    } finally {
      state.idlePause = undefined;
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
          try {
            if (shuttingDown) return;
            const thread = await resolveDocThread(sessionKey, cwd, instructions, ctx.question);
            if (shuttingDown) { await thread.close(); return; }
            const rec = await getSession(sessionKey);
            const run = thread.runStreamed({ text: prompt }, { model: rec?.model, effort: rec?.effort });

            let state: RunState = initialState;
            let timedOut = false;
            const idleMs = currentIdleMs();
            const guarded = withIdleTimeout(run.events, idleMs, () => {
              timedOut = true;
            }, undefined, run.lastActivity);
            for await (const ev of guarded) state = reduce(state, ev);

            if (timedOut) {
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
  ): Promise<AgentThread> {
    const comments = getCommentsConfig(cfg);
    const be = backendFor(comments.backend);
    const { model, effort } = pickDefault(await listModels(be), { model: comments.model, effort: comments.effort });
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
        const resumed = await be.resumeThread({ cwd: rec.cwd, sessionId: rec.sessionId, model, effort });
        // 评论的模型来自评论设置，不是手填的
        await patchSession(sessionKey, { model, effort, modelCustom: false });
        trackSession(sessionKey, resumed);
        commentInstrUsed.set(sessionKey, instructions);
        return resumed;
      } catch (err) {
        log.fail('agent', err, { phase: 'comment-resume', sessionKey });
      }
    }
    const fresh = await be.startThread({ cwd, model, effort });
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

  const pendingGroups = createPendingGroups({
    file: pendingGroupsFile(paths.projectsFile),
    eligible: async ({ chatId, operator }) => isAdmin(cfg, operator) && !(await getProjectByChatId(chatId)),
    verify: async chatId => {
      const membership = await channel.rawClient.im.v1.chatMembers.isInChat({ path: { chat_id: chatId } });
      if (membership.code !== 0 || typeof membership.data?.is_in_chat !== 'boolean') throw new Error('无法确认机器人群成员身份');
      if (!membership.data.is_in_chat) return { state: 'retry' };
      const info = await channel.getChatInfo(chatId);
      if (info.chatType !== 'group' || (channel.botIdentity?.openId && info.ownerId === channel.botIdentity.openId)) return { state: 'ignore' };
      const name = info?.name?.trim();
      if (!name) throw new Error('无法读取飞书群名称');
      return { state: 'ready', name };
    },
    onError: error => log.fail('intake', error, { phase: 'pending-groups' }),
  });
  void trackTask(pendingGroups.refresh());
  const pendingGroupTimer = setInterval(() => { void trackTask(pendingGroups.refresh()); }, 15_000);
  pendingGroupTimer.unref();

  /**
   * `botAdded` event: a human added the bot to a group. If the adder is an admin
   * (binding ties the group to a cwd on the operator's machine — privileged) and
   * the group isn't already bound, DM them a bind card with the project name
   * pre-filled from the group name. Groups the bridge created itself are already
   * registered (or added by the bot, not an admin), so they fall through.
   */
  async function onBotAddedToChat(evt: BotAddedEvent): Promise<void> {
    // The SDK fires botAdded fire-and-forget (no await around the handler), so a
    // rejection here would surface as an unhandled rejection — guard the whole
    // body (getProjectByChatId can throw on a corrupt/locked projects.json).
    await withTrace({ chatId: evt.chatId }, async () => {
      const op = evt.operator?.openId;
      if (await getProjectByChatId(evt.chatId)) {
        log.info('intake', 'bot-added-bound', { chatId: evt.chatId.slice(-6) });
        return;
      }
      if (!op || !isAdmin(cfg, op)) {
        log.info('intake', 'bot-added-nonadmin', { chatId: evt.chatId.slice(-6), op: op?.slice(-6) });
        return;
      }
      await pendingGroups.add(evt.chatId, op).catch(error => log.fail('intake', error, { phase: 'pending-group-add' }));
      void trackTask(pendingGroups.refresh());
      // Best-effort group name (needs im:chat:readonly); the bind card's name is
      // editable, so an empty/failed lookup just means the admin types one.
      const info = await channel.getChatInfo(evt.chatId).catch((err) => {
        log.fail('intake', err, { phase: 'bot-added-chatinfo' });
        return undefined;
      });
      const name = (info?.name ?? '').trim();
      await sendManagedCard(
        channel,
        op,
        buildJoinGroupFormCard({ chatId: evt.chatId, name, backends: backendOptionsFor('full') }),
        undefined,
        false,
        'open_id',
      ).catch((err) => log.fail('intake', err, { phase: 'bot-added-bindcard' }));
      log.info('intake', 'bot-added', { chatId: evt.chatId.slice(-6), op: op.slice(-6), named: Boolean(name) });
    }).catch((err) => log.fail('intake', err, { phase: 'bot-added' }));
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
      if (!isChatAllowed(cfg, rec.chatId) || !isUserAllowedInProject(cfg, project, op)) return;
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
   * 非管理员回拒绝文案（同 handleDmConsole 语义）。事件不带 chat_id，发送走
   * receive_id_type=open_id。
   */
  const onBotMenu = async (evt: { openId?: string; eventKey?: string; eventId?: string }): Promise<void> => {
    const op = evt.openId;
    if (!op) return;
    // raw-tap 绕过 SDK 的内建去重（at-least-once 重推会双开菜单卡）——有 event_id
    // 就按它去重；没有则照常放行（同一菜单点两下本就该出两张卡）。
    if (evt.eventId && seenInbound.seen(`menu:${evt.eventId}`)) return;
    log.info('intake', 'bot-menu', { key: evt.eventKey, op: op.slice(-6) });
    if (!isAdmin(cfg, op)) {
      await channel.rawClient.im.v1.message
        .create({
          params: { receive_id_type: 'open_id' },
          data: {
            receive_id: op,
            msg_type: 'text',
            content: JSON.stringify({ text: '⛔ 仅管理员可在私聊里管理项目。' }),
          },
        })
        .catch(() => undefined);
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
      for (const held of state.deferred ?? []) lost.push(held.origin);
      // Where dropCompact would answer it.
      if (state.compactAfter) lost.push(originOf(state.compactAfter.msg, !state.compactAfter.inThread));
      if (state.waiting) lost.push(state.waiting);
    }
    return lost;
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    // Written at once, before anything is cleared below and long before the Codex processes end or the lock goes.
    droppedReplies?.saveSync(collectLost(), 'shutdown');
    for (const stop of onStop) stop();
    clearInterval(pendingGroupTimer);
    clearInterval(reaper);
    const cleanup: Promise<unknown>[] = [];
    const startCleanup = (operation: () => Promise<unknown>): void => {
      try { cleanup.push(operation()); }
      catch (error) { shutdownErrors.add(error); }
    };
    startCleanup(closeOwnedCodexProcesses);
    startCleanup(shutdownResidentClients);
    const dropped = { queued: 0, held: 0, compacts: 0 };
    for (const state of active.values()) {
      state.intakeCancelled = true;
      dropped.queued += state.queue.length;
      dropped.held += state.deferred?.length ?? 0;
      if (state.compactAfter) dropped.compacts++;
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
    const live = [...new Set(sessions.values())];
    sessions.clear();
    for (const thread of live) startCleanup(() => thread.close());
    const cleanupResults = Promise.allSettled(cleanup);
    shutdownPromise = (async () => {
      while (acceptedTasks.size || runTasks.size) {
        const results = await Promise.allSettled([...acceptedTasks, ...runTasks]);
        for (const result of results) if (result.status === 'rejected') shutdownErrors.add(result.reason);
      }
      for (const result of await cleanupResults) if (result.status === 'rejected') shutdownErrors.add(result.reason);
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

  const settings = createSettingsOwner({ cfg, backendFor, evictLiveSessionsForChat, writePreferences, voiceAction: voice.action, refreshCompletionReminders: refreshCompletionReminderCards });
  const executeAdminWrite = createAdminWriteExecutor({ cfg, backendFor, evictLiveSessionsForChat, writePreferences, voiceAction: voice.action, settings });
  const adminExecute = async (op: AdminWriteOp): Promise<AdminWriteResult> => {
    const result = await executeAdminWrite(op);
    if (op.kind === 'setCompletionReminder') refreshCompletionReminderCards();
    return result;
  };

  return {
    collaboration: admit(collaboration),
    onMessage: admitEvent(onMessage),
    onComment: admitEvent(onComment),
    onBotAddedToChat: admitEvent(onBotAddedToChat),
    onBotRemovedFromChat: admitEvent(onBotRemovedFromChat),
    onReaction: admitEvent(onReaction),
    onBotMenu: admitEvent(onBotMenu),
    onRecall: admitEvent(onRecall),
    dispatcher,
    adminExecute: admit(adminExecute),
    settings: { read: admit(settings.read), save: admit(settings.save), models: admit(settings.models), act: admit(settings.act) },
    shutdown,
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
