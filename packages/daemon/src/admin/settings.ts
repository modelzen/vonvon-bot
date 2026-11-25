import { getAppRoleSnapshot, trustedFeishuAdmins } from '../config/app-roles';
import { readRefused } from '../bot/dm-refused';
import { adminCandidates } from './admin-candidates';
import { ToolRefusal } from '../agent/entry/tools';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DEFAULT_DM_SMART_RULES, FULL_ACCESS_WARNING, JUDGE_SELECTION_KINDS, decisionEndpointProblem } from '@vonvon/protocol';
import type { AgentBackend, ModelInfo, ReasoningEffort } from '../agent/types';
import { backendIds } from '../agent';
import { parseModelId } from '../agent/model-id';
import { permissionTable, PermissionInputError, tableEnv, tierInfo, TIER_NETWORK } from '../agent/permission';
import { getCompletionReminderConfig, getMaxConcurrentRuns, getPendingPolicy, getRunIdleTimeoutMs, getSessionTitleConfig, getSessionTitleEfforts, type AppConfig, type AppPreferences } from '../config/schema';
import { paths } from '../config/paths';
import { admitDirectorySettings, resolveProjectsRootDir } from '../config/directories';
import { botBackendId, groupBackendId, groupPermission, resolveCommentsExecution, resolveModelPreference, resolveProjectModelAccess, projectModelAllowed, projectSpeedAllowed } from '../config/execution';
import { isProjectId } from '../project/library';
import { dmChatId, effectiveMode, getProjectByChatId, getProjectByName, listProjects, mutateProject, mutateProjectByChatId, noMentionOf, pendingPolicyOf, sessionModeOf, type Project, type ProjectWorkspace } from '../project/registry';
import { getSession, listSessions, isRetiredKey, mutateSession, RETIRED_KEY_TEXT, type SessionRecord } from '../bot/session-store';
import { currentCommentInstructions, DEFAULT_COMMENT_INSTRUCTIONS, saveCommentInstructions, syncAllCommentInstructions } from '../bot/comments';
import { voiceView } from '../voice/view';
import { keyStatus } from './secrets';
import { DECISION_FORMAT_LINES, DECISION_INPUT_EXAMPLE, decisionProvider, decisionProviders, keyMissingText } from '../judge/decision';
import { DECISION_PROVIDER_ID, parseStoredJudge, resolveJudgeModel, judgeBackendId } from '../judge/model';
import { JUDGE_CLAUDE_NOTE, JUDGE_CODEX_NOTE, JUDGE_FORMAT_LINES, JUDGE_INPUT_EXAMPLE } from '../judge/prompt';
import { readSmartPrompt, SMART_MAX_CHARS, SmartPromptError, composeSmartRules, resolveSmartRules, rulesFromSmartPrompt } from '../judge/smart-file';
import type { JudgeSelectionStored } from '../judge/types';
import { VoiceActionRefused, type VoiceAction } from '../voice/types';
import { probeBackends, SMART_NO_MENTION_REFUSED, type AppPreferencesWriter } from './ops';
import { parseSettingsAction, parseSettingsEdit, SettingsInputError } from './settings-parse';
import type * as T from './settings-types';
import { offlineModelCatalog, rememberModelCatalog } from './model-catalog';
import { log } from '../core/logger';
import { supplementOf } from '../bot/context-assembly';
import { botFiles, readRole, readSoulText, readText, roleDraft, roleProblem, updateRole, waitForBotFiles } from '../bot/role-files';
import { loadBots } from '../config/bots';
import { discoverBuiltinGroupSkills, discoverGroupSkills, discoverLocalGroupSkills } from '../agent/group-skills';
import { snapshotDefaultJudge, snapshotProviderJudge, requireDecisionKey } from '../project/initial-settings';
import { readJudgeModels } from '../judge/global-models';
import { assertValidCardDisplay } from '../card/card-display-validation';
export type * from './settings-types';
export { parseSettingsAction, parseSettingsEdit, parseSettingsScope, parseModelQuery, SettingsInputError } from './settings-parse';
export function settingsRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function isLocalSettingsSection(kind: string, section: string): boolean {
  return kind === 'agent' ? section === 'profile' || section === 'role' : kind === 'project' && ['profile', 'role', 'modelAccess', 'workspace', 'smartRules', 'skills', 'presentation', 'judge', 'permission', 'response', 'run', 'conversation'].includes(section);
}
const writable: T.SettingsAccess = {
  kind: 'writable'
};
/** `settings set response.*` on a 智能 group (s25c): the command line prints it after "没有保存：settings：". */
const SMART_RESPONSE_REFUSED = `${SMART_NO_MENTION_REFUSED}。要用免 @，先在网页把会话方式改成多会话或单会话`;

export const offlineSettings: T.SettingsAccess = {
  kind: 'readonly',
  reason: 'owner-offline',
  message: '这个 Bot 没在运行，运行起来后才能改设置'
};
/** 补充职责写入时的上限（记忆设计 2.2）；读取不校验。 */
const SUPPLEMENT_MAX = 5_000;
export interface SettingsOwnerDeps {
  /** the Feishu app name for the role draft; read from the bot registry when absent */
  botName?: string;
  responseRoster?: (chatId: string) => Promise<import("@vonvon/protocol").ResponseRoster>;
  cfg: AppConfig;
  /** Local stopped-Bot editing uses cached catalogs only, never starts a provider. */
  offline?: boolean;
  localEditing?: boolean;
  discoverSkills?: typeof discoverGroupSkills;
  writePreferences: AppPreferencesWriter;
  /**
   * Told once a person's off the list (dm-agent 3.3 steps 3 to 5), in this Bot process, after the write; a failure is only
   * logged. D2 stops the turns of their private chat, clears its queue and revokes its sessions' tokens, C2 pauses their
   * private-chat tasks; until then nobody passes this.
   */
  adminRemoved?(openId: string): void | Promise<void>;
  /** open_id → name, read from Feishu for the administrators page; absent in a stopped Bot, which cannot ask */
  personNames?: (openIds: readonly string[]) => Promise<ReadonlyMap<string, string>>;
  backendFor: (id: string) => AgentBackend;
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
  voiceAction?: (action: VoiceAction) => Promise<void>;
  refreshCompletionReminders?: () => void;
  access?: T.SettingsAccess;
  runningConcurrency?: number;
  readProject?: typeof getProjectByName;
  /** the private-chat row, which no name reaches; `readProject` and `mutateProject` only take groups */
  readChatProject?: typeof getProjectByChatId;
  listProjects?: typeof listProjects;
  readSessions?: typeof listSessions;
  readSession?: typeof getSession;
  mutateProject?: typeof mutateProject;
  mutateChatProject?: typeof mutateProjectByChatId;
  mutateSession?: typeof mutateSession;
  /** tests point it at a temporary bot directory */
  readSmartPrompt?: (appId: string, chatId?: string) => ReturnType<typeof readSmartPrompt>;
  /** the keystore, for whether a decision model's key is filled in */
  getSecret?: (id: string) => Promise<string | undefined>;
  /** The shared decision profiles, including a custom service's machine-wide endpoint. */
  readJudgeModels?: typeof readJudgeModels;
  instructions?: {
    read(): Promise<string>;
    save(text: string): Promise<void>;
    sync(text: string): Promise<number>;
  };
}
function effect(fields: string[], when: T.ApplyEffect['when'], detail: string): T.ApplyEffect[] {
  return [{
      fields,
      when,
      detail
    }];
}
/** What `settings save.project` takes for the private chat (dm-agent 4.2): its tier and folder are fixed, and the group-only sections are not its. */
const DM_SECTIONS: ReadonlySet<string> = new Set<keyof T.ProjectSections>(['model', 'speed', 'modelAccess', 'skills', 'smartRules', 'judge', 'conversation', 'run', 'presentation']);
const DM_ONLY_THESE = '私聊只能改模型、速度、可选模型、技能、沟通方式、判断规则、决策模型、运行中来了消息和消息与提醒';
const DM_FIXED: T.SettingsAccess = { kind: 'readonly', reason: 'dm-fixed', message: `私聊只有完全访问一档，目录也是固定的。${DM_ONLY_THESE}。` };
const agentEffects: {
  [K in keyof T.AgentSections]: T.ApplyEffect[];
} = {
  profile: effect(['persona', 'memory'], 'next-turn', '下一轮对话使用新的个性与记忆'),
  role: effect(['identity', 'notes'], 'next-turn', '下一轮对话使用新的角色设定'),
  run: [...effect(['maxConcurrentRuns'], 'restart', '已保存的并发上限在 daemon 重启后生效'), ...effect(['pendingPolicy'], 'next-message', '下一条消息生效'), ...effect(['runIdleTimeoutSeconds'], 'next-turn', '下一次超时检测生效')],
  completion: effect(['mode', 'longTaskMinutes'], 'task-completion', '任务结束时读取最新策略'),
  comments: effect(['backend', 'selection'], 'new-comment', '下一条评论使用新设置'),
  titles: effect(['policy'], 'new-session', '只影响之后新建的会话'),
  paths: effect(['projectsRootDir'], 'new-project', '只影响之后新建的群'),
  access: effect(['allowedChats'], 'next-message', '下一条消息使用新权限'),
  judge: effect(['selection'], 'next-message', '智能模式的下一次判断就用新模型'),
};
/** What else each backend's judge model sees (`smartPrompt.backendNote`). */
const JUDGE_NOTES: Record<string, string> = { 'codex-appserver': JUDGE_CODEX_NOTE, 'claude-agent': JUDGE_CLAUDE_NOTE };
/** A stored judge setting, or nothing when unset or unusable (the judge ignores those too). */
function storedJudge(value: unknown): JudgeSelectionStored | undefined {
  return parseStoredJudge(value, backendIds()).value;
}
function isDecisionSelection(value: T.JudgeSelectionView | undefined): boolean {
  if (!value || (value.kind !== 'decision' && value.kind !== 'provider')) return false;
  return typeof value.provider === 'string' && (value.kind === 'decision' || !!decisionProvider(value.provider));
}
/** The judge setting a view shows: what the judge reads; a kind this version does not know as stored,
 * so it shows and is never rewritten (v1-plan 第 5 节"旧客户端读到决策模型"); anything else unusable
 * as default, which is what the judge then uses. Such a kind goes out whole to every client that
 * reads the view, so no kind may keep a credential in its selection (keys live in secrets.enc,
 * s23g). One over 4,000 characters of JSON shows as default, with no "unknown kind" line. */
