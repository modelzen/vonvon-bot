import { getAppRoleSnapshot } from '../config/app-roles';
import { ToolRefusal } from '../agent/entry/tools';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JUDGE_SELECTION_KINDS } from '@vonvon/protocol';
import type { AgentBackend, ModelInfo, ReasoningEffort } from '../agent/types';
import { backendIds } from '../agent';
import { parseModelId } from '../agent/model-id';
import { getCompletionReminderConfig, getMaxConcurrentRuns, getModelDisplay, getPendingPolicy, getRunIdleTimeoutMs, getSessionTitleConfig, getSessionTitleEfforts, getShowToolCalls, resolveOwner, type AppConfig, type AppPreferences } from '../config/schema';
import { paths } from '../config/paths';
import { admitDirectorySettings, resolveProjectsRootDir } from '../config/directories';
import { botBackendId, groupBackendId, resolveCommentsExecution, resolveModelPreference, resolveProjectModelAccess, projectModelAllowed } from '../config/execution';
import { effectiveMode, getProjectByName, listProjects, mutateProject, noMentionOf, pendingPolicyOf, sessionModeOf, type Project, type ProjectWorkspace } from '../project/registry';
import { getSession, listSessions, isRetiredKey, mutateSession, RETIRED_KEY_TEXT, type SessionRecord } from '../bot/session-store';
import { DEFAULT_COMMENT_INSTRUCTIONS, saveCommentInstructions, syncAllCommentInstructions } from '../bot/comments';
import { voiceView } from '../voice/view';
import { keyStatus } from './secrets';
import { DECISION_FORMAT_LINES, DECISION_INPUT_EXAMPLE, decisionProvider, decisionProviders, keyMissingText } from '../judge/decision';
import { DECISION_PROVIDER_ID, parseStoredJudge, resolveJudgeModel } from '../judge/model';
import { JUDGE_CLAUDE_NOTE, JUDGE_CODEX_NOTE, JUDGE_FORMAT_LINES, JUDGE_INPUT_EXAMPLE } from '../judge/prompt';
import { readSmartPrompt, SMART_MAX_CHARS, SmartPromptError, composeSmartRules, resolveSmartRules, rulesFromSmartPrompt } from '../judge/smart-file';
import type { JudgeSelectionStored } from '../judge/types';
import type { VoiceAction } from '../voice/types';
import { probeBackends, SMART_NO_MENTION_REFUSED, type AppPreferencesWriter } from './ops';
import { parseSettingsAction, parseSettingsEdit, SettingsInputError } from './settings-parse';
import type * as T from './settings-types';
import { offlineModelCatalog, rememberModelCatalog } from './model-catalog';
import { readBotProfile, readGroupProfile, updateBotProfile } from '../bot/group-profile';
import { discoverGroupSkills, discoverLocalGroupSkills } from '../agent/group-skills';
export type * from './settings-types';
export { parseSettingsAction, parseSettingsEdit, parseSettingsScope, parseModelQuery, SettingsInputError } from './settings-parse';
export function settingsRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function isLocalSettingsSection(kind: string, section: string): boolean {
  return kind === 'agent' ? section === 'profile' : kind === 'project' && ['profile', 'modelAccess', 'workspace', 'smartRules', 'skills', 'presentation', 'judge', 'permission', 'response', 'run'].includes(section);
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
export interface SettingsOwnerDeps {
  responseRoster?: (chatId: string) => Promise<import("@vonvon/protocol").ResponseRoster>;
  cfg: AppConfig;
  /** Local stopped-Bot editing uses cached catalogs only, never starts a provider. */
  offline?: boolean;
  localEditing?: boolean;
  profile?: { readBot: typeof readBotProfile; readGroup: typeof readGroupProfile; updateBot: typeof updateBotProfile };
  discoverSkills?: typeof discoverGroupSkills;
  writePreferences: AppPreferencesWriter;
  backendFor: (id: string) => AgentBackend;
  evictLiveSessionsForChat: (chatId: string) => Promise<void>;
  voiceAction?: (action: VoiceAction) => Promise<void>;
  refreshCompletionReminders?: () => void;
  access?: T.SettingsAccess;
  runningConcurrency?: number;
  readProject?: typeof getProjectByName;
  listProjects?: typeof listProjects;
  readSession?: typeof getSession;
  mutateProject?: typeof mutateProject;
  mutateSession?: typeof mutateSession;
  /** tests point it at a temporary bot directory */
  readSmartPrompt?: (appId: string, chatId?: string) => ReturnType<typeof readSmartPrompt>;
  /** the keystore, for whether a decision model's key is filled in */
  getSecret?: (id: string) => Promise<string | undefined>;
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
const agentEffects: {
  [K in keyof T.AgentSections]: T.ApplyEffect[];
} = {
  profile: effect(['persona', 'memory'], 'next-turn', '下一轮对话使用新的个性与记忆'),
  cards: effect(['showToolCalls', 'showModel'], 'next-message', '后续任务卡片输出生效'),
  run: [...effect(['maxConcurrentRuns'], 'restart', '已保存的并发上限在 daemon 重启后生效'), ...effect(['pendingPolicy'], 'next-message', '下一条消息生效'), ...effect(['runIdleTimeoutSeconds'], 'next-turn', '下一次超时检测生效')],
  completion: effect(['mode', 'longTaskMinutes'], 'task-completion', '任务结束时读取最新策略'),
  comments: effect(['backend', 'selection'], 'new-comment', '下一条评论使用新设置'),
  titles: effect(['byBackend'], 'new-session', '只影响之后新建的会话'),
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
  const titles: Record<string, T.TitlePolicy> = {};
  for (const id of new Set([...backendIds(), ...Object.keys(p.sessionTitles?.byBackend ?? {})]))
    titles[id] = getSessionTitleConfig(cfg, id);
  return {
    profile: { persona: '', memory: '' },
    cards: {
      showToolCalls: getShowToolCalls(cfg),
      showModel: getModelDisplay(cfg)
    },
    run: {
      maxConcurrentRuns: getMaxConcurrentRuns(cfg),
      pendingPolicy: getPendingPolicy(cfg),
      runIdleTimeoutSeconds: (getRunIdleTimeoutMs(cfg) ?? 0) / 1000
    },
    completion: getCompletionReminderConfig(cfg),
    comments: {
      backend: resolveCommentsExecution(p).backend,
      selection: selection(p.comments?.model, p.comments?.effort)
    },
    titles: {
      byBackend: titles
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
    case 'cards': return [p.showToolCalls, p.showModel];
    case 'run': return [p.maxConcurrentRuns, p.runIdleTimeoutSeconds, p.pendingPolicy];
    case 'completion': return [p.completionReminder?.mode, p.completionReminder?.longTaskMinutes];
    case 'comments': return [p.comments?.backend, p.comments?.model, p.comments?.effort];
    case 'titles': return Object.entries(p.sessionTitles?.byBackend ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, v]) => [id, v?.enabled, v?.model, v?.effort]);
    case 'paths': return p.projectsRootDir ?? null;
    case 'access': return p.access?.allowedChats ?? [];
    case 'judge': return p.judge;
  }
}
function projectData(p: Project): T.ProjectSections {
  return {
    profile: p.profile ?? { persona: '', memory: '', inheritPersona: true, inheritMemory: true },
    modelAccess: resolveProjectModelAccess({ group: p }),
    workspace: workspaceOf(p),
    smartRules: resolveSmartRules(p.smartRules ?? { respond: '', newTopic: '' }),
    skills: p.skills ?? { disabledPaths: [] },
    presentation: p.presentation ?? { voiceEnabled: false, showToolCalls: true, showModel: 'off', completionMode: 'manual', longTaskMinutes: 5 },
    permission: {
      mode: effectiveMode(p),
      guestMode: effectiveMode(p),
      network: p.network ?? false
    },
    response: {
      noMention: noMentionOf(p)
    },
    model: {
      selection: selection(p.defaultModel, p.defaultEffort, p.defaultModelCustom)
    },
    run: {
      pendingPolicy: p.pendingPolicy ?? 'default'
    },
    judge: {
      selection: storedJudgeView(p.judge)
    }
  };
}
function workspaceOf(p: Project): ProjectWorkspace {
  return { primary: p.cwd, directories: [p.cwd, ...p.directories?.workspaces?.additional ?? []], repositories: p.directories?.repositories ?? [] };
}
function projectRaw(p: Project, section: keyof T.ProjectSections): unknown {
  if (section === 'workspace') return [p.name, p.chatId, p.cwd, p.directories];
  if (['profile', 'modelAccess', 'smartRules', 'skills', 'presentation'].includes(section)) return [p.name, p.chatId, p[section as 'profile']];
  const data = section === 'permission' ? [p.mode, p.network] : section === 'response' ? p.noMention : section === 'run' ? p.pendingPolicy : section === 'judge' ? p.judge : [p.defaultModel, p.defaultEffort, p.defaultModelCustom === true];
  return [p.name, p.chatId, p.cwd, p.backend, data];
}
function sessionRaw(s: SessionRecord): unknown {
  return [s.threadId, s.backend, s.sessionId, s.chatId, s.model, s.effort, s.modelCustom === true];
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
function rejected(error: unknown): {
  kind: 'rejected';
  fields: T.SettingsFieldError[];
} {
  return {
    kind: 'rejected',
    fields: [{
        field: 'settings',
        message: error instanceof SettingsInputError ? error.message : '保存失败，请刷新设置后重试；若配置被其他进程修改，请重启 daemon'
      }]
  };
}
export function createSettingsOwner(deps: SettingsOwnerDeps): T.HostSettings {
  const cfg = deps.cfg;
  const profile = deps.profile ?? { readBot: readBotProfile, readGroup: readGroupProfile, updateBot: updateBotProfile };
  const botId = cfg.accounts.app.id;
  const access = deps.access ?? writable;
  const sectionAccess = (kind: string, section: string) => deps.localEditing && isLocalSettingsSection(kind, section) ? writable : access;
  const runningConcurrency = deps.runningConcurrency ?? getMaxConcurrentRuns(cfg);
  const readProject = deps.readProject ?? getProjectByName;
  const readSession = deps.readSession ?? getSession;
  const changeProject = deps.mutateProject ?? mutateProject;
  const changeSession = deps.mutateSession ?? mutateSession;
  const instructions = deps.instructions ?? {
    read: () => readFile(paths.commentInstructionsFile, 'utf8').catch(error => {
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
      if (deps.offline) { const cached = await offlineModelCatalog(query.backend); const peeked = backend.peekModels?.(); return { ...base, models: peeked?.length ? peeked : cached.models, state: 'fallback', observedAt: cached.observedAt, error: cached.message }; }
      const [status] = await probeBackends([backend]);
      if (!status?.probe?.ok)
        return {
          ...base,
          models: [],
          state: 'unavailable',
          error: '后端当前不可用，请检查安装或登录状态'
        };
      const listed = await backend.listModels();
      if (listed.length) await rememberModelCatalog(query.backend, listed, base.observedAt).catch(() => undefined);
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
      if (!getSessionTitleEfforts(backend).includes(value.effort))
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
  const peekModels = (id: string): ModelInfo[] | undefined => {
    try {
      return deps.backendFor(id).peekModels?.();
    }
    catch {
      return undefined;
    }
  };
  /** Returns what to store, or nothing for `default` (design 2.4). A language model is stored with its
   * backend: a group's must be the group's, or the judge would ignore it; the bot's is its default
   * backend unless it says otherwise. A listed model is checked against the list the backend holds
   * (what the judge fits the effort with), else a fresh catalog, except while the catalog cannot be
   * read: then the choice and its effort are kept as given, and each judgement fits the effort to the
   * model (Rakazo 第二轮 A6). A decision model is checked for its shape only. */
  async function validateJudgeSelection(value: T.JudgeSelection, layerBackend: string, group: boolean): Promise<JudgeSelectionStored | undefined> {
    if (value.kind === 'default')
      return undefined;
    const id = parseModelId(value.model);
    if (!id.ok)
      throw new SettingsInputError(id.message);
    if (value.kind === 'decision') {
      if (!DECISION_PROVIDER_ID.test(value.provider))
        throw new SettingsInputError('决策模型的 provider 只能是小写字母、数字和 -，40 个字以内');
      // any model id, as a hand-typed one: a wrong one fails its judgements as `model` and cools (s23f)
      if (!decisionProvider(value.provider))
        throw new SettingsInputError(`没有 ${value.provider} 这家决策模型，现在有：${decisionProviders().map(p => `${p.displayName}（${p.id}）`).join('、')}`);
      return { kind: 'decision', provider: value.provider, model: id.id };
    }
    const backend = value.backend ?? layerBackend;
    if (!backendIds().includes(backend))
      throw new SettingsInputError('未知后端');

    if (value.effort && !getSessionTitleEfforts(backend).includes(value.effort))
      throw new SettingsInputError('当前后端不支持这个推理强度');
    const stored: JudgeSelectionStored = { kind: 'llm', backend, model: id.id, ...(value.effort ? { effort: value.effort } : {}) };
    if (value.custom)
      return { ...stored, custom: true };
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
    const actualBackend = layers.group?.kind === 'llm' ? layers.group.backend : backend;
    const { model, effort, provider } = resolveJudgeModel(actualBackend, layers, peekModels(actualBackend));
    return { selection: provider ? { kind: 'decision', provider, model } : { kind: 'llm', backend: actualBackend, model, ...(effort ? { effort } : {}) } };
  }
  /** Every decision model this version calls, and whether its key is filled in by the judge's rule (an unreadable
   * keystore is said so, not taken for a missing key; one stored in a shape no header carries is missing, as the
   * judge takes it): what `settings get` and a picker list (s23f, s28), and the key page's status (s23g). */
  async function decisionModels(): Promise<T.DecisionModelsView> {
    return Promise.all(decisionProviders().map(async p => {
      const { status } = await keyStatus(p, deps.getSecret);
      return {
        provider: p.id, displayName: p.displayName, models: p.models.map(m => ({ ...m })), keyId: p.keyId,
        keySet: status === 'set', ...(status === 'unreadable' ? { keyUnreadable: true } : {}),
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
    const result = projectData(p);
    result.profile = await profile.readGroup(botId, p);
    result.modelAccess = resolveProjectModelAccess({ bot: cfg.preferences, group: p }, peekModels(groupBackendId(p)));
    if (!p.directories?.repositories) result.workspace.repositories = [...cfg.preferences?.directories?.repositories ?? []];
    if (!p.smartRules) result.smartRules = rulesFromSmartPrompt(await (deps.readSmartPrompt ?? readSmartPrompt)(botId, p.chatId));
    const completion = getCompletionReminderConfig(cfg);
    result.presentation = p.presentation ? { showModel: getModelDisplay(cfg), ...p.presentation } : { voiceEnabled: voiceView(cfg).enabled, showToolCalls: getShowToolCalls(cfg), showModel: getModelDisplay(cfg), completionMode: completion.mode, longTaskMinutes: completion.longTaskMinutes };
    return result;
  }
  async function sectionRaw(p: Project, section: keyof T.ProjectSections): Promise<unknown> {
    if (section === 'profile' && !p.profile) return [botId, projectRaw(p, section), await profile.readGroup(botId, p)];
    if (section === 'smartRules' && !p.smartRules) return [botId, projectRaw(p, section), (await (deps.readSmartPrompt ?? readSmartPrompt)(botId, p.chatId)).text];
    return [botId, projectRaw(p, section)];
  }
  async function validateModelAccess(value: T.ProjectSections['modelAccess'], previous: T.ProjectSections['modelAccess']): Promise<ModelInfo[]> {
    if (!backendIds().includes(value.backend)) throw new SettingsInputError('请选择支持的 Provider');
    if (!value.models.length || new Set(value.models).size !== value.models.length || new Set(value.efforts).size !== value.efforts.length) throw new SettingsInputError('至少选择一个模型，模型和 Effort 不能重复');
    const peeked = peekModels(value.backend);
    const catalog = peeked?.length ? peeked : (await models({ botId, backend: value.backend, purpose: 'project' })).models;
    for (const id of value.models) {
      if (!parseModelId(id).ok) throw new SettingsInputError('模型 ID 无效');
      const model = catalog.find(m => m.id === id && !m.hidden);
      if (!model) {
        if (value.backend !== previous.backend || !previous.models.includes(id)) throw new SettingsInputError('模型目录暂不可用或没有此模型，请启动 Bot 并刷新目录');
        if (value.efforts.some(e => !previous.efforts.includes(e))) throw new SettingsInputError('无法验证新增 Effort，请刷新模型目录');
      } else if (model.supportedEfforts.length && !model.supportedEfforts.some(e => value.efforts.includes(e))) throw new SettingsInputError(`模型 ${id} 至少需要一个支持的 Effort`);
    }
    if (value.efforts.some(e => !getSessionTitleEfforts(value.backend).includes(e))) throw new SettingsInputError('Provider 不支持这个 Effort');
    return catalog;
  }
  async function read(scope: T.SettingsScope): Promise<T.SettingsView> {
    own(scope);
    if (scope.kind === 'agent') {
      const data = agentData(cfg);
      data.profile = await profile.readBot(botId);
      const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, makeSection(value, [botId, agentRaw(cfg.preferences ?? {}, key as keyof T.AgentSections)], access, agentEffects[key as keyof T.AgentSections])])) as T.AgentSettingsView['sections'];
      sections.profile = makeSection(data.profile, [botId, data.profile], sectionAccess('agent', 'profile'), agentEffects.profile);
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
      const botDecides = sections.judge.effective.selection.kind === 'decision';
      const judgeByBackend: NonNullable<T.AgentSettingsView['judgeByBackend']> = {};
      for (const id of backendIds()) {
        const { model, effort, provider, modelSource } = resolveJudgeModel(id, { bot: botJudge }, peekModels(id));
        judgeByBackend[id] = { model, ...(effort ? { effort } : {}), ...(provider ? { provider } : {}), source: modelSource === 'bot' ? 'bot' : 'default' };
      }
      const text = await instructions.read();
      const roles = getAppRoleSnapshot(botId, cfg.accounts.app.tenant);
      return {
        scope,
        sections,
        ownerOpenId: resolveOwner(cfg) ?? null,
        administrators: {
          feishu: { ownerOpenId: roles?.ownerOpenId ?? null, adminOpenIds: roles?.admins ?? [] },
          scannerOpenId: cfg.preferences?.access?.ownerOpenId ?? cfg.preferences?.access?.admins?.[0] ?? null,
          openIds: [...(cfg.preferences?.access?.admins ?? [])],
          revision: settingsRevision([botId, resolveOwner(cfg), cfg.preferences?.access?.admins ?? []])
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
      const sections = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, makeSection(value, [botId, projectRaw(p, key as keyof T.ProjectSections)], sectionAccess('project', key), effect(Object.keys(value), key === 'model' ? 'new-session' : key === 'permission' ? 'session-rebind' : 'next-message', key === 'model' ? '仅新会话使用项目默认模型' : key === 'judge' ? agentEffects.judge[0]!.detail : key === 'run' && p.backend === 'claude-agent' ? 'Claude 不支持插话，运行中来的消息照样排队' : '下一条消息生效'))])) as T.ProjectSettingsView['sections'];
      for (const key of ['profile', 'smartRules'] as const) sections[key]!.revision = settingsRevision(await sectionRaw(p, key));
      const botProfile = await profile.readBot(botId);
      sections.profile!.effective = { ...data.profile, persona: [data.profile.inheritPersona ? botProfile.persona : '', data.profile.persona].filter(Boolean).join('\n\n'), memory: [data.profile.inheritMemory ? botProfile.memory : '', data.profile.memory].filter(Boolean).join('\n\n') };
      const backendId = groupBackendId(p);
      sections.run.effective = { pendingPolicy: pendingPolicyOf(getPendingPolicy(cfg), p) };
      // The group's default, else the bot's on the same backend (s36d2).
      const prefer = resolveModelPreference({ bot: cfg.preferences, group: p }, backendId);
      sections.model.effective = {
        selection: await effectiveSelection(backendId, prefer?.model, prefer?.effort, prefer?.custom)
      };
      sections.judge.effective = judgeEffective(backendId, { group: storedJudge(p.judge), bot: storedJudge(cfg.preferences?.judge) });
      // a decision model gets none of a backend's extras
      const judgeNote = sections.judge.effective.selection.kind === 'llm' ? JUDGE_NOTES[String(sections.judge.effective.selection.backend ?? backendId)] : undefined;
      const fullOnly = deps.backendFor(backendId).fullAccessOnly?.();
      let skillView: Pick<T.ProjectSettingsView, 'skills' | 'skillsError'>;
      if (deps.offline) {
        try { skillView = { skills: await discoverLocalGroupSkills({ backendId, cwd: p.cwd, directories: data.workspace.directories, disabledPaths: data.skills.disabledPaths }), skillsError: '仅显示本地技能，Provider 插件在启动后读取' }; }
        catch { skillView = { skillsError: '暂时无法读取本地技能目录，请检查工作区目录' }; }
      }
      else {
        try { skillView = { skills: await (deps.discoverSkills ?? discoverGroupSkills)({ backend: deps.backendFor(backendId), cwd: p.cwd, directories: data.workspace.directories, disabledPaths: data.skills.disabledPaths }) }; }
        catch { skillView = { skillsError: '暂时无法读取技能目录，请检查 Provider 状态后重试' }; }
      }
      return {
        scope,
        sections,
        botProfile,
        ...skillView,
        identity: {
          chatId: p.chatId,
          backend: backendId,
          cwd: p.cwd,
          kind: sessionModeOf(p),
          ...(fullOnly ? { fullOnly } : {})
        },
        members: {
          ...(deps.responseRoster ? { roster: await deps.responseRoster(p.chatId) } : {}),
          openIds: [...(p.allowedUsers ?? [])],
          revision: settingsRevision([botId, p.name, p.chatId, p.allowedUsers ?? []])
        },
        smartPrompt: p.smartRules ? { ...await smartPromptView(p.chatId, judgeNote ? [judgeNote] : [], sections.judge.effective.selection.kind === 'decision'), source: 'group', text: composeSmartRules(p.smartRules) } : await smartPromptView(p.chatId, judgeNote ? [judgeNote] : [], sections.judge.effective.selection.kind === 'decision'),
        decisionModels: await decisionModels()
      };
    }
    if (scope.kind === 'session') {
      if (isRetiredKey(scope.threadId))
        throw new SettingsInputError(RETIRED_KEY_TEXT);
      const s = await readSession(scope.threadId);
      if (!s)
        throw new SettingsInputError('会话不存在或已被删除');
      const project = (await (deps.listProjects ?? listProjects)()).find(p => p.chatId === s.chatId);
      return {
        scope,
        sections: {
          model: makeSection({
            selection: selection(s.model, s.effort, s.modelCustom)
          }, [botId, sessionRaw(s)], access, effect(['selection'], 'next-turn', '下一轮对话使用新模型'))
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
    if (selection?.kind !== 'decision')
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
    let additionalEffects: T.ApplyEffect[] = [];
    try {
      if (edit.scope.kind === 'agent') {
        const e = edit as Extract<T.BotSettingsEdit, {
          section: keyof T.AgentSections;
        }>;
        const judge = e.section === 'judge'
          ? await prepareJudge(e.patch.selection, [botId, agentRaw(cfg.preferences ?? {}, 'judge')], e.revision, botBackendId(cfg.preferences), false)
          : undefined;
        if (e.section === 'profile') {
          await profile.updateBot(botId, current => { check([botId, current], e.revision); return { ...current, ...e.patch }; }, beforeCommit);
        } else await deps.writePreferences(async (p) => {
          check([botId, agentRaw(p, e.section as keyof T.AgentSections)], e.revision);
          switch (e.section) {
            case 'cards':
              Object.assign(p, e.patch);
              break;
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
              const [entry] = Object.entries(e.patch.byBackend ?? {});
              if (!entry)
                throw new SettingsInputError('请选择一个后端');
              const [id, policy] = entry;
              if (!backendIds().includes(id) || policy.enabled && !getSessionTitleEfforts(id).includes(policy.effort))
                throw new SettingsInputError('标题后端或推理强度无效');
              p.sessionTitles = {
                ...p.sessionTitles,
                byBackend: {
                  ...p.sessionTitles?.byBackend,
                  [id]: {
                    ...p.sessionTitles?.byBackend?.[id],
                    ...policy
                  }
                }
              };
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
        const allowedCatalog = e.section === 'modelAccess' ? await validateModelAccess({ ...original.modelAccess, ...e.patch }, original.modelAccess) : undefined;
        if (e.section === 'workspace') {
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
          if (sessionModeOf(now) === 'smart' && e.patch.selection?.kind === 'default') throw new SettingsInputError('智能模式需要单独设置决策模型');
          judge = await prepareJudge(e.patch.selection, [botId, projectRaw(now, 'judge')], e.revision, groupBackendId(now), true);
        }
        const p = await changeProject(e.scope.projectName, async (p) => {
          check(await sectionRaw(p, e.section), e.revision);
          switch (e.section) {
            case 'profile': p.profile = { ...await profile.readGroup(botId, p), ...e.patch }; break;
            case 'smartRules': p.smartRules = { ...original.smartRules, ...e.patch }; break;
            case 'skills': p.skills = { ...original.skills, ...e.patch }; p.skills.disabledPaths = [...new Set(p.skills.disabledPaths)]; break;
            case 'presentation': p.presentation = { ...original.presentation, ...e.patch }; break;
            case 'workspace':
              p.cwd = admittedWorkspace!.primary;
              p.directories = { ...p.directories, workspaces: { primary: p.cwd, additional: admittedWorkspace!.directories.filter(path => path !== p.cwd) }, repositories: admittedWorkspace!.repositories };
              break;
            case 'modelAccess': {
              p.modelAccess = { ...original.modelAccess, ...e.patch };
              p.backend = p.modelAccess.backend;
              if (!p.defaultModel || !p.modelAccess.models.includes(p.defaultModel)) { p.defaultModel = p.modelAccess.models[0]; delete p.defaultModelCustom; }
              const supported = allowedCatalog?.find(m => m.id === p.defaultModel)?.supportedEfforts;
              const allowed = supported ? p.modelAccess.efforts.filter(effort => supported.includes(effort)) : p.modelAccess.efforts;
              if (!p.defaultEffort || !allowed.includes(p.defaultEffort)) p.defaultEffort = allowed[0];
              break;
            }
            case 'permission': {
              const next = {
                ...p,
                ...e.patch
              };
              const backend = deps.backendFor(groupBackendId(p));
              const supported = backend.supportedModes;
              if (supported && !supported.includes(effectiveMode(next)))
                throw new SettingsInputError('后端不支持此权限档位');
              // Only the tier this save sets: a stored 只读 stays, and network can still change.
              const fullOnly = backend.fullAccessOnly?.();
              if (fullOnly && e.patch.mode !== undefined && e.patch.mode !== 'full')
                throw new SettingsInputError(fullOnly);
              Object.assign(p, e.patch);
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
              }
              break;
            }
            case 'judge':
              storeJudge(p, judge!, groupBackendId(p));
          }
        }, commitOptions);
        if (['permission', 'workspace', 'skills', 'modelAccess', 'profile'].includes(e.section)) {
          try {
            await deps.evictLiveSessionsForChat(p.chatId);
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
          check([botId, sessionRaw(s)], e.revision);
          if (!e.patch.selection)
            throw new SettingsInputError('缺少模型选择');
          const chosen = await validateSelection(s.backend, e.patch.selection, true);
          const group = (await (deps.listProjects ?? listProjects)()).find(p => p.chatId === s.chatId);
          if (group?.modelAccess && (chosen.kind === 'default' || !projectModelAllowed(group, s.backend, chosen.model, chosen.effort, peekModels(s.backend)))) throw new SettingsInputError('请从本群允许的模型与 Effort 中选择');
          applySelection(s, chosen);
          if (chosen.kind === 'default')
            delete s.modelCustom;
          else
            s.modelCustom = chosen.custom === true;
        }, commitOptions);
      }
      const section = await sectionView(edit);
      const keyless = edit.section === 'judge' ? await keyMissing(edit.patch.selection as T.JudgeSelectionView | undefined) : undefined;
      return {
        kind: 'saved',
        section,
        effects: [...section.value.apply.filter(item => item.fields.some(field => Object.hasOwn(edit.patch, field))), ...additionalEffects, ...(keyless ? effect(['selection'], 'next-message', keyless) : [])]
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
          await deps.voiceAction(action.action);
          break;
        case 'adminMember':
          await deps.writePreferences(p => {
            check([botId, resolveOwner(cfg), p.access?.admins ?? []], action.revision);
            const roles = getAppRoleSnapshot(botId, cfg.accounts.app.tenant);
            const scanner = cfg.preferences?.access?.ownerOpenId ?? cfg.preferences?.access?.admins?.[0];
            if (action.membership === 'absent' && (action.openId === resolveOwner(cfg) || action.openId === scanner || roles?.admins.includes(action.openId)))
              throw new SettingsInputError('飞书应用管理员和注册者不能在本机移除');
            const admins = new Set(p.access?.admins ?? []);
            if (action.membership === 'present')
              admins.add(action.openId);
            else
              admins.delete(action.openId);
            p.access = {
              ...p.access,
              admins: [...admins]
            };
          });
          break;
        case 'projectAudience':
        case 'projectMember':
          await changeProject(action.projectName, p => {
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
export async function materializeGroupSettings(deps: Pick<SettingsOwnerDeps, 'cfg' | 'backendFor' | 'listProjects' | 'mutateProject' | 'profile' | 'readSmartPrompt'> & { readSessions?: typeof listSessions }): Promise<{ updated: string[]; deferred: string[] }> {
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
    const completion = getCompletionReminderConfig(deps.cfg);
    const oldJudge = storedJudge(deps.cfg.preferences?.judge);
    const oldEffectiveJudge = resolveJudgeModel(backend, { bot: oldJudge }, native);
    const judge: JudgeSelectionStored = oldEffectiveJudge.provider ? { kind: 'decision', provider: oldEffectiveJudge.provider, model: oldEffectiveJudge.model } : { kind: 'llm', backend, model: oldEffectiveJudge.model, ...(oldEffectiveJudge.effort ? { effort: oldEffectiveJudge.effort } : {}) };
    let rules = row.smartRules;
    let groupProfile = row.profile;
    try {
      rules ??= rulesFromSmartPrompt(await (deps.readSmartPrompt ?? readSmartPrompt)(botId, row.chatId));
      groupProfile ??= await (deps.profile?.readGroup ?? readGroupProfile)(botId, row);
    } catch { result.deferred.push(row.name); continue; }
    const before = settingsRevision(row);
    const changes: Partial<Project> = {
      ...(!row.profile ? { profile: groupProfile } : {}),
      ...(!row.smartRules ? { smartRules: rules } : {}),
      ...(!row.modelAccess && models.length && !foreignSessions ? { modelAccess: { backend, models, efforts } } : {}),
      ...(!row.defaultModel && preference ? { defaultModel: preference.model, defaultEffort: preference.effort, defaultModelCustom: preference.custom } : {}),
      ...(row.directories?.repositories === undefined ? { directories: { ...row.directories, repositories: [...deps.cfg.preferences?.directories?.repositories ?? []] } } : {}),
      ...(!row.pendingPolicy ? { pendingPolicy: getPendingPolicy(deps.cfg) } : {}),
      ...(!row.presentation || row.presentation.showModel === undefined ? { presentation: { voiceEnabled: voiceView(deps.cfg).enabled, showToolCalls: getShowToolCalls(deps.cfg), showModel: getModelDisplay(deps.cfg), completionMode: completion.mode, longTaskMinutes: completion.longTaskMinutes, ...row.presentation } } : {}),
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