function storedJudgeView(value: unknown): T.JudgeSelectionView {
  const parsed = storedJudge(value);
  if (parsed)
    return parsed;
  const kind = (value as { kind?: unknown } | null)?.kind;
  const unknownKind = typeof value === 'object' && !Array.isArray(value) && typeof kind === 'string' && kind.length > 0 && kind.length <= 100 && !JUDGE_SELECTION_KINDS.includes(kind);
  return unknownKind && JSON.stringify(value).length <= 4000 ? structuredClone(value as T.JudgeSelectionView) : { kind: 'default' };
}
function selection(model?: string, effort?: ReasoningEffort, custom?: boolean): T.ModelSelection {
  return model ? {
    kind: 'explicit',
    model,
    effort: effort ?? 'medium',
    ...(custom ? { custom: true } : {})
  } : {
    kind: 'default'
  };
}
function applySelection(target: {
  model?: string;
  effort?: ReasoningEffort;
}, value: T.ModelSelection): void {
  if (value.kind === 'default') {
    delete target.model;
    delete target.effort;
  }
  else {
    target.model = value.model;
    target.effort = value.effort;
  }
}
function agentData(cfg: AppConfig): T.AgentSections {
  const p = cfg.preferences ?? {};
  const {mode, longTaskMinutes} = getCompletionReminderConfig(cfg);
  return {
    profile: { persona: '', memory: '' },
    role: { identity: '', notes: '' },
    run: {
      maxConcurrentRuns: getMaxConcurrentRuns(cfg),
      pendingPolicy: getPendingPolicy(cfg),
      runIdleTimeoutSeconds: (getRunIdleTimeoutMs(cfg) ?? 0) / 1000
    },
    completion: {mode, longTaskMinutes},
    comments: {
      backend: resolveCommentsExecution(p).backend,
      selection: selection(p.comments?.model, p.comments?.effort)
    },
    titles: {
      policy: getSessionTitleConfig(cfg)
    },
    paths: {
      projectsRootDir: p.projectsRootDir ?? null
    },
    access: {
      allowedChats: [...(p.access?.allowedChats ?? [])]
    },
    judge: {
      selection: storedJudgeView(p.judge)
    },
  };
}
function agentRaw(p: AppPreferences, section: keyof T.AgentSections): unknown {
  switch (section) {
    case 'run': return [p.maxConcurrentRuns, p.runIdleTimeoutSeconds, p.pendingPolicy];
    case 'completion': return [p.completionReminder?.mode, p.completionReminder?.longTaskMinutes];
    case 'comments': return [p.comments?.backend, p.comments?.model, p.comments?.effort];
    case 'titles': return [p.defaults?.backend, p.sessionTitles?.policy, p.sessionTitles?.byBackend];
    case 'paths': return p.projectsRootDir ?? null;
    case 'access': return p.access?.allowedChats ?? [];
    case 'judge': return p.judge;
  }
}
function projectData(p: Project, backend: AgentBackend): T.ProjectSections {
  const perm = groupPermission(p);
  const table = permissionTable(groupBackendId(p));
  const env = { ...tableEnv(backend), group: true };
  return {
    profile: p.profile ?? { persona: '', memory: '', inheritPersona: true, inheritMemory: true },
    role: { supplement: p.supplement ?? '' },
    modelAccess: resolveProjectModelAccess({ group: p }),
    workspace: workspaceOf(p),
    smartRules: resolveSmartRules(p.smartRules ?? { respond: '', newTopic: '' }),
    skills: p.skills ?? { disabledPaths: [] },
    presentation: p.presentation ?? { voiceEnabled: false, showToolCalls: true, showModel: 'off', completionMode: 'manual', longTaskMinutes: 5 },
    permission: {
      mode: perm.tier,
      custom: perm.custom ?? null,
      guestMode: perm.tier,
      network: perm.effect.network,
      options: {
        tiers: [...table.tiers(env)], strength: table.strength(env),
        fields: table.fields(env), expanded: { qa: table.expand('qa'), write: table.expand('write'), full: table.expand('full') },
        ...(perm.custom ? { customSummary: table.describe(perm.custom) } : {}),
        ...(perm.legacy ? { legacy: true } : {}),
        ...(perm.invalid ? { invalid: true } : {}),
      }
    },
    response: {
      noMention: noMentionOf(p)
    },
    conversation: { mode: sessionModeOf(p) === 'smart' ? 'smart' : 'single' },
    model: {
      selection: selection(p.defaultModel, p.defaultEffort, p.defaultModelCustom)
    },
    speed: { tier: p.serviceTier ?? 'inherit' },
    run: {
      pendingPolicy: p.pendingPolicy ?? 'default'
    },
    judge: {
      selection: storedJudgeView(p.judge)
    }
  };
}
export function workspaceOf(p: Project): ProjectWorkspace {
  return { primary: p.cwd, directories: [p.cwd, ...p.directories?.workspaces?.additional ?? []], repositories: p.directories?.repositories ?? [] };
}
/** The revision a project's workspace section carries, for the host's save through the library (settings-service.ts). */
export function workspaceRevision(botId: string, p: Project): string {
  return settingsRevision([botId, projectRaw(p, 'workspace')]);
}
function projectRaw(p: Project, section: keyof T.ProjectSections): unknown {
  if (section === 'speed') return [p.name, p.chatId, p.backend, p.serviceTier];
  if (section === 'role') return [p.name, p.chatId, p.supplement ?? null];
  if (section === 'workspace') return [p.name, p.chatId, p.cwd, p.directories];
  if (section === 'modelAccess') return [p.name, p.chatId, p.modelAccess, p.defaultModel, p.defaultEffort];
  if (['profile', 'smartRules', 'skills', 'presentation'].includes(section)) return [p.name, p.chatId, p[section as 'profile']];
  const data = section === 'permission' ? [p.mode, p.network, p.custom] : section === 'response' ? p.noMention : section === 'conversation' ? p.smart : section === 'run' ? p.pendingPolicy : section === 'judge' ? p.judge : [p.defaultModel, p.defaultEffort, p.defaultModelCustom === true];
  return [p.name, p.chatId, p.cwd, p.backend, data];
}
function sessionRaw(s: SessionRecord): unknown {
  return [s.threadId, s.backend, s.sessionId, s.chatId, s.model, s.effort, s.modelCustom === true];
}
function sessionSpeedRaw(s: SessionRecord): unknown {
  return [s.threadId, s.backend, s.sessionId, s.chatId, s.serviceTier];
}
function makeSection<V>(stored: V, raw: unknown, access: T.SettingsAccess, apply: T.ApplyEffect[], effective = stored): T.SettingsSection<V> {
  return {
    stored,
    effective,
    revision: settingsRevision(raw),
    access,
    apply
  };
}
class Conflict extends Error {
}
class Unchanged extends Error {
}
function check(actual: unknown, revision: string): void {
  if (settingsRevision(actual) !== revision)
    throw new Conflict();
}
/** A judge choice checked before the write lock; `layerBackend` when the check used the layer's
 * backend: a group's language model, or the bot's that names none. */
interface PreparedJudge {
  chosen?: JudgeSelectionStored;
  layerBackend?: string;
}
/** Under the write lock. If the layer's backend the check used moved in between (the bot's default
 * backend, a group's switch), the check no longer holds. */
function storeJudge(target: { judge?: JudgeSelectionStored }, prepared: PreparedJudge, layerBackend: string): void {
  if (prepared.layerBackend !== undefined && layerBackend !== prepared.layerBackend)
    throw new Conflict();
  if (prepared.chosen)
    target.judge = prepared.chosen;
  else
    delete target.judge;
}
class ModelAccessInputError extends SettingsInputError {
  constructor(readonly field: keyof T.ProjectSections['modelAccess'], message: string) {
    super(message);
  }
}
function rejected(error: unknown): {
  kind: 'rejected';
  fields: T.SettingsFieldError[];
} {
  return {
    kind: 'rejected',
    fields: [{
        field: error instanceof ModelAccessInputError ? error.field : 'settings',
        message: error instanceof SettingsInputError ? error.message : '保存失败，请刷新设置后重试；若配置被其他进程修改，请重启 daemon'
      }]
  };
}
/** The Feishu app name the bot was registered with, for the role draft (2.3); undefined when the registry cannot say. */
async function registeredBotName(appId: string): Promise<string | undefined> {
  try { return (await loadBots()).bots.find(bot => bot.appId === appId)?.botName; }
  catch { return undefined; }
}
/** The whole `SOUL.md` and the old shared memory, as a read-only record: nothing reads the second file any more (P4a). */
async function legacyBotProfile(appId: string): Promise<{ persona: string; memory: string }> {
  await waitForBotFiles(appId);
  const files = await botFiles(appId);
  return { persona: await readSoulText(appId), memory: await readText(files, { kind: 'public-memory' }) };
}
export function createSettingsOwner(deps: SettingsOwnerDeps): T.HostSettings {
  const cfg = deps.cfg;
  const botId = cfg.accounts.app.id;
  const access = deps.access ?? writable;
  const sectionAccess = (kind: string, section: string) => deps.localEditing && isLocalSettingsSection(kind, section) ? writable : access;
  const runningConcurrency = deps.runningConcurrency ?? getMaxConcurrentRuns(cfg);
  // A settings scope names a group by its name and the bot's private chat by `oc_dm_<appId>` (dm-agent 4.2).
  const dmChat = dmChatId(botId);
  const readChatProject = deps.readChatProject ?? getProjectByChatId;
  const readGroup = deps.readProject ?? getProjectByName;
  const readProject = (name: string) => name === dmChat ? readChatProject(name) : readGroup(name);
  const readSession = deps.readSession ?? getSession;
  const changeGroup = deps.mutateProject ?? mutateProject;
  const changeChatProject = deps.mutateChatProject ?? mutateProjectByChatId;
  const changeSession = deps.mutateSession ?? mutateSession;
  const instructions = deps.instructions ?? {
    read: () => readFile(paths.commentInstructionsFile, 'utf8').then(currentCommentInstructions).catch(error => {
      if (error.code === 'ENOENT')
        return DEFAULT_COMMENT_INSTRUCTIONS;
      throw error;
    }),
    save: (text: string) => saveCommentInstructions(paths.commentInstructionsFile, text),
    sync: (text: string) => syncAllCommentInstructions(paths.commentsRootDir, text, cfg.accounts.app.tenant),
  };
  let actionChain: Promise<unknown> = Promise.resolve();
  const own = (scope: T.SettingsScope) => {
    if (scope.kind === 'host' || scope.botId !== botId)
      throw new SettingsInputError('设置不属于这个 Bot');
  };
  async function models(query: T.ModelQuery): Promise<T.ModelCatalog> {
    own({
      kind: 'agent',
      botId: query.botId
    });
    const base = {
      backend: query.backend,
      source: 'backend-provided' as const,
      observedAt: new Date().toISOString(),
      titleEfforts: [...getSessionTitleEfforts(query.backend)]
    };
    if (!backendIds().includes(query.backend))
      return {
        ...base,
        models: [],
        state: 'unavailable',
        error: '未知后端'
      };
    try {
      const backend = deps.backendFor(query.backend);
      const target = query.threadId ? await readSession(query.threadId) : undefined;
      if (query.threadId && (!target || target.backend !== query.backend))
        return { ...base, models: [], state: 'unavailable', error: '会话不存在或后端已变化' };
      if (deps.offline) { const cached = await offlineModelCatalog(query.backend); const peeked = backend.peekModels?.(); return { ...base, models: peeked?.length ? peeked : cached.models, state: 'fallback', observedAt: cached.observedAt, error: cached.message }; }
      // A model catalog does not require a Windows sandbox capability probe.
      const [status] = await probeBackends([backend], undefined, { permissions: false });
      if (!status?.probe?.ok)
        return {
          ...base,
          models: [],
          state: 'unavailable',
          error: '后端现在不可用，请检查安装和配置'
        };
      const listed = target?.cwd && backend.listModelsForCwd
        ? await backend.listModelsForCwd(target.cwd, { refresh: query.refresh })
        : await backend.listModels({ refresh: query.refresh });
      // Native backends also return a static list on discovery failure. Only their
      // successful discovery populates peekModels; fallback must not become a
      // confirmed catalog or overwrite a previously confirmed disk snapshot.
      const native = backend.peekModels?.();
      if (native?.length) {
        await rememberModelCatalog(query.backend, native, base.observedAt).catch(() => undefined);
        return { ...base, models: target ? listed : native, state: 'ready' };
      }
      return { ...base, models: listed, state: 'fallback' };
    }
    catch {
      return {
        ...base,
        models: [],
        state: 'unavailable',
        error: '后端模型列表暂时不可用'
      };
    }
  }
  /** Returns the selection to store. A hand-typed id (`custom`, 3.11) is never
   * checked against the catalog, only by parseModelId (and stored trimmed), and its
   * effort only against the backend protocol; `allowCustom` is off where hand-typed
   * ids are not offered (comments). */
  async function validateSelection(backend: string, value: T.ModelSelection, allowCustom = false): Promise<T.ModelSelection> {
    if (!backendIds().includes(backend))
      throw new SettingsInputError('未知后端');
    if (value.kind === 'default')
      return value;
    if (value.custom) {
      if (!allowCustom)
        throw new SettingsInputError('这里不能手填模型 ID');
      const parsed = parseModelId(value.model);
      if (!parsed.ok)
        throw new SettingsInputError(parsed.message);
      if (backend === 'claude-agent' && !getSessionTitleEfforts(backend).includes(value.effort))
        throw new SettingsInputError('当前后端不支持这个推理强度');
      return { ...value, model: parsed.id };
    }
    const catalog = await models({
      botId,
      backend,
      purpose: 'project'
    });
    const model = catalog.models.find(item => item.id === value.model);
    if (!model || model.hidden || !model.supportedEfforts.includes(value.effort))
      throw new SettingsInputError('模型或推理强度不在当前后端支持列表中，请刷新模型列表');
    return value;
  }
  async function validateSpeed(tier: T.SpeedSetting['tier'], backend: string, modelId?: string, custom = false, cwd?: string, group?: Project): Promise<void> {
    if (backend !== 'codex-appserver') throw new SettingsInputError('速度档位仅支持 Codex');
    if (tier === 'inherit' || tier === 'standard') return;
    if (!projectSpeedAllowed(group, modelId, tier)) throw new SettingsInputError('本群未允许这个模型使用此速度档位');
    if (custom) throw new SettingsInputError('自定义模型没有可验证的速度档位');
    const provider = deps.backendFor(backend);
    const contextual = cwd && provider.listModelsForCwd ? await provider.listModelsForCwd(cwd).catch(() => undefined) : undefined;
    if (cwd && provider.listModelsForCwd && !contextual) throw new SettingsInputError('实时模型目录不可用，请稍后重试');
    const catalog = contextual
      ? { state: provider.peekModels?.()?.length ? 'ready' as const : 'fallback' as const, models: contextual }
      : await models({ botId, backend, purpose: 'session' });
    if (catalog.state !== 'ready') throw new SettingsInputError('实时模型目录不可用，请稍后重试');
    const model = modelId ? catalog.models.find(item => item.id === modelId) : catalog.models.find(item => item.isDefault);
    if (!model || model.hidden || !model.serviceTiers?.some(item => item.id === tier))
      throw new SettingsInputError('当前模型不支持这个速度档位');
  }
  const peekModels = (id: string): ModelInfo[] | undefined => {
    try {
      return deps.backendFor(id).peekModels?.();
    }
    catch {
      return undefined;
    }
  };
  /** Returns what to store: group defaults become concrete snapshots; Bot `default` removes its override.
   * A group can use a decision backend independently of its task backend. The Bot layer keeps its
   * existing backend-scoped inheritance. A listed model is checked against the list the backend holds
   * (what the judge fits the effort with), else a fresh catalog, except while the catalog cannot be
   * read: then the choice and its effort are kept as given, and each judgement fits the effort to the
   * model (Rakazo 第二轮 A6). A decision model also requires a readable, configured credential. */
  async function validateJudgeSelection(value: T.JudgeSelection, layerBackend: string, group: boolean): Promise<JudgeSelectionStored | undefined> {
    if (value.kind === 'default') {
      if (!group) return undefined;
      return snapshotDefaultJudge({ backendFor: deps.backendFor, readKey: deps.getSecret, readJudgeModels: deps.readJudgeModels }).catch((error: unknown) => {
        throw new SettingsInputError(error instanceof Error ? error.message : '无法验证默认决策模型');
      });
    }
    if (value.kind === 'provider') {
      const choice=await snapshotProviderJudge(value.provider, { backendFor: deps.backendFor, readKey: deps.getSecret, readJudgeModels: deps.readJudgeModels }).catch((error: unknown) => {
        throw new SettingsInputError(error instanceof Error ? error.message : '无法验证决策 Provider');
      });
      return group ? choice : { kind: 'provider', provider: value.provider };
    }
    const id = parseModelId(value.model);
    if (!id.ok)
      throw new SettingsInputError(id.message);
    if (value.kind === 'decision') {
      if (!DECISION_PROVIDER_ID.test(value.provider))
        throw new SettingsInputError('决策模型的 provider 只能是小写字母、数字和 -，40 个字以内');
      // any model id, as a hand-typed one: a wrong one fails its judgements as `model` and cools (s23f)
      if (!decisionProvider(value.provider))
        throw new SettingsInputError(`没有 ${value.provider} 这家决策模型，现在有：${decisionProviders().map(p => `${p.displayName}（${p.id}）`).join('、')}`);
      await requireDecisionKey(value.provider,deps.getSecret,deps.readJudgeModels).catch((error:unknown)=>{ throw new SettingsInputError(error instanceof Error?error.message:'无法验证决策模型密钥'); });
      return { kind: 'decision', provider: value.provider, model: id.id };
    }
    const backend = value.backend ?? layerBackend;
    if (!backendIds().includes(backend))
      throw new SettingsInputError('未知后端');

    const stored: JudgeSelectionStored = { kind: 'llm', backend, model: id.id, ...(value.effort ? { effort: value.effort } : {}) };
    if (backend === 'claude-agent' && value.effort && !getSessionTitleEfforts(backend).includes(value.effort))
      throw new SettingsInputError('当前后端不支持这个推理强度');
    if (value.custom) {
      return { ...stored, custom: true };
    }
    const listed = peekModels(backend) ?? (await models({ botId, backend, purpose: 'judge' })).models;
    if (!listed.length)
      return stored;
    const model = listed.find(item => item.id === id.id && !item.hidden);
    if (!model)
      throw new SettingsInputError('列表里没有这个模型；手填的 id 加 "custom":true');
    if (value.effort && !model.supportedEfforts.includes(value.effort))
      throw new SettingsInputError(model.supportedEfforts.length ? '这个模型不支持这个推理强度' : '这个模型不支持推理强度，effort 不能写');
    return stored;
  }
  /** A judge save is checked before the write lock: reading the model list can take a while (a cold
   * backend), and the lock holds up every other save of the bot, or of all groups. `current` is the
   * layer as read now; the save checks its revision again under the lock ({@link storeJudge}). */
  async function prepareJudge(selection: T.JudgeSelectionView | undefined, current: unknown, revision: string, layerBackend: string, group: boolean): Promise<PreparedJudge> {
    check(current, revision);
    if (!selection)
      throw new SettingsInputError('缺少模型选择');
    // parseSettingsEdit took only the known kinds
    const value = selection as T.JudgeSelection;
    const chosen = await validateJudgeSelection(value, layerBackend, group);
    return { chosen, ...(value.kind === 'llm' && !value.backend ? { layerBackend } : {}) };
  }
  /** What a group on `backend` judges with (design 2.5), as a selection. */
  function judgeEffective(backend: string, layers: { group?: JudgeSelectionStored; bot?: JudgeSelectionStored }): T.AgentSections['judge'] {
    const active = layers.group ?? layers.bot;
    const actualBackend = judgeBackendId(backend, layers.group ?? (layers.bot?.kind === 'llm' ? undefined : layers.bot));
    const { model, effort, provider } = resolveJudgeModel(actualBackend, layers, peekModels(actualBackend));
    if (active?.kind === 'provider' && !layers.group) return { selection: active };
    return { selection: provider ? { kind: 'decision', provider, model } : { kind: 'llm', backend: actualBackend, model, ...(effort ? { effort } : {}) } };
  }
  /** Every decision model this version calls, and whether its key is filled in by the judge's rule (an unreadable
   * keystore is said so, not taken for a missing key; one stored in a shape no header carries is missing, as the
   * judge takes it): what `settings get` and a picker list (s23f, s28), and the key page's status (s23g). */
  async function decisionModels(): Promise<T.DecisionModelsView> {
    return Promise.all(decisionProviders().map(async p => {
      const { status } = await keyStatus(p, deps.getSecret);
      const profile = p.id === 'custom' ? await (deps.readJudgeModels ?? readJudgeModels)().then(stored => stored.byProvider.custom).catch(() => undefined) : undefined;
      const models = profile && !p.models.some(model => model.id === profile.model)
        ? [...p.models, { id: profile.model, displayName: profile.model }] : p.models;
      return {
        provider: p.id, displayName: p.displayName, models: models.map(m => ({ ...m })), keyId: p.keyId,
        keySet: status === 'set', ...(status === 'unreadable' ? { keyUnreadable: true } : {}),
        ...(p.id === 'custom' ? { endpointConfigured: !decisionEndpointProblem(profile?.endpoint) } : {}),
      };
    }));
  }
  /** SMART.md of the bot (no chatId) or the group, with the read-only parts around it: a decision model's options
   * and state in place of the format lines and the text input when one judges (s23f). */
  async function smartPromptView(chatId: string | undefined, notes: string[], decision: boolean): Promise<T.SmartPromptView> {
    const lines = decision ? DECISION_FORMAT_LINES : JUDGE_FORMAT_LINES;
    // Old clients require this wire field; it is an alias, not a judgement variant.
    const fixed = { formatLines: { ...lines, mentioned: lines.main }, inputExample: decision ? DECISION_INPUT_EXAMPLE : JUDGE_INPUT_EXAMPLE, maxLength: SMART_MAX_CHARS, ...(notes.length ? { backendNote: notes.join('\n') } : {}) };
    try {
      return { ...await (deps.readSmartPrompt ?? readSmartPrompt)(botId, chatId), ...fixed };
    }
    catch (error) {
      const known = error instanceof SmartPromptError;
      return { source: 'default', path: known && error.path || '', text: '', ...fixed, error: known ? error.message : '读不了 SMART.md' };
    }
  }
  async function effectiveSelection(backend: string, model?: string, effort?: ReasoningEffort, custom?: boolean): Promise<T.ModelSelection> {
    if (access.kind !== 'writable' || custom && model)
      return selection(model, effort, custom);
    const catalog = await models({
      botId,
      backend,
      purpose: 'project'
    });
    const preferred = model ? catalog.models.find(item => item.id === model && !item.hidden) : undefined;
    const chosen = preferred ?? catalog.models.find(item => item.isDefault && !item.hidden) ?? catalog.models.find(item => !item.hidden);
    if (!chosen)
      return selection(model, effort);
    return {
      kind: 'explicit',
      model: chosen.id,
      effort: preferred && effort && preferred.supportedEfforts.includes(effort) ? effort : chosen.defaultEffort
    };
  }
  async function projectSettings(p: Project): Promise<T.ProjectSections> {
    // Identity changes invalidate immediately; ordinary reads share the bounded cache.
    // Environment diagnostics use doctor({ force: true }) for an explicit recheck.
    if (!deps.offline) await deps.backendFor(groupBackendId(p)).refreshPermissions?.({ cached: true });
    const result = projectData(p, deps.backendFor(groupBackendId(p)));
    // `profile` is only a record of what the row held before the memory migration; the runtime reads `role` and the entries.
    result.role = { supplement: supplementOf(p) };
    result.modelAccess = resolveProjectModelAccess({ bot: cfg.preferences, group: p }, peekModels(groupBackendId(p)));
    if (!p.directories?.repositories) result.workspace.repositories = [...cfg.preferences?.directories?.repositories ?? []];
    if (!p.smartRules) result.smartRules = p.dm ? { ...DEFAULT_DM_SMART_RULES } : rulesFromSmartPrompt(await (deps.readSmartPrompt ?? readSmartPrompt)(botId, p.chatId));
    const completion = getCompletionReminderConfig(cfg);
    result.presentation = { voiceEnabled: voiceView(cfg).enabled, showToolCalls: true, showModel: 'running', cardDisplay: null, completionMode: completion.mode, longTaskMinutes: completion.longTaskMinutes, completionTemplate: null, ...p.presentation };
    return result;
  }
  async function sectionRaw(p: Project, section: keyof T.ProjectSections): Promise<unknown> {
    if (section === 'role' && p.supplement === undefined) return [botId, projectRaw(p, section), supplementOf(p)];
    if (section === 'smartRules' && !p.smartRules && !p.dm) return [botId, projectRaw(p, section), (await (deps.readSmartPrompt ?? readSmartPrompt)(botId, p.chatId)).text];
    return [botId, projectRaw(p, section)];
  }
  async function validateModelAccess(value: T.ProjectSections['modelAccess'], previous: T.ProjectSections['modelAccess']): Promise<ModelInfo[]> {
    if (!backendIds().includes(value.backend)) throw new ModelAccessInputError('backend', '请选择支持的 Provider');
    if (!value.models.length || new Set(value.models).size !== value.models.length) throw new ModelAccessInputError('models', '至少选择一个模型，模型不能重复');
    if (new Set(value.efforts).size !== value.efforts.length) throw new ModelAccessInputError('efforts', 'Effort 不能重复');
    const discovered = await models({ botId, backend: value.backend, purpose: 'project' });
    // Fallback metadata cannot authorize new models, efforts, or a provider
    // switch. An empty trusted catalog retains the existing subset-only path.
    const catalog = discovered.state === 'ready' ? discovered.models : [];
    const previousEfforts = (id: string) => previous.modelEfforts?.[id] ?? previous.efforts;
    const efforts = (id: string) => value.modelEfforts?.[id] ?? value.efforts;
    if (Object.keys(value.modelEfforts ?? {}).some(id => !value.models.includes(id))) throw new ModelAccessInputError('modelEfforts', 'Effort 策略包含未选择的模型');
    if (Object.keys(value.modelServiceTiers ?? {}).some(id => !value.models.includes(id))) throw new ModelAccessInputError('modelServiceTiers', '速度档位策略包含未选择的模型');
    for (const id of value.models) {
      if (!parseModelId(id).ok) throw new ModelAccessInputError('models', `模型 ID ${id} 无效`);
      const model = catalog.find(m => m.id === id && !m.hidden);
      const selectedEfforts = efforts(id);
      const selectedTiers = value.modelServiceTiers?.[id] ?? [];
      const effortField = value.modelEfforts?.[id] ? 'modelEfforts' : 'efforts';
      if (new Set(selectedEfforts).size !== selectedEfforts.length) throw new ModelAccessInputError(effortField, `模型 ${id} 的 Effort 不能重复`);
      if (new Set(selectedTiers).size !== selectedTiers.length) throw new ModelAccessInputError('modelServiceTiers', `模型 ${id} 的速度档位不能重复`);
      if (!model) {
        if (value.backend !== previous.backend || !previous.models.includes(id)) {
          if (discovered.state === 'ready') throw new ModelAccessInputError('models', `当前 Provider 的目录中没有模型 ${id}，请刷新目录后重新选择`);
          throw new SettingsInputError('模型目录暂不可用，请启动 Bot 并刷新目录');
        }
        if (selectedEfforts.some(e => !previousEfforts(id).includes(e))) throw new SettingsInputError('无法验证新增 Effort，请刷新模型目录');
        if (selectedTiers.some(t => !(previous.modelServiceTiers?.[id] ?? []).includes(t))) throw new SettingsInputError('无法验证新增速度档位，请刷新模型目录');
      } else {
        if (model.supportedEfforts.length && (!selectedEfforts.some(e => model.supportedEfforts.includes(e)) || (value.modelEfforts?.[id] && selectedEfforts.some(e => !model.supportedEfforts.includes(e))))) throw new ModelAccessInputError(effortField, `模型 ${id} 的 Effort 选择无效，请从支持的值中选择：${model.supportedEfforts.join('、')}`);
        if (!model.supportedEfforts.length && value.modelEfforts?.[id]?.length) throw new ModelAccessInputError('modelEfforts', `模型 ${id} 不支持 Effort`);
        if (selectedTiers.some(t => !model.serviceTiers?.some(s => s.id === t))) throw new ModelAccessInputError('modelServiceTiers', `模型 ${id} 不支持所选速度档位：${selectedTiers.filter(t => !model.serviceTiers?.some(s => s.id === t)).join('、')}`);
      }
    }
    const defaultModel = value.defaultModel ?? value.models[0];
    if (!defaultModel || !value.models.includes(defaultModel)) throw new ModelAccessInputError('defaultModel', '默认模型必须在本群允许列表中');
    const defaultEfforts = efforts(defaultModel);
    const nativeDefault = catalog.find(m => m.id === defaultModel);
    if (nativeDefault?.supportedEfforts.length && value.defaultEffort && (!defaultEfforts.includes(value.defaultEffort) || !nativeDefault.supportedEfforts.includes(value.defaultEffort))) throw new ModelAccessInputError('defaultEffort', '默认 Effort 必须在默认模型允许列表中');
    if (nativeDefault && !nativeDefault.supportedEfforts.length && value.defaultEffort) throw new ModelAccessInputError('defaultEffort', '默认模型不支持 Effort');
    if (!nativeDefault && value.defaultEffort && !defaultEfforts.includes(value.defaultEffort)) throw new ModelAccessInputError('defaultEffort', '默认 Effort 必须在默认模型允许列表中');
    return catalog;
  }
  async function read(scope: T.SettingsScope): Promise<T.SettingsView> {
    own(scope);
    if (scope.kind === 'agent') {
      const data = agentData(cfg);
      data.profile = await legacyBotProfile(botId);
      const roleView = await readRole(botId);
      data.role = { identity: roleView.identity, notes: roleView.notes };
      const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, makeSection(value, [botId, agentRaw(cfg.preferences ?? {}, key as keyof T.AgentSections)], access, agentEffects[key as keyof T.AgentSections])])) as T.AgentSettingsView['sections'];
      sections.profile = makeSection(data.profile, [botId, data.profile], sectionAccess('agent', 'profile'), agentEffects.profile);
      sections.role = makeSection(data.role, [botId, data.role], sectionAccess('agent', 'role'), agentEffects.role);
      sections.paths.effective = {
        projectsRootDir: resolveProjectsRootDir(cfg.preferences?.projectsRootDir)
      };
      const comments = resolveCommentsExecution(cfg.preferences);
      sections.comments.effective = {
        backend: comments.backend,
        selection: await effectiveSelection(comments.backend, comments.model?.model, comments.model?.effort, comments.model?.custom)
      };
      sections.run.effective = {
        ...sections.run.stored,
        maxConcurrentRuns: runningConcurrency
      };
      const botJudge = storedJudge(cfg.preferences?.judge);
      sections.judge.effective = judgeEffective(botJudge?.kind === 'llm' ? botJudge.backend : botBackendId(cfg.preferences), { bot: botJudge });
      const botDecides = isDecisionSelection(sections.judge.effective.selection);
      const judgeByBackend: NonNullable<T.AgentSettingsView['judgeByBackend']> = {};
      for (const id of backendIds()) {
        const judgeBackend = judgeBackendId(id, botJudge?.kind === 'llm' ? undefined : botJudge);
        const { model, effort, provider, modelSource } = resolveJudgeModel(judgeBackend, { bot: botJudge }, peekModels(judgeBackend));
        judgeByBackend[id] = { model, ...(effort ? { effort } : {}), ...(provider ? { provider } : {}), source: modelSource === 'bot' ? 'bot' : 'default' };
      }
      const text = await instructions.read();
      const roles = getAppRoleSnapshot(botId, cfg.accounts.app.tenant);
      // Names only from Feishu (dm-agent 3.4), asked once for everyone the page shows; a stopped Bot has no way to ask.
      const admins = cfg.preferences?.access?.admins ?? [];
      const feishuIds = [...new Set([...(roles?.ownerOpenId ? [roles.ownerOpenId] : []), ...trustedFeishuAdmins(roles)])];
      const refused = readRefused(botId);
      const refusedNames = new Map(refused.map(person => [person.openId, person.name]));
      const names = await deps.personNames?.([...new Set([...admins, ...(cfg.preferences?.access?.ownerOpenId ? [cfg.preferences.access.ownerOpenId] : []), ...feishuIds])]) ?? new Map<string, string>();
      const draft = data.role.identity.trim() ? '' : roleDraft(deps.botName ?? await registeredBotName(botId));
      return {
        scope,
        sections,
        roleInfo: {
          ...(draft ? { draft } : {}),
          headed: roleView.headed, oversized: roleView.oversized, mergedNotice: roleView.mergedNotice, integrity: roleView.integrity,
        },
        // The one who scanned the bot in, a label only; what Feishu names is no administrator, only who may be picked.
        ownerOpenId: cfg.preferences?.access?.ownerOpenId ?? null,
        administrators: {
          openIds: [...admins],
          names: Object.fromEntries(admins.flatMap(id => { const name = names.get(id) ?? refusedNames.get(id); return name ? [[id, name]] : []; })),
          candidates: adminCandidates({ admins, creator: cfg.preferences?.access?.ownerOpenId, feishu: feishuIds, refused, names }),
          revision: settingsRevision([botId, cfg.preferences?.access?.admins ?? []])
        },
        voice: voiceView(cfg),
        commentInstructions: {
          content: text === DEFAULT_COMMENT_INSTRUCTIONS ? {
            kind: 'default',
            text
          } : {
            kind: 'custom',
            text
          },
          revision: settingsRevision([botId, text]),
          maxEditLength: 30000
        },
        // the bot's default backend's groups, as `effective`; a decision model gets none of a backend's extras
        smartPrompt: await smartPromptView(undefined, botDecides ? [] : backendIds().flatMap(id => JUDGE_NOTES[id] ?? []), botDecides),
        judgeByBackend,
        decisionModels: await decisionModels()
      };
    }
    if (scope.kind === 'project') {
      const p = await readProject(scope.projectName);
      if (!p)
        throw new SettingsInputError('项目不存在');
      const data = await projectSettings(p);
      const sections = Object.fromEntries(Object.entries(data).filter(([key]) => p.dm || key !== 'conversation').map(([key, value]) => [key, makeSection(value, [botId, projectRaw(p, key as keyof T.ProjectSections)], p.dm && !DM_SECTIONS.has(key) ? DM_FIXED : sectionAccess('project', key), effect(Object.keys(value), key === 'model' ? 'new-session' : key === 'permission' || key === 'workspace' ? 'session-rebind' : 'next-message', key === 'model' ? '仅新会话使用项目默认模型' : key === 'workspace' ? '下一轮新开会话' : key === 'judge' ? agentEffects.judge[0]!.detail : key === 'run' && p.backend === 'claude-agent' ? 'Claude 不支持插话，运行中来的消息照样排队' : '下一条消息生效'))])) as T.ProjectSettingsView['sections'];
      sections.presentation!.effective = { ...data.presentation, cardDisplay: p.presentation?.cardDisplay ?? null,
        ...(p.presentation?.cardDisplay == null ? { showToolCalls: true, showModel: 'running' as const } : {}) };
      for (const key of ['profile', 'role', 'smartRules'] as const) sections[key]!.revision = settingsRevision(await sectionRaw(p, key));
      const botProfile = await legacyBotProfile(botId);
      sections.profile!.effective = { ...data.profile };
      const backendId = groupBackendId(p);
      sections.run.effective = { pendingPolicy: pendingPolicyOf(getPendingPolicy(cfg), p) };
      // The group's default, else the bot's on the same backend (s36d2).
      const prefer = resolveModelPreference({ bot: cfg.preferences, group: p }, backendId);
      sections.model.effective = {
        selection: await effectiveSelection(backendId, prefer?.model, prefer?.effort, prefer?.custom)
      };
      sections.speed!.effective = { tier: p.serviceTier ?? 'inherit' };
      sections.speed!.apply = effect(['tier'], 'next-turn', '旧版群速度设置已停用；请在群主会话中选择速度');
      sections.judge.effective = judgeEffective(backendId, { group: storedJudge(p.judge), bot: storedJudge(cfg.preferences?.judge) });
      // a decision model gets none of a backend's extras
      const judgeSelection = sections.judge.effective.selection;
      const judgeNote = judgeSelection.kind === 'llm' ? JUDGE_NOTES[String(judgeSelection.backend ?? backendId)]
        : judgeSelection.kind === 'provider' && !isDecisionSelection(judgeSelection) ? JUDGE_NOTES[String(judgeSelection.provider)] : undefined;
      const groupDecides = isDecisionSelection(judgeSelection);
      const fullOnly = deps.backendFor(backendId).fullAccessOnly?.();
      let skillView: Pick<T.ProjectSettingsView, 'skills' | 'skillsError'>;
      const builtins = await discoverBuiltinGroupSkills({ appId: botId, set: p.dm ? 'dm' : 'group', disabledPaths: data.skills.disabledPaths });
      if (deps.offline) {
        try {
          const local = await discoverLocalGroupSkills({ backendId, cwd: p.cwd, directories: data.workspace.directories, disabledPaths: data.skills.disabledPaths });
          skillView = { skills: [...builtins, ...local], skillsError: '仅显示本地技能，Provider 插件在启动后读取' };
        } catch {
          skillView = { skillsError: '暂时无法读取本地技能目录，请检查工作区目录' };
        }
      }
      else {
        try {
          const discovered = await (deps.discoverSkills ?? discoverGroupSkills)({ backend: deps.backendFor(backendId), cwd: p.cwd, directories: data.workspace.directories, disabledPaths: data.skills.disabledPaths });
          skillView = { skills: [...builtins, ...discovered] };
        } catch {
          skillView = { skillsError: '暂时无法读取技能目录，请检查 Provider 状态后重试' };
        }
      }
      return {
        scope,
        sections,
        botProfile,
        judgeInheritsHostDefault: p.judge?.kind === 'default',
        ...skillView,
        identity: {
          chatId: p.chatId,
          backend: backendId,
          cwd: p.cwd,
          kind: sessionModeOf(p),
          ...(fullOnly ? { fullOnly } : {})
        },
        members: {
          ...(deps.responseRoster && !p.dm ? { roster: await deps.responseRoster(p.chatId) } : {}),
          openIds: [...(p.allowedUsers ?? [])],
          revision: settingsRevision([botId, p.name, p.chatId, p.allowedUsers ?? []])
        },
        smartPrompt: p.smartRules || p.dm ? { ...await smartPromptView(p.chatId, judgeNote ? [judgeNote] : [], groupDecides), source: 'group', text: composeSmartRules(p.smartRules ?? DEFAULT_DM_SMART_RULES) } : await smartPromptView(p.chatId, judgeNote ? [judgeNote] : [], groupDecides),
        decisionModels: await decisionModels()
      };
    }
    if (scope.kind === 'session') {
      if (isRetiredKey(scope.threadId))
        throw new SettingsInputError(RETIRED_KEY_TEXT);
      const s = await readSession(scope.threadId);
      if (!s)
        throw new SettingsInputError('会话不存在或已被删除');
      let effectiveSpeed: T.SessionSpeedSetting['tier'] = s.serviceTier ?? 'standard';
      if (s.serviceTier && s.serviceTier !== 'standard') {
        const { model: storedModel, serviceTier: storedTier } = s;
        const speedGroup = await readChatProject(s.chatId);
        const speedPreference = speedGroup ? resolveModelPreference({ bot: cfg.preferences, group: speedGroup }, s.backend) : undefined;
        if (!projectSpeedAllowed(speedGroup, storedModel ?? speedPreference?.model, storedTier)) effectiveSpeed = 'standard';
        const catalog = s.backend === 'codex-appserver'
          ? await models({ botId, backend: s.backend, purpose: 'session', threadId: s.threadId })
          : undefined;
        const selected = catalog?.state === 'ready' ? catalog.models.find(item => item.id === storedModel && !item.hidden) : undefined;
        if (!selected?.serviceTiers?.some(item => item.id === storedTier)) effectiveSpeed = 'standard';
      }
      const project = await readChatProject(s.chatId);
      return {
        scope,
        sections: {
          model: makeSection({
            selection: selection(s.model, s.effort, s.modelCustom)
          }, [botId, sessionRaw(s)], access, effect(['selection'], 'next-turn', '下一轮对话使用新模型')),
          speed: makeSection({ tier: s.serviceTier ?? 'standard' }, [botId, sessionSpeedRaw(s)], access, effect(['tier'], 'next-turn', '下一次发起任务时使用新速度，当前任务不变'), { tier: effectiveSpeed })
        },
        identity: {
          backend: s.backend,
          sessionId: s.sessionId,
          chatId: s.chatId,
          projectName: project?.name ?? null
        }
      };
    }
    throw new SettingsInputError('安装设置由 daemon 管理');
  }
  /** After a decision model is chosen without its key (owner: choose first, fill in later): what happens meanwhile
   * and how to fill it in, as one more effect line, which the command line and the web page show as they are. */
  async function keyMissing(selection: T.JudgeSelectionView | undefined): Promise<string | undefined> {
    if (!selection || (selection.kind !== 'decision' && selection.kind !== 'provider') || !isDecisionSelection(selection))
      return undefined;
    const chosen = (await decisionModels()).find(m => m.provider === selection.provider);
    return chosen && !chosen.keySet ? keyMissingText(chosen) : undefined;
  }
  async function sectionView(edit: T.BotSettingsEdit): Promise<T.SettingsSectionView> {
    const view = await read(edit.scope);
    if (view.scope.kind !== edit.scope.kind || !(edit.section in view.sections))
      throw new SettingsInputError('无效设置分区');
    return {
      scope: edit.scope,
      section: edit.section,
      value: view.sections[edit.section as keyof typeof view.sections]
    } as T.SettingsSectionView;
  }
  async function save(input: T.SettingsEdit, options?: T.SettingsCommitOptions): Promise<T.SettingsSave> {
    let committed = false;
    const beforeCommit = () => {
      if (options?.notAfter !== undefined && Date.now() >= options.notAfter) throw new ToolRefusal({ ok: false, code: 'timeout', message: '已过期，没有修改设置。' });
      options?.beforeCommit?.();
      committed = true;
    };
    const commitOptions = { beforeCommit };
    const parsed = parseSettingsEdit(input);
    own(parsed.scope);
    if (sectionAccess(parsed.scope.kind, parsed.section).kind !== 'writable')
      return {
        kind: 'unavailable',
        reason: access
      };
    if (parsed.scope.kind === 'host')
      throw new SettingsInputError('安装设置由 daemon 管理');
    const edit = parsed as T.BotSettingsEdit;
    if (edit.scope.kind === 'project' && edit.section === 'permission') {
      const project = await readProject(edit.scope.projectName);
      if (project) await deps.backendFor(groupBackendId(project)).refreshPermissions?.();
    }
    let additionalEffects: T.ApplyEffect[] = [];
    let turnedFull = false;
    try {
      if (edit.scope.kind === 'project' && edit.scope.projectName === dmChat && !DM_SECTIONS.has(edit.section))
        throw new SettingsInputError(DM_ONLY_THESE);
      if (edit.scope.kind === 'agent') {
        const e = edit as Extract<T.BotSettingsEdit, {
          section: keyof T.AgentSections;
        }>;
        const judge = e.section === 'judge'
          ? await prepareJudge(e.patch.selection, [botId, agentRaw(cfg.preferences ?? {}, 'judge')], e.revision, botBackendId(cfg.preferences), false)
          : undefined;
        if (e.section === 'role') {
          await updateRole(botId, current => {
            check([botId, current], e.revision);
            const next = { ...current, ...e.patch };
            const problem = roleProblem(next, current);
            if (problem) throw new SettingsInputError(problem);
            return next;
          }, { beforeCommit });
        } else if (e.section === 'profile') {
          // Read-only since P4a: the role has its own section and the shared memory is now the bot's memory entries.
          throw new SettingsInputError('角色设定请在「身份与职责」「其他说明」里改；公共记忆已改为 Bot 记忆，在记忆页里改');
        } else await deps.writePreferences(async (p) => {
          check([botId, agentRaw(p, e.section as keyof T.AgentSections)], e.revision);
          switch (e.section) {
            case 'run':
              Object.assign(p, e.patch);
              break;
            case 'completion':
              p.completionReminder = {
                ...p.completionReminder,
                ...e.patch
              };
              break;
            case 'comments': {
              const backend = e.patch.backend ?? resolveCommentsExecution(p).backend;
              const choice = e.patch.selection ?? selection(p.comments?.model, p.comments?.effort);
              await validateSelection(backend, choice);
              // An inherited backend stays inherited: only a chosen one is written (s36d2).
              p.comments = {
                ...p.comments,
                ...(e.patch.backend !== undefined ? { backend } : {})
              };
              applySelection(p.comments, choice);
              break;
            }
            case 'titles': {
              const legacy = Object.entries(e.patch.byBackend ?? {})[0];
              const policy = e.patch.policy ?? (legacy && (legacy[1].enabled ? { ...legacy[1], backend: legacy[0] } : { enabled: false as const }));
              if (!policy || policy.enabled && (!backendIds().includes(policy.backend) || !getSessionTitleEfforts(policy.backend).includes(policy.effort)))
                throw new SettingsInputError('标题后端或推理强度无效');
              p.sessionTitles = { ...p.sessionTitles, policy: { ...p.sessionTitles?.policy, ...policy } };
              break;
            }
            case 'paths':
              if (e.patch.projectsRootDir === null)
                delete p.projectsRootDir;
              else if (e.patch.projectsRootDir !== undefined)
                p.projectsRootDir = e.patch.projectsRootDir;
              break;
            case 'access':
              p.access = {
                ...p.access,
                ...e.patch
              };
              break;
            case 'judge':
              storeJudge(p, judge!, botBackendId(p));
              break;
            default: throw new SettingsInputError('无效的 Bot 设置');
          }
        }, commitOptions);
        if (e.section === 'completion')
          deps.refreshCompletionReminders?.();
      }
      else if (edit.scope.kind === 'project') {
        const e = edit as Extract<T.BotSettingsEdit, {
          scope: T.ProjectSettingsView['scope'];
        }>;
        const initial = await readProject(e.scope.projectName);
        if (!initial) throw new SettingsInputError('项目不存在');
        check(await sectionRaw(initial, e.section), e.revision);
        const original = await projectSettings(initial);
        let admittedWorkspace: ProjectWorkspace | undefined;
        const proposedAccess = e.section === 'modelAccess' ? { ...original.modelAccess, ...e.patch } : undefined;
        if (proposedAccess) {
          // Optional policies and defaults belong to a provider, even when two
          // providers happen to expose the same model ID.
          if (proposedAccess.backend !== original.modelAccess.backend) {
            if (!('modelEfforts' in e.patch)) delete proposedAccess.modelEfforts;
            if (!('modelServiceTiers' in e.patch)) delete proposedAccess.modelServiceTiers;
            if (!('defaultModel' in e.patch)) proposedAccess.defaultModel = proposedAccess.models[0];
            if (!('defaultEffort' in e.patch)) delete proposedAccess.defaultEffort;
          }
          // Editors can submit full maps containing removed-model residue.
          // Drop only unselected keys; selected policies still need validation.
          if (proposedAccess.modelEfforts) proposedAccess.modelEfforts = Object.fromEntries(Object.entries(proposedAccess.modelEfforts).filter(([id]) => proposedAccess.models.includes(id)));
          if (proposedAccess.modelServiceTiers) proposedAccess.modelServiceTiers = Object.fromEntries(Object.entries(proposedAccess.modelServiceTiers).filter(([id]) => proposedAccess.models.includes(id)));
        }
        if (proposedAccess && !('defaultModel' in e.patch) && !proposedAccess.models.includes(proposedAccess.defaultModel ?? '')) {
          proposedAccess.defaultModel = proposedAccess.models[0];
          proposedAccess.defaultEffort = undefined;
        }
        if (proposedAccess && 'defaultModel' in e.patch && !('defaultEffort' in e.patch) && e.patch.defaultModel !== original.modelAccess.defaultModel)
          proposedAccess.defaultEffort = undefined;
        if (proposedAccess && !('defaultEffort' in e.patch) && proposedAccess.defaultModel && proposedAccess.defaultEffort && !(proposedAccess.modelEfforts?.[proposedAccess.defaultModel] ?? proposedAccess.efforts).includes(proposedAccess.defaultEffort))
          proposedAccess.defaultEffort = (proposedAccess.modelEfforts?.[proposedAccess.defaultModel] ?? proposedAccess.efforts)[0];
        const allowedCatalog = proposedAccess ? await validateModelAccess(proposedAccess, original.modelAccess) : undefined;
        if (e.section === 'workspace') {
          // The project holds the workspace; the host funnels a change through the library (admin/library.ts), never this row.
          if (isProjectId(initial.projectId)) throw new SettingsInputError('这个群的工作区归项目管，请通过 daemon 修改项目的工作区');
          const value = { ...original.workspace, ...e.patch };
          if (!value.directories.includes(value.primary)) throw new SettingsInputError('主目录必须在工作区目录中');
          const admitted = await admitDirectorySettings({ workspaces: { primary: value.primary, additional: value.directories.filter(path => path !== value.primary) }, repositories: value.repositories }, { dataDir: paths.appDir });
          admittedWorkspace = { primary: admitted!.workspaces!.primary, directories: [admitted!.workspaces!.primary, ...admitted!.workspaces!.additional], repositories: admitted!.repositories ?? [] };
        }
        let judge: PreparedJudge | undefined;
        if (e.section === 'judge') {
          const now = await readProject(e.scope.projectName);
          if (!now)
            throw new SettingsInputError('项目不存在');
          judge = await prepareJudge(e.patch.selection, [botId, projectRaw(now, 'judge')], e.revision, groupBackendId(now), true);
        }
        const change = e.scope.projectName === dmChat ? changeChatProject : changeGroup;
        const p = await change(e.scope.projectName, async (p) => {
          check(await sectionRaw(p, e.section), e.revision);
          switch (e.section) {
            case 'profile':
              throw new SettingsInputError('本群的个性已改为「补充职责」，本群记忆已改为项目记忆，请在对应的页面里改');
            case 'role': {
              const supplement = e.patch.supplement ?? original.role.supplement;
              if (supplement !== original.role.supplement && [...supplement].length > SUPPLEMENT_MAX) throw new SettingsInputError(`补充职责最多 ${SUPPLEMENT_MAX} 字`);
              p.supplement = supplement;
              break;
            }
            case 'smartRules': p.smartRules = { ...original.smartRules, ...e.patch }; break;
            case 'conversation':
              // A group's revision of `response` is the same value, so a group's save can get this far.
              if (!p.dm) throw new SettingsInputError('无效设置分区');
              p.smart = e.patch.mode === 'smart';
              break;
            case 'skills': p.skills = { ...original.skills, ...e.patch }; p.skills.disabledPaths = [...new Set(p.skills.disabledPaths)]; break;
            case 'presentation': {
              if (e.patch.cardDisplay !== undefined && e.patch.cardDisplay !== null) {
                try { e.patch.cardDisplay = await assertValidCardDisplay(e.patch.cardDisplay); }
                catch (error) { throw new SettingsInputError(error instanceof Error ? error.message : '消息卡配置无效'); }
              }
              // Keep the stored row partial: card-only saves must not freeze
              // voice or completion defaults inherited from the Bot.
              p.presentation = { ...p.presentation, ...e.patch };
              if (e.patch.completionMode !== undefined || e.patch.longTaskMinutes !== undefined) {
                p.presentation.completionMode ??= original.presentation.completionMode;
                p.presentation.longTaskMinutes ??= original.presentation.longTaskMinutes;
              }
              break;
            }
            case 'workspace':
              p.cwd = admittedWorkspace!.primary;
              p.directories = { ...p.directories, workspaces: { primary: p.cwd, additional: admittedWorkspace!.directories.filter(path => path !== p.cwd) }, repositories: admittedWorkspace!.repositories };
              break;
            case 'modelAccess': {
              const previousBackend = groupBackendId(p);
              const currentTier = groupPermission(p).tier;
              p.modelAccess = proposedAccess!;
              p.backend = p.modelAccess.backend;
              if (groupBackendId(p) !== previousBackend) {
                delete p.custom;
                p.mode = currentTier;
                p.network = TIER_NETWORK[currentTier];
              }
              p.defaultModel = p.modelAccess.defaultModel ?? p.modelAccess.models[0];
              const supported = allowedCatalog?.find(m => m.id === p.defaultModel)?.supportedEfforts;
              const allowed: ReasoningEffort[] = p.defaultModel ? p.modelAccess.modelEfforts?.[p.defaultModel] ?? p.modelAccess.efforts : p.modelAccess.efforts;
              const valid = supported ? allowed.filter((effort: ReasoningEffort) => supported.includes(effort)) : allowed;
              p.defaultEffort = p.modelAccess.defaultEffort && valid.includes(p.modelAccess.defaultEffort) ? p.modelAccess.defaultEffort : valid[0];
              p.modelAccess.defaultModel = p.defaultModel;
              if (p.defaultEffort) p.modelAccess.defaultEffort = p.defaultEffort;
              else delete p.modelAccess.defaultEffort;
              delete p.defaultModelCustom;
              break;
            }
            case 'permission': {
              if (e.patch.mode !== undefined && e.patch.custom !== undefined && e.patch.custom !== null)
                throw new SettingsInputError('选档和高级设置一次只改一个');
              if (e.patch.mode === undefined && e.patch.custom === null) {
                const current = groupPermission(p);
                if (current.custom || current.legacy || current.invalid)
                  throw new SettingsInputError('清掉高级设置时要同时选一档，例如 permission.mode=qa。');
                throw new Unchanged();
              }
              const backendId = groupBackendId(p);
              const table = permissionTable(backendId);
              const wasFull = groupPermission(p).effect.mode === 'full';
              let mode = e.patch.mode ?? effectiveMode(p);
              let effectMode = mode;
              let network = TIER_NETWORK[mode];
              let custom: Project['custom'];
              if (e.patch.custom !== undefined && e.patch.custom !== null) {
                let settings: Record<string, unknown>;
                try { settings = table.parseCustom(e.patch.custom); }
                catch (error) {
                  if (error instanceof PermissionInputError) throw new SettingsInputError(error.message);
                  throw error;
                }
                const matched = table.matchTier(settings);
                const effect = table.effect(settings);
                const stored = table.stored?.(settings) ?? effect;
                effectMode = matched ?? effect.mode;
                mode = matched ?? stored.mode;
                network = matched ? TIER_NETWORK[matched] : stored.network;
                if (!matched) custom = { backend: backendId, settings };
              }
              const unavailable = tierInfo(table, tableEnv(deps.backendFor(backendId)), effectMode).unavailable;
              if (unavailable) throw new SettingsInputError(unavailable);
              p.mode = mode;
              p.network = network;
              if (custom) p.custom = custom;
              else delete p.custom;
              // devices 第 15 节：给群选完全访问的地方都带这句。
              turnedFull = effectMode === 'full' && !wasFull;
              break;
            }
            case 'response':
              // 智能 has no 免@ (s25c); the web hides it, so this is the command line or an old page.
              if (sessionModeOf(p) === 'smart')
                throw new SettingsInputError(SMART_RESPONSE_REFUSED);
              Object.assign(p, e.patch);
              break;
            case 'run':
              if (e.patch.pendingPolicy === 'default')
                delete p.pendingPolicy;
              else if (e.patch.pendingPolicy !== undefined)
                p.pendingPolicy = e.patch.pendingPolicy;
              break;
            case 'model': {
              if (!e.patch.selection)
                throw new SettingsInputError('缺少模型选择');
              const chosen = await validateSelection(groupBackendId(p), e.patch.selection, true);
              if (p.modelAccess && (chosen.kind === 'default' || !projectModelAllowed(p, groupBackendId(p), chosen.model, chosen.effort, peekModels(groupBackendId(p))))) throw new SettingsInputError('请从本群允许的模型与 Effort 中选择');
              if (chosen.kind === 'default') {
                delete p.defaultModel;
                delete p.defaultEffort;
                delete p.defaultModelCustom;
              }
              else {
                p.defaultModel = chosen.model;
                p.defaultEffort = chosen.effort;
                p.defaultModelCustom = chosen.custom === true;
                if (p.modelAccess) {
                  p.modelAccess.defaultModel = chosen.model;
                  p.modelAccess.defaultEffort = chosen.effort;
                }
              }
              break;
            }
            case 'speed': {
              const tier = e.patch.tier;
              if (!tier) throw new SettingsInputError('缺少速度档位');
              const prefer = resolveModelPreference({ bot: cfg.preferences, group: p }, groupBackendId(p));
              await validateSpeed(tier, groupBackendId(p), prefer?.model, prefer?.custom);
              if (tier === 'inherit') delete p.serviceTier;
              else p.serviceTier = tier;
              break;
            }
            case 'judge':
              storeJudge(p, judge!, groupBackendId(p));
          }
        }, commitOptions).catch(error => {
          if (error instanceof Unchanged) return undefined;
          throw error;
        });
        if (!p) return { kind: 'saved', section: await sectionView(e), effects: [] };
        if (['permission', 'workspace', 'skills', 'modelAccess', 'profile', 'role'].includes(e.section)) {
          try {
            // A private chat's sessions are under each person's p2p chat_id, not the row's.
            for (const chatId of p.dm ? Object.keys(p.dm.people) : [p.chatId]) await deps.evictLiveSessionsForChat(chatId);
          }
          catch {
            additionalEffects = effect([e.section], 'restart', '设置已保存，但活跃会话重新绑定失败。请重启 daemon 使权限设置生效');
          }
        }
      }
      else {
        const e = edit as Extract<T.BotSettingsEdit, {
          scope: T.SessionSettingsView['scope'];
        }>;
        if (isRetiredKey(e.scope.threadId))
          throw new SettingsInputError(RETIRED_KEY_TEXT);
        await changeSession(e.scope.threadId, async (s) => {
          check([botId, e.section === 'speed' ? sessionSpeedRaw(s) : sessionRaw(s)], e.revision);
          if (e.section === 'speed') {
            if (!e.patch.tier) throw new SettingsInputError('缺少速度档位');
            const group = await readChatProject(s.chatId);
            const prefer = group ? resolveModelPreference({ bot: cfg.preferences, group }, s.backend) : undefined;
            await validateSpeed(e.patch.tier, s.backend, s.model ?? prefer?.model, s.modelCustom === true || (!s.model && prefer?.custom === true), s.cwd, group);
            if (e.patch.tier === 'standard') delete s.serviceTier;
            else s.serviceTier = e.patch.tier;
            return;
          }
          if (!e.patch.selection)
            throw new SettingsInputError('缺少模型选择');
          const chosen = await validateSelection(s.backend, e.patch.selection, true);
          const group = await readChatProject(s.chatId);
          if (group?.modelAccess && (chosen.kind === 'default' || !projectModelAllowed(group, s.backend, chosen.model, chosen.effort, peekModels(s.backend)))) throw new SettingsInputError('请从本群允许的模型与 Effort 中选择');
          applySelection(s, chosen);
          if (chosen.kind === 'default')
            delete s.modelCustom;
          else
            s.modelCustom = chosen.custom === true;
          if (s.serviceTier && s.serviceTier !== 'standard') {
            try {
              const prefer = group ? resolveModelPreference({ bot: cfg.preferences, group }, s.backend) : undefined;
              await validateSpeed(s.serviceTier, s.backend, s.model ?? prefer?.model, s.modelCustom === true || (!s.model && prefer?.custom === true), s.cwd, group);
            } catch (error) {
              if (!(error instanceof SettingsInputError)) throw error;
              delete s.serviceTier;
            }
          }
        }, commitOptions);
      }
      const section = await sectionView(edit);
      const keyless = edit.section === 'judge' ? await keyMissing(edit.patch.selection as T.JudgeSelectionView | undefined) : undefined;
      return {
        kind: 'saved',
        section,
        effects: [...section.value.apply.filter(item => item.fields.some(field => Object.hasOwn(edit.patch, field))), ...additionalEffects, ...(keyless ? effect(['selection'], 'next-message', keyless) : [])],
        ...(turnedFull ? { warnings: [FULL_ACCESS_WARNING] } : {}),
      };
    }
    catch (error) {
      if (error instanceof Conflict)
        return {
          kind: 'conflict',
          current: await sectionView(edit)
        };
      if (error instanceof ToolRefusal || committed) throw error;
      return rejected(error);
    }
  }
  async function performAction(action: T.SettingsAction): Promise<T.SettingsActionResult> {
    own({
      kind: 'agent',
      botId: action.botId
    });
    if (access.kind !== 'writable')
      return {
        kind: 'unavailable',
        reason: access
      };
    const scope: T.AgentSettingsView['scope'] | T.ProjectSettingsView['scope'] = action.kind === 'projectMember' || action.kind === 'projectAudience' ? {
      kind: 'project',
      botId,
      projectName: action.projectName
    } : {
      kind: 'agent',
      botId
    };
    const actionView = async () => await read(scope) as T.AgentSettingsView | T.ProjectSettingsView;
    const warnings: string[] = [];
    try {
      switch (action.kind) {
        case 'voice':
          if (!deps.voiceAction)
            return {
              kind: 'unavailable',
              reason: offlineSettings
            };
          // its refusals say what to do (switch voice on, wait for the check); other failures stay the generic message
          await deps.voiceAction(action.action).catch((error: unknown) => {
            throw error instanceof VoiceActionRefused ? new SettingsInputError(error.message) : error;
          });
          break;
        case 'adminMember': {
          let removed = false;
          await deps.writePreferences(p => {
            check([botId, p.access?.admins ?? []], action.revision);
            const admins = new Set(p.access?.admins ?? []);
            if (action.membership === 'present')
              admins.add(action.openId);
            else {
              if (admins.size === 1 && admins.has(action.openId))
                throw new SettingsInputError('至少要有一个管理员。');
              removed = admins.delete(action.openId);
            }
            p.access = {
              ...p.access,
              admins: [...admins]
            };
          });
          // The list is written and the door shut: what follows only tidies up, so its failure changes nothing.
          if (removed)
            await Promise.resolve().then(() => deps.adminRemoved?.(action.openId)).catch((error: unknown) => log.fail('settings', error, { phase: 'admin-removed' }));
          break;
        }
        case 'projectAudience':
        case 'projectMember':
          await changeGroup(action.projectName, p => {
            check([botId, p.name, p.chatId, p.allowedUsers ?? []], action.revision);
            const members = new Set(p.allowedUsers ?? []);
            if (action.kind === 'projectAudience')
              members.clear();
            else if (action.membership === 'present')
              members.add(action.openId);
            else
              members.delete(action.openId);
            p.allowedUsers = [...members];
          });
          break;
        case 'commentInstructions': {
          const current = await instructions.read();
          check([botId, current], action.revision);
          const text = action.content.kind === 'default' ? DEFAULT_COMMENT_INSTRUCTIONS : action.content.text;
          await instructions.save(text);
          try {
            await instructions.sync(text);
          }
          catch {
            warnings.push('回复规则已保存，但部分历史评论目录同步失败。可再次保存重试；新评论仍使用新规则');
          }
        }
      }
      return {
        kind: 'saved',
        view: await actionView(),
        effects: effect([], action.kind === 'commentInstructions' ? 'new-comment' : 'immediate', '设置已保存'),
        warnings
      };
    }
    catch (error) {
      if (error instanceof Conflict)
        return {
          kind: 'conflict',
          view: await actionView()
        };
      return rejected(error);
    }
  }
  return {
    read,
    save,
    models,
    act(input) {
      const action = parseSettingsAction(input);
      const result = actionChain.then(() => performAction(action));
      actionChain = result.then(() => undefined, () => undefined);
      return result;
    }
  };
}

/** Freeze historical Bot defaults into group-local settings once. Reading a settings page never
 * writes this migration; only the owning Bot startup invokes it. Fields already edited stay put. */
export async function materializeGroupSettings(deps: Pick<SettingsOwnerDeps, 'cfg' | 'backendFor' | 'listProjects' | 'mutateProject' | 'readSmartPrompt'> & { readSessions?: typeof listSessions }): Promise<{ updated: string[]; deferred: string[] }> {
  const botId = deps.cfg.accounts.app.id;
  const sessions = await (deps.readSessions ?? listSessions)();
  const rows = await (deps.listProjects ?? listProjects)();
  const result = { updated: [] as string[], deferred: [] as string[] };
  for (const row of rows) {
    const backend = groupBackendId(row);
    const native = deps.backendFor(backend).peekModels?.() ?? [];
    const selected = resolveProjectModelAccess({ bot: deps.cfg.preferences, group: row }, native);
    const existing = sessions.filter(s => s.chatId === row.chatId);
    // Historical topics may use another Provider. Until an owner explicitly chooses an
    // allowset, keep that legacy access instead of silently blocking those topics.
    const foreignSessions = existing.some(s => s.backend !== backend);
    const models = [...new Set([...native.filter(m => !m.hidden).map(m => m.id), ...selected.models, ...existing.filter(s => s.backend === backend && s.model).map(s => s.model!)])];
    const efforts = [...new Set([...native.flatMap(m => m.supportedEfforts), ...selected.efforts, ...existing.flatMap(s => s.effort ? [s.effort] : [])])];
    const preference = resolveModelPreference({ bot: deps.cfg.preferences, group: row }, backend);
    const oldJudge = storedJudge(deps.cfg.preferences?.judge);
    const oldEffectiveJudge = resolveJudgeModel(backend, { bot: oldJudge }, native);
    const judge: JudgeSelectionStored = oldEffectiveJudge.provider ? { kind: 'decision', provider: oldEffectiveJudge.provider, model: oldEffectiveJudge.model } : { kind: 'llm', backend, model: oldEffectiveJudge.model, ...(oldEffectiveJudge.effort ? { effort: oldEffectiveJudge.effort } : {}) };
    let rules = row.smartRules;
    try {
      rules ??= rulesFromSmartPrompt(await (deps.readSmartPrompt ?? readSmartPrompt)(botId, row.chatId));
    } catch { result.deferred.push(row.name); continue; }
    const before = settingsRevision(row);
    const changes: Partial<Project> = {
      ...(!row.smartRules ? { smartRules: rules } : {}),
      ...(!row.modelAccess && models.length && !foreignSessions ? { modelAccess: { backend, models, efforts } } : {}),
      ...(!row.defaultModel && preference ? { defaultModel: preference.model, defaultEffort: preference.effort, defaultModelCustom: preference.custom } : {}),
      // A row of a library project mirrors the project's folders (memory design §2.1): left out, it runs with the bot's
      // default repositories, as before, and the folder guard in the registry stays quiet.
      ...(row.directories?.repositories === undefined && !isProjectId(row.projectId) ? { directories: { ...row.directories, repositories: [...deps.cfg.preferences?.directories?.repositories ?? []] } } : {}),
      ...(!row.pendingPolicy ? { pendingPolicy: getPendingPolicy(deps.cfg) } : {}),
      ...(!row.judge && judge ? { judge } : {}),
    };
    if (!Object.keys(changes).length) continue;
    try {
      await (deps.mutateProject ?? mutateProject)(row.name, current => {
        if (settingsRevision(current) !== before) throw new Conflict();
        Object.assign(current, changes);
      });
      result.updated.push(row.name);
      if (!row.modelAccess && (!models.length || foreignSessions)) result.deferred.push(row.name);
    } catch (error) {
      if (error instanceof Conflict) result.deferred.push(row.name); else throw error;
    }
  }
  return result;
}
